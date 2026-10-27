import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parsePageOrder } from "../incoming/pagemap";
import { remarkId } from "../incoming/remarkid";
import { parseRmScene } from "../incoming/rmscene";
import { buildInkPageRm, PEN, PEN_COLOR, type InkLine } from "../ink/rmwrite";
import {
	InPlaceRefusedError,
	NotebookChangedError,
	NotebookGoneError,
	sendNotebook,
	sendNotebookUpdate,
	type RawSyncApi,
} from "../transport/notebook";
import { fakeCloud } from "./helpers/fakecloud";
import { decodeJson, encodeJson, filesOf, onTablet, removeFromAccount, type TabletCloud } from "./helpers/tablet";

const PAPER = { paperSize: { width: 1404, height: 1872 } };
const NO_WAIT = { attempts: 3, backoffMs: () => 0, sleep: async () => undefined };

const line = (counter: number, y: number): InkLine => ({
	counter,
	tool: PEN.fineliner,
	color: PEN_COLOR.black,
	thicknessScale: 1,
	points: [
		{ x: 10, y, width: 8, pressure: 100, speed: 0, direction: 0 },
		{ x: 60, y: y + 5, width: 8, pressure: 100, speed: 0, direction: 0 },
	],
});
/** A handwritten page; a different `y`, a different page. */
const page = (y: number) => buildInkPageRm([line(100, y), line(101, y + 20)], PAPER);
/** A page the owner wrote on, as the tablet stores it. */
const ownerPage = buildInkPageRm([line(5, 700), line(6, 760), line(7, 820)], PAPER);
const ownerRemark = remarkId(parseRmScene(ownerPage).lines.map((l) => l.stroke));
/** A tablet page with typed text by an author other than the plugin. */
const typedOn = new Uint8Array(
	readFileSync(fileURLToPath(new URL("./fixtures/text-crdt-ordering.rm", import.meta.url))),
);

interface CPage {
	id: string;
	idx?: { timestamp: string; value: string };
	template?: { timestamp: string; value: string };
	deleted?: unknown;
	[field: string]: unknown;
}
interface Content {
	pageTags?: { name: string; pageId: string }[];
	tags?: { name: string }[];
	lastOpenedPage?: number;
	pages?: string[];
	cPages?: { lastOpened: { timestamp: string; value: string }; pages: CPage[] };
	[field: string]: unknown;
}

/** A notebook the plugin sent, opened on the tablet: per-page records, tags, a template on page 2. */
async function openedOnTablet() {
	const cloud = fakeCloud();
	const sent = await sendNotebook(cloud.api, "Plan", [page(100), page(300)], { retry: NO_WAIT });
	const docId = sent.docId;
	const [p1, p2] = sent.pageIds;
	const hash = await onTablet(cloud, docId, (files) => {
		const content = decodeJson<Content>(files.get(`${docId}.content`));
		files.set(
			`${docId}.content`,
			encodeJson({
				...content,
				tags: [{ name: "work", timestamp: 1 }],
				pageTags: [{ name: "todo", pageId: p2, timestamp: 2 }],
				lastOpenedPage: 1,
				customZoomScale: 1.4,
				cPages: {
					lastOpened: { timestamp: "1:3", value: p2 },
					original: { timestamp: "0:0", value: -1 },
					pages: [
						{ id: p1, idx: { timestamp: "1:2", value: "ba" }, template: { timestamp: "1:1", value: "Blank" } },
						{
							id: p2,
							idx: { timestamp: "1:2", value: "bb" },
							template: { timestamp: "1:4", value: "P Grid medium" },
							scrollTime: { timestamp: "1:5", value: "123" },
						},
					],
					uuids: [{ first: "tablet", second: 1 }],
				},
			}),
		);
	});
	return { cloud, docId, p1, p2, pageIds: sent.pageIds, hash };
}

async function contentOf(cloud: TabletCloud, docId: string) {
	const files = await filesOf(cloud, docId);
	const bytes = files.get(`${docId}.content`);
	return { files, content: decodeJson<Content>(bytes), order: parsePageOrder(new TextDecoder().decode(bytes)) };
}

describe("updating a notebook in place", () => {
	it("keeps the document, its page ids, and what the owner set on the pages", async () => {
		const { cloud, docId, p1, p2, pageIds, hash } = await openedOnTablet();
		const putPages: string[] = [];
		const api: RawSyncApi = {
			...cloud.api,
			putFile: (id, bytes) => {
				putPages.push(id);
				return cloud.api.putFile(id, bytes);
			},
		};
		const result = await sendNotebookUpdate(api, docId, "Plan v2", [page(100), page(320), page(500)], {
			expectedHash: hash,
			pageIds,
			retry: NO_WAIT,
		});

		expect(result.docId).toBe(docId);
		expect(result.pageIds.slice(0, 2)).toEqual([p1, p2]);
		const p3 = result.pageIds[2];
		expect([p1, p2]).not.toContain(p3);
		expect(cloud.live()).toEqual([docId]);
		expect(result.hash).toBe(cloud.hashOf(docId));

		const { files, content, order } = await contentOf(cloud, docId);
		expect(order).toEqual([p1, p2, p3]);
		expect(content.tags).toEqual([{ name: "work", timestamp: 1 }]);
		expect(content.pageTags).toEqual([{ name: "todo", pageId: p2, timestamp: 2 }]);
		expect(content.customZoomScale).toBe(1.4);
		expect(content.lastOpenedPage).toBe(1);
		expect(content.cPages?.lastOpened.value).toBe(p2);
		// Page 2's own record — its template, its scroll — is untouched; the new page sorts after it.
		expect(content.cPages?.pages[1]).toEqual({
			id: p2,
			idx: { timestamp: "1:2", value: "bb" },
			template: { timestamp: "1:4", value: "P Grid medium" },
			scrollTime: { timestamp: "1:5", value: "123" },
		});
		expect(content.cPages?.pages[2]).toMatchObject({ id: p3, template: { value: "Blank" } });
		expect(content.cPages!.pages[2].idx!.value > "bb").toBe(true);
		expect(files.get(`${docId}/${p2}.rm`)).toEqual(page(320));
		// Page 1 did not change: it was not uploaded again.
		expect(putPages).toEqual([`${docId}/${p2}.rm`, `${docId}/${p3}.rm`]);
		const metadata = decodeJson(files.get(`${docId}.metadata`));
		expect(metadata).toMatchObject({ visibleName: "Plan v2", parent: "" });
		expect(metadata.createdTime).toBeDefined();
	});

	it("writes nothing when nothing changed", async () => {
		const { cloud, docId, pageIds, hash } = await openedOnTablet();
		const writes = cloud.rootWrites();
		const result = await sendNotebookUpdate(cloud.api, docId, "Plan", [page(100), page(300)], {
			expectedHash: hash,
			pageIds,
			retry: NO_WAIT,
		});
		expect(result.hash).toBe(hash);
		expect(cloud.rootWrites()).toBe(writes);
	});

	it("writes nothing when the notebook changed since it was read", async () => {
		const { cloud, docId, pageIds, hash } = await openedOnTablet();
		const edited = cloud.writeOnTablet(docId);
		const writes = cloud.rootWrites();
		const attempt = sendNotebookUpdate(cloud.api, docId, "Plan", [page(150), page(300)], {
			expectedHash: hash,
			pageIds,
			retry: NO_WAIT,
		});
		await expect(attempt).rejects.toBeInstanceOf(NotebookChangedError);
		await expect(attempt).rejects.toMatchObject({ expectedHash: hash, actualHash: edited });
		expect(cloud.rootWrites()).toBe(writes);
		expect(cloud.hashOf(docId)).toBe(edited);
	});

	it("keeps a page the owner added where it was, until its ink is in the note", async () => {
		const { cloud, docId, p1, p2, pageIds } = await openedOnTablet();
		const added = await onTablet(cloud, docId, (files) => {
			const content = decodeJson<Content>(files.get(`${docId}.content`));
			const owner = { id: "owner", idx: { timestamp: "2:1", value: "baa" } };
			files.set(
				`${docId}.content`,
				encodeJson({
					...content,
					pageTags: [...(content.pageTags ?? []), { name: "mine", pageId: "owner", timestamp: 3 }],
					cPages: { ...content.cPages, pages: [content.cPages!.pages[0], owner, content.cPages!.pages[1]] },
				}),
			);
			files.set(`${docId}/owner.rm`, ownerPage);
		});

		const kept = await sendNotebookUpdate(cloud.api, docId, "Plan", [page(100), page(320)], {
			expectedHash: added,
			pageIds,
			noteText: "A note without that page's remark.",
			retry: NO_WAIT,
		});
		let read = await contentOf(cloud, docId);
		expect(read.order).toEqual([p1, "owner", p2]);
		expect(read.files.get(`${docId}/owner.rm`)).toEqual(ownerPage);

		await sendNotebookUpdate(cloud.api, docId, "Plan", [page(100), page(340)], {
			expectedHash: kept.hash,
			pageIds: kept.pageIds,
			noteText: `> [!note] Page you added\n> ![[remark.png]]\n> ^ink-${ownerRemark}\n`,
			retry: NO_WAIT,
		});
		read = await contentOf(cloud, docId);
		expect(read.order).toEqual([p1, p2]);
		// Gone as the tablet deletes a page: record and files stay, the record marked with a later stamp.
		expect(read.content.cPages?.pages.find((one) => one.id === "owner")?.deleted).toEqual({ timestamp: "2:2", value: 1 });
		expect(read.files.get(`${docId}/owner.rm`)).toEqual(ownerPage);
		expect(read.content.pageTags?.map((tag) => tag.pageId)).toEqual([p2]);
	});

	it("drops the pages the note no longer fills, keeping an owner's page that followed them", async () => {
		const { cloud, docId, p1, p2, pageIds } = await openedOnTablet();
		const added = await onTablet(cloud, docId, (files) => {
			const content = decodeJson<Content>(files.get(`${docId}.content`));
			const owner = { id: "owner", idx: { timestamp: "2:1", value: "bc" } };
			files.set(`${docId}.content`, encodeJson({ ...content, cPages: { ...content.cPages, pages: [...content.cPages!.pages, owner] } }));
			files.set(`${docId}/owner.rm`, ownerPage);
		});
		const result = await sendNotebookUpdate(cloud.api, docId, "Plan", [page(100)], {
			expectedHash: added,
			pageIds,
			noteText: "",
			retry: NO_WAIT,
		});
		expect(result.pageIds).toEqual([p1]);
		const { files, content, order } = await contentOf(cloud, docId);
		expect(order).toEqual([p1, "owner"]);
		expect(content.cPages?.pages.find((one) => one.id === p2)?.deleted).toEqual({ timestamp: "1:3", value: 1 });
		expect(files.has(`${docId}/${p2}.rm`)).toBe(true);
		expect(content.pageTags).toEqual([]);
		// The page it was open on is gone: it opens on the first page.
		expect(content.lastOpenedPage).toBe(0);
		expect(content.cPages?.lastOpened.value).toBe(p1);
	});

	it("brings back a page of ours the owner deleted under a new id, leaving the tablet's delete as it was", async () => {
		const { cloud, docId, p1, p2, pageIds } = await openedOnTablet();
		const deleted = await onTablet(cloud, docId, (files) => {
			const content = decodeJson<Content>(files.get(`${docId}.content`));
			const pages = content.cPages!.pages.map((p) => (p.id === p2 ? { ...p, deleted: { timestamp: "1:6", value: 1 } } : p));
			files.set(`${docId}.content`, encodeJson({ ...content, cPages: { ...content.cPages, pages } }));
		});
		const result = await sendNotebookUpdate(cloud.api, docId, "Plan", [page(100), page(320)], {
			expectedHash: deleted,
			pageIds,
			retry: NO_WAIT,
		});
		const back = result.pageIds[1];
		expect(result.pageIds[0]).toBe(p1);
		expect(back).not.toBe(p2);
		const { files, content, order } = await contentOf(cloud, docId);
		expect(order).toEqual([p1, back]);
		expect(content.cPages?.pages.find((one) => one.id === p2)?.deleted).toEqual({ timestamp: "1:6", value: 1 });
		expect(files.get(`${docId}/${back}.rm`)).toEqual(page(320));
	});

	it("keeps an owner's page where its order key puts it, not where its record is stored", async () => {
		const { cloud, docId, p1, p2, pageIds } = await openedOnTablet();
		const added = await onTablet(cloud, docId, (files) => {
			const content = decodeJson<Content>(files.get(`${docId}.content`));
			// Inserted between our pages on the tablet, stored at the end of the list.
			const owner = { id: "owner", idx: { timestamp: "2:1", value: "baa" } };
			files.set(`${docId}.content`, encodeJson({ ...content, cPages: { ...content.cPages, pages: [...content.cPages!.pages, owner] } }));
			files.set(`${docId}/owner.rm`, ownerPage);
		});
		const first = await sendNotebookUpdate(cloud.api, docId, "Plan", [page(100), page(320)], {
			expectedHash: added,
			pageIds,
			noteText: "",
			retry: NO_WAIT,
		});
		expect((await contentOf(cloud, docId)).order).toEqual([p1, "owner", p2]);
		await sendNotebookUpdate(cloud.api, docId, "Plan", [page(100), page(340)], {
			expectedHash: first.hash,
			pageIds: first.pageIds,
			noteText: "",
			retry: NO_WAIT,
		});
		expect((await contentOf(cloud, docId)).order).toEqual([p1, "owner", p2]);
	});

	it("hands back the pending record of an update whose root write provably never landed", async () => {
		const { cloud, docId, pageIds, hash } = await openedOnTablet();
		const announced: string[] = [];
		const abandoned: string[] = [];
		const hooks = {
			beforeCommit: async (newHash: string, _ids: string[], written: string[]) => {
				expect(written.length).toBeGreaterThan(0);
				announced.push(newHash);
			},
			abandoned: async (newHash: string) => {
				abandoned.push(newHash);
			},
		};
		// The account changes under every attempt: nothing landed.
		cloud.onRootWrite(() => new Error("precondition failed"));
		await expect(
			sendNotebookUpdate(cloud.api, docId, "Plan", [page(100), page(330)], { expectedHash: hash, pageIds, retry: NO_WAIT, ...hooks }),
		).rejects.toThrow(/precondition/);
		expect(announced).toHaveLength(3);
		expect(abandoned).toEqual([announced[2]]);

		// The tablet wrote into the notebook while the root write was on its way: it
		// is refused, and the retry finds the notebook changed.
		abandoned.length = 0;
		cloud.onRootWrite(null);
		let edited = false;
		const changing: typeof hooks = {
			...hooks,
			beforeCommit: async (newHash, ids, written) => {
				await hooks.beforeCommit(newHash, ids, written);
				if (edited) return;
				edited = true;
				await onTablet(cloud, docId, (files) => files.set(`${docId}.pagedata`, new TextEncoder().encode("Lined\n")));
			},
		};
		await expect(
			sendNotebookUpdate(cloud.api, docId, "Plan", [page(100), page(331)], { expectedHash: hash, pageIds, retry: NO_WAIT, ...changing }),
		).rejects.toBeInstanceOf(NotebookChangedError);
		expect(abandoned).toEqual([announced[announced.length - 1]]);

		// A root write that failed on the way may have landed: it is left for the next run to settle.
		abandoned.length = 0;
		const current = cloud.hashOf(docId)!;
		cloud.onRootWrite(() => new Error("socket hang up"));
		await expect(
			sendNotebookUpdate(cloud.api, docId, "Plan", [page(100), page(332)], { expectedHash: current, pageIds, retry: NO_WAIT, ...hooks }),
		).rejects.toThrow(/socket/);
		expect(abandoned).toEqual([]);
		cloud.onRootWrite(null);
	});

	it("refuses to overwrite a page of ours the owner typed text on, or one it cannot read", async () => {
		const { cloud, docId, p1, p2, pageIds } = await openedOnTablet();
		const typed = await onTablet(cloud, docId, (files) => files.set(`${docId}/${p1}.rm`, typedOn));
		const writes = cloud.rootWrites();
		const attempt = sendNotebookUpdate(cloud.api, docId, "Plan", [page(150), page(300)], {
			expectedHash: typed,
			pageIds,
			retry: NO_WAIT,
		});
		await expect(attempt).rejects.toBeInstanceOf(InPlaceRefusedError);
		await expect(attempt).rejects.toMatchObject({ reason: "typed-text", page: 1 });
		expect(cloud.rootWrites()).toBe(writes);

		const unreadable = await onTablet(cloud, docId, (files) => files.set(`${docId}/${p2}.rm`, new Uint8Array([7])));
		// Page 1 written as it is now leaves its text alone; dropping page 2 would lose what cannot be read.
		const dropping = sendNotebookUpdate(cloud.api, docId, "Plan", [typedOn], {
			expectedHash: unreadable,
			pageIds,
			retry: NO_WAIT,
		});
		await expect(dropping).rejects.toMatchObject({ reason: "unreadable-page", page: 2 });
		expect((await filesOf(cloud, docId)).get(`${docId}/${p1}.rm`)).toEqual(typedOn);
	});

	it("reports a notebook that is gone or in the trash, writing nothing", async () => {
		const { cloud, docId, pageIds } = await openedOnTablet();
		const trashed = await onTablet(cloud, docId, (files) => {
			const metadata = decodeJson(files.get(`${docId}.metadata`));
			files.set(`${docId}.metadata`, encodeJson({ ...metadata, parent: "trash" }));
		});
		const update = (expectedHash: string) =>
			sendNotebookUpdate(cloud.api, docId, "Plan", [page(150)], { expectedHash, pageIds, retry: NO_WAIT });
		await expect(update(trashed)).rejects.toBeInstanceOf(NotebookGoneError);
		await removeFromAccount(cloud, docId);
		const writes = cloud.rootWrites();
		await expect(update(trashed)).rejects.toBeInstanceOf(NotebookGoneError);
		expect(cloud.rootWrites()).toBe(writes);
	});

	it("retries a refused root write with the same new pages, announcing each attempt before it lands", async () => {
		const { cloud, docId, pageIds, hash } = await openedOnTablet();
		let refusals = 1;
		cloud.onRootWrite(() => (refusals-- > 0 ? new Error("precondition failed") : undefined));
		const announced: { hash: string; pageIds: string[] }[] = [];
		const result = await sendNotebookUpdate(cloud.api, docId, "Plan", [page(100), page(320), page(500)], {
			expectedHash: hash,
			pageIds,
			retry: NO_WAIT,
			beforeCommit: async (newHash, ids) => {
				announced.push({ hash: newHash, pageIds: ids });
			},
		});
		expect(announced).toHaveLength(2);
		expect(announced[0].pageIds).toEqual(announced[1].pageIds);
		expect(announced[1]).toEqual({ hash: result.hash, pageIds: result.pageIds });
		expect(cloud.hashOf(docId)).toBe(result.hash);
	});

	it("removes a page that goes from a notebook the tablet never gave per-page records, and keeps its size current", async () => {
		const cloud = fakeCloud();
		const sent = await sendNotebook(cloud.api, "Plan", [page(100), page(300), page(500)], { retry: NO_WAIT });
		const [p1, p2, p3] = sent.pageIds;
		const update = (hash: string) =>
			sendNotebookUpdate(cloud.api, sent.docId, "Plan", [page(100), page(320)], { expectedHash: hash, pageIds: sent.pageIds, retry: NO_WAIT });
		const first = await update(sent.hash);
		const { files, content, order } = await contentOf(cloud, sent.docId);
		expect(order).toEqual([p1, p2]);
		expect(files.has(`${sent.docId}/${p3}.rm`)).toBe(false);
		expect(content.sizeInBytes).toBe(String(page(100).length + page(320).length));
		// Sent again as it is: the page stays gone, nothing is written.
		const writes = cloud.rootWrites();
		await update(first.hash);
		expect((await contentOf(cloud, sent.docId)).order).toEqual([p1, p2]);
		expect(cloud.rootWrites()).toBe(writes);
		// A file the page list does not name (left by an earlier version) is not a page.
		const orphaned = await onTablet(cloud, sent.docId, (files) => files.set(`${sent.docId}/${p3}.rm`, page(500)));
		await update(orphaned);
		expect((await contentOf(cloud, sent.docId)).order).toEqual([p1, p2]);
	});
});
