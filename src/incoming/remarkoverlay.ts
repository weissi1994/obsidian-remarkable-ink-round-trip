/**
 * Where an unconfirmed remark's ink is shown over the note (ink fork, #29).
 *
 * A remark's callout sits after the block it was written against, which
 * says nothing about where on the page the ink was. Its InkStrokes record
 * keeps that place (`at`: the printed row, the ink's left edge from the
 * page's left and its top under the row's baseline — groupNotes in
 * marks.ts). Stretching the tablet's text column onto the note's puts the
 * remark's picture, faded, roughly there; confirming the remark removes it.
 *
 * Pure: the reading view and the editor (remarkui.ts) measure the note and
 * hand the numbers in.
 */

import type { InkStrokes } from "../ink/inkimage";
import { findRemark, isRemarkIdLine, REMARK_ID_PREFIX } from "./remarkid";
import { anchorAbove, rowWords, runsOf, wordSpans, wordsOf } from "./remarkinsert";

/** Blank margin planRender (strokerender.ts) leaves around a remark's ink, device units. */
export const REMARK_PADDING = 40;

/** The page the ink was written on, in points. */
export interface OverlayPage {
	pageWidth: number;
	margin: number;
}

export interface OverlayOptions {
	/**
	 * How far past the column's left and right edges the ink may sit, px: the
	 * view's side padding. Ink written further out is pulled back in.
	 */
	room?: { left: number; right: number };
	/**
	 * The note's line pitch over the tablet's, both in px at the column's
	 * scale: a remark two lines under its row stays two lines under it.
	 */
	lineRatio?: number;
}

/**
 * The remark's picture over the note, px: left from the text column's left
 * edge, top from the anchor row's baseline. The box is the whole picture;
 * the strokes start `padPx` inside it.
 */
export interface OverlayBox {
	leftPx: number;
	topPx: number;
	widthPx: number;
	heightPx: number;
	padPx: number;
}

/** Where the remark's picture goes over a column `columnPx` wide; null without a recorded place. */
export function overlayBox(ink: InkStrokes, page: OverlayPage, columnPx: number, options: OverlayOptions = {}): OverlayBox | null {
	const at = ink.at;
	const columnPt = page.pageWidth - 2 * page.margin;
	if (at === undefined || columnPt <= 0 || columnPx <= 0 || ink.width <= 0) return null;
	const s = columnPx / columnPt;
	const widthPt = ink.sourceWidth * 0.75;
	const heightPt = ink.sourceHeight * 0.75;
	// Device units → points, from the ink's own size: the picture's padding.
	const padPt = (REMARK_PADDING * widthPt) / ink.width;
	const width = widthPt * s;
	const room = options.room ?? { left: 0, right: 0 };
	const min = -Math.max(0, room.left);
	const max = columnPx + Math.max(0, room.right);
	const left = Math.max(min, Math.min((at.x - page.margin) * s, max - width));
	const top = at.below * s * (options.lineRatio ?? 1);
	const pad = padPt * s;
	return { leftPx: left - pad, topPx: top - pad, widthPx: width + 2 * pad, heightPx: heightPt * s + 2 * pad, padPx: pad };
}

/** An unconfirmed remark that shows its ink: its id, its block's first line and its image link. */
export interface PendingRemark {
	id: string;
	start: number;
	image: string;
}

/** The note's unconfirmed remarks with a picture, in order. */
export function pendingRemarks(note: string): PendingRemark[] {
	if (!note.includes(`^${REMARK_ID_PREFIX}`)) return [];
	const lines = note.split("\n");
	const out: PendingRemark[] = [];
	const idOf = new RegExp(`\\^${REMARK_ID_PREFIX}([0-9a-f]+)`);
	for (const line of lines) {
		if (!isRemarkIdLine(line)) continue;
		const id = idOf.exec(line)?.[1];
		if (id === undefined || out.some((remark) => remark.id === id)) continue;
		const found = findRemark(note, { id });
		if (found === null || found.confirmed) continue;
		const block = lines.slice(found.start, found.end + 1).join("\n");
		const image = /!\[\[([^\]|#]+)/.exec(block)?.[1];
		if (image !== undefined) out.push({ id, start: found.start, image });
	}
	return out;
}

/** Where the printed row a remark was written against is in the note: the line above it, and where on that line. */
export function remarkAnchor(lines: string[], before: number, row: string): { line: number; offset: number } | null {
	const line = anchorAbove(lines, before, row);
	if (line === null) return null;
	const spans = wordSpans(lines[line]);
	const run = runsOf(
		spans.map((span) => span.word),
		rowWords(row),
	)[0];
	return run === undefined ? null : { line, offset: spans[run].start };
}

/** How many times the row's words run in these lines: which match on a rendered line is the anchor. */
export function runsBefore(lines: string[], row: string): number {
	const wanted = rowWords(row);
	return lines.reduce((count, line) => count + runsOf(wordsOf(line), wanted).length, 0);
}

/** Every run of the row's words in rendered text: the first word's place in it, for measuring. */
export function findWordRun(text: string, row: string): { start: number; end: number }[] {
	const spans = wordSpans(text);
	return runsOf(
		spans.map((span) => span.word),
		rowWords(row),
	).map((at) => ({ start: spans[at].start, end: spans[at].end }));
}
