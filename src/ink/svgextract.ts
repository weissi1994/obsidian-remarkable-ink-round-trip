/**
 * Rendered SVG → InkDrawing (ink fork).
 *
 * Runs where the SVG is live in a document — Obsidian at send time — because
 * what is visible in a Mermaid diagram is decided by its stylesheet: label
 * backgrounds are white rects, edges get their stroke from CSS classes,
 * arrowheads live in <marker>s, and text extents need real font metrics.
 * Computed styles, transform matrices and text boxes come from the browser;
 * the geometry itself is flattened by the pure helpers in inkdrawing.ts.
 *
 * Standard DOM APIs only, so the same code is exercised in a headless
 * browser by the test scripts.
 */

import {
	applyMatrix,
	DrawingFill,
	DrawingLabel,
	DrawingPath,
	ellipsePoints,
	InkDrawing,
	Matrix,
	multiply,
	occlude,
	pathToPolylines,
	rectPoints,
} from "./inkdrawing";

const SKIP_CONTAINERS = new Set([
	"defs",
	"marker",
	"symbol",
	"clippath",
	"mask",
	"pattern",
	"lineargradient",
	"radialgradient",
	"filter",
	"style",
	"title",
	"desc",
	"metadata",
	"script",
]);

const GEOMETRY = new Set(["path", "rect", "circle", "ellipse", "line", "polyline", "polygon"]);

function toMatrix(m: DOMMatrix | null): Matrix {
	if (m === null) return [1, 0, 0, 1, 0, 0];
	return [m.a, m.b, m.c, m.d, m.e, m.f];
}

/** rgb()/rgba()/#hex → [r, g, b, alpha] or null for none/url(). */
function parseColor(value: string): [number, number, number, number] | null {
	const v = value.trim().toLowerCase();
	if (v === "" || v === "none" || v === "transparent" || v.startsWith("url(")) return null;
	const rgb = /^rgba?\(([^)]+)\)$/.exec(v);
	if (rgb !== null) {
		const parts = rgb[1].split(/[\s,/]+/).filter((p) => p !== "").map(Number);
		return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1];
	}
	const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(v);
	if (hex !== null) {
		const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join("") : hex[1];
		const n = parseInt(h, 16);
		return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
	}
	return null;
}

const luminance = (c: [number, number, number, number]) => (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255;

function hexOf(c: [number, number, number, number]): string {
	return `#${[c[0], c[1], c[2]].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

/** Visible at all: no hidden ancestor, enough cumulative opacity. */
function visibility(el: Element, stop: Element): number {
	let opacity = 1;
	for (let node: Element | null = el; node !== null; node = node.parentElement) {
		const style = getComputedStyle(node);
		if (style.display === "none") return 0;
		opacity *= Number(style.opacity || "1");
		if (node === stop) break;
	}
	const style = getComputedStyle(el);
	if (style.visibility === "hidden" || style.visibility === "collapse") return 0;
	return opacity;
}

function inSkippedContainer(el: Element, root: Element): boolean {
	for (let node = el.parentElement; node !== null && node !== root; node = node.parentElement) {
		if (SKIP_CONTAINERS.has(node.tagName.toLowerCase())) return true;
	}
	return false;
}

/** Local geometry of one shape element as polylines. */
function shapeGeometry(el: Element): { points: [number, number][]; closed: boolean }[] {
	const num = (name: string) => Number.parseFloat(el.getAttribute(name) ?? "0") || 0;
	switch (el.tagName.toLowerCase()) {
		case "path":
			return pathToPolylines(el.getAttribute("d") ?? "");
		case "rect": {
			const width = num("width");
			const height = num("height");
			if (width <= 0 || height <= 0) return [];
			const rxAttr = el.getAttribute("rx");
			const ryAttr = el.getAttribute("ry");
			const rx = rxAttr !== null ? num("rx") : ryAttr !== null ? num("ry") : 0;
			const ry = ryAttr !== null ? num("ry") : rx;
			return [{ points: rectPoints(num("x"), num("y"), width, height, rx, ry), closed: true }];
		}
		case "circle": {
			const r = num("r");
			return r > 0 ? [{ points: ellipsePoints(num("cx"), num("cy"), r, r), closed: true }] : [];
		}
		case "ellipse": {
			const rx = num("rx");
			const ry = num("ry");
			return rx > 0 && ry > 0 ? [{ points: ellipsePoints(num("cx"), num("cy"), rx, ry), closed: true }] : [];
		}
		case "line":
			return [
				{
					points: [
						[num("x1"), num("y1")],
						[num("x2"), num("y2")],
					],
					closed: false,
				},
			];
		case "polyline":
		case "polygon": {
			const values = (el.getAttribute("points") ?? "")
				.trim()
				.split(/[\s,]+/)
				.map(Number)
				.filter((v) => Number.isFinite(v));
			const points: [number, number][] = [];
			for (let i = 0; i + 1 < values.length; i += 2) points.push([values[i], values[i + 1]]);
			if (points.length < 2) return [];
			const closed = el.tagName.toLowerCase() === "polygon";
			if (closed) points.push(points[0]);
			return [{ points, closed }];
		}
		default:
			return [];
	}
}

/** The transform from an element's user space into the root SVG's pixels. */
function matrixOf(el: Element, root: SVGSVGElement): Matrix {
	const graphics = el as unknown as SVGGraphicsElement;
	const own = typeof graphics.getScreenCTM === "function" ? graphics.getScreenCTM() : null;
	const base = root.getScreenCTM();
	if (own === null || base === null) return toMatrix(graphics.getCTM?.() ?? null);
	return toMatrix(base.inverse().multiply(own));
}

/** Transform attribute of one element (for marker children, not in layout). */
function localTransform(el: Element): Matrix {
	const graphics = el as unknown as SVGGraphicsElement;
	const list = graphics.transform?.baseVal;
	const consolidated = list && list.numberOfItems > 0 ? list.consolidate() : null;
	return consolidated ? toMatrix(consolidated.matrix) : [1, 0, 0, 1, 0, 0];
}

interface Collected {
	paths: (DrawingPath & { order: number })[];
	fills: DrawingFill[];
	/** Opaque filled shapes, which hide what was painted before them. */
	occluders: { points: number[]; order: number }[];
	/** Paint order counter: one step per shape, in document order. */
	order: number;
}

function addShape(
	collected: Collected,
	el: Element,
	matrix: Matrix,
	opacity: number,
	strokeScale = 1,
): void {
	const style = getComputedStyle(el);
	const stroke = parseColor(style.stroke);
	const strokeWidth = Number.parseFloat(style.strokeWidth || "1") * strokeScale;
	const strokeOpacity = Number(style.strokeOpacity || "1") * opacity * (stroke?.[3] ?? 1);
	const strokeVisible =
		stroke !== null && strokeWidth > 0.05 && strokeOpacity > 0.08 && luminance(stroke) < 0.95;
	const fill = parseColor(style.fill);
	const fillOpacity = Number(style.fillOpacity || "1") * opacity * (fill?.[3] ?? 1);
	const fillVisible = fill !== null && fillOpacity > 0.15;
	if (!strokeVisible && !fillVisible) return;
	const tag = el.tagName.toLowerCase();
	const canFill = tag !== "line" && tag !== "polyline";
	const order = ++collected.order;
	for (const line of shapeGeometry(el)) {
		const flat = line.points.flatMap(([x, y]) => applyMatrix(matrix, x, y));
		const coloured = fillVisible && canFill && (line.closed || tag === "path");
		if (coloured && luminance(fill) < 0.9) {
			collected.fills.push({ points: flat, rgb: hexOf(fill) });
		}
		if (coloured && fillOpacity >= 0.9 && line.closed) {
			collected.occluders.push({ points: flat, order });
		}
		// The outline: drawn when stroked, and for a coloured shape without a
		// stroke — otherwise a dark arrowhead or bar would lose its edge.
		if (strokeVisible || (coloured && luminance(fill) < 0.9)) {
			collected.paths.push({
				points: flat.map((v) => Math.round(v * 100) / 100),
				closed: line.closed,
				order,
			});
		}
	}
}

/** Draw the markers an element references (arrowheads, diamonds, circles). */
function addMarkers(collected: Collected, el: Element, matrix: Matrix, opacity: number): void {
	const style = getComputedStyle(el);
	const geometry = shapeGeometry(el);
	if (geometry.length === 0) return;
	const strokeWidth = Number.parseFloat(style.strokeWidth || "1") || 1;
	const ends: { which: "start" | "end"; ref: string }[] = [];
	for (const which of ["start", "end"] as const) {
		const value = which === "start" ? style.markerStart : style.markerEnd;
		const id = /url\(["']?#([^"')]+)["']?\)/.exec(value ?? "")?.[1];
		if (id !== undefined) ends.push({ which, ref: id });
	}
	for (const { which, ref } of ends) {
		const marker = el.ownerDocument.getElementById(ref);
		if (marker === null || marker.tagName.toLowerCase() !== "marker") continue;
		const path = which === "end" ? geometry[geometry.length - 1].points : geometry[0].points;
		if (path.length < 2) continue;
		const [vx, vy] = which === "end" ? path[path.length - 1] : path[0];
		// Direction at the vertex, from the nearest distinct point.
		let other = which === "end" ? path[path.length - 2] : path[1];
		for (let k = 2; Math.hypot(other[0] - vx, other[1] - vy) < 0.01 && k < path.length; k++) {
			other = which === "end" ? path[path.length - 1 - k] : path[k];
		}
		let angle =
			which === "end" ? Math.atan2(vy - other[1], vx - other[0]) : Math.atan2(other[1] - vy, other[0] - vx);
		const orient = marker.getAttribute("orient") ?? "0";
		if (orient === "auto-start-reverse" && which === "start") angle += Math.PI;
		else if (orient !== "auto" && orient !== "auto-start-reverse") angle = (Number.parseFloat(orient) * Math.PI) / 180;
		const num = (name: string, fallback: number) => {
			const raw = marker.getAttribute(name);
			const value = raw === null ? Number.NaN : Number.parseFloat(raw);
			return Number.isFinite(value) ? value : fallback;
		};
		const markerWidth = num("markerWidth", 3);
		const markerHeight = num("markerHeight", 3);
		const units = marker.getAttribute("markerUnits") === "userSpaceOnUse" ? 1 : strokeWidth;
		const box = (marker.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
		let viewBox: Matrix = [1, 0, 0, 1, 0, 0];
		if (box.length === 4 && box[2] > 0 && box[3] > 0) {
			const sx = markerWidth / box[2];
			const sy = markerHeight / box[3];
			const s = Math.min(sx, sy); // preserveAspectRatio xMidYMid meet
			viewBox = [s, 0, 0, s, -box[0] * s, -box[1] * s];
		}
		const [rx, ry] = applyMatrix(viewBox, num("refX", 0), num("refY", 0));
		const cos = Math.cos(angle);
		const sin = Math.sin(angle);
		let placement: Matrix = [1, 0, 0, 1, vx, vy];
		placement = multiply(placement, [cos, sin, -sin, cos, 0, 0]);
		placement = multiply(placement, [units, 0, 0, units, 0, 0]);
		placement = multiply(placement, [1, 0, 0, 1, -rx, -ry]);
		placement = multiply(placement, viewBox);
		const base = multiply(matrix, placement);
		const walk = (node: Element, m: Matrix) => {
			for (const child of Array.from(node.children)) {
				const childMatrix = multiply(m, localTransform(child));
				if (GEOMETRY.has(child.tagName.toLowerCase())) addShape(collected, child, childMatrix, opacity, units);
				else if (child.tagName.toLowerCase() === "g") walk(child, childMatrix);
			}
		};
		walk(marker, base);
	}
}

/** One text line's box in root pixels. */
function boxOf(el: SVGGraphicsElement, root: SVGSVGElement): { x: number; y: number; width: number; height: number } | null {
	let bbox: DOMRect;
	try {
		bbox = el.getBBox();
	} catch {
		return null;
	}
	if (bbox.width <= 0 || bbox.height <= 0) return null;
	const m = matrixOf(el, root);
	const corners = [
		applyMatrix(m, bbox.x, bbox.y),
		applyMatrix(m, bbox.x + bbox.width, bbox.y),
		applyMatrix(m, bbox.x, bbox.y + bbox.height),
		applyMatrix(m, bbox.x + bbox.width, bbox.y + bbox.height),
	];
	const xs = corners.map((c) => c[0]);
	const ys = corners.map((c) => c[1]);
	return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

/**
 * Extract a drawing from an SVG element that is attached to a document and
 * sized 1 unit = 1 pixel (the caller sets width/height to its viewBox size).
 */
export function extractDrawing(root: SVGSVGElement): InkDrawing {
	const viewBox = root.viewBox?.baseVal;
	const width = viewBox && viewBox.width > 0 ? viewBox.width : root.getBoundingClientRect().width;
	const height = viewBox && viewBox.height > 0 ? viewBox.height : root.getBoundingClientRect().height;
	const collected: Collected = { paths: [], fills: [], occluders: [], order: 0 };
	const labels: DrawingLabel[] = [];

	for (const el of Array.from(root.querySelectorAll("*"))) {
		const tag = el.tagName.toLowerCase();
		if (SKIP_CONTAINERS.has(tag) || inSkippedContainer(el, root)) continue;
		if (GEOMETRY.has(tag)) {
			const opacity = visibility(el, root);
			if (opacity < 0.05) continue;
			const matrix = matrixOf(el, root);
			addShape(collected, el, matrix, opacity);
			addMarkers(collected, el, matrix, opacity);
		} else if (tag === "text") {
			if (visibility(el, root) < 0.05) continue;
			const lines = Array.from(el.children).filter(
				(child) => child.tagName.toLowerCase() === "tspan" && (child.textContent ?? "").trim() !== "",
			);
			for (const line of lines.length > 0 ? lines : [el]) {
				// Per line: Mermaid styles the <text> white and its tspans black.
				const fill = parseColor(getComputedStyle(line).fill);
				if (fill === null || luminance(fill) > 0.95) continue;
				const box = boxOf(line as SVGGraphicsElement, root);
				const text = (line.textContent ?? "").replace(/\s+/g, " ").trim();
				if (box !== null && text !== "") labels.push({ text, ...box });
			}
		} else if (tag === "foreignobject") {
			if (visibility(el, root) < 0.05) continue;
			const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
			const box = boxOf(el as SVGGraphicsElement, root);
			if (box !== null && text !== "") labels.push({ text, ...box });
		}
	}
	// Matrices map into the root's viewBox space; shift it to start at 0,0.
	const ox = viewBox && viewBox.width > 0 ? viewBox.x : 0;
	const oy = viewBox && viewBox.height > 0 ? viewBox.y : 0;
	const shift = (flat: number[]) =>
		flat.map((v, i) => Math.round((v - (i % 2 === 0 ? ox : oy)) * 100) / 100);
	return {
		width: Math.round(width * 100) / 100,
		height: Math.round(height * 100) / 100,
		// Label boxes hide the lines that run under them (edge labels sit on a
		// plate), but never the outline of the shape the label is in.
		paths: occlude(collected.paths, [
			...collected.occluders,
			...labels.map((label) => ({
				points: rectPoints(label.x + 1, label.y + 1, Math.max(label.width - 2, 0), Math.max(label.height - 2, 0)).flat(),
				order: Number.MAX_SAFE_INTEGER,
				openOnly: true,
			})),
		]).map((path) => ({
			...path,
			points: shift(path.points),
		})),
		fills: collected.fills.map((fill) => ({ ...fill, points: shift(fill.points) })),
		labels: labels.map((label) => ({
			...label,
			x: Math.round((label.x - ox) * 100) / 100,
			y: Math.round((label.y - oy) * 100) / 100,
			width: Math.round(label.width * 100) / 100,
			height: Math.round(label.height * 100) / 100,
		})),
	};
}
