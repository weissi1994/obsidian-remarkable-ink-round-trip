import { describe, expect, it } from "vitest";
import type { DeviceItem } from "../sync/deviceimport";
import { createFolder, editMetadata, ensureFolderPath, readListing } from "../transport/metadata";
import { NotebookChangedError, NotebookGoneError, sendNotebook } from "../transport/notebook";
import { fakeCloud } from "./helpers/fakecloud";

const ONCE = { retry: { attempts: 1 } };

async function withNotebook() {
	const cloud = fakeCloud();
	const folder = await createFolder(cloud.api, "Obsidian", "", ONCE);
	const doc = await sendNotebook(cloud.api, "Plan", [new Uint8Array([1])], { parentId: folder.id, retry: { attempts: 1 } });
	return { cloud, folder: folder.id, doc };
}

describe("the account listing", () => {
	it("gives each item's name and folder, reading metadata only for what changed", async () => {
		const { cloud, folder, doc } = await withNotebook();
		const cache: Record<string, DeviceItem> = {};
		const first = await readListing(cloud.api, cache);
		expect(first.find((item) => item.id === doc.docId)).toMatchObject({ visibleName: "Plan", parent: folder, type: "DocumentType" });
		let reads = 0;
		const getHash = cloud.api.getHash.bind(cloud.api);
		cloud.api.getHash = (id, hash) => {
			reads++;
			return getHash(id, hash);
		};
		await readListing(cloud.api, cache);
		expect(reads).toBe(0);
	});

	it("keeps an item whose metadata cannot be read, marked, with its current hash", async () => {
		const { cloud, doc } = await withNotebook();
		const getHash = cloud.api.getHash.bind(cloud.api);
		cloud.api.getHash = (id, hash) => (id.startsWith(doc.docId) ? Promise.reject(new Error("unreadable")) : getHash(id, hash));
		const listing = await readListing(cloud.api, {});
		expect(listing.find((item) => item.id === doc.docId)).toMatchObject({ unreadable: true, hash: cloud.hashOf(doc.docId) });
	});

	it("forgets what left the account", async () => {
		const { cloud, doc } = await withNotebook();
		const cache: Record<string, DeviceItem> = {};
		await readListing(cloud.api, cache);
		const [root, generation] = await cloud.api.getRootHash();
		const { entries } = await cloud.api.getEntries("root.docSchema", root);
		const [next] = await cloud.api.putEntries("root", entries.filter((entry) => entry.id !== doc.docId), 4);
		await cloud.api.putRootHash(next.hash, generation);
		expect((await readListing(cloud.api, cache)).some((item) => item.id === doc.docId)).toBe(false);
		expect(cache[doc.docId]).toBeUndefined();
	});
});

describe("renaming and moving", () => {
	it("changes only the metadata, and resolves to the new hash", async () => {
		const { cloud, doc } = await withNotebook();
		const pagesBefore = (await cloud.api.getEntries("", cloud.hashOf(doc.docId) ?? "")).entries.filter((e) => e.id.endsWith(".rm"));
		const hash = await editMetadata(cloud.api, doc.docId, doc.hash, { visibleName: "Roadmap", parent: "trash" }, ONCE);
		expect(hash).toBe(cloud.hashOf(doc.docId));
		expect(cloud.parentOf(doc.docId)).toBe("trash");
		const pagesAfter = (await cloud.api.getEntries("", hash)).entries.filter((e) => e.id.endsWith(".rm"));
		expect(pagesAfter).toEqual(pagesBefore);
	});

	it("writes nothing when the document changed since it was seen", async () => {
		const { cloud, doc } = await withNotebook();
		cloud.writeOnTablet(doc.docId);
		const writes = cloud.rootWrites();
		await expect(editMetadata(cloud.api, doc.docId, doc.hash, { parent: "trash" }, ONCE)).rejects.toBeInstanceOf(NotebookChangedError);
		expect(cloud.rootWrites()).toBe(writes);
		expect(cloud.parentOf(doc.docId)).not.toBe("trash");
	});

	it("says so when the document is not on the account", async () => {
		const { cloud } = await withNotebook();
		await expect(editMetadata(cloud.api, "missing", "h", { visibleName: "x" }, ONCE)).rejects.toBeInstanceOf(NotebookGoneError);
	});

	it("tries again from a fresh read when the root moved on meanwhile", async () => {
		const { cloud, doc } = await withNotebook();
		let refused = 1;
		cloud.onRootWrite(() => (refused-- > 0 ? new Error("precondition failed") : undefined));
		await editMetadata(cloud.api, doc.docId, doc.hash, { visibleName: "Again" }, { retry: { attempts: 2, sleep: () => Promise.resolve() } });
		expect((await readListing(cloud.api, {})).find((item) => item.id === doc.docId)?.visibleName).toBe("Again");
	});
});

describe("mirrored folders", () => {
	it("are made where missing and reused where there", async () => {
		const cloud = fakeCloud();
		const listing = await readListing(cloud.api, {});
		const id = await ensureFolderPath(cloud.api, listing, "Obsidian/Projects/Alpha", ONCE);
		const writes = cloud.rootWrites();
		expect(await ensureFolderPath(cloud.api, listing, "Obsidian/Projects/Alpha", ONCE)).toBe(id);
		await ensureFolderPath(cloud.api, listing, "Obsidian/Projects/Beta", ONCE);
		expect(cloud.rootWrites()).toBe(writes + 1);
		const fresh = await readListing(cloud.api, {});
		expect(fresh.filter((item) => item.type === "CollectionType").map((item) => item.visibleName).sort()).toEqual([
			"Alpha",
			"Beta",
			"Obsidian",
			"Projects",
		]);
	});

	it("are not confused with a same-named folder elsewhere, or in the trash", async () => {
		const cloud = fakeCloud();
		const elsewhere = await createFolder(cloud.api, "Elsewhere", "", ONCE);
		const stray = await createFolder(cloud.api, "Notes", elsewhere.id, ONCE);
		const trashed = await createFolder(cloud.api, "Notes", "trash", ONCE);
		const id = await ensureFolderPath(cloud.api, await readListing(cloud.api, {}), "Notes", ONCE);
		expect([stray.id, trashed.id]).not.toContain(id);
		expect(await ensureFolderPath(cloud.api, [], "", ONCE)).toBe("");
	});
});
