import { describe, expect, it } from "vitest";
import {
	DeviceItem,
	findNewNotebooks,
	importedNote,
	importNotebooks,
	noteFileName,
	writtenByPlugin,
	reimportNotebook,
	type NewNotebook,
} from "../sync/deviceimport";
import { buildInkPageRm } from "../ink/rmwrite";
import { parseRmScene } from "../incoming/rmscene";
import { remarkText } from "../ocr/samples";
import { parseFrontmatter } from "../preprocess/preprocess";
import { notesNeedingUpload, sendNote, type SendDeps } from "../sync/send";
import type { MappingTable } from "../id/mapping";
import { DEVICE_PROFILES } from "../ink/inkrender";
import { sendNotebook, uploadNotebook } from "../transport/notebook";
import { fakeCloud } from "./helpers/fakecloud";

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

describe("recognising the plugin's own notebooks", () => {
	it("by the plugin's author on the page, whichever vault instance sent it", () => {
		const page = buildInkPageRm(
			[{ counter: 100, tool: 17, color: 0, thicknessScale: 2, points: [{ x: 0, y: 0, width: 16, pressure: 200, speed: 5, direction: 0 }] }],
			{ paperSize: { width: 1404, height: 1872 } },
		);
		expect(writtenByPlugin(parseRmScene(page).authors)).toBe(true);
		expect(writtenByPlugin(new Map([[1, "4ba8e2f1c0d94b7e9c1f2a3b4c5d6e7f"]]))).toBe(false);
	});

	it("never brings such a notebook in", () => {
		const items = [folder("p", "Projects"), { ...doc("n", "Weekly", "p"), ours: true }];
		expect(findNewNotebooks(items, { baseFolder: "", vaultFolders: ["Projects"], known: new Set(), now: NOW, quietMs: 0 })).toEqual([]);
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
	const render = () => ({
		pages: [new Uint8Array([1])],
		snapshot: { font: "readability", fallbackFont: "readability", pen: "medium" as const, color: 0, jitter: 0, profile: DEVICE_PROFILES.rm2, shape: 1 },
	});
	const content = importedNote(ID, [{ text: "Buy seeds" }]);
	const note = { path: "Projects/Ideas.md", basename: "Ideas", content, existingDocId: ID };
	const adopted = (deviceDocId: string, accountedHash: string): MappingTable => ({
		[ID]: {
			docId: ID,
			notePath: "Projects/Ideas.md",
			deviceDocId,
			uploadedAt: "2026-10-19T00:00:00Z",
			contentHash: "",
			format: "device",
			accountedHash,
		},
	});

	it("is sent as handwriting in place of the tablet's notebook, as it was read", async () => {
		const table = adopted("new-1", "h-at-import");
		expect(notesNeedingUpload([note], table, () => ({ kind: "missing" }))).toHaveLength(1);
		const replaced: (string | undefined)[][] = [];
		const deps: SendDeps = {
			client: {
				uploadInk: (_name, _pages, options) => {
					replaced.push([options.replaces, options.expectedHash]);
					return Promise.resolve({ deviceDocId: "ink-1", pageIds: ["p"], replaced: true });
				},
			},
			ink: { render },
			resolveEmbed: () => ({ kind: "missing" }),
			persistDocId: () => Promise.resolve(),
			replacePrevious: () => Promise.resolve("trashed"),
		};
		const { table: after } = await sendNote(note, table, deps);
		expect(replaced).toEqual([["new-1", "h-at-import"]]);
		expect(after[ID]).toMatchObject({ format: "ink", deviceDocId: "ink-1" });
	});

	it("leaves the tablet's notebook alone when it was written in after the import", async () => {
		const cloud = fakeCloud();
		const original = await uploadNotebook(cloud.api, "Ideas", [new Uint8Array([5])]);
		const table = adopted(original.docId, original.hash);
		cloud.writeOnTablet(original.docId);
		const deps: SendDeps = {
			client: {
				uploadInk: (name, pages, options) =>
					sendNotebook(cloud.api, name, pages, { ...options, docId: options.deviceDocId }).then((r) => ({
						deviceDocId: r.docId,
						pageIds: r.pageIds,
						hash: r.hash,
						replaced: r.replaced,
					})),
			},
			ink: { render },
			resolveEmbed: () => ({ kind: "missing" }),
			persistDocId: () => Promise.resolve(),
			replacePrevious: () => Promise.resolve("not-found"),
		};
		const { result } = await sendNote(note, table, deps);
		expect(result.ok).toBe(false);
		expect(result.ok ? "" : result.error).toContain("changed on the reMarkable");
		expect(cloud.live()).toEqual([original.docId]);
	});
});

describe("bringing a notebook in again after it was written in", () => {
	const io = (initial: string) => {
		let text = initial;
		return {
			read: () => Promise.resolve(text),
			process: (change: (current: string) => string) => {
				text = change(text);
				return Promise.resolve(text);
			},
			text: () => text,
		};
	};
	const body = (pages: { text?: string }[]) => importedNote(ID, pages).replace(/^---\n[\s\S]*?\n---\n/, "");

	it("adds the new page and keeps what the owner changed in the note", async () => {
		const base = body([{ text: "Buy seeds" }]);
		const note = io(importedNote(ID, [{ text: "Buy seeds" }]).replace("Buy seeds", "Buy seeds and soil"));
		const theirs = body([{ text: "Buy seeds" }, { text: "Call Ann" }]);
		const backups: string[] = [];
		const { written, conflicts } = await reimportNotebook(note, async (pre) => void backups.push(pre), base, theirs);
		expect(written).toBe(true);
		expect(conflicts).toBe(0);
		expect(note.text()).toContain("Buy seeds and soil");
		expect(note.text()).toContain("Call Ann");
		expect(parseFrontmatter(note.text()).fields["remarkable-id"]).toBe(ID);
		expect(backups).toHaveLength(1);
	});

	it("drops nothing when the note as first brought in was not kept", async () => {
		const note = io(importedNote(ID, [{ text: "Mine now" }]));
		await reimportNotebook(note, async () => undefined, null, body([{ text: "Tablet's" }]));
		expect(note.text()).toContain("Mine now");
		expect(note.text()).toContain("Tablet's");
	});

	it("writes nothing when the pages read as the note already is", async () => {
		const text = importedNote(ID, [{ text: "Same" }]);
		const note = io(text);
		const { written } = await reimportNotebook(note, async () => undefined, body([{ text: "Same" }]), body([{ text: "Same" }]));
		expect(written).toBe(false);
		expect(note.text()).toBe(text);
	});
});

describe("bringing several in", () => {
	const notebook = (id: string): NewNotebook => ({ id, hash: `h-${id}`, name: id, folder: "" });

	it("reports a notebook that cannot be read and brings in the rest, saving after each", async () => {
		const saved: number[] = [];
		let done = 0;
		const { created, failed } = await importNotebooks(
			[notebook("a"), notebook("corrupt"), notebook("pdf"), notebook("c")],
			async (item) => {
				if (item.id === "corrupt") throw new Error("unreadable page");
				done++;
				return item.id === "pdf" ? null : `${item.id}.md`;
			},
			async () => {
				saved.push(done);
			},
		);
		expect(created).toEqual(["a.md", "c.md"]);
		expect(failed).toEqual([{ notebook: notebook("corrupt"), error: "unreadable page" }]);
		expect(saved).toEqual([1, 1, 2, 3]);
	});
});
