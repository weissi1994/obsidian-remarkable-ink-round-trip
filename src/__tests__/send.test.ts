import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	NoteInput,
	SendDeps,
	SendResult,
	SentRecord,
	notesNeedingUpload,
	prepareNoteContent,
	sendBatch,
	sendNote,
} from "../sync/send";
import { TYPO_VERSION } from "../convert/pdf";
import { isValidDocId } from "../id/docid";
import { MappingEntry, MappingTable, contentHash } from "../id/mapping";
import { parsePageOrder } from "../incoming/pagemap";
import { remarkId } from "../incoming/remarkid";
import { parseRmScene } from "../incoming/rmscene";
import { DEVICE_PROFILES } from "../ink/inkrender";
import { buildInkPageRm, PEN, PEN_COLOR, type InkLine } from "../ink/rmwrite";
import { SyncState, type StateFs } from "../sync/syncstate";
import { sendNotebook, sendNotebookUpdate } from "../transport/notebook";
import { fakeCloud } from "./helpers/fakecloud";
import { memoryFs } from "./helpers/memoryfs";
import { filesOf, onTablet, removeFromAccount } from "./helpers/tablet";

/** What a result has to say: its error, or the warning that came with a send. */
const messageOf = (result: SendResult): string => (result.ok ? (result.warning ?? "") : result.error);

/** The account listing as settlePending takes it: device document id → hash. */
const listed = (cloud: { listing(): { id: string; hash: string }[] }) =>
	new Map(cloud.listing().map((item) => [item.id, item.hash]));

function makeDeps(overrides: Partial<SendDeps> = {}) {
	const uploads: { name: string; pages: Uint8Array[] }[] = [];
	const persisted: { path: string; docId: string }[] = [];
	const sent: Record<string, SentRecord> = {};
	const deps: SendDeps = {
		client: {
			uploadInk: (name, pages) => {
				uploads.push({ name, pages });
				return Promise.resolve({ deviceDocId: `device-${uploads.length}`, pageIds: ["p1"], hash: `hash-${uploads.length}` });
			},
		},
		ink: {
			render: () => ({
				pages: [new Uint8Array([1])],
				snapshot: {
					font: "readability",
					fallbackFont: "readability",
					pen: "medium",
					color: 0,
					jitter: 0.4,
					profile: DEVICE_PROFILES.rm2,
					shape: 1,
				},
			}),
			commitSent: (docId, record) => {
				sent[docId] = record;
				return Promise.resolve();
			},
		},
		resolveEmbed: () => ({ kind: "missing" }),
		persistDocId: (note, docId) => {
			persisted.push({ path: note.path, docId });
			return Promise.resolve();
		},
		...overrides,
	};
	return { deps, uploads, persisted, sent };
}

const NOTE: NoteInput = {
	path: "map/Nota.md",
	basename: "Nota",
	content: "---\ntitle: X\n---\nInhoud van de notitie.",
};

describe("notesNeedingUpload", () => {
	const docId = "0f8fad5b-d9cb-469f-a165-70867728950e";
	const note = { ...NOTE, existingDocId: docId };
	const missing = () => ({ kind: "missing" as const });
	const tableFor = (format: "ink" | "pdf"): MappingTable => ({
		[docId]: {
			docId,
			notePath: note.path,
			deviceDocId: "device-a",
			uploadedAt: "2026-09-03T00:00:00Z",
			contentHash: contentHash(prepareNoteContent(note, missing).markdown),
			format,
		},
	});

	it("filters unchanged notes before cloud work is queued", () => {
		expect(notesNeedingUpload([note], tableFor("ink"), missing)).toEqual([]);
		expect(
			notesNeedingUpload([{ ...note, content: `${note.content}\nChanged.` }], tableFor("ink"), missing),
		).toHaveLength(1);
	});

	it("re-sends a note last sent as PDF, even when unchanged", () => {
		expect(notesNeedingUpload([note], tableFor("pdf"), missing)).toHaveLength(1);
	});
});

describe("sendNote", () => {
	it("generates and persists a docId, uploads a notebook, and records the mapping", async () => {
		const { deps, uploads, persisted } = makeDeps();
		const { result, table } = await sendNote(NOTE, {}, deps);

		if (!result.ok) throw new Error(`unexpected failure: ${result.error}`);
		expect(isValidDocId(result.docId)).toBe(true);
		expect(persisted).toEqual([{ path: "map/Nota.md", docId: result.docId }]);
		expect(uploads[0].name).toBe("Nota");
		expect(table[result.docId]).toMatchObject({
			notePath: "map/Nota.md",
			deviceDocId: "device-1",
			format: "ink",
		});
		expect(table[result.docId].ink?.pageIds).toEqual(["p1"]);
	});

	it("keeps the note body as the merge base, frontmatter left out", async () => {
		const { deps, sent } = makeDeps();
		const { result } = await sendNote(NOTE, {}, deps);
		if (!result.ok) throw new Error("unexpected failure");
		expect(sent[result.docId].body).toBe("Inhoud van de notitie.");
		expect(sent[result.docId].markdown).toContain("Inhoud van de notitie.");
	});

	it("reuses an existing docId without persisting again", async () => {
		const { deps, persisted } = makeDeps();
		const existing = "0f8fad5b-d9cb-469f-a165-70867728950e";
		const { result } = await sendNote({ ...NOTE, existingDocId: existing }, {}, deps);
		if (!result.ok) throw new Error("unexpected failure");
		expect(result.docId).toBe(existing);
		expect(persisted).toHaveLength(0);
	});

	it("returns a failure result instead of throwing", async () => {
		const { deps } = makeDeps({
			client: { uploadInk: () => Promise.reject(new Error("cloud down")) },
		});
		const { result, table } = await sendNote(NOTE, {}, deps);
		expect(result).toMatchObject({ ok: false, error: "cloud down" });
		expect(table).toEqual({});
	});

	it("records the typography, so tablet changes can be anchored", async () => {
		const { deps } = makeDeps({ layout: { fontSize: 13 } });
		const { table } = await sendNote(NOTE, {}, deps);
		expect(Object.values(table)[0].pdfLayout).toMatchObject({ fontSize: 13, typo: TYPO_VERSION });
	});
});

describe("sendNote skipUnchanged", () => {
	it("skips the upload when content is unchanged, and sends when it changed", async () => {
		const { deps, uploads } = makeDeps({ skipUnchanged: true });
		const first = await sendNote(NOTE, {}, deps);
		if (!first.result.ok) throw new Error("unexpected failure");
		expect(uploads).toHaveLength(1);

		const again = await sendNote(
			{ ...NOTE, existingDocId: first.result.docId },
			first.table,
			deps,
		);
		if (!again.result.ok) throw new Error("unexpected failure");
		expect(again.result.skipped).toBe(true);
		expect(uploads).toHaveLength(1);

		const changed = await sendNote(
			{
				...NOTE,
				content: `${NOTE.content}\nExtra regel.`,
				existingDocId: first.result.docId,
			},
			again.table,
			deps,
		);
		if (!changed.result.ok) throw new Error("unexpected failure");
		expect(changed.result.skipped).toBeUndefined();
		expect(uploads).toHaveLength(2);
	});
});

describe("sendNote folder mirroring hooks", () => {
	it("does not upload when the destination folder was not resolved", async () => {
		const { deps, uploads } = makeDeps({
			resolveParent: () => Promise.reject(new Error("folder creation failed")),
		});
		const { result } = await sendNote(NOTE, {}, deps);

		expect(result).toMatchObject({
			ok: false,
			error: "folder creation failed",
		});
		expect(uploads).toHaveLength(0);
	});

	it("uploads into the resolved parent and retires the previous device copy", async () => {
		const trashed: string[] = [];
		const parents: string[] = [];
		const { deps, uploads } = makeDeps({
			resolveParent: (notePath) => {
				parents.push(notePath);
				return Promise.resolve("dir-42");
			},
			replacePrevious: (id) => {
				trashed.push(id);
				return Promise.resolve("trashed");
			},
		});
		const uploadArgs: (string | undefined)[] = [];
		deps.client = {
			uploadInk: (name, pages, uploadOptions) => {
				uploadArgs.push(uploadOptions.parentId);
				uploads.push({ name, pages });
				return Promise.resolve({ deviceDocId: `device-${uploads.length}`, pageIds: ["p1"], hash: `hash-${uploads.length}` });
			},
		};

		const first = await sendNote(NOTE, {}, deps);
		if (!first.result.ok) throw new Error("unexpected failure");
		const second = await sendNote(
			{
				...NOTE,
				content: `${NOTE.content}\nGewijzigd.`,
				existingDocId: first.result.docId,
			},
			first.table,
			deps,
		);
		if (!second.result.ok) throw new Error("unexpected failure");

		expect(parents).toEqual(["map/Nota.md", "map/Nota.md"]);
		expect(uploadArgs).toEqual(["dir-42", "dir-42"]);
		expect(trashed).toEqual(["device-1"]);
	});

	it("sends anyway when the old copy cannot be trashed, and says so", async () => {
		const { deps } = makeDeps({
			replacePrevious: () => Promise.reject(new Error("trash faalt")),
		});
		const first = await sendNote(NOTE, {}, deps);
		if (!first.result.ok) throw new Error("unexpected failure");
		const second = await sendNote(
			{ ...NOTE, content: "ander", existingDocId: first.result.docId },
			first.table,
			deps,
		);
		expect(second.result.ok).toBe(true);
		expect(messageOf(second.result)).toContain("trash faalt");
	});

	it("leaves an old copy that changed during the send alone, and says so", async () => {
		const { deps } = makeDeps({ replacePrevious: () => Promise.resolve("changed") });
		const first = await sendNote(NOTE, {}, deps);
		if (!first.result.ok) throw new Error("unexpected failure");
		const second = await sendNote({ ...NOTE, content: "ander", existingDocId: first.result.docId }, first.table, deps);
		expect(second.result.ok).toBe(true);
		expect(messageOf(second.result)).toContain("was kept");
	});
});

describe("sendBatch", () => {
	it("continues after a failure and reports per file", async () => {
		let calls = 0;
		const { deps } = makeDeps({
			client: {
				uploadInk: () => {
					calls++;
					return calls === 1
						? Promise.reject(new Error("eerste faalt"))
						: Promise.resolve({ deviceDocId: `device-${calls}`, pageIds: ["p1"] });
				},
			},
		});
		const progress: number[] = [];
		const { results, table } = await sendBatch(
			[NOTE, { ...NOTE, path: "b.md", basename: "b" }],
			{},
			deps,
			(done) => progress.push(done),
		);
		expect(results.map((r) => r.ok)).toEqual([false, true]);
		expect(Object.keys(table)).toHaveLength(1);
		expect(progress).toEqual([1, 2]);
	});

	it("records every landed upload of a batch at once", async () => {
		const { deps } = makeDeps();
		const checkpoints: number[] = [];
		const notes = Array.from({ length: 45 }, (_, index) => ({
			...NOTE,
			path: `batch/${index}.md`,
			basename: String(index),
		}));

		const { table } = await sendBatch(
			notes,
			{},
			deps,
			undefined,
			async (checkpoint) => {
				checkpoints.push(Object.keys(checkpoint).length);
			},
		);

		expect(checkpoints).toHaveLength(45);
		expect(checkpoints[44]).toBe(45);
		expect(Object.keys(table)).toHaveLength(45);
	});

	it("records a single landed send at once too", async () => {
		const { deps } = makeDeps();
		const checkpoints: MappingTable[] = [];
		await sendBatch([NOTE], {}, deps, undefined, async (checkpoint) => {
			checkpoints.push(checkpoint);
		});
		expect(checkpoints).toHaveLength(1);
		expect(Object.values(checkpoints[0])[0].deviceDocId).toBe("device-1");
	});
});

describe("sending without losing tablet ink", () => {
	const DOC = "0f8fad5b-d9cb-469f-a165-70867728950e";
	const ROOT = "reMarkable/.sync";
	const note: NoteInput = { ...NOTE, existingDocId: DOC };
	const edited: NoteInput = { ...note, content: `${NOTE.content}\nTyped in Obsidian.` };
	const NO_WAIT = { attempts: 3, backoffMs: () => 0, sleep: async () => undefined };

	/** The production wiring: real upload protocol, shared sync state on a file seam. */
	function setup() {
		const cloud = fakeCloud();
		const disk = memoryFs();
		const state = new SyncState(disk.fs, ROOT);
		const { deps } = makeDeps({
			client: {
				uploadInk: (name, pages, options) =>
					sendNotebook(cloud.api, name, pages, {
						parentId: options.parentId,
						replaces: options.replaces,
						expectedHash: options.expectedHash,
						docId: options.deviceDocId,
						pageIds: options.pageIds,
						retry: NO_WAIT,
					}).then((r) => ({ deviceDocId: r.docId, pageIds: r.pageIds, hash: r.hash, replaced: r.replaced })),
			},
			replacePrevious: () => Promise.resolve("not-found"),
		});
		deps.ink = {
			...deps.ink,
			persistPending: (docId, sent, mapping) => state.writePending(docId, sent, mapping),
			commitSent: (docId, sent, mapping) => state.commitSent(docId, sent, mapping),
		};
		return { cloud, disk, state, deps };
	}

	async function sentOnce(deps: SendDeps): Promise<MappingTable> {
		const { result, table } = await sendNote(note, {}, deps);
		if (!result.ok) throw new Error(result.error);
		return table;
	}

	it("does not replace a notebook that could not be read in this run", async () => {
		const { cloud, deps } = setup();
		const table = await sentOnce(deps);
		const before = cloud.rootWrites();
		const { results } = await sendBatch(
			[edited, { ...NOTE, path: "other.md", basename: "other" }],
			table,
			{ ...deps, unread: new Map([[DOC, "network down"]]) },
		);
		expect(results[0].ok).toBe(false);
		expect(messageOf(results[0])).toContain("could not be read (network down)");
		expect(results[1].ok).toBe(true);
		// Only the other note's notebook was written; the unread one is untouched.
		expect(cloud.rootWrites() - before).toBe(1);
		expect(cloud.parentOf(table[DOC].deviceDocId)).toBe("");
	});

	it("reads ink synced after the pull before replacing the notebook, then sends", async () => {
		const { cloud, state, deps } = setup();
		const table = await sentOnce(deps);
		const old = table[DOC].deviceDocId;
		cloud.writeOnTablet(old);
		const writesBefore = cloud.rootWrites();
		const rereads: string[] = [];
		deps.reread = async (current) => {
			rereads.push(current.path);
			// The pull merges the new ink and records the hash it read.
			return {
				note: { ...current, content: `${current.content}\nWritten on the tablet.` },
				entry: { ...table[DOC], accountedHash: cloud.hashOf(old) },
			};
		};
		const { result, table: after } = await sendNote(edited, table, deps);
		expect(result.ok).toBe(true);
		expect(rereads).toEqual([note.path]);
		// The refused attempt wrote nothing; the second replaced in one root write.
		expect(cloud.rootWrites() - writesBefore).toBe(1);
		expect(cloud.parentOf(old)).toBe("trash");
		expect(cloud.live()).toEqual([after[DOC].deviceDocId]);
		expect((await state.readSent(DOC))?.body).toContain("Written on the tablet.");
	});

	it("reads a notebook whose hash is not known before replacing it", async () => {
		const { cloud, deps } = setup();
		const table = await sentOnce(deps);
		const old = table[DOC].deviceDocId;
		// A send committed without the hash it wrote (an older version, a settled crash).
		const unknown: MappingTable = { [DOC]: { ...table[DOC], accountedHash: undefined } };
		cloud.writeOnTablet(old);
		const writes = cloud.rootWrites();
		const held = await sendNote(edited, unknown, deps);
		expect(held.result.ok).toBe(false);
		expect(messageOf(held.result)).toContain("not read since it was last sent");
		expect(cloud.rootWrites()).toBe(writes);

		const rereads: string[] = [];
		deps.reread = async (current) => {
			rereads.push(current.path);
			return { note: current, entry: { ...table[DOC], accountedHash: cloud.hashOf(old) } };
		};
		const { result } = await sendNote(edited, unknown, deps);
		expect(result.ok).toBe(true);
		expect(rereads).toEqual([note.path]);
		expect(cloud.parentOf(old)).toBe("trash");
	});

	it("holds the note back when the notebook keeps changing, keeping what the re-read recorded", async () => {
		const { cloud, deps } = setup();
		const table = await sentOnce(deps);
		const old = table[DOC].deviceDocId;
		cloud.writeOnTablet(old);
		deps.reread = async (current) => {
			const read = cloud.hashOf(old);
			cloud.writeOnTablet(old); // still being written in
			return { note: current, entry: { ...table[DOC], accountedHash: read } };
		};
		const { result, table: after } = await sendNote(edited, table, deps);
		expect(result.ok).toBe(false);
		expect(messageOf(result)).toContain("keeps changing");
		expect(cloud.live()).toEqual([old]);
		expect(after[DOC].accountedHash).not.toBe(table[DOC].accountedHash);
	});

	it("keeps the merge base when the upload fails", async () => {
		const { disk, state, deps, cloud } = setup();
		const table = await sentOnce(deps);
		const base = await state.readSent(DOC);
		deps.client = { uploadInk: () => Promise.reject(new Error("cloud down")) };
		const { result } = await sendNote(edited, table, deps);
		expect(result).toMatchObject({ ok: false, error: "cloud down" });
		expect(await state.readSent(DOC)).toEqual(base);
		// The next run finds the send never landed and drops it.
		const next = new SyncState(disk.fs, ROOT);
		const loaded = await next.loadMappings();
		const settled = await next.settlePending(loaded, listed(cloud));
		expect(settled.dropped).toEqual([DOC]);
		expect(settled.table[DOC]).toEqual(table[DOC]);
		expect(await next.readSent(DOC)).toEqual(base);
	});

	it("records a send that landed just before a crash, and does not send it twice", async () => {
		const { cloud, disk, deps } = setup();
		const table = await sentOnce(deps);
		const old = table[DOC].deviceDocId;
		// The plugin dies after the upload, before the send is committed.
		const crashing = { ...deps, ink: { ...deps.ink, commitSent: () => Promise.reject(new Error("crash")) } };
		await sendNote(edited, table, crashing);
		const [landed] = cloud.live();
		expect(landed).not.toBe(old);

		const next = new SyncState(disk.fs, ROOT);
		const loaded = await next.loadMappings();
		expect(loaded[DOC].deviceDocId).toBe(old);
		const settled = await next.settlePending(loaded, listed(cloud));
		expect(settled.committed).toEqual([DOC]);
		expect(settled.table[DOC].deviceDocId).toBe(landed);
		expect((await next.readSent(DOC))?.body).toContain("Typed in Obsidian.");

		const writes = cloud.rootWrites();
		const again = await sendNote(edited, settled.table, { ...deps, skipUnchanged: true });
		expect(again.result).toMatchObject({ ok: true, skipped: true });
		expect(cloud.rootWrites()).toBe(writes);
		expect(cloud.live()).toEqual([landed]);
	});
});

describe("sending into the same notebook", () => {
	const DOC = "0f8fad5b-d9cb-469f-a165-70867728950e";
	const ROOT = "reMarkable/.sync";
	const note: NoteInput = { ...NOTE, existingDocId: DOC };
	const edited: NoteInput = { ...note, content: `${NOTE.content}\n\nTyped in Obsidian.` };
	const NO_WAIT = { attempts: 3, backoffMs: () => 0, sleep: async () => undefined };
	const PAPER = { paperSize: { width: 1404, height: 1872 } };
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

	/** The production wiring with in-place updates; one handwritten page per block, so an edit changes only its page. */
	function setup() {
		const cloud = fakeCloud();
		const disk = memoryFs();
		const state = new SyncState(disk.fs, ROOT, "this-copy");
		const trashed: string[] = [];
		const { deps } = makeDeps({
			client: {
				uploadInk: (name, pages, options) =>
					sendNotebook(cloud.api, name, pages, {
						parentId: options.parentId,
						replaces: options.replaces,
						expectedHash: options.expectedHash,
						docId: options.deviceDocId,
						pageIds: options.pageIds,
						retry: NO_WAIT,
					}).then((r) => ({ deviceDocId: r.docId, pageIds: r.pageIds, hash: r.hash, replaced: r.replaced })),
				updateInk: (deviceDocId, name, pages, options) =>
					sendNotebookUpdate(cloud.api, deviceDocId, name, pages, { ...options, retry: NO_WAIT }).then((r) => ({
						deviceDocId: r.docId,
						pageIds: r.pageIds,
						hash: r.hash,
					})),
			},
			replacePrevious: (id) => {
				trashed.push(id);
				return Promise.resolve("trashed");
			},
		});
		deps.ink = {
			...deps.ink,
			render: (blocks) => ({
				pages: blocks.map((block, index) => buildInkPageRm([line(100 + index, 100 + JSON.stringify(block).length)], PAPER)),
				snapshot: {
					font: "readability",
					fallbackFont: "readability",
					pen: "medium",
					color: 0,
					jitter: 0.4,
					profile: DEVICE_PROFILES.rm2,
					shape: 1,
				},
			}),
			persistPending: (docId, sent, mapping, previousHash, written) => state.writePending(docId, sent, mapping, previousHash, written),
			commitSent: (docId, sent, mapping) => state.commitSent(docId, sent, mapping),
		};
		return { cloud, disk, state, deps, trashed };
	}

	async function sentOnce(deps: SendDeps): Promise<MappingTable> {
		const { result, table } = await sendNote(note, {}, deps);
		if (!result.ok) throw new Error(result.error);
		return table;
	}

	const settleNextRun = async (fs: StateFs, cloud: { listing(): { id: string; hash: string }[] }) => {
		const next = new SyncState(fs, ROOT, "this-copy");
		return { next, settled: await next.settlePending(await next.loadMappings(), listed(cloud)) };
	};

	it("writes a changed note into its notebook: same document, same pages, nothing trashed", async () => {
		const { cloud, deps, trashed } = setup();
		const table = await sentOnce(deps);
		const old = table[DOC].deviceDocId;
		const { result, table: after } = await sendNote(edited, table, deps);
		if (!result.ok) throw new Error(result.error);
		expect(result.deviceDocId).toBe(old);
		expect(cloud.live()).toEqual([old]);
		expect(trashed).toEqual([]);
		expect(after[DOC].accountedHash).toBe(cloud.hashOf(old));
		expect(after[DOC].ink?.pageIds[0]).toBe(table[DOC].ink?.pageIds[0]);
		expect(after[DOC].ink?.pageIds.length).toBeGreaterThan(table[DOC].ink?.pageIds.length ?? 0);
	});

	it("records an update that landed just before a crash, and does not send it again", async () => {
		const { cloud, disk, deps } = setup();
		const table = await sentOnce(deps);
		const old = table[DOC].deviceDocId;
		const crashing = { ...deps, ink: { ...deps.ink, commitSent: () => Promise.reject(new Error("crash")) } };
		await sendNote(edited, table, crashing);

		const { next, settled } = await settleNextRun(disk.fs, cloud);
		expect(settled.committed).toEqual([DOC]);
		expect(settled.table[DOC]).toMatchObject({ deviceDocId: old, accountedHash: cloud.hashOf(old) });
		expect((await next.readSent(DOC))?.body).toContain("Typed in Obsidian.");

		const writes = cloud.rootWrites();
		const again = await sendNote(edited, settled.table, { ...deps, skipUnchanged: true });
		expect(again.result).toMatchObject({ ok: true, skipped: true });
		expect(cloud.rootWrites()).toBe(writes);
		expect(cloud.live()).toEqual([old]);
	});

	it("keeps the merge base when the update never landed, though its notebook is listed", async () => {
		const { cloud, disk, state, deps } = setup();
		const table = await sentOnce(deps);
		const base = await state.readSent(DOC);
		cloud.onRootWrite(() => new Error("connection lost"));
		const { result } = await sendNote(edited, table, deps);
		expect(result).toMatchObject({ ok: false, error: "connection lost" });
		cloud.onRootWrite(null);

		const { next, settled } = await settleNextRun(disk.fs, cloud);
		expect(settled.dropped).toEqual([DOC]);
		expect(settled.table[DOC]).toEqual(table[DOC]);
		expect(await next.readSent(DOC)).toEqual(base);
	});

	it("drops the pending record of an update that lost its root write to the tablet, before reading the notebook again", async () => {
		const { cloud, disk, state, deps } = setup();
		const table = await sentOnce(deps);
		const old = table[DOC].deviceDocId;
		const base = await state.readSent(DOC);
		deps.ink = { ...deps.ink, dropPending: (docId, hash) => state.dropPending(docId, hash) };
		// The tablet syncs a page in just as the update's root write goes out: refused, and the retry finds it changed.
		cloud.onRootWrite(() => {
			cloud.onRootWrite(null);
			cloud.writeOnTablet(old);
			return new Error("precondition failed");
		});
		// What the re-read's settle would find: with the notebook's files to tell, a pending record is decided.
		let pendingAtReread: boolean | undefined;
		deps.reread = async () => {
			const next = new SyncState(disk.fs, ROOT, "this-copy");
			const entriesAt = async (id: string, hash: string) =>
				new Set((await cloud.api.getEntries(`${id}.docSchema`, hash)).entries.map((entry) => entry.hash));
			const settled = await next.settlePending(await next.loadMappings(), listed(cloud), entriesAt);
			pendingAtReread = settled.committed.length > 0 || settled.dropped.length > 0;
			return null;
		};
		const { result } = await sendNote(edited, table, deps);
		expect(result.ok).toBe(false);
		// Nothing of the refused update was left to settle as if it had landed.
		expect(pendingAtReread).toBe(false);
		expect(await state.readSent(DOC)).toEqual(base);
	});

	it("makes a new notebook when the old one is gone from the account", async () => {
		const { cloud, deps, trashed } = setup();
		const table = await sentOnce(deps);
		const old = table[DOC].deviceDocId;
		await removeFromAccount(cloud, old);
		const { result, table: after } = await sendNote(edited, table, deps);
		if (!result.ok) throw new Error(result.error);
		expect(result.deviceDocId).not.toBe(old);
		expect(cloud.live()).toEqual([result.deviceDocId]);
		expect(after[DOC].accountedHash).toBe(cloud.hashOf(result.deviceDocId));
		expect(trashed).toEqual([]);
	});

	it("does not send over text typed on the tablet, and says why", async () => {
		const { cloud, deps } = setup();
		const table = await sentOnce(deps);
		const old = table[DOC].deviceDocId;
		const [first] = table[DOC].ink?.pageIds ?? [];
		const typedOn = new Uint8Array(readFileSync(new URL("./fixtures/text-crdt-ordering.rm", import.meta.url)));
		const typed = await onTablet(cloud, old, (files) => files.set(`${old}/${first}.rm`, typedOn));
		// The pull read the notebook (it cannot import typed text yet) and accounted for it.
		const read = { ...table, [DOC]: { ...table[DOC], accountedHash: typed } };
		const writes = cloud.rootWrites();
		const changed = { ...edited, content: `---\ntitle: X\n---\nAnders begonnen.\n\nTyped in Obsidian.` };
		const { result, table: after } = await sendNote(changed, read, deps);
		expect(result.ok).toBe(false);
		expect(messageOf(result)).toContain("text typed on the reMarkable");
		expect(cloud.rootWrites()).toBe(writes);
		expect(after[DOC].accountedHash).toBe(typed);
	});

	it("updates a notebook started on the tablet in place, keeping the pages not in the note", async () => {
		const { cloud, deps } = setup();
		const inNote = buildInkPageRm([line(5, 700), line(6, 760)], PAPER);
		const notInNote = buildInkPageRm([line(5, 900), line(6, 990), line(7, 1100)], PAPER);
		const tablet = await sendNotebook(cloud.api, "Ideas", [inNote, notInNote], { retry: NO_WAIT });
		const [taken, left] = tablet.pageIds;
		const imported: MappingEntry = {
			docId: DOC,
			notePath: note.path,
			deviceDocId: tablet.docId,
			uploadedAt: "2026-10-27T00:00:00Z",
			contentHash: "",
			format: "device",
			accountedHash: tablet.hash,
		};
		const id = remarkId(parseRmScene(inNote).lines.map((l) => l.stroke));
		const fromTablet: NoteInput = { ...note, content: `Idee.\n\n> [!note] Page 1\n> ![[p1.png]]\n> ^ink-${id}\n` };
		const { result, table } = await sendNote(fromTablet, { [DOC]: imported }, deps);
		if (!result.ok) throw new Error(result.error);
		expect(result.deviceDocId).toBe(tablet.docId);
		expect(cloud.live()).toEqual([tablet.docId]);
		const files = await filesOf(cloud, tablet.docId);
		// Gone from the notebook as the tablet deletes a page: no longer shown, files kept.
		expect(parsePageOrder(new TextDecoder().decode(files.get(`${tablet.docId}.content`)))).not.toContain(taken);
		expect(files.get(`${tablet.docId}/${left}.rm`)).toEqual(notInNote);
		expect(table[DOC]).toMatchObject({ format: "ink", accountedHash: cloud.hashOf(tablet.docId) });
		expect(table[DOC].ink?.pageIds).not.toContain(left);
	});
});
