/**
 * Handwriting taken into the note where it was written (inkRemarksForm
 * "inline"): its reading as plain text — or, when it could not be read with
 * confidence, its ink as a small inline image — in the table cell, on the
 * task, at the end of the line it was written beside, or as a paragraph of
 * its own where it was written between blocks.
 *
 * Each item is followed by its marker, an Obsidian comment `%%ink-<id>%%`
 * (remarkid.ts remarkId): hidden in reading view, stripped before a send
 * (preprocess.ts), and how the next import finds the item again instead of
 * placing it twice.
 *
 * What the item says is the text before its marker, back to the start of its
 * container — the cell, the item's or line's text, or an earlier marker on
 * the same line. Appended to text that was there already, the item is only
 * the last words of that: the plugin's own reading when the note still ends
 * in it, else as many words as the ink has (or the reading had).
 */

import { REMARK_ID_PREFIX } from "./remarkid";
import { cellsOf } from "./remarkinsert";

/** The hidden marker after an inline item. */
export function inlineMarker(id: string): string {
	return `%%${REMARK_ID_PREFIX}${id}%%`;
}

const MARKER = `%%${REMARK_ID_PREFIX}([0-9a-f]+)%%`;
/** An ink embed, `![[path|size]]` (`\|` in a table), ending where it stands. */
const EMBED_AT_END = /!\[\[([^\]|\\]+)(?:\\?\|[^\]]*)?\]\]$/;
/** An ink embed with its marker: an inline item still showing its image. */
export const INLINE_IMAGE_RE = new RegExp(`!\\[\\[([^\\]|\\\\]+)(?:\\\\?\\|[^\\]]*)?\\]\\]${MARKER}`, "g");
const FENCE = /^\s*(?:>\s*)*(`{3,}|~{3,})/;
const TABLE_LINE = /^\s*(?:>\s?)*\s*\|/;
const LINE_PREFIX = /^(?:\s*>\s?)*\s*(?:(?:[-*+]|\d+[.)])\s+(?:\[.\](?=\s|$)\s?)?|#{1,6}\s+)?/;

/** An inline item in a note. */
export interface InlineRemark {
	id: string;
	/** Its line. */
	line: number;
	/** Where its marker starts in the line. */
	at: number;
	/** Where its container starts in the line: the cell, the line's text, or after an earlier marker. */
	from: number;
	/** In a table row: pipes in its text are escaped. */
	inTable: boolean;
	/** Its container's text before its marker, trimmed. */
	before: string;
	/** The image it still shows: the path of the ink embed right before its marker. */
	image?: string;
}

/** Collapse a reading to one line: an inline item has no line breaks. */
export function flatText(text: string): string {
	return text.split(/\s+/).filter((word) => word !== "").join(" ");
}

/** Every inline item of a note, outside code blocks. */
export function inlineRemarks(note: string): InlineRemark[] {
	const out: InlineRemark[] = [];
	let fence: string | null = null;
	note.split("\n").forEach((line, index) => {
		const marker = FENCE.exec(line)?.[1];
		if (marker !== undefined) {
			if (fence === null) fence = marker;
			else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
			return;
		}
		if (fence !== null || !line.includes(`%%${REMARK_ID_PREFIX}`)) return;
		const inTable = TABLE_LINE.test(line);
		const prefix = inTable ? 0 : LINE_PREFIX.exec(line)![0].length;
		let previous = -1;
		for (const match of line.matchAll(new RegExp(MARKER, "g"))) {
			const at = match.index;
			let from = inTable ? cellStart(line, at) : prefix;
			if (previous > from) from = previous;
			const before = line.slice(from, at).trimEnd();
			const image = EMBED_AT_END.exec(before)?.[1]?.trim();
			out.push({ id: match[1], line: index, at, from, inTable, before: before.trim(), ...(image === undefined ? {} : { image }) });
			previous = at + match[0].length;
		}
	});
	return out;
}

/** The inline item with this id, or null when the note has none. */
export function findInlineRemark(note: string, id: string): InlineRemark | null {
	return inlineRemarks(note).find((item) => item.id === id) ?? null;
}

/** Just after the unescaped pipe opening the cell that holds `at`. */
function cellStart(line: string, at: number): number {
	for (let i = at - 1; i >= 0; i--) {
		if (line[i] === "|" && line[i - 1] !== "\\") return i + 1;
	}
	return 0;
}

/** Where the last `count` words before `end` start, not before `from`. */
function wordsBack(line: string, from: number, end: number, count: number): number {
	let at = end;
	for (let n = 0; n < count; n++) {
		while (at > from && /\s/.test(line[at - 1])) at--;
		if (at <= from) break;
		while (at > from && !/\s/.test(line[at - 1])) at--;
	}
	while (at < end && /\s/.test(line[at])) at++;
	return at;
}

/**
 * Where the item's content runs in its line, its marker aside. An image: its
 * embed. Text: the plugin's reading `known` when the container still ends in
 * it; else the last `words` words (the ink's), or as many as `known` has, or
 * the whole container.
 */
function contentRange(line: string, item: InlineRemark, known?: string, words?: number): { start: number; end: number } {
	let end = item.at;
	while (end > item.from && /\s/.test(line[end - 1])) end--;
	if (item.image !== undefined) {
		const before = line.slice(item.from, end);
		return { start: item.from + (EMBED_AT_END.exec(before)?.index ?? 0), end };
	}
	const before = flatText(line.slice(item.from, end));
	const plain = known === undefined ? "" : flatText(known);
	const plugin = item.inTable ? plain.replace(/(?<!\\)\|/g, "\\|") : plain;
	const pluginWords = plugin === "" ? 0 : plugin.split(" ").length;
	if (plugin !== "" && (before === plugin || before.endsWith(` ${plugin}`))) {
		return { start: wordsBack(line, item.from, end, pluginWords), end };
	}
	return { start: wordsBack(line, item.from, end, words ?? (plugin === "" ? Infinity : pluginWords)), end };
}

/**
 * What an inline item says: "" while it shows its image, else its text (see
 * contentRange for how far back that reaches). Null when the note has no
 * item with this id.
 */
export function inlineRemarkText(note: string, id: string, known?: string, words?: number): string | null {
	const item = findInlineRemark(note, id);
	if (item === null) return null;
	if (item.image !== undefined) return "";
	const line = note.split("\n")[item.line];
	const { start, end } = contentRange(line, item, known, words);
	const text = flatText(line.slice(start, end));
	return item.inTable ? text.replace(/\\\|/g, "|") : text;
}

/**
 * The note with an inline item's content — its image, or its text as
 * contentRange finds it — replaced by `content`. Null when the note has no
 * item with this id.
 */
export function setInlineRemark(note: string, id: string, content: InlineContent, known?: string, words?: number): string | null {
	const item = findInlineRemark(note, id);
	if (item === null) return null;
	const lines = note.split("\n");
	const line = lines[item.line];
	const { start, end } = contentRange(line, item, known, words);
	lines[item.line] = line.slice(0, start) + inlineContent(content, item.inTable) + line.slice(end);
	return lines.join("\n");
}

/** The note with an item's marker pointing at another remark id (the same writing, added to). */
export function retargetInlineRemark(note: string, from: string, to: string): string {
	return note.split(inlineMarker(from)).join(inlineMarker(to));
}

/**
 * The inline item still showing its image on line `line` nearest column
 * `ch` — what "Turn this handwriting into text" acts on. Null when the line
 * has none.
 */
export function inlineImageAt(note: string, line: number, ch: number): InlineRemark | null {
	let best: { item: InlineRemark; away: number } | null = null;
	for (const item of inlineRemarks(note)) {
		if (item.line !== line || item.image === undefined) continue;
		const away = ch < item.from ? item.from - ch : ch > item.at ? ch - item.at : 0;
		if (best === null || away < best.away) best = { item, away };
	}
	return best?.item ?? null;
}

/** What an inline item shows: the reading, or the ink as an image `width` px wide. */
export type InlineContent = { text: string } | { image: string; width: number };

/** The markdown of an item's content: text on one line (pipes escaped in a table), or the embed. */
function inlineContent(content: InlineContent, inTable: boolean): string {
	if ("text" in content) {
		const text = flatText(content.text);
		return inTable ? text.replace(/(?<!\\)\|/g, "\\|") : text;
	}
	return `![[${content.image}${inTable ? "\\|" : "|"}${content.width}]]`;
}

/** An inline item as it goes into the note: its content, then its marker. */
export function inlineItem(content: InlineContent, id: string, inTable = false): string {
	return `${inlineContent(content, inTable)}${inlineMarker(id)}`;
}

/**
 * A line with an item appended to its text, after a space — before a block
 * id ending it (`^abc`), which must stay last. An empty task (`- [ ] `)
 * gets the item as its text.
 */
export function appendToLine(line: string, item: string): string {
	const blockId = /\s+\^[A-Za-z0-9-]+\s*$/.exec(line);
	const body = (blockId === null ? line : line.slice(0, blockId.index)).trimEnd();
	return `${body}${body === "" ? "" : " "}${item}${blockId === null ? "" : blockId[0].trimEnd()}`;
}

/**
 * A table row with an item appended to the text of cell `column` (0-based,
 * kept within the row): the row keeps its cells, so the table stays valid.
 * The item must carry its pipes escaped (inlineItem with inTable).
 */
export function appendToCell(line: string, column: number, item: string): string {
	const prefix = /^(\s*(?:>\s?)+)/.exec(line)?.[1] ?? "";
	const body = line.slice(prefix.length);
	const cells = cellsOf(body);
	const at = Math.min(Math.max(column, 0), cells.length - 1);
	const current = cells[at].trim();
	cells[at] = ` ${current === "" ? item : `${current} ${item}`} `;
	const indent = /^\s*/.exec(body)![0];
	return `${prefix}${indent}|${cells.join("|")}|`;
}

/**
 * Ranges of a text that never reach the page: comments (`%%…%%`, inline
 * markers among them) and the ink embeds of inline items, which go back as
 * strokes or a picture of their own (preprocess.ts).
 */
export function hiddenInlineRanges(source: string): { start: number; end: number }[] {
	const out: { start: number; end: number }[] = [];
	for (const match of source.matchAll(INLINE_IMAGE_RE)) out.push({ start: match.index, end: match.index + match[0].length });
	for (const match of source.matchAll(/%%[\s\S]*?%%/g)) {
		if (!out.some((range) => match.index >= range.start && match.index < range.end)) out.push({ start: match.index, end: match.index + match[0].length });
	}
	return out.sort((a, b) => a.start - b.start);
}
