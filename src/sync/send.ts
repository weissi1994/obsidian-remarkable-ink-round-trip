/**
 * Send orchestration (PRD F1, F8-basis): note → preprocess → PDF → upload,
 * with per-file results for batch runs. Pure logic over injected adapters so
 * the whole flow is unit-testable without Obsidian or a device.
 */

import {
	preprocess,
	parseFrontmatter,
	EmbedResolver,
} from "../preprocess/preprocess";
import { canonicalText } from "../convert/textdoc";
import { parseBlocks } from "../convert/mdblocks";
import {
	renderPdf,
	resolveLayoutOptions,
	PdfLayoutOptions,
} from "../convert/pdf";
import { renderEpub } from "../convert/epub";
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

/** Document file formats the upload client takes (PRD F3). */
export type OutputFormat = "pdf" | "epub";

/** What the settings can choose: a review file, or a handwritten notebook (ink fork). */
export type SettingsFormat = OutputFormat | "ink";

/**
 * Everything one send can deliver: the settings formats plus "text" — the
 * write-mode notebook (F16), an explicit per-send choice, never a default.
 */
export type SendFormat = SettingsFormat | "text";

export interface SendDeps {
	client: {
		upload(
			fileName: string,
			bytes: Uint8Array,
			options: { parentId?: string; format: OutputFormat },
		): Promise<UploadResult>;
		/**
		 * Upload the note as an editable typed-text notebook (F16). Optional
		 * because it needs the raw sync API: the plugin edge wires it in
		 * whenever that session exists, and a text send without it fails with
		 * a clear message instead of silently degrading to PDF.
		 */
		uploadText?(
			visibleName: string,
			markdown: string,
			options: { parentId?: string },
		): Promise<UploadResult>;
		/**
		 * Ink fork: upload a notebook of pen-stroke pages. Returns the page ids
		 * it chose, which the import maps back to layout pages.
		 */
		uploadInk?(
			visibleName: string,
			pages: Uint8Array[],
			options: { parentId?: string },
		): Promise<UploadResult & { pageIds: string[] }>;
	};
	/**
	 * Ink fork: turn a note into handwritten pages. Absent means handwriting
	 * is unavailable here (e.g. the owner's hand is selected but missing),
	 * and an ink send fails with a clear message.
	 */
	ink?: {
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
		persistSent?(
			docId: string,
			sent: {
				title: string;
				markdown: string;
				images?: Record<string, InkImage>;
				drawings?: Record<string, InkDrawing>;
			},
		): Promise<void>;
	};
	/** Delivered format; PDF is the default because it anchors annotations. */
	format?: SendFormat;
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
	format: SendFormat,
	resolveEmbed: (
		linkpath: string,
		notePath: string,
	) => ReturnType<EmbedResolver>,
	frontmatterAsTitleBlock = false,
): { markdown: string; missingEmbeds: string[] } {
	if (format === "text") {
		return { markdown: parseFrontmatter(note.content).body, missingEmbeds: [] };
	}
	const processed = preprocess(note.content, {
		resolveEmbed: (linkpath) => resolveEmbed(linkpath, note.path),
		frontmatterAsTitleBlock,
	});
	return processed;
}

export function notesNeedingUpload(
	notes: NoteInput[],
	table: MappingTable,
	format: SendFormat,
	resolveEmbed: (
		linkpath: string,
		notePath: string,
	) => ReturnType<EmbedResolver>,
	frontmatterAsTitleBlock = false,
): NoteInput[] {
	return notes.filter((note) => {
		if (typeof note.existingDocId !== "string") return true;
		const previous = table[note.existingDocId];
		if (previous === undefined) return true;
		const { markdown } = prepareNoteContent(
			note,
			format,
			resolveEmbed,
			frontmatterAsTitleBlock,
		);
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
		const format: SendFormat = deps.format ?? "pdf";

		// Write-mode (F16): the note BODY travels as editable text, exactly as
		// it is on disk — no embed inlining (an edit inside an inlined embed
		// could never flow back to the right file) and no frontmatter (vault
		// metadata is not text to edit; the note keeps its own frontmatter and
		// the import, GP_E7_S3, leaves it standing). Review formats keep their
		// full preprocessing below.
		const { markdown, missingEmbeds } = prepareNoteContent(
			note,
			format,
			deps.resolveEmbed,
			deps.frontmatterAsTitleBlock,
		);
		const hash = contentHash(markdown);
		if (deps.skipUnchanged && table[docId]?.contentHash === hash) {
			return {
				result: {
					ok: true,
					path: note.path,
					docId,
					deviceDocId: table[docId].deviceDocId,
					missingEmbeds,
					skipped: true,
				},
				table,
			};
		}
		const parentId = deps.resolveParent
			? await deps.resolveParent(note.path)
			: undefined;
		let upload: UploadResult;
		let inkSnapshot: InkSnapshot | undefined;
		if (format === "text") {
			if (deps.client.uploadText === undefined) {
				throw new Error(
					"Editable-text sends need the reMarkable sync API, which is not available right now.",
				);
			}
			upload = await deps.client.uploadText(note.basename, markdown, {
				parentId,
			});
		} else if (format === "ink") {
			if (deps.client.uploadInk === undefined || deps.ink === undefined) {
				throw new Error(
					"Handwritten sends need the reMarkable sync API, which is not available right now.",
				);
			}
			const blocks = parseBlocks(markdown);
			const images = (await deps.ink.loadImages?.(note)) ?? {};
			const drawings = (await deps.ink.loadDrawings?.(markdown)) ?? {};
			const rendered = deps.ink.render(blocks, note.basename, docId, deps.layout, images, drawings);
			// Keep the text BEFORE uploading: a failed write after a landed
			// upload would orphan the notebook and duplicate it on retry.
			await deps.ink.persistSent?.(docId, {
				title: note.basename,
				markdown,
				images: rendered.snapshot.imageStyle === undefined ? undefined : images,
				drawings: Object.keys(drawings).length > 0 ? drawings : undefined,
			});
			const result = await deps.client.uploadInk(note.basename, rendered.pages, { parentId });
			upload = result;
			inkSnapshot = { ...rendered.snapshot, pageIds: result.pageIds };
		} else {
			const blocks = parseBlocks(markdown);
			const bytes =
				format === "epub"
					? await renderEpub(blocks, { title: note.basename, docId })
					: (
							await renderPdf(
								blocks,
								{ title: note.basename, docId },
								deps.layout,
							)
						).bytes;
			upload = await deps.client.upload(`${note.basename}.${format}`, bytes, {
				parentId,
				format,
			});
		}

		const previous = table[docId];
		if (
			deps.replacePrevious &&
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
			// The import routes branch on this: annotation pull skips "text"
			// documents (their import is the write-mode route, GP_E7_S3).
			format,
			// What an unedited device copy reads back as (GP_E7_S3) — the
			// import's "was the device actually edited?" reference.
			textHash:
				format === "text" ? contentHash(canonicalText(markdown)) : undefined,
			// EPUB reflows and a text notebook has no fixed page geometry, so
			// only PDF records layout to anchor imported ink against (GP_E3_S8).
			pdfLayout:
				format === "pdf" || format === "ink" ? resolveLayoutOptions(deps.layout) : undefined,
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
	let successfulSinceCheckpoint = 0;
	for (const note of notes) {
		const { result, table: updated } = await sendNote(note, current, deps);
		current = updated;
		results.push(result);
		onProgress?.(results.length, notes.length, result);
		if (notes.length > 20 && result.ok) {
			successfulSinceCheckpoint += 1;
			if (successfulSinceCheckpoint === 20) {
				await onCheckpoint?.(current);
				successfulSinceCheckpoint = 0;
			}
		}
	}
	return { results, table: current };
}
