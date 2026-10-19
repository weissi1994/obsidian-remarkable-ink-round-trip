/**
 * Notebooks started on the tablet, brought into the vault (ink fork).
 *
 * A notebook the plugin did not write, sitting in the device folder of a
 * synced vault folder, becomes a note at the same place in the vault: each
 * page as a callout with the page's ink as an image and its text as read.
 * The sync then sends that note back as a handwritten notebook in place of
 * the original — from there on it is a synced note like any other.
 */

export interface DeviceItem {
	id: string;
	hash: string;
	type: string;
	parent: string;
	visibleName: string;
	lastModified: string;
	/** Read and found not to be a notebook (a PDF, an EPUB): not looked at again at this hash. */
	notNotebook?: boolean;
}

export interface NewNotebook {
	id: string;
	hash: string;
	name: string;
	/** Vault folder it belongs in ("" = vault root). */
	folder: string;
}

/** Device path of an item's folder ("" = root), or null when it is in the trash. */
function folderPathOf(item: DeviceItem, byId: Map<string, DeviceItem>): string | null {
	const names: string[] = [];
	let parent = item.parent;
	for (let guard = 0; parent !== "" && guard < 64; guard++) {
		if (parent === "trash") return null;
		const folder = byId.get(parent);
		if (folder === undefined) return null;
		names.unshift(folder.visibleName);
		parent = folder.parent;
	}
	return names.join("/");
}

/**
 * Notebooks to bring in: documents the plugin does not know, inside the
 * device folder of a synced vault folder, and left alone on the tablet for
 * `quietMs` — a notebook still being written in is not swapped out from
 * under the pen.
 */
export function findNewNotebooks(
	items: DeviceItem[],
	options: { baseFolder: string; vaultFolders: string[]; known: Set<string>; now: number; quietMs: number },
): NewNotebook[] {
	const byId = new Map(items.map((item) => [item.id, item]));
	const base = options.baseFolder.replace(/^\/+|\/+$/g, "");
	const out: NewNotebook[] = [];
	for (const item of items) {
		if (item.type !== "DocumentType" || item.notNotebook === true || options.known.has(item.id)) continue;
		if (options.now - Number(item.lastModified) < options.quietMs) continue;
		const path = folderPathOf(item, byId);
		if (path === null) continue;
		for (const vaultFolder of options.vaultFolders) {
			const clean = vaultFolder.replace(/^\/+|\/+$/g, "");
			const device = [base, clean].filter((part) => part !== "").join("/");
			if (path !== device && !path.startsWith(`${device}/`)) continue;
			const rest = path.slice(device.length).replace(/^\//, "");
			out.push({ id: item.id, hash: item.hash, name: item.visibleName, folder: [clean, rest].filter((p) => p !== "").join("/") });
			break;
		}
	}
	return out;
}

/** A file name the vault accepts, from a notebook name. */
export function noteFileName(name: string): string {
	const clean = name.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim();
	return clean === "" ? "reMarkable notebook" : clean;
}

/**
 * The note for a notebook: its id in the frontmatter, then each page as a
 * callout — the text as read (edit it freely: corrections teach the reader
 * your hand) and the page's ink.
 */
export function importedNote(docId: string, pages: { image?: string; text?: string }[]): string {
	const blocks = pages
		.map((page, index) => {
			const title = pages.length === 1 ? "> [!note] Written on the reMarkable" : `> [!note] Page ${index + 1}`;
			const text = page.text === undefined ? [] : page.text.split("\n").map((line) => `> ${line}`);
			const image = page.image === undefined ? [] : [`> ![[${page.image}]]`];
			return [title, ...text, ...image].join("\n");
		})
		.join("\n\n");
	return `---\nremarkable-id: ${docId}\n---\n${blocks}\n`;
}
