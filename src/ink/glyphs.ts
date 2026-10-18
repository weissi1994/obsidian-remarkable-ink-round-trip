/**
 * Single-line glyphs for the ink renderer (ink fork).
 *
 * A glyph is a set of pen paths — centre lines, not outlines — so it can be
 * written as real strokes the device treats like its own handwriting. Every
 * source is normalised to the same frame: baseline at y = 0, y pointing up,
 * and the capital height at exactly 1. That one convention lets a bundled
 * font, a captured hand and a composed accent mix on one line and still sit
 * on the same baseline at the same size.
 */

import allure from "./fonts/allure.json";
import hersheyScript from "./fonts/hershey-script.json";
import hersheySans from "./fonts/hershey-sans.json";
import readability from "./fonts/readability.json";

/** One glyph in cap units: advance width plus pen paths as flat x,y lists. */
export interface Glyph {
	advance: number;
	strokes: number[][];
}

/**
 * Where glyphs come from. `version` changes whenever the shapes change, so a
 * document's recorded font can say exactly which shapes it was written with
 * — the import regenerates them to tell your ink from ours.
 */
export interface GlyphSource {
	id: string;
	version: string;
	name: string;
	glyphs: Map<string, Glyph[]>;
	/** Advance of a space, in cap units. */
	space: number;
}

interface FontFile {
	id: string;
	name: string;
	license: string;
	upm: number;
	glyphs: Record<string, [number, number[][]]>;
}

/** Bundled single-line fonts, by id. Order is the order settings list them. */
export const BUILTIN_FONTS: { id: string; label: string }[] = [
	{ id: "readability", label: "Readability — clean print (EMS Readability)" },
	{ id: "hershey-sans", label: "Hershey Sans — technical print" },
	{ id: "allure", label: "Allure — flowing script (EMS Allure)" },
	{ id: "hershey-script", label: "Hershey Script — classic script" },
];

const FONT_FILES: Record<string, FontFile> = {
	allure: allure as unknown as FontFile,
	"hershey-script": hersheyScript as unknown as FontFile,
	"hershey-sans": hersheySans as unknown as FontFile,
	readability: readability as unknown as FontFile,
};

/** Bump when the normalisation below changes how bundled fonts come out. */
const BUILTIN_SHAPE_VERSION = "1";

const cache = new Map<string, GlyphSource>();

/** FNV-1a over the glyph data, as 8 hex digits. */
function shapeHash(file: FontFile): string {
	const text = JSON.stringify(file.glyphs);
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

/** Top of the capital H in raw units: the yardstick every font is scaled by. */
function capHeightOf(file: FontFile): number {
	const h = file.glyphs.H;
	if (h === undefined) return file.upm * 0.7;
	let top = -Infinity;
	for (const stroke of h[1]) {
		for (let i = 1; i < stroke.length; i += 2) top = Math.max(top, stroke[i]);
	}
	return Number.isFinite(top) && top > 0 ? top : file.upm * 0.7;
}

export function builtinFont(id: string): GlyphSource {
	const cached = cache.get(id);
	if (cached !== undefined) return cached;
	const file = FONT_FILES[id] ?? FONT_FILES.readability;
	const cap = capHeightOf(file);
	const glyphs = new Map<string, Glyph[]>();
	for (const [ch, [advance, strokes]] of Object.entries(file.glyphs)) {
		glyphs.set(ch, [
			{
				advance: advance / cap,
				strokes: strokes.map((stroke) => stroke.map((value) => value / cap)),
			},
		]);
	}
	const source: GlyphSource = {
		id: file.id,
		// Content-addressed: a font file changed in an update gets a new
		// version, so older sends refuse to regenerate rather than mismatch.
		version: `builtin-${file.id}-${BUILTIN_SHAPE_VERSION}-${shapeHash(file)}`,
		name: file.name,
		glyphs,
		space: (file.glyphs[" "]?.[0] ?? file.upm * 0.3) / cap,
	};
	cache.set(id, source);
	return source;
}

/** Licences of the bundled fonts, for the about text and the release notes. */
export function builtinFontLicense(id: string): string {
	return FONT_FILES[id]?.license ?? "unknown";
}

/* ------------------------------------------------------------------ */
/* Composition: accents and stand-ins for what a source does not carry */
/* ------------------------------------------------------------------ */

/** Combining marks we can draw ourselves, as paths over a unit box. */
const MARKS: Record<string, number[][]> = {
	"̈": [
		[0.3, 0, 0.3, 0.06],
		[0.7, 0, 0.7, 0.06],
	], // diaeresis
	"́": [[0.35, 0, 0.65, 0.22]], // acute
	"̀": [[0.35, 0.22, 0.65, 0]], // grave
	"̂": [[0.25, 0, 0.5, 0.2, 0.75, 0]], // circumflex
	"̌": [[0.25, 0.2, 0.5, 0, 0.75, 0.2]], // caron
	"̃": [[0.2, 0.05, 0.38, 0.17, 0.62, 0.05, 0.8, 0.17]], // tilde
	"̊": [[0.5, 0, 0.62, 0.08, 0.5, 0.18, 0.38, 0.08, 0.5, 0]], // ring
	"̄": [[0.25, 0.08, 0.75, 0.08]], // macron
	"̋": [
		[0.25, 0, 0.45, 0.22],
		[0.55, 0, 0.75, 0.22],
	], // double acute
	"̇": [[0.5, 0, 0.5, 0.06]], // dot above
	"̧": [[0.5, 0, 0.55, -0.12, 0.42, -0.2]], // cedilla (below)
	"̨": [[0.55, 0, 0.45, -0.12, 0.6, -0.2]], // ogonek (below)
};

const BELOW = new Set(["̧", "̨"]);

/** Characters drawn as a sequence of others when no source has them. */
const STAND_INS: Record<string, string> = {
	"„": ",,",
	"‚": ",",
	"…": "...",
	"•": "·",
	"‹": "<",
	"›": ">",
	"«": "<<",
	"»": ">>",
	"′": "'",
	"″": '"',
	"‘": "'",
	"’": "'",
	"“": '"',
	"”": '"',
	"–": "-",
	"—": "--",
	" ": " ",
	ß: "ss",
	ẞ: "SS",
	"€": "E",
	"™": "TM",
};

function inkBounds(glyph: Glyph): { minX: number; maxX: number; minY: number; maxY: number } {
	let minX = Infinity;
	let maxX = -Infinity;
	let minY = Infinity;
	let maxY = -Infinity;
	for (const stroke of glyph.strokes) {
		for (let i = 0; i + 1 < stroke.length; i += 2) {
			minX = Math.min(minX, stroke[i]);
			maxX = Math.max(maxX, stroke[i]);
			minY = Math.min(minY, stroke[i + 1]);
			maxY = Math.max(maxY, stroke[i + 1]);
		}
	}
	if (!Number.isFinite(minX)) return { minX: 0, maxX: glyph.advance, minY: 0, maxY: 0.7 };
	return { minX, maxX, minY, maxY };
}

/** A base glyph with a combining mark drawn over (or under) it. */
function withMark(base: Glyph, mark: string): Glyph {
	const paths = MARKS[mark];
	const ink = inkBounds(base);
	const width = Math.max(ink.maxX - ink.minX, 0.35);
	const strokes = base.strokes.map((stroke) => [...stroke]);
	const below = BELOW.has(mark);
	const top = below ? Math.min(ink.minY, 0) : ink.maxY + 0.12;
	const left = ink.minX + (ink.maxX - ink.minX - width) / 2;
	const height = 0.42; // mark box height in cap units
	for (const path of paths) {
		const out: number[] = [];
		for (let i = 0; i + 1 < path.length; i += 2) {
			const x = left + path[i] * width;
			const y = below ? top + path[i + 1] * height : top + path[i + 1] * height;
			out.push(x, y);
		}
		strokes.push(out);
	}
	return { advance: base.advance, strokes };
}

/** Glyphs of a string laid side by side as one glyph. */
function sequence(parts: Glyph[]): Glyph {
	let cursor = 0;
	const strokes: number[][] = [];
	for (const part of parts) {
		for (const stroke of part.strokes) {
			strokes.push(stroke.map((value, index) => (index % 2 === 0 ? value + cursor : value)));
		}
		cursor += part.advance;
	}
	return { advance: cursor, strokes };
}

/** A box with a question mark: what a character no source can draw becomes. */
function missingGlyph(): Glyph {
	return {
		advance: 0.6,
		strokes: [[0.05, 0, 0.5, 0, 0.5, 0.75, 0.05, 0.75, 0.05, 0]],
	};
}

/**
 * Pick a glyph for one character: the primary source first, then the
 * fallback source, then composition (accent over base, stand-in sequence).
 * `variant` picks among captured alternates deterministically.
 */
export function resolveGlyph(
	ch: string,
	primary: GlyphSource,
	fallback: GlyphSource,
	variant = 0,
	depth = 0,
): Glyph {
	for (const source of [primary, fallback]) {
		const options = source.glyphs.get(ch);
		if (options !== undefined && options.length > 0) {
			return options[Math.abs(variant) % options.length];
		}
	}
	if (depth > 2) return missingGlyph();
	const decomposed = ch.normalize("NFD");
	if (decomposed.length > 1 && [...decomposed].slice(1).every((mark) => mark in MARKS)) {
		const [base, ...marks] = [...decomposed];
		let glyph = resolveGlyph(base, primary, fallback, variant, depth + 1);
		for (const mark of marks) glyph = withMark(glyph, mark);
		return glyph;
	}
	const standIn = STAND_INS[ch];
	if (standIn !== undefined) {
		return sequence(
			[...standIn].map((part, index) =>
				resolveGlyph(part, primary, fallback, variant + index, depth + 1),
			),
		);
	}
	return missingGlyph();
}

/* ------------------------------------------------------------------ */
/* The font the typesetter measures with                               */
/* ------------------------------------------------------------------ */

/** Capital height as a fraction of the nominal font size (Helvetica: 0.718). */
export const CAP_RATIO = 0.7;

export interface HandFontStyle {
	/** Shear for italics, as dx per unit of height. */
	slant?: number;
	/** Pen thickness multiplier for bold. */
	weight?: number;
	/** Fixed advance per character in cap units (code blocks). */
	monoAdvance?: number;
}

/**
 * A handwriting font as the typesetter sees it: an advance width per string
 * — the same MeasureFont contract pdf-lib's fonts meet — plus the glyph
 * paths the ink converter draws. Width and drawing come from one glyph
 * lookup, so a word's recorded box is exactly the ink it holds.
 */
export class HandFont {
	constructor(
		readonly primary: GlyphSource,
		readonly fallback: GlyphSource,
		readonly style: HandFontStyle = {},
	) {}

	/** Cache key fragment: everything that changes the shapes or widths. */
	get signature(): string {
		return `${this.primary.version}|${this.fallback.version}|${this.style.slant ?? 0}|${this.style.weight ?? 1}|${this.style.monoAdvance ?? 0}`;
	}

	glyph(ch: string, variant = 0): Glyph {
		if (ch === " ") return { advance: this.spaceAdvance(), strokes: [] };
		return resolveGlyph(ch, this.primary, this.fallback, variant);
	}

	private spaceAdvance(): number {
		return this.style.monoAdvance ?? this.primary.space;
	}

	/** Advance of one character in cap units. */
	advanceOf(ch: string): number {
		if (this.style.monoAdvance !== undefined) return this.style.monoAdvance;
		return this.glyph(ch).advance;
	}

	widthOfTextAtSize(text: string, size: number): number {
		const cap = size * CAP_RATIO;
		let total = 0;
		for (const ch of text) total += this.advanceOf(ch);
		return total * cap;
	}
}
