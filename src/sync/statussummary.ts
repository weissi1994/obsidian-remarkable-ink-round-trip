import type { MappingTable } from "../id/mapping";
import type { SyncQueueStatus } from "./queues";

export interface LiveSyncStatus extends SyncQueueStatus {
	pendingChanges: number;
	/** Notes done and in the running upload batch, when one runs. */
	uploading?: { done: number; total: number };
}

export interface SyncStatusSummary {
	queue: string;
	queuedWork: number;
	pendingChanges: number;
	trackedNotes: number;
	localTrackedNotes: number;
	missingLocalNotes: number;
	/** Notes whose note or notebook was deleted on one side; not synced until it comes back. */
	archivedNotes: number;
	watchNotes: number;
	untrackedWatchNotes: number;
	lastUploadedAt: string | null;
}

export function buildSyncStatusSummary(input: {
	mappings: MappingTable;
	localPaths: ReadonlySet<string>;
	watchPaths: ReadonlySet<string>;
	live: LiveSyncStatus;
}): SyncStatusSummary {
	const all = Object.values(input.mappings);
	const entries = all.filter((entry) => entry.state !== "archived");
	const mappedPaths = new Set(entries.map((entry) => entry.notePath));
	const localTrackedNotes = entries.filter((entry) =>
		input.localPaths.has(entry.notePath),
	).length;
	const syncTimes = entries.map((entry) => entry.uploadedAt).sort();
	const lastUploadedAt = syncTimes[syncTimes.length - 1] ?? null;
	const queue =
		input.live.active === "folder"
			? "Preparing device folders"
			: input.live.active === "push"
				? input.live.uploading === undefined
					? "Uploading"
					: `Uploading ${input.live.uploading.done}/${input.live.uploading.total}`
				: input.live.active === "pull"
					? "Importing"
					: input.live.queuedFolders +
								input.live.queuedPushes +
								input.live.queuedPulls >
							0
						? "Queued"
						: input.live.pendingChanges > 0
							? "Waiting for debounce"
							: "Idle";

	return {
		queue,
		queuedWork:
			input.live.queuedFolders +
			input.live.queuedPushes +
			input.live.queuedPulls,
		pendingChanges: input.live.pendingChanges,
		trackedNotes: entries.length,
		localTrackedNotes,
		missingLocalNotes: entries.length - localTrackedNotes,
		archivedNotes: all.length - entries.length,
		watchNotes: input.watchPaths.size,
		untrackedWatchNotes: [...input.watchPaths].filter(
			(path) => !mappedPaths.has(path),
		).length,
		lastUploadedAt,
	};
}

/** Where a note stands, as the status panel lists it. */
export type NoteSyncState = "error" | "clash" | "tablet-pending" | "waiting" | "in-sync" | "archived" | "opted-out";

/** The panel's sections, in order, with their headings. */
export const NOTE_STATE_LABELS: Record<NoteSyncState, string> = {
	error: "Not sent because of an error",
	clash: "Open clash (also changed on the reMarkable)",
	"tablet-pending": "Tablet changes waiting to go in",
	waiting: "Waiting to send",
	"in-sync": "In sync",
	archived: "Archived",
	"opted-out": "Opted out",
};

/** What the panel knows about one note in the vault. */
export interface NoteFacts {
	path: string;
	docId?: string;
	optOut?: boolean;
	/** In a sync folder (outside the plugin's own folders). */
	inSyncFolder: boolean;
	/** The note's text, for the clash and pending callouts; absent = not read. */
	text?: string;
}

export interface NoteStatus {
	path: string;
	state: NoteSyncState;
	/** Why: the error, or what a note waits for. */
	detail?: string;
}

/** Callout id lines the merge writes (merge3.ts, annotationnote.ts): a clash to resolve, tablet changes not taken in yet. */
const CLASH_ID = /^> \^ink-conflict-[0-9a-f-]+\s*$/m;
const PENDING_ID = /^> \^ink-pending\s*$/m;

/**
 * Each synced note's state, worst first: opted out and archived as such,
 * then a send error, an open clash, tablet changes waiting, a send waiting
 * (a note of a sync folder not sent yet, one held back, one changed and
 * queued), else in sync. Notes neither synced nor in a sync folder are not
 * listed.
 */
export function classifyNotes(input: {
	notes: readonly NoteFacts[];
	mappings: MappingTable;
	/** The last send error of a note, by path. */
	errors: ReadonlyMap<string, string>;
	/** Notes waiting for a send, with why when known (a held send, a queued change). */
	waiting: ReadonlyMap<string, string | undefined>;
}): NoteStatus[] {
	const out: NoteStatus[] = [];
	for (const note of input.notes) {
		const record = note.docId === undefined ? undefined : input.mappings[note.docId];
		const error = input.errors.get(note.path);
		let status: NoteStatus | null;
		if (note.optOut === true) status = { path: note.path, state: "opted-out" };
		else if (record?.state === "archived") status = { path: note.path, state: "archived" };
		else if (error !== undefined) status = { path: note.path, state: "error", detail: error };
		else if (record === undefined && !note.inSyncFolder) status = null;
		else if (note.text !== undefined && CLASH_ID.test(note.text)) status = { path: note.path, state: "clash" };
		else if (note.text !== undefined && PENDING_ID.test(note.text)) status = { path: note.path, state: "tablet-pending" };
		else if (input.waiting.has(note.path) || record === undefined) {
			const detail = input.waiting.get(note.path);
			status = { path: note.path, state: "waiting", ...(detail === undefined ? {} : { detail }) };
		} else status = { path: note.path, state: "in-sync" };
		if (status !== null) out.push(status);
	}
	return out;
}
