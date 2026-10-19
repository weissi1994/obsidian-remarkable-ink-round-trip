/**
 * Markdown → handwritten notebook pages (ink fork).
 *
 * The layout is the PDF typesetter's, unchanged: `typesetBlocks` runs with a
 * recording backend whose fonts are handwriting fonts. Every drawing call it
 * makes — words, bullets, checkboxes, table rules — is then turned into pen
 * strokes in device units. Because the layout map comes out of the very same
 * pass, every word's recorded box is where its ink actually is, and the
 * whole upstream import (marks, anchors, the annotated copy) works on these
 * notebooks as it does on PDFs.
 *
 * Deterministic by construction: same note, same options, same strokes —
 * down to the jitter, which is seeded. The import relies on that to
 * regenerate what was sent and tell the tablet owner's ink from ours.
 */

import { imagePlaceholderText, type Block } from "../convert/mdblocks";
import {
	DrawColor,
	DrawPage,
	HighlightKind,
	MeasureFont,
	PdfLayout,
	PdfLayoutOptions,
	TypesetBackend,
	typesetBlocks,
} from "../convert/pdf";
import { CAP_RATIO, HandFont } from "./glyphs";
import { FIRST_STROKE_COUNTER, HIGHLIGHTER_ARGB, InkLine, InkPoint, PEN, PEN_COLOR, buildInkPageRm } from "./rmwrite";
import { hatchImage, highlighterColorOf, ImageStyle, InkImage } from "./inkimage";
import { diagramKey, drawingSize, drawingStrokes, InkDrawing } from "./inkdrawing";

/** A device's notebook canvas: grid in device units and its pixel density. */
export interface DeviceProfile {
	width: number;
	height: number;
	dpi: number;
}

/**
 * Known canvases. The reMarkable 1/2/Paper Pure and Paper Pro numbers are
 * confirmed upstream (devicecheck 2026-08-20) and by rmscene's test files,
 * whose Paper Pro pages carry paper_size (1620, 2160). The Move's is its
 * screen (954×1696 @ 264 dpi); the "Detect page size" command reads the real
 * paper_size from a notebook made on the tablet, which beats any table.
 */
export const DEVICE_PROFILES: Record<"rm2" | "paperpro" | "move", DeviceProfile> = {
	rm2: { width: 1404, height: 1872, dpi: 226 },
	paperpro: { width: 1620, height: 2160, dpi: 229 },
	move: { width: 954, height: 1696, dpi: 264 },
};

/** Page size in points for a canvas: device pixels at its own density. */
export function pageSizeFor(profile: DeviceProfile): { pageWidth: number; pageHeight: number } {
	const perPoint = profile.dpi / 72;
	return {
		pageWidth: Math.round((profile.width / perPoint) * 100) / 100,
		pageHeight: Math.round((profile.height / perPoint) * 100) / 100,
	};
}

/** How the generated ink is written. */
export interface InkPen {
	tool: number;
	color: number;
	thicknessScale: number;
	/** v2 point width for this pen at this thickness. */
	width: number;
}

export const INK_PENS: Record<"fine" | "medium" | "bold", InkPen> = {
	fine: { tool: PEN.fineliner, color: PEN_COLOR.black, thicknessScale: 1, width: 10 },
	medium: { tool: PEN.fineliner, color: PEN_COLOR.black, thicknessScale: 2, width: 16 },
	bold: { tool: PEN.fineliner, color: PEN_COLOR.black, thicknessScale: 3, width: 24 },
};

export interface InkFonts {
	body: HandFont;
	bold: HandFont;
	italic: HandFont;
	mono: HandFont;
}

export interface InkRenderOptions {
	profile: DeviceProfile;
	fonts: InkFonts;
	pen: InkPen;
	/** 0 = mechanically even, 1 = noticeably hand-made. */
	jitter: number;
	/** Seeds the jitter; the document id keeps it stable across re-imports. */
	seed: string;
	/**
	 * Pictures by the name their placeholder line carries (`[image: name]`),
	 * already quantised. A placeholder without one stays a text line.
	 */
	images?: Record<string, InkImage>;
	/** How pictures are drawn; absent = coloured hatch. */
	imageStyle?: ImageStyle;
	/** Diagrams by diagramKey(source): Mermaid blocks drawn by hand. */
	drawings?: Record<string, InkDrawing>;
	/**
	 * Colour accents: highlighter bands behind code, inline code and quotes,
	 * and diagram fills as highlighter instead of hatching. Absent on sends
	 * made before the feature, which must replay without them.
	 */
	accents?: boolean;
	/**
	 * Inline styling: bold and italic words, highlighted, struck and
	 * underlined ones. Absent on sends made before it, which replay plain.
	 */
	inline?: boolean;
}

/** Highlighter colour per accent; the rM 2 and 1 show every one as grey. */
export const ACCENT_COLORS: Record<Exclude<HighlightKind, "mark">, number> = {
	"code": PEN_COLOR.blue,
	"inline-code": PEN_COLOR.pink,
	"quote": PEN_COLOR.yellow,
	"table-header": PEN_COLOR.grey,
};

/** The placeholder line preprocessing leaves for an image embed. */
const IMAGE_PLACEHOLDER = /^\[image: (.+)\]$/;

/**
 * Swap image placeholder paragraphs for image blocks where the picture is
 * known, and Mermaid code blocks for drawing blocks where the diagram is.
 */
export function withImageBlocks(
	blocks: Block[],
	images: Record<string, InkImage> | undefined,
	drawings: Record<string, InkDrawing> | undefined = undefined,
): Block[] {
	const hasImages = images !== undefined && Object.keys(images).length > 0;
	const hasDrawings = drawings !== undefined && Object.keys(drawings).length > 0;
	if (!hasImages && !hasDrawings) return blocks;
	return blocks.map((block) => {
		if (block.type === "code" && drawings !== undefined) {
			const key = diagramKey(block.lines.join("\n"));
			const drawing = drawings[key];
			if (drawing !== undefined) return { type: "inkimage", name: key, ...drawingSize(drawing) };
			return block;
		}
		if (images === undefined) return block;
		const text =
			block.type === "paragraph"
				? block.text.trim()
				: block.type === "imageref"
					? imagePlaceholderText(block)
					: undefined;
		if (text === undefined) return block;
		const match = IMAGE_PLACEHOLDER.exec(text);
		const image = match === null ? undefined : images[match[1]];
		if (match === null || image === undefined) return block;
		// Natural size: pixels at 96 dpi, in points.
		return { type: "inkimage", name: match[1], width: image.sourceWidth * 0.75, height: image.sourceHeight * 0.75 };
	});
}

/** One stroke this plugin wrote, as the import needs to recognise it. */
export interface GeneratedStroke {
	/** CRDT counter of the line item (author 1). */
	counter: number;
	/** Layout word id this stroke belongs to; null for bullets, rules, boxes. */
	wordId: number | null;
	tool: number;
	color: number;
	thicknessScale: number;
	/** v2 point width, when not the pen's own (highlighter bands). */
	width?: number;
	/** Absolute device coordinates. */
	points: { x: number; y: number }[];
}

export interface InkRender {
	layout: PdfLayout;
	/** Strokes per page, index 0 = page 1. */
	pages: GeneratedStroke[][];
}

/* ------------------------------------------------------------------ */
/* Recording backend                                                   */
/* ------------------------------------------------------------------ */

type DrawOp =
	| { kind: "text"; text: string; x: number; y: number; size: number; font: HandFont; color?: DrawColor }
	| { kind: "image"; name: string; x: number; y: number; width: number; height: number }
	| {
			kind: "highlight";
			x: number;
			y: number;
			width: number;
			height: number;
			highlight: HighlightKind;
			rgb?: string;
	  }
	| { kind: "decoration"; x1: number; x2: number; y: number; size: number; decoration: "strike" | "underline" }
	| {
			kind: "line";
			x1: number;
			y1: number;
			x2: number;
			y2: number;
			thickness: number;
			color?: DrawColor;
	  }
	| {
			kind: "rect";
			x: number;
			y: number;
			width: number;
			height: number;
			thickness: number;
			color?: DrawColor;
	  };

class RecordingBackend implements TypesetBackend {
	readonly pages: DrawOp[][] = [];

	constructor(readonly fonts: InkFonts) {}

	get body(): MeasureFont {
		return this.fonts.body;
	}
	get bold(): MeasureFont {
		return this.fonts.bold;
	}
	get italic(): MeasureFont {
		return this.fonts.italic;
	}
	get mono(): MeasureFont {
		return this.fonts.mono;
	}

	addPage(): DrawPage {
		const ops: DrawOp[] = [];
		this.pages.push(ops);
		return {
			drawText: (text, o) => {
				ops.push({
					kind: "text",
					text,
					x: o.x,
					y: o.y,
					size: o.size,
					font: o.font as HandFont,
					color: o.color,
				});
			},
			drawLine: (o) => {
				ops.push({
					kind: "line",
					x1: o.start.x,
					y1: o.start.y,
					x2: o.end.x,
					y2: o.end.y,
					thickness: o.thickness ?? 1,
					color: o.color,
				});
			},
			drawRectangle: (o) => {
				ops.push({
					kind: "rect",
					x: o.x,
					y: o.y,
					width: o.width,
					height: o.height,
					thickness: o.borderWidth ?? 1,
					color: o.borderColor,
				});
			},
			drawHighlight: (o) => {
				ops.push({
					kind: "highlight",
					x: o.x,
					y: o.y,
					width: o.width,
					height: o.height,
					highlight: o.kind,
					rgb: o.rgb,
				});
			},
			drawDecoration: (o) => {
				ops.push({ kind: "decoration", x1: o.x1, x2: o.x2, y: o.y, size: o.size, decoration: o.kind });
			},
			drawImage: (name, o) => {
				ops.push({ kind: "image", name, x: o.x, y: o.y, width: o.width, height: o.height });
			},
		};
	}
}

/* ------------------------------------------------------------------ */
/* Deterministic jitter                                                */
/* ------------------------------------------------------------------ */

/** FNV-1a over a string, for seeding. */
function hash32(text: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

/** mulberry32: small, fast, good enough to wobble a pen. */
function prng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

/** The highlighter colour for a marked word; yellow when none was given. */
function markColorOf(rgb: string | undefined): number {
	if (rgb === undefined) return PEN_COLOR.yellow;
	const hex = rgb.length === 4 ? [...rgb.slice(1)].map((c) => c + c).join("") : rgb.slice(1);
	const value = parseInt(hex, 16);
	if (!Number.isFinite(value)) return PEN_COLOR.yellow;
	return highlighterColorOf((value >> 16) & 255, (value >> 8) & 255, value & 255) ?? PEN_COLOR.yellow;
}

/** Grey for anything the typesetter drew lighter than near-black. */
function penColorFor(color: DrawColor | undefined, pen: InkPen): number {
	if (color === undefined) return pen.color;
	const rgbColor = color as unknown as { red?: number; green?: number; blue?: number };
	const luminance =
		0.299 * (rgbColor.red ?? 0) + 0.587 * (rgbColor.green ?? 0) + 0.114 * (rgbColor.blue ?? 0);
	return luminance < 0.4 ? pen.color : PEN_COLOR.grey;
}

/** Insert points along long segments so a stroke erases and renders like ink. */
function resample(points: { x: number; y: number }[], step = 5): { x: number; y: number }[] {
	const out: { x: number; y: number }[] = [];
	for (let i = 0; i < points.length; i++) {
		const point = points[i];
		if (i > 0) {
			const prev = points[i - 1];
			const length = Math.hypot(point.x - prev.x, point.y - prev.y);
			if (length < 0.01) continue;
			const pieces = Math.floor(length / step);
			for (let k = 1; k < pieces; k++) {
				const u = k / pieces;
				out.push({ x: prev.x + (point.x - prev.x) * u, y: prev.y + (point.y - prev.y) * u });
			}
		}
		out.push(point);
	}
	return out;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * Typeset `blocks` as handwriting. Pure and deterministic: the send and the
 * import both call this, and must get the same strokes.
 */
export function renderInk(
	blocks: Block[],
	title: string,
	layoutOptions: PdfLayoutOptions,
	options: InkRenderOptions,
): InkRender {
	const backend = new RecordingBackend(options.fonts);
	const pageSize = pageSizeFor(options.profile);
	const typeset = typesetBlocks(
		withImageBlocks(blocks, options.images, options.drawings),
		title,
		{ ...layoutOptions, ...pageSize },
		backend,
	);
	const layout: PdfLayout = {
		...typeset,
		grid: { width: options.profile.width, height: options.profile.height },
	};

	// Which placed line a text op is: the typesetter records the exact same
	// numbers it draws with, so equality is the right test.
	const byPlacement = new Map<string, (typeof layout.lines)[number]>();
	for (const line of layout.lines) {
		byPlacement.set(`${line.page}|${line.x}|${line.y}|${line.text}`, line);
	}

	const sx = options.profile.width / layout.pageWidth;
	const sy = options.profile.height / layout.pageHeight;
	const toDevice = (x: number, y: number) => ({
		x: round2(x * sx - options.profile.width / 2),
		y: round2((layout.pageHeight - y) * sy),
	});

	const pages: GeneratedStroke[][] = backend.pages.map((ops, pageIndex) => {
		const page = pageIndex + 1;
		const strokes: GeneratedStroke[] = [];
		let counter = FIRST_STROKE_COUNTER;
		const add = (
			wordId: number | null,
			points: { x: number; y: number }[],
			color: number,
			thicknessScale: number,
			pen: { tool: number; width: number } | undefined = undefined,
		) => {
			const dense = resample(points);
			if (dense.length === 0) return;
			const stroke: GeneratedStroke = {
				counter: counter++,
				wordId,
				tool: pen?.tool ?? options.pen.tool,
				color,
				thicknessScale,
				points: dense.map((point) => ({ x: round2(point.x), y: round2(point.y) })),
			};
			if (pen !== undefined) stroke.width = pen.width;
			strokes.push(stroke);
		};

		for (const op of ops) {
			if (op.kind === "decoration") {
				if (options.inline !== true) continue;
				// Through the middle of the lower-case letters, or just under
				// the baseline.
				const cap = op.size * CAP_RATIO;
				const y = op.decoration === "strike" ? op.y + cap * 0.42 : op.y - op.size * 0.14;
				add(null, [toDevice(op.x1, y), toDevice(op.x2, y)], options.pen.color, options.pen.thicknessScale);
			} else if (op.kind === "highlight") {
				if (op.highlight === "mark" ? options.inline !== true : options.accents !== true) continue;
				const color =
					op.highlight === "mark"
						? markColorOf(op.rgb)
						: ACCENT_COLORS[op.highlight];
				const top = toDevice(op.x, op.y + op.height);
				const bottom = toDevice(op.x + op.width, op.y);
				const height = bottom.y - top.y;
				// One band per ~7 pt of height; each a little wider than its
				// share so neighbouring bands and lines join without gaps.
				const rows = Math.max(1, Math.ceil(height / (7 * options.profile.dpi / 72)));
				const band = height / rows;
				// The pen's round ends reach past the points by half a band.
				const inset = Math.max(0, Math.min(band / 2, (bottom.x - top.x) / 2 - 0.5));
				for (let row = 0; row < rows; row++) {
					const y = top.y + band * (row + 0.5);
					add(
						null,
						[
							{ x: top.x + inset, y },
							{ x: bottom.x - inset, y },
						],
						color,
						1,
						{ tool: PEN.highlighter, width: Math.round(band * 1.1 * 4) },
					);
				}
			} else if (op.kind === "text") {
				const placed = byPlacement.get(`${page}|${op.x}|${op.y}|${op.text}`);
				const color = penColorFor(op.color, options.pen);
				const fontWeight = op.font.style.weight ?? 1;
				const fontSlant = op.font.style.slant ?? 0;
				const cap = op.size * CAP_RATIO;
				const space = op.font.widthOfTextAtSize(" ", op.size);
				let cursor = op.x;
				let wordIndex = 0;
				// The same walk as the typesetter's placeWords, so ink and word
				// boxes line up exactly.
				for (const part of op.text.split(" ")) {
					if (part === "") {
						cursor += space;
						continue;
					}
					const wordId = placed?.words[wordIndex]?.id ?? null;
					const style = options.inline === true ? placed?.words[wordIndex]?.style : undefined;
					wordIndex++;
					// Bold and italic do not change a word's width, so styling it
					// moves nothing on the page.
					const weight =
						style?.bold === true ? Math.max(fontWeight, options.fonts.bold.style.weight ?? 1) : fontWeight;
					const slant =
						style?.italic === true && fontSlant === 0 ? (options.fonts.italic.style.slant ?? 0) : fontSlant;
					const random = prng(hash32(`${options.seed}|${page}|${wordId ?? `d${cursor}`}`));
					const amount = Math.max(0, Math.min(1, options.jitter));
					// Per-word wobble: baseline and a hint of size. Kept well
					// inside the word box so mark reading is unaffected.
					const wordDy = (random() - 0.5) * 0.08 * amount;
					const wordScale = 1 + (random() - 0.5) * 0.05 * amount;
					let charX = cursor;
					for (const ch of part) {
						const advance = op.font.advanceOf(ch);
						const glyph = op.font.glyph(ch, Math.floor(random() * 1000));
						const dx = (random() - 0.5) * 0.04 * amount;
						const dy = wordDy + (random() - 0.5) * 0.04 * amount;
						// A mono font centres each glyph in its fixed cell.
						const centre =
							op.font.style.monoAdvance !== undefined
								? (op.font.style.monoAdvance - glyph.advance) / 2
								: 0;
						for (const path of glyph.strokes) {
							const points: { x: number; y: number }[] = [];
							for (let i = 0; i + 1 < path.length; i += 2) {
								const gy = (path[i + 1] + dy) * wordScale;
								const gx = (path[i] + centre + dx) * wordScale + gy * slant;
								points.push(toDevice(charX + gx * cap, op.y + gy * cap));
							}
							if (points.length === 1) points.push({ ...points[0], x: points[0].x + 0.5 });
							add(wordId, points, color, options.pen.thicknessScale * weight);
						}
						charX += advance * cap;
					}
					cursor += op.font.widthOfTextAtSize(part, op.size) + space;
				}
			} else if (op.kind === "image") {
				const topLeft = toDevice(op.x, op.y + op.height);
				const bottomRight = toDevice(op.x + op.width, op.y);
				const drawing = options.drawings?.[op.name];
				if (drawing !== undefined) {
					const strokes = drawingStrokes(drawing, {
						box: {
							left: topLeft.x,
							top: topLeft.y,
							width: bottomRight.x - topLeft.x,
							height: bottomRight.y - topLeft.y,
						},
						font: options.fonts.body,
						color: options.pen.color,
						thickness: Math.max(1, options.pen.thicknessScale * 0.75),
						jitter: options.jitter,
						seed: `${options.seed}|${op.name}`,
						unit: options.profile.dpi / 72,
						colour: options.imageStyle !== "mono-hatch",
						highlighter: options.accents === true,
					});
					for (const stroke of strokes) {
						const pen =
							stroke.tool === undefined || stroke.width === undefined
								? undefined
								: { tool: stroke.tool, width: stroke.width };
						add(null, stroke.points, stroke.color, stroke.thickness, pen);
					}
					continue;
				}
				const image = options.images?.[op.name];
				if (image === undefined) continue;
				const hatch = hatchImage(image, {
					box: {
						left: topLeft.x,
						top: topLeft.y,
						width: bottomRight.x - topLeft.x,
						height: bottomRight.y - topLeft.y,
					},
					style: options.imageStyle ?? "colour-hatch",
					unit: options.profile.dpi / 72,
				});
				// Hatching is drawn with the thinnest pen whatever the text pen.
				for (const stroke of hatch) add(null, stroke.points, stroke.color, 1);
			} else if (op.kind === "line") {
				add(
					null,
					[toDevice(op.x1, op.y1), toDevice(op.x2, op.y2)],
					penColorFor(op.color, options.pen),
					op.thickness >= 1.2 ? options.pen.thicknessScale : Math.max(1, options.pen.thicknessScale / 2),
				);
			} else {
				add(
					null,
					[
						toDevice(op.x, op.y),
						toDevice(op.x + op.width, op.y),
						toDevice(op.x + op.width, op.y + op.height),
						toDevice(op.x, op.y + op.height),
						toDevice(op.x, op.y),
					],
					penColorFor(op.color, options.pen),
					Math.max(1, options.pen.thicknessScale * 0.75),
				);
			}
		}
		return strokes;
	});

	return { layout, pages };
}

/** Direction of travel as the device stores it: 0–255 around the circle. */
function directionOf(dx: number, dy: number): number {
	if (dx === 0 && dy === 0) return 0;
	const angle = Math.atan2(dy, dx);
	return Math.round((((angle + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI)) * 255) & 0xff;
}

/**
 * Strokes → v2 points with the pressure and width a real pen would leave.
 * `exactColours`: a colour tablet's highlighter writes the "highlight" entry
 * plus the exact colour; given a palette entry instead, the Paper Pro shows
 * that entry's pen colour — dark — and ignores the exact one.
 */
export function toInkLines(strokes: GeneratedStroke[], pen: InkPen, exactColours = false): InkLine[] {
	return strokes.map((stroke) => {
		const widthScale = stroke.thicknessScale / pen.thicknessScale;
		const points: InkPoint[] = stroke.points.map((point, index) => {
			const next = stroke.points[Math.min(index + 1, stroke.points.length - 1)];
			const prev = stroke.points[Math.max(index - 1, 0)];
			return {
				x: point.x,
				y: point.y,
				width: stroke.width ?? pen.width * widthScale,
				pressure: 200,
				speed: 6,
				direction: directionOf(next.x - prev.x, next.y - prev.y),
			};
		});
		const argb = stroke.tool === PEN.highlighter ? HIGHLIGHTER_ARGB[stroke.color] : undefined;
		return {
			counter: stroke.counter,
			tool: stroke.tool,
			color: exactColours && argb !== undefined ? PEN_COLOR.highlight : stroke.color,
			thicknessScale: stroke.thicknessScale,
			points,
			...(argb === undefined ? {} : { argb }),
		};
	});
}

/** Colour tablets (Paper Pro, Move); the reMarkable 1 and 2 share the 1404×1872 canvas. */
export function hasColour(profile: DeviceProfile): boolean {
	return !(profile.width === 1404 && profile.height === 1872);
}

/** The `.rm` bytes of every page of a render. */
export function inkPagesToRm(render: InkRender, options: InkRenderOptions): Uint8Array[] {
	return render.pages.map((strokes) =>
		buildInkPageRm(toInkLines(strokes, options.pen, hasColour(options.profile)), {
			paperSize: { width: options.profile.width, height: options.profile.height },
		}),
	);
}
