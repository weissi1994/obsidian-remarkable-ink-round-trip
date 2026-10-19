/**
 * What changed on the tablet, merged into the note itself.
 *
 * The marks are projected onto the note body as it was sent — the text the
 * layout belongs to — and the result is merged three ways with the note as
 * it reads now, so edits made in the vault meanwhile survive. Without that
 * base (a send from before two-way sync, a lost record) or a layout to read
 * against, the changes are appended as a summary block instead.
 *
 * A handwritten remark the note already shows is not placed again: every
 * import reads the whole notebook, so without care each sync would offer it
 * once more — as a conflict next to the note's callout, or, in the summary
 * block, in place of it. What the callout says depends on who wrote it:
 * text the owner changed stands for good; a reading the plugin wrote and
 * nobody touched (the mark's `replaces`) gives way to a newer, different
 * reading, so remarks read badly before improve as the reader learns.
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
import { findRemark, isRemarkTextLine as isTextLine, remarkIdLine } from "../incoming/remarkid";
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

/** Whether the note's text for a remark is the plugin's own, untouched, and a new reading differs. */
function takesNewReading(mark: ImportedMark, text: string): boolean {
	return mark.replaces !== undefined && text === mark.replaces && mark.transcript !== undefined && mark.transcript !== text;
}

/**
 * The note with what it already shows of the tablet's remarks settled, and
 * the remarks still to place. A remark the note has is not placed again; its
 * callout takes the new reading only while it shows the plugin's untouched
 * earlier one (`replaces`), and a callout from before ids gets its id line.
 * `refreshed` lists the ids whose text was replaced.
 */
export function settleRemarks(
	ours: string,
	marks: ImportedMark[],
): { ours: string; marks: ImportedMark[]; refreshed: string[] } {
	let lines = ours.split("\n");
	const rest: ImportedMark[] = [];
	const refreshed: string[] = [];
	for (const mark of marks) {
		const found = isRemark(mark) ? findRemark(lines.join("\n"), refOf(mark)) : null;
		if (found === null) {
			rest.push(mark);
			continue;
		}
		const quoted = lines[found.end].startsWith(">");
		if (mark.id !== undefined && !found.hasId) lines.splice(found.end + 1, 0, remarkIdLine(mark.id, quoted));
		if (found.titled && takesNewReading(mark, found.text)) {
			// The text lines go; the new reading takes their place under the title.
			const block = lines.slice(found.start + 1, found.end + 1).filter((line) => !isTextLine(line));
			lines = [
				...lines.slice(0, found.start + 1),
				...mark.transcript!.split("\n").map((line) => `> ${line}`),
				...block,
				...lines.slice(found.end + 1),
			];
			if (mark.id !== undefined) refreshed.push(mark.id);
		}
	}
	return { ours: lines.join("\n"), marks: rest, refreshed };
}

/** In the summary block, a remark keeps the note's text unless it is the plugin's untouched reading. */
function withNoteTexts(ours: string, marks: ImportedMark[], refreshed: string[]): ImportedMark[] {
	return marks.map((mark) => {
		const text = isRemark(mark) ? findRemark(ours, refOf(mark))?.text : undefined;
		if (text === undefined) return mark;
		if (takesNewReading(mark, text)) {
			if (mark.id !== undefined) refreshed.push(mark.id);
			return mark;
		}
		return text === "" ? mark : { ...mark, transcript: text };
	});
}

export function mergeTabletChanges(input: TabletChanges): {
	body: string;
	outcome: AnnotationOutcome;
	/** Remarks whose untouched earlier reading was replaced by a new one. */
	refreshed: string[];
} {
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
		const refreshed: string[] = [];
		const summary = renderAnnotationBlock({
			sourcePath: input.sourcePath,
			sourceName: input.sourceName,
			highlights: input.highlights,
			marks: withNoteTexts(input.ours, input.marks, refreshed),
			inSourceNote: true,
			styles: input.styles,
			erasedAs: input.erasedAs,
			importedAt: input.importedAt,
		});
		return { body: upsertAnnotationBlock(input.ours, summary.text), outcome: summary.outcome, refreshed };
	}
	const merged = merge3(input.base, settled.ours, projected.markdown);
	return {
		body: merged.text,
		outcome: { form: "copy", unplaced: projected.unplaced.length, conflicts: merged.conflicts },
		refreshed: settled.refreshed,
	};
}
