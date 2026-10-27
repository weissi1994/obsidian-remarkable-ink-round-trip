import { describe, expect, it } from "vitest";
import type { MappingEntry } from "../id/mapping";
import { emptyStore, mergeStores, type RemarkRecord } from "../ocr/samples";
import { StateFileError, SyncState } from "../sync/syncstate";
import { memoryFs } from "./helpers/memoryfs";

const A = "0f8fad5b-d9cb-469f-a165-70867728950a";
const B = "0f8fad5b-d9cb-469f-a165-70867728950b";
const C = "0f8fad5b-d9cb-469f-a165-70867728950c";
const D = "0f8fad5b-d9cb-469f-a165-70867728950d";

const entry = (docId: string, deviceDocId: string): MappingEntry => ({
	docId,
	notePath: `${docId}.md`,
	deviceDocId,
	uploadedAt: "2026-10-19T00:00:00Z",
	contentHash: "x",
	format: "ink",
});
const ROOT = "reMarkable/.sync";
const CONFLICTED = "<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> other\n";

describe("shared sync state", () => {
	it("keeps one file per note and writes only what changed", async () => {
		const { fs, files, writes } = memoryFs();
		const state = new SyncState(fs, ROOT);
		await state.saveMappings({ [A]: entry(A, "d1"), [B]: entry(B, "d2") });
		expect([...files.keys()].sort()).toEqual([`${ROOT}/notes/${A}.json`, `${ROOT}/notes/${B}.json`]);
		const before = writes();
		await state.saveMappings({ [A]: entry(A, "d1"), [B]: entry(B, "d3") });
		expect(writes() - before).toBe(1);
		await state.saveMappings({ [A]: entry(A, "d1") });
		expect(files.has(`${ROOT}/notes/${B}.json`)).toBe(false);
		expect(await new SyncState(fs, ROOT).loadMappings()).toEqual({ [A]: entry(A, "d1") });
	});

	it("takes in what another device synced, keeping what changed here", async () => {
		const { fs } = memoryFs();
		const here = new SyncState(fs, ROOT);
		const there = new SyncState(fs, ROOT);
		await here.saveMappings({ [A]: entry(A, "d1"), [B]: entry(B, "d2"), [C]: entry(C, "d3") });
		await there.loadMappings();
		// The other device re-sent a, sent a new note d and dropped c…
		await there.saveMappings({ [A]: entry(A, "d9"), [B]: entry(B, "d2"), [D]: entry(D, "d4") });
		// …while this one re-sent b without having saved yet.
		const merged = await here.refresh({ [A]: entry(A, "d1"), [B]: entry(B, "d7"), [C]: entry(C, "d3") });
		expect(merged[A].deviceDocId).toBe("d9");
		expect(merged[B].deviceDocId).toBe("d7");
		expect(merged[C]).toBeUndefined();
		expect(merged[D].deviceDocId).toBe("d4");
	});

	it("stores pictures once by content and gives them back with the send", async () => {
		const { fs, files } = memoryFs();
		const state = new SyncState(fs, ROOT);
		const image = { width: 1, height: 1, sourceWidth: 1, sourceHeight: 1, cells: "AA==" };
		await state.writeSent(A, { title: "A", markdown: "x", images: { pic: image } });
		await state.writeSent(B, { title: "B", markdown: "y", images: { same: image } });
		expect([...files.keys()].filter((f) => f.includes("/pictures/"))).toHaveLength(1);
		expect(await state.readSent(B)).toEqual({ title: "B", markdown: "y", images: { same: image }, drawings: undefined });
		// The mapping and the send share the note's file without overwriting each other.
		await state.saveMappings({ [A]: entry(A, "d1") });
		expect((await state.readSent(A))?.title).toBe("A");
		expect((await new SyncState(fs, ROOT).loadMappings())[A].deviceDocId).toBe("d1");
	});

	it("skips a file a merge left conflict markers in, without forgetting its note", async () => {
		const { fs, files } = memoryFs();
		const state = new SyncState(fs, ROOT);
		await state.saveMappings({ [A]: entry(A, "d1"), [B]: entry(B, "d2") });
		files.set(`${ROOT}/notes/${B}.json`, CONFLICTED);
		const merged = await state.refresh({ [A]: entry(A, "d1"), [B]: entry(B, "d2") });
		expect(merged[B].deviceDocId).toBe("d2");
		expect(state.unreadable).toEqual([`${ROOT}/notes/${B}.json`]);
	});

	it("never writes over a file it cannot read, and names it", async () => {
		const { fs, files } = memoryFs();
		const state = new SyncState(fs, ROOT);
		await state.saveMappings({ [A]: entry(A, "d1"), [B]: entry(B, "d2") });
		const file = `${ROOT}/notes/${B}.json`;
		files.set(file, CONFLICTED);
		// A pull records a new hash for both notes: a is written, b is left alone.
		await state.saveMappings({ [A]: { ...entry(A, "d1"), accountedHash: "h1" }, [B]: { ...entry(B, "d2"), accountedHash: "h2" } });
		expect(files.get(file)).toBe(CONFLICTED);
		expect(state.unwritable).toEqual([file]);
		expect((await new SyncState(fs, ROOT).loadMappings())[A].accountedHash).toBe("h1");
		// Dropping its mapping does not delete it either.
		await state.saveMappings({ [A]: entry(A, "d1") });
		expect(files.get(file)).toBe(CONFLICTED);
		// A send of that note fails before anything is uploaded, naming the file.
		const send = state.writePending(B, { title: "B", markdown: "y" }, entry(B, "d5"));
		await expect(send).rejects.toBeInstanceOf(StateFileError);
		await expect(send).rejects.toThrow(file);
		await expect(state.commitSent(B, { title: "B", markdown: "y" }, entry(B, "d5"))).rejects.toThrow(file);
		expect(files.get(file)).toBe(CONFLICTED);
	});

	it("does not load conflict copies as notes, and lists them", async () => {
		const { fs, files } = memoryFs();
		const state = new SyncState(fs, ROOT);
		await state.saveMappings({ [A]: entry(A, "d-current") });
		const old = JSON.stringify({ mapping: entry(A, "d-old") });
		const copies = [
			`${ROOT}/notes/${A}.sync-conflict-20261027-101112-ABCDEFG.json`,
			`${ROOT}/notes/${A} (conflict 2026-10-27).json`,
			`${ROOT}/notes/${A}.json.orig`,
		];
		for (const copy of copies) files.set(copy, old);
		const fresh = new SyncState(fs, ROOT);
		expect(await fresh.loadMappings()).toEqual({ [A]: entry(A, "d-current") });
		expect(fresh.conflictCopies.sort()).toEqual([...copies].sort());
	});

	it("reads a mapping stored as importedHash by an earlier version", async () => {
		const { fs, files } = memoryFs();
		files.set(`${ROOT}/notes/${A}.json`, JSON.stringify({ mapping: { ...entry(A, "d1"), importedHash: "h-old" } }));
		const loaded = await new SyncState(fs, ROOT).loadMappings();
		expect(loaded[A].accountedHash).toBe("h-old");
		expect(loaded[A]).not.toHaveProperty("importedHash");
	});
});

describe("sends in flight", () => {
	const sent = (body: string) => ({ title: "A", markdown: body, body });

	it("keeps the committed send as the merge base until the upload is committed", async () => {
		const { fs } = memoryFs();
		const state = new SyncState(fs, ROOT);
		await state.commitSent(A, sent("old"), entry(A, "d1"));
		await state.writePending(A, sent("new"), entry(A, "d2"));
		expect((await state.readSent(A))?.body).toBe("old");
		await state.commitSent(A, sent("new"), { ...entry(A, "d2"), accountedHash: "h2" });
		expect((await state.readSent(A))?.body).toBe("new");
		const reloaded = new SyncState(fs, ROOT);
		expect((await reloaded.loadMappings())[A]).toMatchObject({ deviceDocId: "d2", accountedHash: "h2" });
		// Committed: nothing left to settle.
		expect(await reloaded.settlePending({}, new Map([["d2", "h2"]]))).toMatchObject({ committed: [], dropped: [] });
	});

	it("keeps what the note was last merged with until a new send lands", async () => {
		const { fs } = memoryFs();
		const state = new SyncState(fs, ROOT, "this-copy");
		await state.commitSent(A, sent("sent"), { ...entry(A, "d1"), accountedHash: "h1" });
		await state.writeMergedBase(A, "sent, merged with the tablet");
		expect(await new SyncState(fs, ROOT).readSent(A)).toMatchObject({ body: "sent", mergedBase: "sent, merged with the tablet" });
		// A send in flight does not change the base; its landing does.
		await state.writePending(A, sent("next"), { ...entry(A, "d1"), accountedHash: "h2" }, "h1");
		expect((await state.readSent(A))?.mergedBase).toBe("sent, merged with the tablet");
		const next = new SyncState(fs, ROOT, "this-copy");
		await next.settlePending(await next.loadMappings(), new Map([["d1", "h2"]]));
		expect(await next.readSent(A)).not.toHaveProperty("mergedBase");
		await next.writeMergedBase(A, "merged again");
		await next.commitSent(A, { ...sent("third"), mergedBase: "must not be stored" }, entry(A, "d1"));
		expect(await next.readSent(A)).not.toHaveProperty("mergedBase");
	});

	it("settles nothing against an empty account listing", async () => {
		const { fs } = memoryFs();
		const state = new SyncState(fs, ROOT);
		await state.commitSent(A, sent("old"), entry(A, "d1"));
		await state.writePending(A, sent("new"), entry(A, "d2"));
		const fresh = new SyncState(fs, ROOT);
		const table = await fresh.loadMappings();
		expect(await fresh.settlePending(table, new Map())).toMatchObject({ committed: [], dropped: [] });
		// The pending record is still there for a later, real listing.
		expect((await fresh.settlePending(table, new Map([["d2", "h"]]))).committed).toEqual([A]);
	});

	it("keeps a send in flight when its note's mapping is dropped meanwhile", async () => {
		const { fs, files } = memoryFs();
		const state = new SyncState(fs, ROOT);
		await state.saveMappings({ [A]: entry(A, "d1") });
		await state.writePending(A, sent("new"), entry(A, "d2"));
		await state.saveMappings({});
		expect(files.has(`${ROOT}/notes/${A}.json`)).toBe(true);
		const fresh = new SyncState(fs, ROOT);
		const table = await fresh.loadMappings();
		expect(table[A]).toBeUndefined();
		expect((await fresh.settlePending(table, new Map([["d2", "h"]]))).table[A].deviceDocId).toBe("d2");
	});

	describe("an update in place (same notebook, new hash)", () => {
		/** A committed send to d1 at hash h1, then an update to h2 recorded as pending. */
		async function inFlight() {
			const { fs } = memoryFs();
			const state = new SyncState(fs, ROOT, "this-copy");
			await state.commitSent(A, sent("old"), { ...entry(A, "d1"), accountedHash: "h1" });
			await state.writePending(A, sent("new"), { ...entry(A, "d1"), accountedHash: "h2" }, "h1");
			const next = new SyncState(fs, ROOT, "this-copy");
			return { next, table: await next.loadMappings() };
		}

		it("did not land while the notebook still has the hash it replaced, though it is listed", async () => {
			const { next, table } = await inFlight();
			const settled = await next.settlePending(table, new Map([["d1", "h1"]]));
			expect(settled.dropped).toEqual([A]);
			expect(settled.table[A].accountedHash).toBe("h1");
			expect((await next.readSent(A))?.body).toBe("old");
		});

		it("landed when the notebook has the hash it wrote", async () => {
			const { next, table } = await inFlight();
			const settled = await next.settlePending(table, new Map([["d1", "h2"]]));
			expect(settled.committed).toEqual([A]);
			expect(settled.table[A].accountedHash).toBe("h2");
			expect((await next.readSent(A))?.body).toBe("new");
		});

		it("landed and was written on since: committed, the newer ink left for the next read", async () => {
			const { next, table } = await inFlight();
			const settled = await next.settlePending(table, new Map([["d1", "h3"]]));
			expect(settled.committed).toEqual([A]);
			// Still the hash the update wrote, so the pull sees h3 as new.
			expect(settled.table[A].accountedHash).toBe("h2");
		});
	});

	describe("another copy of the vault sending (shared state folder)", () => {
		it("leaves its send in flight alone until it is stale", async () => {
			const { fs } = memoryFs();
			let clock = 1_000_000;
			const there = new SyncState(fs, ROOT, "other-copy", () => clock);
			await there.commitSent(A, sent("old"), entry(A, "d1"));
			await there.writePending(A, sent("new"), entry(A, "d2"));

			const here = new SyncState(fs, ROOT, "this-copy", () => clock + 60_000);
			const listing = new Map([["d1", "h1"]]);
			const early = await here.settlePending(await here.loadMappings(), listing);
			expect(early).toMatchObject({ committed: [], dropped: [] });
			// Its upload lands: the other copy's pending send is still there to commit.
			const reloaded = new SyncState(fs, ROOT, "this-copy", () => clock + 60_000);
			expect((await reloaded.settlePending(await reloaded.loadMappings(), new Map([...listing, ["d2", "h2"]]))).committed).toEqual([A]);

			await there.writePending(A, sent("newer"), entry(A, "d3"));
			clock += 2 * 60 * 60 * 1000;
			const later = new SyncState(fs, ROOT, "this-copy", () => clock);
			expect((await later.settlePending(await later.loadMappings(), listing)).dropped).toEqual([A]);
		});

		it("drops its own send that never landed at once", async () => {
			const { fs } = memoryFs();
			const state = new SyncState(fs, ROOT, "this-copy");
			await state.commitSent(A, sent("old"), entry(A, "d1"));
			await state.writePending(A, sent("new"), entry(A, "d2"));
			const next = new SyncState(fs, ROOT, "this-copy");
			expect((await next.settlePending(await next.loadMappings(), new Map([["d1", "h1"]]))).dropped).toEqual([A]);
			expect((await next.readSent(A))?.body).toBe("old");
		});

		it("does not write a landed send over a later one already committed", async () => {
			const { fs, files } = memoryFs();
			const state = new SyncState(fs, ROOT, "this-copy");
			await state.writePending(A, sent("first"), { ...entry(A, "d2"), uploadedAt: "2026-10-19T00:00:00Z" });
			// Another copy committed a later send of the same note meanwhile, beside our pending record.
			const file = `${ROOT}/notes/${A}.json`;
			const record = JSON.parse(files.get(file)!) as Record<string, unknown>;
			files.set(
				file,
				JSON.stringify({
					...record,
					sent: { title: "A", markdown: "later", body: "later" },
					mapping: { ...entry(A, "d3"), uploadedAt: "2026-10-20T00:00:00Z" },
				}),
			);
			const next = new SyncState(fs, ROOT, "this-copy");
			const settled = await next.settlePending(await next.loadMappings(), new Map([["d2", "h2"], ["d3", "h3"]]));
			expect(settled.committed).toEqual([]);
			expect(settled.table[A].deviceDocId).toBe("d3");
			expect((await next.readSent(A))?.body).toBe("later");
		});
	});
});

describe("learned handwriting shared between copies", () => {
	const hand = { handVersion: "hand-1", pendingSheet: null, pendingWordSheet: null, pendingTestSheet: null };

	it("reads a handwriting.json from before the test sheet as having none waiting", async () => {
		const { fs, writes } = memoryFs();
		const old = { handVersion: "hand-1", pendingSheet: null, pendingWordSheet: null };
		await fs.write(`${ROOT}/handwriting.json`, JSON.stringify(old));
		const state = new SyncState(fs, ROOT);
		expect(await state.readHandwriting()).toEqual(hand);
		const before = writes();
		await state.saveHandwriting(hand);
		expect(writes()).toBe(before);
	});

	it("carries the hand in use to another copy, written only when it changed", async () => {
		const { fs, writes } = memoryFs();
		await new SyncState(fs, ROOT).saveHandwriting(hand);
		const other = new SyncState(fs, ROOT);
		expect(await other.readHandwriting()).toEqual(hand);
		const before = writes();
		await other.saveHandwriting(hand);
		expect(writes()).toBe(before);
	});

	it("does not undo a newer hand from another copy with an unchanged one", async () => {
		const { fs } = memoryFs();
		const a = new SyncState(fs, ROOT);
		const b = new SyncState(fs, ROOT);
		await a.saveHandwriting(hand);
		await b.readHandwriting();
		await a.saveHandwriting({ ...hand, handVersion: "hand-2" });
		await b.saveHandwriting(hand);
		expect((await new SyncState(fs, ROOT).readHandwriting())?.handVersion).toBe("hand-2");
	});

	it("merges word samples and remarks two copies learned", () => {
		const stroke = (x: number) => [[{ x, y: 0 }]];
		const remark = (transcript: string, at: string, corrected = false): RemarkRecord => ({ strokes: stroke(1), transcript, at, corrected });
		const disk = { ...emptyStore(), words: { Montag: [stroke(1)] }, remarks: { r1: remark("Mantag", "2026-10-20", false), r2: remark("fixed", "2026-10-01", true) } };
		const mine = { ...emptyStore(), words: { Montag: [stroke(1), stroke(2)], heute: [stroke(3)] }, remarks: { r1: remark("Montag", "2026-10-01", true), r2: remark("read again", "2026-10-21") } };
		const merged = mergeStores(disk, mine);
		expect(merged.words.Montag).toEqual([stroke(1), stroke(2)]);
		expect(merged.words.heute).toEqual([stroke(3)]);
		expect(merged.remarks.r1.transcript).toBe("Montag");
		expect(merged.remarks.r2.transcript).toBe("fixed");
	});
});
