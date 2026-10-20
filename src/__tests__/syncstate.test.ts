import { describe, expect, it } from "vitest";
import type { MappingEntry } from "../id/mapping";
import { emptyStore, mergeStores, type RemarkRecord } from "../ocr/samples";
import { SyncState, type StateFs } from "../sync/syncstate";

function memoryFs() {
	const files = new Map<string, string>();
	let writes = 0;
	const fs: StateFs = {
		exists: async (path) => files.has(path) || [...files.keys()].some((f) => f.startsWith(`${path}/`)),
		read: async (path) => {
			const text = files.get(path);
			if (text === undefined) throw new Error(`no ${path}`);
			return text;
		},
		write: async (path, data) => {
			writes++;
			files.set(path, data);
		},
		mkdir: async () => undefined,
		list: async (dir) => [...files.keys()].filter((f) => f.startsWith(`${dir}/`) && !f.slice(dir.length + 1).includes("/")),
		remove: async (path) => {
			files.delete(path);
		},
	};
	return { fs, files, writes: () => writes };
}

const entry = (docId: string, deviceDocId: string): MappingEntry => ({
	docId,
	notePath: `${docId}.md`,
	deviceDocId,
	uploadedAt: "2026-10-19T00:00:00Z",
	contentHash: "x",
	format: "ink",
});
const ROOT = "reMarkable/.sync";

describe("shared sync state", () => {
	it("keeps one file per note and writes only what changed", async () => {
		const { fs, files, writes } = memoryFs();
		const state = new SyncState(fs, ROOT);
		await state.saveMappings({ a: entry("a", "d1"), b: entry("b", "d2") });
		expect([...files.keys()].sort()).toEqual([`${ROOT}/notes/a.json`, `${ROOT}/notes/b.json`]);
		const before = writes();
		await state.saveMappings({ a: entry("a", "d1"), b: entry("b", "d3") });
		expect(writes() - before).toBe(1);
		await state.saveMappings({ a: entry("a", "d1") });
		expect(files.has(`${ROOT}/notes/b.json`)).toBe(false);
		expect(await new SyncState(fs, ROOT).loadMappings()).toEqual({ a: entry("a", "d1") });
	});

	it("takes in what another device synced, keeping what changed here", async () => {
		const { fs } = memoryFs();
		const here = new SyncState(fs, ROOT);
		const there = new SyncState(fs, ROOT);
		await here.saveMappings({ a: entry("a", "d1"), b: entry("b", "d2"), c: entry("c", "d3") });
		await there.loadMappings();
		// The other device re-sent a, sent a new note d and dropped c…
		await there.saveMappings({ a: entry("a", "d9"), b: entry("b", "d2"), d: entry("d", "d4") });
		// …while this one re-sent b without having saved yet.
		const merged = await here.refresh({ a: entry("a", "d1"), b: entry("b", "d7"), c: entry("c", "d3") });
		expect(merged.a.deviceDocId).toBe("d9");
		expect(merged.b.deviceDocId).toBe("d7");
		expect(merged.c).toBeUndefined();
		expect(merged.d.deviceDocId).toBe("d4");
	});

	it("stores pictures once by content and gives them back with the send", async () => {
		const { fs, files } = memoryFs();
		const state = new SyncState(fs, ROOT);
		const image = { width: 1, height: 1, sourceWidth: 1, sourceHeight: 1, cells: "AA==" };
		await state.writeSent("a", { title: "A", markdown: "x", images: { pic: image } });
		await state.writeSent("b", { title: "B", markdown: "y", images: { same: image } });
		expect([...files.keys()].filter((f) => f.includes("/pictures/"))).toHaveLength(1);
		expect(await state.readSent("b")).toEqual({ title: "B", markdown: "y", images: { same: image }, drawings: undefined });
		// The mapping and the send share the note's file without overwriting each other.
		await state.saveMappings({ a: entry("a", "d1") });
		expect((await state.readSent("a"))?.title).toBe("A");
		expect((await new SyncState(fs, ROOT).loadMappings()).a.deviceDocId).toBe("d1");
	});

	it("skips a file a merge left conflict markers in, without forgetting its note", async () => {
		const { fs, files } = memoryFs();
		const state = new SyncState(fs, ROOT);
		await state.saveMappings({ a: entry("a", "d1"), b: entry("b", "d2") });
		files.set(`${ROOT}/notes/b.json`, "<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> other\n");
		const merged = await state.refresh({ a: entry("a", "d1"), b: entry("b", "d2") });
		expect(merged.b.deviceDocId).toBe("d2");
		expect(state.unreadable).toEqual([`${ROOT}/notes/b.json`]);
	});
});

describe("learned handwriting shared between copies", () => {
	const hand = { handVersion: "hand-1", pendingSheet: null, pendingWordSheet: null };

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
