/**
 * What changed on the tablet, merged into the note itself.
 *
 * The marks are projected onto the note body as it was sent — the text the
 * layout belongs to — and the result is merged three ways with the note as
 * it reads now, so edits made in the vault meanwhile survive. Without that
 * base (a send from before two-way sync, a lost record) or a layout to read
 * against, the changes are appended as a summary block instead.
 *
 * A handwritten remark the note already shows is the owner's from then on:
 * its text may have been corrected, the callout moved or reworded. Every
 * import reads the whole notebook again, so without care each sync would
 * offer the old reading once more — as a conflict next to the correction,
 * or, in the summary block, in place of it. The note's version is kept
 * instead; only a remark that had no text yet gets the new reading.
 */

import type { PdfLayout } from "../convert/pdf";
import {
	AnnotationOutcome,
	renderAnnotationBlock,
	upsertAnnotationBlock,
} from "../incoming/annotationnote";
import type { Highlight } from "../incoming/highlights";
import type { MarkStyles } from "../incoming/markstyles";
import type { ImportedMark } from "../incoming/pull";
import { findRemark, remarkIdLine } from "../incoming/remarkid";
import { projectOntoSource } from "../incoming/sourceprojection";
import { merge3 } from "./merge3";

export interface TabletChanges {
	/** The note body as it was sent, or null when unknown. */
	base: string | null;
	/** The note body as it reads now. */
	ours: string;
	layout: PdfLayout | null;
	highlights: Highlight[];
	marks: ImportedMark[];
	styles?: MarkStyles;
	erasedAs?: "delete" | "strikethrough";
	sourcePath: string;
	sourceName: string;
	importedAt: string;
}

/** Remarks are found by id, or by image in notes from before ids. */
const refOf = (mark: ImportedMark) => ({ id: mark.id, image: mark.path });
const isRemark = (mark: ImportedMark) => mark.kind === "note" && (mark.id !== undefined || mark.path !== undefined);

/**
 * The note with what it already shows of the tablet's remarks settled, and
 * the remarks still to place. A remark the note has is not placed again; if
 * its callout has no text yet and the reader now has some, the text goes
 * into that callout, and a callout from before ids gets its id line.
 */
export function settleRemarks(ours: string, marks: ImportedMark[]): { ours: string; marks: ImportedMark[] } {
	const lines = ours.split("\n");
	const rest: ImportedMark[] = [];
	for (const mark of marks) {
		const found = isRemark(mark) ? findRemark(lines.join("\n"), refOf(mark)) : null;
		if (found === null) {
			rest.push(mark);
			continue;
		}
		const quoted = lines[found.end].startsWith(">");
		if (mark.id !== undefined && !found.hasId) lines.splice(found.end + 1, 0, remarkIdLine(mark.id, quoted));
		if (found.text === "" && mark.transcript !== undefined && found.titled) {
			lines.splice(found.start + 1, 0, ...mark.transcript.split("\n").map((line) => `> ${line}`));
		}
	}
	return { ours: lines.join("\n"), marks: rest };
}

/** In the summary block, a remark keeps the text the note gave it. */
function withNoteTexts(ours: string, marks: ImportedMark[]): ImportedMark[] {
	return marks.map((mark) => {
		const text = isRemark(mark) ? findRemark(ours, refOf(mark))?.text : undefined;
		return text === undefined || text === "" ? mark : { ...mark, transcript: text };
	});
}

export function mergeTabletChanges(input: TabletChanges): { body: string; outcome: AnnotationOutcome } {
	const settled = settleRemarks(input.ours, input.marks);
	const projected =
		input.base === null || input.layout === null
			? null
			: projectOntoSource({
					source: input.base,
					layout: input.layout,
					highlights: input.highlights,
					marks: settled.marks,
					styles: input.styles,
					erasedAs: input.erasedAs,
				});
	if (projected === null || input.base === null) {
		const summary = renderAnnotationBlock({
			sourcePath: input.sourcePath,
			sourceName: input.sourceName,
			highlights: input.highlights,
			marks: withNoteTexts(input.ours, input.marks),
			inSourceNote: true,
			styles: input.styles,
			erasedAs: input.erasedAs,
			importedAt: input.importedAt,
		});
		return { body: upsertAnnotationBlock(input.ours, summary.text), outcome: summary.outcome };
	}
	const merged = merge3(input.base, settled.ours, projected.markdown);
	return {
		body: merged.text,
		outcome: { form: "copy", unplaced: projected.unplaced.length, conflicts: merged.conflicts },
	};
}
