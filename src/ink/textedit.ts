/**
 * Typed text of a page on the tablet changed to new text in place, the
 * way the tablet itself edits it (typed-text notebooks).
 *
 * Rewriting the page from scratch would give every character a new id, and
 * the owner's ink anchored to a character would lose its place. So the
 * page's text sequence is diffed against the new text — paragraphs first,
 * then character by character with its emphasis and paragraph style inside
 * the paragraphs that changed, a range too large to diff replaced whole —
 * and only the difference is written as CRDT operations under the plugin's
 * author: removed characters become tombstones (deleted_length) under their
 * own ids, new runs are inserted between their neighbours (left/right ids),
 * a changed paragraph style is a new paragraph break. Every other block of
 * the page — the owner's strokes, groups, anchors, layers — is kept byte for
 * byte, and so are the text block's fields this does not know, where they were.
 *
 * Anything this cannot do exactly is refused, never approximated: the edit
 * is read back with the page reader and must order and read as intended.
 */

import { diffHunks } from "../sync/merge3";
import {
	idKey,
	type ItemId,
	maxCounterInBlock,
	orderTextChars,
	PARAGRAPH_STYLES,
	type ParagraphStyle,
	parseRmScene,
	type RawRootText,
	readRootTextBlock,
	type RootTextTails,
	SEQUENCE_END,
	type StyleEntry,
	type TextChar,
	type TypedParagraph,
} from "../incoming/rmscene";
import { ByteWriter, HEADER } from "./rmbytes";
import { INK_AUTHOR } from "./rmwrite";

const BLOCK_ROOT_TEXT = 0x07;
const TAG_BYTE1 = 0x1;
const FORMAT_BOLD_ON = 1;
const FORMAT_BOLD_OFF = 2;
const FORMAT_ITALIC_ON = 3;
const FORMAT_ITALIC_OFF = 4;

export type TypedPageEdit =
	/** The page already reads as the new text. */
	| { kind: "unchanged" }
	| { kind: "edited"; bytes: Uint8Array }
	/** The page has no typed text to edit. */
	| { kind: "no-text" }
	/** The edit could not be made exactly; `reason` says why, for the log. */
	| { kind: "refused"; reason: string };

/** One code point with its emphasis, or a paragraph break with the style of the paragraph it opens. */
interface Token {
	key: string;
	value: string;
	bold: boolean;
	italic: boolean;
	style?: ParagraphStyle;
}

function charToken(value: string, bold: boolean, italic: boolean): Token {
	return { key: `c${bold ? 1 : 0}${italic ? 1 : 0}${value}`, value, bold, italic };
}

function breakToken(style: ParagraphStyle): Token {
	return { key: `n${style}`, value: "\n", bold: false, italic: false, style };
}

/** Paragraphs as tokens; the first paragraph's style is not a token (it has no break). */
function tokensOf(paragraphs: readonly TypedParagraph[]): Token[] {
	const tokens: Token[] = [];
	paragraphs.forEach((paragraph, index) => {
		if (index > 0) tokens.push(breakToken(paragraph.style));
		for (const span of paragraph.spans) for (const value of span.text) tokens.push(charToken(value, span.bold, span.italic));
	});
	return tokens;
}

/** A stored text item: a run of characters, one format code, or a tombstone. */
interface Item {
	id: ItemId;
	left: ItemId;
	right: ItemId;
	deletedLength: number;
	value: string | number;
	/** Fields the page had on this item that the reader does not know, written back as they were. */
	tails?: RootTextTails["perItem"][number];
}

interface Block {
	start: number;
	bodyStart: number;
	end: number;
	type: number;
}

function blocksOf(page: Uint8Array): Block[] | null {
	const view = new DataView(page.buffer, page.byteOffset, page.byteLength);
	const blocks: Block[] = [];
	let offset = HEADER.length;
	while (offset + 8 <= page.length) {
		const end = offset + 8 + view.getUint32(offset, true);
		if (end > page.length) return null;
		blocks.push({ start: offset, bodyStart: offset + 8, end, type: page[offset + 7] });
		offset = end;
	}
	return offset === page.length ? blocks : null;
}

const sameId = (a: ItemId, b: ItemId) => a.author === b.author && a.counter === b.counter;

/** A base range `o` replaced by the new range `x`. */
interface Hunk {
	oStart: number;
	oEnd: number;
	xStart: number;
	xEnd: number;
}

/**
 * Most items one Myers diff takes on: its trace grows with the square of
 * the edit, so a range larger than this is replaced whole instead.
 */
const MAX_DIFF = 2000;

/**
 * The hunks turning `a` into `b`, offset by `ao`/`bo`: common ends left out,
 * the rest by Myers' diff (merge3.ts diffHunks) while it is small enough,
 * else one replacement.
 */
function boundedHunks(a: readonly string[], b: readonly string[], ao = 0, bo = 0): Hunk[] {
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let end = 0;
	while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
	const restA = a.slice(start, a.length - end);
	const restB = b.slice(start, b.length - end);
	if (restA.length === 0 && restB.length === 0) return [];
	const at = (hunk: Hunk): Hunk => ({
		oStart: ao + start + hunk.oStart,
		oEnd: ao + start + hunk.oEnd,
		xStart: bo + start + hunk.xStart,
		xEnd: bo + start + hunk.xEnd,
	});
	if (restA.length + restB.length > MAX_DIFF) return [at({ oStart: 0, oEnd: restA.length, xStart: 0, xEnd: restB.length })];
	return diffHunks(restA, restB).map(at);
}

/**
 * Token hunks, paragraphs first: paragraphs that are the same are left
 * alone, and characters are diffed only inside the paragraphs that changed.
 * Time and memory stay bounded by MAX_DIFF whatever the size of the page.
 */
function tokenHunks(a: readonly string[], b: readonly string[]): Hunk[] {
	// Paragraph units: a break token and the characters up to the next one.
	const unitsOf = (keys: readonly string[]) => {
		const starts = [0];
		keys.forEach((key, at) => {
			if (key.startsWith("n") && at > 0) starts.push(at);
		});
		return { starts, keys: starts.map((from, i) => JSON.stringify(keys.slice(from, starts[i + 1] ?? keys.length))) };
	};
	const unitsA = unitsOf(a);
	const unitsB = unitsOf(b);
	const tokenAt = (units: { starts: number[] }, unit: number, length: number) => units.starts[unit] ?? length;
	return boundedHunks(unitsA.keys, unitsB.keys).flatMap((hunk) => {
		const oStart = tokenAt(unitsA, hunk.oStart, a.length);
		const oEnd = tokenAt(unitsA, hunk.oEnd, a.length);
		const xStart = tokenAt(unitsB, hunk.xStart, b.length);
		const xEnd = tokenAt(unitsB, hunk.xEnd, b.length);
		return boundedHunks(a.slice(oStart, oEnd), b.slice(xStart, xEnd), oStart, xStart);
	});
}

/**
 * Edit the typed text of `page` to read `paragraphs`, as `author` — the
 * plugin, unless a test plays the tablet. New ids start after the highest
 * of that author's counters anywhere on the page.
 */
export function editTypedPage(page: Uint8Array, paragraphs: readonly TypedParagraph[], author = INK_AUTHOR): TypedPageEdit {
	const head = new TextDecoder().decode(page.subarray(0, HEADER.length));
	const blocks = head === HEADER ? blocksOf(page) : null;
	if (blocks === null) return { kind: "refused", reason: "the page is not a readable v6 page" };
	const textBlocks = blocks.filter((block) => block.type === BLOCK_ROOT_TEXT);
	if (textBlocks.length === 0) return { kind: "no-text" };
	if (textBlocks.length > 1) return { kind: "refused", reason: "the page has more than one text block" };
	const textBlock = textBlocks[0];

	let raw: RawRootText;
	try {
		raw = readRootTextBlock(page, textBlock.bodyStart, textBlock.end);
	} catch {
		return { kind: "refused", reason: "its text block could not be read" };
	}
	const known = new Set<string>();
	for (const char of raw.chars) {
		if (known.has(idKey(char.id))) return { kind: "refused", reason: "its text has a character id twice" };
		known.add(idKey(char.id));
	}
	const endKey = idKey(SEQUENCE_END);
	if (raw.chars.some((char) => ![char.left, char.right].every((id) => idKey(id) === endKey || known.has(idKey(id))))) {
		return { kind: "refused", reason: "its text refers to characters the page does not hold" };
	}
	let ordered: TextChar[];
	try {
		ordered = orderTextChars(raw.chars);
	} catch {
		return { kind: "refused", reason: "its text has no consistent order" };
	}

	const styleOf = (id: ItemId): ParagraphStyle => PARAGRAPH_STYLES[raw.styles.get(idKey(id)) ?? 1] ?? "plain";
	const device: { token: Token; at: number }[] = [];
	let bold = false;
	let italic = false;
	ordered.forEach((char, at) => {
		const value = char.value;
		if (typeof value === "number") {
			if (value === FORMAT_BOLD_ON) bold = true;
			else if (value === FORMAT_BOLD_OFF) bold = false;
			else if (value === FORMAT_ITALIC_ON) italic = true;
			else if (value === FORMAT_ITALIC_OFF) italic = false;
		} else if (value !== null) {
			const token = value === "\n" ? { ...breakToken(styleOf(char.id)), bold, italic } : charToken(value, bold, italic);
			device.push({ token, at });
		}
	});
	const target = tokensOf(paragraphs);
	const firstStyle = paragraphs[0]?.style ?? "plain";
	const hunks = tokenHunks(
		device.map((entry) => entry.token.key),
		target.map((token) => token.key),
	);
	const restyle = styleOf(SEQUENCE_END) !== firstStyle;
	if (hunks.length === 0 && !restyle) return { kind: "unchanged" };

	let next =
		1 +
		Math.max(
			0,
			...blocks.map((block) => maxCounterInBlock(page, block.bodyStart, block.end, author, block.type)),
			...raw.chars.filter((char) => char.id.author === author).map((char) => char.id.counter),
			...raw.styleEntries.flatMap((entry) => [entry.key, entry.timestamp]).filter((id) => id.author === author).map((id) => id.counter),
		);
	const scene = parseRmScene(page);
	for (const line of scene.lines) if (line.id.author === author) next = Math.max(next, line.id.counter + 1);
	for (const range of scene.deleted) if (range.author === author) next = Math.max(next, range.from + range.length);
	const fresh = (): ItemId => ({ author, counter: next++ });

	const deleted = new Set<string>();
	const inserted: Item[] = [];
	/** Ordered position → ids inserted right after it (-1: before everything). */
	const insertedAfter = new Map<number, ItemId[]>();
	const styles: StyleEntry[] = [...raw.styleEntries];
	for (const hunk of hunks) {
		for (let at = hunk.oStart; at < hunk.oEnd; at++) deleted.add(idKey(ordered[device[at].at].id));
		if (hunk.xStart === hunk.xEnd) continue;
		const anchor = hunk.oStart === 0 ? undefined : device[hunk.oStart - 1];
		const after = anchor?.at ?? -1;
		const right = ordered[after + 1]?.id ?? SEQUENCE_END;
		const state = { bold: anchor?.token.bold ?? false, italic: anchor?.token.italic ?? false };
		const units: { id: ItemId; value: string | number }[] = [];
		const current = { ...state };
		const format = (wanted: { bold: boolean; italic: boolean }) => {
			if (current.bold !== wanted.bold) units.push({ id: fresh(), value: wanted.bold ? FORMAT_BOLD_ON : FORMAT_BOLD_OFF });
			if (current.italic !== wanted.italic) units.push({ id: fresh(), value: wanted.italic ? FORMAT_ITALIC_ON : FORMAT_ITALIC_OFF });
			current.bold = wanted.bold;
			current.italic = wanted.italic;
		};
		for (const token of target.slice(hunk.xStart, hunk.xEnd)) {
			if (token.style === undefined) format(token);
			const id = fresh();
			units.push({ id, value: token.value });
			if (token.style !== undefined) {
				styles.push({ key: id, timestamp: fresh(), code: PARAGRAPH_STYLES.indexOf(token.style) });
			}
		}
		format(state);
		let left = anchor === undefined ? SEQUENCE_END : ordered[anchor.at].id;
		let run: Item | undefined;
		for (const unit of units) {
			// Characters with consecutive ids are one run, as the tablet stores them.
			if (run !== undefined && typeof unit.value === "string" && unit.id.counter === left.counter + 1) {
				run.value += unit.value;
			} else {
				run = { id: unit.id, left, right, deletedLength: 0, value: unit.value };
				inserted.push(run);
			}
			if (typeof unit.value !== "string") run = undefined;
			left = unit.id;
		}
		insertedAfter.set(after, units.map((unit) => unit.id));
	}
	if (restyle) {
		const at = styles.findIndex((entry) => sameId(entry.key, SEQUENCE_END));
		if (styles[at]?.tail !== undefined) return { kind: "refused", reason: "its first paragraph's style holds fields this cannot keep" };
		const entry = { key: SEQUENCE_END, timestamp: fresh(), code: PARAGRAPH_STYLES.indexOf(firstStyle) };
		if (at === -1) styles.unshift(entry);
		else styles[at] = entry;
	}

	// The stored items again, split where some of a run's characters went;
	// an item kept whole keeps the fields this does not know.
	const items: Item[] = [];
	const itemSize = new Array<number>(raw.tails.perItem.length).fill(0);
	for (const char of raw.chars) itemSize[char.item]++;
	if (itemSize.includes(0)) return { kind: "refused", reason: "its text has an item without characters" };
	const deadAt = (index: number) => raw.chars[index].value === null || deleted.has(idKey(raw.chars[index].id));
	for (let start = 0; start < raw.chars.length; ) {
		const char = raw.chars[start];
		const dead = deadAt(start);
		let end = start + 1;
		while (
			end < raw.chars.length &&
			typeof char.value !== "number" &&
			raw.chars[end].item === char.item &&
			typeof raw.chars[end].value !== "number" &&
			deadAt(end) === dead
		) {
			end++;
		}
		const run = raw.chars.slice(start, end);
		const tails = raw.tails.perItem[char.item];
		const kept = run.length === itemSize[char.item] && dead === (char.value === null);
		if (!kept && tails.item.length + tails.value.length > 0) {
			return { kind: "refused", reason: "its text holds fields this cannot keep through the edit" };
		}
		items.push({
			id: char.id,
			left: char.left,
			right: run[run.length - 1].right,
			deletedLength: dead ? run.length : 0,
			value: dead ? "" : typeof char.value === "number" ? char.value : run.map((one) => one.value as string).join(""),
			...(kept ? { tails } : {}),
		});
		start = end;
	}

	const body = new ByteWriter();
	writeRootText(body, raw, [...items, ...inserted], styles);
	const text = body.bytes();
	const out = new ByteWriter();
	out.raw(page.subarray(0, textBlock.start));
	out.u32(text.length);
	out.raw(page.subarray(textBlock.start + 4, textBlock.bodyStart));
	out.raw(text);
	out.raw(page.subarray(textBlock.end));
	const bytes = out.bytes();

	// Read back as the tablet would: the sequence in the intended order, the text as asked.
	const expected: string[] = [];
	for (const id of insertedAfter.get(-1) ?? []) expected.push(idKey(id));
	ordered.forEach((char, at) => {
		expected.push(idKey(char.id));
		for (const id of insertedAfter.get(at) ?? []) expected.push(idKey(id));
	});
	try {
		const reread = readRootTextBlock(bytes, textBlock.start + 8, textBlock.start + 8 + text.length);
		const order = orderTextChars(reread.chars).map((char) => idKey(char.id));
		if (order.join(",") !== expected.join(",")) {
			return { kind: "refused", reason: "the tablet would order the inserted text differently" };
		}
	} catch {
		return { kind: "refused", reason: "the edited text could not be read back" };
	}
	const result = parseRmScene(bytes).text?.paragraphs ?? [];
	const readsAs = tokensOf(result).map((token) => token.key);
	const wanted = target.map((token) => token.key);
	if (readsAs.join("\u0001") !== wanted.join("\u0001") || (result.length > 0 && result[0].style !== firstStyle)) {
		return { kind: "refused", reason: "the edited text would not read as the note" };
	}
	return { kind: "edited", bytes };
}

/** The RootText block body, as rmscene writes it (roottext.ts encodeRootText), with the bytes it does not know where they were. */
function writeRootText(w: ByteWriter, raw: RawRootText, items: Item[], styles: StyleEntry[]): void {
	const crdt = (id: ItemId) => ({ part1: id.author, part2: id.counter });
	const { tails } = raw;
	w.taggedId(1, crdt(raw.blockId));
	w.subblock(2, (body) => {
		body.subblock(1, (outer) => {
			outer.subblock(1, (list) => {
				list.varuint(items.length);
				for (const item of items) {
					list.subblock(0, (s) => {
						s.taggedId(2, crdt(item.id));
						s.taggedId(3, crdt(item.left));
						s.taggedId(4, crdt(item.right));
						s.taggedInt(5, item.deletedLength);
						const value = item.value;
						const valueTail = item.tails?.value ?? new Uint8Array(0);
						if (typeof value === "string") {
							if (value !== "" || valueTail.length > 0) {
								const encoded = new TextEncoder().encode(value);
								s.subblock(6, (v) => {
									v.varuint(encoded.length);
									v.u8(1);
									v.raw(encoded);
									v.raw(valueTail);
								});
							}
						} else {
							s.subblock(6, (v) => {
								v.varuint(0);
								v.u8(1);
								v.taggedInt(2, value);
								v.raw(valueTail);
							});
						}
						if (item.tails !== undefined) s.raw(item.tails.item);
					});
				}
				list.raw(tails.itemList);
			});
			outer.raw(tails.items);
		});
		body.subblock(2, (outer) => {
			outer.subblock(1, (list) => {
				list.varuint(styles.length);
				for (const { key, timestamp, code, tail } of styles) {
					list.crdtId(crdt(key));
					list.taggedId(1, crdt(timestamp));
					list.subblock(2, (v) => {
						v.tag(1, TAG_BYTE1);
						v.u8(code);
						if (tail !== undefined) v.raw(tail);
					});
				}
				list.raw(tails.styleList);
			});
			outer.raw(tails.styles);
		});
		body.raw(tails.body);
	});
	w.subblock(3, (s) => {
		s.f64(raw.x);
		s.f64(raw.y);
		s.raw(tails.position);
	});
	w.taggedFloat(4, raw.width);
	w.raw(tails.block);
}
