/**
 * In-memory reMarkable raw sync API for transport and send tests: content-
 * addressed files and entry lists, a root with a generation, and hooks to play
 * the tablet (writing into a notebook) or a busy cloud (a refused root write).
 */

import type { RawEntry, RawSyncApi } from "../../transport/notebook";

export function fakeCloud(failRootHashTimes = 0) {
	const files = new Map<string, Uint8Array>();
	const lists = new Map<string, RawEntry[]>();
	const texts = new Map<string, string>();
	let root: RawEntry | null = null;
	let generation = 1;
	let failures = failRootHashTimes;
	let counter = 0;
	/** Runs before each root write; return an error to refuse it. */
	let beforeRootWrite: (() => Error | undefined) | null = null;
	const entry = (id: string): RawEntry => ({ id, hash: `h${++counter}` });
	const rootList = (): RawEntry[] => (root ? (lists.get(root.hash) ?? []) : []);
	const setRoot = (entries: RawEntry[]): void => {
		const e = entry("root");
		lists.set(e.hash, entries);
		root = { id: "root", hash: e.hash };
		generation++;
	};
	const api: RawSyncApi = {
		getRootHash: () => Promise.resolve([root?.hash ?? "root0", generation, 3]),
		getEntries: (_id, hash) => Promise.resolve({ entries: [...(lists.get(hash) ?? [])] }),
		getHash: (_id, hash) => {
			const bytes = files.get(hash);
			if (!bytes) throw new Error(`no file for ${hash}`);
			return Promise.resolve(bytes);
		},
		putFile: (id, bytes) => {
			const e = entry(id);
			files.set(e.hash, bytes);
			return Promise.resolve([e, Promise.resolve()]);
		},
		putText: (id, content) => {
			const e = entry(id);
			files.set(e.hash, new TextEncoder().encode(content));
			texts.set(id, content);
			return Promise.resolve([e, Promise.resolve()]);
		},
		putEntries: (id, entries) => {
			const e = entry(id);
			lists.set(e.hash, [...entries]);
			return Promise.resolve([e, Promise.resolve()]);
		},
		putRootHash: (hash, gen) => {
			if (failures > 0) {
				failures--;
				return Promise.reject(new Error("precondition failed"));
			}
			const refused = beforeRootWrite?.();
			if (refused !== undefined) return Promise.reject(refused);
			if (gen !== generation) return Promise.reject(new Error("precondition failed"));
			root = { id: "root", hash };
			generation++;
			return Promise.resolve([hash, generation]);
		},
	};
	const metadataOf = (docId: string): Record<string, unknown> | null => {
		const doc = rootList().find((e) => e.id === docId);
		const meta = doc === undefined ? undefined : lists.get(doc.hash)?.find((e) => e.id === `${docId}.metadata`);
		const bytes = meta === undefined ? undefined : files.get(meta.hash);
		return bytes === undefined ? null : (JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>);
	};
	return {
		api,
		texts,
		rootList,
		rootWrites: () => generation - 1,
		/** The account listing as rmapi-js' listIds gives it: root entries. */
		listing: () => rootList().map(({ id, hash }) => ({ id, hash })),
		hashOf: (docId: string) => rootList().find((e) => e.id === docId)?.hash,
		parentOf: (docId: string) => metadataOf(docId)?.parent,
		/** Documents on the account and not in the trash. */
		live: () => rootList().filter((e) => metadataOf(e.id)?.parent !== "trash").map((e) => e.id),
		/** The tablet writes a new page into a notebook and syncs it. */
		writeOnTablet(docId: string): string {
			const doc = rootList().find((e) => e.id === docId);
			if (doc === undefined) throw new Error(`no ${docId} on the account`);
			const page = entry(`${docId}/tablet-${counter}.rm`);
			files.set(page.hash, new Uint8Array([7]));
			const updated = entry(docId);
			lists.set(updated.hash, [...(lists.get(doc.hash) ?? []), page]);
			setRoot(rootList().map((e) => (e.id === docId ? updated : e)));
			return updated.hash;
		},
		onRootWrite(hook: (() => Error | undefined) | null): void {
			beforeRootWrite = hook;
		},
	};
}

export type FakeCloud = ReturnType<typeof fakeCloud>;
