/**
 * What has to happen to keep each note and its notebook together, decided
 * from what the vault and the tablet look like now against what was last
 * synced (the record). Pure: the engine (sync/engine.ts) carries the actions
 * out one by one, writing the record after each, so a run that stops halfway
 * is planned again from wherever it got to.
 *
 * Renames and moves go both ways, metadata only; when both sides renamed,
 * the vault wins. Nothing is ever deleted: a note deleted in the vault sends
 * its notebook to the tablet's trash (only while it holds nothing the note
 * lacks), a notebook trashed on the tablet sends its note to the archive
 * folder, and either coming back brings the other back.
 */

import type { MappingEntry, MappingTable } from "../id/mapping";
import { devicePathOf } from "../transport/metadata";
import { noteFileName, type DeviceItem } from "./deviceimport";
import { isInWatchFolder } from "./watcher";

/** A markdown note in the vault and the document id in its frontmatter, if any. */
export interface VaultNote {
	path: string;
	docId?: string;
}

export interface ReconcilePolicy {
	/** Device folder holding the mirrored vault tree; null when folders are not mirrored (moves are then not followed). */
	baseFolder: string | null;
	/** Vault folder notes go to when their notebook was trashed on the tablet. */
	archiveFolder: string;
}

/** Record fields an action sets once it is done; `undefined` removes a field. */
export type RecordPatch = { [K in keyof MappingEntry]?: MappingEntry[K] | undefined };

export type Action =
	/** Bookkeeping only: nothing to write on either side. */
	| { kind: "record"; docId: string; patch: RecordPatch; log?: string }
	/**
	 * Rename and/or move the notebook, while its hash is still `expectedHash`.
	 * `folder`: a vault folder whose mirrored device folder becomes the parent
	 * (created when missing); `parent`: a device folder id outright.
	 */
	| {
			kind: "edit-notebook";
			docId: string;
			deviceDocId: string;
			expectedHash: string;
			visibleName?: string;
			folder?: string;
			parent?: string;
			patch: RecordPatch;
			log: string;
	  }
	/** Rename/move the note in the vault (links follow); the record takes the path it lands on. */
	| { kind: "move-note"; docId: string; from: string; to: string; patch: RecordPatch; log: string }
	/** The note was deleted and the notebook holds nothing more: to the tablet's trash, compare-before-write. */
	| { kind: "trash-notebook"; docId: string; deviceDocId: string; expectedHash: string; log: string }
	/**
	 * The notebook was trashed or is gone: its unread ink in first (when
	 * `readFirst`), then the note into the archive folder.
	 */
	| { kind: "archive-note"; docId: string; from: string; to: string; readFirst: boolean; log: string };

const stripMd = (path: string): string => path.replace(/\.md$/i, "");
export const baseName = (path: string): string => stripMd(path.split("/").pop() ?? path);
export const folderOf = (path: string): string => path.split("/").slice(0, -1).join("/");
const join = (folder: string, name: string): string => (folder === "" ? name : `${folder}/${name}`);
const clean = (path: string): string => path.trim().replace(/^\/+|\/+$/g, "");

/** Whether a device item sits in the trash, directly or inside a trashed folder. */
export function inTrash(parent: string, byId: ReadonlyMap<string, DeviceItem>): boolean {
	let current = parent;
	for (let guard = 0; current !== "" && guard < 64; guard++) {
		if (current === "trash") return true;
		const folder = byId.get(current);
		if (folder === undefined) return false;
		current = folder.parent;
	}
	return false;
}

/** The vault folder a device folder mirrors, or null when it lies outside the mirrored tree. */
export function mirroredVaultFolder(parent: string, byId: ReadonlyMap<string, DeviceItem>, baseFolder: string): string | null {
	const path = devicePathOf(parent, byId);
	if (path === null) return null;
	const base = clean(baseFolder);
	if (base === "") return path;
	if (path === base) return "";
	return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : null;
}

/** The device folder path that mirrors a vault folder. */
export function mirroredDevicePath(vaultFolder: string, baseFolder: string): string {
	return [clean(baseFolder), clean(vaultFolder)].filter((part) => part !== "").join("/");
}

/** Where a note goes in the archive: its vault path kept below the archive folder. */
export function archivePathOf(notePath: string, archiveFolder: string): string {
	const archive = clean(archiveFolder);
	return archive === "" || isInWatchFolder(notePath, archive) ? notePath : `${archive}/${notePath}`;
}

/**
 * The actions that bring every record's note and notebook back together.
 * `device` null: the account could not be listed — nothing on the tablet
 * side is judged. An empty listing (a fresh pairing, an endpoint switch) and
 * an empty vault (not loaded yet) are never read as "everything was
 * deleted".
 */
export function plan(
	records: MappingTable,
	vault: readonly VaultNote[],
	device: readonly DeviceItem[] | null,
	policy: ReconcilePolicy,
): Action[] {
	const notesById = new Map<string, VaultNote[]>();
	for (const note of vault) {
		if (note.docId === undefined) continue;
		const list = notesById.get(note.docId) ?? [];
		list.push(note);
		notesById.set(note.docId, list);
	}
	const byId = new Map((device ?? []).map((item) => [item.id, item]));
	const listed = device !== null && device.length > 0;
	const vaultSeen = vault.length > 0;
	const actions: Action[] = [];

	for (const record of Object.values(records)) {
		const copies = notesById.get(record.docId) ?? [];
		// Several notes on one id (a copy) are told apart before a send; until then the one at the recorded path is it.
		const note = copies.length === 1 ? copies[0] : copies.find((copy) => copy.path === record.notePath);
		if (copies.length > 1 && note === undefined) continue;
		if (record.format !== "ink" && record.format !== "device") {
			// An earlier version's PDF or text copy: re-sent as ink, so only the path is kept up.
			if (note !== undefined && note.path !== record.notePath) {
				actions.push({ kind: "record", docId: record.docId, patch: { notePath: note.path } });
			}
			continue;
		}
		if (device === null) continue;
		const dev = byId.get(record.deviceDocId);
		if (dev?.unreadable === true) continue;
		const trashed = dev !== undefined && inTrash(dev.parent, byId);
		const gone = dev === undefined && listed;
		const out = record.state === "archived" ? planArchived(record, note, dev, trashed, gone, byId, policy) : null;
		if (out !== null) {
			actions.push(...out);
			continue;
		}
		if (note === undefined) {
			if (!vaultSeen) continue;
			if (gone || trashed) {
				actions.push({
					kind: "record",
					docId: record.docId,
					patch: { state: "archived", archivedFrom: undefined },
					log: `${record.notePath}: deleted in the vault, and its notebook is ${gone ? "gone from" : "in the trash on"} the reMarkable — archived`,
				});
			} else if (dev === undefined) {
				continue;
			} else if (dev.hash === record.accountedHash) {
				actions.push({
					kind: "trash-notebook",
					docId: record.docId,
					deviceDocId: dev.id,
					expectedHash: dev.hash,
					log: `${record.notePath}: deleted in the vault — notebook “${dev.visibleName}” moved to the reMarkable's trash`,
				});
			} else if (record.unappliedHash !== dev.hash) {
				actions.push({
					kind: "record",
					docId: record.docId,
					patch: { unappliedHash: dev.hash },
					log:
						`${record.notePath}: deleted in the vault but written on the tablet — notebook “${dev.visibleName}” kept, ` +
						"its new ink is in no note (restore the note to bring it in)",
				});
			}
			continue;
		}
		if (dev === undefined || trashed) {
			if (dev === undefined && !gone) {
				if (note.path !== record.notePath) actions.push({ kind: "record", docId: record.docId, patch: { notePath: note.path } });
				continue;
			}
			actions.push({
				kind: "archive-note",
				docId: record.docId,
				from: note.path,
				to: archivePathOf(note.path, policy.archiveFolder),
				readFirst: dev !== undefined && dev.hash !== record.accountedHash,
				log: `${note.path}: notebook ${dev === undefined ? "gone from" : "moved to the trash on"} the reMarkable — note archived`,
			});
			continue;
		}
		actions.push(...planNames(record, note, dev, byId, policy));
	}
	return actions;
}

/** Note and notebook both there: follow renames and moves from either side. */
function planNames(
	record: MappingEntry,
	note: VaultNote,
	dev: DeviceItem,
	byId: ReadonlyMap<string, DeviceItem>,
	policy: ReconcilePolicy,
): Action[] {
	const docId = record.docId;
	const name = baseName(note.path);
	const folder = folderOf(note.path);
	const vaultRenamed = name !== baseName(record.notePath);
	const vaultMoved = folder !== folderOf(record.notePath);
	// A record from before these were kept takes the tablet as it is.
	const tabletRenamed = dev.visibleName !== (record.deviceName ?? dev.visibleName);
	const tabletMoved = dev.parent !== (record.deviceParent ?? dev.parent);
	const mirrored = policy.baseFolder === null ? null : mirroredVaultFolder(dev.parent, byId, policy.baseFolder);

	const lines: string[] = [];
	let visibleName: string | undefined;
	let toFolder: string | undefined;
	if (vaultRenamed && dev.visibleName !== name) {
		visibleName = name;
		lines.push(
			tabletRenamed
				? `renamed on both sides — the vault's “${name}” wins over the tablet's “${dev.visibleName}”`
				: `renamed in the vault: notebook “${dev.visibleName}” → “${name}”`,
		);
	}
	if (policy.baseFolder !== null && vaultMoved && mirrored !== folder) {
		toFolder = folder;
		lines.push(tabletMoved ? `moved on both sides — the vault's folder “${folder}” wins` : `moved in the vault: notebook to “${folder || "/"}”`);
	}
	const actions: Action[] = [];
	if (visibleName !== undefined || toFolder !== undefined) {
		actions.push({
			kind: "edit-notebook",
			docId,
			deviceDocId: dev.id,
			expectedHash: dev.hash,
			...(visibleName === undefined ? {} : { visibleName }),
			...(toFolder === undefined ? {} : { folder: toFolder }),
			patch: { notePath: note.path, unappliedHash: undefined },
			log: `${note.path}: ${lines.join("; ")}`,
		});
	}

	const noteName = !vaultRenamed && tabletRenamed ? noteFileName(dev.visibleName) : name;
	const noteFolder =
		policy.baseFolder !== null && !vaultMoved && tabletMoved && mirrored !== null ? mirrored : folder;
	if (noteName !== name || noteFolder !== folder) {
		const to = `${join(noteFolder, noteName)}.md`;
		actions.push({
			kind: "move-note",
			docId,
			from: note.path,
			to,
			patch: { deviceName: visibleName ?? dev.visibleName, ...(toFolder === undefined ? { deviceParent: dev.parent } : {}) },
			log: `${note.path}: ${noteName !== name ? `renamed on the tablet to “${dev.visibleName}”` : ""}${
				noteName !== name && noteFolder !== folder ? " and " : ""
			}${noteFolder !== folder ? `moved on the tablet to “${noteFolder || "/"}”` : ""} — note follows`,
		});
		return actions;
	}
	if (actions.length > 0) return actions;

	const patch: RecordPatch = {};
	if (note.path !== record.notePath) patch.notePath = note.path;
	if (record.deviceName !== dev.visibleName) patch.deviceName = dev.visibleName;
	if (record.deviceParent !== dev.parent) patch.deviceParent = dev.parent;
	if (Object.keys(patch).length === 0) return [];
	const detached =
		policy.baseFolder !== null && tabletMoved && mirrored === null
			? `${note.path}: notebook moved outside the synced folders on the tablet — left there, still synced`
			: undefined;
	return [{ kind: "record", docId, patch, ...(detached === undefined ? {} : { log: detached }) }];
}

/**
 * An archived record: null while nothing came back. The note found outside
 * the archive (or, deleted in the vault, found at all) brings its notebook
 * back from the trash; the notebook restored on the tablet brings the note
 * back to where it was.
 */
function planArchived(
	record: MappingEntry,
	note: VaultNote | undefined,
	dev: DeviceItem | undefined,
	trashed: boolean,
	gone: boolean,
	byId: ReadonlyMap<string, DeviceItem>,
	policy: ReconcilePolicy,
): Action[] {
	const docId = record.docId;
	const resumed: RecordPatch = { state: undefined, archivedFrom: undefined, unappliedHash: undefined };
	const archive = clean(policy.archiveFolder);
	const inArchive = (path: string) => archive !== "" && isInWatchFolder(path, archive);
	if (note === undefined) {
		// The notebook of a deleted note came back on the tablet and was written in: say so, once per change.
		if (dev === undefined || trashed || dev.hash === record.accountedHash || dev.hash === record.unappliedHash) return [];
		return [
			{
				kind: "record",
				docId,
				patch: { unappliedHash: dev.hash },
				log:
					`${record.notePath}: deleted in the vault but written on the tablet — notebook “${dev.visibleName}” kept, ` +
					"its new ink is in no note (restore the note to bring it in)",
			},
		];
	}
	const noteBack = record.archivedFrom === undefined || (note.path !== record.notePath && !inArchive(note.path));
	if (noteBack) {
		if (dev === undefined) {
			if (!gone) return [];
			// The owner took the note back; its notebook is gone, so a new one is sent.
			return [
				{
					kind: "record",
					docId,
					patch: { ...resumed, notePath: note.path, contentHash: "", deviceName: undefined, deviceParent: undefined },
					log: `${note.path}: back in the vault; its notebook is gone from the reMarkable, so a new one is sent`,
				},
			];
		}
		const name = baseName(note.path);
		const folder = folderOf(note.path);
		const rename = dev.visibleName === name ? {} : { visibleName: name };
		if (trashed) {
			const keepParent =
				note.path === record.notePath && record.deviceParent !== undefined && (record.deviceParent === "" || devicePathOf(record.deviceParent, byId) !== null);
			return [
				{
					kind: "edit-notebook",
					docId,
					deviceDocId: dev.id,
					expectedHash: dev.hash,
					...rename,
					...(keepParent ? { parent: record.deviceParent } : policy.baseFolder === null ? { parent: "" } : { folder }),
					patch: { ...resumed, notePath: note.path },
					log: `${note.path}: back in the vault — notebook “${dev.visibleName}” restored from the reMarkable's trash`,
				},
			];
		}
		// Both came back on their own: the note's name and place win, as for any rename.
		const mirrored = policy.baseFolder === null ? null : mirroredVaultFolder(dev.parent, byId, policy.baseFolder);
		const move = mirrored !== null && mirrored !== folder ? { folder } : {};
		if (Object.keys(rename).length > 0 || Object.keys(move).length > 0) {
			return [
				{
					kind: "edit-notebook",
					docId,
					deviceDocId: dev.id,
					expectedHash: dev.hash,
					...rename,
					...move,
					patch: { ...resumed, notePath: note.path },
					log: `${note.path}: back in the vault — synced again, notebook “${dev.visibleName}” follows the note`,
				},
			];
		}
		return [
			{
				kind: "record",
				docId,
				patch: { ...resumed, notePath: note.path, deviceName: dev.visibleName, deviceParent: dev.parent },
				log: `${note.path}: back in the vault — synced again`,
			},
		];
	}
	if (record.archivedFrom !== undefined && dev !== undefined && !trashed) {
		// Back where the tablet restored it, when that is a synced folder; else where it was.
		const mirrored = policy.baseFolder === null ? null : mirroredVaultFolder(dev.parent, byId, policy.baseFolder);
		const to = mirrored === null ? record.archivedFrom : `${join(mirrored, noteFileName(dev.visibleName))}.md`;
		return [
			{
				kind: "move-note",
				docId,
				from: note.path,
				to,
				patch: { ...resumed, deviceName: dev.visibleName, deviceParent: dev.parent },
				log: `${to}: notebook restored on the reMarkable — note moved back from the archive`,
			},
		];
	}
	if (note.path !== record.notePath) return [{ kind: "record", docId, patch: { notePath: note.path } }];
	return [];
}
