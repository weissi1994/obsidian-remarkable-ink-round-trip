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
 *   on — the Paper Pro writes (1620, 2160).
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
	 * relative to a text position this reader does not compute.
	 */
	anchored: boolean;
}

export interface DeletedRange {
	author: number;
	from: number;
	length: number;
}

export interface RmScene {
	lines: SceneLine[];
	deleted: DeletedRange[];
	paperSize?: { width: number; height: number };
	/** Author index → UUID hex, for the diagnostic log. */
	authors: Map<number, string>;
	blockTypes: Record<number, number>;
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
	// anchored to a real character of typed text.
	for (const { line, parentKey } of pending) {
		let key: string | undefined = parentKey;
		let offsetX = 0;
		let anchored = false;
		for (let depth = 0; key !== undefined && !LAYER_ROOT_KEYS.has(key) && depth < 16; depth++) {
			const group = groups.get(key);
			if (group !== undefined) {
				offsetX += group.anchorOriginX ?? 0;
				if (group.anchored && !(group.anchorId !== undefined && isMarkerAnchor(group.anchorId) && !hasRootText)) {
					anchored = true;
				}
			}
			key = groupParent.get(key);
		}
		if (offsetX !== 0) for (const point of line.stroke.points) point.x += offsetX;
		line.anchored = anchored;
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
