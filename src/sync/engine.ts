/**
 * The sync engine: one run of the round trip, behind ports so it runs the
 * same against Obsidian and the reMarkable cloud as against the in-memory
 * stand-ins of the tests.
 *
 * A run first brings notes and notebooks together (sync/reconcile.ts):
 * renames, moves, deletes and restores on either side, metadata only. Then
 * the content: every notebook with new ink is read and merged into its note,
 * notebooks started on the tablet are brought in, and every note that is new
 * or changed is sent. Each step writes its record as soon as it is done, so a
 * run that stops anywhere is picked up by the next one, which plans again
 * from what both sides look like then.
 */

import { duplicateIdLosers, generateDocId } from "../id/docid";
import type { MappingEntry, MappingTable } from "../id/mapping";
import type { EmbedContent } from "../preprocess/preprocess";
import { NotebookChangedError, NotebookGoneError } from "../transport/notebook";
import type { DeviceItem } from "./deviceimport";
import type { PushWork } from "./queues";
import {
	baseName,
	folderOf,
	foreignListing,
	inTrash,
	mirroredDevicePath,
	mirroredVaultFolder,
	plan,
	vanishedAtOnce,
	vanishedIds,
	VANISH_SETTLE_MS,
	VANISH_SETTLE_RUNS,
	type VanishedNotes,
	type Action,
	type RecordPatch,
	type ReconcilePolicy,
	type VaultNote,
} from "./reconcile";
import { optedOut, relativeFolderPath } from "./selection";
import { PENDING_STALE_MS } from "./syncstate";
import { devicePathOf } from "../transport/metadata";
import { notesNeedingUpload, sendBatch, type NoteInput, type SendDeps, type SendResult } from "./send";
import { mergeTags, normalTags, sameTags } from "./tags";
import { isInWatchFolder } from "./watcher";

export interface VaultPort {
	/** Every markdown note with the document id in its frontmatter — read from the file where a cache lags. */
	notes(): Promise<(VaultNote & { ctime?: number })[]>;
	/** Rename/move a note, its links following; missing folders are made, a taken path gets a number. Resolves to the path used. */
	move(from: string, to: string): Promise<string>;
	/** Write (or, with null, remove) the document id in a note's frontmatter. */
	setDocId(path: string, docId: string | null): Promise<void>;
	/** Write (true) or remove (false) the opt-out in a note's frontmatter (selection.ts OPT_OUT_FRONTMATTER_KEY). */
	setOptOut(path: string, optOut: boolean): Promise<void>;
	/** Replace a note's frontmatter `tags` (none: the key goes). */
	setTags(path: string, tags: readonly string[]): Promise<void>;
	/** Whether the note with this document id was seen deleted (a vault event): taken as deleted at once, not one sync later. */
	deleted?(docId: string): boolean;
	/** The note as a send reads it, its embeds resolved; null when it is not there. */
	load(path: string): Promise<{ note: NoteInput; resolveEmbed: (linkpath: string) => EmbedContent } | null>;
}

export interface CloudPort {
	/** Every document and folder on the account, trashed ones included (transport/metadata.ts readListing). */
	listing(): Promise<DeviceItem[]>;
	/** The device folder at `path`, made where missing; folders made are added to `listing`. */
	ensureFolder(path: string, listing: DeviceItem[]): Promise<string>;
	/** Rename/move a document while its hash is `expectedHash`; resolves to its new hash. */
	editMetadata(deviceDocId: string, expectedHash: string, update: { visibleName?: string; parent?: string }): Promise<string>;
	/** A document's tags at root entry hash `hash` (transport/metadata.ts readTags). */
	readTags(deviceDocId: string, hash: string): Promise<string[]>;
	/** Set a document's tags while its hash is `expectedHash`; resolves to its new hash. */
	editTags(deviceDocId: string, expectedHash: string, tags: readonly string[]): Promise<string>;
	uploadInk: SendDeps["client"]["uploadInk"];
	updateInk?: SendDeps["client"]["updateInk"];
}

export interface RecordStore {
	get(): MappingTable;
	/** Replace the records and persist them before resolving. */
	set(table: MappingTable): Promise<void>;
	/** Take in records another copy of the vault wrote since. */
	refresh(): Promise<void>;
	/** Settle sends a crash left half-done against the listing (id → hash); resolves to lines for the log. */
	settle(present: ReadonlyMap<string, string>): Promise<string[]>;
	persistPending?: SendDeps["ink"]["persistPending"];
	commitSent?: SendDeps["ink"]["commitSent"];
	/** Notes another copy of the vault is sending right now (SyncState.sendingElsewhere): not sent from here meanwhile. */
	sendingElsewhere?(): ReadonlySet<string>;
	/** A send recorded as pending was refused before it could land (SyncState.dropPending). */
	dropPending?: SendDeps["ink"]["dropPending"];
}

export interface ContentPort {
	/**
	 * Read these notebooks and merge their new ink into the notes. `nested`:
	 * called from inside a cloud write of this run, so it must not queue.
	 */
	pull: (docIds: string[], options: { background?: boolean; nested?: boolean }) => Promise<{ changed: Set<string>; unread: Map<string, string> }>;
	/**
	 * A notebook brought in from the tablet (format "device") that changed
	 * since: its pages read again and merged into the note. Resolves to
	 * whether the note changed; throws when it could not be read.
	 */
	reimport(docId: string): Promise<boolean>;
	/** Bring notebooks started on the tablet into the vault; resolves to the new notes' paths. */
	importNew(listing: DeviceItem[], background: boolean): Promise<string[]>;
}

export interface SendPorts {
	render: SendDeps["ink"]["render"];
	loadImages?: SendDeps["ink"]["loadImages"];
	loadDrawings?: SendDeps["ink"]["loadDrawings"];
	renderTyped?: SendDeps["ink"]["renderTyped"];
	notebookMode?: SendDeps["notebookMode"];
	/** Ready what every send of the batch needs (the learned hand). */
	prepare?(): Promise<void>;
	layout?: SendDeps["layout"];
	frontmatterAsTitleBlock?: boolean;
	progress?(done: number, total: number): void;
	/** Show what the batch did; `failure`: the batch could not run at all. */
	report(results: SendResult[], options: { auto: boolean; background: boolean; failure?: string }): Promise<void>;
}

export interface EnginePolicy extends ReconcilePolicy {
	/** Vault folders whose notes are all kept in sync; empty when off. */
	syncFolders: string[];
	/** Folders inside the sync folders that are the plugin's own (backups). */
	excludeFolders: string[];
}

export interface EnginePorts {
	vault: VaultPort;
	cloud: CloudPort;
	records: RecordStore;
	content: ContentPort;
	send: SendPorts;
	policy(): EnginePolicy;
	log: (line: string) => void;
	/**
	 * A step that could not run at all (the account could not be listed, a
	 * cloud call failed): the run's failure, for the caller to count and
	 * show. Logged as a line when absent.
	 */
	failed?: (what: string, error: unknown) => void;
	/** Run a send in the shared cloud lane (sync/queues.ts PushQueue); run directly when absent. */
	push?: (work: PushWork) => Promise<void>;
	/** The clock (epoch ms); Date.now when absent. */
	now?: () => number;
	/**
	 * Notes vanished at once as the last runs saw them, kept with this copy's
	 * own data (not the shared state: it is about this copy's vault). Absent:
	 * such notes are never taken as deleted.
	 */
	vanished?: { get(): VanishedNotes | null; set(seen: VanishedNotes | null): Promise<void> };
}

export interface SendOptions {
	/** Skip notes whose notebook is up to date (sync folders, a sync run). */
	auto?: boolean;
	background?: boolean;
	/** Read the notes' notebooks first (default); a sync run already did. */
	pullFirst?: boolean;
	/** With `pullFirst: false`: the notebooks that could not be read, by note docId. */
	unread?: ReadonlyMap<string, string>;
	/** Bring names and folders together first (default); a sync run already did. */
	reconcile?: boolean;
	/** "Sync folder" with mirroring off: the folder keeps its own tree below the device root. */
	structureRoot?: string;
	/** The owner asked for these notes by hand: an opt-out in their frontmatter goes first. */
	optIn?: boolean;
}

const isActive = (entry: MappingEntry | undefined): entry is MappingEntry =>
	entry !== undefined && entry.state !== "archived" && (entry.format === "ink" || entry.format === "device");

function patched(entry: MappingEntry, patch: RecordPatch): MappingEntry {
	const next: Record<string, unknown> = { ...entry, ...patch };
	for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
	return next as unknown as MappingEntry;
}

export class SyncEngine {
	/** Notes this engine held back from a send, with why (SyncEngine.send). */
	readonly held = new Map<string, string>();
	/** Notes this engine's sends looked at; every note once `fullRun` (a sync). */
	readonly covered = new Set<string>();
	fullRun = false;
	/**
	 * Notes whose rename, move or archive failed in this engine's run: a send
	 * now would record the note's name and place as the notebook's while the
	 * notebook still has the old ones, and the change would never follow.
	 */
	private readonly unsettled = new Set<string>();

	constructor(private readonly ports: EnginePorts) {}

	private async update(docId: string, patch: RecordPatch): Promise<void> {
		const table = this.ports.records.get();
		const entry = table[docId];
		if (entry === undefined) return;
		await this.ports.records.set({ ...table, [docId]: patched(entry, patch) });
	}

	/**
	 * The tags a record keeps through a send. A new notebook starts without
	 * tags, so the note's count as added to it; one written in place keeps
	 * its tags, still known at the new hash when they were at the old one.
	 */
	private tagsAfterSend(previous: MappingEntry | undefined, entry: MappingEntry): RecordPatch {
		if (entry.tags !== undefined) return {};
		if (previous === undefined || previous.deviceDocId !== entry.deviceDocId) return { tags: [], tagsHash: entry.accountedHash };
		if (previous.tags === undefined) return {};
		return {
			tags: previous.tags,
			tagsHash: previous.tagsHash !== undefined && previous.tagsHash === previous.accountedHash ? entry.accountedHash : previous.tagsHash,
		};
	}

	/**
	 * Whether a note waits instead of being sent: another copy of the vault
	 * is sending it right now, or another copy sent it and its record has not
	 * arrived — the note has a document id this copy has no record of, and a
	 * notebook of its name no record knows, made within the last
	 * PENDING_STALE_MS, is on the account (an older one is the owner's own,
	 * or one kept after "Stop syncing"; a send asked for by hand, `optIn`,
	 * goes ahead regardless); or its notebook is in the trash without the
	 * lifecycle having archived it, replaced by another copy's send
	 * (sync/reconcile.ts plan). Sending it now would put a second notebook
	 * beside that one.
	 */
	private heldBack(note: NoteInput, listing: readonly DeviceItem[], optIn: boolean): boolean {
		const docId = note.existingDocId;
		if (typeof docId !== "string") return false;
		const record = this.ports.records.get()[docId];
		if (this.unsettled.has(docId) || (isActive(record) && record.notePath !== note.path)) {
			this.held.set(note.path, "its notebook's name or folder could not be brought along yet");
			return true;
		}
		if (this.ports.records.sendingElsewhere?.().has(docId) === true) {
			this.held.set(note.path, "another copy of the vault is sending it right now");
			return true;
		}
		const byId = new Map(listing.map((item) => [item.id, item]));
		const current = isActive(record) ? byId.get(record.deviceDocId) : undefined;
		if (current !== undefined && inTrash(current.parent, byId)) {
			this.held.set(note.path, "its notebook was replaced on the reMarkable by a send from another copy of the vault, whose sync state has not arrived yet");
			return true;
		}
		const table = this.ports.records.get();
		if (table[docId] !== undefined || optIn) return false;
		const known = new Set(Object.values(table).map((entry) => entry.deviceDocId));
		// Another copy sent it where the note's folder mirrors; one elsewhere is the owner's own.
		const { baseFolder } = this.ports.policy();
		const now = (this.ports.now ?? Date.now)();
		const stranger = listing.find(
			(item) =>
				item.type === "DocumentType" &&
				item.visibleName === note.basename &&
				!known.has(item.id) &&
				!inTrash(item.parent, byId) &&
				now - Number(item.createdTime ?? item.lastModified) < PENDING_STALE_MS &&
				(baseFolder === null || mirroredVaultFolder(item.parent, byId, baseFolder) === folderOf(note.path)),
		);
		if (stranger === undefined) return false;
		this.held.set(note.path, `notebook “${stranger.visibleName}” on the reMarkable may be this note, sent from another copy of the vault whose sync state has not arrived yet`);
		return true;
	}

	/**
	 * Give every copy of a note its own document id before anything is
	 * planned or sent: Obsidian's "Make a copy" duplicates the id, and the
	 * copy would take over the original's notebook. Looks at the whole vault,
	 * not only the notes about to be sent. Resolves to the notes as they are
	 * after.
	 */
	private async splitCopies(): Promise<VaultNote[]> {
		const notes = await this.ports.vault.notes();
		const table = this.ports.records.get();
		const losers = duplicateIdLosers(
			notes.map((note) => ({ path: note.path, docId: note.docId, ctime: note.ctime ?? 0 })),
			(docId) => table[docId]?.notePath,
		);
		if (losers.length === 0) return notes;
		const renewed = new Map<string, string>();
		for (const path of losers) {
			const docId = generateDocId();
			await this.ports.vault.setDocId(path, docId);
			renewed.set(path, docId);
			this.ports.log(`“${path}” shared its document id with another note (a copy?); it now has its own and gets a notebook of its own`);
		}
		return notes.map((note) => (renewed.has(note.path) ? { ...note, docId: renewed.get(note.path) } : note));
	}

	/**
	 * Bring notes and notebooks together: renames, moves, deletes and
	 * restores from either side (sync/reconcile.ts). Resolves to the account
	 * listing as it is after (null when it could not be read), and whether it
	 * is another account's (`foreign`): then nothing should be sent either.
	 */
	async reconcile(): Promise<{ listing: DeviceItem[] | null; notes: VaultNote[]; foreign: boolean }> {
		this.unsettled.clear();
		await this.ports.records.refresh();
		let listing: DeviceItem[] | null = null;
		try {
			listing = await this.ports.cloud.listing();
		} catch (error) {
			this.fail("could not list the reMarkable account", error);
		}
		if (listing !== null) {
			for (const line of await this.ports.records.settle(new Map(listing.map((item) => [item.id, item.hash])))) {
				this.ports.log(line);
			}
		}
		let notes = await this.splitCopies();
		const records = this.ports.records.get();
		const foreign = foreignListing(records, listing);
		if (foreign) {
			this.fail(
				"none of the synced notes' notebooks are on this reMarkable account",
				new Error("Another account or endpoint? Nothing is archived or sent until the notebooks are found again — switch back, or start over with a fresh sync state."),
			);
		}
		const deleted = this.ports.vault.deleted?.bind(this.ports.vault);
		const settled = await this.vanishSettled(records, notes, deleted);
		const actions = plan(records, notes, listing, this.ports.policy(), deleted, settled);
		// A note's later actions build on its earlier ones: after one fails, the next run plans again from what is there.
		const failed = new Set<string>();
		for (const action of actions) {
			if (failed.has(action.docId)) continue;
			if (!(await this.execute(action, listing ?? []))) failed.add(action.docId);
		}
		for (const docId of failed) this.unsettled.add(docId);
		if (actions.some((action) => action.kind === "move-note")) notes = await this.ports.vault.notes();
		return { listing, notes, foreign };
	}

	private fail(what: string, error: unknown): void {
		if (this.ports.failed !== undefined) this.ports.failed(what, error);
		else this.ports.log(`${what}: ${error instanceof Error ? error.message : String(error)}`);
	}

	/**
	 * Most synced notes missing from the vault at once (vanishedAtOnce): a
	 * vault still arriving, until the same notes stayed away for
	 * VANISH_SETTLE_RUNS runs and VANISH_SETTLE_MS — then the owner deleted
	 * them while Obsidian was closed, and they are taken as deleted (their
	 * notebooks go to the tablet's trash only while unchanged since read).
	 * Resolves to whether that point is reached; logs once per change.
	 */
	private async vanishSettled(records: MappingTable, notes: VaultNote[], deleted: ((docId: string) => boolean) | undefined): Promise<boolean> {
		const store = this.ports.vanished;
		const last = store?.get() ?? null;
		if (notes.length === 0 || !vanishedAtOnce(records, notes, deleted)) {
			if (last !== null) await store?.set(null);
			return false;
		}
		const ids = vanishedIds(records, notes, deleted);
		const now = (this.ports.now ?? Date.now)();
		const seen: VanishedNotes =
			last !== null && last.ids.join("\n") === ids.join("\n") ? { ...last, runs: last.runs + 1 } : { ids, since: now, runs: 1, settled: false };
		if (store !== undefined && !seen.settled && seen.runs >= VANISH_SETTLE_RUNS && now - seen.since >= VANISH_SETTLE_MS) {
			seen.settled = true;
			this.ports.log(`${ids.length} synced notes stayed away from the vault since ${new Date(seen.since).toISOString().slice(0, 16).replace("T", " ")} — taken as deleted now`);
		} else if (seen.runs === 1) {
			this.ports.log(
				`${ids.length} synced notes are not in the vault (still arriving on this device?) — none is taken as deleted for now` +
					(store === undefined ? "" : "; if they stay away, they are after a while"),
			);
		}
		await store?.set(seen);
		return seen.settled;
	}

	/** Carry out one action; resolves to whether it was done. */
	private async execute(action: Action, listing: DeviceItem[]): Promise<boolean> {
		const { cloud, vault, log } = this.ports;
		try {
			switch (action.kind) {
				case "record":
					await this.update(action.docId, action.patch);
					break;
				case "edit-notebook": {
					const policy = this.ports.policy();
					const parent =
						action.folder !== undefined && policy.baseFolder !== null
							? await cloud.ensureFolder(mirroredDevicePath(action.folder, policy.baseFolder), listing)
							: action.parent;
					const item = listing.find((entry) => entry.id === action.deviceDocId);
					const visibleName = action.visibleName ?? item?.visibleName;
					const update = {
						...(action.visibleName === undefined ? {} : { visibleName: action.visibleName }),
						...(parent === undefined || parent === item?.parent ? {} : { parent }),
					};
					let hash = action.expectedHash;
					const left = item?.parent;
					if (Object.keys(update).length > 0) hash = await cloud.editMetadata(action.deviceDocId, action.expectedHash, update);
					if (item !== undefined) Object.assign(item, { hash, ...update });
					if (update.parent !== undefined && left !== undefined && left !== "" && !listing.some((one) => one.parent === left)) {
						const byId = new Map(listing.map((one) => [one.id, one]));
						const path = devicePathOf(left, byId);
						if (path !== null) log(`device folder “${path}” is empty now; it is left on the reMarkable`);
					}
					const entry = this.ports.records.get()[action.docId];
					const newParent = parent ?? item?.parent;
					const devicePath = newParent === undefined ? null : devicePathOf(newParent, new Map(listing.map((one) => [one.id, one])));
					await this.update(action.docId, {
						...action.patch,
						deviceName: visibleName,
						deviceParent: newParent,
						devicePath: devicePath ?? undefined,
						// Ink the note does not have yet stays unaccounted for: the read after this takes it in.
						accountedHash: entry?.accountedHash === action.expectedHash ? hash : entry?.accountedHash,
						// Name and folder are not tags: tags known at the old hash still hold.
						tagsHash: entry?.tagsHash === action.expectedHash ? hash : entry?.tagsHash,
					});
					break;
				}
				case "move-note": {
					const path = await vault.move(action.from, action.to);
					await this.update(action.docId, { ...action.patch, notePath: path });
					break;
				}
				case "trash-notebook": {
					const hash = await cloud.editMetadata(action.deviceDocId, action.expectedHash, { parent: "trash" });
					const item = listing.find((entry) => entry.id === action.deviceDocId);
					if (item !== undefined) Object.assign(item, { hash, parent: "trash" });
					await this.update(action.docId, { state: "archived", archivedFrom: undefined, accountedHash: hash, noteMissing: undefined });
					break;
				}
				case "archive-note": {
					if (action.readFirst) {
						let reason: string | undefined;
						if (this.ports.records.get()[action.docId]?.format === "device") {
							await this.ports.content.reimport(action.docId).catch((error: unknown) => {
								reason = error instanceof Error ? error.message : String(error);
							});
						} else {
							const { unread } = await this.ports.content.pull([action.docId], { nested: true, background: true });
							reason = unread.get(action.docId);
						}
						if (reason !== undefined) log(`${action.from}: the trashed notebook's new ink could not be read (${reason}); it stays in the notebook`);
					}
					const path = action.from === action.to ? action.from : await vault.move(action.from, action.to);
					await this.update(action.docId, { state: "archived", archivedFrom: action.archivedFrom, notePath: path, unappliedHash: undefined, noteMissing: undefined });
					break;
				}
			}
		} catch (error) {
			if (error instanceof NotebookChangedError) {
				log(`${action.docId}: its notebook changed on the reMarkable meanwhile — left for the next sync`);
			} else if (error instanceof NotebookGoneError) {
				log(`${action.docId}: its notebook is no longer on the reMarkable — left for the next sync`);
			} else {
				log(`${action.docId}: ${action.kind} failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			return false;
		}
		if ("log" in action && action.log !== undefined) log(action.log);
		return true;
	}

	/**
	 * The whole round trip: lifecycle, then tags both ways, every notebook
	 * with new ink read into its note, notebooks started on the tablet
	 * brought in, and every note that is new or out of date sent. A note
	 * opted out in its frontmatter is left alone.
	 */
	async sync(options: { background?: boolean } = {}): Promise<void> {
		const background = options.background === true;
		this.fullRun = true;
		const { listing, notes, foreign } = await this.reconcile();
		if (foreign) return;
		const table = this.ports.records.get();
		const kept = notes.filter((note) => note.docId !== undefined && note.optOut !== true);
		const noteOf = new Map(kept.map((note) => [note.docId, note]));
		const byId = new Map((listing ?? []).map((item) => [item.id, item]));
		const live = (entry: MappingEntry): DeviceItem | undefined => {
			const item = byId.get(entry.deviceDocId);
			return item === undefined || inTrash(item.parent, byId) ? undefined : item;
		};
		// Only notes that are there with notebooks that are there: anything else the lifecycle has dealt with.
		const synced = Object.values(table).filter(
			(entry) => isActive(entry) && noteOf.has(entry.docId) && (listing === null || live(entry) !== undefined),
		);
		// Before the read: it takes the notebook's new hash as read, and tags changed on the tablet would go unseen.
		if (listing !== null) {
			await this.syncTags(
				synced.flatMap((entry) => {
					const item = live(entry);
					const note = noteOf.get(entry.docId);
					return item === undefined || item.unreadable === true || note === undefined ? [] : [{ docId: entry.docId, note, item }];
				}),
			);
		}
		const { changed, unread } = await this.ports.content.pull(
			synced.filter((entry) => entry.format === "ink").map((entry) => entry.docId),
			{ background },
		);
		const unreadAll = new Map(unread);
		for (const entry of synced) {
			const latest = this.ports.records.get()[entry.docId] ?? entry;
			if (entry.format !== "device" || live(entry)?.hash === latest.accountedHash) continue;
			try {
				if (await this.ports.content.reimport(entry.docId)) changed.add(noteOf.get(entry.docId)?.path ?? entry.notePath);
			} catch (error) {
				unreadAll.set(entry.docId, error instanceof Error ? error.message : String(error));
			}
		}
		if (listing !== null) {
			for (const path of await this.ports.content.importNew(listing, background)) changed.add(path);
		}

		const policy = this.ports.policy();
		const current = this.ports.records.get();
		const paths = new Set<string>();
		const after = await this.ports.vault.notes();
		for (const note of after) {
			const record = note.docId === undefined ? undefined : current[note.docId];
			if (record?.state === "archived" || note.optOut === true) continue;
			const inSyncFolder =
				policy.syncFolders.some((folder) => isInWatchFolder(note.path, folder)) &&
				!policy.excludeFolders.some((folder) => isInWatchFolder(note.path, folder));
			if (inSyncFolder || isActive(record) || changed.has(note.path)) paths.add(note.path);
		}
		if (paths.size === 0) return;
		await this.send([...paths], { auto: true, pullFirst: false, reconcile: false, background, unread: unreadAll });

		// A fresh notebook starts without tags, a note brought in this run has none recorded: settled now, not one sync later.
		const fresh = Object.values(this.ports.records.get()).filter(
			(entry): entry is MappingEntry & { accountedHash: string } =>
				isActive(entry) &&
				entry.accountedHash !== undefined &&
				(entry.tags === undefined || entry.tagsHash === entry.accountedHash) &&
				current[entry.docId]?.accountedHash !== entry.accountedHash,
		);
		if (fresh.length === 0) return;
		const noteNow = new Map((await this.ports.vault.notes()).filter((note) => note.optOut !== true).map((note) => [note.docId, note]));
		await this.syncTags(
			fresh.flatMap((entry) => {
				const note = noteNow.get(entry.docId);
				return note === undefined ? [] : [{ docId: entry.docId, note, item: { hash: entry.accountedHash } }];
			}),
		);
	}

	/**
	 * Bring each note's frontmatter tags and its notebook's tags together
	 * (sync/tags.ts): what either side added since the tags last agreed is
	 * added to the other, what either removed is removed. The tablet's tags
	 * are read only when its hash moved since. A notebook that changed
	 * meanwhile is left for the next sync. `item`: the notebook as listed,
	 * its hash moved along when the tags are written.
	 */
	private async syncTags(notes: { docId: string; note: VaultNote; item: { hash: string } }[]): Promise<void> {
		const { cloud, vault } = this.ports;
		for (const { docId, note, item } of notes) {
			const entry = this.ports.records.get()[docId];
			if (entry === undefined) continue;
			const vaultTags = normalTags(note.tags ?? []);
			const known = entry.tags !== undefined && entry.tagsHash === item.hash;
			if (known && sameTags(vaultTags, entry.tags ?? [])) continue;
			try {
				const tablet = known ? (entry.tags ?? []) : normalTags(await cloud.readTags(entry.deviceDocId, item.hash));
				const merged = mergeTags(entry.tags, vaultTags, tablet);
				const hash = sameTags(merged, tablet) ? item.hash : await cloud.editTags(entry.deviceDocId, item.hash, merged);
				const was = item.hash;
				item.hash = hash;
				if (!sameTags(merged, vaultTags)) await vault.setTags(note.path, merged);
				const latest = this.ports.records.get()[docId] ?? entry;
				if (latest.tags !== undefined && sameTags(latest.tags, merged) && latest.tagsHash === hash) continue;
				await this.update(docId, {
					tags: merged,
					tagsHash: hash,
					// Only the tags changed: a notebook read up to the write stays read.
					accountedHash: latest.accountedHash === was ? hash : latest.accountedHash,
				});
			} catch (error) {
				if (error instanceof NotebookChangedError || error instanceof NotebookGoneError) continue;
				this.fail(`${note.path}: its tags could not be synced`, error);
			}
		}
	}

	/**
	 * Send notes as handwritten notebooks. A note that has a notebook gets it
	 * read first, so ink not yet in the note is merged before the notebook is
	 * rewritten; one whose notebook could not be read is held back. With
	 * `auto`, unchanged notes are skipped. Archived notes are never sent, nor
	 * notes opted out in their frontmatter — unless `optIn` lifts it first.
	 * Held back too: a note another copy of the vault is sending right now,
	 * and one with a document id this copy has no record of while a notebook
	 * of its name that no record knows is on the account — another copy's
	 * send whose state has not arrived yet (`held`).
	 */
	async send(paths: string[], options: SendOptions = {}): Promise<void> {
		const { vault, records, content, cloud } = this.ports;
		const auto = options.auto === true;
		const background = options.background === true;
		for (const path of paths) this.covered.add(path);
		if (options.reconcile !== false && (await this.reconcile()).foreign) {
			if (!background) await this.ports.send.report([], { auto, background, failure: "None of the synced notes' notebooks are on this reMarkable account." });
			return;
		}
		let unread: ReadonlyMap<string, string> = options.unread ?? new Map<string, string>();
		const loaded = new Map<string, { note: NoteInput; resolveEmbed: (linkpath: string) => EmbedContent }>();
		const load = async () => {
			loaded.clear();
			for (const path of paths) {
				const one = await vault.load(path);
				if (one !== null) loaded.set(path, one);
			}
		};
		await load();
		if (options.optIn === true) {
			const lifted = [...loaded.values()].filter(({ note }) => optedOut(note.content));
			for (const { note } of lifted) await vault.setOptOut(note.path, false);
			if (lifted.length > 0) await load();
		}
		const recordOf = (note: NoteInput) => (typeof note.existingDocId === "string" ? records.get()[note.existingDocId] : undefined);
		if (options.pullFirst !== false) {
			const synced = [...loaded.values()].map(({ note }) => recordOf(note)).filter(isActive);
			const ink = synced.filter((entry) => entry.format === "ink").map((entry) => entry.docId);
			if (ink.length > 0) unread = (await content.pull(ink, { background: true })).unread;
			const failed = new Map(unread);
			for (const entry of synced.filter((one) => one.format === "device")) {
				await content.reimport(entry.docId).catch((error: unknown) => {
					failed.set(entry.docId, error instanceof Error ? error.message : String(error));
				});
			}
			unread = failed;
			await load();
		}
		await records.refresh();
		const resolveEmbed = (linkpath: string, notePath: string): EmbedContent =>
			loaded.get(notePath)?.resolveEmbed(linkpath) ?? { kind: "missing" };
		let notes = [...loaded.values()]
			.map(({ note }) => note)
			.filter((note) => recordOf(note)?.state !== "archived" && !optedOut(note.content));
		if (notes.length === 0) {
			if (!background) await this.ports.send.report([], { auto, background, failure: "No markdown notes to send." });
			return;
		}
		if (auto) {
			try {
				notes = notesNeedingUpload(notes, records.get(), resolveEmbed, this.ports.send.frontmatterAsTitleBlock, this.ports.send.notebookMode);
			} catch (error) {
				await this.ports.send.report([], { auto, background, failure: error instanceof Error ? error.message : String(error) });
				return;
			}
		}

		const policy = this.ports.policy();
		const structureOnly = policy.baseFolder === null && options.structureRoot !== undefined;
		const base = structureOnly ? "" : policy.baseFolder;
		const parents = new Map<string, string>();
		const parentPaths = new Map<string, string>();
		const work: PushWork = {
			ensureFolders: async () => {
				if (notes.length === 0) return;
				await this.ports.send.prepare?.();
				const listing = await cloud.listing();
				for (const line of await records.settle(new Map(listing.map((item) => [item.id, item.hash])))) this.ports.log(line);
				notes = notes.filter((note) => !this.heldBack(note, listing, options.optIn === true));
				const byId = new Map(listing.map((item) => [item.id, item]));
				for (const note of notes) {
					const record = recordOf(note);
					const known = record?.deviceParent;
					// Where the notebook is now, wherever the owner put it; a new one goes where the vault folder mirrors.
					if (isActive(record) && known !== undefined && (known === "" || (byId.has(known) && !inTrash(known, byId)))) {
						parents.set(note.path, known);
					} else if (base !== null) {
						const folder = structureOnly ? relativeFolderPath(folderOf(note.path), options.structureRoot ?? "") : folderOf(note.path);
						parents.set(note.path, await cloud.ensureFolder(mirroredDevicePath(folder, base), listing));
					} else {
						parents.set(note.path, "");
					}
				}
				const after = new Map(listing.map((item) => [item.id, item]));
				for (const [path, parent] of parents) {
					const devicePath = devicePathOf(parent, after);
					if (devicePath !== null) parentPaths.set(path, devicePath);
				}
			},
			uploadFiles: async () => {
				if (notes.length === 0) {
					await this.ports.send.report([], { auto, background });
					return;
				}
				this.ports.send.progress?.(0, notes.length);
				// Only what the batch changed goes back: a re-read during the batch may have taken in other copies' records.
				let batchBase = records.get();
				const applyBatch = async (next: MappingTable): Promise<void> => {
					const merged = { ...records.get() };
					for (const [docId, entry] of Object.entries(next)) {
						if (entry === batchBase[docId]) continue;
						const previous = merged[docId];
						// A fresh send knows its notebook's name and folder: what it was sent with.
						const named =
							entry.deviceName === undefined
								? {
										...entry,
										deviceName: baseName(entry.notePath),
										deviceParent: parents.get(entry.notePath) ?? "",
										devicePath: parentPaths.get(entry.notePath),
									}
								: entry;
						merged[docId] = { ...named, ...this.tagsAfterSend(previous, entry) };
					}
					batchBase = next;
					await records.set(merged);
				};
				const { results, table } = await sendBatch(
					notes,
					records.get(),
					{
						client: { uploadInk: cloud.uploadInk, ...(cloud.updateInk === undefined ? {} : { updateInk: cloud.updateInk }) },
						ink: {
							render: this.ports.send.render,
							loadImages: this.ports.send.loadImages,
							loadDrawings: this.ports.send.loadDrawings,
							renderTyped: this.ports.send.renderTyped,
							persistPending: records.persistPending,
							dropPending: records.dropPending,
							commitSent: records.commitSent,
						},
						resolveParent: (notePath) => {
							const parent = parents.get(notePath);
							return parent === undefined
								? Promise.reject(new Error(`Device folder was not prepared for "${notePath}".`))
								: Promise.resolve(parent);
						},
						// An earlier version's PDF or text copy goes to the trash once its notebook is sent.
						replacePrevious: async (previousId, expectedHash) => {
							const listing = await cloud.listing();
							const item = listing.find((entry) => entry.id === previousId);
							if (item === undefined) return "not-found";
							if (expectedHash !== undefined && item.hash !== expectedHash) return "changed";
							await cloud.editMetadata(previousId, item.hash, { parent: "trash" });
							return "trashed";
						},
						unread,
						reread: async (note, docId) => {
							const entry = records.get()[docId];
							if (!isActive(entry)) return null;
							try {
								if (entry.format === "device") await content.reimport(docId);
								else if ((await content.pull([docId], { nested: true, background: true })).unread.size > 0) return null;
							} catch {
								return null;
							}
							const again = await vault.load(note.path);
							if (again === null) return null;
							loaded.set(note.path, again);
							return { note: again.note, entry: records.get()[docId] };
						},
						resolveEmbed,
						persistDocId: (note, docId) => vault.setDocId(note.path, docId),
						layout: this.ports.send.layout,
						frontmatterAsTitleBlock: this.ports.send.frontmatterAsTitleBlock,
						notebookMode: this.ports.send.notebookMode,
						skipUnchanged: auto,
					},
					(done, total) => this.ports.send.progress?.(done, total),
					applyBatch,
				);
				await applyBatch(table);
				await this.ports.send.report(results, { auto, background });
			},
		};
		const push = this.ports.push ?? (async (w: PushWork) => {
			await w.ensureFolders();
			await w.uploadFiles();
		});
		try {
			await push(work);
		} catch (error) {
			await this.ports.send.report([], { auto, background, failure: error instanceof Error ? error.message : String(error) });
		}
	}

	/**
	 * Stop syncing a note: its record goes, then the note is opted out in its
	 * frontmatter (so a sync folder does not send it again as a new
	 * notebook), then the id goes from its frontmatter — in that order, so a
	 * stop cut short never leaves a record whose note looks deleted, nor a
	 * note that is sent again. The notebook stays, or with `trashNotebook`
	 * goes to the tablet's trash — only while it holds nothing the note
	 * lacks. Resolves to what happened to the notebook.
	 */
	async unlink(docId: string, notePath: string | null, trashNotebook: boolean): Promise<"kept" | "trashed" | "changed"> {
		const { cloud, records, vault } = this.ports;
		const entry = records.get()[docId];
		let outcome: "kept" | "trashed" | "changed" = "kept";
		if (entry !== undefined && trashNotebook) {
			const listing = await cloud.listing();
			const byId = new Map(listing.map((item) => [item.id, item]));
			const item = byId.get(entry.deviceDocId);
			if (item !== undefined && !inTrash(item.parent, byId)) {
				if (item.hash !== entry.accountedHash) {
					outcome = "changed";
				} else {
					try {
						await cloud.editMetadata(item.id, item.hash, { parent: "trash" });
						outcome = "trashed";
					} catch (error) {
						if (!(error instanceof NotebookChangedError)) throw error;
						outcome = "changed";
					}
				}
			}
		}
		if (entry !== undefined) {
			await records.set(Object.fromEntries(Object.entries(records.get()).filter(([id]) => id !== docId)));
		}
		if (notePath !== null) {
			await vault.setOptOut(notePath, true);
			await vault.setDocId(notePath, null);
		}
		return outcome;
	}
}
