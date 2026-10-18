import { describe, expect, it } from "vitest";
import {
	NoteInput,
	SendDeps,
	SentRecord,
	notesNeedingUpload,
	prepareNoteContent,
	sendBatch,
	sendNote,
} from "../sync/send";
import { TYPO_VERSION } from "../convert/pdf";
import { isValidDocId } from "../id/docid";
import { MappingTable, contentHash } from "../id/mapping";
import { DEVICE_PROFILES } from "../ink/inkrender";

function makeDeps(overrides: Partial<SendDeps> = {}) {
	const uploads: { name: string; pages: Uint8Array[] }[] = [];
	const persisted: { path: string; docId: string }[] = [];
	const sent: Record<string, SentRecord> = {};
	const deps: SendDeps = {
		client: {
			uploadInk: (name, pages) => {
				uploads.push({ name, pages });
				return Promise.resolve({ deviceDocId: `device-${uploads.length}`, pageIds: ["p1"] });
			},
		},
		ink: {
			render: () => ({
				pages: [new Uint8Array([1])],
				snapshot: {
					font: "readability",
					fallbackFont: "readability",
					pen: "medium",
					color: 0,
					jitter: 0.4,
					profile: DEVICE_PROFILES.rm2,
					shape: 1,
				},
			}),
			persistSent: (docId, record) => {
				sent[docId] = record;
				return Promise.resolve();
			},
		},
		resolveEmbed: () => ({ kind: "missing" }),
		persistDocId: (note, docId) => {
			persisted.push({ path: note.path, docId });
			return Promise.resolve();
		},
		...overrides,
	};
	return { deps, uploads, persisted, sent };
}

const NOTE: NoteInput = {
	path: "map/Nota.md",
	basename: "Nota",
	content: "---\ntitle: X\n---\nInhoud van de notitie.",
};

describe("notesNeedingUpload", () => {
	const docId = "0f8fad5b-d9cb-469f-a165-70867728950e";
	const note = { ...NOTE, existingDocId: docId };
	const missing = () => ({ kind: "missing" as const });
	const tableFor = (format: "ink" | "pdf"): MappingTable => ({
		[docId]: {
			docId,
			notePath: note.path,
			deviceDocId: "device-a",
			uploadedAt: "2026-09-03T00:00:00Z",
			contentHash: contentHash(prepareNoteContent(note, missing).markdown),
			format,
		},
	});

	it("filters unchanged notes before cloud work is queued", () => {
		expect(notesNeedingUpload([note], tableFor("ink"), missing)).toEqual([]);
		expect(
			notesNeedingUpload([{ ...note, content: `${note.content}\nChanged.` }], tableFor("ink"), missing),
		).toHaveLength(1);
	});

	it("re-sends a note last sent as PDF, even when unchanged", () => {
		expect(notesNeedingUpload([note], tableFor("pdf"), missing)).toHaveLength(1);
	});
});

describe("sendNote", () => {
	it("generates and persists a docId, uploads a notebook, and records the mapping", async () => {
		const { deps, uploads, persisted } = makeDeps();
		const { result, table } = await sendNote(NOTE, {}, deps);

		if (!result.ok) throw new Error(`unexpected failure: ${result.error}`);
		expect(isValidDocId(result.docId)).toBe(true);
		expect(persisted).toEqual([{ path: "map/Nota.md", docId: result.docId }]);
		expect(uploads[0].name).toBe("Nota");
		expect(table[result.docId]).toMatchObject({
			notePath: "map/Nota.md",
			deviceDocId: "device-1",
			format: "ink",
		});
		expect(table[result.docId].ink?.pageIds).toEqual(["p1"]);
	});

	it("keeps the note body as the merge base, frontmatter left out", async () => {
		const { deps, sent } = makeDeps();
		const { result } = await sendNote(NOTE, {}, deps);
		if (!result.ok) throw new Error("unexpected failure");
		expect(sent[result.docId].body).toBe("Inhoud van de notitie.");
		expect(sent[result.docId].markdown).toContain("Inhoud van de notitie.");
	});

	it("reuses an existing docId without persisting again", async () => {
		const { deps, persisted } = makeDeps();
		const existing = "0f8fad5b-d9cb-469f-a165-70867728950e";
		const { result } = await sendNote({ ...NOTE, existingDocId: existing }, {}, deps);
		if (!result.ok) throw new Error("unexpected failure");
		expect(result.docId).toBe(existing);
		expect(persisted).toHaveLength(0);
	});

	it("returns a failure result instead of throwing", async () => {
		const { deps } = makeDeps({
			client: { uploadInk: () => Promise.reject(new Error("cloud down")) },
		});
		const { result, table } = await sendNote(NOTE, {}, deps);
		expect(result).toMatchObject({ ok: false, error: "cloud down" });
		expect(table).toEqual({});
	});

	it("records the typography, so tablet changes can be anchored", async () => {
		const { deps } = makeDeps({ layout: { fontSize: 13 } });
		const { table } = await sendNote(NOTE, {}, deps);
		expect(Object.values(table)[0].pdfLayout).toMatchObject({ fontSize: 13, typo: TYPO_VERSION });
	});
});

describe("sendNote skipUnchanged", () => {
	it("skips the upload when content is unchanged, and sends when it changed", async () => {
		const { deps, uploads } = makeDeps({ skipUnchanged: true });
		const first = await sendNote(NOTE, {}, deps);
		if (!first.result.ok) throw new Error("unexpected failure");
		expect(uploads).toHaveLength(1);

		const again = await sendNote(
			{ ...NOTE, existingDocId: first.result.docId },
			first.table,
			deps,
		);
		if (!again.result.ok) throw new Error("unexpected failure");
		expect(again.result.skipped).toBe(true);
		expect(uploads).toHaveLength(1);

		const changed = await sendNote(
			{
				...NOTE,
				content: `${NOTE.content}\nExtra regel.`,
				existingDocId: first.result.docId,
			},
			again.table,
			deps,
		);
		if (!changed.result.ok) throw new Error("unexpected failure");
		expect(changed.result.skipped).toBeUndefined();
		expect(uploads).toHaveLength(2);
	});
});

describe("sendNote folder mirroring hooks", () => {
	it("does not upload when the destination folder was not resolved", async () => {
		const { deps, uploads } = makeDeps({
			resolveParent: () => Promise.reject(new Error("folder creation failed")),
		});
		const { result } = await sendNote(NOTE, {}, deps);

		expect(result).toMatchObject({
			ok: false,
			error: "folder creation failed",
		});
		expect(uploads).toHaveLength(0);
	});

	it("uploads into the resolved parent and retires the previous device copy", async () => {
		const trashed: string[] = [];
		const parents: string[] = [];
		const { deps, uploads } = makeDeps({
			resolveParent: (notePath) => {
				parents.push(notePath);
				return Promise.resolve("dir-42");
			},
			replacePrevious: (id) => {
				trashed.push(id);
				return Promise.resolve();
			},
		});
		const uploadArgs: (string | undefined)[] = [];
		deps.client = {
			uploadInk: (name, pages, uploadOptions) => {
				uploadArgs.push(uploadOptions.parentId);
				uploads.push({ name, pages });
				return Promise.resolve({ deviceDocId: `device-${uploads.length}`, pageIds: ["p1"] });
			},
		};

		const first = await sendNote(NOTE, {}, deps);
		if (!first.result.ok) throw new Error("unexpected failure");
		const second = await sendNote(
			{
				...NOTE,
				content: `${NOTE.content}\nGewijzigd.`,
				existingDocId: first.result.docId,
			},
			first.table,
			deps,
		);
		if (!second.result.ok) throw new Error("unexpected failure");

		expect(parents).toEqual(["map/Nota.md", "map/Nota.md"]);
		expect(uploadArgs).toEqual(["dir-42", "dir-42"]);
		expect(trashed).toEqual(["device-1"]);
	});

	it("treats a failing replacePrevious as non-fatal", async () => {
		const { deps } = makeDeps({
			replacePrevious: () => Promise.reject(new Error("trash faalt")),
		});
		const first = await sendNote(NOTE, {}, deps);
		if (!first.result.ok) throw new Error("unexpected failure");
		const second = await sendNote(
			{ ...NOTE, content: "ander", existingDocId: first.result.docId },
			first.table,
			deps,
		);
		expect(second.result.ok).toBe(true);
	});
});

describe("sendBatch", () => {
	it("continues after a failure and reports per file", async () => {
		let calls = 0;
		const { deps } = makeDeps({
			client: {
				uploadInk: () => {
					calls++;
					return calls === 1
						? Promise.reject(new Error("eerste faalt"))
						: Promise.resolve({ deviceDocId: `device-${calls}`, pageIds: ["p1"] });
				},
			},
		});
		const progress: number[] = [];
		const { results, table } = await sendBatch(
			[NOTE, { ...NOTE, path: "b.md", basename: "b" }],
			{},
			deps,
			(done) => progress.push(done),
		);
		expect(results.map((r) => r.ok)).toEqual([false, true]);
		expect(Object.keys(table)).toHaveLength(1);
		expect(progress).toEqual([1, 2]);
	});

	it("records every landed upload of a batch at once", async () => {
		const { deps } = makeDeps();
		const checkpoints: number[] = [];
		const notes = Array.from({ length: 45 }, (_, index) => ({
			...NOTE,
			path: `batch/${index}.md`,
			basename: String(index),
		}));

		const { table } = await sendBatch(
			notes,
			{},
			deps,
			undefined,
			async (checkpoint) => {
				checkpoints.push(Object.keys(checkpoint).length);
			},
		);

		expect(checkpoints).toHaveLength(45);
		expect(checkpoints[44]).toBe(45);
		expect(Object.keys(table)).toHaveLength(45);
	});
});
