/**
 * Writing pen strokes into a v6 `.rm` page (ink fork).
 *
 * The block list follows rmscene (MIT, Rick Lupton) — the same reference the
 * stroke reader was built
 * against: author table, migration and page info, the scene info carrying the
 * paper size, the root group and "Layer 1" (plus an empty layer on top to
 * write on, for handwriting sheets), then one line item per stroke,
 * chained left-to-right as a CRDT sequence inside the layer.
 *
 * Every stroke gets an id the import can recognise: author 1 (our own, an
 * all-zero UUID that names nobody) and a counter from FIRST_STROKE_COUNTER
 * upwards in drawing order. The tablet writes its own strokes under its own
 * author, and moved or erased strokes leave tombstones and `move_id`
 * back-references to these ids — which is how a returning page says exactly
 * which generated words were erased or moved.
 */

import { ByteWriter, HEADER, type CrdtId } from "./rmbytes";

const BLOCK_AUTHOR_IDS = 0x09;
const BLOCK_MIGRATION_INFO = 0x00;
const BLOCK_PAGE_INFO = 0x0a;
const BLOCK_SCENE_INFO = 0x0d;
const BLOCK_SCENE_TREE = 0x01;
const BLOCK_TREE_NODE = 0x02;
const BLOCK_SCENE_GROUP_ITEM = 0x04;
const BLOCK_SCENE_LINE_ITEM = 0x05;
const GROUP_ITEM_TYPE = 0x02;
const LINE_ITEM_TYPE = 0x03;

/** Our author index in the page's author table. */
export const INK_AUTHOR = 1;
/** First counter used for generated strokes; lower ids are structural. */
export const FIRST_STROKE_COUNTER = 100;

const id = (part1: number, part2: number): CrdtId => ({ part1, part2 });
const END = id(0, 0);
const ROOT = id(0, 1);
const LAYER = id(0, 11);
/**
 * A second layer, on top, for the owner to write on (handwriting sheets): the
 * node, its label's timestamp, and its place among the root's children —
 * structural ids, below FIRST_STROKE_COUNTER like Layer 1's. Shaped as in
 * rmscene's Normal_A_stroke_2_layers test file.
 */
const WRITING_LAYER = id(0, 14);
const WRITING_LAYER_LABEL = id(0, 15);
const WRITING_LAYER_ITEM = id(0, 16);

/** reMarkable pen ids (rmscene `Pen`). */
export const PEN = {
	ballpoint: 15,
	fineliner: 17,
	pencil: 14,
	mechanicalPencil: 13,
	marker: 16,
	highlighter: 18,
} as const;

/** reMarkable colour ids (rmscene `PenColor`). */
export const PEN_COLOR = {
	black: 0,
	grey: 1,
	white: 2,
	yellow: 3,
	green: 4,
	pink: 5,
	blue: 6,
	red: 7,
	/** The colour tablets' highlighter: the exact colour rides along (InkLine.argb). */
	highlight: 9,
} as const;

export interface InkPoint {
	x: number;
	y: number;
	/** Pen width at this point (device units ×4 convention of v2 points). */
	width: number;
	pressure: number;
	speed: number;
	/** 0–255, the angle of travel as the device records it. */
	direction: number;
}

export interface InkLine {
	counter: number;
	tool: number;
	color: number;
	thicknessScale: number;
	points: InkPoint[];
	/**
	 * Exact colour as 0xAARRGGBB. The Paper Pro shows this instead of the
	 * palette entry `color` names, which other models keep using.
	 */
	argb?: number;
}

/**
 * The light tints the tablet's own highlighter lays down, per palette entry
 * (blue, yellow and pink as Paper Pro pages record them). Without them a
 * highlighter in the pen palette's blue is dark enough to drown the text.
 */
export const HIGHLIGHTER_ARGB: Record<number, number> = {
	3: 0xffffed75, // yellow
	4: 0xffb2f2bb, // green
	5: 0xfff29eff, // pink
	6: 0xffbeeafe, // blue
	7: 0xffffc9c9, // red
	1: 0xffdee2e6, // grey
};

export interface InkPageOptions {
	/** Paper size in device units, written to the scene info block. */
	paperSize: { width: number; height: number };
	/**
	 * Names of two layers: the strokes go on the first, and the second — on
	 * top, and selected when the page opens — stays empty for the owner to
	 * write on. The tablet's eraser and lasso act on the selected layer only,
	 * so the owner's corrections cannot touch what was written. Absent: one
	 * layer, "Layer 1", as every notebook page.
	 */
	layers?: { strokes: string; writing: string };
}

/**
 * One line item of a page as the scene stores it. Production writes plain
 * lines under author 1; the general shape — other authors, tombstones,
 * move back-references — exists so tests can build pages the way a tablet
 * leaves them after erasing and moving.
 */
export interface SceneItemSpec {
	author: number;
	counter: number;
	/** The stroke; absent for a tombstone. */
	line?: Omit<InkLine, "counter">;
	/** Counters this (value-less) item deletes, starting at its own. */
	deletedLength?: number;
	moveFrom?: { author: number; counter: number };
	/** Written on the writing layer (InkPageOptions.layers), as the owner's ink lands there. */
	onWritingLayer?: boolean;
}

/**
 * Build one page. Lines are written in the order given; their counters must
 * be unique and increasing (the CRDT sequence orders by left neighbour).
 */
export function buildInkPageRm(lines: InkLine[], options: InkPageOptions): Uint8Array {
	return buildScenePageRm(
		lines.map((line) => ({ author: INK_AUTHOR, counter: line.counter, line })),
		options,
	);
}

/** The general writer behind buildInkPageRm (see SceneItemSpec). */
export function buildScenePageRm(items: SceneItemSpec[], options: InkPageOptions): Uint8Array {
	const w = new ByteWriter();
	w.raw(new TextEncoder().encode(HEADER));

	const authors = [...new Set([INK_AUTHOR, ...items.map((item) => item.author)])].sort(
		(a, b) => a - b,
	);
	w.block(BLOCK_AUTHOR_IDS, 1, 1, (b) => {
		b.varuint(authors.length);
		for (const author of authors) {
			b.subblock(0, (s) => {
				s.varuint(16);
				// Ours is all zeros; any other author gets a recognisable stand-in.
				s.raw(new Array<number>(16).fill(author === INK_AUTHOR ? 0 : author));
				s.u16(author);
			});
		}
	});

	w.block(BLOCK_MIGRATION_INFO, 1, 1, (b) => {
		b.taggedId(1, id(1, 1));
		b.taggedBool(2, true);
		b.taggedBool(3, false);
	});

	w.block(BLOCK_PAGE_INFO, 0, 1, (b) => {
		b.taggedInt(1, 1); // loads
		b.taggedInt(2, 0); // merges
		b.taggedInt(3, 0); // text chars
		b.taggedInt(4, 0); // text lines
		b.taggedInt(5, 0); // type folio use count
	});

	w.block(BLOCK_SCENE_INFO, 0, 1, (b) => {
		// current layer
		b.subblock(1, (s) => {
			s.taggedId(1, id(0, 1));
			s.taggedId(2, options.layers === undefined ? LAYER : WRITING_LAYER);
		});
		b.lwwBool(2, id(0, 1), true); // background visible
		b.lwwBool(3, id(0, 1), true); // root document visible
		b.subblock(5, (s) => {
			s.u32(Math.round(options.paperSize.width));
			s.u32(Math.round(options.paperSize.height));
		});
	});

	w.block(BLOCK_SCENE_TREE, 1, 1, (b) => {
		b.taggedId(1, LAYER);
		b.taggedId(2, END);
		b.taggedBool(3, true);
		b.subblock(4, (s) => s.taggedId(1, ROOT));
	});
	if (options.layers !== undefined) {
		w.block(BLOCK_SCENE_TREE, 1, 1, (b) => {
			b.taggedId(1, WRITING_LAYER);
			b.taggedId(2, END);
			b.taggedBool(3, true);
			b.subblock(4, (s) => s.taggedId(1, ROOT));
		});
	}

	w.block(BLOCK_TREE_NODE, 1, 2, (b) => {
		b.taggedId(1, ROOT);
		b.lwwString(2, END, "");
		b.lwwBool(3, END, true);
	});

	w.block(BLOCK_TREE_NODE, 1, 2, (b) => {
		b.taggedId(1, LAYER);
		b.lwwString(2, id(0, 12), options.layers?.strokes ?? "Layer 1");
		b.lwwBool(3, END, true);
	});

	if (options.layers !== undefined) {
		const label = options.layers.writing;
		w.block(BLOCK_TREE_NODE, 1, 2, (b) => {
			b.taggedId(1, WRITING_LAYER);
			b.lwwString(2, WRITING_LAYER_LABEL, label);
			b.lwwBool(3, END, true);
		});
	}

	w.block(BLOCK_SCENE_GROUP_ITEM, 1, 1, (b) => {
		b.taggedId(1, ROOT);
		b.taggedId(2, id(0, 13));
		b.taggedId(3, END);
		b.taggedId(4, END);
		b.taggedInt(5, 0);
		b.subblock(6, (s) => {
			s.u8(GROUP_ITEM_TYPE);
			s.taggedId(2, LAYER);
		});
	});

	if (options.layers !== undefined) {
		// After Layer 1 among the root's children: on top of it.
		w.block(BLOCK_SCENE_GROUP_ITEM, 1, 1, (b) => {
			b.taggedId(1, ROOT);
			b.taggedId(2, WRITING_LAYER_ITEM);
			b.taggedId(3, id(0, 13));
			b.taggedId(4, END);
			b.taggedInt(5, 0);
			b.subblock(6, (s) => {
				s.u8(GROUP_ITEM_TYPE);
				s.taggedId(2, WRITING_LAYER);
			});
		});
	}

	let left = END;
	for (const item of items) {
		const itemId = id(item.author, item.counter);
		const line = item.line;
		w.block(BLOCK_SCENE_LINE_ITEM, 2, 2, (b) => {
			b.taggedId(1, item.onWritingLayer === true ? WRITING_LAYER : LAYER);
			b.taggedId(2, itemId);
			b.taggedId(3, left);
			b.taggedId(4, END);
			b.taggedInt(5, item.deletedLength ?? 0);
			if (line === undefined) return;
			b.subblock(6, (s) => {
				s.u8(LINE_ITEM_TYPE);
				s.taggedInt(1, line.tool);
				s.taggedInt(2, line.color);
				s.taggedDouble(3, line.thicknessScale);
				s.taggedFloat(4, 0); // starting length
				s.subblock(5, (p) => {
					for (const point of line.points) {
						p.f32(point.x);
						p.f32(point.y);
						p.u16(clampInt(point.speed, 0, 0xffff));
						p.u16(clampInt(point.width, 0, 0xffff));
						p.u8(clampInt(point.direction, 0, 255));
						p.u8(clampInt(point.pressure, 0, 255));
					}
				});
				s.taggedId(6, id(0, 1)); // timestamp, as rmscene writes it
				if (item.moveFrom !== undefined) {
					s.taggedId(7, id(item.moveFrom.author, item.moveFrom.counter));
				}
				if (line.argb !== undefined) s.taggedInt(8, line.argb >>> 0);
			});
		});
		left = itemId;
	}

	return w.bytes();
}

function clampInt(value: number, low: number, high: number): number {
	if (!Number.isFinite(value)) return low;
	return Math.min(high, Math.max(low, Math.round(value)));
}
