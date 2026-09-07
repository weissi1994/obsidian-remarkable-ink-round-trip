/**
 * Send orchestration (PRD F1, F8-basis): note → preprocess → PDF → upload,
 * with per-file results for batch runs. Pure logic over injected adapters so
 * the whole flow is unit-testable without Obsidian or a device.
 */

import { preprocess, parseFrontmatter, EmbedResolver } from "../preprocess/preprocess";
import { canonicalText } from "../convert/textdoc";
import {
	imageRefTargets,
	parseBlocks,
	substituteDiagrams,
	substituteVaultImages,
} from "../convert/mdblocks";
import { renderPdf, resolveLayoutOptions, PdfLayoutOptions } from "../convert/pdf";
import type { DiagramImage } from "../convert/mermaid";
import { renderEpub } from "../convert/epub";
import { ensureDocId } from "../id/docid";
import { MappingTable, contentHash, recordUpload } from "../id/mapping";
import type { UploadResult } from "../transport/cloud";

/** Vault access seam: the plugin edge adapts TFile/Vault to this shape. */
export interface NoteInput {
	path: string;
	basename: string;
	content: string;
	/** Current frontmatter value of the docId key, if any. */
	existingDocId?: unknown;
}

/** Document format the settings can choose (PRD F3). */
export type OutputFormat = "pdf" | "epub";

/**
 * Everything one send can deliver: the settings formats plus "text" — the
 * write-mode notebook (F16), an explicit per-send choice, never a default.
 */
export type SendFormat = OutputFormat | "text";

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
	};
	/** Delivered format; PDF is the default because it anchors annotations. */
	format?: SendFormat;
	/** Resolve an embed for a given note (notePath disambiguates targets). */
	resolveEmbed: (linkpath: string, notePath: string) => ReturnType<EmbedResolver>;
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
	/**
	 * Render mermaid fences to PNGs (fork: image blocks). Optional and
	 * DOM-bound: the plugin edge wires in renderMermaidDiagrams; tests and
	 * environments without it send fences as code blocks, exactly as
	 * before. One null slot per failed diagram — substitution keeps that
	 * fence as code. Any thrown error degrades the whole send the same way.
	 */
	renderDiagrams?: (markdown: string) => Promise<(DiagramImage | null)[]>;
	/**
	 * Load standalone vault images (fork: image blocks). Same seam and same
	 * failure rule as renderDiagrams: DOM-bound, so the edge injects it, and
	 * a null slot falls back to the placeholder text the plugin has always
	 * produced. Targets arrive in occurrence order.
	 */
	resolveImages?: (targets: string[], notePath: string) => Promise<(DiagramImage | null)[]>;
	/** Turn standalone images into pictures rather than placeholder text. */
	imagesAsBlocks?: boolean;
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
		const body =
			format === "text"
				? parseFrontmatter(note.content).body
				: preprocess(note.content, {
						resolveEmbed: (linkpath) => deps.resolveEmbed(linkpath, note.path),
						frontmatterAsTitleBlock: deps.frontmatterAsTitleBlock,
						imagesAsBlocks: deps.imagesAsBlocks,
					});
		const markdown = typeof body === "string" ? body : body.markdown;
		let diagrams: (DiagramImage | null)[] = [];
		let pictures: (DiagramImage | null)[] = [];
		const missingEmbeds = typeof body === "string" ? [] : body.missingEmbeds;
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
		if (format === "text") {
			if (deps.client.uploadText === undefined) {
				throw new Error(
					"Editable-text sends need the reMarkable sync API, which is not available right now.",
				);
			}
			upload = await deps.client.uploadText(note.basename, markdown, { parentId });
		} else {
			let blocks = parseBlocks(markdown);
			// Diagrams render only for PDF (fork: image blocks): EPUB reflows
			// and records no geometry to anchor against. The content hash is
			// taken from the markdown above, before substitution, so
			// "unchanged, skip" stays independent of how mermaid renders.
			if (format === "pdf" && deps.renderDiagrams !== undefined) {
				try {
					diagrams = await deps.renderDiagrams(markdown);
				} catch (error) {
					// Degrading to code blocks is correct, but doing it silently hid a
					// ReferenceError for a whole release — say so before falling back.
					console.error("reMarkable Round-Trip: diagram rendering failed", error);
					diagrams = [];
				}
				if (diagrams.length > 0) blocks = substituteDiagrams(blocks, diagrams);
			}
			// Vault pictures, same rules as diagrams: PDF only (EPUB reflows
			// and records no geometry to anchor against), failures fall back
			// to placeholder text, and the hash above is taken before this so
			// "unchanged, skip" never depends on how a picture loaded.
			if (format === "pdf" && deps.resolveImages !== undefined) {
				const targets = imageRefTargets(blocks);
				if (targets.length > 0) {
					try {
						pictures = await deps.resolveImages(targets, note.path);
					} catch (error) {
						console.error(
							"reMarkable Round-Trip: loading vault images failed, sending them as placeholder text",
							error,
						);
						pictures = [];
					}
				}
				// Runs even with nothing loaded: leftover placeholders must
				// become their text form rather than reach the typesetter.
				if (targets.length > 0) blocks = substituteVaultImages(blocks, pictures);
			}
			const bytes =
				format === "epub"
					? await renderEpub(blocks, { title: note.basename, docId })
					: (await renderPdf(blocks, { title: note.basename, docId }, deps.layout)).bytes;
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
			textHash: format === "text" ? contentHash(canonicalText(markdown)) : undefined,
			// EPUB reflows and a text notebook has no fixed page geometry, so
			// only PDF records layout to anchor imported ink against (GP_E3_S8).
			pdfLayout:
				format === "pdf"
					? {
							...resolveLayoutOptions(deps.layout),
							// Recorded per upload so the import replays the
							// same geometry without re-rendering mermaid
							// (fork: image blocks; see mapping.ts).
							...(diagrams.length > 0
								? {
										images: diagrams.map((d) =>
											d === null ? null : { w: d.w, h: d.h },
										),
									}
								: {}),
							...(pictures.length > 0
								? {
										vaultImages: pictures.map((p) =>
											p === null ? null : { w: p.w, h: p.h },
										),
									}
								: {}),
						}
					: undefined,
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
): Promise<{ results: SendResult[]; table: MappingTable }> {
	const results: SendResult[] = [];
	let current = table;
	for (const note of notes) {
		const { result, table: updated } = await sendNote(note, current, deps);
		current = updated;
		results.push(result);
		onProgress?.(results.length, notes.length, result);
	}
	return { results, table: current };
}
