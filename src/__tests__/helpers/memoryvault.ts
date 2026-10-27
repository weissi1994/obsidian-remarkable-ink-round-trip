/**
 * In-memory vault for engine tests: notes by path with their frontmatter id,
 * Obsidian's moves (a taken path gets a number), deletes into a trash they
 * can be restored from, and the engine's VaultPort over it.
 */

import { DOCID_FRONTMATTER_KEY } from "../../id/docid";
import { parseFrontmatter, splitNote } from "../../preprocess/preprocess";
import type { VaultPort } from "../../sync/engine";

export function withDocId(content: string, docId: string | null): string {
	const { head, body } = splitNote(content);
	const lines = head === "" ? [] : head.replace(/^---\r?\n/, "").replace(/\r?\n---(\r?\n)?$/, "").split("\n");
	const kept = lines.filter((line) => !line.startsWith(`${DOCID_FRONTMATTER_KEY}:`));
	if (docId !== null) kept.unshift(`${DOCID_FRONTMATTER_KEY}: ${docId}`);
	return kept.length === 0 ? body : `---\n${kept.join("\n")}\n---\n${body}`;
}

export function memoryVault() {
	const files = new Map<string, { content: string; ctime: number }>();
	const trash = new Map<string, { content: string; ctime: number }>();
	let clock = 0;
	let writes = 0;
	/** Runs before every write; throw from it to fail the write (a crash). */
	let beforeWrite: (() => void) | null = null;
	const write = () => {
		beforeWrite?.();
		writes++;
	};
	const free = (path: string): string => {
		if (!files.has(path)) return path;
		const stem = path.replace(/\.md$/, "");
		for (let n = 2; ; n++) if (!files.has(`${stem} (${n}).md`)) return `${stem} (${n}).md`;
	};
	const docIdOf = (content: string): string | undefined => {
		const value = parseFrontmatter(content).fields[DOCID_FRONTMATTER_KEY];
		return typeof value === "string" && value !== "" ? value : undefined;
	};
	const port: VaultPort = {
		notes: () =>
			Promise.resolve(
				[...files.entries()].map(([path, file]) => ({ path, docId: docIdOf(file.content), ctime: file.ctime })),
			),
		move: (from, to) => {
			const file = files.get(from);
			if (file === undefined) return Promise.reject(new Error(`no ${from}`));
			if (from === to) return Promise.resolve(to);
			write();
			files.delete(from);
			const path = free(to);
			files.set(path, file);
			return Promise.resolve(path);
		},
		setDocId: (path, docId) => {
			const file = files.get(path);
			if (file === undefined) return Promise.reject(new Error(`no ${path}`));
			write();
			files.set(path, { ...file, content: withDocId(file.content, docId) });
			return Promise.resolve();
		},
		load: (path) => {
			const file = files.get(path);
			if (file === undefined) return Promise.resolve(null);
			return Promise.resolve({
				note: {
					path,
					basename: (path.split("/").pop() ?? path).replace(/\.md$/, ""),
					content: file.content,
					existingDocId: docIdOf(file.content),
				},
				resolveEmbed: () => ({ kind: "missing" as const }),
			});
		},
	};
	return {
		port,
		files,
		trash,
		writes: () => writes,
		onWrite(hook: (() => void) | null): void {
			beforeWrite = hook;
		},
		read: (path: string) => files.get(path)?.content,
		docIdOf,
		create(path: string, content: string): void {
			files.set(path, { content, ctime: ++clock });
		},
		modify(path: string, change: (content: string) => string): void {
			const file = files.get(path);
			if (file === undefined) throw new Error(`no ${path}`);
			write();
			files.set(path, { ...file, content: change(file.content) });
		},
		/** A user rename/move: no number added, the target must be free. */
		rename(from: string, to: string): void {
			const file = files.get(from);
			if (file === undefined || files.has(to)) throw new Error(`cannot rename ${from} → ${to}`);
			files.delete(from);
			files.set(to, file);
		},
		/** Delete into the trash, from where `restore` brings it back. */
		remove(path: string): void {
			const file = files.get(path);
			if (file === undefined) throw new Error(`no ${path}`);
			files.delete(path);
			trash.set(path, file);
		},
		restore(path: string): string {
			const file = trash.get(path);
			if (file === undefined) throw new Error(`nothing to restore at ${path}`);
			trash.delete(path);
			const at = free(path);
			files.set(at, file);
			return at;
		},
	};
}
