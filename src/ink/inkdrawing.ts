/**
 * Vector drawings — Mermaid diagrams — as handwritten pen strokes (ink fork).
 *
 * A diagram reaches this module as an InkDrawing: polylines, filled areas and
 * text labels in the SVG's own pixel space, already extracted from the
 * rendered SVG (svgextract.ts runs that part in the browser, where styles and
 * text metrics are known). Here it is drawn into a box on the page:
 *
 * - lines and outlines get a slight hand-drawn wobble;
 * - coloured fills are hatched in the tablet's inks (the same quantisation as
 *   pictures), near-white fills stay paper;
 * - labels are written in the note's handwriting, fitted to their box.
 *
 * Pure and deterministic: the send stores the InkDrawing, so the import
 * regenerates the exact strokes even after Mermaid or the note changed.
 */

import { CAP_RATIO, HandFont } from "./glyphs";
import { IMAGE_INKS, highlighterColorOf, quantizePixel } from "./inkimage";
import { PEN, PEN_COLOR } from "./rmwrite";

export interface DrawingPath {
	/** Flat x,y list in drawing pixels. */
	points: number[];
	closed?: boolean;
}

export interface DrawingFill {
	/** Polygon outline, flat x,y list in drawing pixels. */
	points: number[];
	/** Fill colour as `#rrggbb`. */
	rgb: string;
}

export interface DrawingLabel {
	text: string;
	/** Box the text occupied in the rendered SVG, drawing pixels. */
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface InkDrawing {
	width: number;
	height: number;
	paths: DrawingPath[];
	fills: DrawingFill[];
	labels: DrawingLabel[];
}

/* ------------------------------------------------------------------ */
/* Geometry helpers shared with the extractor                          */
/* ------------------------------------------------------------------ */

/** Affine matrix [a, b, c, d, e, f] as in SVG: x' = a x + c y + e. */
export type Matrix = [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export function multiply(m: Matrix, n: Matrix): Matrix {
	return [
		m[0] * n[0] + m[2] * n[1],
		m[1] * n[0] + m[3] * n[1],
		m[0] * n[2] + m[2] * n[3],
		m[1] * n[2] + m[3] * n[3],
		m[0] * n[4] + m[2] * n[5] + m[4],
		m[1] * n[4] + m[3] * n[5] + m[5],
	];
}

export function applyMatrix(m: Matrix, x: number, y: number): [number, number] {
	return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** Flatten SVG path data into polylines (absolute, curves sampled). */
export function pathToPolylines(d: string): { points: [number, number][]; closed: boolean }[] {
	const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
	const out: { points: [number, number][]; closed: boolean }[] = [];
	let current: { points: [number, number][]; closed: boolean } | null = null;
	let x = 0;
	let y = 0;
	let startX = 0;
	let startY = 0;
	let lastControl: [number, number] | null = null;
	let lastQuad: [number, number] | null = null;
	let command = "";
	let i = 0;
	const isCommand = (token: string) => /^[A-Za-z]$/.test(token);
	const num = () => Number(tokens[i++]);
	const push = (px: number, py: number) => {
		if (current === null) {
			current = { points: [[x, y]], closed: false };
			out.push(current);
		}
		current.points.push([px, py]);
	};
	while (i < tokens.length) {
		if (isCommand(tokens[i])) command = tokens[i++];
		if (command === "") break;
		const rel = command === command.toLowerCase();
		const upper = command.toUpperCase();
		if (upper === "Z") {
			if (current !== null) {
				current.points.push([startX, startY]);
				current.closed = true;
			}
			x = startX;
			y = startY;
			current = null;
			lastControl = lastQuad = null;
			continue;
		}
		if (i >= tokens.length || isCommand(tokens[i])) {
			// A command with no arguments left: skip it rather than loop.
			if (!isCommand(tokens[i] ?? "")) break;
			continue;
		}
		switch (upper) {
			case "M": {
				const nx = num() + (rel ? x : 0);
				const ny = num() + (rel ? y : 0);
				x = startX = nx;
				y = startY = ny;
				current = { points: [[x, y]], closed: false };
				out.push(current);
				command = rel ? "l" : "L";
				lastControl = lastQuad = null;
				break;
			}
			case "L": {
				const nx = num() + (rel ? x : 0);
				const ny = num() + (rel ? y : 0);
				push(nx, ny);
				x = nx;
				y = ny;
				lastControl = lastQuad = null;
				break;
			}
			case "H": {
				const nx = num() + (rel ? x : 0);
				push(nx, y);
				x = nx;
				lastControl = lastQuad = null;
				break;
			}
			case "V": {
				const ny = num() + (rel ? y : 0);
				push(x, ny);
				y = ny;
				lastControl = lastQuad = null;
				break;
			}
			case "C":
			case "S": {
				let c1x: number;
				let c1y: number;
				if (upper === "C") {
					c1x = num() + (rel ? x : 0);
					c1y = num() + (rel ? y : 0);
				} else {
					c1x = lastControl ? 2 * x - lastControl[0] : x;
					c1y = lastControl ? 2 * y - lastControl[1] : y;
				}
				const c2x = num() + (rel ? x : 0);
				const c2y = num() + (rel ? y : 0);
				const ex = num() + (rel ? x : 0);
				const ey = num() + (rel ? y : 0);
				const steps = Math.max(4, Math.min(24, Math.ceil(Math.hypot(ex - x, ey - y) / 6)));
				for (let s = 1; s <= steps; s++) {
					const u = s / steps;
					const a = (1 - u) ** 3;
					const b = 3 * (1 - u) ** 2 * u;
					const c = 3 * (1 - u) * u ** 2;
					const e = u ** 3;
					push(a * x + b * c1x + c * c2x + e * ex, a * y + b * c1y + c * c2y + e * ey);
				}
				lastControl = [c2x, c2y];
				lastQuad = null;
				x = ex;
				y = ey;
				break;
			}
			case "Q":
			case "T": {
				let qx: number;
				let qy: number;
				if (upper === "Q") {
					qx = num() + (rel ? x : 0);
					qy = num() + (rel ? y : 0);
				} else {
					qx = lastQuad ? 2 * x - lastQuad[0] : x;
					qy = lastQuad ? 2 * y - lastQuad[1] : y;
				}
				const ex = num() + (rel ? x : 0);
				const ey = num() + (rel ? y : 0);
				const steps = Math.max(4, Math.min(16, Math.ceil(Math.hypot(ex - x, ey - y) / 6)));
				for (let s = 1; s <= steps; s++) {
					const u = s / steps;
					push(
						(1 - u) ** 2 * x + 2 * (1 - u) * u * qx + u ** 2 * ex,
						(1 - u) ** 2 * y + 2 * (1 - u) * u * qy + u ** 2 * ey,
					);
				}
				lastQuad = [qx, qy];
				lastControl = null;
				x = ex;
				y = ey;
				break;
			}
			case "A": {
				const rx0 = Math.abs(num());
				const ry0 = Math.abs(num());
				const rotation = (num() * Math.PI) / 180;
				const large = num() !== 0;
				const sweep = num() !== 0;
				const ex = num() + (rel ? x : 0);
				const ey = num() + (rel ? y : 0);
				for (const [px, py] of arcPoints(x, y, rx0, ry0, rotation, large, sweep, ex, ey)) push(px, py);
				x = ex;
				y = ey;
				lastControl = lastQuad = null;
				break;
			}
			default:
				i++;
		}
	}
	return out.filter((line) => line.points.length > 1);
}

/** SVG elliptical arc (endpoint parameterisation) as sample points, end included. */
function arcPoints(
	x1: number,
	y1: number,
	rx: number,
	ry: number,
	phi: number,
	large: boolean,
	sweep: boolean,
	x2: number,
	y2: number,
): [number, number][] {
	if (rx === 0 || ry === 0) return [[x2, y2]];
	const cos = Math.cos(phi);
	const sin = Math.sin(phi);
	const dx = (x1 - x2) / 2;
	const dy = (y1 - y2) / 2;
	const x1p = cos * dx + sin * dy;
	const y1p = -sin * dx + cos * dy;
	const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
	if (lambda > 1) {
		rx *= Math.sqrt(lambda);
		ry *= Math.sqrt(lambda);
	}
	const sign = large === sweep ? -1 : 1;
	const numerator = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
	const factor = sign * Math.sqrt(Math.max(0, numerator / (rx * rx * y1p * y1p + ry * ry * x1p * x1p)));
	const cxp = (factor * rx * y1p) / ry;
	const cyp = (-factor * ry * x1p) / rx;
	const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
	const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
	const angle = (ux: number, uy: number, vx: number, vy: number) => {
		const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
		return a;
	};
	const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
	let delta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
	if (!sweep && delta > 0) delta -= 2 * Math.PI;
	if (sweep && delta < 0) delta += 2 * Math.PI;
	const steps = Math.max(4, Math.min(48, Math.ceil((Math.abs(delta) * Math.max(rx, ry)) / 5)));
	const points: [number, number][] = [];
	for (let s = 1; s <= steps; s++) {
		const t = theta1 + (delta * s) / steps;
		points.push([
			cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin,
			cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos,
		]);
	}
	points[points.length - 1] = [x2, y2];
	return points;
}

/** Polyline of an ellipse (closed). */
export function ellipsePoints(cx: number, cy: number, rx: number, ry: number): [number, number][] {
	const steps = Math.max(12, Math.min(72, Math.ceil((2 * Math.PI * Math.max(rx, ry)) / 5)));
	const points: [number, number][] = [];
	for (let s = 0; s <= steps; s++) {
		const t = (2 * Math.PI * s) / steps;
		points.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
	}
	return points;
}

/** Polyline of a (possibly rounded) rectangle (closed). */
export function rectPoints(
	x: number,
	y: number,
	width: number,
	height: number,
	rx = 0,
	ry = rx,
): [number, number][] {
	const rX = Math.min(Math.max(rx, 0), width / 2);
	const rY = Math.min(Math.max(ry, 0), height / 2);
	if (rX <= 0 || rY <= 0) {
		return [
			[x, y],
			[x + width, y],
			[x + width, y + height],
			[x, y + height],
			[x, y],
		];
	}
	const corner = (cx: number, cy: number, start: number): [number, number][] => {
		const out: [number, number][] = [];
		for (let s = 0; s <= 4; s++) {
			const t = start + (Math.PI / 2) * (s / 4);
			out.push([cx + rX * Math.cos(t), cy + rY * Math.sin(t)]);
		}
		return out;
	};
	const points = [
		...corner(x + width - rX, y + rY, -Math.PI / 2),
		...corner(x + width - rX, y + height - rY, 0),
		...corner(x + rX, y + height - rY, Math.PI / 2),
		...corner(x + rX, y + rY, Math.PI),
	];
	points.push(points[0]);
	return points;
}

/**
 * Clip lines where an opaque shape painted later covers them — a connector
 * running under a node box, an edge hidden behind a label plate. SVG paints
 * in document order; ink has no paint order, so what the browser would
 * hide has to be cut away. A point within 1.5 px of the shape's edge counts
 * as outside, so arrowheads that touch a box keep their tips.
 */
export function occlude(
	paths: (DrawingPath & { order: number })[],
	occluders: { points: number[]; order: number; openOnly?: boolean }[],
): DrawingPath[] {
	const polygons = occluders.map((occluder) => {
		const points: [number, number][] = [];
		for (let i = 0; i + 1 < occluder.points.length; i += 2) points.push([occluder.points[i], occluder.points[i + 1]]);
		const xs = points.map((p) => p[0]);
		const ys = points.map((p) => p[1]);
		return {
			order: occluder.order,
			openOnly: occluder.openOnly === true,
			points,
			box: { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) },
		};
	});
	const covered = (x: number, y: number, order: number, closed: boolean): boolean => {
		for (const polygon of polygons) {
			if (polygon.order <= order || (polygon.openOnly && closed)) continue;
			const { box } = polygon;
			if (x < box.minX || x > box.maxX || y < box.minY || y > box.maxY) continue;
			let inside = false;
			let nearEdge = false;
			const pts = polygon.points;
			for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
				const [xi, yi] = pts[i];
				const [xj, yj] = pts[j];
				if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
				const vx = xj - xi;
				const vy = yj - yi;
				const len2 = vx * vx + vy * vy;
				const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - xi) * vx + (y - yi) * vy) / len2));
				if (Math.hypot(x - (xi + t * vx), y - (yi + t * vy)) <= 1.5) nearEdge = true;
			}
			if (inside && !nearEdge) return true;
		}
		return false;
	};
	const out: DrawingPath[] = [];
	for (const path of paths) {
		if (!polygons.some((polygon) => polygon.order > path.order)) {
			out.push({ points: path.points, closed: path.closed });
			continue;
		}
		let run: number[] = [];
		const flush = () => {
			if (run.length >= 4) out.push({ points: run });
			run = [];
		};
		for (let i = 0; i + 1 < path.points.length; i += 2) {
			const x0 = path.points[i];
			const y0 = path.points[i + 1];
			const x1 = path.points[i + 2] ?? x0;
			const y1 = path.points[i + 3] ?? y0;
			const pieces = i + 3 < path.points.length ? Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 2)) : 1;
			for (let k = 0; k < pieces; k++) {
				const x = x0 + ((x1 - x0) * k) / pieces;
				const y = y0 + ((y1 - y0) * k) / pieces;
				if (covered(x, y, path.order, path.closed === true)) flush();
				else run.push(Math.round(x * 100) / 100, Math.round(y * 100) / 100);
			}
		}
		flush();
	}
	return out;
}

/* ------------------------------------------------------------------ */
/* Drawing → strokes                                                   */
/* ------------------------------------------------------------------ */

export interface DrawingStroke {
	color: number;
	thickness: number;
	points: { x: number; y: number }[];
	/** Pen other than the note's own (the highlighter for fills). */
	tool?: number;
	/** v2 point width, when not derived from the thickness. */
	width?: number;
}

export interface DrawingRenderOptions {
	/** Target box in device units. */
	box: { left: number; top: number; width: number; height: number };
	font: HandFont;
	/** Ink for lines and labels. */
	color: number;
	/** Pen thickness of the note's text, for the lines. */
	thickness: number;
	/** 0–1: how much the lines wobble. */
	jitter: number;
	seed: string;
	/** Device units per point (dpi / 72), for hatch spacing. */
	unit: number;
	/** Fill hatching in colour or grey. */
	colour: boolean;
	/** Fill areas with highlighter bands instead of hatching. */
	highlighter?: boolean;
}

function hash32(text: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

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

const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * Resample a polyline and push it sideways by a slow, smooth wobble — the
 * difference between a ruler line and a hand-drawn one.
 */
function wobble(
	points: { x: number; y: number }[],
	amplitude: number,
	random: () => number,
): { x: number; y: number }[] {
	const dense: { x: number; y: number }[] = [];
	for (let i = 0; i < points.length; i++) {
		if (i > 0) {
			const a = points[i - 1];
			const b = points[i];
			const length = Math.hypot(b.x - a.x, b.y - a.y);
			const pieces = Math.max(1, Math.floor(length / 8));
			for (let k = 1; k < pieces; k++) {
				dense.push({ x: a.x + ((b.x - a.x) * k) / pieces, y: a.y + ((b.y - a.y) * k) / pieces });
			}
		}
		dense.push(points[i]);
	}
	if (amplitude <= 0 || dense.length < 3) return dense.map((p) => ({ x: round2(p.x), y: round2(p.y) }));
	const phase = random() * Math.PI * 2;
	const wavelength = 60 + random() * 60;
	let travelled = 0;
	return dense.map((point, index) => {
		const prev = dense[Math.max(0, index - 1)];
		const next = dense[Math.min(dense.length - 1, index + 1)];
		if (index > 0) travelled += Math.hypot(point.x - prev.x, point.y - prev.y);
		const tx = next.x - prev.x;
		const ty = next.y - prev.y;
		const length = Math.hypot(tx, ty) || 1;
		// Ends stay put, so lines still meet the boxes they connect.
		const taper = Math.min(1, index / 3, (dense.length - 1 - index) / 3);
		const offset = Math.sin(phase + (travelled / wavelength) * Math.PI * 2) * amplitude * taper;
		return { x: round2(point.x - (ty / length) * offset), y: round2(point.y + (tx / length) * offset) };
	});
}

/** Hatch the inside of a polygon (even–odd) with parallel lines. */
function hatchPolygon(
	polygon: { x: number; y: number }[],
	angleDegrees: number,
	spacing: number,
): { x: number; y: number }[][] {
	if (polygon.length < 3) return [];
	const angle = (angleDegrees * Math.PI) / 180;
	const dx = Math.cos(angle);
	const dy = Math.sin(angle);
	// Normal coordinate of each vertex decides which lines cross the shape.
	const offsets = polygon.map((p) => -p.x * dy + p.y * dx);
	const low = Math.min(...offsets);
	const high = Math.max(...offsets);
	const lines: { x: number; y: number }[][] = [];
	for (let offset = low + spacing / 2; offset < high; offset += spacing) {
		const hits: number[] = [];
		for (let i = 0; i < polygon.length; i++) {
			const a = polygon[i];
			const b = polygon[(i + 1) % polygon.length];
			const oa = offsets[i];
			const ob = offsets[(i + 1) % polygon.length];
			if ((oa <= offset && ob > offset) || (ob <= offset && oa > offset)) {
				const t = (offset - oa) / (ob - oa);
				const px = a.x + (b.x - a.x) * t;
				const py = a.y + (b.y - a.y) * t;
				hits.push(px * dx + py * dy);
			}
		}
		hits.sort((a, b) => a - b);
		for (let k = 0; k + 1 < hits.length; k += 2) {
			if (hits[k + 1] - hits[k] < spacing * 0.6) continue;
			const at = (along: number) => ({
				x: round2(along * dx - offset * dy),
				y: round2(along * dy + offset * dx),
			});
			lines.push([at(hits[k]), at(hits[k + 1])]);
		}
	}
	return lines;
}

/** Draw a diagram into its box. Order: fills, lines, labels. */
export function drawingStrokes(drawing: InkDrawing, options: DrawingRenderOptions): DrawingStroke[] {
	const { box } = options;
	const scale = Math.min(box.width / Math.max(drawing.width, 1), box.height / Math.max(drawing.height, 1));
	const left = box.left + (box.width - drawing.width * scale) / 2;
	const top = box.top;
	const map = (x: number, y: number) => ({ x: left + x * scale, y: top + y * scale });
	const random = prng(hash32(`${options.seed}|drawing`));
	const out: DrawingStroke[] = [];

	// Fills: hatched in the nearest ink, lightly — they are background.
	const spacing = 2.6 * options.unit;
	for (const fill of drawing.fills) {
		const value = parseInt(fill.rgb.slice(1), 16);
		if (options.highlighter === true) {
			const color = highlighterColorOf((value >> 16) & 255, (value >> 8) & 255, value & 255);
			if (color === null) continue;
			const polygon: { x: number; y: number }[] = [];
			for (let i = 0; i + 1 < fill.points.length; i += 2) polygon.push(map(fill.points[i], fill.points[i + 1]));
			// Rows that exactly tile the shape's height, none wider than 7 pt.
			const ys = polygon.map((p) => p.y);
			const height = Math.max(...ys) - Math.min(...ys);
			if (height < 1) continue;
			const band = height / Math.max(1, Math.ceil(height / (7 * options.unit)));
			for (const segment of hatchPolygon(polygon, 0, band)) {
				out.push({
					color: options.colour ? color : PEN_COLOR.grey,
					thickness: 1,
					points: segment,
					tool: PEN.highlighter,
					width: Math.round(band * 1.1 * 4),
				});
			}
			continue;
		}
		const code = quantizePixel((value >> 16) & 255, (value >> 8) & 255, value & 255);
		if (code === 0) continue;
		let ink = code >> 2;
		if (!options.colour && ink > 2) ink = 2;
		const passes = Math.min(2, code & 3);
		const polygon: { x: number; y: number }[] = [];
		for (let i = 0; i + 1 < fill.points.length; i += 2) polygon.push(map(fill.points[i], fill.points[i + 1]));
		for (let pass = 1; pass <= passes; pass++) {
			const angle = IMAGE_INKS[ink].angle + (pass === 2 ? 90 : 0);
			for (const segment of hatchPolygon(polygon, angle, spacing)) {
				out.push({ color: IMAGE_INKS[ink].color, thickness: 1, points: segment });
			}
		}
	}

	// Lines and outlines, in the note's ink, with a hand-drawn wobble.
	const amplitude = Math.max(0, Math.min(1, options.jitter)) * 1.6 * (options.unit / 3.14);
	for (const path of drawing.paths) {
		const points: { x: number; y: number }[] = [];
		for (let i = 0; i + 1 < path.points.length; i += 2) points.push(map(path.points[i], path.points[i + 1]));
		if (points.length < 2) continue;
		out.push({
			color: options.color,
			thickness: options.thickness,
			points: wobble(points, amplitude, random),
		});
	}

	// Labels, written in the note's hand and fitted to their box.
	for (const label of drawing.labels) {
		const text = label.text.replace(/\s+/g, " ").trim();
		if (text === "") continue;
		const boxLeft = map(label.x, label.y);
		const boxRight = map(label.x + label.width, label.y + label.height);
		const height = boxRight.y - boxLeft.y;
		const width = boxRight.x - boxLeft.x;
		// A label box is about 1.2× the font size; cap height is 0.7 of that.
		let cap = height * 0.62;
		const advance = [...text].reduce((sum, ch) => sum + options.font.advanceOf(ch), 0);
		if (advance * cap > width * 1.05) cap = (width * 1.05) / advance;
		cap = Math.max(cap, 3);
		const textWidth = advance * cap;
		let cursor = boxLeft.x + (width - textWidth) / 2;
		const baseline = boxLeft.y + height / 2 + cap / 2;
		for (const ch of text) {
			const glyph = options.font.glyph(ch, Math.floor(random() * 1000));
			for (const stroke of glyph.strokes) {
				const points: { x: number; y: number }[] = [];
				for (let i = 0; i + 1 < stroke.length; i += 2) {
					points.push({ x: round2(cursor + stroke[i] * cap), y: round2(baseline - stroke[i + 1] * cap) });
				}
				if (points.length === 1) points.push({ x: points[0].x + 0.5, y: points[0].y });
				out.push({ color: options.color, thickness: options.thickness, points });
			}
			cursor += options.font.advanceOf(ch) * cap;
		}
	}
	return out;
}

/** Size of the drawing on the page in points, from its pixel size (96 dpi). */
export function drawingSize(drawing: InkDrawing): { width: number; height: number } {
	return { width: drawing.width * 0.75, height: drawing.height * 0.75 };
}

/** Placeholder key for a diagram: its source, hashed. */
export function diagramKey(source: string): string {
	return `mermaid:${hash32(source.replace(/\r\n/g, "\n").trim()).toString(16).padStart(8, "0")}`;
}

export { CAP_RATIO, PEN_COLOR };
