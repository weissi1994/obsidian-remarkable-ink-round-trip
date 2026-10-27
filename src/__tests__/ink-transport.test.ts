import { describe, expect, it } from "vitest";
import { NotebookChangedError, readNotebook, sendNotebook, uploadNotebook } from "../transport/notebook";
import { ocrBody, ocrPrompt, parseOcrResponse, transcribe } from "../transport/ocr";
import type { HttpRequest } from "../transport/http";
import { sendNote, type SendDeps } from "../sync/send";
import { DEVICE_PROFILES } from "../ink/inkrender";
import { fakeCloud } from "./helpers/fakecloud";

const NO_WAIT = { attempts: 3, backoffMs: () => 0, sleep: async () => undefined };

describe("notebook upload", () => {
	it("uploads every page and reads them back by page id", async () => {
		const { api, texts } = fakeCloud();
		const pages = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])];
		const { docId, pageIds } = await uploadNotebook(api, "Wochenplan", pages, { now: () => 1 });
		expect(pageIds).toHaveLength(2);
		const content = JSON.parse(texts.get(`${docId}.content`)!) as {
			fileType: string;
			pages: string[];
			pageCount: number;
			redirectionPageMap: number[];
		};
		expect(content.fileType).toBe("notebook");
		expect(content.pages).toEqual(pageIds);
		expect(content.pageCount).toBe(2);
		expect(content.redirectionPageMap).toEqual([-1, -1]);
		expect(texts.get(`${docId}.pagedata`)).toBe("Blank\nBlank\n");
		const read = await readNotebook(api, docId);
		expect(read.pages.map((p) => p.pageId)).toEqual(pageIds);
		expect([...read.pages[1].bytes]).toEqual([4, 5]);
	});

	it("reports the new document's hash exactly as the account listing shows it", async () => {
		const cloud = fakeCloud();
		const { docId, hash } = await uploadNotebook(cloud.api, "Plan", [new Uint8Array([1])]);
		expect(cloud.hashOf(docId)).toBe(hash);
		expect((await readNotebook(cloud.api, docId)).hash).toBe(hash);
	});

	it("trashes the notebook it replaces in the same root update", async () => {
		const { api, texts, rootList, rootWrites } = fakeCloud();
		const old = await uploadNotebook(api, "Plan", [new Uint8Array([1])], { now: () => 1 });
		const before = rootWrites();
		const next = await uploadNotebook(api, "Plan", [new Uint8Array([2])], {
			now: () => 2,
			replaces: old.docId,
			expectedHash: old.hash,
		});
		expect(next.replaced).toBe(true);
		expect(rootWrites() - before).toBe(1);
		expect(JSON.parse(texts.get(`${old.docId}.metadata`)!)).toMatchObject({ parent: "trash", visibleName: "Plan" });
		const ids = rootList().map((e) => e.id);
		expect(ids).toEqual(expect.arrayContaining([old.docId, next.docId]));
		expect(ids.filter((id) => id === old.docId)).toHaveLength(1);
		// A notebook already gone from the account is simply not trashed.
		const third = await uploadNotebook(api, "Plan", [new Uint8Array([3])], { now: () => 3, replaces: "gone" });
		expect(third.replaced).toBe(false);
	});

	it("writes nothing when the notebook to replace changed on the tablet since it was read", async () => {
		const cloud = fakeCloud();
		const old = await uploadNotebook(cloud.api, "Plan", [new Uint8Array([1])]);
		const edited = cloud.writeOnTablet(old.docId);
		const before = cloud.rootWrites();
		const attempt = uploadNotebook(cloud.api, "Plan", [new Uint8Array([2])], { replaces: old.docId, expectedHash: old.hash });
		await expect(attempt).rejects.toBeInstanceOf(NotebookChangedError);
		await expect(attempt).rejects.toMatchObject({ expectedHash: old.hash, actualHash: edited });
		expect(cloud.rootWrites()).toBe(before);
		expect(cloud.live()).toEqual([old.docId]);
	});

	it("checks again on a retry: ink synced while the cloud was busy stops the replace", async () => {
		const cloud = fakeCloud();
		const old = await uploadNotebook(cloud.api, "Plan", [new Uint8Array([1])]);
		// The first root write is refused because the tablet is syncing — new ink.
		cloud.onRootWrite(() => {
			cloud.onRootWrite(null);
			cloud.writeOnTablet(old.docId);
			return new Error("precondition failed");
		});
		await expect(
			sendNotebook(cloud.api, "Plan", [new Uint8Array([2])], { replaces: old.docId, expectedHash: old.hash, retry: NO_WAIT }),
		).rejects.toBeInstanceOf(NotebookChangedError);
		expect(cloud.live()).toEqual([old.docId]);
		expect(cloud.parentOf(old.docId)).toBe("");
	});

	it("fails instead of leaving two notebooks when the one to replace cannot be read", async () => {
		const cloud = fakeCloud();
		const old = await uploadNotebook(cloud.api, "Plan", [new Uint8Array([1])]);
		const getHash = cloud.api.getHash.bind(cloud.api);
		cloud.api.getHash = (id, hash) => (id.endsWith(".metadata") ? Promise.reject(new Error("network down")) : getHash(id, hash));
		await expect(
			uploadNotebook(cloud.api, "Plan", [new Uint8Array([2])], { replaces: old.docId, expectedHash: old.hash }),
		).rejects.toThrow("network down");
		expect(cloud.live()).toEqual([old.docId]);
	});

	it("retries a generation conflict onto the same document", async () => {
		const { api, rootList } = fakeCloud(1);
		const result = await sendNotebook(api, "x", [new Uint8Array([9])], { retry: NO_WAIT });
		const ids = rootList().map((e) => e.id);
		expect(ids.filter((id) => id === result.docId)).toHaveLength(1);
	});
});

describe("OCR", () => {
	it("asks for a verbatim transcription and passes the context line", () => {
		const prompt = ocrPrompt({ png: new ArrayBuffer(0), quote: "Envoy rate limits" });
		expect(prompt).toContain("exactly as written");
		expect(prompt).toContain("Envoy rate limits");
		const body = JSON.parse(ocrBody({ endpoint: "x", model: "m" }, { png: new Uint8Array([1, 2]).buffer })) as {
			model: string;
			messages: { content: { image_url?: { url: string } }[] }[];
		};
		expect(body.model).toBe("m");
		expect(body.messages[0].content[1].image_url?.url).toBe("data:image/png;base64,AQI=");
	});

	it("sends the owner's corrections ahead as worked examples", () => {
		const examples = [
			{ png: new Uint8Array([9]).buffer, text: "Termin morgen" },
			{ png: new Uint8Array([8]).buffer, text: "prüfen" },
		];
		expect(ocrPrompt({ png: new ArrayBuffer(0), examples })).toContain("same handwriting");
		expect(ocrPrompt({ png: new ArrayBuffer(0) })).not.toContain("same handwriting");
		const body = JSON.parse(ocrBody({ endpoint: "x", model: "m" }, { png: new Uint8Array([1, 2]).buffer, examples })) as {
			messages: { role: string; content: string | { type: string; image_url?: { url: string } }[] }[];
		};
		expect(body.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
		const image = (i: number) =>
			(body.messages[i].content as { image_url?: { url: string } }[]).find((part) => part.image_url)?.image_url?.url;
		expect(image(0)).toBe("data:image/png;base64,CQ==");
		expect(body.messages[1].content).toBe("Termin morgen");
		expect(body.messages[3].content).toBe("prüfen");
		// The image to read comes last.
		expect(image(4)).toBe("data:image/png;base64,AQI=");
	});

	it("reads string and part-list answers, and NO_TEXT as nothing", () => {
		expect(parseOcrResponse(JSON.stringify({ choices: [{ message: { content: "prüfen!" } }] }))).toBe("prüfen!");
		expect(
			parseOcrResponse(JSON.stringify({ choices: [{ message: { content: [{ type: "text", text: "a b" }] } }] })),
		).toBe("a b");
		expect(parseOcrResponse(JSON.stringify({ choices: [{ message: { content: "NO_TEXT" } }] }))).toBeNull();
	});

	it("calls /chat/completions with the key, and explains failures", async () => {
		const seen: HttpRequest[] = [];
		const ok = await transcribe(
			async (request) => {
				seen.push(request);
				return { status: 200, headers: {}, text: JSON.stringify({ choices: [{ message: { content: "hi" } }] }) };
			},
			{ endpoint: "http://localhost:11434/v1/", model: "m", apiKey: "k" },
			{ png: new ArrayBuffer(1) },
		);
		expect(ok).toBe("hi");
		expect(seen[0].url).toBe("http://localhost:11434/v1/chat/completions");
		expect(seen[0].headers?.Authorization).toBe("Bearer k");
		await expect(
			transcribe(async () => ({ status: 401, headers: {}, text: "" }), { endpoint: "https://x/v1", model: "m" }, { png: new ArrayBuffer(1) }),
		).rejects.toThrow("refused the API key");
	});
});

describe("ink send", () => {
	it("renders, uploads and records everything the import needs", async () => {
		const pending: string[] = [];
		const committed: string[] = [];
		const deps: SendDeps = {
			client: {
				uploadInk: async (_name, _pages, options) => ({ deviceDocId: options.deviceDocId, pageIds: options.pageIds, hash: "h-new" }),
			},
			ink: {
				render: () => ({
					pages: [new Uint8Array([1]), new Uint8Array([2])],
					snapshot: {
						font: "readability",
						fallbackFont: "readability",
						pen: "medium",
						color: 0,
						jitter: 0.4,
						profile: DEVICE_PROFILES.move,
						shape: 1,
					},
				}),
				persistPending: async (docId) => {
					pending.push(docId);
				},
				commitSent: async (docId) => {
					committed.push(docId);
				},
			},
			resolveEmbed: () => ({ kind: "missing" }),
			persistDocId: async () => undefined,
			layout: { fontSize: 11, lineHeight: 1.5, margin: 32 },
		};
		const { result, table } = await sendNote(
			{ path: "Plan.md", basename: "Plan", content: "---\nremarkable-id: abc\n---\nHallo", existingDocId: "abc" },
			{},
			deps,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const entry = table[result.docId];
		expect(entry.format).toBe("ink");
		expect(entry.ink?.pageIds).toHaveLength(2);
		expect(entry.ink?.profile).toEqual(DEVICE_PROFILES.move);
		expect(entry.pdfLayout?.margin).toBe(32);
		expect(entry.accountedHash).toBe("h-new");
		expect(pending).toEqual([result.docId]);
		expect(committed).toEqual([result.docId]);
	});
});
