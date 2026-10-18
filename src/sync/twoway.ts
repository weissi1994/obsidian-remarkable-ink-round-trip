/**
 * What changed on the tablet, merged into the note itself.
 *
 * The marks are projected onto the note body as it was sent — the text the
 * layout belongs to — and the result is merged three ways with the note as
 * it reads now, so edits made in the vault meanwhile survive. Without that
 * base (a send from before two-way sync, a lost record) or a layout to read
 * against, the changes are appended as a summary block instead.
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

export function mergeTabletChanges(input: TabletChanges): { body: string; outcome: AnnotationOutcome } {
	const projected =
		input.base === null || input.layout === null
			? null
			: projectOntoSource({
					source: input.base,
					layout: input.layout,
					highlights: input.highlights,
					marks: input.marks,
					styles: input.styles,
					erasedAs: input.erasedAs,
				});
	if (projected === null || input.base === null) {
		const summary = renderAnnotationBlock({
			sourcePath: input.sourcePath,
			sourceName: input.sourceName,
			highlights: input.highlights,
			marks: input.marks,
			inSourceNote: true,
			styles: input.styles,
			erasedAs: input.erasedAs,
			importedAt: input.importedAt,
		});
		return { body: upsertAnnotationBlock(input.ours, summary.text), outcome: summary.outcome };
	}
	const merged = merge3(input.base, input.ours, projected.markdown);
	return {
		body: merged.text,
		outcome: { form: "copy", unplaced: projected.unplaced.length, conflicts: merged.conflicts },
	};
}
