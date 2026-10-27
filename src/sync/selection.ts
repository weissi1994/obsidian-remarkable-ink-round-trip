/**
 * Flattening a file-explorer multi-selection into the notes to send
 * (GP_E2_S14). Pure: the plugin edge injects how to classify an item, so
 * this runs in tests without Obsidian — same seam as the rest of the core.
 */

import { parseFrontmatter } from "../preprocess/preprocess";

/**
 * Frontmatter key whose `false` keeps a note out of the sync even inside a
 * sync folder ("Stop syncing" writes it, "Sync with reMarkable" removes it).
 */
export const OPT_OUT_FRONTMATTER_KEY = "remarkable";

/** Whether a frontmatter value of OPT_OUT_FRONTMATTER_KEY opts the note out. */
export function isOptOut(value: unknown): boolean {
	return value === false || (typeof value === "string" && value.trim().toLowerCase() === "false");
}

/** Whether a note's text opts it out of the sync. */
export function optedOut(content: string): boolean {
	return isOptOut(parseFrontmatter(content).fields[OPT_OUT_FRONTMATTER_KEY]);
}

export type SelectionKind<T> =
	| { kind: "note" }
	| { kind: "folder"; children: T[] }
	| { kind: "other" };

/**
 * Depth-first collection of notes from a mixed selection of notes and
 * folders, de-duplicated by path: selecting a note *and* the folder holding
 * it must not send that note twice. Selection order is preserved.
 */
export function flattenSelection<T extends { path: string }>(
	selection: T[],
	classify: (item: T) => SelectionKind<T>,
): T[] {
	const out: T[] = [];
	const seen = new Set<string>();

	const walk = (items: T[]): void => {
		for (const item of items) {
			const classified = classify(item);
			if (classified.kind === "note") {
				if (!seen.has(item.path)) {
					seen.add(item.path);
					out.push(item);
				}
			} else if (classified.kind === "folder") {
				walk(classified.children);
			}
		}
	};

	walk(selection);
	return out;
}

/**
 * Folder path of `dir` relative to `root` (GP_E5_S2): sending a folder keeps
 * its internal structure on the device even when vault mirroring is off, so
 * device folders start at the sent folder rather than the full vault path.
 * `root` "" or "/" means the vault root (nothing to strip); a `dir` outside
 * `root` is returned unchanged rather than guessed at.
 */
export function relativeFolderPath(dir: string, root: string): string {
	if (root === "" || root === "/") return dir;
	if (dir === root) return "";
	return dir.startsWith(`${root}/`) ? dir.slice(root.length + 1) : dir;
}
