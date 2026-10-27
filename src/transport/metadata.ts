/**
 * Metadata-only operations on the reMarkable raw sync API: the account
 * listing with names and folders, renaming and moving a document (the trash
 * is a folder like any other) and creating folders — without touching a
 * document's pages.
 *
 * Every edit is compare-before-write: it goes through only while the
 * document's entry in the account root still has the hash the caller saw,
 * and the root itself is replaced only at the generation it was read at
 * (a refused root write is retried from a fresh read).
 */

import { generateDocId } from "../id/docid";
import type { DeviceItem } from "../sync/deviceimport";
import { withGenerationRetry, type RetryOptions } from "./mirror";
import { NotebookChangedError, NotebookGoneError, type RawEntry, type RawSyncApi } from "./notebook";

interface Metadata {
	visibleName?: string;
	parent?: string;
	type?: string;
	lastModified?: string;
	[key: string]: unknown;
}

async function metadataEntry(api: RawSyncApi, docId: string, hash: string): Promise<{ entries: RawEntry[]; meta: RawEntry }> {
	const { entries } = await api.getEntries(`${docId}.docSchema`, hash);
	const meta = entries.find((entry) => entry.id === `${docId}.metadata`);
	if (meta === undefined) throw new Error(`${docId} has no metadata.`);
	return { entries, meta };
}

async function readMetadata(api: RawSyncApi, docId: string, hash: string): Promise<Metadata> {
	const { meta } = await metadataEntry(api, docId, hash);
	return JSON.parse(new TextDecoder().decode(await api.getHash(meta.id, meta.hash))) as Metadata;
}

/**
 * Every document and folder on the account, trashed ones included (parent
 * "trash"). Metadata is read only for what changed since `cache` (by hash),
 * which is updated in place. An item whose metadata cannot be read is still
 * listed — with its current hash and `unreadable` — so it is never taken
 * for gone.
 */
export async function readListing(api: RawSyncApi, cache: Record<string, DeviceItem>): Promise<DeviceItem[]> {
	const [rootHash] = await api.getRootHash();
	const { entries } = await api.getEntries("root.docSchema", rootHash);
	const present = new Set<string>();
	const out: DeviceItem[] = [];
	for (const { id, hash } of entries) {
		present.add(id);
		if (cache[id]?.hash !== hash) {
			try {
				const meta = await readMetadata(api, id, hash);
				cache[id] = {
					id,
					hash,
					type: String(meta.type ?? ""),
					parent: String(meta.parent ?? ""),
					visibleName: String(meta.visibleName ?? ""),
					lastModified: String(meta.lastModified ?? "0"),
				};
			} catch {
				// Tried again next time; the stale cache entry is not trusted meanwhile.
				out.push({ ...(cache[id] ?? { type: "", parent: "", visibleName: "", lastModified: "0" }), id, hash, unreadable: true });
				continue;
			}
		}
		out.push(cache[id]);
	}
	for (const id of Object.keys(cache)) if (!present.has(id)) delete cache[id];
	return out;
}

/**
 * Change a document's name and/or folder while its root entry still has
 * `expectedHash`; resolves to its new entry hash. NotebookChangedError when
 * it changed since, NotebookGoneError when it is not on the account.
 */
export function editMetadata(
	api: RawSyncApi,
	docId: string,
	expectedHash: string,
	update: { visibleName?: string; parent?: string },
	options: { retry?: RetryOptions; now?: () => number } = {},
): Promise<string> {
	return withGenerationRetry(async () => {
		const [rootHash, generation, schemaVersion] = await api.getRootHash();
		const { entries: root } = await api.getEntries("root.docSchema", rootHash);
		const current = root.find((entry) => entry.id === docId);
		if (current === undefined) throw new NotebookGoneError(docId);
		if (current.hash !== expectedHash) throw new NotebookChangedError(docId, expectedHash, current.hash);
		const { entries, meta } = await metadataEntry(api, docId, current.hash);
		const metadata = JSON.parse(new TextDecoder().decode(await api.getHash(meta.id, meta.hash))) as Metadata;
		const [newMeta, uploadMeta] = await api.putText(
			`${docId}.metadata`,
			JSON.stringify({ ...metadata, ...update, lastModified: (options.now ?? Date.now)().toFixed() }),
		);
		const [entry, uploadEntries] = await api.putEntries(
			docId,
			entries.map((e) => (e.id === meta.id ? newMeta : e)),
			schemaVersion,
		);
		const [rootEntry, uploadRoot] = await api.putEntries(
			"root",
			root.map((e) => (e.id === docId ? entry : e)),
			4,
		);
		await Promise.all([uploadMeta, uploadEntries, uploadRoot]);
		await api.putRootHash(rootEntry.hash, generation);
		return entry.hash;
	}, options.retry);
}

/** Create a folder (a collection) under `parent` ("" = root); resolves to its id and hash. */
export function createFolder(
	api: RawSyncApi,
	visibleName: string,
	parent: string,
	options: { retry?: RetryOptions; now?: () => number } = {},
): Promise<{ id: string; hash: string }> {
	const id = generateDocId();
	return withGenerationRetry(async () => {
		const now = (options.now ?? Date.now)().toFixed();
		const [rootHash, generation, schemaVersion] = await api.getRootHash();
		const [[content, uploadContent], [meta, uploadMeta]] = await Promise.all([
			api.putText(`${id}.content`, JSON.stringify({ tags: [] })),
			api.putText(
				`${id}.metadata`,
				JSON.stringify({ lastModified: now, createdTime: now, parent, pinned: false, type: "CollectionType", visibleName }),
			),
		]);
		const [[collection, uploadCollection], { entries: root }] = await Promise.all([
			api.putEntries(id, [content, meta], schemaVersion),
			api.getEntries("root.docSchema", rootHash),
		]);
		const [rootEntry, uploadRoot] = await api.putEntries("root", [...root.filter((e) => e.id !== id), collection], 4);
		await Promise.all([uploadContent, uploadMeta, uploadCollection, uploadRoot]);
		await api.putRootHash(rootEntry.hash, generation);
		return { id, hash: collection.hash };
	}, options.retry);
}

/** Device folder path of a collection id ("" = root), or null when it is in the trash or not on the account. */
export function devicePathOf(parent: string, byId: ReadonlyMap<string, DeviceItem>): string | null {
	const names: string[] = [];
	let current = parent;
	for (let guard = 0; current !== "" && guard < 64; guard++) {
		if (current === "trash") return null;
		const folder = byId.get(current);
		if (folder === undefined || folder.type !== "CollectionType") return null;
		names.unshift(folder.visibleName);
		current = folder.parent;
	}
	return current === "" ? names.join("/") : null;
}

/**
 * The folder at `path` ("a/b", "" = root), created where missing. `listing`
 * is the account as last read; folders created here are added to it, so
 * one listing serves a whole run.
 */
export async function ensureFolderPath(
	api: RawSyncApi,
	listing: DeviceItem[],
	path: string,
	options: { retry?: RetryOptions; now?: () => number } = {},
): Promise<string> {
	let parent = "";
	for (const name of path.split("/").filter((segment) => segment !== "")) {
		const existing = listing.find(
			(item) => item.type === "CollectionType" && item.visibleName === name && item.parent === parent,
		);
		if (existing !== undefined) {
			parent = existing.id;
			continue;
		}
		const created = await createFolder(api, name, parent, options);
		listing.push({ id: created.id, hash: created.hash, type: "CollectionType", parent, visibleName: name, lastModified: "0" });
		parent = created.id;
	}
	return parent;
}
