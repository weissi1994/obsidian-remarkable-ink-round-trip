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
	inTrash,
	mirroredDevicePath,
	plan,
	type Action,
	type RecordPatch,
	type ReconcilePolicy,
	type VaultNote,
} from "./reconcile";
import { relativeFolderPath } from "./selection";
import { devicePathOf } from "../transport/metadata";
import { notesNeedingUpload, sendBatch, type NoteInput, type SendDeps, type SendResult } from "./send";
import { isInWatchFolder } from "./watcher";

export interface VaultPort {
	/** Every markdown note with the document id in its frontmatter — read from the file where a cache lags. */
	notes(): Promise<(VaultNote & { ctime?: number })[]>;
	/** Rename/move a note, its links following; missing folders are made, a taken path gets a number. Resolves to the path used. */
	move(from: string, to: string): Promise<string>;
	/** Write (or, with null, remove) the document id in a note's frontmatter. */
	setDocId(path: string, docId: string | null): Promise<void>;
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
	/** Run a send in the shared cloud lane (sync/queues.ts PushQueue); run directly when absent. */
	push?: (work: PushWork) => Promise<void>;
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
}

const isActive = (entry: MappingEntry | undefined): entry is MappingEntry =>
	entry !== undefined && entry.state !== "archived" && (entry.format === "ink" || entry.format === "device");

function patched(entry: MappingEntry, patch: RecordPatch): MappingEntry {
	const next: Record<string, unknown> = { ...entry, ...patch };
	for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
	return next as unknown as MappingEntry;
}

export class SyncEngine {
	constructor(private readonly ports: EnginePorts) {}

	private async update(docId: string, patch: RecordPatch): Promise<void> {
		const table = this.ports.records.get();
		const entry = table[docId];
		if (entry === undefined) return;
		await this.ports.records.set({ ...table, [docId]: patched(entry, patch) });
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
	 * listing as it is after, or null when it could not be read.
	 */
	async reconcile(): Promise<{ listing: DeviceItem[] | null; notes: VaultNote[] }> {
		await this.ports.records.refresh();
		let listing: DeviceItem[] | null = null;
		try {
			listing = await this.ports.cloud.listing();
		} catch (error) {
			this.ports.log(`could not list the reMarkable account: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (listing !== null) {
			for (const line of await this.ports.records.settle(new Map(listing.map((item) => [item.id, item.hash])))) {
				this.ports.log(line);
			}
		}
		let notes = await this.splitCopies();
		const actions = plan(this.ports.records.get(), notes, listing, this.ports.policy());
		for (const action of actions) await this.execute(action, listing ?? []);
		if (actions.some((action) => action.kind === "move-note")) notes = await this.ports.vault.notes();
		return { listing, notes };
	}

	private async execute(action: Action, listing: DeviceItem[]): Promise<void> {
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
					await this.update(action.docId, {
						...action.patch,
						deviceName: visibleName,
						deviceParent: parent ?? item?.parent,
						// Ink the note does not have yet stays unaccounted for: the read after this takes it in.
						accountedHash: entry?.accountedHash === action.expectedHash ? hash : entry?.accountedHash,
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
					await this.update(action.docId, { state: "archived", archivedFrom: undefined, accountedHash: hash });
					break;
				}
				case "archive-note": {
					if (action.readFirst) {
						const { unread } = await this.ports.content.pull([action.docId], { nested: true, background: true });
						const reason = unread.get(action.docId);
						if (reason !== undefined) log(`${action.from}: the trashed notebook's new ink could not be read (${reason}); it stays in the notebook`);
					}
					const path = action.from === action.to ? action.from : await vault.move(action.from, action.to);
					await this.update(action.docId, { state: "archived", archivedFrom: action.from, notePath: path, unappliedHash: undefined });
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
			return;
		}
		if ("log" in action && action.log !== undefined) log(action.log);
	}

	/**
	 * The whole round trip: lifecycle, then every notebook with new ink read
	 * into its note, notebooks started on the tablet brought in, and every
	 * note that is new or out of date sent.
	 */
	async sync(options: { background?: boolean } = {}): Promise<void> {
		const background = options.background === true;
		const { listing, notes } = await this.reconcile();
		const table = this.ports.records.get();
		const byDoc = new Map(notes.filter((note) => note.docId !== undefined).map((note) => [note.docId, note.path]));
		const byId = new Map((listing ?? []).map((item) => [item.id, item]));
		const live = (entry: MappingEntry): DeviceItem | undefined => {
			const item = byId.get(entry.deviceDocId);
			return item === undefined || inTrash(item.parent, byId) ? undefined : item;
		};
		// Only notes that are there with notebooks that are there: anything else the lifecycle has dealt with.
		const synced = Object.values(table).filter(
			(entry) => isActive(entry) && byDoc.has(entry.docId) && (listing === null || live(entry) !== undefined),
		);
		const { changed, unread } = await this.ports.content.pull(
			synced.filter((entry) => entry.format === "ink").map((entry) => entry.docId),
			{ background },
		);
		const unreadAll = new Map(unread);
		for (const entry of synced) {
			if (entry.format !== "device" || live(entry)?.hash === entry.accountedHash) continue;
			try {
				if (await this.ports.content.reimport(entry.docId)) changed.add(byDoc.get(entry.docId) ?? entry.notePath);
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
		for (const note of await this.ports.vault.notes()) {
			const record = note.docId === undefined ? undefined : current[note.docId];
			if (record?.state === "archived") continue;
			const inSyncFolder =
				policy.syncFolders.some((folder) => isInWatchFolder(note.path, folder)) &&
				!policy.excludeFolders.some((folder) => isInWatchFolder(note.path, folder));
			if (inSyncFolder || isActive(record) || changed.has(note.path)) paths.add(note.path);
		}
		if (paths.size === 0) return;
		await this.send([...paths], { auto: true, pullFirst: false, reconcile: false, background, unread: unreadAll });
	}

	/**
	 * Send notes as handwritten notebooks. A note that has a notebook gets it
	 * read first, so ink not yet in the note is merged before the notebook is
	 * rewritten; one whose notebook could not be read is held back. With
	 * `auto`, unchanged notes are skipped. Archived notes are never sent.
	 */
	async send(paths: string[], options: SendOptions = {}): Promise<void> {
		const { vault, records, content, cloud } = this.ports;
		const auto = options.auto === true;
		const background = options.background === true;
		if (options.reconcile !== false) await this.reconcile();
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
		let notes = [...loaded.values()].map(({ note }) => note).filter((note) => recordOf(note)?.state !== "archived");
		if (notes.length === 0) {
			if (!background) await this.ports.send.report([], { auto, background, failure: "No markdown notes to send." });
			return;
		}
		if (auto) {
			try {
				notes = notesNeedingUpload(notes, records.get(), resolveEmbed, this.ports.send.frontmatterAsTitleBlock);
			} catch (error) {
				await this.ports.send.report([], { auto, background, failure: error instanceof Error ? error.message : String(error) });
				return;
			}
		}

		const policy = this.ports.policy();
		const structureOnly = policy.baseFolder === null && options.structureRoot !== undefined;
		const base = structureOnly ? "" : policy.baseFolder;
		const parents = new Map<string, string>();
		const work: PushWork = {
			ensureFolders: async () => {
				if (notes.length === 0) return;
				await this.ports.send.prepare?.();
				const listing = await cloud.listing();
				for (const line of await records.settle(new Map(listing.map((item) => [item.id, item.hash])))) this.ports.log(line);
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
						// A fresh send knows its notebook's name and folder: what it was sent with.
						merged[docId] =
							entry.deviceName === undefined
								? { ...entry, deviceName: baseName(entry.notePath), deviceParent: parents.get(entry.notePath) ?? "" }
								: entry;
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
							persistPending: records.persistPending,
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
	 * Stop syncing a note: its record goes, then the id in its frontmatter
	 * (in that order, so a stop cut short never leaves a record whose note
	 * looks deleted). The notebook stays, or with `trashNotebook` goes to the
	 * tablet's trash — only while it holds nothing the note lacks. Resolves to
	 * what happened to the notebook.
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
		if (notePath !== null) await vault.setDocId(notePath, null);
		return outcome;
	}
}
