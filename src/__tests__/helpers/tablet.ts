/**
 * Play the tablet against the fake cloud: read a document's files and write
 * them back changed, the way a sync from the tablet replaces them.
 */

import type { RawEntry, RawSyncApi } from "../../transport/notebook";

/** What these helpers need of the fake cloud (helpers/fakecloud.ts). */
export interface TabletCloud {
	api: RawSyncApi;
	hashOf(docId: string): string | undefined;
}

/** A document's files by id, as the account holds them now. */
export async function filesOf(cloud: TabletCloud, docId: string): Promise<Map<string, Uint8Array>> {
	const hash = cloud.hashOf(docId);
	if (hash === undefined) throw new Error(`no ${docId} on the account`);
	const { entries } = await cloud.api.getEntries(`${docId}.docSchema`, hash);
	const files = new Map<string, Uint8Array>();
	for (const entry of entries) files.set(entry.id, await cloud.api.getHash(entry.id, entry.hash));
	return files;
}

/** Write a root holding `entries`; `edit` gets the current one. */
async function writeRoot(cloud: TabletCloud, edit: (entries: RawEntry[]) => RawEntry[]): Promise<void> {
	const [rootHash, generation] = await cloud.api.getRootHash();
	const { entries } = await cloud.api.getEntries("root.docSchema", rootHash);
	const [root] = await cloud.api.putEntries("root", edit(entries), 4);
	await cloud.api.putRootHash(root.hash, generation);
}

/** The tablet changes a document's files and syncs; returns its new hash. */
export async function onTablet(
	cloud: TabletCloud,
	docId: string,
	edit: (files: Map<string, Uint8Array>) => void,
): Promise<string> {
	const files = await filesOf(cloud, docId);
	edit(files);
	const entries: RawEntry[] = [];
	for (const [id, bytes] of files) entries.push((await cloud.api.putFile(id, bytes))[0]);
	const [doc] = await cloud.api.putEntries(docId, entries, 3);
	await writeRoot(cloud, (root) => root.map((entry) => (entry.id === docId ? doc : entry)));
	return doc.hash;
}

/** The document is deleted for good (emptied from the trash on the tablet). */
export function removeFromAccount(cloud: TabletCloud, docId: string): Promise<void> {
	return writeRoot(cloud, (root) => root.filter((entry) => entry.id !== docId));
}

export const decodeJson = <T = Record<string, unknown>>(bytes: Uint8Array | undefined): T =>
	JSON.parse(new TextDecoder().decode(bytes)) as T;

export const encodeJson = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
