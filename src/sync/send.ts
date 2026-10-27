/**
 * Send orchestration (PRD F1, F8-basis): note → preprocess → handwritten
 * notebook → upload, with per-file results for batch runs. Pure logic over
 * injected adapters so the whole flow is unit-testable without Obsidian or a
 * device.
 */

import { preprocess, splitNote, EmbedResolver } from "../preprocess/preprocess";
import { parseBlocks } from "../convert/mdblocks";
import { resolveLayoutOptions, PdfLayoutOptions } from "../convert/pdf";
import { ensureDocId, generateDocId } from "../id/docid";
import { InkSnapshot, MappingEntry, MappingTable, contentHash, recordUpload } from "../id/mapping";
import { NotebookChangedError } from "../transport/notebook";
import type { Block } from "../convert/mdblocks";
import type { Picture } from "../ink/inkimage";
import type { InkDrawing } from "../ink/inkdrawing";
import type { UploadResult } from "../transport/cloud";

/** Vault access seam: the plugin edge adapts TFile/Vault to this shape. */
export interface NoteInput {
	path: string;
	basename: string;
	content: string;
	/** Current frontmatter value of the docId key, if any. */
	existingDocId?: unknown;
}

/** What a send keeps so the import can regenerate it and merge into the note. */
export interface SentRecord {
	title: string;
	/** The preprocessed text the notebook was written from. */
	markdown: string;
	/** The note body (no frontmatter) as it was when sent: the merge base. */
	body?: string;
	images?: Record<string, Picture>;
	drawings?: Record<string, InkDrawing>;
}

export interface SendDeps {
	client: {
		/**
		 * Upload a notebook of pen-stroke pages under the ids the send chose
		 * (and recorded) beforehand. `replaces`: the previous notebook, trashed
		 * in the same cloud update — only while its hash is still
		 * `expectedHash`, else NotebookChangedError and nothing is written.
		 * `hash`: the new document's entry hash in the account root.
		 */
		uploadInk(
			visibleName: string,
			pages: Uint8Array[],
			options: {
				parentId?: string;
				replaces?: string;
				expectedHash?: string;
				deviceDocId: string;
				pageIds: string[];
			},
		): Promise<UploadResult & { pageIds: string[]; replaced?: boolean; hash?: string }>;
	};
	/** Turn a note into handwritten pages. */
	ink: {
		render(
			blocks: Block[],
			title: string,
			docId: string,
			layout: PdfLayoutOptions | undefined,
			images?: Record<string, Picture>,
			drawings?: Record<string, InkDrawing>,
		): { pages: Uint8Array[]; snapshot: Omit<InkSnapshot, "pageIds"> };
		/** The note's Mermaid diagrams, traced, by diagramKey(source). */
		loadDrawings?(markdown: string): Promise<Record<string, InkDrawing>>;
		/** The note's embedded pictures, quantised, by placeholder name. */
		loadImages?(note: NoteInput): Promise<Record<string, Picture>>;
		/**
		 * Record the send before its upload, beside the committed one: a crash
		 * after the upload must not lose the notebook, a failed upload must not
		 * change the merge base (SyncState.writePending).
		 */
		persistPending?(docId: string, sent: SentRecord, mapping: MappingEntry): Promise<void>;
		/** The upload landed: keep its text and mapping together (SyncState.commitSent). */
		commitSent?(docId: string, sent: SentRecord, mapping: MappingEntry): Promise<void>;
	};
	/** Resolve an embed for a given note (notePath disambiguates targets). */
	resolveEmbed: (
		linkpath: string,
		notePath: string,
	) => ReturnType<EmbedResolver>;
	/** Persist a newly generated docId into the note's frontmatter. */
	persistDocId: (note: NoteInput, docId: string) => Promise<void>;
	/**
	 * Device collection for this note (folder mirroring, GP_E2_S7); omit for
	 * root uploads.
	 */
	resolveParent?: (notePath: string) => Promise<string>;
	/**
	 * Retire the previous device copy when the upload could not trash it
	 * itself (idempotent re-send, N3) — only while its hash is still
	 * `expectedHash`. Anything but "trashed"/"not-found" is reported.
	 */
	replacePrevious?: (
		previousDeviceDocId: string,
		expectedHash?: string,
	) => Promise<"trashed" | "not-found" | "changed">;
	/**
	 * Notebooks that could not be read in this run, by note docId, with the
	 * reason. Their notes are not sent: the upload would replace ink that is
	 * not in the note yet.
	 */
	unread?: ReadonlyMap<string, string>;
	/**
	 * Read a note's notebook again after it changed on the tablet during the
	 * send, merging the new ink into the note. Returns the note as it is now
	 * and its mapping as the read left it; null when it could not be read.
	 */
	reread?: (note: NoteInput, docId: string) => Promise<{ note: NoteInput; entry: MappingEntry | undefined } | null>;
	layout?: PdfLayoutOptions;
	frontmatterAsTitleBlock?: boolean;
	/**
	 * Skip the upload when the preprocessed content matches the recorded
	 * hash of the last upload (watch-folder flow, F6).
	 */
	skipUnchanged?: boolean;
}

export interface SendSuccess {
	ok: true;
	path: string;
	docId: string;
	deviceDocId: string;
	missingEmbeds: string[];
	/** True when the note was up to date and no upload happened. */
	skipped?: boolean;
	/** Sent, but something about the old notebook needs the owner's eye. */
	warning?: string;
}

export interface SendFailure {
	ok: false;
	path: string;
	error: string;
}

export type SendResult = SendSuccess | SendFailure;

export function prepareNoteContent(
	note: NoteInput,
	resolveEmbed: (
		linkpath: string,
		notePath: string,
	) => ReturnType<EmbedResolver>,
	frontmatterAsTitleBlock = false,
): { markdown: string; missingEmbeds: string[] } {
	return preprocess(note.content, {
		resolveEmbed: (linkpath) => resolveEmbed(linkpath, note.path),
		frontmatterAsTitleBlock,
	});
}

/**
 * Notes whose notebook is missing or out of date. A note last sent in a
 * format other than handwriting always counts: it is re-sent as ink.
 */
export function notesNeedingUpload(
	notes: NoteInput[],
	table: MappingTable,
	resolveEmbed: (
		linkpath: string,
		notePath: string,
	) => ReturnType<EmbedResolver>,
	frontmatterAsTitleBlock = false,
): NoteInput[] {
	return notes.filter((note) => {
		if (typeof note.existingDocId !== "string") return true;
		const previous = table[note.existingDocId];
		if (previous === undefined || previous.format !== "ink") return true;
		const { markdown } = prepareNoteContent(note, resolveEmbed, frontmatterAsTitleBlock);
		return previous.contentHash !== contentHash(markdown);
	});
}

/** Send one note; never throws — failures come back as a result (F8). */
export async function sendNote(
	note: NoteInput,
	table: MappingTable,
	deps: SendDeps,
): Promise<{ result: SendResult; table: MappingTable }> {
	let current = table;
	try {
		const { docId, isNew } = ensureDocId(note.existingDocId);
		if (isNew) await deps.persistDocId(note, docId);
		const unread = current[docId] === undefined ? undefined : deps.unread?.get(docId);
		if (unread !== undefined) {
			throw new Error(
				`Not sent: its notebook could not be read (${unread}), and sending would replace ink that is not in the note yet.`,
			);
		}
		try {
			return await uploadOnce(note, docId, current, deps);
		} catch (error) {
			if (!(error instanceof NotebookChangedError) || deps.reread === undefined) throw error;
		}
		// The tablet wrote into the notebook since it was read: bring that ink
		// in, then send the note as it is now — once; a notebook still being
		// written in waits for the next sync.
		const again = await deps.reread(note, docId);
		if (again === null) {
			throw new Error("Not sent: its notebook changed on the reMarkable and could not be read again.");
		}
		if (again.entry !== undefined) current = { ...current, [docId]: again.entry };
		try {
			return await uploadOnce(again.note, docId, current, deps);
		} catch (error) {
			if (!(error instanceof NotebookChangedError)) throw error;
			throw new Error(
				"Not sent: its notebook keeps changing on the reMarkable (still being written in?). It is tried again on the next sync.",
			);
		}
	} catch (error) {
		return {
			result: {
				ok: false,
				path: note.path,
				error: error instanceof Error ? error.message : String(error),
			},
			table: current,
		};
	}
}

/**
 * One upload of a note. The send is recorded as pending before the upload
 * and committed with its mapping after it, so the merge base only moves
 * once the tablet really holds the new notebook. Throws NotebookChangedError
 * when the old notebook changed since it was last read; nothing was written.
 */
async function uploadOnce(
	note: NoteInput,
	docId: string,
	table: MappingTable,
	deps: SendDeps,
): Promise<{ result: SendResult; table: MappingTable }> {
	const { markdown, missingEmbeds } = prepareNoteContent(note, deps.resolveEmbed, deps.frontmatterAsTitleBlock);
	const hash = contentHash(markdown);
	const current = table[docId];
	if (deps.skipUnchanged && current?.format === "ink" && current.contentHash === hash) {
		return {
			result: { ok: true, path: note.path, docId, deviceDocId: current.deviceDocId, missingEmbeds, skipped: true },
			table,
		};
	}
	const parentId = deps.resolveParent ? await deps.resolveParent(note.path) : undefined;
	const blocks = parseBlocks(markdown, { html: true, quotePictures: true, nestedQuotes: true });
	const images = (await deps.ink.loadImages?.(note)) ?? {};
	const drawings = (await deps.ink.loadDrawings?.(markdown)) ?? {};
	const rendered = deps.ink.render(blocks, note.basename, docId, deps.layout, images, drawings);
	const sent: SentRecord = {
		title: note.basename,
		markdown,
		body: splitNote(note.content).body,
		images: Object.keys(images).length > 0 ? images : undefined,
		drawings: Object.keys(drawings).length > 0 ? drawings : undefined,
	};
	const replaces = deps.replacePrevious === undefined ? undefined : current?.deviceDocId;
	// Notebooks the import reads are replaced only as read; an old PDF copy
	// is never read, so there is nothing to compare it with.
	const expectedHash = current?.format === "ink" || current?.format === "device" ? current.accountedHash : undefined;
	const planned: MappingEntry = {
		docId,
		notePath: note.path,
		deviceDocId: generateDocId(),
		uploadedAt: new Date().toISOString(),
		contentHash: hash,
		format: "ink",
		pdfLayout: resolveLayoutOptions(deps.layout),
		// Ink fork: everything the import needs to regenerate the strokes.
		ink: { ...rendered.snapshot, pageIds: rendered.pages.map(() => generateDocId()) },
	};
	await deps.ink.persistPending?.(docId, sent, planned);
	const upload = await deps.client.uploadInk(note.basename, rendered.pages, {
		parentId,
		replaces,
		expectedHash: replaces === undefined ? undefined : expectedHash,
		deviceDocId: planned.deviceDocId,
		pageIds: planned.ink?.pageIds ?? [],
	});
	const entry: MappingEntry = {
		...planned,
		deviceDocId: upload.deviceDocId,
		ink: { ...rendered.snapshot, pageIds: upload.pageIds },
		accountedHash: upload.hash,
	};
	const updated = recordUpload(table, entry);

	let warning: string | undefined;
	if (replaces !== undefined && upload.replaced !== true && replaces !== upload.deviceDocId && deps.replacePrevious) {
		try {
			const outcome = await deps.replacePrevious(replaces, expectedHash);
			if (outcome === "changed") {
				warning = "The previous notebook changed on the reMarkable during the send and was kept: its new ink is not in the note.";
			}
		} catch (error) {
			warning = `The previous notebook could not be moved to the trash: ${error instanceof Error ? error.message : String(error)}`;
		}
	}
	try {
		await deps.ink.commitSent?.(docId, sent, entry);
	} catch (error) {
		// The notebook landed; the pending record still names it, so the next
		// run commits it from there.
		return {
			result: {
				ok: false,
				path: note.path,
				error: `Sent, but recording the send failed (${error instanceof Error ? error.message : String(error)}); the next sync records it.`,
			},
			table: updated,
		};
	}
	return {
		result: {
			ok: true,
			path: note.path,
			docId,
			deviceDocId: upload.deviceDocId,
			missingEmbeds,
			...(warning === undefined ? {} : { warning }),
		},
		table: updated,
	};
}

/** Send a batch sequentially; one failure never aborts the rest (F8). */
export async function sendBatch(
	notes: NoteInput[],
	table: MappingTable,
	deps: SendDeps,
	onProgress?: (done: number, total: number, current: SendResult) => void,
	onCheckpoint?: (table: MappingTable) => Promise<void>,
): Promise<{ results: SendResult[]; table: MappingTable }> {
	const results: SendResult[] = [];
	let current = table;
	for (const note of notes) {
		const { result, table: updated } = await sendNote(note, current, deps);
		const changed = updated !== current;
		current = updated;
		results.push(result);
		onProgress?.(results.length, notes.length, result);
		// Every change to the mappings is recorded at once — a landed notebook
		// above all: an interrupted run must not send it again.
		if (changed) await onCheckpoint?.(current);
	}
	return { results, table: current };
}
