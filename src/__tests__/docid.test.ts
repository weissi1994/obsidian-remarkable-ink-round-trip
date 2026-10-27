import { describe, expect, it } from "vitest";
import { duplicateIdLosers, ensureDocId, generateDocId, isValidDocId } from "../id/docid";
import { contentHash, lookupByDeviceDocId, recordUpload } from "../id/mapping";

describe("docid", () => {
	it("generates valid v4-style UUIDs", () => {
		const id = generateDocId();
		expect(isValidDocId(id)).toBe(true);
	});

	it("keeps an existing valid id (idempotent)", () => {
		const id = generateDocId();
		expect(ensureDocId(id)).toEqual({ docId: id, isNew: false });
	});

	it("replaces missing or malformed ids", () => {
		expect(ensureDocId(undefined).isNew).toBe(true);
		expect(ensureDocId("niet-een-uuid").isNew).toBe(true);
	});
});

describe("notes sharing one id (Obsidian's “Make a copy”)", () => {
	const id = "0f8fad5b-d9cb-469f-a165-70867728950e";
	const other = "0f8fad5b-d9cb-469f-a165-70867728950f";

	it("lets the note the mapping points at keep the id, even when the copy is older", () => {
		const notes = [
			{ path: "copy.md", docId: id, ctime: 1 },
			{ path: "Plan.md", docId: id, ctime: 5 },
			{ path: "unrelated.md", docId: other, ctime: 0 },
		];
		expect(duplicateIdLosers(notes, (docId) => (docId === id ? "Plan.md" : undefined))).toEqual(["copy.md"]);
	});

	it("lets the oldest keep it when the mapping's note is not among them", () => {
		const notes = [
			{ path: "Plan 1.md", docId: id, ctime: 9 },
			{ path: "Plan.md", docId: id, ctime: 3 },
			{ path: "Plan 2.md", docId: id, ctime: 7 },
		];
		expect(duplicateIdLosers(notes, () => "moved-away.md").sort()).toEqual(["Plan 1.md", "Plan 2.md"]);
	});

	it("leaves notes without a valid id alone", () => {
		const notes = [
			{ path: "a.md", docId: undefined, ctime: 1 },
			{ path: "b.md", docId: undefined, ctime: 2 },
			{ path: "c.md", docId: "not-an-id", ctime: 3 },
			{ path: "d.md", docId: "not-an-id", ctime: 4 },
		];
		expect(duplicateIdLosers(notes, () => undefined)).toEqual([]);
	});
});

describe("mapping", () => {
	it("records uploads and finds them by device doc id", () => {
		const table = recordUpload(
			{},
			{
				docId: "a",
				notePath: "map/nota.md",
				deviceDocId: "device-1",
				contentHash: contentHash("inhoud"),
			},
		);
		expect(lookupByDeviceDocId(table, "device-1")?.notePath).toBe("map/nota.md");
		expect(table["a"].uploadedAt).toBeTruthy();
	});

	it("hashes content stably and detects changes", () => {
		expect(contentHash("x")).toBe(contentHash("x"));
		expect(contentHash("x")).not.toBe(contentHash("y"));
	});
});
