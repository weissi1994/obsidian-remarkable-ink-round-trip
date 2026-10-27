import { describe, expect, it, vi } from "vitest";
import { WatchQueue, isInWatchFolder, parseFolderList, renameInFolderList } from "../sync/watcher";

/** Manual timer harness: fire() runs all due timers. */
function fakeTimers() {
	let nextId = 1;
	const timers = new Map<number, () => void>();
	return {
		setTimer: (fn: () => void, _ms: number) => {
			const id = nextId++;
			timers.set(id, fn);
			return id;
		},
		clearTimer: (id: number) => void timers.delete(id),
		fire: () => {
			const due = [...timers.values()];
			timers.clear();
			due.forEach((fn) => fn());
		},
		pending: () => timers.size,
	};
}

describe("isInWatchFolder", () => {
	it("matches the folder itself and nested paths only", () => {
		expect(isInWatchFolder("reMarkable-out/a.md", "reMarkable-out")).toBe(true);
		expect(isInWatchFolder("reMarkable-out/sub/b.md", "reMarkable-out")).toBe(
			true,
		);
		expect(isInWatchFolder("reMarkable-outtakes/c.md", "reMarkable-out")).toBe(
			false,
		);
		expect(isInWatchFolder("elders/d.md", "reMarkable-out")).toBe(false);
		expect(isInWatchFolder("x.md", "")).toBe(false);
	});
});

describe("parseFolderList", () => {
	it("splits, cleans and dedupes comma-separated folders", () => {
		expect(parseFolderList(" /out/ , Work/print,, out ")).toEqual(["out", "Work/print"]);
		expect(parseFolderList("")).toEqual([]);
		expect(parseFolderList("reMarkable-out")).toEqual(["reMarkable-out"]);
	});
});

describe("renameInFolderList", () => {
	it("follows a renamed sync folder and the folders below it, leaving look-alikes", () => {
		expect(renameInFolderList("Work, Work/print, Workshop", "Work", "Job")).toBe("Job, Job/print, Workshop");
		expect(renameInFolderList("Projects/Old", "Projects", "Archive/Projects")).toBe("Archive/Projects/Old");
		expect(renameInFolderList("Work", "Elsewhere", "Other")).toBeNull();
	});
});

describe("a rename, move or delete of a synced note or folder", () => {
	const queue = (timers: ReturnType<typeof fakeTimers>, ready: string[][]) =>
		new WatchQueue({ folders: ["out"], debounceMs: 1000, ...timers, onReady: (paths) => ready.push(paths) });

	it("runs a batch even with no note to send, so the notebooks follow", () => {
		const timers = fakeTimers();
		const ready: string[][] = [];
		queue(timers, ready).structureChanged();
		timers.fire();
		expect(ready).toEqual([[]]);
	});

	it("is not cancelled when the last pending note is removed", () => {
		const timers = fakeTimers();
		const ready: string[][] = [];
		const q = queue(timers, ready);
		q.noteChanged("out/a.md");
		q.structureChanged();
		q.noteRemoved("out/a.md");
		timers.fire();
		expect(ready).toEqual([[]]);
	});
});

describe("WatchQueue", () => {
	it("watches every configured folder", () => {
		const timers = fakeTimers();
		const ready: string[][] = [];
		const queue = new WatchQueue({
			folders: ["out", "work/print"],
			debounceMs: 1000,
			setTimer: timers.setTimer,
			clearTimer: timers.clearTimer,
			onReady: (paths) => ready.push(paths),
		});
		queue.noteChanged("out/a.md");
		queue.noteChanged("work/print/b.md");
		queue.noteChanged("work/c.md");
		timers.fire();
		expect(ready).toEqual([["out/a.md", "work/print/b.md"]]);
	});

	it("debounces repeated changes into one send", () => {
		const timers = fakeTimers();
		const ready: string[][] = [];
		const queue = new WatchQueue({
			folders: ["out"],
			debounceMs: 1000,
			setTimer: timers.setTimer,
			clearTimer: timers.clearTimer,
			onReady: (paths) => ready.push(paths),
		});
		queue.noteChanged("out/nota.md");
		queue.noteChanged("out/nota.md");
		queue.noteChanged("out/nota.md");
		expect(timers.pending()).toBe(1);
		expect(queue.status()).toEqual({ pendingChanges: 1, pendingPaths: ["out/nota.md"] });
		timers.fire();
		expect(ready).toEqual([["out/nota.md"]]);
		expect(queue.status()).toEqual({ pendingChanges: 0, pendingPaths: [] });
	});

	it("coalesces different notes into one deduplicated batch", () => {
		const timers = fakeTimers();
		const ready: string[][] = [];
		const queue = new WatchQueue({
			folders: ["out"],
			debounceMs: 1000,
			setTimer: timers.setTimer,
			clearTimer: timers.clearTimer,
			onReady: (paths) => ready.push(paths),
		});
		queue.noteChanged("out/a.md");
		queue.noteChanged("out/b.md");
		queue.noteChanged("out/a.md");

		expect(timers.pending()).toBe(1);
		timers.fire();
		expect(ready).toEqual([["out/a.md", "out/b.md"]]);
	});

	it("ignores non-markdown files and files outside the folder", () => {
		const timers = fakeTimers();
		const queue = new WatchQueue({
			folders: ["out"],
			debounceMs: 1000,
			setTimer: timers.setTimer,
			clearTimer: timers.clearTimer,
			onReady: () => {},
		});
		queue.noteChanged("out/plaatje.png");
		queue.noteChanged("elders/nota.md");
		expect(timers.pending()).toBe(0);
	});

	it("cancels a pending send when the file is removed, and all on dispose", () => {
		const timers = fakeTimers();
		const ready: string[][] = [];
		const queue = new WatchQueue({
			folders: ["out"],
			debounceMs: 1000,
			setTimer: timers.setTimer,
			clearTimer: timers.clearTimer,
			onReady: (paths) => ready.push(paths),
		});
		queue.noteChanged("out/a.md");
		queue.noteRemoved("out/a.md");
		expect(queue.status()).toEqual({ pendingChanges: 0, pendingPaths: [] });
		queue.noteChanged("out/b.md");
		queue.dispose();
		expect(queue.status()).toEqual({ pendingChanges: 0, pendingPaths: [] });
		timers.fire();
		expect(ready).toEqual([]);
	});
});

describe("WatchQueue under real timing", () => {
	function realQueue(extra: Partial<ConstructorParameters<typeof WatchQueue>[0]> = {}) {
		const batches: string[][] = [];
		const queue = new WatchQueue({
			folders: ["out"],
			debounceMs: 15_000,
			setTimer: (fn, ms) => setTimeout(fn, ms) as unknown as number,
			clearTimer: (id) => clearTimeout(id),
			onReady: (paths) => batches.push(paths),
			...extra,
		});
		return { queue, batches };
	}

	it("sends after the max wait even while the note keeps changing", () => {
		vi.useFakeTimers();
		try {
			const { queue, batches } = realQueue();
			for (let t = 0; t < 55_000; t += 5_000) {
				queue.noteChanged("out/a.md");
				vi.advanceTimersByTime(5_000);
			}
			expect(batches).toEqual([]);
			queue.noteChanged("out/a.md");
			vi.advanceTimersByTime(4_999);
			expect(batches).toEqual([]);
			vi.advanceTimersByTime(1);
			expect(batches).toEqual([["out/a.md"]]);
			queue.noteChanged("out/a.md");
			vi.advanceTimersByTime(14_999);
			expect(batches).toHaveLength(1);
			vi.advanceTimersByTime(1);
			expect(batches).toHaveLength(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("ignores the plugin's own write inside the suppression window, not after", () => {
		vi.useFakeTimers();
		try {
			const { queue, batches } = realQueue();
			queue.suppress("out/a.md", 2_000);
			queue.noteChanged("out/a.md");
			vi.advanceTimersByTime(30_000);
			expect(batches).toEqual([]);
			queue.noteChanged("out/a.md");
			vi.advanceTimersByTime(15_000);
			expect(batches).toEqual([["out/a.md"]]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("never queues notes in an excluded folder inside a watched one", () => {
		vi.useFakeTimers();
		try {
			const { queue, batches } = realQueue({ excludeFolders: ["out/backup"] });
			queue.noteChanged("out/backup/a.md");
			queue.noteChanged("out/backupish.md");
			vi.advanceTimersByTime(15_000);
			expect(batches).toEqual([["out/backupish.md"]]);
		} finally {
			vi.useRealTimers();
		}
	});
});
