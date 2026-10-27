/**
 * Markdown blocks → page layout (PRD F3, K1).
 *
 * The typesetter behind every handwritten notebook: it lays out the note on
 * a fixed page grid and records where each word landed — the anchor every
 * imported mark is read against. What it draws on is a seam (TypesetBackend);
 * the ink renderer records the calls and turns them into pen strokes.
 *
 * Standard-font metrics and WinAnsi text: characters outside WinAnsi are
 * replaced by a close ASCII fallback, so layouts replay exactly.
 */

import {
	dropLeadingTitleHeading,
	imagePlaceholderText,
	type Block,
	type InlineStyles,
	type ListItem,
	shiftInline,
	wordCount,
} from "./mdblocks";

/**
 * Typography behaviour version (GP_E5_S4–S7). Recorded per upload alongside
 * the font numbers: an import reproduces the layout of a sent document by
 * typesetting it again, so behaviour changes (word breaking, WinAnsi
 * typography, fill-in rows, checkboxes) must replay per document — otherwise
 * every improvement shifts the anchors of previously sent documents
 * (the GP_E3_S15 lesson). Version 1 = pre-0.29 behaviour; version 2 =
 * 0.29.0 (word breaking without float tolerance); version 3 = 0.29.1-0.30.0
 * (float tolerance, label rows); version 4 = 0.31.0 (keep tables together,
 * keep headings with their content); version 5 = 0.32.1 (fill-in rows at
 * 2.0 line steps instead of 2.4); version 6 = 0.32.2 (a leading H1 that
 * repeats the document title is dropped); version 7 = 0.33.0 (a paragraph
 * that is one whole bold or italic span renders in that font); version 8 =
 * current (fork: a mermaid fence whose dimensions were recorded per upload
 * renders as an image block instead of code — replay is gated on the
 * recorded `images` list, so pre-fork documents rebuild unchanged); version
 * 9 = handwriting only: check marks, crosses and arrows are drawn as such
 * instead of becoming "?" or "->"; version 10 = tables get a full grid —
 * border, column and row lines — with padded cells; version 11 = a task
 * item with no text (`- [ ]`) gets its drawn box instead of the literal
 * "[ ]".
 */
export const TYPO_VERSION = 11;

/** Symbols a handwritten page draws itself since typo 9 (see glyphs.ts SHAPES). */
const DRAWN_SYMBOLS = "✓✔☑✗✘✕✖→←↔↑↓";

export interface PdfLayoutOptions {
	/** Base body font size in points. */
	fontSize?: number;
	/** Line height as a multiple of the font size. */
	lineHeight?: number;
	/** Page margin in points. */
	margin?: number;
	/** Typography behaviour version; defaults to the current TYPO_VERSION. */
	typo?: number;
	/** Page size in PDF points; defaults to the reMarkable 1/2 screen (GP_E6_S2). */
	pageWidth?: number;
	pageHeight?: number;
	/**
	 * Start a new page before headings up to this level (GP_E6_S4);
	 * 0 = only at explicit \pagebreak markers.
	 */
	breakAtHeading?: number;
	/**
	 * Smart section packing (GP_E6_S9): a #/## section starts on a fresh page
	 * unless it still fits whole in the space left. Recorded per upload.
	 */
	packSections?: boolean;
}

/** A single word and where it starts, for word-level anchoring (GP_E3_S9). */
export interface PlacedWord {
	/** Sequence number across the whole document, in reading order. */
	id: number;
	text: string;
	x: number;
	width: number;
	/** Inline styling in the source; drawn by the ink renderer, never measured. */
	style?: WordStyle;
}

export interface WordStyle {
	code?: true;
	bold?: true;
	italic?: true;
	strike?: true;
	underline?: true;
	/** Highlighted: the colour it was marked in, or true for the default. */
	highlight?: string | true;
}

/** What kind of source block a line came from (GP_E3_S12). */
export type LineRole = "title" | "heading" | "paragraph" | "list" | "quote" | "code" | "table";

/** One piece of text as it was placed on the page (GP_E3_S8). */
export interface LaidOutLine {
	/** 1-based page number. */
	page: number;
	/** Baseline position in PDF points (origin bottom-left). */
	x: number;
	y: number;
	size: number;
	text: string;
	/**
	 * The line's words with their own positions. This is what lets a
	 * strike-through report *which* words were struck (GP_E3_S9).
	 */
	words: PlacedWord[];
	/** The source block this line belongs to; wrapped lines share it. */
	block: number;
	role: LineRole;
	/** Heading level, list depth, or table column — role-dependent. */
	level?: number;
	/** Numbered list marker, when the item had one. */
	ordered?: number;
	/**
	 * The drawn checkbox of a task item, on the item's first line
	 * (GP_E5_S12). In PDF points, y is the box's bottom edge. Lives only in
	 * the rebuilt layout — never persisted — so it needs no typo version and
	 * exists for every upload that drew checkboxes.
	 */
	checkbox?: { x: number; y: number; size: number; checked: boolean };
}

/**
 * Where every line ended up. This is what lets imported ink be quoted
 * against the text it sits next to: the device gives strokes in page
 * coordinates, and this map turns those coordinates back into sentences.
 */
export interface PdfLayout {
	pageWidth: number;
	pageHeight: number;
	pageCount: number;
	lines: LaidOutLine[];
	/** Typography behaviour version this layout was produced with. */
	typo?: number;
	/**
	 * The device grid the page maps onto, when the producer knows it exactly
	 * (ink fork): a handwritten notebook is written straight in device units,
	 * including on the Paper Pro Move, whose grid the page-width heuristic in
	 * deviceGridFor cannot tell apart. Absent for PDFs.
	 */
	grid?: { width: number; height: number };
	/**
	 * Ink fork: remarks drawn back where they were written, by image name.
	 * Their callouts are in the note but not on the page, so the projection
	 * skips them. Absent when there are none.
	 */
	remarksInPlace?: string[];
}

// reMarkable 2 screen in PDF points (1404×1872 px at 226 DPI).
export const PAGE_WIDTH = 447;
export const PAGE_HEIGHT = 596;

const DEFAULTS: Required<PdfLayoutOptions> = {
	fontSize: 11,
	lineHeight: 1.5,
	margin: 40,
	typo: TYPO_VERSION,
	pageWidth: PAGE_WIDTH,
	pageHeight: PAGE_HEIGHT,
	breakAtHeading: 0,
	packSections: false,
};

/**
 * The typography actually used, defaults filled in. Recorded per upload so a
 * later import can reproduce the same page layout even when the settings have
 * changed in the meantime (GP_E3_S8).
 */
export function resolveLayoutOptions(
	options: PdfLayoutOptions = {},
): Required<PdfLayoutOptions> {
	return { ...DEFAULTS, ...options };
}

const HEADING_SIZES: Record<number, number> = {
	// Level 0 is the document title. It carried no entry between 0.11.0 and
	// 0.16.0 — the title moved from level 1 to level 0 to give it its own
	// role, and silently fell through to the 11 pt body size. That cost more
	// than an ugly title: the title block shrank by 49.7 pt, so rebuilding the
	// layout of a document sent earlier put every row on page 1 fifty points
	// too high, and every pen mark landed three rows below where it was drawn
	// (GP_E3_S15).
	0: 19,
	1: 19,
	2: 16,
	3: 14,
	4: 12,
	5: 11,
	6: 11,
};

/**
 * Replace characters WinAnsi cannot encode with a readable ASCII fallback.
 * Dashes, curly quotes, ellipsis and bullet ARE WinAnsi (0x85–0x97) and pass
 * through untouched since GP_E5_S7 — the earlier blanket ASCII-fallback
 * turned every em dash into "--" on the page.
 */
const REPLACEMENTS: Record<string, string> = {
	"→": "->",
	"←": "<-",
	"↔": "<->",
	"\u00a0": " ",
	"′": "'",
	"″": '"',
	"≤": "<=",
	"≥": ">=",
	"≠": "!=",
	"≈": "~",
};

/** The pre-0.29 blanket fallbacks, replayed for typo-version-1 documents. */
const LEGACY_REPLACEMENTS: Record<string, string> = {
	"–": "-",
	"—": "--",
	"‘": "'",
	"’": "'",
	"“": '"',
	"”": '"',
	"…": "...",
	"•": "-",
};

export function toWinAnsi(text: string, typo: number = TYPO_VERSION): string {
	let out = "";
	for (const ch of text.normalize("NFC")) {
		if (typo >= 9 && DRAWN_SYMBOLS.includes(ch)) {
			out += ch;
		} else if (typo < 2 && ch in LEGACY_REPLACEMENTS) {
			out += LEGACY_REPLACEMENTS[ch];
		} else if (ch in REPLACEMENTS) {
			out += REPLACEMENTS[ch];
		} else if (ch.charCodeAt(0) <= 0xff || isWinAnsiExtra(ch)) {
			out += ch;
		} else {
			out += "?";
		}
	}
	return out;
}

function isWinAnsiExtra(ch: string): boolean {
	// Printable WinAnsi characters above U+00FF: Euro, ligatures, marks — and
	// since GP_E5_S7 the typography that used to be ASCII-fallbacked: en/em
	// dash, curly quotes, ellipsis, bullet.
	return "€ŠšŽžŒœŸƒˆ˜†‡‰‹›™–—‘’“”…•".includes(ch);
}

/**
 * What the typesetter needs from a font: its advance width. pdf-lib's PDFFont
 * satisfies this, and so does the handwriting font of the ink renderer — the
 * layout code below is shared, so a PDF and a handwritten notebook of the
 * same note lay out by the same rules (ink fork).
 */
export interface MeasureFont {
	widthOfTextAtSize(text: string, size: number): number;
}

/** Colour as the drawing calls pass it, components 0–1. */
export interface DrawColor {
	red: number;
	green: number;
	blue: number;
}

const rgb = (red: number, green: number, blue: number): DrawColor => ({ red, green, blue });

/**
 * The drawing surface of one page: exactly the three PDFPage calls the
 * typesetter makes. A PDF page forwards them to pdf-lib; the ink renderer
 * records them and turns them into pen strokes.
 */
export interface DrawPage {
	drawText(
		text: string,
		options: { x: number; y: number; size: number; font: MeasureFont; color?: DrawColor },
	): void;
	drawLine(options: {
		start: { x: number; y: number };
		end: { x: number; y: number };
		thickness?: number;
		color?: DrawColor;
	}): void;
	drawRectangle(options: {
		x: number;
		y: number;
		width: number;
		height: number;
		borderWidth?: number;
		borderColor?: DrawColor;
	}): void;
	/** Ink fork: where a picture goes (bottom-left origin, points). */
	drawImage?(name: string, options: { x: number; y: number; width: number; height: number }): void;
	/**
	 * Ink fork: a coloured band behind text — a code block or quote line, or
	 * a run of inline code. Bottom-left origin, points. PDF ignores it.
	 */
	drawHighlight?(options: {
		x: number;
		y: number;
		width: number;
		height: number;
		kind: HighlightKind;
		/** For "mark": the colour the text was highlighted in. */
		rgb?: string;
	}): void;
	/** Ink fork: a line through or under a run of words (baseline y). */
	drawDecoration?(options: { x1: number; x2: number; y: number; size: number; kind: "strike" | "underline" }): void;
	/** A pre-embedded PNG for an image block; a backend without one leaves the space blank. */
	drawPng?(block: Block, options: { x: number; y: number; width: number; height: number }): void;
	/**
	 * Ink fork: a remark drawn back where it was written passes here, at the
	 * cursor (baseline y, points). Takes no room; the backend places the ink.
	 */
	drawOverlay?(name: string, options: { y: number }): void;
}

export type HighlightKind = "code" | "inline-code" | "quote" | "mark" | "table-header";

/** Fonts and pages: everything a typesetting pass draws with. */
export interface TypesetBackend {
	body: MeasureFont;
	bold: MeasureFont;
	italic: MeasureFont;
	mono: MeasureFont;
	addPage(width: number, height: number): DrawPage;
}

interface Typesetter {
	backend: TypesetBackend;
	page: DrawPage;
	pageIndex: number;
	y: number;
	body: MeasureFont;
	bold: MeasureFont;
	italic: MeasureFont;
	mono: MeasureFont;
	opts: Required<PdfLayoutOptions>;
	/** Every placed line, in reading order (GP_E3_S8). */
	placed: LaidOutLine[];
	/** Source-block counter; wrapped lines of one block share its number. */
	block: number;
	role: LineRole;
	level?: number;
	ordered?: number;
	/** Running word counter, so a mark can name the exact words it covers. */
	wordId: number;
	/** Styled words of the current block, consumed as words are placed. */
	code?: InlineTrack;
	/**
	 * Left indent of everything drawn, in points, on top of the margin: the
	 * content of a quote is set in by its bar (#22). 0 outside quotes, where
	 * every layout stays exactly what it was.
	 */
	inset: number;
	/** The quotes being drawn, outermost first: their bars break with the page. */
	frames: QuoteFrame[];
	/** Left edge of the quote band behind the lines drawn now, if any. */
	band?: number;
}

/** An open quote's bar: its x, and where its segment on this page starts. */
interface QuoteFrame {
	x: number;
	top: number;
}

interface InlineTrack {
	styles: Map<number, WordStyle>;
	/** The block's words as wrapText splits them. */
	words: string[];
	word: number;
	/** Characters of the current word already placed (a broken long word). */
	used: number;
}

/** Arm style tracking for the text the current block is about to place. */
function trackInline(ts: Typesetter, text: string, inline: InlineStyles | undefined): void {
	if (inline === undefined) return;
	const styles = new Map<number, WordStyle>();
	const set = (word: number, patch: WordStyle) => styles.set(word, { ...styles.get(word), ...patch });
	for (const word of inline.code ?? []) set(word, { code: true });
	for (const word of inline.bold ?? []) set(word, { bold: true });
	for (const word of inline.italic ?? []) set(word, { italic: true });
	for (const word of inline.strike ?? []) set(word, { strike: true });
	for (const word of inline.underline ?? []) set(word, { underline: true });
	for (const h of inline.highlight ?? []) set(h.word, { highlight: h.rgb ?? true });
	if (styles.size === 0) return;
	const words = toWinAnsi(text, ts.opts.typo)
		.split(/\s+/)
		.filter((w) => w !== "");
	ts.code = { styles, words, word: 0, used: 0 };
}

/** Arm style tracking for one table cell: each cell is its own run of words. */
function trackCell(ts: Typesetter, text: string, inline: InlineStyles | null | undefined): void {
	ts.code = undefined;
	if (inline !== null && inline !== undefined) trackInline(ts, text, inline);
}

/** Runs of consecutive words on one line sharing a style. */
function runsOf(words: PlacedWord[], has: (style: WordStyle) => boolean): [PlacedWord, PlacedWord][] {
	const runs: [PlacedWord, PlacedWord][] = [];
	for (let i = 0; i < words.length; i++) {
		if (words[i].style === undefined || !has(words[i].style!)) continue;
		let j = i;
		while (j + 1 < words.length && words[j + 1].style !== undefined && has(words[j + 1].style!)) j++;
		runs.push([words[i], words[j]]);
		i = j;
	}
	return runs;
}

function newPage(ts: Typesetter): void {
	// An open quote's bar runs to the foot of the page and picks up again
	// at the top of the next one.
	for (const frame of ts.frames) drawBar(ts, frame, ts.opts.margin);
	ts.page = ts.backend.addPage(ts.opts.pageWidth, ts.opts.pageHeight);
	ts.pageIndex++;
	ts.y = ts.opts.pageHeight - ts.opts.margin;
	for (const frame of ts.frames) frame.top = barTop(ts);
}

/**
 * Draw one line *and* remember where it landed. Every text placement goes
 * through here, so the layout map cannot silently drift from the PDF.
 */
function put(
	ts: Typesetter,
	text: string,
	x: number,
	y: number,
	size: number,
	font: MeasureFont,
): void {
	const words = text.trim() !== "" ? placeWords(ts, text, x, font, size) : [];
	const pad = font.widthOfTextAtSize(" ", size) * 0.4;
	if (ts.page.drawHighlight !== undefined) {
		for (const [first, last] of runsOf(words, (style) => style.code === true)) {
			ts.page.drawHighlight({
				x: first.x - pad,
				y: y - size * 0.3,
				width: last.x + last.width - first.x + 2 * pad,
				height: size * 1.15,
				kind: "inline-code",
			});
		}
		// One band per colour: a run changes colour where the marking did.
		const colourOf = (word: PlacedWord) => (word.style?.highlight === true ? "" : (word.style?.highlight ?? ""));
		for (const [first, last] of runsOf(words, (style) => style.highlight !== undefined)) {
			const run = words.slice(words.indexOf(first), words.indexOf(last) + 1);
			let start = 0;
			for (let k = 1; k <= run.length; k++) {
				if (k < run.length && colourOf(run[k]) === colourOf(run[start])) continue;
				const rgb = colourOf(run[start]);
				ts.page.drawHighlight({
					x: run[start].x - pad,
					y: y - size * 0.3,
					width: run[k - 1].x + run[k - 1].width - run[start].x + 2 * pad,
					height: size * 1.15,
					kind: "mark",
					...(rgb === "" ? {} : { rgb }),
				});
				start = k;
			}
		}
	}
	if (ts.page.drawDecoration !== undefined) {
		for (const kind of ["strike", "underline"] as const) {
			for (const [first, last] of runsOf(words, (style) => style[kind] === true)) {
				ts.page.drawDecoration({ x1: first.x, x2: last.x + last.width, y, size, kind });
			}
		}
	}
	ts.page.drawText(text, { x, y, size, font, color: rgb(0, 0, 0) });
	if (text.trim() !== "") {
		ts.placed.push({
			page: ts.pageIndex,
			x,
			y,
			size,
			text,
			words,
			block: ts.block,
			role: ts.role,
			level: ts.level,
			ordered: ts.ordered,
		});
	}
}

/** Start a new source block; every line drawn after this shares its number. */
function beginBlock(ts: Typesetter, role: LineRole, level?: number, ordered?: number): void {
	ts.block++;
	ts.role = role;
	ts.level = level;
	ts.ordered = ordered;
	ts.code = undefined;
}

/**
 * Walk a drawn line word by word, advancing exactly as the renderer does, so
 * a word's recorded position is the position it occupies on the page.
 */
function placeWords(
	ts: Typesetter,
	text: string,
	x: number,
	font: MeasureFont,
	size: number,
): PlacedWord[] {
	const spaceWidth = font.widthOfTextAtSize(" ", size);
	const words: PlacedWord[] = [];
	let cursor = x;
	for (const part of text.split(" ")) {
		if (part === "") {
			cursor += spaceWidth;
			continue;
		}
		const width = font.widthOfTextAtSize(part, size);
		const word: PlacedWord = { id: ts.wordId++, text: part, x: cursor, width };
		const track = ts.code;
		if (track !== undefined && track.word < track.words.length) {
			const style = track.styles.get(track.word);
			if (style !== undefined) word.style = style;
			track.used += part.length;
			if (track.used >= track.words[track.word].length) {
				track.word++;
				track.used = 0;
			}
		}
		words.push(word);
		cursor += width + spaceWidth;
	}
	return words;
}

function ensureRoom(ts: Typesetter, needed: number): void {
	if (ts.y - needed < ts.opts.margin) newPage(ts);
}

/**
 * Float-noise guard for width comparisons (GP_E5_S4 follow-up): a table
 * column's wrap width is its own content's measured width minus and plus the
 * same padding, which re-enters as e.g. 56.129999999999995 against a word of
 * 56.13. Without the tolerance, a word that exactly fills its column is
 * "wider" by 7e-15 pt and gets broken ("Achillespee/s").
 */
const WIDTH_EPSILON = 0.01;

/** Split a single word wider than the line into chunks that fit (GP_E5_S4). */
function breakLongWord(
	word: string,
	font: MeasureFont,
	size: number,
	maxWidth: number,
	epsilon: number,
): string[] {
	const parts: string[] = [];
	let current = "";
	for (const ch of word) {
		const candidate = current + ch;
		if (font.widthOfTextAtSize(candidate, size) <= maxWidth + epsilon || current === "") {
			current = candidate;
		} else {
			parts.push(current);
			current = ch;
		}
	}
	parts.push(current);
	return parts;
}

/**
 * Greedy word-wrap for the given font/size and maximum line width. A word
 * wider than the line is hard-broken mid-word (GP_E5_S4): before, it was
 * drawn as-is and overflowed — in a narrow table column that meant colliding
 * with the neighbouring column's text.
 */
export function wrapText(
	text: string,
	font: MeasureFont,
	size: number,
	maxWidth: number,
	typo: number = TYPO_VERSION,
): string[] {
	const words = text.split(/\s+/).filter((w) => w !== "");
	if (words.length === 0) return [];
	const lines: string[] = [];
	let current = "";
	for (const word of words) {
		const candidate = current === "" ? word : `${current} ${word}`;
		if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
			current = candidate;
			continue;
		}
		// The candidate overflows: only now is the word's own width worth
		// measuring (the fitting case above stays a single measurement). The
		// float tolerance is itself versioned: 0.29.0 (typo 2) broke words
		// without it, and its uploads must replay that way.
		const epsilon = typo >= 3 ? WIDTH_EPSILON : 0;
		if (typo >= 2 && font.widthOfTextAtSize(word, size) > maxWidth + epsilon) {
			if (current !== "") {
				lines.push(current);
			}
			const parts = breakLongWord(word, font, size, maxWidth, epsilon);
			lines.push(...parts.slice(0, -1));
			current = parts[parts.length - 1];
			continue;
		}
		if (current === "") {
			// A single word wider than the line overflows as-is: version-1
			// behaviour, and for version 2 the hairline case where the word
			// fills its column within the float tolerance.
			current = candidate;
		} else {
			lines.push(current);
			current = word;
		}
	}
	lines.push(current);
	return lines;
}

function drawLines(
	ts: Typesetter,
	lines: string[],
	font: MeasureFont,
	size: number,
	indent: number,
	extraGapAfter: number,
): void {
	const step = size * ts.opts.lineHeight;
	for (const line of lines) {
		ensureRoom(ts, step);
		ts.y -= step;
		drawBand(ts, step);
		put(ts, line, left(ts) + indent, ts.y, size, font);
	}
	ts.y -= extraGapAfter;
}

/** Left edge of the text column: the margin, plus a quote's inset. */
function left(ts: Typesetter): number {
	return ts.opts.margin + ts.inset;
}

function contentWidth(ts: Typesetter, indent = 0): number {
	return ts.opts.pageWidth - 2 * ts.opts.margin - ts.inset - indent;
}

function drawHeading(ts: Typesetter, level: number, text: string, inline?: InlineStyles): void {
	beginBlock(ts, level === 0 ? "title" : "heading", Math.max(level, 1));
	trackInline(ts, text, inline);
	const size = HEADING_SIZES[level] ?? 11;
	const gapBefore = size * 0.8;
	// Keep-with-next (GP_E6_S5, typo 4): a heading only starts on a page if
	// at least a couple of body lines fit under it — a heading dangling at
	// the bottom belongs with its content on the next page.
	const keepWith =
		level >= 1 && ts.opts.typo >= 4 ? 2 * ts.opts.fontSize * ts.opts.lineHeight : 0;
	ensureRoom(ts, gapBefore + size * ts.opts.lineHeight + keepWith);
	ts.y -= gapBefore;
	const lines = wrapText(toWinAnsi(text, ts.opts.typo), ts.bold, size, contentWidth(ts), ts.opts.typo);
	drawLines(ts, lines, ts.bold, size, 0, size * 0.35);
}

function drawParagraph(
	ts: Typesetter,
	text: string,
	style?: "bold" | "italic",
	inline?: InlineStyles,
	/** The font of a paragraph without a style of its own; the body font by default. */
	plain: MeasureFont = ts.body,
): void {
	beginBlock(ts, "paragraph");
	trackInline(ts, text, inline);
	// A whole-span label like "**Doel**" renders in its font (GP_E6_S7,
	// typo 7): the line stays single-font, so wrapping, the word map and the
	// projection stay trivially correct. Mixed inline styling is GP_E6_S8.
	const font =
		ts.opts.typo >= 7 && style === "bold"
			? ts.bold
			: ts.opts.typo >= 7 && style === "italic"
				? ts.italic
				: plain;
	const lines = wrapText(
		toWinAnsi(text, ts.opts.typo),
		font,
		ts.opts.fontSize,
		contentWidth(ts),
		ts.opts.typo,
	);
	drawLines(ts, lines, font, ts.opts.fontSize, 0, ts.opts.fontSize * 0.6);
}

function drawList(ts: Typesetter, items: ListItem[]): void {
	const size = ts.opts.fontSize;
	const counters: number[] = [];
	let prevDepth = -1;
	for (const item of items) {
		if (item.depth > prevDepth) counters[item.depth] = 0;
		if (item.ordered) counters[item.depth] = (counters[item.depth] ?? 0) + 1;
		prevDepth = item.depth;
		// Each item is its own block: a wrapped item keeps one number, the
		// next item gets a new one.
		beginBlock(ts, "list", item.depth, item.ordered ? counters[item.depth] : undefined);

		const indent = 14 + item.depth * 14;
		const bullet = item.ordered ? `${counters[item.depth]}.` : "-";
		// A task item renders a drawn checkbox instead of the literal "[ ]"
		// (GP_E5_S6) — a square you can actually tick with the pen.
		const task = ts.opts.typo >= 2 && !item.ordered ? parseTaskMarker(item.text, ts.opts.typo >= 11) : null;
		const text = task ? task.rest : item.text;
		// The "[ ]" marker's words are not drawn as text.
		const skipped = task ? wordCount(item.text) - wordCount(text) : 0;
		trackInline(ts, text, shiftInline(item.inline, -skipped));
		const lines = wrapText(toWinAnsi(text, ts.opts.typo), ts.body, size, contentWidth(ts, indent), ts.opts.typo);
		const step = size * ts.opts.lineHeight;
		ensureRoom(ts, step);
		// Bullet on the first line, hanging indent for wrapped lines.
		ts.y -= step;
		drawBand(ts, step);
		if (task) {
			drawCheckbox(ts, left(ts) + indent - 12, ts.y, size, task.checked);
		} else {
			ts.page.drawText(bullet, {
				x: left(ts) + indent - 12,
				y: ts.y,
				size,
				font: ts.body,
			});
		}
		if (lines.length > 0) {
			put(ts, lines[0], left(ts) + indent, ts.y, size, ts.body);
			// The import needs to know where the box sits to read a pen tick
			// in it (GP_E5_S12); checkboxRect is the same function drawCheckbox
			// draws from, so the two cannot drift.
			if (task) {
				ts.placed[ts.placed.length - 1].checkbox = {
					...checkboxRect(left(ts) + indent - 12, ts.y, size),
					checked: task.checked,
				};
			}
		} else if (task) {
			// Only its box: still a line of the layout, so a tick in it is read.
			ts.placed.push({
				page: ts.pageIndex,
				x: left(ts) + indent,
				y: ts.y,
				size,
				text: "",
				words: [],
				block: ts.block,
				role: ts.role,
				level: ts.level,
				ordered: ts.ordered,
				checkbox: { ...checkboxRect(left(ts) + indent - 12, ts.y, size), checked: task.checked },
			});
		}
		for (const line of lines.slice(1)) {
			ensureRoom(ts, step);
			ts.y -= step;
			drawBand(ts, step);
			put(ts, line, left(ts) + indent, ts.y, size, ts.body);
		}
	}
	ts.y -= size * 0.6;
}

/**
 * Markdown task marker at the start of a list item: "[ ] …" or "[x] …";
 * with `empty`, also the marker alone (typo 11).
 */
export function parseTaskMarker(text: string, empty = false): { checked: boolean; rest: string } | null {
	const match = (empty ? /^\[( |x|X)\](?:\s+(.*))?$/ : /^\[( |x|X)\]\s+(.*)$/).exec(text);
	if (!match) return null;
	return { checked: match[1] !== " ", rest: match[2] ?? "" };
}

/**
 * The box geometry shared by drawing (drawCheckbox) and the layout map
 * (GP_E5_S12): one function, so tick detection can never drift from what
 * was actually drawn. `y` is the text baseline; the result's `y` is the
 * box's bottom edge.
 */
export function checkboxRect(
	x: number,
	y: number,
	size: number,
): { x: number; y: number; size: number } {
	const box = size * 0.75;
	return { x, y: y - box * 0.08, size: box };
}

/** A drawn checkbox at the bullet position; ticked with a check for [x]. */
function drawCheckbox(ts: Typesetter, x: number, y: number, size: number, checked: boolean): void {
	const rect = checkboxRect(x, y, size);
	const box = rect.size;
	ts.page.drawRectangle({
		x: rect.x,
		y: rect.y,
		width: box,
		height: box,
		borderWidth: 0.8,
		borderColor: rgb(0.25, 0.25, 0.25),
	});
	if (checked) {
		const y0 = rect.y;
		ts.page.drawLine({
			start: { x: x + box * 0.2, y: y0 + box * 0.45 },
			end: { x: x + box * 0.42, y: y0 + box * 0.2 },
			thickness: 1,
			color: rgb(0.25, 0.25, 0.25),
		});
		ts.page.drawLine({
			start: { x: x + box * 0.42, y: y0 + box * 0.2 },
			end: { x: x + box * 0.85, y: y0 + box * 0.8 },
			thickness: 1,
			color: rgb(0.25, 0.25, 0.25),
		});
	}
}

function drawQuote(ts: Typesetter, quoteLines: string[], inline?: InlineStyles): void {
	beginBlock(ts, "quote");
	const size = ts.opts.fontSize;
	const indent = 14;
	const text = quoteLines.join(" ").trim();
	trackInline(ts, text, inline);
	const lines = wrapText(toWinAnsi(text, ts.opts.typo), ts.italic, size, contentWidth(ts, indent), ts.opts.typo);
	const step = size * ts.opts.lineHeight;
	for (const line of lines) {
		ensureRoom(ts, step);
		ts.y -= step;
		// A drawn quote bar instead of a "|" glyph per line (GP_E5_S7); the
		// per-line segments span the full line step, so consecutive lines
		// join into one continuous bar.
		ts.page.drawLine({
			start: { x: left(ts) + 3, y: ts.y - step * 0.15 },
			end: { x: left(ts) + 3, y: ts.y + step * 0.85 },
			thickness: 1.5,
			color: rgb(0.55, 0.55, 0.55),
		});
		ts.page.drawHighlight?.({
			x: left(ts) + 6,
			y: ts.y - step * 0.15,
			width: contentWidth(ts) - 6,
			height: step,
			kind: "quote",
		});
		put(ts, line, left(ts) + indent, ts.y, size, ts.italic);
	}
	ts.y -= size * 0.6;
}

/** Blocks the quote band runs behind; code, tables and pictures keep their own look. */
const BANDED: ReadonlySet<Block["type"]> = new Set(["paragraph", "heading", "list"]);

/**
 * A quote whose content was parsed as blocks (#22): every child is drawn by
 * its own routine, set in by the width of the bar, so a table stays a table
 * and a task keeps a box to tick. One bar runs along the whole quote — per
 * page, as children may break it — and the quote band only behind lines of
 * text. A plain paragraph keeps the italic a quote has always had.
 */
function drawQuoteBlocks(ts: Typesetter, children: Block[]): void {
	const size = ts.opts.fontSize;
	const step = size * ts.opts.lineHeight;
	const outer = { inset: ts.inset, band: ts.band, y: ts.y, page: ts.pageIndex };
	const frame: QuoteFrame = { x: left(ts) + 3, top: barTop(ts) };
	ts.frames.push(frame);
	ts.inset = outer.inset + 14;
	for (const child of children) {
		// A nested quote draws its own band; this one stays off behind it.
		ts.band = BANDED.has(child.type) ? ts.opts.margin + outer.inset + 6 : undefined;
		if (child.type === "paragraph" && child.style === undefined) {
			drawParagraph(ts, child.text, undefined, child.inline, ts.italic);
		} else {
			drawBlock(ts, child);
		}
	}
	ts.frames.pop();
	ts.inset = outer.inset;
	ts.band = outer.band;
	// The last child's gap is the quote's: the bar stops where a line's
	// segment would, above it.
	drawBar(ts, frame, ts.y + size * 0.6 - step * 0.15);
	if (ts.y === outer.y && ts.pageIndex === outer.page) ts.y -= size * 0.6;
}

/** Where a quote bar starts above the next line: the top of its line step. */
function barTop(ts: Typesetter): number {
	return ts.y - ts.opts.fontSize * ts.opts.lineHeight * 0.15;
}

/** One page's segment of a quote bar, down to `bottom`; nothing when empty. */
function drawBar(ts: Typesetter, frame: QuoteFrame, bottom: number): void {
	if (frame.top - bottom < 0.5) return;
	ts.page.drawLine({
		start: { x: frame.x, y: bottom },
		end: { x: frame.x, y: frame.top },
		thickness: 1.5,
		color: rgb(0.55, 0.55, 0.55),
	});
}

/** The quote band behind the line just stepped to, inside a quote. */
function drawBand(ts: Typesetter, step: number): void {
	if (ts.band === undefined) return;
	ts.page.drawHighlight?.({
		x: ts.band,
		y: ts.y - step * 0.15,
		width: ts.opts.pageWidth - ts.opts.margin - ts.band,
		height: step,
		kind: "quote",
	});
}

function drawCode(ts: Typesetter, codeLines: string[]): void {
	beginBlock(ts, "code");
	const size = ts.opts.fontSize - 1.5;
	const step = size * 1.3;
	for (const raw of codeLines) {
		// Hard-truncate: code is preformatted, wrapping would garble it.
		let line = toWinAnsi(raw.replace(/\t/g, "  "), ts.opts.typo);
		while (line.length > 0 && ts.mono.widthOfTextAtSize(line, size) > contentWidth(ts, 8)) {
			line = line.slice(0, -1);
		}
		ensureRoom(ts, step);
		ts.y -= step;
		ts.page.drawHighlight?.({
			x: left(ts) + 2,
			y: ts.y - step * 0.25,
			width: contentWidth(ts) - 2,
			height: step,
			kind: "code",
		});
		put(ts, line, left(ts) + 8, ts.y, size, ts.mono);
	}
	ts.y -= size * 0.8;
}

/**
 * Table rows in a full grid (typo 10): each row draws its own sides, column
 * lines and bottom rule, so a table broken across pages stays closed on both
 * — a row that starts a page draws the top border again.
 */
function drawGridRows(
	ts: Typesetter,
	rows: string[][],
	plans: { writing: boolean; label: boolean; cellLines: string[][]; height: number }[],
	g: { size: number; step: number; total: number; offsets: number[]; inset: number; padTop: number; padBottom: number },
	inline?: (InlineStyles | null)[][],
): void {
	const x0 = left(ts);
	const right = x0 + g.total;
	const border = rgb(0.25, 0.25, 0.25);
	const inner = rgb(0.6, 0.6, 0.6);
	const hline = (y: number, thickness: number, color: DrawColor) =>
		ts.page.drawLine({ start: { x: x0, y }, end: { x: right, y }, thickness, color });
	const vlines = (top: number, bottom: number) => {
		ts.page.drawLine({ start: { x: x0, y: top }, end: { x: x0, y: bottom }, thickness: 0.8, color: border });
		ts.page.drawLine({ start: { x: right, y: top }, end: { x: right, y: bottom }, thickness: 0.8, color: border });
		for (const offset of g.offsets.slice(1)) {
			const x = x0 + offset;
			ts.page.drawLine({ start: { x, y: top }, end: { x, y: bottom }, thickness: 0.5, color: inner });
		}
	};
	let page = -1;
	rows.forEach((row, rowIndex) => {
		beginBlock(ts, "table", rowIndex);
		const plan = plans[rowIndex];
		ensureRoom(ts, Math.min(plan.height, ts.opts.pageHeight - 2 * ts.opts.margin));
		const top = ts.y;
		// A row opening the table or a page closes the grid above it.
		if (ts.pageIndex !== page) hline(top, 0.8, border);
		page = ts.pageIndex;
		if (rowIndex === 0) {
			ts.page.drawHighlight?.({ x: x0, y: top - plan.height, width: g.total, height: plan.height, kind: "table-header" });
		}
		let bottom = top - plan.height;
		if (!plan.writing) {
			const font = rowIndex === 0 ? ts.bold : ts.body;
			let lowest = top - g.padTop;
			row.forEach((cell, c) => {
				let y = top - g.padTop;
				trackCell(ts, cell, inline?.[rowIndex]?.[c]);
				for (const line of plan.cellLines[c]) {
					y -= g.step;
					if (y < ts.opts.margin) break;
					put(ts, line, x0 + g.offsets[c] + g.inset, y, g.size, font);
				}
				lowest = Math.min(lowest, y);
			});
			// A row taller than the page is cut where its text was cut.
			bottom = Math.max(Math.min(bottom, lowest - g.padBottom), ts.opts.margin - g.padBottom);
		}
		vlines(top, bottom);
		const last = rowIndex === rows.length - 1;
		hline(bottom, rowIndex === 0 ? 1.3 : last ? 0.8 : 0.5, rowIndex === 0 || last ? border : inner);
		ts.y = bottom;
	});
}

/**
 * Distribute a table's total width over columns based on their natural
 * (content) widths. Fits naturally when there is room; otherwise columns
 * shrink proportionally, but never below `minWidth` (or their own natural
 * width, if smaller) so narrow columns stay readable while wide ones wrap.
 * Exported for tests (GP_E2_S11: cells wrap, content is never truncated).
 */
export function computeColumnWidths(
	naturals: number[],
	total: number,
	minWidth = 56,
	/** Per column, the width below which a word would have to break (typo 10). */
	words?: number[],
): number[] {
	const sum = naturals.reduce((a, b) => a + b, 0);
	if (sum <= total) return [...naturals];
	const base = naturals.map((n) => Math.min(minWidth, n));
	// Room for each column's longest word, as long as all of them fit.
	const wordFloors = words === undefined ? base : base.map((floor, i) => Math.min(naturals[i], Math.max(floor, words[i])));
	const floors = wordFloors.reduce((a, b) => a + b, 0) <= total ? wordFloors : base;
	const flexTotal = total - floors.reduce((a, b) => a + b, 0);
	const flexNat = naturals.map((n, i) => n - floors[i]);
	const flexSum = flexNat.reduce((a, b) => a + b, 0);
	if (flexTotal <= 0 || flexSum <= 0) {
		return naturals.map(() => total / naturals.length);
	}
	return naturals.map((n, i) => floors[i] + (flexNat[i] * flexTotal) / flexSum);
}

function drawTable(ts: Typesetter, rows: string[][], inline?: (InlineStyles | null)[][]): void {
	// Content-weighted columns; cell text wraps across lines (beta finding
	// GP_E2_S11: truncation lost content on real documents).
	const size = ts.opts.fontSize - 1;
	const step = size * ts.opts.lineHeight;
	const pad = 8;
	const total = contentWidth(ts);
	const cols = Math.max(...rows.map((r) => r.length), 1);

	const naturals = Array.from({ length: cols }, (_, c) =>
		Math.max(
			...rows.map((row, rowIndex) => {
				const font = rowIndex === 0 ? ts.bold : ts.body;
				const text = toWinAnsi(row[c] ?? "", ts.opts.typo);
				return text === "" ? 0 : font.widthOfTextAtSize(text, size) + pad;
			}),
		),
	);
	// Typo 10: no column narrower than its longest word, where they all fit.
	const longestWords =
		ts.opts.typo >= 10
			? Array.from({ length: cols }, (_, c) =>
					Math.max(
						0,
						...rows.flatMap((row, rowIndex) => {
							const font = rowIndex === 0 ? ts.bold : ts.body;
							return toWinAnsi(row[c] ?? "", ts.opts.typo)
								.split(/\s+/)
								.filter((w) => w !== "")
								.map((w) => font.widthOfTextAtSize(w, size) + pad);
						}),
					),
				)
			: undefined;
	const widths = computeColumnWidths(naturals, total, 56, longestWords);
	const offsets = widths.map((_, c) => widths.slice(0, c).reduce((a, b) => a + b, 0));

	// Plan every row up front: fill-in shapes (GP_E5_S5), wrapped cell lines
	// and each row's height. The plan feeds the keep-together decision below
	// AND the drawing loop, so the two can never disagree.
	// Fill-in rows: enough height to write in with a pen, but not so much
	// that a log table can no longer share a page with its text (typo 5
	// trimmed 2.4 to 2.0 on owner feedback; earlier uploads replay 2.4).
	const writingSteps = ts.opts.typo >= 5 ? 2 : 2.4;
	// Typo 10: a full grid, and room inside each cell so no line touches text.
	const grid = ts.opts.typo >= 10;
	const padTop = grid ? size * 0.3 : 0;
	const padBottom = grid ? size * 0.45 : 0;
	const inset = grid ? pad / 2 : 0;
	const plans = rows.map((row, rowIndex) => {
		// An all-empty body row is a fill-in row (GP_E5_S5): real writing
		// height and a faint rule — a one-line sliver is useless under a pen.
		const writing =
			ts.opts.typo >= 2 && rowIndex > 0 && row.every((cell) => (cell ?? "").trim() === "");
		if (writing) {
			return { writing, label: false, cellLines: [] as string[][], height: writingSteps * step };
		}
		// A label row — only the first column filled, the rest left to
		// complete on the device — is the other fill-in shape (typo 3+).
		const label =
			ts.opts.typo >= 3 &&
			rowIndex > 0 &&
			row.length > 1 &&
			(row[0] ?? "").trim() !== "" &&
			row.slice(1).every((cell) => (cell ?? "").trim() === "");
		const font = rowIndex === 0 ? ts.bold : ts.body;
		const cellLines = row.map((cell, c) =>
			wrapText(toWinAnsi(cell, ts.opts.typo), font, size, Math.max(widths[c] - pad, 24), ts.opts.typo),
		);
		const rowLines = Math.max(1, ...cellLines.map((lines) => lines.length));
		const height = grid
			? (label ? Math.max(rowLines, writingSteps) : rowLines) * step + padTop + padBottom
			: (label ? Math.max(rowLines, writingSteps) : rowLines) * step + (rowIndex === 0 ? 6 : 0);
		return { writing, label, cellLines, height };
	});

	// Keep-together (GP_E6_S5, typo 4): a table that fits on one page but not
	// in the space left moves to a fresh page whole, instead of snapping in
	// two. Taller-than-page tables keep the row-by-row behaviour.
	if (ts.opts.typo >= 4) {
		const tableHeight = plans.reduce((sum, plan) => sum + plan.height, 0);
		if (tableHeight <= ts.opts.pageHeight - 2 * ts.opts.margin) {
			ensureRoom(ts, tableHeight);
		}
	}

	if (grid) {
		drawGridRows(ts, rows, plans, { size, step, total, offsets, inset, padTop, padBottom }, inline);
		ts.y -= size * 0.8;
		return;
	}

	rows.forEach((row, rowIndex) => {
		beginBlock(ts, "table", rowIndex);
		const plan = plans[rowIndex];
		if (plan.writing) {
			ensureRoom(ts, plan.height);
			ts.y -= plan.height;
			ts.page.drawLine({
				start: { x: left(ts), y: ts.y },
				end: { x: left(ts) + total, y: ts.y },
				thickness: 0.4,
				color: rgb(0.7, 0.7, 0.7),
			});
			return;
		}
		const isLabelRow = plan.label;
		const font = rowIndex === 0 ? ts.bold : ts.body;
		const cellLines = plan.cellLines;
		// The planned height IS the consumed height — one formula, one truth,
		// or ensureRoom(tableHeight) above could reserve a different total
		// than the rows actually use.
		const rowHeight = plan.height;
		// Keep the row on one page when it fits; taller-than-page rows fall
		// back to a mid-row break via the per-line floor guard below.
		ensureRoom(ts, Math.min(rowHeight, ts.opts.pageHeight - 2 * ts.opts.margin));
		const top = ts.y;
		let lowest = top;
		row.forEach((cell, c) => {
			let y = top;
			trackCell(ts, cell, inline?.[rowIndex]?.[c]);
			for (const line of cellLines[c]) {
				y -= step;
				if (y < ts.opts.margin) break;
				put(ts, line, left(ts) + offsets[c], y, size, font);
			}
			lowest = Math.min(lowest, y);
		});
		ts.y = lowest;
		if (isLabelRow) {
			ts.y = Math.min(ts.y, Math.max(top - rowHeight, ts.opts.margin));
			ts.page.drawLine({
				start: { x: left(ts), y: ts.y },
				end: { x: left(ts) + total, y: ts.y },
				thickness: 0.4,
				color: rgb(0.7, 0.7, 0.7),
			});
		}
		if (rowIndex === 0) {
			ts.y -= 3;
			ts.page.drawLine({
				start: { x: left(ts), y: ts.y },
				end: { x: left(ts) + total, y: ts.y },
				thickness: 0.5,
				color: rgb(0.4, 0.4, 0.4),
			});
			ts.y -= 3;
		}
	});
	ts.y -= size * 0.8;
}

function drawHr(ts: Typesetter): void {
	ensureRoom(ts, 14);
	ts.y -= 10;
	ts.page.drawLine({
		start: { x: left(ts), y: ts.y },
		end: { x: ts.opts.pageWidth - ts.opts.margin, y: ts.y },
		thickness: 0.5,
		color: rgb(0.4, 0.4, 0.4),
	});
	ts.y -= 6;
}

/**
 * Draw an image block: a rendered mermaid diagram (fork: image blocks).
 *
 * Geometry is pure arithmetic over (w, h, opts) — no pixel data involved —
 * so the import-time layout replay reproduces identical page positions from
 * the recorded dimensions alone. Keep-together like tables: a diagram that
 * fits a page never breaks across two; the scale cap means one always fits.
 * No lines are emitted into the layout map — like an hr, the region carries
 * no words, so pen strokes over it come back through the remark path,
 * anchored to the nearest text line.
 */
function drawImageBlock(ts: Typesetter, block: Block & { type: "image" }): void {
	const gap = ts.opts.fontSize * 0.6;
	const contentW = contentWidth(ts);
	const maxH = ts.opts.pageHeight - 2 * ts.opts.margin - 2 * gap;
	const scale = Math.min(1, contentW / block.w, maxH / block.h);
	const width = block.w * scale;
	const height = block.h * scale;
	ensureRoom(ts, height + 2 * gap);
	ts.y -= gap;
	ts.page.drawPng?.(block, {
		x: left(ts) + (contentW - width) / 2,
		y: ts.y - height,
		width,
		height,
	});
	ts.y -= height + gap;
}

/**
 * Ink fork: reserve room for a picture at its natural size (pixels at 96 dpi),
 * never wider than the text column nor taller than most of a page.
 */
function drawImage(ts: Typesetter, block: { name: string; width: number; height: number }): void {
	beginBlock(ts, "paragraph");
	const maxWidth = contentWidth(ts);
	const maxHeight = (ts.opts.pageHeight - 2 * ts.opts.margin) * 0.7;
	let width = Math.max(Math.min(block.width, maxWidth), Math.min(60, maxWidth));
	let height = width * (block.height / Math.max(block.width, 1));
	if (height > maxHeight) {
		height = maxHeight;
		width = height * (block.width / Math.max(block.height, 1));
	}
	const gap = ts.opts.fontSize * 0.6;
	ensureRoom(ts, height + gap);
	ts.y -= height + gap * 0.5;
	ts.page.drawImage?.(block.name, { x: left(ts), y: ts.y, width, height });
	ts.y -= gap;
}

/** Draw one block through the shared per-type routines. */
function drawBlock(ts: Typesetter, block: Block): void {
	switch (block.type) {
		case "heading":
			drawHeading(ts, block.level, block.text, block.inline);
			break;
		case "paragraph":
			drawParagraph(ts, block.text, block.style, block.inline);
			break;
		case "list":
			drawList(ts, block.items);
			break;
		case "quote":
			if (block.blocks !== undefined) drawQuoteBlocks(ts, block.blocks);
			else drawQuote(ts, block.lines, block.inline);
			break;
		case "code":
			drawCode(ts, block.lines);
			break;
		case "table":
			drawTable(ts, block.rows, block.inline);
			break;
		case "hr":
			drawHr(ts);
			break;
		case "image":
			drawImageBlock(ts, block);
			break;
		case "imageref":
			// Substitution normally replaces these before typesetting; a
			// leftover means nobody loaded the picture, so draw what the
			// plugin has always drawn for an image it could not inline.
			drawParagraph(ts, imagePlaceholderText(block), "italic");
			break;
		case "pagebreak":
			// Handled by the render loop; never drawn.
			break;
		case "inkimage":
			drawImage(ts, block);
			break;
		case "inkoverlay":
			// No room taken, no line placed: the ink goes where it was written.
			ts.page.drawOverlay?.(block.name, { y: ts.y });
			break;
	}
}

/**
 * Index just past the section that starts at `start`: up to (not including)
 * the next #/## heading or explicit pagebreak (GP_E6_S9).
 */
function sectionEnd(blocks: Block[], start: number): number {
	for (let i = start + 1; i < blocks.length; i++) {
		const b = blocks[i];
		if (b.type === "pagebreak") return i;
		if (b.type === "heading" && b.level >= 1 && b.level <= 2) return i;
	}
	return blocks.length;
}

/**
 * Where measurement drawing lands: nowhere. Covers exactly the PDFPage
 * methods the draw routines use; a routine growing a new method crashes
 * loudly here (a test failure), never a silent mismeasure. A real scratch
 * page is deliberately NOT used: pdf-lib's removePage only detaches a page
 * from the page tree, its leaf and content stream would stay in the saved
 * document and roughly double the upload's size.
 */
const MEASURE_SINK: DrawPage = {
	drawText: () => undefined,
	drawLine: () => undefined,
	drawRectangle: () => undefined,
	drawImage: () => undefined,
	drawPng: () => undefined,
};

/**
 * Height the blocks would occupy, measured by running the SAME drawing code
 * that will render them — never a parallel formula (the GP_E6_S5 lesson) —
 * against the sink page above, on a page too tall to ever break. Every
 * piece of typesetter state is restored afterwards, so the layout map, the
 * anchors and the saved PDF see nothing of the measurement.
 */
function measureBlocks(ts: Typesetter, blocks: Block[]): number {
	const saved = {
		opts: ts.opts,
		page: ts.page,
		pageIndex: ts.pageIndex,
		placed: ts.placed,
		block: ts.block,
		role: ts.role,
		level: ts.level,
		ordered: ts.ordered,
		wordId: ts.wordId,
		y: ts.y,
		code: ts.code,
		inset: ts.inset,
		frames: ts.frames,
		band: ts.band,
	};
	const tall = 1_000_000;
	ts.opts = { ...ts.opts, pageHeight: tall };
	ts.placed = [];
	ts.page = MEASURE_SINK;
	ts.y = tall - ts.opts.margin;
	ts.frames = [];
	for (const block of blocks) {
		drawBlock(ts, block);
	}
	const used = tall - ts.opts.margin - ts.y;
	ts.opts = saved.opts;
	ts.page = saved.page;
	ts.pageIndex = saved.pageIndex;
	ts.placed = saved.placed;
	ts.block = saved.block;
	ts.role = saved.role;
	ts.level = saved.level;
	ts.ordered = saved.ordered;
	ts.wordId = saved.wordId;
	ts.y = saved.y;
	ts.code = saved.code;
	ts.inset = saved.inset;
	ts.frames = saved.frames;
	ts.band = saved.band;
	return used;
}

/**
 * The whole layout pass, independent of what it draws on (ink fork). The
 * PDF renderer and the handwriting renderer both come through here, so the
 * page grid — the thing every imported mark is anchored to — is produced by
 * one piece of code whatever the output.
 */
export function typesetBlocks(
	blocks: Block[],
	title: string,
	options: PdfLayoutOptions,
	backend: TypesetBackend,
): PdfLayout {
	const opts = resolveLayoutOptions(options);
	const ts: Typesetter = {
		backend,
		page: MEASURE_SINK,
		pageIndex: 0,
		placed: [],
		block: 0,
		role: "paragraph",
		wordId: 0,
		y: 0,
		body: backend.body,
		bold: backend.bold,
		italic: backend.italic,
		mono: backend.mono,
		opts,
		inset: 0,
		frames: [],
	};
	newPage(ts);

	drawHeading(ts, 0, title);
	ts.y -= 4;

	// The title just went up; a first H1 saying the same thing again is
	// duplication, not content (GP_E6_S6, typo 6 — earlier uploads replay
	// the duplicate so their anchors hold).
	const content = ts.opts.typo >= 6 ? dropLeadingTitleHeading(blocks, title) : blocks;

	// A pagebreak is honoured lazily, before the next drawn block: a marker
	// at the very end (or on an already-fresh page) never leaves a blank
	// page behind (GP_E6_S1). Headings up to opts.breakAtHeading get the
	// same treatment (GP_E6_S4) — except the very first block, which would
	// otherwise leave the title alone on a near-empty page.
	//
	// Smart packing (GP_E6_S9): with packSections on, a #/## section is
	// pre-measured and moves whole to a fresh page only when it will not
	// fit in the space left on the current one — small sections keep
	// flowing, large ones start clean, no per-document markers needed.
	let pendingBreak = false;
	let drewContent = false;
	for (let index = 0; index < content.length; index++) {
		const block = content[index];
		if (block.type === "pagebreak") {
			pendingBreak = true;
			continue;
		}
		if (block.type === "inkoverlay") {
			// Not content: a page break or heading rule must not count it.
			drawBlock(ts, block);
			continue;
		}
		const startsSection =
			block.type === "heading" && block.level >= 1 && block.level <= 2;
		const breakForHeading =
			block.type === "heading" &&
			drewContent &&
			block.level >= 1 &&
			block.level <= ts.opts.breakAtHeading;
		// Measuring is pointless on a still-fresh page (same guard as the
		// break itself): whatever the section's height, nothing would move.
		const breakForPacking =
			ts.opts.packSections &&
			startsSection &&
			drewContent &&
			!pendingBreak &&
			!breakForHeading &&
			ts.y < ts.opts.pageHeight - ts.opts.margin &&
			measureBlocks(ts, content.slice(index, sectionEnd(content, index))) >
				ts.y - ts.opts.margin;
		if (pendingBreak || breakForHeading || breakForPacking) {
			pendingBreak = false;
			if (ts.y < ts.opts.pageHeight - ts.opts.margin) newPage(ts);
		}
		drewContent = true;
		drawBlock(ts, block);
	}

	return {
		pageWidth: ts.opts.pageWidth,
		pageHeight: ts.opts.pageHeight,
		pageCount: ts.pageIndex,
		lines: ts.placed,
		// The RESOLVED version (ts.opts, defaults filled in) — the raw
		// option may be undefined and would misreport what was used.
		typo: ts.opts.typo,
	};
}
