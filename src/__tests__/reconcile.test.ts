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
			{ d: record({ deviceName: undefined, deviceParent: undefined }) },
			[{ path: "Notes/Plan.md", docId: "d" }],
			[...TREE, notebook({ visibleName: "Plan on tablet", parent: "other" })],
			POLICY,
		);
		expect(actions).toEqual([{ kind: "record", docId: "d", patch: { deviceName: "Plan on tablet", deviceParent: "other" } }]);
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
});
