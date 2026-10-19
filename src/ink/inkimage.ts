/**
 * Images as pen strokes: the coloured-hatch style (ink fork).
 *
 * A picture becomes what you would draw with the tablet's own coloured
 * fineliners: every pixel is reduced to one ink colour and a darkness level,
 * and each colour is filled with parallel hatch lines — one pass for light
 * tones, a crossing pass for mid tones, a third for the darkest. Black and
 * grey carry the shadows; blue, red, green, yellow and pink carry the colour.
 * On a reMarkable without colour the same strokes simply render grey/black.
 *
 * Deterministic by construction: the send stores the quantised grid, not the
 * picture, so the import regenerates exactly the strokes it sent even if the
 * image file changes afterwards.
 */

import { PEN_COLOR } from "./rmwrite";

/** The inks a picture is drawn with, in grid-code order (index 0 = paper). */
export const IMAGE_INKS: { name: string; color: number; rgb: [number, number, number]; hue?: number; angle: number }[] = [
	{ name: "paper", color: PEN_COLOR.white, rgb: [255, 255, 255], angle: 0 },
	{ name: "black", color: PEN_COLOR.black, rgb: [0, 0, 0], angle: 45 },
	{ name: "grey", color: PEN_COLOR.grey, rgb: [140, 140, 140], angle: 45 },
	{ name: "blue", color: PEN_COLOR.blue, rgb: [40, 90, 210], hue: 220, angle: 30 },
	{ name: "red", color: PEN_COLOR.red, rgb: [215, 45, 45], hue: 2, angle: 120 },
	{ name: "green", color: PEN_COLOR.green, rgb: [45, 155, 70], hue: 130, angle: 75 },
	{ name: "yellow", color: PEN_COLOR.yellow, rgb: [240, 200, 40], hue: 50, angle: 165 },
	{ name: "pink", color: PEN_COLOR.pink, rgb: [230, 85, 175], hue: 320, angle: 100 },
];

/** Hue of an ink when a chromatic pixel is nearest to it, per index above. */
const CHROMATIC = [3, 4, 5, 6, 7];

/**
 * A quantised picture: one byte per cell, `ink << 2 | level` (level 1–3;
 * 0 = leave the paper blank). Stored with the send, so it must stay small:
 * the long side is capped at GRID_MAX cells.
 */
export interface InkImage {
	/** Grid size in cells. */
	width: number;
	height: number;
	/** Pixel size of the original picture, for its natural size on the page. */
	sourceWidth: number;
	sourceHeight: number;
	/** Base64 of width × height cell codes, row by row. */
	cells: string;
}

/**
 * Ink the tablet's owner wrote, kept as strokes rather than pixels: what a
 * remark or page image in the vault was drawn from. Sent back, it is written
 * as the very same strokes instead of a hatched copy of its picture.
 */
export interface InkStrokes {
	kind: "strokes";
	/** Natural size as a picture's would be (pixels at 96 dpi): points ÷ 0.75. */
	sourceWidth: number;
	sourceHeight: number;
	/** Extent of the strokes, device units, from 0,0. */
	width: number;
	height: number;
	strokes: {
		tool: number;
		color: number;
		thicknessScale: number;
		/** Flat x, y, width per point; width in the pen's own v2 units. */
		points: number[];
	}[];
	/**
	 * Where a remark was written: beside the printed row with this text, its
	 * left edge `x` points from the page's left, its top `below` points under
	 * that row's baseline (negative: above it). Lets a send draw the ink back
	 * where it was instead of in a callout (inkrender.ts overlays). Absent for
	 * a page the owner added and for remarks read before it was kept.
	 */
	at?: RemarkPlace;
}

export interface RemarkPlace {
	text: string;
	x: number;
	below: number;
}

export function isInkStrokes(picture: InkImage | InkStrokes): picture is InkStrokes {
	return (picture as InkStrokes).kind === "strokes";
}

/** Strokes in device units (as read from a page) → a record at their own size. */
export function inkStrokesOf(
	strokes: { tool: number; color: number; thicknessScale: number; points: { x: number; y: number; width: number }[] }[],
	dpi: number,
): InkStrokes | null {
	const all = strokes.flatMap((s) => s.points);
	if (all.length === 0) return null;
	const minX = Math.min(...all.map((p) => p.x));
	const minY = Math.min(...all.map((p) => p.y));
	const width = Math.max(1, Math.max(...all.map((p) => p.x)) - minX);
	const height = Math.max(1, Math.max(...all.map((p) => p.y)) - minY);
	const round = (v: number) => Math.round(v * 10) / 10;
	// Device pixels at the tablet's density, as points, as "96 dpi pixels".
	const toSource = (v: number) => ((v * 72) / dpi) / 0.75;
	return {
		kind: "strokes",
		sourceWidth: toSource(width),
		sourceHeight: toSource(height),
		width,
		height,
		strokes: strokes.map((s) => ({
			tool: s.tool,
			color: s.color,
			thicknessScale: s.thicknessScale,
			points: s.points.flatMap((p) => [round(p.x - minX), round(p.y - minY), Math.round(p.width)]),
		})),
	};
}

/** What a picture embed is sent as: hatched pixels, or the owner's own strokes. */
export type Picture = InkImage | InkStrokes;

export type ImageStyle = "colour-hatch" | "mono-hatch";

export const GRID_MAX = 200;

/** Grid size for a picture, keeping its aspect ratio. */
export function gridSizeFor(width: number, height: number): { width: number; height: number } {
	const scale = Math.min(1, GRID_MAX / Math.max(width, height, 1));
	return {
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(height * scale)),
	};
}

function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
	const max = Math.max(r, g, b) / 255;
	const min = Math.min(r, g, b) / 255;
	const delta = max - min;
	let h = 0;
	if (delta > 0) {
		const rn = r / 255;
		const gn = g / 255;
		const bn = b / 255;
		if (max === rn) h = 60 * (((gn - bn) / delta) % 6);
		else if (max === gn) h = 60 * ((bn - rn) / delta + 2);
		else h = 60 * ((rn - gn) / delta + 4);
	}
	if (h < 0) h += 360;
	return { h, s: max === 0 ? 0 : delta / max, v: max };
}

function hueDistance(a: number, b: number): number {
	const d = Math.abs(a - b) % 360;
	return d > 180 ? 360 - d : d;
}

/** Highlighter colours by hue; Paper Pro and Move show them, others grey. */
const HIGHLIGHTER_HUES: { color: number; hue: number }[] = [
	{ color: PEN_COLOR.yellow, hue: 55 },
	{ color: PEN_COLOR.green, hue: 125 },
	{ color: PEN_COLOR.blue, hue: 205 },
	{ color: PEN_COLOR.pink, hue: 315 },
	{ color: PEN_COLOR.red, hue: 5 },
];

/**
 * The highlighter colour closest to a fill, or null for near-white. Unlike
 * quantizePixel, pale tints count: a pastel box background is still colour.
 */
export function highlighterColorOf(r: number, g: number, b: number): number | null {
	const { h, s, v } = rgbToHsv(r, g, b);
	if (s < 0.08 || v < 0.2) return v >= 0.93 ? null : PEN_COLOR.grey;
	let best = HIGHLIGHTER_HUES[0];
	for (const candidate of HIGHLIGHTER_HUES) {
		if (hueDistance(h, candidate.hue) < hueDistance(h, best.hue)) best = candidate;
	}
	return best.color;
}

/** One pixel → `ink << 2 | level`, or 0 for paper. Alpha below ½ is paper. */
export function quantizePixel(r: number, g: number, b: number, a = 255): number {
	if (a < 128) return 0;
	const { h, s, v } = rgbToHsv(r, g, b);
	const code = (ink: number, level: number) => (ink << 2) | level;
	// Achromatic, or too dark to tell its colour: black and grey carry tone.
	if (s < 0.12 || v < 0.2) {
		if (v >= 0.86) return 0;
		if (v >= 0.66) return code(2, 1);
		if (v >= 0.46) return code(2, 2);
		if (v >= 0.24) return code(1, 2);
		return code(1, 3);
	}
	let best = CHROMATIC[0];
	for (const ink of CHROMATIC) {
		if (hueDistance(h, IMAGE_INKS[ink].hue!) < hueDistance(h, IMAGE_INKS[best].hue!)) best = ink;
	}
	// Pale colours get one pass, saturated mid tones two, deep ones three.
	const depth = s * 0.6 + (1 - v) * 0.8;
	const level = depth < 0.45 ? 1 : depth < 0.75 ? 2 : 3;
	return code(best, level);
}

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
	const binary = atob(text);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

/**
 * Quantise an RGBA buffer that is already at grid size (the plugin edge
 * scales the picture with a canvas first).
 */
export function quantizeImage(
	rgba: Uint8ClampedArray | Uint8Array,
	width: number,
	height: number,
	sourceWidth = width,
	sourceHeight = height,
): InkImage {
	const cells = new Uint8Array(width * height);
	for (let i = 0; i < cells.length; i++) {
		cells[i] = quantizePixel(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2], rgba[i * 4 + 3]);
	}
	return { width, height, sourceWidth, sourceHeight, cells: toBase64(cells) };
}

export interface HatchStroke {
	color: number;
	points: { x: number; y: number }[];
}

export interface HatchOptions {
	/** Target box in device units: left, top, width, height. */
	box: { left: number; top: number; width: number; height: number };
	style: ImageStyle;
	/** Device units per point of the canvas (dpi / 72). */
	unit: number;
	/** Upper bound on generated points; spacing widens until it fits. */
	maxPoints?: number;
}

/** In mono mode every colour becomes a grey of matching depth. */
function inkFor(ink: number, style: ImageStyle): number {
	if (style === "colour-hatch" || ink <= 2) return ink;
	return 2;
}

/**
 * Hatch a quantised picture into strokes. Each (ink, pass) is a set of
 * parallel lines at that ink's angle; a line is cut into a stroke wherever it
 * runs through cells of that ink at or above the pass's level.
 */
export function hatchImage(image: InkImage, options: HatchOptions): HatchStroke[] {
	const cells = fromBase64(image.cells);
	const maxPoints = options.maxPoints ?? 60000;
	for (let widen = 1; widen <= 4; widen *= 1.5) {
		const strokes = hatchPass(image, cells, options, widen);
		const points = strokes.reduce((sum, stroke) => sum + stroke.points.length, 0);
		if (points <= maxPoints || widen >= 3.3) return strokes;
	}
	return [];
}

function hatchPass(image: InkImage, cells: Uint8Array, options: HatchOptions, widen: number): HatchStroke[] {
	const { box, style } = options;
	const spacing = 2.4 * options.unit * widen; // ≈ 2.4 pt between lines
	const step = Math.max(2, spacing / 2.5); // sampling along a line
	const minRun = spacing * 0.8; // shorter runs are dust, not hatching
	const cellAt = (x: number, y: number): number => {
		const cx = Math.floor(((x - box.left) / box.width) * image.width);
		const cy = Math.floor(((y - box.top) / box.height) * image.height);
		if (cx < 0 || cy < 0 || cx >= image.width || cy >= image.height) return 0;
		return cells[cy * image.width + cx];
	};
	const inks = new Set<number>();
	for (const code of cells) if (code !== 0) inks.add(inkFor(code >> 2, style));

	const strokes: HatchStroke[] = [];
	const cx = box.left + box.width / 2;
	const cy = box.top + box.height / 2;
	const reach = Math.hypot(box.width, box.height) / 2 + spacing;
	for (const ink of [...inks].sort((a, b) => a - b)) {
		for (let pass = 1; pass <= 3; pass++) {
			// Successive passes cross the first: +90°, then +45°.
			const angle = ((IMAGE_INKS[ink].angle + (pass === 2 ? 90 : pass === 3 ? 45 : 0)) * Math.PI) / 180;
			const dx = Math.cos(angle);
			const dy = Math.sin(angle);
			// Lines are offset along the normal; the pass index staggers them.
			const offsetStart = -reach + ((pass - 1) * spacing) / 3;
			for (let offset = offsetStart; offset <= reach; offset += spacing) {
				const ox = cx - dy * offset;
				const oy = cy + dx * offset;
				let run: { x: number; y: number }[] = [];
				const flush = () => {
					if (run.length >= 2) {
						const first = run[0];
						const last = run[run.length - 1];
						if (Math.hypot(last.x - first.x, last.y - first.y) >= minRun) {
							strokes.push({ color: IMAGE_INKS[ink].color, points: [first, last] });
						}
					}
					run = [];
				};
				for (let t = -reach; t <= reach; t += step) {
					const x = ox + dx * t;
					const y = oy + dy * t;
					const code = cellAt(x, y);
					const inside =
						code !== 0 && inkFor(code >> 2, style) === ink && (code & 3) >= pass;
					if (inside) run.push({ x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 });
					else flush();
				}
				flush();
			}
		}
	}
	return strokes;
}
