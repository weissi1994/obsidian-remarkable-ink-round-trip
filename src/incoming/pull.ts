/**
 * Pull orchestration for the incoming route (PRD F10/F11; design:
 * docs/ontwerp-inkomende-route.md).
 *
 * Walks the known mappings, skips documents whose device hash has not
 * changed since the last import, downloads the highlight files of the rest,
 * and hands the result to the vault writer. Pure over injected adapters, so
 * the whole flow is testable without a device.
 */

import { PdfLayout } from "../convert/pdf";
import { MappingEntry, MappingTable } from "../id/mapping";
import type { AnnotationOutcome } from "./annotationnote";
import type { Highlight } from "./highlights";
import type { EmptyTask, MarkKind } from "./marks";
import type { Stroke } from "./rmlines";
import type { InkRender } from "../ink/inkrender";
import type { RemarkPlace } from "../ink/inkimage";
import type { ReaderName } from "../ocr/samples";
import { collectInkAnnotations } from "./inkpull";

/** One file belonging to a device document. */
export interface DocumentFile {
	/** Path within the document, e.g. "<doc>.highlights/<page>.json". */
	id: string;
	hash: string;
}

/** What a document turned out to contain — the basis for diagnostics. */
export interface DocumentScan {
	totalFiles: number;
	/** `.highlights/*.json` files: selected *text*. */
	highlightFiles: number;
	/** `.rm` files: pen strokes, including the freehand highlighter. */
	strokeFiles: number;
	parsedHighlights: number;
	/** Files we could not read; they were skipped, not fatal. */
	unreadableFiles: number;
	/** Pages that yielded at least one annotation (F12). */
	renderedPages: number;
	/** Individual remarks found; a page can hold several (GP_E3_S8). */
	renderedRemarks: number;
	/** Remarks that could be tied to the source text (GP_E3_S8). */
	anchoredRemarks: number;
	/** Marks read as strike-through, circle, margin bar or arrow (GP_E3_S9). */
	interpretedMarks: number;
	/** Text highlights found inside the `.rm` pen layer (GP_E3_S11). */
	highlightsInStrokes: number;
	/** Pages the reader added on the device to write on (GP_E3_S20). */
	addedPages: number;
	/** Why anchoring was unavailable, when it was. */
	anchorSkipped?: "no-layout";
	/** Ink fork: what happened to the generated handwriting. */
	ink?: {
		erasedWords: number;
		movedWords: number;
		partialWords: number;
		ownStrokes: number;
		transcribed: number;
		/**
		 * Which reader produced the transcribed remarks, and how sure it was —
		 * count and summed score per reader, averaged at render time. Optional so
		 * older scans (and runs that read nothing) stay valid. Endpoint readings
		 * carry no score, so they contribute 0 to the sum.
		 */
		readers?: Partial<Record<ReaderName, { count: number; scoreSum: number }>>;
	};
	/** How the vault block came out: annotated copy or summary (GP_E3_S14). */
	written?: WriteOutcome;
	/** How the note relates to what was sent (F14, GP_E3_S3). */
	sourceState?: SourceState;
}

/** What the vault writer made of one document's annotations (GP_E3_S14). */
export type WriteOutcome = AnnotationOutcome;

/**
 * How the note in the vault relates to the document that was sent (F14,
 * GP_E3_S3).
 *
 * - `match` — unchanged; annotations land where they belong.
 * - `changed` — edited since it was sent, so the page geometry no longer
 *   describes this text. Annotations still come back, but unanchored.
 * - `moved` — found again elsewhere in the vault by its document id.
 * - `missing` — no note in the vault carries this document id any more.
 * - `no-snapshot` — sent before the plugin recorded typography (or as EPUB).
 */
export type SourceState =
	| "match"
	| "changed"
	| "moved"
	| "missing"
	| "no-snapshot";

/** One annotation as it will appear in the vault (GP_E3_S9). */
export interface ImportedMark {
	kind: MarkKind;
	/** Page in the source document, when it could be determined. */
	page?: number;
	/** The words the mark points at. */
	target?: string;
	/** Ids of the covered words, for the annotated copy (GP_E3_S12). */
	words?: number[];
	/** Source blocks a margin bar spans. */
	blocks?: number[];
	/** The line the mark sits against, for context. */
	quote?: string;
	/** On a task item with no text, which has no words to point at (marks.ts EmptyTask). */
	task?: EmptyTask;
	/** Vault path of the rendered ink; only kinds that need a picture have one. */
	path?: string;
	/**
	 * This is a whole page the reader added on the device, not a mark on the
	 * source text (GP_E3_S20).
	 */
	addedPage?: number;
	/**
	 * Ink fork: handwriting read as text by the configured OCR endpoint.
	 * Opt-in; the image stays alongside unless the owner turned it off.
	 */
	transcript?: string;
	/**
	 * Ink fork: the reading may go into the note as text where it was
	 * written (ocr/samples.ts isConfidentReading); else the ink goes in as an
	 * image there (inkRemarksForm "inline").
	 */
	confident?: boolean;
	/** Ink fork: written on a printed row — beside its text, on its task, in its margin — not between rows. */
	onRow?: boolean;
	/** Ink fork: the table column under the remark, when it sits on a table row (0-based). */
	column?: number;
	/**
	 * Ink fork: the remark's id, a hash of its ink (remarkid.ts). Names its
	 * image and marks its callout, so it is found again in the note.
	 */
	id?: string;
	/**
	 * Ink fork: the text the plugin last wrote for this remark, when the owner
	 * never corrected it. A callout still showing exactly this takes the new
	 * reading; any other text in the note is the owner's and stays.
	 */
	replaces?: string;
	/** Ink fork: the owner confirmed this reading (✓); kept when the remark is written again. */
	confirmed?: boolean;
	/** Ink fork, kind "moved": insert the moved words after this word id… */
	moveAfter?: number;
	/** …or before this one, when they landed at the start of a line. */
	moveBefore?: number;
	/** Ink fork: a remark's strokes, device units, so a remark the owner added strokes to is recognised (sync/twoway.ts). */
	strokes?: { x: number; y: number }[][];
	/** Ink fork, kind "skipped": why this tablet change could not be read or applied — listed in the note's “Pending from reMarkable” callout. */
	unapplied?: string;
	/** Ink fork, kind "skipped": a whole page went unread (not downloadable, unreadable, or no longer matching what was sent), so this import cannot say what changed on it — the merge must not take its text as the tablet's (sync/twoway.ts). */
	unreadPage?: boolean;
	/**
	 * Ink fork, kind "note": text typed on the tablet, as markdown. It goes
	 * into the note as it is — plain text, no callout — where a free remark
	 * on its page would.
	 */
	typed?: string;
	/**
	 * Ink fork, with `typed`: its page's id and text as a block id
	 * (remarkid.ts typedTextId), written after the text in the note, so text
	 * the note took in is not placed a second time once the owner edited it,
	 * and its page goes on the next send.
	 */
	typedId?: string;
	/**
	 * Ink fork, typed-text notebooks: the whole typed text of the notebook's
	 * page as markdown, the tablet's side of the merge (sync/twoway.ts). One
	 * mark per import carries it.
	 */
	tabletText?: string;
	/** Ink fork, typed-text notebooks: a remark goes after this paragraph of `tabletText` (0-based; -1 before the first). */
	afterParagraph?: number;
}

/** What the edge needs to paint one remark. */
export interface StrokeRenderRequest {
	deviceDocId: string;
	strokes: Stroke[];
	/** Page number when known, else the ordinal of the stroke file. */
	page: number;
	/** 1-based index of this remark within its page. */
	remark: number;
	/** Ink fork: a whole page the owner added, not a margin remark (OCR prompt). */
	wholePage?: boolean;
	/** Ink fork: the table column under the remark, when it sits on a table row (0-based). */
	column?: number;
	/** Ink fork: highlighter drawn over the remark's own handwriting. */
	inkHighlights?: InkHighlight[];
	/** Ink fork: where the remark sits relative to the row it was written against. */
	at?: RemarkPlace;
}

/** Highlighter strokes over handwriting, device units, with the colour they carry. */
export interface InkHighlight {
	strokes: { x: number; y: number }[][];
	rgb: string;
}

export interface PullDeps {
	/** Current device documents, by cloud document id → content hash. */
	listDocumentHashes: () => Promise<Map<string, string>>;
	/** Files belonging to a device document at the given hash. */
	listDocumentFiles: (
		deviceDocId: string,
		hash: string,
	) => Promise<DocumentFile[]>;
	/** Text contents of one document file. */
	readFile: (file: DocumentFile) => Promise<string>;
	/** Raw bytes of one document file (for `.rm` stroke pages). */
	readBytes?: (file: DocumentFile) => Promise<Uint8Array>;
	/**
	 * Paint one remark and return the vault path of the embed. Absent means
	 * handwriting import is switched off.
	 */
	renderStrokes?: (request: StrokeRenderRequest) => Promise<string | null>;
	/** Diagnostic sink; the plugin edge collects these for the user. */
	log?: (line: string) => void;
	/**
	 * Ink fork: regenerate the handwritten notebook exactly as it was sent —
	 * layout and every generated stroke — so the import can tell the owner's
	 * ink from the plugin's. Null when it cannot be reproduced.
	 */
	loadInk?: (entry: MappingEntry) => Promise<InkRender | null>;
	/**
	 * Ink fork: read handwriting as text (opt-in OCR). Absent = off. Returns
	 * null when the endpoint saw no words.
	 */
	transcribe?: (
		request: StrokeRenderRequest & { quote?: string },
	) => Promise<{ text: string; by?: ReaderName; score?: number; confident?: boolean } | null>;
	/** Keep the ink image next to a transcript (default true). */
	keepImageWithTranscript?: boolean;
	/**
	 * Reproduce the page layout of the document as it was sent, so ink can be
	 * quoted against the text it sits on (GP_E3_S8). Returning null — no
	 * snapshot, EPUB, or a source note that changed since — costs the quotes
	 * and nothing else.
	 */
	loadLayout?: (entry: MappingEntry) => Promise<PdfLayout | null>;
	/**
	 * Whether the note still matches the document that was sent (F14). A
	 * changed note is not an error — the annotations are real — but the reader
	 * has to know that they describe an older version.
	 */
	checkSource?: (entry: MappingEntry) => Promise<SourceState>;
	/**
	 * Persist the rendered annotations for one source note. The outcome says
	 * whether it became an annotated copy or fell back to a summary — a silent
	 * fallback cost the owner two test rounds (GP_E3_S14).
	 */
	writeAnnotations: (
		entry: MappingEntry,
		highlights: Highlight[],
		marks: ImportedMark[],
		/** How the note relates to what was sent, so the block can say so (F14). */
		sourceState?: SourceState,
	) => Promise<WriteOutcome | void>;
	/** Re-import even when the device hash is unchanged. */
	force?: boolean;
	/** Let pending outgoing work run between documents. */
	yieldToPush?: () => Promise<void>;
	/** False when a yielded push replaced this mapping before it was read. */
	isCurrent?: (entry: MappingEntry) => boolean;
}

export interface PullSuccess {
	ok: true;
	docId: string;
	notePath: string;
	highlightCount: number;
	/** True when nothing changed on the device and the note was left alone. */
	skipped?: boolean;
	/** Why it was skipped, for the diagnostic report. */
	skipReason?: "unchanged" | "not-on-device" | "superseded" | "legacy";
	scan?: DocumentScan;
}

export interface PullFailure {
	ok: false;
	docId: string;
	notePath: string;
	error: string;
}

export type PullResult = PullSuccess | PullFailure;

/**
 * Apply pull-owned mapping changes without overwriting a push that completed
 * while an account-wide pull yielded. Pulls only update accountedHash, and
 * only while nothing else moved it since the pull took its scope: an update
 * in place keeps the notebook's id, so a changed id alone would miss it, and
 * the older hash written back would have the notebook read again, against
 * the newer send.
 */
export function mergePullMappings(
	current: MappingTable,
	scope: MappingTable,
	pulled: MappingTable,
): MappingTable {
	const merged = { ...current };
	for (const [docId, original] of Object.entries(scope)) {
		const latest = merged[docId];
		const result = pulled[docId];
		if (latest?.deviceDocId !== original.deviceDocId || latest.accountedHash !== original.accountedHash || result === undefined) {
			continue;
		}
		merged[docId] = { ...latest, accountedHash: result.accountedHash };
	}
	return merged;
}

/** Kinds the text says everything about; a picture of the ink adds nothing. */
export const TEXT_ONLY_KINDS = new Set<MarkKind>([
	"strikethrough",
	"underline",
	"circle",
	"margin",
	// A tick rewrites its task's marker (GP_E5_S12); an image of the tick
	// itself would be noise — and without this entry the whole feature
	// vanished when handwriting import was off (reviewvondst).
	"checkbox",
	"checkbox-cancel",
	"erased",
	"moved",
]);

/**
 * Import annotations for every known mapping. Never throws: each document
 * comes back as its own result (same discipline as the outgoing batch).
 */
export async function pullAnnotations(
	table: MappingTable,
	deps: PullDeps,
	onProgress?: (done: number, total: number, current: PullResult) => void,
): Promise<{ results: PullResult[]; table: MappingTable }> {
	const entries = Object.values(table);
	const results: PullResult[] = [];
	let updated = table;

	let hashes: Map<string, string>;
	try {
		hashes = await deps.listDocumentHashes();
	} catch (error) {
		// Cannot reach the device at all: report once per mapping rather than
		// pretending some succeeded.
		const message = error instanceof Error ? error.message : String(error);
		return {
			results: entries.map((entry) => ({
				ok: false as const,
				docId: entry.docId,
				notePath: entry.notePath,
				error: message,
			})),
			table,
		};
	}

	deps.log?.(
		`${entries.length} mapped note(s); ${hashes.size} document(s) on the account`,
	);

	for (const entry of entries) {
		await deps.yieldToPush?.();
		const hash = hashes.get(entry.deviceDocId);
		let result: PullResult;
		try {
			deps.log?.(`${entry.notePath} → device ${entry.deviceDocId}`);
			if (deps.isCurrent?.(entry) === false) {
				deps.log?.("  superseded by a newer push — skipped");
				result = {
					ok: true,
					docId: entry.docId,
					notePath: entry.notePath,
					highlightCount: 0,
					skipped: true,
					skipReason: "superseded",
				};
			} else if (hash === undefined) {
				// Gone from the account (deleted on the tablet, trash emptied):
				// the lifecycle archives its note (sync/reconcile.ts); the
				// mapping stays, so the note is never sent as a duplicate.
				deps.log?.("  not on the account — skipped");
				result = {
					ok: true,
					docId: entry.docId,
					notePath: entry.notePath,
					highlightCount: 0,
					skipped: true,
					skipReason: "not-on-device",
				};
			} else if (entry.format !== "ink") {
				// Sent as PDF, EPUB or editable text by an earlier version: not
				// read any more. The next sync re-sends the note as handwriting.
				deps.log?.(`  ${entry.format ?? "pdf"} document from an earlier version — not read`);
				result = {
					ok: true,
					docId: entry.docId,
					notePath: entry.notePath,
					highlightCount: 0,
					skipped: true,
					skipReason: "legacy",
				};
			} else if (!deps.force && entry.accountedHash === hash) {
				deps.log?.(
					`  unchanged since last import (${hash.slice(0, 8)}…) — skipped`,
				);
				result = {
					ok: true,
					docId: entry.docId,
					notePath: entry.notePath,
					highlightCount: 0,
					skipped: true,
					skipReason: "unchanged",
				};
			} else {
				const { highlights, scan, marks } = await collectInkAnnotations(entry, hash, deps);
				const written = await deps.writeAnnotations(
					entry,
					highlights,
					marks,
					scan.sourceState,
				);
				if (written) scan.written = written;
				if (written?.reason === "no-source") {
					// The note is not in the vault (moved out, deleted, not synced
					// here yet): its ink went nowhere. The hash stays, so the
					// notebook is read again once the note is back.
					throw new Error("Its note is not in the vault, so the ink on the tablet was not brought in; it is read again once the note is back.");
				}
				updated = {
					...updated,
					[entry.docId]: { ...entry, accountedHash: hash },
				};
				result = {
					ok: true,
					docId: entry.docId,
					notePath: entry.notePath,
					highlightCount: highlights.length,
					scan,
				};
			}
		} catch (error) {
			deps.log?.(
				`  failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			result = {
				ok: false,
				docId: entry.docId,
				notePath: entry.notePath,
				error: error instanceof Error ? error.message : String(error),
			};
		}
		results.push(result);
		onProgress?.(results.length, entries.length, result);
	}

	return { results, table: updated };
}
