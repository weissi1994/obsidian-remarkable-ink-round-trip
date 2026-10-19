/**
 * Sync state shared by every copy of the vault (ink fork).
 *
 * What ties a note to its notebook — the mapping, the text the notebook was
 * written from, the learned hand, the word samples — lives in a folder of
 * the vault itself, so a vault synced by git (or anything else) carries it to
 * every device: a second Obsidian knows what the first one sent and neither
 * sends a duplicate. Device-only things (the pairing token, settings, caches)
 * stay in the plugin's own data.
 *
 * One small file per note, so two devices editing different notes never
 * collide; pictures stored once by content, so a re-send does not rewrite
 * them. A file that cannot be read — a merge left conflict markers in it — is
 * skipped and reported, never taken for "nothing was sent".
 */

import type { MappingEntry, MappingTable } from "../id/mapping";
import type { HandLibrary } from "../ink/handsheet";
import type { InkDrawing } from "../ink/inkdrawing";
import type { InkStrokes, Picture } from "../ink/inkimage";
import type { SampleStore } from "../ocr/samples";
import type { SentRecord } from "./send";

/** The file operations the state needs; the plugin edge adapts the vault adapter. */
export interface StateFs {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
	mkdir(path: string): Promise<void>;
	/** Files directly inside `dir`, as full paths. */
	list(dir: string): Promise<string[]>;
	remove(path: string): Promise<void>;
}

/** A note's file: its mapping and what its notebook was written from. */
interface NoteFile {
	mapping?: MappingEntry;
	sent?: StoredSent;
}

/** A send record with its pictures replaced by references to `pictures/`. */
type StoredSent = Omit<SentRecord, "images" | "drawings"> & {
	images?: Record<string, string>;
	drawings?: Record<string, string>;
};

function hash(text: string): string {
	let h1 = 0x811c9dc5;
	let h2 = 0x01000193;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		h1 = Math.imul(h1 ^ c, 0x01000193);
		h2 = Math.imul(h2 ^ c, 0x5bd1e995);
	}
	return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

export class SyncState {
	/** Each note's mapping as last written or read, to write only what changed. */
	private readonly seen = new Map<string, string>();
	/** Files that could not be read on the last load, for the log. */
	unreadable: string[] = [];

	constructor(
		private readonly fs: StateFs,
		readonly root: string,
	) {}

	private path(...parts: string[]): string {
		return [this.root.replace(/\/+$/, ""), ...parts].join("/");
	}

	private async readJson<T>(path: string): Promise<T | null> {
		if (!(await this.fs.exists(path))) return null;
		try {
			return JSON.parse(await this.fs.read(path)) as T;
		} catch {
			this.unreadable.push(path);
			return null;
		}
	}

	private async writeJson(path: string, value: unknown): Promise<void> {
		const folder = path.split("/").slice(0, -1).join("/");
		if (folder !== "" && !(await this.fs.exists(folder))) await this.fs.mkdir(folder);
		await this.fs.write(path, JSON.stringify(value, null, "\t"));
	}

	private noteFile(docId: string): string {
		return this.path("notes", `${docId}.json`);
	}

	/** Every note's mapping on disk. */
	async loadMappings(): Promise<MappingTable> {
		const table = await this.loadMappingsRaw();
		for (const [docId, mapping] of Object.entries(table)) this.seen.set(docId, JSON.stringify(mapping));
		return table;
	}

	/** Whether the state folder holds any notes yet (for the one-time migration). */
	async isEmpty(): Promise<boolean> {
		const dir = this.path("notes");
		return !(await this.fs.exists(dir)) || (await this.fs.list(dir)).length === 0;
	}

	/** Write the mappings that changed since last seen; drop the ones gone from the table. */
	async saveMappings(table: MappingTable): Promise<void> {
		for (const [docId, mapping] of Object.entries(table)) {
			const text = JSON.stringify(mapping);
			if (this.seen.get(docId) === text) continue;
			const file = this.noteFile(docId);
			const note = (await this.readJson<NoteFile>(file)) ?? {};
			await this.writeJson(file, { ...note, mapping });
			this.seen.set(docId, text);
		}
		for (const docId of [...this.seen.keys()]) {
			if (table[docId] !== undefined) continue;
			const file = this.noteFile(docId);
			if (await this.fs.exists(file)) await this.fs.remove(file);
			this.seen.delete(docId);
		}
	}

	/**
	 * Take in what another device wrote since: a mapping whose file changed on
	 * disk (a pull brought it) replaces ours; a new file adds one; a file
	 * that went away removes it. Mappings this device changed since are kept.
	 */
	async refresh(table: MappingTable): Promise<MappingTable> {
		const onDisk = await this.loadMappingsRaw();
		const merged: MappingTable = { ...table };
		for (const [docId, mapping] of Object.entries(onDisk)) {
			const text = JSON.stringify(mapping);
			const ours = table[docId] === undefined ? undefined : JSON.stringify(table[docId]);
			const lastSeen = this.seen.get(docId);
			if (text === lastSeen) continue; // unchanged on disk
			if (ours !== undefined && ours !== lastSeen && lastSeen !== undefined) continue; // changed here too: ours is newer
			merged[docId] = mapping;
			this.seen.set(docId, text);
		}
		for (const docId of [...this.seen.keys()]) {
			if (onDisk[docId] !== undefined || this.unreadable.includes(this.noteFile(docId))) continue;
			if (table[docId] !== undefined && JSON.stringify(table[docId]) !== this.seen.get(docId)) continue;
			delete merged[docId];
			this.seen.delete(docId);
		}
		return merged;
	}

	private async loadMappingsRaw(): Promise<MappingTable> {
		this.unreadable = [];
		const table: MappingTable = {};
		const dir = this.path("notes");
		if (!(await this.fs.exists(dir))) return table;
		for (const file of await this.fs.list(dir)) {
			if (!file.endsWith(".json")) continue;
			const note = await this.readJson<NoteFile>(file);
			if (note?.mapping !== undefined) table[note.mapping.docId] = note.mapping;
		}
		return table;
	}

	/* ------------------------------ sends ------------------------------ */

	private async storePictures<T>(pictures: Record<string, T> | undefined): Promise<Record<string, string> | undefined> {
		if (pictures === undefined) return undefined;
		const refs: Record<string, string> = {};
		for (const [name, picture] of Object.entries(pictures)) {
			const text = JSON.stringify(picture);
			const key = hash(text);
			const file = this.path("pictures", `${key}.json`);
			if (!(await this.fs.exists(file))) await this.writeJson(file, picture);
			refs[name] = key;
		}
		return refs;
	}

	private async loadPictures<T>(refs: Record<string, string> | undefined): Promise<Record<string, T> | undefined> {
		if (refs === undefined) return undefined;
		const out: Record<string, T> = {};
		for (const [name, key] of Object.entries(refs)) {
			const picture = await this.readJson<T>(this.path("pictures", `${key}.json`));
			if (picture !== null) out[name] = picture;
		}
		return out;
	}

	async writeSent(docId: string, sent: SentRecord): Promise<void> {
		const file = this.noteFile(docId);
		const note = (await this.readJson<NoteFile>(file)) ?? {};
		const stored: StoredSent = {
			...sent,
			images: await this.storePictures<Picture>(sent.images),
			drawings: await this.storePictures<InkDrawing>(sent.drawings),
		};
		await this.writeJson(file, { ...note, sent: stored });
	}

	async readSent(docId: string): Promise<SentRecord | null> {
		const note = await this.readJson<NoteFile>(this.noteFile(docId));
		if (note?.sent === undefined) return null;
		return {
			...note.sent,
			images: await this.loadPictures<Picture>(note.sent.images),
			drawings: await this.loadPictures<InkDrawing>(note.sent.drawings),
		};
	}

	/* ------------------------------ ink ------------------------------- */

	/** The strokes a remark or page image in the vault was drawn from, by image file name. */
	readInk(imageName: string): Promise<InkStrokes | null> {
		return this.readJson<InkStrokes>(this.path("ink", `${imageName}.json`));
	}

	writeInk(imageName: string, ink: InkStrokes): Promise<void> {
		return this.writeJson(this.path("ink", `${imageName}.json`), ink);
	}

	/* ------------------------- hands and samples ----------------------- */

	readHand(version: string): Promise<HandLibrary | null> {
		return this.readJson<HandLibrary>(this.path("hands", `${version}.json`));
	}

	writeHand(library: HandLibrary): Promise<void> {
		return this.writeJson(this.path("hands", `${library.version}.json`), library);
	}

	readSamples(): Promise<SampleStore | null> {
		return this.readJson<SampleStore>(this.path("samples.json"));
	}

	writeSamples(store: SampleStore): Promise<void> {
		return this.writeJson(this.path("samples.json"), store);
	}
}
