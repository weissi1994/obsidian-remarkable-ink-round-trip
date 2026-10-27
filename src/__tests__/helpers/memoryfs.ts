/** In-memory file seam for SyncState tests (the vault adapter in production). */

import type { StateFs } from "../../sync/syncstate";

export function memoryFs() {
	const files = new Map<string, string>();
	let writes = 0;
	const fs: StateFs = {
		exists: async (path) => files.has(path) || [...files.keys()].some((f) => f.startsWith(`${path}/`)),
		read: async (path) => {
			const text = files.get(path);
			if (text === undefined) throw new Error(`no ${path}`);
			return text;
		},
		write: async (path, data) => {
			writes++;
			files.set(path, data);
		},
		mkdir: async () => undefined,
		list: async (dir) => [...files.keys()].filter((f) => f.startsWith(`${dir}/`) && !f.slice(dir.length + 1).includes("/")),
		remove: async (path) => {
			files.delete(path);
		},
	};
	return { fs, files, writes: () => writes };
}
