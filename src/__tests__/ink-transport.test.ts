import { describe, expect, it } from "vitest";
import type { RawEntry, RawSyncApi } from "../transport/notebook";
import { readNotebook, sendNotebook, uploadNotebook } from "../transport/notebook";
import { ocrBody, ocrPrompt, parseOcrResponse, transcribe } from "../transport/ocr";
import type { HttpRequest } from "../transport/http";
import { sendNote, type SendDeps } from "../sync/send";
import { DEVICE_PROFILES } from "../ink/inkrender";

/** In-memory raw sync api (same shape as the text-notebook tests use). */
function fakeApi(failRootHashTimes = 0) {
	const files = new Map<string, Uint8Array>();
	const lists = new Map<string, RawEntry[]>();
	const texts = new Map<string, string>();
	let root: RawEntry | null = null;
	let generation = 1;
	let failures = failRootHashTimes;
	let counter = 0;
	const entry = (id: string): RawEntry => ({ id, hash: `h${++counter}` });
	const api: RawSyncApi = {
		getRootHash: () => Promise.resolve([root?.hash ?? "root0", generation, 3]),
		getEntries: (_id, hash) => Promise.resolve({ entries: lists.get(hash) ?? [] }),
		getHash: (_id, hash) => {
			const bytes = files.get(hash);
			if (!bytes) throw new Error(`no file for ${hash}`);
			return Promise.resolve(bytes);
		},
		putFile: (id, bytes) => {
			const e = entry(id);
			files.set(e.hash, bytes);
			return Promise.resolve([e, Promise.resolve()]);
		},
		putText: (id, content) => {
			const e = entry(id);
			files.set(e.hash, new TextEncoder().encode(content));
			texts.set(id, content);
			return Promise.resolve([e, Promise.resolve()]);
		},
		putEntries: (id, entries) => {
			const e = entry(id);
			lists.set(e.hash, [...entries]);
			return Promise.resolve([e, Promise.resolve()]);
		},
		putRootHash: (hash, gen) => {
			if (failures > 0) {
				failures--;
				return Promise.reject(new Error("precondition failed"));
			}
			expect(gen).toBe(generation);
			root = { id: "root", hash };
			generation++;
			return Promise.resolve([hash, generation]);
		},
	};
	return {
		api,
		texts,
		rootList: () => (root ? (lists.get(root.hash) ?? []) : []),
		rootWrites: () => generation - 1,
	};
}

describe("notebook upload", () => {
	it("uploads every page and reads them back by page id", async () => {
		const { api, texts } = fakeApi();
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

	it("trashes the notebook it replaces in the same root update", async () => {
		const { api, texts, rootList, rootWrites } = fakeApi();
		const old = await uploadNotebook(api, "Plan", [new Uint8Array([1])], { now: () => 1 });
		const before = rootWrites();
		const next = await uploadNotebook(api, "Plan", [new Uint8Array([2])], { now: () => 2, replaces: old.docId });
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

	it("retries a generation conflict onto the same document", async () => {
		const { api, rootList } = fakeApi(1);
		const result = await sendNotebook(api, "x", [new Uint8Array([9])], {
			retry: { attempts: 3, backoffMs: () => 0, sleep: async () => undefined },
		});
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
		const persisted: string[] = [];
		const deps: SendDeps = {
			client: {
				uploadInk: async (_name, pages) => ({ deviceDocId: "dev-9", pageIds: pages.map((_, i) => `p${i}`) }),
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
				persistSent: async (docId) => {
					persisted.push(docId);
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
		expect(entry.ink?.pageIds).toEqual(["p0", "p1"]);
		expect(entry.ink?.profile).toEqual(DEVICE_PROFILES.move);
		expect(entry.pdfLayout?.margin).toBe(32);
		expect(persisted).toEqual([result.docId]);
	});
});
