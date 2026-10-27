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

import { isValidDocId } from "../id/docid";
import { migrateMapping, type MappingEntry, type MappingTable } from "../id/mapping";
import type { HandLibrary, PendingSheet } from "../ink/handsheet";
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
	/**
	 * A send recorded before its upload: the text and the mapping it will
	 * have. Committed once the upload landed, dropped if it never did — so a
	 * crash between the two neither loses the notebook nor sends it twice.
	 */
	pending?: PendingSend;
	/**
	 * The tablet's side as the note was last merged with it since `sent`:
	 * the base of the next merge, so merging the same ink again changes
	 * nothing. A new send is a new base and clears it.
	 */
	mergedBase?: string;
}

interface PendingSend {
	sent: StoredSent;
	mapping: MappingEntry;
	/** An update in place: the notebook's hash before it, which it still has if the update never landed. */
	previousHash?: string;
	/** The vault copy that is sending, and since when (ms): another copy's send may still be on its way. */
	device?: string;
	at?: number;
}

/** A send record with its pictures replaced by references to `pictures/`. */
type StoredSent = Omit<SentRecord, "images" | "drawings"> & {
	images?: Record<string, string>;
	drawings?: Record<string, string>;
};

/**
 * A note's state file exists but cannot be read — a git or Syncthing merge
 * left conflict markers in it. Writing over it would lose half its record,
 * so the note is not synced until someone repairs the file.
 */
export class StateFileError extends Error {
	constructor(readonly path: string) {
		super(
			`The sync state file “${path}” cannot be read (a merge may have left conflict markers in it). ` +
				"Repair or remove it; this note is not synced until then.",
		);
		this.name = "StateFileError";
	}
}

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

/** A send in flight this long is no longer on its way: another copy of the vault may drop it. */
const PENDING_STALE_MS = 60 * 60 * 1000;

/** Which learned hand is in use, and the sheets waiting on the tablet. */
export interface SharedHandwriting {
	handVersion: string;
	pendingSheet: PendingSheet | null;
	pendingWordSheet: PendingSheet | null;
	pendingTestSheet: PendingSheet | null;
}

export class SyncState {
	/** Each note's mapping as last written or read, to write only what changed. */
	private readonly seen = new Map<string, string>();
	/** handwriting.json as last written or read, likewise. */
	private seenHandwriting: string | null = null;
	/** Notes whose file held a send in flight on the last load (settlePending). */
	private readonly pendingIds = new Set<string>();
	/** Files that could not be read on the last load, for the log. */
	unreadable: string[] = [];
	/** Copies a sync tool left beside a note's file on a conflict; not loaded, for the log. */
	conflictCopies: string[] = [];
	/** Note files the last saveMappings left alone because they cannot be read. */
	unwritable: string[] = [];

	constructor(
		private readonly fs: StateFs,
		readonly root: string,
		/** This copy of the vault (kept in the plugin's own data), stamped on its sends in flight. */
		readonly deviceId?: string,
		private readonly now: () => number = Date.now,
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

	/** A note's file before it is rewritten: absent is empty, unreadable stops the write. */
	private async readNoteForWrite(docId: string): Promise<NoteFile> {
		const file = this.noteFile(docId);
		if (!(await this.fs.exists(file))) return {};
		try {
			return JSON.parse(await this.fs.read(file)) as NoteFile;
		} catch {
			throw new StateFileError(file);
		}
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

	/**
	 * Write the mappings that changed since last seen; drop the ones gone from
	 * the table. A file that cannot be read is left as it is and listed in
	 * `unwritable` — it is tried again on the next save.
	 */
	async saveMappings(table: MappingTable): Promise<void> {
		this.unwritable = [];
		for (const [docId, mapping] of Object.entries(table)) {
			const text = JSON.stringify(mapping);
			if (this.seen.get(docId) === text) continue;
			let note: NoteFile;
			try {
				note = await this.readNoteForWrite(docId);
			} catch (error) {
				if (!(error instanceof StateFileError)) throw error;
				this.unwritable.push(error.path);
				continue;
			}
			await this.writeJson(this.noteFile(docId), { ...note, mapping });
			this.seen.set(docId, text);
		}
		for (const docId of [...this.seen.keys()]) {
			if (table[docId] !== undefined) continue;
			const file = this.noteFile(docId);
			let note: NoteFile;
			try {
				note = await this.readNoteForWrite(docId);
			} catch (error) {
				if (!(error instanceof StateFileError)) throw error;
				this.unwritable.push(error.path);
				continue;
			}
			// A send in flight keeps its file: settlePending decides about it.
			if (note.pending !== undefined) {
				delete note.mapping;
				await this.writeJson(file, note);
			} else if (await this.fs.exists(file)) {
				await this.fs.remove(file);
			}
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

	/**
	 * Only `<docId>.json` is a note's file. What a sync tool leaves beside it
	 * on a conflict — Syncthing's `.sync-conflict-…`, git's or Obsidian Sync's
	 * `(conflict…)`, a merge's `.orig` — is listed for the owner instead: read
	 * as a note it would bring back an old mapping.
	 */
	private async loadMappingsRaw(): Promise<MappingTable> {
		this.unreadable = [];
		this.conflictCopies = [];
		this.pendingIds.clear();
		const table: MappingTable = {};
		const dir = this.path("notes");
		if (!(await this.fs.exists(dir))) return table;
		for (const file of await this.fs.list(dir)) {
			const name = file.split("/").pop() ?? file;
			if (!name.endsWith(".json") || !isValidDocId(name.slice(0, -".json".length))) {
				if (/\.sync-conflict-|\(conflict|\.orig$/i.test(name)) this.conflictCopies.push(file);
				continue;
			}
			const note = await this.readJson<NoteFile>(file);
			if (note?.mapping !== undefined) table[note.mapping.docId] = migrateMapping(note.mapping);
			if (note?.pending !== undefined) this.pendingIds.add(name.slice(0, -".json".length));
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

	private async storeSent(sent: SentRecord): Promise<StoredSent> {
		const stored: StoredSent = {
			...sent,
			images: await this.storePictures<Picture>(sent.images),
			drawings: await this.storePictures<InkDrawing>(sent.drawings),
		};
		// Kept beside the send, not in it (writeMergedBase).
		delete stored.mergedBase;
		return stored;
	}

	/** Keep a send record outright (the one-time move from the plugin folder). */
	async writeSent(docId: string, sent: SentRecord): Promise<void> {
		const note = await this.readNoteForWrite(docId);
		delete note.mergedBase;
		await this.writeJson(this.noteFile(docId), { ...note, sent: await this.storeSent(sent) });
	}

	/** Record what the note was just merged with (NoteFile.mergedBase). */
	async writeMergedBase(docId: string, text: string): Promise<void> {
		const note = await this.readNoteForWrite(docId);
		await this.writeJson(this.noteFile(docId), { ...note, mergedBase: text });
	}

	/**
	 * Record a send about to be uploaded, beside the committed one: the merge
	 * base stays what the tablet holds until the upload has landed.
	 * `previousHash`: for an update in place, the notebook's hash before it.
	 */
	async writePending(docId: string, sent: SentRecord, mapping: MappingEntry, previousHash?: string): Promise<void> {
		const note = await this.readNoteForWrite(docId);
		const pending: PendingSend = {
			sent: await this.storeSent(sent),
			mapping,
			...(previousHash === undefined ? {} : { previousHash }),
			...(this.deviceId === undefined ? {} : { device: this.deviceId }),
			at: this.now(),
		};
		await this.writeJson(this.noteFile(docId), { ...note, pending });
	}

	/** The upload landed: its text and mapping become the note's, in one write. */
	async commitSent(docId: string, sent: SentRecord, mapping: MappingEntry): Promise<void> {
		const note = await this.readNoteForWrite(docId);
		delete note.pending;
		delete note.mergedBase;
		await this.writeJson(this.noteFile(docId), { ...note, sent: await this.storeSent(sent), mapping });
		this.seen.set(docId, JSON.stringify(mapping));
	}

	/**
	 * Settle sends a crash left half-done against the account listing
	 * (`present`: device document id → root entry hash). A new notebook
	 * landed when it is listed. An update in place (its mapping names the
	 * hash it writes) landed when the notebook has that hash — or any hash but
	 * the one it had before: written on since. A landed send is committed,
	 * unless the note's record is from a later send already. One that did not
	 * land is dropped if it is this copy's, or stale: another copy of the vault
	 * may still be sending it. An empty listing settles nothing — more likely
	 * a fresh pairing than every upload lost. Returns `table` with the
	 * committed mappings.
	 */
	async settlePending(
		table: MappingTable,
		present: ReadonlyMap<string, string>,
	): Promise<{ table: MappingTable; committed: string[]; dropped: string[] }> {
		const out = { table: { ...table }, committed: [] as string[], dropped: [] as string[] };
		if (present.size === 0) return out;
		for (const docId of [...this.pendingIds]) {
			let note: NoteFile;
			try {
				note = await this.readNoteForWrite(docId);
			} catch {
				continue;
			}
			const { pending, ...rest } = note;
			this.pendingIds.delete(docId);
			if (pending === undefined) continue;
			const listed = present.get(pending.mapping.deviceDocId);
			const landed =
				listed !== undefined &&
				(pending.mapping.accountedHash === undefined ||
					listed === pending.mapping.accountedHash ||
					listed !== pending.previousHash);
			if (landed) {
				if (rest.mapping !== undefined && rest.mapping.uploadedAt > pending.mapping.uploadedAt) {
					await this.writeJson(this.noteFile(docId), rest);
					out.dropped.push(docId);
					continue;
				}
				delete rest.mergedBase;
				await this.writeJson(this.noteFile(docId), { ...rest, sent: pending.sent, mapping: pending.mapping });
				this.seen.set(docId, JSON.stringify(pending.mapping));
				out.table[docId] = pending.mapping;
				out.committed.push(docId);
				continue;
			}
			const own = this.deviceId !== undefined && pending.device === this.deviceId;
			const stale = pending.device === undefined || pending.at === undefined || this.now() - pending.at > PENDING_STALE_MS;
			if (!own && !stale) continue;
			// A first send that never landed leaves nothing behind.
			if (Object.keys(rest).length === 0) await this.fs.remove(this.noteFile(docId));
			else await this.writeJson(this.noteFile(docId), rest);
			out.dropped.push(docId);
		}
		return out;
	}

	async readSent(docId: string): Promise<SentRecord | null> {
		const note = await this.readJson<NoteFile>(this.noteFile(docId));
		if (note?.sent === undefined) return null;
		return {
			...note.sent,
			images: await this.loadPictures<Picture>(note.sent.images),
			drawings: await this.loadPictures<InkDrawing>(note.sent.drawings),
			...(note.mergedBase === undefined ? {} : { mergedBase: note.mergedBase }),
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

	async readHandwriting(): Promise<SharedHandwriting | null> {
		const read = await this.readJson<Partial<SharedHandwriting>>(this.path("handwriting.json"));
		if (read === null) return null;
		// Written before the test sheet existed: none is waiting.
		const shared = { ...read, pendingTestSheet: read.pendingTestSheet ?? null } as SharedHandwriting;
		this.seenHandwriting = JSON.stringify(shared);
		return shared;
	}

	/** Written only when it changed here, so a copy never undoes another's newer hand. */
	async saveHandwriting(shared: SharedHandwriting): Promise<void> {
		const text = JSON.stringify(shared);
		if (text === this.seenHandwriting) return;
		await this.writeJson(this.path("handwriting.json"), shared);
		this.seenHandwriting = text;
	}

	readSamples(): Promise<SampleStore | null> {
		return this.readJson<SampleStore>(this.path("samples.json"));
	}

	writeSamples(store: SampleStore): Promise<void> {
		return this.writeJson(this.path("samples.json"), store);
	}
}
