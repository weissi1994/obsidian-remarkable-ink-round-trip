import { describe, expect, it } from "vitest";
import { DeviceItem, findNewNotebooks, importedNote, noteFileName } from "../sync/deviceimport";
import { remarkText } from "../ocr/samples";
import { parseFrontmatter } from "../preprocess/preprocess";
import { notesNeedingUpload, sendNote, type SendDeps } from "../sync/send";
import type { MappingTable } from "../id/mapping";
import { DEVICE_PROFILES } from "../ink/inkrender";

const NOW = 1_800_000_000_000;
const OLD = String(NOW - 60 * 60_000);
const folder = (id: string, name: string, parent = ""): DeviceItem => ({
	id,
	hash: `h-${id}`,
	type: "CollectionType",
	parent,
	visibleName: name,
	lastModified: OLD,
});
const doc = (id: string, name: string, parent: string, lastModified = OLD): DeviceItem => ({
	id,
	hash: `h-${id}`,
	type: "DocumentType",
	parent,
	visibleName: name,
	lastModified,
});

const ITEMS: DeviceItem[] = [
	folder("base", "Obsidian"),
	folder("proj", "Projects", "base"),
	folder("sub", "Garden", "proj"),
	folder("other", "Archive", "base"),
	doc("new-1", "Ideas", "proj"),
	doc("new-2", "Beds: plan", "sub"),
	doc("ours", "Weekly", "proj"),
	doc("outside", "Old", "other"),
	doc("rootdoc", "Loose", ""),
	doc("trashed", "Gone", "trash"),
	doc("busy", "Writing now", "proj", String(NOW - 60_000)),
	{ ...doc("pdf", "Manual", "proj"), notNotebook: true },
];

describe("finding notebooks started on the tablet", () => {
	const found = findNewNotebooks(ITEMS, {
		baseFolder: "Obsidian",
		vaultFolders: ["Projects", "Tasks"],
		known: new Set(["ours"]),
		now: NOW,
		quietMs: 10 * 60_000,
	});

	it("takes unknown notebooks in a synced folder, sub-folders included, at the matching vault path", () => {
		expect(found.map((n) => [n.id, n.folder])).toEqual([
			["new-1", "Projects"],
			["new-2", "Projects/Garden"],
		]);
	});

	it("leaves the plugin's own, other folders, the trash, PDFs and notebooks still being written alone", () => {
		const ids = found.map((n) => n.id);
		for (const id of ["ours", "outside", "rootdoc", "trashed", "pdf", "busy"]) expect(ids).not.toContain(id);
	});

	it("works with no base folder", () => {
		const items = [folder("p", "Projects"), doc("n", "Ideas", "p")];
		expect(
			findNewNotebooks(items, { baseFolder: "", vaultFolders: ["Projects"], known: new Set(), now: NOW, quietMs: 0 }),
		).toEqual([{ id: "n", hash: "h-n", name: "Ideas", folder: "Projects" }]);
	});
});

describe("the imported note", () => {
	const note = importedNote("doc-1", [
		{ image: "ink/p1.png", text: "Buy seeds\nPlan beds" },
		{ image: "ink/p2.png" },
	]);

	it("carries its id and a callout per page with the text and the ink", () => {
		expect(parseFrontmatter(note).fields["remarkable-id"]).toBe("doc-1");
		expect(note).toContain("> [!note] Page 1\n> Buy seeds\n> Plan beds\n> ![[ink/p1.png]]");
		expect(note).toContain("> [!note] Page 2\n> ![[ink/p2.png]]");
	});

	it("is laid out so a corrected text teaches the reader", () => {
		expect(remarkText(note, "ink/p1.png")).toBe("Buy seeds\nPlan beds");
		expect(remarkText(note, "ink/p2.png")).toBe("");
	});

	it("gets a file name the vault accepts", () => {
		expect(noteFileName("Beds: plan / 2026?")).toBe("Beds plan 2026");
		expect(noteFileName("  ")).toBe("reMarkable notebook");
	});
});

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("adopting it", () => {
	it("is sent as handwriting in place of the tablet's notebook", async () => {
		const content = importedNote(ID, [{ text: "Buy seeds" }]);
		const table: MappingTable = {
			[ID]: {
				docId: ID,
				notePath: "Projects/Ideas.md",
				deviceDocId: "new-1",
				uploadedAt: "2026-10-19T00:00:00Z",
				contentHash: "",
				format: "device",
			},
		};
		const note = { path: "Projects/Ideas.md", basename: "Ideas", content, existingDocId: ID };
		expect(notesNeedingUpload([note], table, () => ({ kind: "missing" }))).toHaveLength(1);
		const replaced: (string | undefined)[] = [];
		const deps: SendDeps = {
			client: {
				uploadInk: (_name, _pages, options) => {
					replaced.push(options.replaces);
					return Promise.resolve({ deviceDocId: "ink-1", pageIds: ["p"], replaced: true });
				},
			},
			ink: {
				render: () => ({
					pages: [new Uint8Array([1])],
					snapshot: { font: "readability", fallbackFont: "readability", pen: "medium", color: 0, jitter: 0, profile: DEVICE_PROFILES.rm2, shape: 1 },
				}),
			},
			resolveEmbed: () => ({ kind: "missing" }),
			persistDocId: () => Promise.resolve(),
			replacePrevious: () => Promise.resolve(),
		};
		const { table: after } = await sendNote(note, table, deps);
		expect(replaced).toEqual(["new-1"]);
		expect(after[ID]).toMatchObject({ format: "ink", deviceDocId: "ink-1" });
	});
});
