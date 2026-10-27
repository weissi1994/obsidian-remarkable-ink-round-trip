/**
 * The sync engine wired to stand-ins: the fake cloud (helpers/fakecloud.ts)
 * with the real transports, an in-memory vault, the real SyncState on an
 * in-memory folder, and a content stand-in for the pull: a notebook's new
 * tablet pages go into its note as one line each (`ink <page>`). Sends are
 * the real ones (sync/send.ts), pages rendered as one deterministic stroke
 * per note text. Plus the tablet's own hand: renaming, moving, trashing,
 * restoring and deleting outright.
 */

import type { MappingTable } from "../../id/mapping";
import { buildInkPageRm } from "../../ink/rmwrite";
import { DEVICE_PROFILES } from "../../ink/inkrender";
import type { DeviceItem } from "../../sync/deviceimport";
import { SyncEngine, type ContentPort, type EnginePorts, type RecordStore } from "../../sync/engine";
import { SyncState } from "../../sync/syncstate";
import { createFolder, editMetadata, ensureFolderPath, readListing } from "../../transport/metadata";
import { sendNotebook, sendNotebookUpdate } from "../../transport/notebook";
import { fakeCloud } from "./fakecloud";
import { memoryFs } from "./memoryfs";
import { memoryVault } from "./memoryvault";

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
}

export function syncRig(options: RigOptions = {}) {
	const cloud = fakeCloud();
	const vault = memoryVault();
	const files = memoryFs();
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
	let state = new SyncState(fs, "state", "install-a");
	let table: MappingTable = {};
	const log: string[] = [];
	const cache: Record<string, DeviceItem> = {};
	/** Notebooks the plugin created, to tell a duplicate from a notebook started on the tablet. */
	const created = new Set<string>();
	const api = cloud.api;

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
			const settled = await state.settlePending(table, present);
			table = settled.table;
			return [...settled.committed.map((id) => `settled ${id}`), ...settled.dropped.map((id) => `dropped ${id}`)];
		},
		persistPending: (docId, sent, mapping, previousHash) => state.writePending(docId, sent, mapping, previousHash),
		commitSent: (docId, sent, mapping) => state.commitSent(docId, sent, mapping),
	};

	/** The stand-in pull: every tablet page not in the note yet becomes a line of it. */
	const readInto = async (docId: string): Promise<string | null> => {
		const entry = table[docId];
		const hash = entry === undefined ? undefined : cloud.hashOf(entry.deviceDocId);
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
		await records.set({ ...table, [docId]: { ...table[docId], accountedHash: hash } });
		return missing.length > 0 ? note.path : null;
	};
	const content: ContentPort = {
		pull: async (docIds) => {
			const changed = new Set<string>();
			const unread = new Map<string, string>();
			for (const docId of docIds) {
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
		importNew: () => Promise.resolve([]),
	};

	const ports: EnginePorts = {
		vault: vault.port,
		cloud: {
			listing: () => readListing(api, cache),
			ensureFolder: (path, listing) => ensureFolderPath(api, listing, path, { retry: NO_RETRY }),
			editMetadata: (id, expectedHash, update) => editMetadata(api, id, expectedHash, update, { retry: NO_RETRY }),
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
		policy: () => ({
			baseFolder: options.baseFolder === undefined ? "Obsidian" : options.baseFolder,
			archiveFolder: options.archiveFolder ?? "reMarkable/Archive",
			syncFolders: options.syncFolders ?? ["Notes"],
			excludeFolders: [],
		}),
		log: (line) => log.push(line),
	};
	let engine = new SyncEngine(ports);

	const tabletHash = (id: string): string => {
		const hash = cloud.hashOf(id);
		if (hash === undefined) throw new Error(`no ${id} on the account`);
		return hash;
	};
	const tablet = {
		rename: (id: string, visibleName: string) => editMetadata(api, id, tabletHash(id), { visibleName }, { retry: NO_RETRY }),
		move: (id: string, parent: string) => editMetadata(api, id, tabletHash(id), { parent }, { retry: NO_RETRY }),
		trash: (id: string) => editMetadata(api, id, tabletHash(id), { parent: "trash" }, { retry: NO_RETRY }),
		folder: (name: string, parent = "") => createFolder(api, name, parent, { retry: NO_RETRY }).then((folder) => folder.id),
		/** The folder at a device path, made where missing. */
		folderAt: async (path: string) => ensureFolderPath(api, await readListing(api, {}), path, { retry: NO_RETRY }),
		write: (id: string) => cloud.writeOnTablet(id),
		/** Deleted outright, trash emptied: gone from the account. */
		erase: async (id: string) => {
			const [root, generation] = await api.getRootHash();
			const { entries } = await api.getEntries("root.docSchema", root);
			const [entry] = await api.putEntries("root", entries.filter((e) => e.id !== id), 4);
			await api.putRootHash(entry.hash, generation);
		},
		/** A notebook as the tablet sees it: name, folder path ("" = root, null = trash) and hash. */
		async describe(id: string): Promise<{ name: string; parent: string; hash: string } | null> {
			const listing = await readListing(api, {});
			const item = listing.find((one) => one.id === id);
			return item === undefined ? null : { name: item.visibleName, parent: item.parent, hash: item.hash };
		},
		listing: () => readListing(api, {}),
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
			state = new SyncState(fs, "state", "install-a");
			table = await state.loadMappings();
			engine = new SyncEngine(ports);
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
