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
import { parseLease, type SyncLease } from "./lease";
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
	/** An update in place: entry hashes of the files it writes — the notebook holds them once it landed. */
	written?: string[];
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

/** An unused file in the state folder is moved to its trash after this long unused. */
export const GC_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** What a garbage collection did: files moved to the trash, files still in their grace period. */
export interface GcResult {
	moved: string[];
	waiting: number;
	/** Set when nothing was collected because a note's file could not be read. */
	skipped?: string;
}

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
	/** Notes another copy of the vault is sending right now, as of the last load. */
	private readonly foreignPending = new Set<string>();
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
	 * The notes folder gone altogether (the state folder moved or renamed
	 * along with its parent) is not "every mapping removed": nothing is taken
	 * in then.
	 */
	async refresh(table: MappingTable): Promise<MappingTable> {
		if (this.seen.size > 0 && !(await this.fs.exists(this.path("notes")))) return table;
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
		this.foreignPending.clear();
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
			if (note?.pending !== undefined) {
				const docId = name.slice(0, -".json".length);
				this.pendingIds.add(docId);
				if (!this.ownOrStale(note.pending)) this.foreignPending.add(docId);
			}
		}
		return table;
	}

	private ownOrStale(pending: PendingSend): boolean {
		const own = this.deviceId !== undefined && pending.device === this.deviceId;
		return own || pending.device === undefined || pending.at === undefined || this.now() - pending.at > PENDING_STALE_MS;
	}

	/**
	 * Notes another copy of the vault has a send in flight for, as of the last
	 * load: not sent from here meanwhile, or both copies would write a notebook
	 * for them. Cleared once the send lands or goes stale.
	 */
	sendingElsewhere(): ReadonlySet<string> {
		return this.foreignPending;
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
	 * `previousHash`: for an update in place, the notebook's hash before it;
	 * `written`: the entry hashes of the files it writes.
	 */
	async writePending(docId: string, sent: SentRecord, mapping: MappingEntry, previousHash?: string, written?: string[]): Promise<void> {
		const note = await this.readNoteForWrite(docId);
		const pending: PendingSend = {
			sent: await this.storeSent(sent),
			mapping,
			...(previousHash === undefined ? {} : { previousHash }),
			...(written === undefined ? {} : { written }),
			...(this.deviceId === undefined ? {} : { device: this.deviceId }),
			at: this.now(),
		};
		await this.writeJson(this.noteFile(docId), { ...note, pending });
	}

	/**
	 * The upload recorded as pending was refused before it could land: the
	 * pending goes, but only while it is still the one that writes `hash`
	 * (a later send may have recorded its own since).
	 */
	async dropPending(docId: string, hash: string): Promise<void> {
		const note = await this.readNoteForWrite(docId);
		if (note.pending === undefined || note.pending.mapping.accountedHash !== hash) return;
		delete note.pending;
		if (Object.keys(note).length === 0) await this.fs.remove(this.noteFile(docId));
		else await this.writeJson(this.noteFile(docId), note);
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
	 * landed when it is listed. An update in place landed when the notebook
	 * has the hash it writes, did not when it still has the one before; at
	 * any other hash the tablet wrote since, and only the notebook's files
	 * tell: it landed when they hold one the update wrote (`entriesAt`: the
	 * entry hashes of a document at a hash). Without them, or when they
	 * cannot be read, it stays undecided until a later run. A landed send is
	 * committed, unless the note's record is from a later send already. One
	 * that did not land is dropped if it is this copy's, or stale: another
	 * copy of the vault may still be sending it. An empty listing settles
	 * nothing — more likely a fresh pairing than every upload lost. Returns
	 * `table` with the committed mappings.
	 */
	async settlePending(
		table: MappingTable,
		present: ReadonlyMap<string, string>,
		entriesAt?: (deviceDocId: string, hash: string) => Promise<ReadonlySet<string>>,
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
			if (pending === undefined) {
				this.foreignPending.delete(docId);
				continue;
			}
			const listed = present.get(pending.mapping.deviceDocId);
			let landed: boolean;
			if (listed === undefined) landed = false;
			else if (pending.previousHash === undefined || pending.mapping.accountedHash === undefined || listed === pending.mapping.accountedHash) landed = true;
			else if (listed === pending.previousHash) landed = false;
			else {
				const written = pending.written ?? [];
				if (entriesAt === undefined || written.length === 0) continue;
				try {
					const entries = await entriesAt(pending.mapping.deviceDocId, listed);
					landed = written.some((hash) => entries.has(hash));
				} catch {
					continue;
				}
			}
			if (landed) {
				this.foreignPending.delete(docId);
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
			if (!this.ownOrStale(pending)) continue;
			this.foreignPending.delete(docId);
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

	/* ------------------------------ lease ------------------------------ */

	/** Which copy of the vault syncs on its own (sync/lease.ts); a file that cannot be read counts as none. */
	async readLease(): Promise<SyncLease | null> {
		const file = this.path("lease.json");
		if (!(await this.fs.exists(file))) return null;
		try {
			return parseLease(await this.fs.read(file));
		} catch {
			return null;
		}
	}

	writeLease(lease: SyncLease): Promise<void> {
		return this.writeJson(this.path("lease.json"), lease);
	}

	/* ------------------------ garbage collection ----------------------- */

	/**
	 * Move pictures, remark strokes and learned hands nothing refers to any
	 * more into `trash/` of the state folder, once they have been unused for
	 * `graceMs` — a copy of the vault whose newer note files have not arrived
	 * yet may still need them. Never deletes. A picture is in use while any
	 * note's file names it, a send in flight included; a hand while the
	 * shared handwriting or any send uses it; remark strokes while a note
	 * embeds their image (`inkInUse`, by image file name). A note's file that
	 * cannot be read stops the whole collection: what it refers to is unknown.
	 * When each file was first seen unused is kept in `gc.json`.
	 */
	async collectGarbage(options: { inkInUse: ReadonlySet<string>; graceMs?: number }): Promise<GcResult> {
		const now = this.now();
		const grace = options.graceMs ?? GC_GRACE_MS;
		const pictures = new Set<string>();
		const hands = new Set<string>();
		const notesDir = this.path("notes");
		// Conflict copies too: the owner may still merge one back.
		for (const file of (await this.fs.exists(notesDir)) ? await this.fs.list(notesDir) : []) {
			let note: NoteFile;
			try {
				note = JSON.parse(await this.fs.read(file)) as NoteFile;
			} catch {
				return { moved: [], waiting: 0, skipped: file };
			}
			for (const sent of [note.sent, note.pending?.sent]) {
				for (const key of [...Object.values(sent?.images ?? {}), ...Object.values(sent?.drawings ?? {})]) pictures.add(key);
			}
			for (const mapping of [note.mapping, note.pending?.mapping]) if (mapping?.ink?.hand !== undefined) hands.add(mapping.ink.hand);
		}
		const handwritingFile = this.path("handwriting.json");
		if (await this.fs.exists(handwritingFile)) {
			try {
				const shared = JSON.parse(await this.fs.read(handwritingFile)) as Partial<SharedHandwriting>;
				if (typeof shared.handVersion === "string") hands.add(shared.handVersion);
			} catch {
				return { moved: [], waiting: 0, skipped: handwritingFile };
			}
		}
		const inUse: [string, ReadonlySet<string>][] = [
			["pictures", pictures],
			["ink", options.inkInUse],
			["hands", hands],
		];
		const unused: string[] = [];
		for (const [dir, used] of inUse) {
			const folder = this.path(dir);
			if (!(await this.fs.exists(folder))) continue;
			for (const file of await this.fs.list(folder)) {
				const name = file.split("/").pop() ?? file;
				if (name.endsWith(".json") && !used.has(name.slice(0, -".json".length))) unused.push(`${dir}/${name}`);
			}
		}

		const ledgerFile = this.path("gc.json");
		let before: Record<string, number> = {};
		if (await this.fs.exists(ledgerFile)) {
			try {
				before = JSON.parse(await this.fs.read(ledgerFile)) as Record<string, number>;
			} catch {
				// A damaged ledger starts over: every grace period begins again.
			}
		}
		const ledger: Record<string, number> = {};
		const moved: string[] = [];
		for (const file of unused) {
			const since = typeof before[file] === "number" ? before[file] : now;
			if (now - since < grace) {
				ledger[file] = since;
				continue;
			}
			const text = await this.fs.read(this.path(file));
			const target = this.path("trash", file);
			const folder = target.split("/").slice(0, -1).join("/");
			if (!(await this.fs.exists(folder))) await this.fs.mkdir(folder);
			await this.fs.write(target, text);
			await this.fs.remove(this.path(file));
			moved.push(file);
		}
		const changed =
			Object.keys(ledger).length !== Object.keys(before).length || Object.entries(ledger).some(([file, since]) => before[file] !== since);
		if (changed) {
			if (Object.keys(ledger).length > 0) await this.writeJson(ledgerFile, ledger);
			else await this.fs.remove(ledgerFile);
		}
		return { moved, waiting: Object.keys(ledger).length };
	}
}
