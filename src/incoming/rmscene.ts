/**
 * A fuller `.rm` v6 reader for handwritten notebooks (ink fork).
 *
 * The upstream reader (rmlines.ts) takes stroke geometry and nothing else,
 * which is all a review PDF needs. A notebook the plugin wrote itself needs
 * the CRDT bookkeeping that reader walks past, because that is where the
 * tablet records what happened to our strokes:
 *
 * - every line's item id — ours are author 1, counter ≥ 100;
 * - deleted ranges — an erased stroke leaves a value-less item whose
 *   deleted_length covers one or more consecutive counters (rmscene's
 *   Lines_v2_updated.rm: one tombstone covering 11 strokes);
 * - `move_id` — a lasso move writes NEW line items that point back at the
 *   line they were moved from (same file: (2,30) → move_id (1,15));
 * - groups — moved ink can land in a group anchored to text, whose x origin
 *   (anchor_origin_x) the stroke coordinates are relative to;
 * - the scene info's paper size, which says which canvas the page was made
 *   on — the Paper Pro writes (1620, 2160);
 * - typed text (the RootText block): a CRDT sequence of character runs,
 *   tombstones and inline format codes, plus paragraph styles keyed by the
 *   newline that opens each paragraph — resolved here the way rmscene does.
 *
 * Same tolerance discipline as upstream: an unreadable block costs that
 * block, a truncated file returns what was read (N3).
 */

import { RM_V6_HEADER, Stroke, StrokePoint } from "./rmlines";

export interface ItemId {
	author: number;
	counter: number;
}

export function idKey(id: ItemId): string {
	return `${id.author}:${id.counter}`;
}

export interface SceneLine {
	id: ItemId;
	parent: ItemId;
	stroke: Stroke;
	/** The line this one was moved from, when the tablet recorded a move. */
	moveFrom?: ItemId;
	/** Exact colour as `#rrggbb`, when the line carries one (Paper Pro). */
	rgb?: string;
	/**
	 * True when the line sits in a group anchored to typed text: its y is
	 * relative to a text position this reader can only estimate.
	 */
	anchored: boolean;
	/**
	 * Where the typed text puts the anchor of an anchored line, to add to its
	 * y — rmc's layout: a fixed height per paragraph style and no line wrap,
	 * so ink below a paragraph that wraps on the tablet lands too high.
	 * Absent when the anchor is not a character this page's text has.
	 */
	textAnchorY?: number;
}

export interface DeletedRange {
	author: number;
	from: number;
	length: number;
}

/** Typed-text paragraph styles by the code the page stores (rmscene ParagraphStyle). */
export const PARAGRAPH_STYLES = [
	"basic",
	"plain",
	"heading",
	"bold",
	"bullet",
	"bullet2",
	"checkbox",
	"checkbox-checked",
] as const;
export type ParagraphStyle = (typeof PARAGRAPH_STYLES)[number];

export interface TextSpan {
	text: string;
	bold: boolean;
	italic: boolean;
}

/** A paragraph of typed text as the writer takes it. */
export interface TypedParagraph {
	style: ParagraphStyle;
	spans: TextSpan[];
}

export interface TextParagraph extends TypedParagraph {
	/** The newline that opens the paragraph, (0, 0) for the first; styles are keyed by it. */
	startId: ItemId;
	text: string;
	/** Item id of each code point of `text`; erased characters are not in either. */
	charIds: ItemId[];
}

/** The page's typed text: paragraphs in document order, and the text box in page units. */
export interface SceneText {
	paragraphs: TextParagraph[];
	x: number;
	y: number;
	width: number;
}

export interface RmScene {
	lines: SceneLine[];
	deleted: DeletedRange[];
	paperSize?: { width: number; height: number };
	/** Author index → UUID hex, for the diagnostic log. */
	authors: Map<number, string>;
	blockTypes: Record<number, number>;
	/** Absent when the page has no RootText block or it could not be read. */
	text?: SceneText;
}

const TAG_BYTE1 = 0x1;
const TAG_BYTE4 = 0x4;
const TAG_BYTE8 = 0x8;
const TAG_LENGTH4 = 0xc;
const TAG_ID = 0xf;

const BLOCK_AUTHOR_IDS = 0x09;
const BLOCK_SCENE_INFO = 0x0d;
const BLOCK_TREE_NODE = 0x02;
const BLOCK_GROUP_ITEM = 0x04;
const BLOCK_LINE_ITEM = 0x05;
const BLOCK_ROOT_TEXT = 0x07;
const ITEM_TYPE_LINE = 3;

const ERASER_TOOLS = new Set([6, 8, 38]);

class Reader {
	offset: number;
	constructor(
		readonly view: DataView,
		start: number,
		readonly end: number,
	) {
		this.offset = start;
	}
	get remaining(): number {
		return this.end - this.offset;
	}
	u8(): number {
		return this.view.getUint8(this.offset++);
	}
	u16(): number {
		const v = this.view.getUint16(this.offset, true);
		this.offset += 2;
		return v;
	}
	u32(): number {
		const v = this.view.getUint32(this.offset, true);
		this.offset += 4;
		return v;
	}
	f32(): number {
		const v = this.view.getFloat32(this.offset, true);
		this.offset += 4;
		return v;
	}
	f64(): number {
		const v = this.view.getFloat64(this.offset, true);
		this.offset += 8;
		return v;
	}
	varuint(): number {
		let shift = 0;
		let value = 0;
		for (;;) {
			const byte = this.u8();
			value += (byte & 0x7f) * 2 ** shift;
			if ((byte & 0x80) === 0) return value;
			shift += 7;
			if (shift > 49) throw new Error("varuint too long");
		}
	}
	peekTag(): { index: number; type: number } | null {
		if (this.remaining <= 0) return null;
		const save = this.offset;
		try {
			const raw = this.varuint();
			return { index: raw >> 4, type: raw & 0xf };
		} finally {
			this.offset = save;
		}
	}
	tag(): { index: number; type: number } {
		const raw = this.varuint();
		return { index: raw >> 4, type: raw & 0xf };
	}
	/** Expect a tag with this index and type; throws when it is not next. */
	expect(index: number, type: number): void {
		const tag = this.tag();
		if (tag.index !== index || tag.type !== type) {
			throw new Error(`expected tag ${index}/${type}, got ${tag.index}/${tag.type}`);
		}
	}
	has(index: number, type: number): boolean {
		const tag = this.peekTag();
		return tag !== null && tag.index === index && tag.type === type;
	}
	crdtId(): ItemId {
		const author = this.u8();
		const counter = this.varuint();
		return { author, counter };
	}
	utf8(length: number): string {
		if (length > this.remaining) throw new Error("string past end of block");
		const bytes = new Uint8Array(this.view.buffer, this.view.byteOffset + this.offset, length);
		this.offset += length;
		return new TextDecoder().decode(bytes);
	}
	id(index: number): ItemId {
		this.expect(index, TAG_ID);
		return this.crdtId();
	}
	int(index: number): number {
		this.expect(index, TAG_BYTE4);
		return this.u32();
	}
	float(index: number): number {
		this.expect(index, TAG_BYTE4);
		return this.f32();
	}
	double(index: number): number {
		this.expect(index, TAG_BYTE8);
		return this.f64();
	}
	/** A tagged length-prefixed subblock; returns a reader over its body. */
	sub(index: number): Reader {
		this.expect(index, TAG_LENGTH4);
		const length = this.u32();
		const inner = new Reader(this.view, this.offset, this.offset + length);
		this.offset += length;
		return inner;
	}
	/** Skip one field of whatever type comes next. */
	skipField(): void {
		const tag = this.tag();
		switch (tag.type) {
			case TAG_BYTE1:
				this.offset += 1;
				break;
			case TAG_BYTE4:
				this.offset += 4;
				break;
			case TAG_BYTE8:
				this.offset += 8;
				break;
			case TAG_LENGTH4: {
				// Read first: `offset += u32()` would add to the pre-read offset.
				const length = this.u32();
				this.offset += length;
				break;
			}
			case TAG_ID:
				this.crdtId();
				break;
			default:
				throw new Error(`unknown tag type ${tag.type}`);
		}
	}
}

const LAYER_ROOT_KEYS = new Set(["0:1", "0:11"]);

/** Points of a line value, 14 bytes each in version 2, 24 in version 1. */
function readPoints(reader: Reader, version: number): StrokePoint[] {
	const size = version === 1 ? 24 : 14;
	const points: StrokePoint[] = [];
	while (reader.remaining >= size) {
		const x = reader.f32();
		const y = reader.f32();
		if (version === 1) {
			reader.f32();
			reader.f32();
			const width = Math.round(reader.f32() * 4);
			const pressure = reader.f32() * 255;
			points.push({ x, y, width, pressure });
		} else {
			reader.u16();
			const width = reader.u16();
			reader.u8();
			const pressure = reader.u8();
			points.push({ x, y, width, pressure });
		}
	}
	return points;
}

interface GroupInfo {
	anchorOriginX?: number;
	anchored: boolean;
	/** The text character the group is anchored to, when it is. */
	anchorId?: ItemId;
}

/**
 * Anchor ids of author 0 with a huge counter are markers, not characters —
 * rmscene's samples anchor lasso moves to (0, 2^48 − 2). rmc resolves them
 * to y = 0 on a page without typed text, which is every notebook we write.
 */
function isMarkerAnchor(id: ItemId): boolean {
	return id.author === 0 && id.counter >= 2 ** 40;
}

/** Read a tree node block for its anchor fields (fields 7–10, all LWW). */
function readTreeNode(reader: Reader): { id: ItemId; group: GroupInfo } {
	const id = reader.id(1);
	const group: GroupInfo = { anchored: false };
	while (reader.remaining > 0) {
		const tag = reader.peekTag();
		if (tag === null) break;
		if (tag.type === TAG_LENGTH4 && (tag.index === 7 || tag.index === 10)) {
			const sub = reader.sub(tag.index);
			sub.id(1); // timestamp
			if (tag.index === 7) {
				group.anchorId = sub.id(2);
				group.anchored = true;
			} else {
				group.anchorOriginX = sub.float(2);
			}
		} else {
			reader.skipField();
		}
	}
	return { id, group };
}

/** One code point, format code or erased character (value null) of the text sequence. */
interface TextChar {
	id: ItemId;
	left: ItemId;
	right: ItemId;
	value: string | number | null;
}

interface RawRootText {
	chars: TextChar[];
	/** Newline id → paragraph style code. */
	styles: Map<string, number>;
	x: number;
	y: number;
	width: number;
}

/**
 * Items store runs whose later characters have implicit ids (counter + i);
 * other items' left/right ids point at those, so the sequence can only be
 * ordered one character at a time (rmscene expand_text_item).
 */
function expandTextItem(
	out: TextChar[],
	id: ItemId,
	left: ItemId,
	right: ItemId,
	deletedLength: number,
	value: string | number,
): void {
	const units: (string | number | null)[] =
		deletedLength > 0
			? new Array<null>(deletedLength).fill(null)
			: typeof value === "number"
				? [value]
				: Array.from(value);
	let leftId = left;
	units.forEach((unit, i) => {
		const charId = { author: id.author, counter: id.counter + i };
		const rightId = i === units.length - 1 ? right : { author: id.author, counter: id.counter + i + 1 };
		out.push({ id: charId, left: leftId, right: rightId, value: unit });
		leftId = charId;
	});
}

function readRootText(reader: Reader): RawRootText {
	reader.id(1);
	const body = reader.sub(2);
	const items = body.sub(1).sub(1);
	const chars: TextChar[] = [];
	const itemCount = items.varuint();
	for (let i = 0; i < itemCount; i++) {
		const item = items.sub(0);
		const id = item.id(2);
		const left = item.id(3);
		const right = item.id(4);
		const deletedLength = item.int(5);
		let value: string | number = "";
		if (item.has(6, TAG_LENGTH4)) {
			const string = item.sub(6);
			const length = string.varuint();
			string.u8();
			value = string.utf8(length);
			// A format code rides on an empty string (rmscene read_string_with_format).
			if (string.has(2, TAG_BYTE4)) value = string.int(2);
		}
		expandTextItem(chars, id, left, right, deletedLength, value);
	}
	const styles = new Map<string, number>();
	const formats = body.sub(2).sub(1);
	const styleCount = formats.varuint();
	for (let i = 0; i < styleCount; i++) {
		const charId = formats.crdtId();
		formats.id(1);
		const style = formats.sub(2);
		style.expect(1, TAG_BYTE1);
		styles.set(idKey(charId), style.u8());
	}
	const position = reader.sub(3);
	const x = position.f64();
	const y = position.f64();
	return { chars, styles, x, y, width: reader.float(4) };
}

/** (0, 0): the start and end of every CRDT sequence, and the first paragraph's key. */
const SEQUENCE_END: ItemId = { author: 0, counter: 0 };

/**
 * The CRDT sequence in document order: Kahn's algorithm over left → item →
 * right, concurrent inserts broken by higher author first, then lower
 * counter — rmscene's toposort_items, which matches the tablet's own order.
 * Unknown neighbours count as the sequence ends. Throws on a cycle.
 */
function orderTextChars(chars: TextChar[]): TextChar[] {
	const byKey = new Map(chars.map((char) => [idKey(char.id), char]));
	const START = "start";
	const FINISH = "finish";
	const endKey = idKey(SEQUENCE_END);
	const side = (id: ItemId, fallback: string): string => {
		const key = idKey(id);
		return key !== endKey && byKey.has(key) ? key : fallback;
	};
	const inDegree = new Map<string, number>([[START, 0], [FINISH, 0]]);
	const dependents = new Map<string, string[]>();
	const edge = (from: string, to: string): void => {
		const list = dependents.get(from);
		if (list === undefined) dependents.set(from, [to]);
		else list.push(to);
		inDegree.set(to, (inDegree.get(to) ?? 0) + 1);
	};
	for (const [key, char] of byKey) {
		if (!inDegree.has(key)) inDegree.set(key, 0);
		edge(side(char.left, START), key);
		edge(key, side(char.right, FINISH));
	}
	const rank = (key: string): [number, number, number] => {
		if (key === START) return [0, 0, 0];
		if (key === FINISH) return [2, 0, 0];
		const { id } = byKey.get(key)!;
		return [1, -id.author, id.counter];
	};
	const ready = new MinHeap<string>((a, b) => {
		const ra = rank(a);
		const rb = rank(b);
		return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2];
	});
	for (const [key, degree] of inDegree) if (degree === 0) ready.push(key);
	const ordered: TextChar[] = [];
	for (let key = ready.pop(); key !== undefined; key = ready.pop()) {
		const char = byKey.get(key);
		if (char !== undefined) ordered.push(char);
		if (key === FINISH) break;
		for (const next of dependents.get(key) ?? []) {
			const degree = inDegree.get(next)! - 1;
			inDegree.set(next, degree);
			if (degree === 0) ready.push(next);
		}
	}
	if (ordered.length !== byKey.size) throw new Error("cyclic text sequence");
	return ordered;
}

class MinHeap<T> {
	private items: T[] = [];
	constructor(private readonly compare: (a: T, b: T) => number) {}
	push(item: T): void {
		const items = this.items;
		items.push(item);
		for (let i = items.length - 1; i > 0; ) {
			const parent = (i - 1) >> 1;
			if (this.compare(items[i], items[parent]) >= 0) break;
			[items[i], items[parent]] = [items[parent], items[i]];
			i = parent;
		}
	}
	pop(): T | undefined {
		const items = this.items;
		const top = items[0];
		const last = items.pop();
		if (items.length > 0 && last !== undefined) {
			items[0] = last;
			for (let i = 0; ; ) {
				const left = 2 * i + 1;
				const right = left + 1;
				let least = i;
				if (left < items.length && this.compare(items[left], items[least]) < 0) least = left;
				if (right < items.length && this.compare(items[right], items[least]) < 0) least = right;
				if (least === i) break;
				[items[i], items[least]] = [items[least], items[i]];
				i = least;
			}
		}
		return top;
	}
}

/** Inline format codes in the text sequence (firmware 3.3+, rmscene TextDocument). */
const FORMAT_BOLD_ON = 1;
const FORMAT_BOLD_OFF = 2;
const FORMAT_ITALIC_ON = 3;
const FORMAT_ITALIC_OFF = 4;

/** rmc's text layout, the only published estimate of where paragraphs sit. */
const TEXT_TOP_Y = -88;
const LINE_HEIGHTS: Partial<Record<ParagraphStyle, number>> = {
	plain: 70,
	bold: 70,
	heading: 150,
	bullet: 35,
	bullet2: 35,
	checkbox: 35,
	"checkbox-checked": 35,
};
const MARKER_TOP = idKey({ author: 0, counter: 2 ** 48 - 2 });
const MARKER_BOTTOM = idKey({ author: 0, counter: 2 ** 48 - 1 });

/**
 * Paragraphs and, for anchored ink, the y of every character id. Every
 * newline opens a paragraph keyed by its id; the first is keyed (0, 0) — so
 * text that starts with a newline starts with an empty paragraph (rmscene's
 * TextDocument folds that one away). Erased characters have no text but keep
 * a place in the layout, as in rmc: ink anchored to them stays put.
 */
function resolveText(raw: RawRootText): { text: SceneText; anchorY: Map<string, number> } {
	type Draft = { paragraph: TextParagraph; anchorKeys: string[] };
	const drafts: Draft[] = [];
	const open = (startId: ItemId): Draft => {
		const code = raw.styles.get(idKey(startId)) ?? 1;
		const style: ParagraphStyle = PARAGRAPH_STYLES[code] ?? "plain";
		const draft: Draft = {
			paragraph: { style, spans: [], startId, text: "", charIds: [] },
			anchorKeys: [idKey(startId)],
		};
		drafts.push(draft);
		return draft;
	};
	let current: Draft | undefined;
	let bold = false;
	let italic = false;
	let live = false;
	for (const char of orderTextChars(raw.chars)) {
		const value = char.value;
		if (typeof value === "number") {
			if (value === FORMAT_BOLD_ON) bold = true;
			else if (value === FORMAT_BOLD_OFF) bold = false;
			else if (value === FORMAT_ITALIC_ON) italic = true;
			else if (value === FORMAT_ITALIC_OFF) italic = false;
			continue;
		}
		current ??= open(SEQUENCE_END);
		if (value === "\n") {
			current = open(char.id);
			live = true;
			continue;
		}
		current.anchorKeys.push(idKey(char.id));
		if (value === null) continue;
		live = true;
		const paragraph = current.paragraph;
		paragraph.text += value;
		paragraph.charIds.push(char.id);
		const last = paragraph.spans[paragraph.spans.length - 1];
		if (last !== undefined && last.bold === bold && last.italic === italic) last.text += value;
		else paragraph.spans.push({ text: value, bold, italic });
	}

	const anchorY = new Map<string, number>();
	let y = raw.y + TEXT_TOP_Y;
	anchorY.set(MARKER_TOP, y);
	for (const { paragraph, anchorKeys } of drafts) {
		for (const key of anchorKeys) anchorY.set(key, y);
		y += LINE_HEIGHTS[paragraph.style] ?? 70;
	}
	anchorY.set(MARKER_BOTTOM, y);
	const paragraphs = live ? drafts.map((draft) => draft.paragraph) : [];
	return { text: { paragraphs, x: raw.x, y: raw.y, width: raw.width }, anchorY };
}

/** Parse a whole page. */
export function parseRmScene(bytes: Uint8Array): RmScene {
	const scene: RmScene = { lines: [], deleted: [], authors: new Map(), blockTypes: {} };
	if (bytes.length < RM_V6_HEADER.length) return scene;
	for (let i = 0; i < RM_V6_HEADER.length; i++) {
		if (bytes[i] !== RM_V6_HEADER.charCodeAt(i)) return scene;
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const groups = new Map<string, GroupInfo>();
	const groupParent = new Map<string, string>();
	let hasRootText = false;
	let textAnchors = new Map<string, number>();
	/** group item: node id → parent node id, so nested groups resolve. */
	const pending: { line: SceneLine; parentKey: string; rawX: number[] }[] = [];

	let offset = RM_V6_HEADER.length;
	while (offset + 8 <= bytes.length) {
		const length = view.getUint32(offset, true);
		const currentVersion = view.getUint8(offset + 6);
		const blockType = view.getUint8(offset + 7);
		const start = offset + 8;
		const end = start + length;
		if (end > bytes.length) break;
		scene.blockTypes[blockType] = (scene.blockTypes[blockType] ?? 0) + 1;
		const reader = new Reader(view, start, end);
		try {
			if (blockType === BLOCK_AUTHOR_IDS) {
				const count = reader.varuint();
				for (let i = 0; i < count; i++) {
					const sub = reader.sub(0);
					const uuidLength = sub.varuint();
					let hex = "";
					for (let k = 0; k < uuidLength; k++) hex += sub.u8().toString(16).padStart(2, "0");
					scene.authors.set(sub.u16(), hex);
				}
			} else if (blockType === BLOCK_SCENE_INFO) {
				while (reader.remaining > 0) {
					const tag = reader.peekTag();
					if (tag === null) break;
					if (tag.index === 5 && tag.type === TAG_LENGTH4) {
						const sub = reader.sub(5);
						const width = sub.u32();
						const height = sub.u32();
						if (width > 0 && height > 0) scene.paperSize = { width, height };
					} else {
						reader.skipField();
					}
				}
			} else if (blockType === BLOCK_TREE_NODE) {
				const { id, group } = readTreeNode(reader);
				groups.set(idKey(id), group);
			} else if (blockType === BLOCK_GROUP_ITEM) {
				// Which node a group sits in, so nested offsets add up.
				const parent = reader.id(1);
				reader.id(2);
				reader.id(3);
				reader.id(4);
				reader.int(5);
				if (reader.has(6, TAG_LENGTH4)) {
					const value = reader.sub(6);
					value.u8();
					const child = value.id(2);
					groupParent.set(idKey(child), idKey(parent));
				}
			} else if (blockType === BLOCK_ROOT_TEXT) {
				hasRootText = true;
				const { text, anchorY } = resolveText(readRootText(reader));
				scene.text = text;
				textAnchors = anchorY;
			} else if (blockType === BLOCK_LINE_ITEM) {
				const parent = reader.id(1);
				const itemId = reader.id(2);
				reader.id(3);
				reader.id(4);
				const deletedLength = reader.int(5);
				if (!reader.has(6, TAG_LENGTH4)) {
					if (deletedLength > 0) {
						scene.deleted.push({
							author: itemId.author,
							from: itemId.counter,
							length: deletedLength,
						});
					}
				} else {
					const value = reader.sub(6);
					const itemType = value.u8();
					if (itemType === ITEM_TYPE_LINE) {
						const tool = value.int(1);
						const color = value.int(2);
						const thicknessScale = value.double(3);
						value.float(4);
						const pointsBlock = value.sub(5);
						const points = readPoints(pointsBlock, currentVersion);
						let moveFrom: ItemId | undefined;
						if (value.has(6, TAG_ID)) value.id(6);
						if (value.has(7, TAG_ID)) moveFrom = value.id(7);
						let rgb: string | undefined;
						if (value.has(8, TAG_BYTE4)) {
							// Packed as b | g<<8 | r<<16 | a<<24 (rmscene write_color).
							rgb = `#${(value.int(8) & 0xffffff).toString(16).padStart(6, "0")}`;
						}
						if (points.length > 0 && !ERASER_TOOLS.has(tool)) {
							const line: SceneLine = {
								id: itemId,
								parent,
								stroke: { tool, color, thicknessScale, points },
								moveFrom,
								rgb,
								anchored: false,
							};
							scene.lines.push(line);
							pending.push({
								line,
								parentKey: idKey(parent),
								rawX: points.map((point) => point.x),
							});
						}
					}
				}
			}
		} catch {
			// One unreadable block costs that block only.
		}
		offset = end;
	}

	// Group anchors are known only once every tree node has been read. Walk
	// up the chain: x origins add up; y is only unknown when some group is
	// anchored to a real character of typed text, and then estimated.
	for (const { line, parentKey } of pending) {
		let key: string | undefined = parentKey;
		let offsetX = 0;
		let anchored = false;
		let anchorY: number | undefined = 0;
		for (let depth = 0; key !== undefined && !LAYER_ROOT_KEYS.has(key) && depth < 16; depth++) {
			const group = groups.get(key);
			if (group !== undefined) {
				offsetX += group.anchorOriginX ?? 0;
				if (
					group.anchored &&
					group.anchorId !== undefined &&
					!(isMarkerAnchor(group.anchorId) && !hasRootText)
				) {
					anchored = true;
					const y = textAnchors.get(idKey(group.anchorId));
					anchorY = y === undefined || anchorY === undefined ? undefined : anchorY + y;
				}
			}
			key = groupParent.get(key);
		}
		if (offsetX !== 0) for (const point of line.stroke.points) point.x += offsetX;
		line.anchored = anchored;
		if (anchored && anchorY !== undefined) line.textAnchorY = anchorY;
	}
	return scene;
}

/** Is this id inside one of the deleted ranges? */
export function isDeleted(id: ItemId, deleted: DeletedRange[]): boolean {
	return deleted.some(
		(range) =>
			range.author === id.author && id.counter >= range.from && id.counter < range.from + range.length,
	);
}
