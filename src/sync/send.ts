/**
 * Send orchestration (PRD F1, F8-basis): note → preprocess → handwritten
 * notebook → upload, with per-file results for batch runs. Pure logic over
 * injected adapters so the whole flow is unit-testable without Obsidian or a
 * device.
 */

import { preprocess, splitNote, EmbedResolver } from "../preprocess/preprocess";
import { parseBlocks } from "../convert/mdblocks";
import { resolveLayoutOptions, PdfLayoutOptions } from "../convert/pdf";
import { ensureDocId } from "../id/docid";
import { InkSnapshot, MappingTable, contentHash, recordUpload } from "../id/mapping";
import type { Block } from "../convert/mdblocks";
import type { InkImage } from "../ink/inkimage";
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
	images?: Record<string, InkImage>;
	drawings?: Record<string, InkDrawing>;
}

export interface SendDeps {
	client: {
		/**
		 * Upload a notebook of pen-stroke pages. Returns the page ids it
		 * chose, which the import maps back to layout pages.
		 */
		uploadInk(
			visibleName: string,
			pages: Uint8Array[],
			/** `replaces`: the previous notebook, trashed in the same cloud update. */
			options: { parentId?: string; replaces?: string },
		): Promise<UploadResult & { pageIds: string[]; replaced?: boolean }>;
	};
	/** Turn a note into handwritten pages. */
	ink: {
		render(
			blocks: Block[],
			title: string,
			docId: string,
			layout: PdfLayoutOptions | undefined,
			images?: Record<string, InkImage>,
			drawings?: Record<string, InkDrawing>,
		): { pages: Uint8Array[]; snapshot: Omit<InkSnapshot, "pageIds"> };
		/** The note's Mermaid diagrams, traced, by diagramKey(source). */
		loadDrawings?(markdown: string): Promise<Record<string, InkDrawing>>;
		/** The note's embedded pictures, quantised, by placeholder name. */
		loadImages?(note: NoteInput): Promise<Record<string, InkImage>>;
		/** Keep the sent text, so the import can regenerate it after edits. */
		persistSent?(docId: string, sent: SentRecord): Promise<void>;
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
	 * Retire the previous device copy after a successful re-upload
	 * (idempotent re-send, N3). Failures are non-fatal: the old copy then
	 * simply lingers, which is the pre-mirroring behavior.
	 */
	replacePrevious?: (previousDeviceDocId: string) => Promise<void>;
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
	try {
		const { docId, isNew } = ensureDocId(note.existingDocId);
		if (isNew) await deps.persistDocId(note, docId);
		const { markdown, missingEmbeds } = prepareNoteContent(
			note,
			deps.resolveEmbed,
			deps.frontmatterAsTitleBlock,
		);
		const hash = contentHash(markdown);
		const current = table[docId];
		if (deps.skipUnchanged && current?.format === "ink" && current.contentHash === hash) {
			return {
				result: {
					ok: true,
					path: note.path,
					docId,
					deviceDocId: current.deviceDocId,
					missingEmbeds,
					skipped: true,
				},
				table,
			};
		}
		const parentId = deps.resolveParent
			? await deps.resolveParent(note.path)
			: undefined;
		const blocks = parseBlocks(markdown, { html: true });
		const images = (await deps.ink.loadImages?.(note)) ?? {};
		const drawings = (await deps.ink.loadDrawings?.(markdown)) ?? {};
		const rendered = deps.ink.render(blocks, note.basename, docId, deps.layout, images, drawings);
		// Keep the text BEFORE uploading: a failed write after a landed
		// upload would orphan the notebook and duplicate it on retry.
		await deps.ink.persistSent?.(docId, {
			title: note.basename,
			markdown,
			body: splitNote(note.content).body,
			images: rendered.snapshot.imageStyle === undefined ? undefined : images,
			drawings: Object.keys(drawings).length > 0 ? drawings : undefined,
		});
		const upload = await deps.client.uploadInk(note.basename, rendered.pages, {
			parentId,
			replaces: deps.replacePrevious === undefined ? undefined : current?.deviceDocId,
		});
		const inkSnapshot: InkSnapshot = { ...rendered.snapshot, pageIds: upload.pageIds };

		const previous = table[docId];
		if (
			deps.replacePrevious &&
			upload.replaced !== true &&
			previous !== undefined &&
			previous.deviceDocId !== upload.deviceDocId
		) {
			try {
				await deps.replacePrevious(previous.deviceDocId);
			} catch {
				// Non-fatal: the old device copy lingers (pre-mirroring behavior).
			}
		}

		const updated = recordUpload(table, {
			docId,
			notePath: note.path,
			deviceDocId: upload.deviceDocId,
			contentHash: hash,
			format: "ink",
			pdfLayout: resolveLayoutOptions(deps.layout),
			// Ink fork: everything the import needs to regenerate the strokes.
			ink: inkSnapshot,
		});
		return {
			result: {
				ok: true,
				path: note.path,
				docId,
				deviceDocId: upload.deviceDocId,
				missingEmbeds,
			},
			table: updated,
		};
	} catch (error) {
		return {
			result: {
				ok: false,
				path: note.path,
				error: error instanceof Error ? error.message : String(error),
			},
			table,
		};
	}
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
		current = updated;
		results.push(result);
		onProgress?.(results.length, notes.length, result);
		// Every notebook that landed is recorded at once: a batch interrupted
		// half-way must not send them again — the cloud limits how fast it goes.
		if (notes.length > 1 && result.ok && result.skipped !== true) await onCheckpoint?.(current);
	}
	return { results, table: current };
}
