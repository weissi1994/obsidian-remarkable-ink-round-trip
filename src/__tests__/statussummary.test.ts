import { describe, expect, it } from "vitest";
import { buildSyncStatusSummary } from "../sync/statussummary";

describe("buildSyncStatusSummary", () => {
	it("summarises persisted coverage and live queue state", () => {
		const summary = buildSyncStatusSummary({
			mappings: {
				a: {
					docId: "a",
					notePath: "watch/a.md",
					deviceDocId: "remote-a",
					uploadedAt: "2026-09-01T10:00:00Z",
					contentHash: "a",
				},
				b: {
					docId: "b",
					notePath: "missing.md",
					deviceDocId: "remote-b",
					uploadedAt: "2026-09-03T10:00:00Z",
					contentHash: "b",
				},
				c: {
					docId: "c",
					notePath: "Archive/watch/c.md",
					deviceDocId: "remote-c",
					uploadedAt: "2026-09-04T10:00:00Z",
					contentHash: "c",
					state: "archived",
				},
			},
			localPaths: new Set(["watch/a.md", "watch/new.md"]),
			watchPaths: new Set(["watch/a.md", "watch/new.md"]),
			live: {
				active: "push",
				queuedFolders: 1,
				queuedPushes: 2,
				queuedPulls: 3,
				pendingChanges: 4,
			},
		});

		expect(summary).toEqual({
			queue: "Uploading",
			queuedWork: 6,
			pendingChanges: 4,
			trackedNotes: 2,
			localTrackedNotes: 1,
			missingLocalNotes: 1,
			archivedNotes: 1,
			watchNotes: 2,
			untrackedWatchNotes: 1,
			lastUploadedAt: "2026-09-03T10:00:00Z",
		});
	});
});
