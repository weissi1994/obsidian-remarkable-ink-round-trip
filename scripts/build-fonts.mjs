#!/usr/bin/env node
/**
 * Convert single-line SVG fonts (EMS / Hershey, as shipped by the
 * `hersheytext` package) into the compact JSON the ink renderer bundles.
 *
 * Usage: node scripts/build-fonts.mjs <svg_fonts dir> <out dir>
 *
 * Output per font: { id, name, license, upm, glyphs: { ch: [advance, [[x,y,...], ...]] } }
 * Coordinates are font units with y pointing UP and the baseline at 0, rounded
 * to integers (1/1000 em is far below a pen width at any size we render).
 * Curves (a handful per font) are flattened here so the runtime only ever
 * deals in polylines.
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const FONTS = [
	{ id: "readability", file: "EMSReadability.svg" },
	{ id: "allure", file: "EMSAllure.svg" },
	{ id: "hershey-script", file: "HersheyScript1.svg" },
	{ id: "hershey-sans", file: "HersheySans1.svg" },
];

function decodeEntities(text) {
	return text
		.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

function attr(tag, name) {
	const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
	return match === null ? undefined : decodeEntities(match[1]);
}

/** Tokenise SVG path data into commands with numeric arguments. */
function tokens(d) {
	const out = [];
	const re = /([MmLlHhVvCcZz])|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;
	let match;
	while ((match = re.exec(d)) !== null) {
		out.push(match[1] !== undefined ? match[1] : Number(match[2]));
	}
	return out;
}

/** Path data → polylines (absolute coordinates, curves flattened). */
function polylines(d) {
	const t = tokens(d);
	const lines = [];
	let current = null;
	let x = 0;
	let y = 0;
	let startX = 0;
	let startY = 0;
	let command = null;
	let i = 0;
	const num = () => {
		const value = t[i++];
		if (typeof value !== "number") throw new Error(`expected number in path: ${d}`);
		return value;
	};
	while (i < t.length) {
		if (typeof t[i] === "string") command = t[i++];
		switch (command) {
			case "M":
			case "m": {
				const nx = num();
				const ny = num();
				x = command === "m" ? x + nx : nx;
				y = command === "m" ? y + ny : ny;
				startX = x;
				startY = y;
				current = [[x, y]];
				lines.push(current);
				// Implicit lineto after a moveto's first pair.
				command = command === "m" ? "l" : "L";
				break;
			}
			case "L":
			case "l": {
				const nx = num();
				const ny = num();
				x = command === "l" ? x + nx : nx;
				y = command === "l" ? y + ny : ny;
				current.push([x, y]);
				break;
			}
			case "H":
			case "h":
				x = command === "h" ? x + num() : num();
				current.push([x, y]);
				break;
			case "V":
			case "v":
				y = command === "v" ? y + num() : num();
				current.push([x, y]);
				break;
			case "C":
			case "c": {
				const rel = command === "c";
				const c1x = (rel ? x : 0) + num();
				const c1y = (rel ? y : 0) + num();
				const c2x = (rel ? x : 0) + num();
				const c2y = (rel ? y : 0) + num();
				const ex = (rel ? x : 0) + num();
				const ey = (rel ? y : 0) + num();
				const steps = 8;
				for (let s = 1; s <= steps; s++) {
					const u = s / steps;
					const a = (1 - u) ** 3;
					const b = 3 * (1 - u) ** 2 * u;
					const c = 3 * (1 - u) * u ** 2;
					const e = u ** 3;
					current.push([a * x + b * c1x + c * c2x + e * ex, a * y + b * c1y + c * c2y + e * ey]);
				}
				x = ex;
				y = ey;
				break;
			}
			case "Z":
			case "z":
				current.push([startX, startY]);
				x = startX;
				y = startY;
				break;
			default:
				throw new Error(`unsupported path command ${command} in ${d}`);
		}
	}
	return lines.filter((line) => line.length > 1);
}

const [, , srcDir, outDir] = process.argv;
if (!srcDir || !outDir) {
	console.error("usage: build-fonts.mjs <svg_fonts dir> <out dir>");
	process.exit(1);
}
mkdirSync(outDir, { recursive: true });

for (const font of FONTS) {
	const svg = readFileSync(join(srcDir, font.file), "utf8");
	const metadata = (/<metadata>([\s\S]*?)<\/metadata>/.exec(svg)?.[1] ?? "").trim();
	const fontTag = /<font\s[^>]*>/.exec(svg)[0];
	const faceTag = /<font-face[\s\S]*?\/>/.exec(svg)[0];
	const defaultAdvance = Number(attr(fontTag, "horiz-adv-x") ?? 500);
	const upm = Number(attr(faceTag, "units-per-em") ?? 1000);
	const name = attr(faceTag, "font-family") ?? font.id;
	const glyphs = {};
	for (const tag of svg.match(/<glyph\s[^>]*>/g) ?? []) {
		const unicode = attr(tag, "unicode");
		if (unicode === undefined || [...unicode].length !== 1) continue;
		const advance = Math.round(Number(attr(tag, "horiz-adv-x") ?? defaultAdvance));
		const d = attr(tag, "d");
		const strokes = d === undefined ? [] : polylines(d);
		glyphs[unicode] = [
			advance,
			strokes.map((line) => line.flatMap(([px, py]) => [Math.round(px), Math.round(py)])),
		];
	}
	const license = /SIL Open Font License/.test(metadata)
		? "SIL Open Font License 1.1"
		: /Hershey/.test(metadata)
			? "Hershey Fonts licence (see FONTS-LICENSE.md)"
			: "unknown";
	const out = { id: font.id, name, license, upm, glyphs };
	writeFileSync(join(outDir, `${font.id}.json`), JSON.stringify(out));
	console.log(`${font.id}: ${Object.keys(glyphs).length} glyphs, ${license}`);
}
