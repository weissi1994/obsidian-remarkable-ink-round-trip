/**
 * Watch-folder queue (PRD F6): notes created/modified inside any configured
 * vault folder are collected into one debounced batch and handed to the send
 * flow without a manual command. Timers are injected so the logic tests
 * without a DOM and the plugin edge can pass window-bound timers.
 */

export interface WatchQueueOptions {
	/** Vault folders to watch, without trailing slash (e.g. "reMarkable-out"). */
	folders: string[];
	/** Quiet period after the last change before a file is sent. */
	debounceMs: number;
	setTimer: (fn: () => void, ms: number) => number;
	clearTimer: (id: number) => void;
	/**
	 * Longest a pending change waits, counted from the first change of the
	 * batch: continuous typing keeps restarting the debounce, and without a
	 * cap the note would never be sent. Default 60 s.
	 */
	maxWaitMs?: number;
	/** Folders never watched even inside a watched one (the backup folder). */
	excludeFolders?: string[];
	/** Clock for suppression windows; defaults to Date.now. */
	now?: () => number;
	/** Called once with the deduplicated batch when the quiet window closes. */
	onReady: (paths: string[]) => void;
}

/** Split the comma-separated setting into clean, unique folder paths. */
export function parseFolderList(value: string): string[] {
	const folders = value
		.split(",")
		.map((f) => f.trim().replace(/^\/+|\/+$/g, ""))
		.filter((f) => f !== "");
	return [...new Set(folders)];
}

/** True when the path lives inside the watched folder (any depth). */
export function isInWatchFolder(path: string, folder: string): boolean {
	const prefix = folder.replace(/\/+$/, "");
	if (prefix === "") return false;
	return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * The comma-separated folder setting after the vault folder `from` was
 * renamed to `to` (the folders in it and below it follow); null when it
 * names neither.
 */
export function renameInFolderList(value: string, from: string, to: string): string | null {
	const folders = parseFolderList(value);
	const renamed = folders.map((folder) => (isInWatchFolder(folder, from) ? `${to}${folder.slice(from.length)}` : folder));
	return renamed.some((folder, i) => folder !== folders[i]) ? [...new Set(renamed)].join(", ") : null;
}

export class WatchQueue {
	private readonly pending = new Set<string>();
	private timer: number | null = null;
	private firstPendingAt: number | null = null;
	private readonly suppressedUntil = new Map<string, number>();
	/** The batch waiting runs even with no note left in it: something was renamed, moved or deleted. */
	private structural = false;

	constructor(private readonly opts: WatchQueueOptions) {}

	/** Report a create/modify event; only markdown files in a watched folder count. */
	noteChanged(path: string): void {
		if (!path.endsWith(".md")) return;
		if (!this.opts.folders.some((f) => isInWatchFolder(path, f))) return;
		if (this.opts.excludeFolders?.some((f) => isInWatchFolder(path, f))) return;
		const now = this.now();
		const until = this.suppressedUntil.get(path);
		if (until !== undefined) {
			if (now <= until) return;
			this.suppressedUntil.delete(path);
		}
		this.pending.add(path);
		if (this.firstPendingAt === null) this.firstPendingAt = now;
		this.schedule(now);
	}

	private schedule(now: number): void {
		if (this.timer !== null) this.opts.clearTimer(this.timer);
		const maxWait = this.opts.maxWaitMs ?? 60_000;
		const left = Math.max(0, (this.firstPendingAt ?? now) + maxWait - now);
		this.timer = this.opts.setTimer(() => {
			this.timer = null;
			this.firstPendingAt = null;
			this.structural = false;
			const paths = [...this.pending];
			this.pending.clear();
			this.opts.onReady(paths);
		}, Math.min(this.opts.debounceMs, left));
	}

	/**
	 * Ignore events for `path` for the next `ms`: the plugin's own writes
	 * (merged tablet changes, frontmatter ids) would otherwise re-queue the
	 * note it just synced.
	 */
	suppress(path: string, ms: number): void {
		this.suppressedUntil.set(path, this.now() + ms);
	}

	private now(): number {
		return (this.opts.now ?? Date.now)();
	}

	/** A rename/delete out of the folder cancels the pending send. */
	noteRemoved(path: string): void {
		this.pending.delete(path);
		if (this.pending.size === 0 && !this.structural && this.timer !== null) {
			this.opts.clearTimer(this.timer);
			this.timer = null;
			this.firstPendingAt = null;
		}
	}

	/**
	 * A synced note or a folder was renamed, moved or deleted: run a batch
	 * after the quiet period even with no note to send, so the notebooks
	 * follow (sync/reconcile.ts).
	 */
	structureChanged(): void {
		const now = this.now();
		this.structural = true;
		if (this.firstPendingAt === null) this.firstPendingAt = now;
		this.schedule(now);
	}

	/** Read-only view of the sends waiting for the debounce timer. */
	status(): { pendingChanges: number; pendingPaths: string[] } {
		return { pendingChanges: this.pending.size, pendingPaths: [...this.pending] };
	}

	/** Cancel everything (plugin unload or settings change). */
	dispose(): void {
		if (this.timer !== null) this.opts.clearTimer(this.timer);
		this.timer = null;
		this.firstPendingAt = null;
		this.structural = false;
		this.pending.clear();
		this.suppressedUntil.clear();
	}
}
