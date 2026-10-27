/**
 * Take a handwritten remark into the note as plain text (ink fork, ⤵).
 *
 * The remark callout goes; its text lands where the ink was written — in
 * the table cell under it, as a line of the callout or a new item of the
 * list it was written against, or as a paragraph after the text it follows.
 * Parts of the handwriting the owner went over with the highlighter come
 * back highlighted, in the same markup an imported highlight on printed
 * text gets (`<mark style="background: …">`, the tablet's own colour) — the
 * reverse of a highlight in the note being drawn as highlighter on the
 * tablet.
 */

import { splitLineInto, splitWords, type Point } from "../ocr/recognize";
import { findRemark } from "./remarkid";

/** Where the remark was written: the printed line it sits against, and the table column. */
export interface RemarkTarget {
	quote?: string;
	column?: number;
}

export interface InkHighlightRecord {
	strokes: Point[][];
	rgb: string;
}

interface Box {
	minX: number;
	maxX: number;
	minY: number;
	maxY: number;
}

function boxOf(strokes: Point[][]): Box | null {
	const points = strokes.flat();
	if (points.length === 0) return null;
	return {
		minX: Math.min(...points.map((p) => p.x)),
		maxX: Math.max(...points.map((p) => p.x)),
		minY: Math.min(...points.map((p) => p.y)),
		maxY: Math.max(...points.map((p) => p.y)),
	};
}

/** The highlighter colour over an ink word: covering at least half its width, on its line. */
function colourOver(word: Box, highlights: { box: Box; rgb: string }[]): string | null {
	for (const { box, rgb } of highlights) {
		const across = Math.min(word.maxX, box.maxX) - Math.max(word.minX, box.minX);
		const down = Math.min(word.maxY, box.maxY) - Math.max(word.minY, box.minY);
		// A swipe is stored as its centre line, often flat: touching the word's height is enough.
		if (down >= 0 && across >= (word.maxX - word.minX) * 0.5) return rgb;
	}
	return null;
}

/** Ink words paired with text words, line by line — as a correction is learned (ocr/samples.ts). */
function pairWords(strokes: Point[][], lines: string[][]): Point[][][] | null {
	const inkLines = splitWords(strokes);
	if (inkLines.length === lines.length) {
		const cut = inkLines.map((line, i) =>
			line.length === lines[i].length
				? line
				: Math.abs(line.length - lines[i].length) === 1
					? splitLineInto(line.flat(), lines[i].length)
					: null,
		);
		if (cut.every((line) => line !== null)) return cut.flat();
	}
	const ink = inkLines.flat();
	return ink.length === lines.flat().length ? ink : null;
}

const mark = (rgb: string, words: string) => `<mark style="background: ${rgb}">${words}</mark>`;

/**
 * The remark's text with the highlighted words marked. `placed` is false
 * when highlights could not be pinned to words (text and ink did not line
 * up) and were left out; a remark highlighted almost entirely is then
 * marked whole.
 */
export function highlightedText(
	text: string,
	strokes: Point[][],
	inkHighlights: InkHighlightRecord[] | undefined,
): { text: string; placed: boolean } {
	const highlights = (inkHighlights ?? [])
		.map((h) => ({ box: boxOf(h.strokes), rgb: h.rgb }))
		.filter((h): h is { box: Box; rgb: string } => h.box !== null);
	if (highlights.length === 0) return { text, placed: true };
	const lines = text.split("\n").map((line) => line.split(/\s+/).filter((word) => word !== ""));
	const paired = pairWords(strokes, lines);
	if (paired === null) {
		const words = splitWords(strokes).flat();
		const coloured = words.map((word) => boxOf(word)).filter((b): b is Box => b !== null).map((b) => colourOver(b, highlights));
		const share = coloured.filter((rgb) => rgb !== null).length / Math.max(1, coloured.length);
		if (share >= 0.8) {
			const rgb = coloured.find((c) => c !== null)!;
			return { text: text.split("\n").map((line) => (line.trim() === "" ? line : mark(rgb, line.trim()))).join("\n"), placed: true };
		}
		return { text, placed: false };
	}
	let next = 0;
	const out = lines.map((words) => {
		const colours = words.map(() => {
			const box = boxOf(paired[next++]);
			return box === null ? null : colourOver(box, highlights);
		});
		const parts: string[] = [];
		for (let i = 0; i < words.length; ) {
			const rgb = colours[i];
			let j = i;
			while (j + 1 < words.length && colours[j + 1] === rgb) j++;
			const run = words.slice(i, j + 1).join(" ");
			parts.push(rgb === null ? run : mark(rgb, run));
			i = j + 1;
		}
		return parts.join(" ");
	});
	return { text: out.join("\n"), placed: true };
}

/** A word of a line, markdown and punctuation aside, and where it stands in the line. */
export interface WordSpan {
	word: string;
	start: number;
	end: number;
}

/** A line's words with their places, markdown and punctuation aside. */
export function wordSpans(line: string): WordSpan[] {
	const spans: WordSpan[] = [];
	for (const match of line.matchAll(/[^\s|]+/g)) {
		const raw = match[0];
		const lead = /^[^\p{L}\p{N}]*/u.exec(raw)?.[0].length ?? 0;
		const word = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
		if (word === "") continue;
		const start = match.index + lead;
		spans.push({ word, start, end: start + word.length });
	}
	return spans;
}

/** A line's words, markdown and punctuation aside, for finding a printed line in the source. */
export function wordsOf(line: string): string[] {
	return wordSpans(line).map((span) => span.word);
}

/** The words a printed row is found by in the source: its first four. */
export function rowWords(quote: string | undefined): string[] {
	return wordsOf(quote ?? "").slice(0, 4);
}

/** Where the words run in a line's words, in order: the index of the first of each run. */
export function runsOf(words: string[], wanted: string[]): number[] {
	const runs: number[] = [];
	if (wanted.length === 0) return runs;
	for (let at = 0; at + wanted.length <= words.length; at++) {
		if (wanted.every((word, k) => words[at + k] === word)) runs.push(at);
	}
	return runs;
}

/** The source line the remark was written against: the nearest one above it holding the quote. */
export function anchorAbove(lines: string[], before: number, quote: string | undefined): number | null {
	const wanted = rowWords(quote);
	if (wanted.length === 0) return null;
	for (let i = before - 1; i >= 0; i--) {
		if (runsOf(wordsOf(lines[i]), wanted).length > 0) return i;
	}
	return null;
}

const FENCE = /^\s*(`{3,}|~{3,})/;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])(\s+)(\[.\]\s+)?/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** The closing fence of the code block holding line `at` (fences included), or null outside one. */
export function fenceEnd(lines: string[], at: number): number | null {
	let open: { line: number; fence: string } | null = null;
	for (let i = 0; i < lines.length; i++) {
		const fence = FENCE.exec(lines[i])?.[1];
		if (fence === undefined) continue;
		if (open === null) {
			if (i > at) return null;
			open = { line: i, fence };
		} else if (fence[0] === open.fence[0] && fence.length >= open.fence.length) {
			if (at <= i) return i;
			open = null;
		}
	}
	return open === null ? null : lines.length - 1;
}

/** End of the paragraph-like block from `at`: up to the next blank line. */
function paragraphEnd(lines: string[], at: number): number {
	let end = at;
	while (end + 1 < lines.length && lines[end + 1].trim() !== "") end++;
	return end;
}

/** Cells of a table row, the outer pipes aside; `\|` stays inside its cell. */
export function cellsOf(row: string): string[] {
	const inner = row.trim().replace(/^\|/, "").replace(/\|$/, "");
	return inner.split(/(?<!\\)\|/);
}

/**
 * The note with the remark `id` taken in as `text`: its callout removed, the
 * text placed where the ink was written. Null when the note has no such
 * remark callout.
 */
export function insertRemarkText(note: string, id: string, text: string, target: RemarkTarget = {}): string | null {
	const found = findRemark(note, { id });
	if (found === null || !found.titled) return null;
	const lines = note.split("\n");
	// The callout goes first: everything it is placed relative to lies above.
	let removeFrom = found.start;
	const removeTo = found.end;
	if (removeFrom > 0 && lines[removeFrom - 1].trim() === "" && (removeTo + 1 >= lines.length || lines[removeTo + 1].trim() === "")) {
		removeFrom--;
	}
	lines.splice(removeFrom, removeTo - removeFrom + 1);
	const textLines = text.split("\n").map((line) => line.trim()).filter((line) => line !== "");
	if (textLines.length === 0) return lines.join("\n");

	const anchor = anchorAbove(lines, removeFrom, target.quote);
	const paragraph = (after: number) => {
		const at = after + 1;
		lines.splice(at, 0, "", ...textLines);
		if (at + 1 + textLines.length < lines.length && lines[at + 1 + textLines.length].trim() !== "") {
			lines.splice(at + 1 + textLines.length, 0, "");
		}
	};

	if (anchor === null) {
		// Nothing to go by: where the callout was.
		paragraph(removeFrom - 1);
		return lines.join("\n");
	}
	const line = lines[anchor];
	// A line of a callout or quote: the table and list logic below runs on the
	// line without its `>` prefix, and every line it writes gets it back.
	const prefix = /^(\s*(?:>\s?)+)/.exec(line)?.[1] ?? "";
	const body = line.slice(prefix.length);
	const unquoted = (at: number) => (lines[at].startsWith(prefix) ? lines[at].slice(prefix.length) : "");

	const fence = fenceEnd(lines, anchor);
	if (fence !== null) {
		paragraph(fence);
	} else if (TABLE_ROW.test(body) && !TABLE_RULE.test(body)) {
		// Into the cell under the ink.
		const cells = cellsOf(body);
		const column = Math.min(Math.max(target.column ?? cells.length - 1, 0), cells.length - 1);
		const value = textLines.map((l) => l.replace(/(?<!\\)\|/g, "\\|")).join("<br>");
		const current = cells[column].trim();
		cells[column] = ` ${current === "" ? value : `${current} ${value}`} `;
		const indent = /^\s*/.exec(body)![0];
		lines[anchor] = `${prefix}${indent}|${cells.join("|")}|`;
	} else if (LIST_ITEM.test(body)) {
		// A new item after the one it was written against (and that item's continuation).
		const [, indent, marker, gap] = LIST_ITEM.exec(body)!;
		let end = anchor;
		while (end + 1 < lines.length) {
			const following = unquoted(end + 1);
			if (!/^\s+\S/.test(following) || /^\s*/.exec(following)![0].length <= indent.length || LIST_ITEM.test(following.slice(indent.length))) break;
			end++;
		}
		const ordered = /^\d+/.exec(marker);
		const next = ordered === null ? marker : `${Number(ordered[0]) + 1}${marker.slice(ordered[0].length)}`;
		const pad = " ".repeat(next.length + gap.length);
		lines.splice(end + 1, 0, `${prefix}${indent}${next}${gap}${textLines[0]}`, ...textLines.slice(1).map((l) => `${prefix}${indent}${pad}${l}`));
	} else if (prefix !== "") {
		// A line of the callout or quote it was written in, right after that line.
		lines.splice(anchor + 1, 0, ...textLines.map((l) => `${prefix}${l}`));
	} else {
		paragraph(paragraphEnd(lines, anchor));
	}
	return lines.join("\n");
}
