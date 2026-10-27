import { describe, expect, it } from "vitest";
import type { MappingEntry } from "../id/mapping";
import type { DeviceItem } from "../sync/deviceimport";
import { plan, type ReconcilePolicy } from "../sync/reconcile";

const POLICY: ReconcilePolicy = { baseFolder: "Obsidian", archiveFolder: "Archive" };
const folder = (id: string, name: string, parent = ""): DeviceItem => ({ id, hash: `h-${id}`, type: "CollectionType", parent, visibleName: name, lastModified: "0" });
const TREE = [folder("base", "Obsidian"), folder("notes", "Notes", "base"), folder("other", "Other", "base")];
const notebook = (patch: Partial<DeviceItem> = {}): DeviceItem => ({
	id: "nb",
	hash: "h1",
	type: "DocumentType",
	parent: "notes",
	visibleName: "Plan",
	lastModified: "0",
	...patch,
});
const record = (patch: Partial<MappingEntry> = {}): MappingEntry => ({
	docId: "d",
	notePath: "Notes/Plan.md",
	deviceDocId: "nb",
	uploadedAt: "",
	contentHash: "c",
	format: "ink",
	accountedHash: "h1",
	deviceName: "Plan",
	deviceParent: "notes",
	devicePath: "Obsidian/Notes",
	...patch,
});

describe("planning", () => {
	it("does nothing while both sides are as last synced", () => {
		expect(plan({ d: record() }, [{ path: "Notes/Plan.md", docId: "d" }], [...TREE, notebook()], POLICY)).toEqual([]);
	});

	it("judges nothing on the tablet side when the account could not be listed", () => {
		expect(plan({ d: record() }, [{ path: "Readme.md" }], null, POLICY)).toEqual([]);
	});

	it("leaves a notebook alone whose metadata could not be read", () => {
		const actions = plan({ d: record() }, [{ path: "Notes/Renamed.md", docId: "d" }], [...TREE, notebook({ unreadable: true })], POLICY);
		expect(actions).toEqual([]);
	});

	it("only follows the path of a note sent as PDF by an earlier version", () => {
		const actions = plan(
			{ d: record({ format: "pdf" }) },
			[{ path: "Elsewhere/Plan.md", docId: "d" }],
			[...TREE, notebook({ parent: "trash" })],
			POLICY,
		);
		expect(actions).toEqual([{ kind: "record", docId: "d", patch: { notePath: "Elsewhere/Plan.md" } }]);
	});

	it("waits while two notes carry the id and neither is at the recorded path", () => {
		const notes = [
			{ path: "A/Plan.md", docId: "d" },
			{ path: "B/Plan.md", docId: "d" },
		];
		expect(plan({ d: record() }, notes, [...TREE, notebook({ parent: "trash" })], POLICY)).toEqual([]);
	});

	it("takes the tablet as it is for a record from before names and folders were kept", () => {
		const actions = plan(
			{ d: record({ deviceName: undefined, deviceParent: undefined, devicePath: undefined }) },
			[{ path: "Notes/Plan.md", docId: "d" }],
			[...TREE, notebook({ visibleName: "Plan on tablet", parent: "other" })],
			POLICY,
		);
		expect(actions).toEqual([
			{ kind: "record", docId: "d", patch: { deviceName: "Plan on tablet", deviceParent: "other", devicePath: "Obsidian/Other" } },
		]);
	});

	it("does not follow folder moves when folders are not mirrored", () => {
		const actions = plan(
			{ d: record() },
			[{ path: "Elsewhere/Plan.md", docId: "d" }],
			[...TREE, notebook()],
			{ ...POLICY, baseFolder: null },
		);
		expect(actions).toEqual([{ kind: "record", docId: "d", patch: { notePath: "Elsewhere/Plan.md" } }]);
	});

	it("treats a notebook in a trashed folder as trashed", () => {
		const actions = plan(
			{ d: record() },
			[{ path: "Notes/Plan.md", docId: "d" }],
			[...TREE.map((item) => (item.id === "notes" ? { ...item, parent: "trash" } : item)), notebook()],
			POLICY,
		);
		expect(actions).toMatchObject([{ kind: "archive-note", from: "Notes/Plan.md", to: "Archive/Notes/Plan.md", readFirst: false }]);
	});

	it("reads a trashed notebook's new ink before archiving its note", () => {
		const actions = plan({ d: record() }, [{ path: "Notes/Plan.md", docId: "d" }], [...TREE, notebook({ parent: "trash", hash: "h2" })], POLICY);
		expect(actions).toMatchObject([{ kind: "archive-note", readFirst: true }]);
	});

	it("waits on a notebook trashed in the write that made a notebook no record knows: replaced by another copy's send", () => {
		const replaced = notebook({ parent: "trash", hash: "h2", lastModified: "1700" });
		const replacement = notebook({ id: "nb2", hash: "n1", lastModified: "1700", createdTime: "1700" });
		const vault = [{ path: "Notes/Plan.md", docId: "d" }];
		expect(plan({ d: record() }, vault, [...TREE, replaced, replacement], POLICY)).toEqual([]);
		// Deleted in the vault meanwhile: not archived either.
		expect(plan({ d: record() }, [{ path: "Readme.md" }], [...TREE, replaced, replacement], POLICY, () => true)).toEqual([]);
		// Replaced again since: still another copy's.
		const again = notebook({ id: "nb3", hash: "n3", lastModified: "1800", createdTime: "1800" });
		expect(plan({ d: record() }, vault, [...TREE, replaced, { ...replacement, parent: "trash", lastModified: "1800" }, again], POLICY)).toEqual([]);
		// Made at another time, or known to a record: trashed on the tablet after all.
		const later = { ...replacement, createdTime: "1701" };
		expect(plan({ d: record() }, vault, [...TREE, replaced, later], POLICY)).toMatchObject([{ kind: "archive-note" }]);
		const other = record({ docId: "e", notePath: "Notes/Other.md", deviceDocId: "nb2", accountedHash: "n1", deviceName: "Other" });
		const device = [...TREE, replaced, { ...replacement, visibleName: "Other" }];
		expect(plan({ d: record(), e: other }, [...vault, { path: "Notes/Other.md", docId: "e" }], device, POLICY)).toMatchObject([
			{ kind: "archive-note", docId: "d" },
		]);
	});

	it("restores a trashed notebook into the folder mirroring its note's when the folder it was in was renamed on the tablet meanwhile", () => {
		const archived = record({ state: "archived", deviceParent: "notes", devicePath: "Obsidian/Notes" });
		const renamed = [folder("base", "Obsidian"), folder("notes", "Projects", "base"), notebook({ parent: "trash" })];
		const vault = [{ path: "Notes/Plan.md", docId: "d" }];
		expect(plan({ d: archived }, vault, renamed, POLICY)).toMatchObject([{ kind: "edit-notebook", folder: "Notes" }]);
		// Still mirroring the note's folder, or outside the mirrored tree: back where it was.
		expect(plan({ d: archived }, vault, [...TREE, notebook({ parent: "trash" })], POLICY)).toMatchObject([{ kind: "edit-notebook", parent: "notes" }]);
		const outside = [folder("base", "Obsidian"), folder("notes", "Mine"), notebook({ parent: "trash" })];
		expect(plan({ d: archived }, vault, outside, POLICY)).toMatchObject([{ kind: "edit-notebook", parent: "notes" }]);
	});

	it("moves a note found in the archive folder back out while its notebook is live, never the notebook into the archive", () => {
		const actions = plan({ d: record() }, [{ path: "Archive/Notes/Plan.md", docId: "d" }], [...TREE, notebook()], POLICY);
		expect(actions).toEqual([expect.objectContaining({ kind: "move-note", from: "Archive/Notes/Plan.md", to: "Notes/Plan.md" })]);
	});

	it("remembers where a note already in the archive folder was synced when its notebook goes", () => {
		const actions = plan({ d: record() }, [{ path: "Archive/Notes/Plan.md", docId: "d" }], [...TREE, notebook({ parent: "trash" })], POLICY);
		expect(actions).toMatchObject([{ kind: "archive-note", from: "Archive/Notes/Plan.md", to: "Archive/Notes/Plan.md", archivedFrom: "Notes/Plan.md" }]);
	});

	it("blames a delete seen on the deleted note's id, not on another note whose record names its path", () => {
		// "b" was renamed to the path "a" had before, then "a" deleted there; "b" has not arrived on this device yet.
		const records = { a: record({ docId: "a", deviceDocId: "nb-a" }), b: record({ docId: "b", deviceDocId: "nb-b", notePath: "Notes/Plan.md" }) };
		const vault = [{ path: "Readme.md" }, { path: "Notes/Other.md", docId: "c" }];
		const device = [...TREE, notebook({ id: "nb-a" }), notebook({ id: "nb-b" })];
		expect(plan(records, vault, device, POLICY, (docId) => docId === "a")).toEqual([
			expect.objectContaining({ kind: "trash-notebook", docId: "a", deviceDocId: "nb-a" }),
			{ kind: "record", docId: "b", patch: { noteMissing: true } },
		]);
	});
});
