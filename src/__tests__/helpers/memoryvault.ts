/**
 * In-memory vault for engine tests: notes by path with their frontmatter id,
 * Obsidian's moves (a taken path gets a number), deletes into a trash they
 * can be restored from, and the engine's VaultPort over it.
 */

import { DOCID_FRONTMATTER_KEY } from "../../id/docid";
import { parseFrontmatter, splitNote } from "../../preprocess/preprocess";
import type { VaultPort } from "../../sync/engine";
import { isOptOut, OPT_OUT_FRONTMATTER_KEY } from "../../sync/selection";
import { frontmatterTags } from "../../sync/tags";

/** The note with one frontmatter key set to a raw YAML value, or removed (null). */
export function withField(content: string, key: string, value: string | null): string {
	const { head, body } = splitNote(content);
	const lines = head === "" ? [] : head.replace(/^---\r?\n/, "").replace(/\r?\n---(\r?\n)?$/, "").split("\n");
	const kept = lines.filter((line) => !line.startsWith(`${key}:`));
	if (value !== null) kept.unshift(`${key}: ${value}`);
	return kept.length === 0 ? body : `---\n${kept.join("\n")}\n---\n${body}`;
}

export function withDocId(content: string, docId: string | null): string {
	return withField(content, DOCID_FRONTMATTER_KEY, docId);
}

export function memoryVault() {
	const files = new Map<string, { content: string; ctime: number }>();
	const trash = new Map<string, { content: string; ctime: number }>();
	/** Document ids of notes the owner deleted (Obsidian's delete event); the note coming back clears it. */
	const deleted = new Set<string>();
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
	const arrived = (content: string): void => {
		const docId = docIdOf(content);
		if (docId !== undefined) deleted.delete(docId);
	};
	const port: VaultPort = {
		notes: () =>
			Promise.resolve(
				[...files.entries()].map(([path, file]) => {
					const fields = parseFrontmatter(file.content).fields;
					const tags = frontmatterTags(fields.tags);
					return {
						path,
						docId: docIdOf(file.content),
						ctime: file.ctime,
						...(tags.length > 0 ? { tags } : {}),
						...(isOptOut(fields[OPT_OUT_FRONTMATTER_KEY]) ? { optOut: true } : {}),
					};
				}),
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
		setOptOut: (path, optOut) => {
			const file = files.get(path);
			if (file === undefined) return Promise.reject(new Error(`no ${path}`));
			write();
			files.set(path, { ...file, content: withField(file.content, OPT_OUT_FRONTMATTER_KEY, optOut ? "false" : null) });
			return Promise.resolve();
		},
		setTags: (path, tags) => {
			const file = files.get(path);
			if (file === undefined) return Promise.reject(new Error(`no ${path}`));
			write();
			files.set(path, { ...file, content: withField(file.content, "tags", tags.length === 0 ? null : `[${tags.join(", ")}]`) });
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
		deleted: (docId) => deleted.has(docId),
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
			arrived(content);
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
			// As Obsidian's delete event, under whatever name the note has now.
			const docId = docIdOf(file.content);
			if (docId !== undefined) deleted.add(docId);
		},
		/** Gone without a delete event: deleted while Obsidian was closed, or by a sync tool. */
		removeUnseen(path: string): void {
			if (!files.delete(path)) throw new Error(`no ${path}`);
		},
		restore(path: string): string {
			const file = trash.get(path);
			if (file === undefined) throw new Error(`nothing to restore at ${path}`);
			trash.delete(path);
			const at = free(path);
			files.set(at, file);
			arrived(file.content);
			return at;
		},
	};
}

export type MemoryVault = ReturnType<typeof memoryVault>;
