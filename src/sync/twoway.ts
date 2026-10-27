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
 * reading that scores better (see withEarlierReadings), so remarks read
 * badly before improve as the reader learns. A reading the owner confirmed
 * (✓ in the title) is never replaced. A remark the owner wrote more on is
 * a new id with mostly the old ink: its callout is found by that ink and
 * takes the new id instead of a second callout appearing.
 *
 * Nothing the tablet changed is dropped silently: what the import could not
 * read, and what the projection could not apply, is listed in one “Pending
 * from reMarkable” callout at the end of the note, replaced by every import
 * and gone once nothing is pending.
 *
 * Once a merge is written, the tablet's text it merged (`projected`) is the
 * base of the next one (`mergedBase`), until the note is sent again: merged
 * against the text as sent, every later import would apply the same tablet
 * changes on top of themselves. Remark callouts placed since the send are
 * the note's from then on, kept out of that base and the tablet's text
 * alike — what the note does with them, rereading aside, stands. An import
 * that left a page unread merges against the text as sent: against the
 * last merge's, that page's changes would look undone.
 *
 * Text typed on a handwritten page comes in as a mark carrying it, placed
 * like a free remark on its page. A typed-text notebook needs no
 * projection: the page's text is the tablet's side as it is
 * (sync/typednote.ts projectTyped), its ink placed after the paragraph it
 * belongs to.
 *
 * Pure and synchronous: the write runs it again on the note as it is at
 * that moment.
 */

import type { PdfLayout } from "../convert/pdf";
import {
	AnnotationOutcome,
	PendingChange,
	pendingLine,
	renderAnnotationBlock,
	upsertAnnotationBlock,
	withoutPendingCallout,
	withPendingCallout,
} from "../incoming/annotationnote";
import type { Highlight } from "../incoming/highlights";
import type { MarkStyles } from "../incoming/markstyles";
import type { ImportedMark } from "../incoming/pull";
import {
	findRemark,
	isRemarkIdLine,
	isRemarkTextLine as isTextLine,
	isSameRemark,
	REMARK_ID_PREFIX,
	remarkIdLine,
} from "../incoming/remarkid";
import { projectOntoSource } from "../incoming/sourceprojection";
import { merge3 } from "./merge3";
import { projectTyped } from "./typednote";

/** A remark's ink as an earlier import kept it, and the plugin's reading of it while the owner never changed it. */
export type KeptRemark = { strokes: { x: number; y: number }[][]; text?: string };

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
	/** A remark the note shows, by id, as kept from an earlier import; null when nothing was kept. */
	remarkInk?: (id: string) => KeptRemark | null;
	/** The tablet's text the note was last merged with since it was sent: that merge's `projected`. */
	mergedBase?: string;
}

const remarkIdOf = new RegExp(`\\^${REMARK_ID_PREFIX}([0-9a-f]+)`);

/** Ids of the remark callouts in a text. */
function remarkIds(text: string): Set<string> {
	return new Set(text.split("\n").flatMap((line) => (isRemarkIdLine(line) ? [remarkIdOf.exec(line)![1]] : [])));
}

/**
 * The text without the callouts of these remarks, and the blank line one
 * left behind — the reverse of how the projection puts a remark in.
 */
function withoutRemarks(text: string, ids: Set<string>): string {
	let lines = text.split("\n");
	for (const id of ids) {
		const found = findRemark(lines.join("\n"), { id });
		if (found === null) continue;
		const after = found.end + 1;
		const blankAfter = after >= lines.length || lines[after].trim() === "";
		let from = found.start;
		let to = found.end;
		if (from > 0 && lines[from - 1].trim() === "" && blankAfter) from--;
		else if (from === 0 && after < lines.length && lines[after].trim() === "") to++;
		lines = [...lines.slice(0, from), ...lines.slice(to + 1)];
	}
	return lines.join("\n");
}

/** Remarks are found by id, or by image in notes from before ids. */
const refOf = (mark: ImportedMark) => ({ id: mark.id, image: mark.path });
const isRemark = (mark: ImportedMark) => mark.kind === "note" && (mark.id !== undefined || mark.path !== undefined);

/** Whether the note's text for a remark is the plugin's own, untouched, and a new reading differs. */
function takesNewReading(mark: ImportedMark, text: string): boolean {
	return mark.replaces !== undefined && text === mark.replaces && mark.transcript !== undefined && mark.transcript !== text;
}

/**
 * The callout of a remark the owner has since written more on, or erased
 * part of: one whose remark is no longer on the tablet as it was, and whose
 * kept ink is mostly this mark's (isSameRemark). It is pointed at the new
 * remark — id line and image — so it is settled like any remark the note
 * shows. Returns the note's lines and the plugin's reading of the old ink,
 * when the owner never changed it; null when no callout matches.
 */
function rebindChangedRemark(
	lines: string[],
	mark: ImportedMark,
	current: Set<string>,
	remarkInk: (id: string) => KeptRemark | null,
): { lines: string[]; text?: string } | null {
	if (mark.id === undefined || mark.strokes === undefined) return null;
	const idOf = new RegExp(`\\^${REMARK_ID_PREFIX}([0-9a-f]+)`);
	for (let at = 0; at < lines.length; at++) {
		if (!isRemarkIdLine(lines[at])) continue;
		const id = idOf.exec(lines[at])![1];
		if (current.has(id)) continue;
		const kept = remarkInk(id);
		if (kept === null) continue;
		const found = findRemark(lines.join("\n"), { id });
		if (found === null) continue;
		const block = lines.slice(found.start, found.end + 1);
		const imageAt = block.findIndex((line) => line.includes("![["));
		const image = imageAt === -1 ? undefined : /!\[\[([^\]|]+)/.exec(block[imageAt])?.[1];
		// Remark images are named `<doc>-p<page>-<id>.png`.
		const page = image === undefined ? undefined : Number(/-p(\d+)-[^/]*$/.exec(image)?.[1] ?? NaN);
		const known = { page: Number.isFinite(page) ? page : undefined, strokes: kept.strokes };
		if (!isSameRemark(known, { page: mark.addedPage ?? mark.page, strokes: mark.strokes })) continue;
		const next = [...lines];
		next[at] = lines[at].replace(idOf, `^${REMARK_ID_PREFIX}${mark.id}`);
		const prefix = /^(\s*(?:>\s?)*)/.exec(lines[at])![1];
		if (imageAt !== -1 && image !== undefined) {
			if (mark.path === undefined) next.splice(found.start + imageAt, 1);
			else next[found.start + imageAt] = block[imageAt].replace(`![[${image}]]`, `![[${mark.path}]]`);
		} else if (mark.path !== undefined) {
			next.splice(at, 0, `${prefix}![[${mark.path}]]`);
		}
		return { lines: next, text: kept.text };
	}
	return null;
}

/**
 * The note with what it already shows of the tablet's remarks settled, and
 * the remarks still to place. A remark the note has is not placed again; its
 * callout takes the new reading only while it shows the plugin's untouched
 * earlier one (`replaces`), and a callout from before ids gets its id line.
 * A remark whose ink changed takes over its old callout (rebindChangedRemark),
 * whose text gives way to the new reading on the same terms.
 * `refreshed` lists the ids whose text was replaced.
 */
export function settleRemarks(
	ours: string,
	marks: ImportedMark[],
	remarkInk?: (id: string) => KeptRemark | null,
): { ours: string; marks: ImportedMark[]; refreshed: string[] } {
	let lines = ours.split("\n");
	const rest: ImportedMark[] = [];
	const refreshed: string[] = [];
	// A callout whose remark is still on the tablet as it was belongs to that remark.
	const current = new Set(marks.flatMap((mark) => (mark.id === undefined ? [] : [mark.id])));
	for (const mark of marks) {
		let found = isRemark(mark) ? findRemark(lines.join("\n"), refOf(mark)) : null;
		// Rebound to the callout of its earlier ink: that callout's text is the
		// plugin's while it is empty or the reading the plugin last wrote.
		let pluginText = false;
		if (found === null && isRemark(mark) && remarkInk !== undefined) {
			const rebound = rebindChangedRemark(lines, mark, current, remarkInk);
			if (rebound !== null) {
				lines = rebound.lines;
				found = findRemark(lines.join("\n"), refOf(mark));
				pluginText = found !== null && (found.text === "" || found.text === rebound.text);
			}
		}
		if (found === null) {
			rest.push(mark);
			continue;
		}
		const quoted = lines[found.end].startsWith(">");
		if (mark.id !== undefined && !found.hasId) lines.splice(found.end + 1, 0, remarkIdLine(mark.id, quoted));
		const untouched =
			takesNewReading(mark, found.text) ||
			(pluginText && mark.transcript !== undefined && mark.transcript !== found.text);
		if (found.titled && !found.confirmed && untouched) {
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
		const found = isRemark(mark) ? findRemark(ours, refOf(mark)) : null;
		if (found === null) return mark;
		if (!found.confirmed && takesNewReading(mark, found.text)) {
			if (mark.id !== undefined) refreshed.push(mark.id);
			return mark;
		}
		const kept = found.confirmed ? { ...mark, confirmed: true } : mark;
		return found.text === "" ? kept : { ...kept, transcript: found.text };
	});
}

export function mergeTabletChanges(input: TabletChanges): {
	body: string;
	outcome: AnnotationOutcome;
	/** Remarks whose untouched earlier reading was replaced by a new one. */
	refreshed: string[];
	/**
	 * The tablet's text this merge used, to keep as the next one's
	 * `mergedBase` once the body is written; null when there is none to keep
	 * (nothing applied, a summary, a page left unread).
	 */
	projected: string | null;
} {
	// The pending callout is the plugin's own list, rebuilt by every import.
	const ours = withoutPendingCallout(input.ours);
	const marks = input.marks.filter((mark) => mark.kind !== "skipped");
	const unread: PendingChange[] = input.marks
		.filter((mark) => mark.kind === "skipped")
		.map((mark) => ({ page: mark.page, text: mark.unapplied ?? "a change that could not be read" }));
	if (input.highlights.length === 0 && marks.length === 0) {
		return {
			body: withPendingCallout(ours, unread),
			outcome: { form: "copy", conflicts: 0, pending: unread.map(pendingLine) },
			refreshed: [],
			projected: null,
		};
	}
	const settled = settleRemarks(ours, marks, input.remarkInk);
	const typedPage = marks.find((mark) => mark.tabletText !== undefined)?.tabletText;
	const projected =
		input.base === null
			? null
			: typedPage !== undefined
				? projectTyped(input.base, typedPage, settled.marks)
				: input.layout === null
					? null
					: projectOntoSource({
							source: input.base,
							layout: input.layout,
							highlights: input.highlights,
							marks: settled.marks,
							styles: input.styles,
							erasedAs: input.erasedAs,
							listUnplaced: false,
						});
	if (projected === null || input.base === null) {
		const refreshed: string[] = [];
		// Without what was sent, a typed page's text cannot be merged: it is listed whole.
		const listed = input.marks.map((mark) =>
			mark.tabletText === undefined ? mark : { kind: mark.kind, typed: mark.tabletText },
		);
		const summary = renderAnnotationBlock({
			sourcePath: input.sourcePath,
			sourceName: input.sourceName,
			highlights: input.highlights,
			// The summary lists what could not be read with everything else.
			marks: withNoteTexts(ours, listed, refreshed),
			inSourceNote: true,
			styles: input.styles,
			erasedAs: input.erasedAs,
			importedAt: input.importedAt,
		});
		return {
			body: upsertAnnotationBlock(ours, summary.text),
			outcome: { ...summary.outcome, pending: unread.map(pendingLine) },
			refreshed,
			projected: null,
		};
	}
	// The projection trims the end; the note keeps the base's.
	const tail = input.base.slice(input.base.trimEnd().length);
	const theirs = withoutPendingCallout(projected.markdown + tail);
	const complete = !input.marks.some((mark) => mark.kind === "skipped" && mark.unreadPage === true);
	let base = withoutPendingCallout(input.base);
	let tablet = theirs;
	if (input.mergedBase !== undefined && complete) {
		const sentIds = remarkIds(base);
		const placed = new Set([...remarkIds(input.mergedBase)].filter((id) => !sentIds.has(id)));
		base = withoutRemarks(withoutPendingCallout(input.mergedBase), placed);
		tablet = withoutRemarks(theirs, placed);
	}
	const merged = merge3(base, settled.ours, tablet);
	const pending = [
		...unread,
		...projected.unapplied,
		...projected.unplaced.map((highlight) => ({
			page: highlight.page,
			text: `“${highlight.text}” highlighted — not found in the note`,
		})),
	].sort((a, b) => (a.page ?? Infinity) - (b.page ?? Infinity));
	return {
		body: withPendingCallout(merged.text, pending),
		outcome: {
			form: "copy",
			unplaced: projected.unplaced.length,
			conflicts: merged.conflicts,
			pending: pending.map(pendingLine),
		},
		refreshed: settled.refreshed,
		projected: complete ? theirs : null,
	};
}
