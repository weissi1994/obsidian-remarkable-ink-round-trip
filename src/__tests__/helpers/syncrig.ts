/**
 * The sync engine wired to stand-ins: the fake cloud (helpers/fakecloud.ts)
 * with the real transports, an in-memory vault, the real SyncState on an
 * in-memory folder, and a content stand-in for the pull: a notebook's new
 * tablet pages go into its note as one line each (`ink <page>`). Sends are
 * the real ones (sync/send.ts), pages rendered as one deterministic stroke
 * per note text. Plus the tablet's own hand: renaming, moving, trashing,
 * restoring and deleting outright.
 */

import { generateDocId } from "../../id/docid";
import type { MappingTable } from "../../id/mapping";
import { buildInkPageRm } from "../../ink/rmwrite";
import { DEVICE_PROFILES } from "../../ink/inkrender";
import { findNewNotebooks, noteFileName, type DeviceItem } from "../../sync/deviceimport";
import { SyncEngine, type ContentPort, type EnginePorts, type RecordStore } from "../../sync/engine";
import { SyncState } from "../../sync/syncstate";
import { createFolder, editMetadata, editTags, ensureFolderPath, readListing, readTags } from "../../transport/metadata";
import { sendNotebook, sendNotebookUpdate } from "../../transport/notebook";
import { fakeCloud, type FakeCloud } from "./fakecloud";
import { memoryFs } from "./memoryfs";
import { memoryVault, withDocId, type MemoryVault } from "./memoryvault";

export const NO_RETRY = { attempts: 1 };

/** One stroke whose position encodes the text: the same note always draws the same page. */
function pageOf(text: string): Uint8Array {
	let hash = 0;
	for (let i = 0; i < text.length; i++) hash = (Math.imul(hash, 31) + text.charCodeAt(i)) >>> 0;
	return buildInkPageRm(
		[{ counter: 100, tool: 17, color: 0, thicknessScale: 2, points: [{ x: hash % 1000, y: (hash >>> 10) % 1000, width: 16, pressure: 200, speed: 5, direction: 0 }] }],
		{ paperSize: { width: 1404, height: 1872 } },
	);
}

export interface RigOptions {
	baseFolder?: string | null;
	syncFolders?: string[];
	archiveFolder?: string;
	/** Send in place (default) or as a new notebook replacing the old. */
	inPlace?: boolean;
	/** Another install of the same vault: shares this cloud (and, given, this vault), with its own state folder. */
	cloud?: FakeCloud;
	vault?: MemoryVault;
	installId?: string;
	/** Notebooks the plugin wrote, shared between installs (the real one tells by the pages' author). */
	created?: Set<string>;
}

export function syncRig(options: RigOptions = {}) {
	const cloud = options.cloud ?? fakeCloud();
	const vault = options.vault ?? memoryVault();
	const files = memoryFs();
	const installId = options.installId ?? "install-a";
	let failing: (() => void) | null = null;
	const fs = {
		...files.fs,
		write: async (path: string, data: string) => {
			failing?.();
			await files.fs.write(path, data);
		},
		remove: async (path: string) => {
			failing?.();
			await files.fs.remove(path);
		},
	};
	let state = new SyncState(fs, "state", installId);
	let table: MappingTable = {};
	const log: string[] = [];
	let cache: Record<string, DeviceItem> = {};
	/** Notebooks the plugin created, to tell a duplicate from a notebook started on the tablet. */
	const created = options.created ?? new Set<string>();
	/** The account the plugin is paired with: switchable, as an endpoint or account switch. */
	let account = cloud;
	let api = cloud.api;

	const records: RecordStore = {
		get: () => table,
		set: async (next) => {
			table = next;
			await state.saveMappings(next);
		},
		refresh: async () => {
			table = await state.refresh(table);
		},
		settle: async (present) => {
			const settled = await state.settlePending(table, present, async (id, hash) => {
				const { entries } = await api.getEntries(`${id}.docSchema`, hash);
				return new Set(entries.map((entry) => entry.hash));
			});
			table = settled.table;
			return [...settled.committed.map((id) => `settled ${id}`), ...settled.dropped.map((id) => `dropped ${id}`)];
		},
		persistPending: (...args) => state.writePending(...args),
		commitSent: (docId, sent, mapping) => state.commitSent(docId, sent, mapping),
		dropPending: (docId, hash) => state.dropPending(docId, hash),
		sendingElsewhere: () => state.sendingElsewhere(),
	};

	/**
	 * The stand-in pull: every tablet page not in the note yet becomes a line
	 * of it. As the real one: only handwritten notebooks are read, and the
	 * hash read is recorded only while the record is still the one read from.
	 */
	const readInto = async (docId: string): Promise<string | null> => {
		const entry = table[docId];
		const hash = entry === undefined ? undefined : account.hashOf(entry.deviceDocId);
		if (entry === undefined || hash === undefined) throw new Error("not on the account");
		if (hash === entry.accountedHash) return null;
		const notes = await vault.port.notes();
		const note = notes.find((one) => one.docId === docId);
		if (note === undefined) throw new Error("its note is not in the vault");
		const { entries } = await api.getEntries(`${entry.deviceDocId}.docSchema`, hash);
		const pages = entries.filter((e) => e.id.includes("/tablet-")).map((e) => `ink ${e.id.split("/").pop()}`);
		const text = vault.read(note.path) ?? "";
		const missing = pages.filter((line) => !text.includes(line));
		if (missing.length > 0) vault.modify(note.path, (current) => `${current.replace(/\n?$/, "\n")}${missing.join("\n")}\n`);
		const latest = table[docId];
		if (latest !== undefined && latest.deviceDocId === entry.deviceDocId && latest.accountedHash === entry.accountedHash) {
			await records.set({ ...table, [docId]: { ...latest, accountedHash: hash } });
		}
		return missing.length > 0 ? note.path : null;
	};
	const policy = () => ({
		baseFolder: options.baseFolder === undefined ? "Obsidian" : options.baseFolder,
		archiveFolder: options.archiveFolder ?? "reMarkable/Archive",
		syncFolders: options.syncFolders ?? ["Notes"],
		excludeFolders: [],
	});
	const content: ContentPort = {
		pull: async (docIds) => {
			const changed = new Set<string>();
			const unread = new Map<string, string>();
			for (const docId of docIds) {
				if (table[docId]?.format !== "ink") continue;
				try {
					const path = await readInto(docId);
					if (path !== null) changed.add(path);
				} catch (error) {
					unread.set(docId, error instanceof Error ? error.message : String(error));
				}
			}
			return { changed, unread };
		},
		reimport: async (docId) => (await readInto(docId)) !== null,
		/** Notebooks started on the tablet in a mirrored folder become notes, their pages as `ink` lines. */
		importNew: async (listing) => {
			const { baseFolder, syncFolders } = policy();
			if (baseFolder === null) return [];
			const known = new Set(Object.values(table).map((entry) => entry.deviceDocId));
			const items = listing.map((item) => (created.has(item.id) ? { ...item, ours: true } : item));
			const found = findNewNotebooks(items, { baseFolder, vaultFolders: syncFolders, known, now: Number.POSITIVE_INFINITY, quietMs: 0 });
			const paths: string[] = [];
			for (const notebook of found) {
				const docId = generateDocId();
				const stem = [notebook.folder, noteFileName(notebook.name)].filter((part) => part !== "").join("/");
				let path = `${stem}.md`;
				for (let n = 2; vault.files.has(path); n++) path = `${stem} (${n}).md`;
				const { entries } = await api.getEntries(`${notebook.id}.docSchema`, notebook.hash);
				const lines = entries.filter((e) => e.id.endsWith(".rm")).map((e) => `ink ${e.id.split("/").pop()}`);
				vault.create(path, withDocId(`# ${notebook.name}\n\n${lines.join("\n")}\n`, docId));
				await state.writeSent(docId, { title: notebook.name, markdown: "", body: "" });
				const byId = new Map(listing.map((item) => [item.id, item]));
				const parent = byId.get(notebook.id)?.parent ?? "";
				await records.set({
					...table,
					[docId]: {
						docId,
						notePath: path,
						deviceDocId: notebook.id,
						uploadedAt: "",
						contentHash: "",
						format: "device",
						accountedHash: notebook.hash,
						deviceName: notebook.name,
						deviceParent: parent,
					},
				});
				paths.push(path);
			}
			return paths;
		},
	};

	const ports: EnginePorts = {
		vault: vault.port,
		cloud: {
			listing: () => readListing(api, cache),
			ensureFolder: (path, listing) => ensureFolderPath(api, listing, path, { retry: NO_RETRY }),
			editMetadata: (id, expectedHash, update) => editMetadata(api, id, expectedHash, update, { retry: NO_RETRY }),
			readTags: (id, hash) => readTags(api, id, hash),
			editTags: (id, expectedHash, tags) => editTags(api, id, expectedHash, tags, { retry: NO_RETRY }),
			uploadInk: async (name, pages, o) => {
				const result = await sendNotebook(api, name, pages, { ...o, docId: o.deviceDocId, retry: NO_RETRY });
				created.add(result.docId);
				return { deviceDocId: result.docId, pageIds: result.pageIds, hash: result.hash, replaced: result.replaced };
			},
			updateInk:
				options.inPlace === false
					? undefined
					: async (id, name, pages, o) => {
							const result = await sendNotebookUpdate(api, id, name, pages, { ...o, retry: NO_RETRY });
							return { deviceDocId: result.docId, pageIds: result.pageIds, hash: result.hash };
						},
		},
		records,
		content,
		send: {
			// From the whole note, so an edit changes the page.
			render: (blocks, title) => ({
				pages: [pageOf(`${title}\n${JSON.stringify(blocks)}`)],
				snapshot: { font: "readability", fallbackFont: "readability", pen: "medium", color: 0, jitter: 0, profile: DEVICE_PROFILES.rm2, shape: 1 },
			}),
			report: async () => undefined,
		},
		policy,
		log: (line) => log.push(line),
	};
	let engine = new SyncEngine(ports);

	const home = cloud.api;
	const tabletHash = (id: string): string => {
		const hash = cloud.hashOf(id);
		if (hash === undefined) throw new Error(`no ${id} on the account`);
		return hash;
	};
	const tablet = {
		rename: (id: string, visibleName: string) => editMetadata(home, id, tabletHash(id), { visibleName }, { retry: NO_RETRY }),
		move: (id: string, parent: string) => editMetadata(home, id, tabletHash(id), { parent }, { retry: NO_RETRY }),
		trash: (id: string) => editMetadata(home, id, tabletHash(id), { parent: "trash" }, { retry: NO_RETRY }),
		folder: (name: string, parent = "") => createFolder(home, name, parent, { retry: NO_RETRY }).then((folder) => folder.id),
		/** The folder at a device path, made where missing. */
		folderAt: async (path: string) => ensureFolderPath(home, await readListing(home, {}), path, { retry: NO_RETRY }),
		write: (id: string) => cloud.writeOnTablet(id),
		/** A notebook started on the tablet, in the folder at `parent`: one page of the owner's. */
		create: async (name: string, parent: string) =>
			(await sendNotebook(home, name, [new Uint8Array([9])], { parentId: parent, retry: NO_RETRY })).docId,
		tags: (id: string, tags: string[]) => editTags(home, id, tabletHash(id), tags, { retry: NO_RETRY }),
		/** Deleted outright, trash emptied: gone from the account. */
		erase: async (id: string) => {
			const [root, generation] = await home.getRootHash();
			const { entries } = await home.getEntries("root.docSchema", root);
			const [entry] = await home.putEntries("root", entries.filter((e) => e.id !== id), 4);
			await home.putRootHash(entry.hash, generation);
		},
		/** A notebook as the tablet sees it: name, folder path ("" = root, null = trash) and hash. */
		async describe(id: string): Promise<{ name: string; parent: string; hash: string } | null> {
			const listing = await readListing(home, {});
			const item = listing.find((one) => one.id === id);
			return item === undefined ? null : { name: item.visibleName, parent: item.parent, hash: item.hash };
		},
		listing: () => readListing(home, {}),
	};

	return {
		cloud,
		vault,
		fs: files,
		ports,
		log,
		created,
		tablet,
		get engine() {
			return engine;
		},
		get table() {
			return table;
		},
		/** Make every state write (and whatever else calls it) fail from now on; null heals. */
		failWrites(hook: (() => void) | null): void {
			failing = hook;
		},
		/** Start over as after a restart: the state read back from its files. */
		async restart(): Promise<void> {
			state = new SyncState(fs, "state", installId);
			table = await state.loadMappings();
			engine = new SyncEngine(ports);
		},
		/** Pair with another account (an endpoint switch), or back with this rig's own (null). */
		useAccount(other: FakeCloud | null): void {
			account = other ?? cloud;
			api = account.api;
			cache = {};
		},
		get state() {
			return state;
		},
		/** The record of the note at `path`, by its frontmatter id. */
		recordOf(path: string) {
			const text = vault.read(path);
			const docId = text === undefined ? undefined : vault.docIdOf(text);
			return docId === undefined ? undefined : table[docId];
		},
	};
}

export type SyncRig = ReturnType<typeof syncRig>;
