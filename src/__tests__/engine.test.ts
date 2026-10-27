import { describe, expect, it } from "vitest";
import { syncRig, type RigOptions, type SyncRig } from "./helpers/syncrig";
import { withDocId } from "./helpers/memoryvault";
import { sendNotebook } from "../transport/notebook";

const note = (title: string) => `# ${title}\n\nSome text.\n`;

/**
 * A rig with one synced note at Notes/<name>.md (and an unsynced one, so the
 * vault never looks unloaded); resolves to it and its notebook id.
 */
async function synced(name = "Plan", options: RigOptions = {}) {
	const rig = syncRig(options);
	rig.vault.create("Readme.md", "Not synced.\n");
	rig.vault.create(`Notes/${name}.md`, note(name));
	if (options.syncFolders?.length === 0) await rig.engine.send([`Notes/${name}.md`]);
	else await rig.engine.sync();
	const record = rig.recordOf(`Notes/${name}.md`);
	if (record === undefined) throw new Error(`not sent: ${rig.log.join("\n")}`);
	return { rig, docId: record.docId, id: record.deviceDocId };
}

/** The device folder path a document sits in; null in the trash or gone. */
async function folderPath(rig: SyncRig, id: string): Promise<string | null> {
	const listing = await rig.tablet.listing();
	const byId = new Map(listing.map((item) => [item.id, item]));
	if (!byId.has(id)) return null;
	const names: string[] = [];
	let parent = byId.get(id)?.parent ?? "";
	while (parent !== "") {
		if (parent === "trash") return null;
		const folder = byId.get(parent);
		if (folder === undefined) return null;
		names.unshift(folder.visibleName);
		parent = folder.parent;
	}
	return names.join("/");
}

/** The notebook's page files: unchanged ids and hashes mean nothing was rendered again. */
async function pages(rig: SyncRig, id: string): Promise<string[]> {
	const hash = rig.cloud.hashOf(id) ?? "";
	const { entries } = await rig.cloud.api.getEntries(`${id}.docSchema`, hash);
	return entries.filter((entry) => entry.id.endsWith(".rm")).map((entry) => `${entry.id}@${entry.hash}`);
}

async function expectQuiet(rig: SyncRig): Promise<void> {
	const before = [rig.cloud.rootWrites(), rig.vault.writes(), rig.fs.writes()];
	await rig.engine.sync();
	expect([rig.cloud.rootWrites(), rig.vault.writes(), rig.fs.writes()]).toEqual(before);
}

describe("a first sync", () => {
	it("sends a note in a sync folder into the mirrored folder, and a second sync writes nothing", async () => {
		const { rig, id } = await synced();
		expect(await rig.tablet.describe(id)).toMatchObject({ name: "Plan" });
		expect(await folderPath(rig, id)).toBe("Obsidian/Notes");
		await expectQuiet(rig);
	});
});

describe("renames and moves in the vault", () => {
	it("rename the notebook without writing its pages again", async () => {
		const { rig, id } = await synced();
		const before = await pages(rig, id);
		rig.vault.rename("Notes/Plan.md", "Notes/Roadmap.md");
		await rig.engine.sync();
		expect(await rig.tablet.describe(id)).toMatchObject({ name: "Roadmap" });
		expect(await pages(rig, id)).toEqual(before);
		expect(rig.recordOf("Notes/Roadmap.md")).toMatchObject({ deviceDocId: id, notePath: "Notes/Roadmap.md", deviceName: "Roadmap" });
		await expectQuiet(rig);
	});

	it("move the notebook into the mirrored folder, made where missing", async () => {
		const { rig, id } = await synced();
		rig.vault.rename("Notes/Plan.md", "Notes/Work/Plan.md");
		await rig.engine.sync();
		expect(await folderPath(rig, id)).toBe("Obsidian/Notes/Work");
		expect(rig.recordOf("Notes/Work/Plan.md")?.deviceDocId).toBe(id);
		await expectQuiet(rig);
	});

	it("keep ink written on the tablet before the rename: it is read in, not taken as read", async () => {
		const { rig, id, docId } = await synced();
		const page = rig.tablet.write(id);
		rig.vault.rename("Notes/Plan.md", "Notes/Roadmap.md");
		await rig.engine.sync();
		expect(rig.vault.read("Notes/Roadmap.md")).toMatch(/^ink tablet-/m);
		expect(rig.table[docId].accountedHash).toBe(rig.cloud.hashOf(id));
		expect(page).not.toBe(rig.cloud.hashOf(id));
	});
});

describe("a vault folder renamed", () => {
	it("takes its notes' notebooks along, and reports the old device folder left empty", async () => {
		const rig = syncRig();
		rig.vault.create("Readme.md", "Not synced.\n");
		rig.vault.create("Notes/Work/A.md", note("A"));
		rig.vault.create("Notes/Work/B.md", note("B"));
		await rig.engine.sync();
		const ids = ["Notes/Work/A.md", "Notes/Work/B.md"].map((path) => rig.recordOf(path)?.deviceDocId ?? "");
		rig.vault.rename("Notes/Work/A.md", "Notes/Job/A.md");
		rig.vault.rename("Notes/Work/B.md", "Notes/Job/B.md");
		await rig.engine.sync();
		for (const id of ids) expect(await folderPath(rig, id)).toBe("Obsidian/Notes/Job");
		expect(rig.log.filter((line) => line.includes("“Obsidian/Notes/Work” is empty now"))).toHaveLength(1);
		await expectQuiet(rig);
	});
});

describe("renames and moves on the tablet", () => {
	it("rename the note", async () => {
		const { rig, id, docId } = await synced();
		await rig.tablet.rename(id, "Roadmap");
		await rig.engine.sync();
		expect(rig.vault.read("Notes/Plan.md")).toBeUndefined();
		expect(rig.vault.docIdOf(rig.vault.read("Notes/Roadmap.md") ?? "")).toBe(docId);
		await expectQuiet(rig);
	});

	it("give a name with characters a file cannot hold a file name, and leave it at that", async () => {
		const { rig, id } = await synced();
		await rig.tablet.rename(id, "Plan: v2");
		await rig.engine.sync();
		expect(rig.vault.read("Notes/Plan  v2.md") ?? rig.vault.read("Notes/Plan v2.md")).toBeDefined();
		await expectQuiet(rig);
	});

	it("move the note to the vault folder the notebook's new folder mirrors", async () => {
		const { rig, id } = await synced();
		await rig.tablet.move(id, await rig.tablet.folderAt("Obsidian/Projects/Q4"));
		await rig.engine.sync();
		expect(rig.vault.read("Projects/Q4/Plan.md")).toBeDefined();
		expect(rig.vault.read("Notes/Plan.md")).toBeUndefined();
		await expectQuiet(rig);
	});

	it("leave the note where it is when the notebook moves outside the synced folders, and stop moving it back", async () => {
		const { rig, id } = await synced();
		const elsewhere = await rig.tablet.folder("Elsewhere");
		await rig.tablet.move(id, elsewhere);
		await rig.engine.sync();
		expect(rig.vault.read("Notes/Plan.md")).toBeDefined();
		expect(rig.log.join("\n")).toContain("outside the synced folders");
		rig.vault.modify("Notes/Plan.md", (text) => `${text}More.\n`);
		await rig.engine.sync();
		expect(await rig.tablet.describe(id)).toMatchObject({ parent: elsewhere });
		expect(rig.recordOf("Notes/Plan.md")?.contentHash).not.toBe("");
		await expectQuiet(rig);
	});

	it("let the vault's name win when both sides renamed, and say so", async () => {
		const { rig, id } = await synced();
		await rig.tablet.rename(id, "Tablet name");
		rig.vault.rename("Notes/Plan.md", "Notes/Vault name.md");
		await rig.engine.sync();
		expect(await rig.tablet.describe(id)).toMatchObject({ name: "Vault name" });
		expect(rig.vault.read("Notes/Vault name.md")).toBeDefined();
		expect(rig.log.join("\n")).toContain("renamed on both sides");
		await expectQuiet(rig);
	});
});

describe("a note deleted in the vault", () => {
	it("sends its notebook to the tablet's trash and archives the record", async () => {
		const { rig, id, docId } = await synced();
		rig.vault.remove("Notes/Plan.md");
		await rig.engine.sync();
		expect(await rig.tablet.describe(id)).toMatchObject({ parent: "trash" });
		expect(rig.table[docId].state).toBe("archived");
		await expectQuiet(rig);
	});

	it("keeps a notebook written in since, and reports it once", async () => {
		const { rig, id, docId } = await synced();
		rig.tablet.write(id);
		rig.vault.remove("Notes/Plan.md");
		let pulls = 0;
		const { pull } = rig.ports.content;
		rig.ports.content.pull = (ids, options) => {
			if (ids.includes(docId)) pulls++;
			return pull(ids, options);
		};
		await rig.engine.sync();
		expect(await folderPath(rig, id)).toBe("Obsidian/Notes");
		expect(rig.log.filter((line) => line.includes("deleted in the vault but written on the tablet"))).toHaveLength(1);
		await expectQuiet(rig);
		expect(rig.log.filter((line) => line.includes("deleted in the vault but written on the tablet"))).toHaveLength(1);
		expect(pulls).toBe(0);
	});

	it("brings the notebook back from the trash when the note is restored, and syncs again", async () => {
		const { rig, id, docId } = await synced();
		rig.vault.remove("Notes/Plan.md");
		await rig.engine.sync();
		rig.vault.restore("Notes/Plan.md");
		await rig.engine.sync();
		expect(await folderPath(rig, id)).toBe("Obsidian/Notes");
		expect(rig.table[docId].state).toBeUndefined();
		rig.vault.modify("Notes/Plan.md", (text) => `${text}Back.\n`);
		const before = rig.cloud.hashOf(id);
		await rig.engine.sync();
		expect(rig.cloud.hashOf(id)).not.toBe(before);
		await expectQuiet(rig);
	});

	it("is not taken for deleted when the vault looks empty (not loaded yet)", async () => {
		const { rig, id } = await synced();
		rig.vault.remove("Notes/Plan.md");
		rig.vault.remove("Readme.md");
		await rig.engine.reconcile();
		expect(await folderPath(rig, id)).toBe("Obsidian/Notes");
	});
});

describe("a notebook trashed or deleted on the tablet", () => {
	it("brings its new ink in, archives the note, and never sends it again", async () => {
		const { rig, id, docId } = await synced();
		rig.tablet.write(id);
		await rig.tablet.trash(id);
		const writes = rig.created.size;
		await rig.engine.sync();
		const archived = "reMarkable/Archive/Notes/Plan.md";
		expect(rig.vault.read(archived)).toMatch(/^ink tablet-/m);
		expect(rig.table[docId]).toMatchObject({ state: "archived", archivedFrom: "Notes/Plan.md", notePath: archived });
		rig.vault.modify(archived, (text) => `${text}Edited.\n`);
		await rig.engine.sync();
		expect(rig.created.size).toBe(writes);
		expect(await rig.tablet.describe(id)).toMatchObject({ parent: "trash" });
		await expectQuiet(rig);
	});

	it("archives the note of a notebook gone from the account, but not on an empty listing", async () => {
		const { rig, id, docId } = await synced();
		await rig.tablet.erase(id);
		await rig.engine.sync();
		expect(rig.table[docId].state).toBe("archived");
		expect(rig.vault.read("reMarkable/Archive/Notes/Plan.md")).toBeDefined();
	});

	it("leaves everything as it is when the account lists nothing (a fresh pairing)", async () => {
		const { rig, docId } = await synced();
		const [, generation] = await rig.cloud.api.getRootHash();
		const [empty] = await rig.cloud.api.putEntries("root", [], 4);
		await rig.cloud.api.putRootHash(empty.hash, generation);
		await rig.engine.reconcile();
		expect(rig.table[docId].state).toBeUndefined();
		expect(rig.vault.read("Notes/Plan.md")).toBeDefined();
	});

	it("moves the note back from the archive when the notebook is restored from the tablet's trash", async () => {
		const { rig, id, docId } = await synced();
		const folder = (await rig.tablet.describe(id))?.parent ?? "";
		await rig.tablet.trash(id);
		await rig.engine.sync();
		await rig.tablet.move(id, folder);
		await rig.engine.sync();
		expect(rig.vault.read("Notes/Plan.md")).toBeDefined();
		expect(rig.table[docId]).toMatchObject({ notePath: "Notes/Plan.md" });
		expect(rig.table[docId].state).toBeUndefined();
		await expectQuiet(rig);
	});

	it("brings the notebook back when the owner moves the note out of the archive", async () => {
		const { rig, id } = await synced();
		await rig.tablet.trash(id);
		await rig.engine.sync();
		rig.vault.rename("reMarkable/Archive/Notes/Plan.md", "Notes/Plan.md");
		await rig.engine.sync();
		expect(await folderPath(rig, id)).toBe("Obsidian/Notes");
		await expectQuiet(rig);
	});
});

describe("stopping a note's sync", () => {
	it("forgets the note and keeps its notebook by default", async () => {
		const { rig, id, docId } = await synced("Plan", { syncFolders: [] });
		expect(await rig.engine.unlink(docId, "Notes/Plan.md", false)).toBe("kept");
		expect(rig.table[docId]).toBeUndefined();
		expect(rig.vault.docIdOf(rig.vault.read("Notes/Plan.md") ?? "")).toBeUndefined();
		expect(await folderPath(rig, id)).toBe("Obsidian/Notes");
		await expectQuiet(rig);
	});

	it("trashes the notebook only while it holds nothing the note lacks", async () => {
		const first = await synced();
		expect(await first.rig.engine.unlink(first.docId, "Notes/Plan.md", true)).toBe("trashed");
		expect(await first.rig.tablet.describe(first.id)).toMatchObject({ parent: "trash" });
		const second = await synced();
		second.rig.tablet.write(second.id);
		expect(await second.rig.engine.unlink(second.docId, "Notes/Plan.md", true)).toBe("changed");
		expect(await folderPath(second.rig, second.id)).toBe("Obsidian/Notes");
	});
});

describe("a notebook brought in from the tablet", () => {
	it("is read again when written in after it was brought in, then sent", async () => {
		const rig = syncRig();
		const folder = await rig.tablet.folderAt("Obsidian/Notes");
		const original = await sendNotebook(rig.cloud.api, "Ideas", [new Uint8Array([5])], { parentId: folder, retry: { attempts: 1 } });
		const docId = "0f8fad5b-d9cb-469f-a165-70867728950e";
		rig.vault.create("Notes/Ideas.md", withDocId("> [!note] Written on the reMarkable\n", docId));
		await rig.ports.records.set({
			[docId]: { docId, notePath: "Notes/Ideas.md", deviceDocId: original.docId, uploadedAt: "", contentHash: "", format: "device", accountedHash: original.hash },
		});
		rig.tablet.write(original.docId);
		await rig.engine.sync();
		expect(rig.vault.read("Notes/Ideas.md")).toMatch(/^ink tablet-/m);
		expect(rig.table[docId]).toMatchObject({ format: "ink", deviceDocId: original.docId });
		expect(rig.table[docId].accountedHash).toBe(rig.cloud.hashOf(original.docId));
		await expectQuiet(rig);
	});
});

describe("copies of a note", () => {
	it("get an id of their own, even when only the copy is sent", async () => {
		const { rig, id, docId } = await synced("Plan", { syncFolders: [] });
		rig.vault.create("Elsewhere/Plan copy.md", rig.vault.read("Notes/Plan.md") ?? "");
		await rig.engine.send(["Elsewhere/Plan copy.md"]);
		const copy = rig.vault.docIdOf(rig.vault.read("Elsewhere/Plan copy.md") ?? "");
		expect(copy).not.toBe(docId);
		expect(rig.table[docId].deviceDocId).toBe(id);
		expect(copy === undefined ? undefined : rig.table[copy]?.deviceDocId).not.toBe(id);
	});
});

describe("a run cut short", () => {
	it("picks up where it stopped: no duplicate notebook, nothing lost", async () => {
		const { rig, id } = await synced();
		rig.vault.rename("Notes/Plan.md", "Notes/Work/Plan.md");
		rig.vault.create("Notes/Other.md", note("Other"));
		let left = 1;
		rig.failWrites(() => {
			if (left-- <= 0) throw new Error("crash");
		});
		await rig.engine.sync().catch(() => undefined);
		rig.failWrites(null);
		await rig.restart();
		await rig.engine.sync();
		expect(await folderPath(rig, id)).toBe("Obsidian/Notes/Work");
		const live = (await rig.tablet.listing()).filter((item) => item.type === "DocumentType" && item.parent !== "trash");
		expect(live).toHaveLength(2);
		await expectQuiet(rig);
	});
});
