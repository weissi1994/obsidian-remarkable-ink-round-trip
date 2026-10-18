/**
 * Capturing the tablet owner's handwriting (ink fork).
 *
 * The plugin sends a sheet of labelled boxes; the owner writes each character
 * once, on the line, and syncs. Reading it back is the same diff the
 * annotation import uses — the boxes, guides and labels are strokes the
 * plugin wrote, so whatever else is on the page is the owner's hand — and
 * each box's ink becomes a glyph, normalised to the frame every glyph source
 * shares (baseline at 0, capital height 1).
 *
 * The sheet is regenerated at import from the recorded profile and charset
 * version, never stored: same discipline as the notebooks themselves.
 */

import { diffInkPage } from "../incoming/inkdiff";
import { parseRmScene } from "../incoming/rmscene";
import { Glyph, GlyphSource, HandFont, builtinFont, CAP_RATIO } from "./glyphs";
import type { DeviceProfile, GeneratedStroke, InkPen } from "./inkrender";
import { toInkLines } from "./inkrender";
import { buildInkPageRm, FIRST_STROKE_COUNTER, PEN_COLOR } from "./rmwrite";

/**
 * Bump when the sheet layout or charset changes, and keep the old one
 * buildable: a sheet waiting on the tablet is read back with the layout it
 * was sent with. Version 2: more characters, a reference letter beside the
 * writing space, and x-height and descender guides.
 */
export const SHEET_VERSION = 2;

const CHARS_V1 =
	"abcdefghijklmnopqrstuvwxyz" +
	"ABCDEFGHIJKLMNOPQRSTUVWXYZ" +
	"0123456789" +
	"äöüßÄÖÜ" +
	".,;:!?'\"-()/&@#%+=*€";

/**
 * Characters on the letter sheet, per version. Accented letters (é, à, ç…)
 * need no box: they are composed from the owner's own base letter.
 */
export const SHEET_CHARSETS: Record<number, string> = {
	1: CHARS_V1,
	2: CHARS_V1 + "[]{}<>_~^|\\$£°„“”‘’«»…–✓✗→←↑↓",
};

export const SHEET_CHARS = SHEET_CHARSETS[SHEET_VERSION];

/**
 * The word sheet (joined-up writing): everyday German and English words,
 * short and long, chosen so most letter joins occur somewhere.
 */
export const WORD_SHEET_WORDS = [
	"und", "nicht", "die", "der", "das", "ist", "auch", "noch", "wenn", "aber",
	"schon", "heute", "morgen", "Termin", "prüfen", "wichtig", "Frage", "danke",
	"bitte", "können", "müssen", "Woche", "später", "Idee",
	"the", "and", "that", "with", "this", "have", "from", "will", "what", "about",
	"which", "when", "could", "think", "check", "again", "meeting", "question",
	"today", "tomorrow", "because", "maybe", "should", "next",
];

export type SheetKind = "letters" | "words";

export interface SheetBox {
	/** What to write in the box: a character, or a whole word on the word sheet. */
	char: string;
	/** 1-based sheet page. */
	page: number;
	left: number;
	top: number;
	width: number;
	height: number;
	baseline: number;
	capLine: number;
}

export interface Sheet {
	pages: GeneratedStroke[][];
	boxes: SheetBox[];
}

/** What a pending sheet needs to be read back. */
export interface PendingSheet {
	deviceDocId: string;
	pageIds: string[];
	profile: DeviceProfile;
	version: number;
	/** Absent for the letter sheet, which came first. */
	kind?: "words";
}

const GUIDE_PEN: InkPen = { tool: 17, color: PEN_COLOR.grey, thicknessScale: 1, width: 8 };

/**
 * Lay out the sheet for a canvas. Deterministic for a given profile, kind
 * and version — the import rebuilds it to tell the owner's ink from ours.
 */
export function buildSheet(profile: DeviceProfile, kind: SheetKind = "letters", version = SHEET_VERSION): Sheet {
	const unit = profile.dpi / 226; // keep physical sizes across devices
	const margin = Math.round(60 * unit);
	const words = kind === "words";
	const legacy = !words && version < 2;
	const boxWidth = words
		? Math.round(Math.max(420 * unit, (profile.width - 2 * margin) / 2 - 1))
		: Math.round((legacy ? 132 : 190) * unit);
	const boxHeight = Math.round(176 * unit);
	const headerHeight = Math.round(210 * unit);
	const cols = Math.max(words ? 1 : 3, Math.floor((profile.width - 2 * margin) / boxWidth));
	const rowsPerPage = Math.max(2, Math.floor((profile.height - headerHeight - margin) / boxHeight));
	const perPage = cols * rowsPerPage;
	const left0 = -profile.width / 2 + (profile.width - cols * boxWidth) / 2;
	const label = new HandFont(builtinFont("hershey-sans"), builtinFont("readability"));

	const boxes: SheetBox[] = [];
	const pages: GeneratedStroke[][] = [];
	const chars = words ? WORD_SHEET_WORDS : [...(SHEET_CHARSETS[version] ?? SHEET_CHARS)];
	const pageCount = Math.ceil(chars.length / perPage);

	for (let p = 0; p < pageCount; p++) {
		const strokes: GeneratedStroke[] = [];
		let counter = FIRST_STROKE_COUNTER;
		const add = (points: { x: number; y: number }[], color: number = PEN_COLOR.grey, thickness = 1) => {
			strokes.push({
				counter: counter++,
				wordId: null,
				tool: GUIDE_PEN.tool,
				color,
				thicknessScale: thickness,
				points: densify(points),
			});
		};
		const write = (text: string, x: number, baseline: number, cap: number, color: number) => {
			let cursor = x;
			for (const ch of text) {
				const glyph = label.glyph(ch);
				for (const path of glyph.strokes) {
					const points: { x: number; y: number }[] = [];
					for (let i = 0; i + 1 < path.length; i += 2) {
						points.push({ x: cursor + path[i] * cap, y: baseline - path[i + 1] * cap });
					}
					add(points, color, 1);
				}
				cursor += label.advanceOf(ch) * cap;
			}
		};

		// Instructions, in the plugin's own hand, wrapped to the box grid —
		// the Move's canvas is too narrow for them on one line.
		const textWidth = cols * boxWidth;
		const wrap = (text: string, cap: number): string[] => {
			const lines: string[] = [];
			let current = "";
			for (const word of text.split(" ")) {
				const candidate = current === "" ? word : `${current} ${word}`;
				if (current !== "" && label.widthOfTextAtSize(candidate, cap / CAP_RATIO) > textWidth) {
					lines.push(current);
					current = word;
				} else {
					current = candidate;
				}
			}
			if (current !== "") lines.push(current);
			return lines;
		};
		const titleCap = 28 * unit;
		const instructionCap = 18 * unit;
		write(
			`${words ? "Word sheet" : "Handwriting sheet"} ${p + 1}/${pageCount}`,
			left0,
			margin + titleCap,
			titleCap,
			PEN_COLOR.black,
		);
		const instructions = wrap(
			words
				? "Write each word once in its box the way you usually write, joined-up " +
						"if that is how you write, sitting on the solid line. Skip any you like."
				: legacy
					? "Write each character once in its box, sitting on the solid line. " +
							"Capitals reach the dashed line. Skip any you like."
					: "Copy each character once, in the space to its right. Sit on the " +
							"solid line; capitals and tall letters reach the dashed line, small " +
							"letters the dotted one, tails go down to the lower dotted line. " +
							"Skip any you like.",
			instructionCap,
		);
		instructions.forEach((line, index) => {
			write(line, left0, margin + titleCap + instructionCap * (2.2 + index * 1.7), instructionCap, PEN_COLOR.black);
		});

		const onPage = chars.slice(p * perPage, (p + 1) * perPage);
		onPage.forEach((char, index) => {
			const col = index % cols;
			const row = Math.floor(index / cols);
			const left = left0 + col * boxWidth;
			const top = headerHeight + row * boxHeight;
			if (legacy) {
				const baseline = top + boxHeight * 0.7;
				const capLine = baseline - boxHeight * 0.42;
				boxes.push({ char, page: p + 1, left, top, width: boxWidth, height: boxHeight, baseline, capLine });
				const inset = 6 * unit;
				// Frame.
				add([
					{ x: left + inset, y: top + inset },
					{ x: left + boxWidth - inset, y: top + inset },
					{ x: left + boxWidth - inset, y: top + boxHeight - inset },
					{ x: left + inset, y: top + boxHeight - inset },
					{ x: left + inset, y: top + inset },
				]);
				// Baseline, solid.
				add([
					{ x: left + inset * 2, y: baseline },
					{ x: left + boxWidth - inset * 2, y: baseline },
				]);
				// Cap line, dashed.
				const dash = 10 * unit;
				for (let x = left + inset * 2; x + dash <= left + boxWidth - inset * 2; x += dash * 2) {
					add([
						{ x, y: capLine },
						{ x: x + dash, y: capLine },
					]);
				}
				// The character to write, small, top left.
				write(char, left + inset * 2.2, top + inset + 22 * unit, 18 * unit, PEN_COLOR.grey);
				return;
			}
			// Version 2: the reference, written at full size on the same lines
			// the owner writes on, so where every part belongs can be read off.
			const baseline = top + boxHeight * 0.66;
			const cap = boxHeight * 0.4;
			const capLine = baseline - cap;
			const xLine = baseline - cap * 0.66;
			const descLine = baseline + cap * 0.38;
			boxes.push({ char, page: p + 1, left, top, width: boxWidth, height: boxHeight, baseline, capLine });
			const inset = 6 * unit;
			const right = left + boxWidth - inset;
			add([
				{ x: left + inset, y: top + inset },
				{ x: right, y: top + inset },
				{ x: right, y: top + boxHeight - inset },
				{ x: left + inset, y: top + boxHeight - inset },
				{ x: left + inset, y: top + inset },
			]);
			// The reference, in black so it stands out from the grey guides: a
			// character at writing size in its own column, shrunk only when it
			// would not fit; a word above the guides, where no line crosses it.
			const column = words ? 0 : boxWidth * 0.44;
			if (words) {
				const wordCap = Math.min(cap * 0.42, (capLine - top - inset * 3) * 0.85);
				write(char, left + inset * 2.5, capLine - inset * 2.5, wordCap, PEN_COLOR.black);
			} else {
				const natural = label.widthOfTextAtSize(char, cap / CAP_RATIO);
				const refCap = natural > column * 0.8 ? (cap * column * 0.8) / natural : cap;
				const refWidth = label.widthOfTextAtSize(char, refCap / CAP_RATIO);
				write(char, left + (column - refWidth) / 2 + inset / 2, baseline, refCap, PEN_COLOR.black);
				// Where the reference ends and the writing space begins.
				add([
					{ x: left + column, y: top + inset * 3 },
					{ x: left + column, y: top + boxHeight - inset * 3 },
				]);
			}
			// Guides across the box: cap dashed, x-height and descender dotted,
			// baseline solid.
			const from = left + inset * 2;
			const to = right - inset;
			const dashed = (y: number, dash: number, gap: number) => {
				for (let x = from; x + dash <= to; x += dash + gap) {
					add([
						{ x, y },
						{ x: x + dash, y },
					]);
				}
			};
			dashed(capLine, 10 * unit, 10 * unit);
			dashed(xLine, 3 * unit, 9 * unit);
			dashed(descLine, 3 * unit, 9 * unit);
			add([
				{ x: from, y: baseline },
				{ x: to, y: baseline },
			]);
		});
		pages.push(strokes);
	}
	return { pages, boxes };
}

function densify(points: { x: number; y: number }[], step = 6): { x: number; y: number }[] {
	const out: { x: number; y: number }[] = [];
	points.forEach((point, i) => {
		if (i > 0) {
			const prev = points[i - 1];
			const length = Math.hypot(point.x - prev.x, point.y - prev.y);
			const pieces = Math.floor(length / step);
			for (let k = 1; k < pieces; k++) {
				out.push({
					x: Math.round((prev.x + ((point.x - prev.x) * k) / pieces) * 100) / 100,
					y: Math.round((prev.y + ((point.y - prev.y) * k) / pieces) * 100) / 100,
				});
			}
		}
		out.push({ x: Math.round(point.x * 100) / 100, y: Math.round(point.y * 100) / 100 });
	});
	return out;
}

/** The `.rm` pages of a sheet. */
export function sheetPagesToRm(sheet: Sheet, profile: DeviceProfile): Uint8Array[] {
	return sheet.pages.map((strokes) =>
		buildInkPageRm(toInkLines(strokes, GUIDE_PEN), {
			paperSize: { width: profile.width, height: profile.height },
		}),
	);
}

/* ------------------------------------------------------------------ */
/* Learning: sheet ink → handwriting library                           */
/* ------------------------------------------------------------------ */

/** The stored handwriting: glyph variants per character, in cap units. */
export interface HandLibrary {
	format: 1;
	/** Content hash; what a send records so its strokes can be regenerated. */
	version: string;
	createdAt: string;
	/** Advance of a space in cap units. */
	space: number;
	glyphs: Record<string, Glyph[]>;
}

/** Ramer–Douglas–Peucker on a flat x,y list. */
function simplify(flat: number[], epsilon: number): number[] {
	const count = flat.length / 2;
	if (count <= 2) return flat;
	const keep = new Uint8Array(count);
	keep[0] = 1;
	keep[count - 1] = 1;
	const stack: [number, number][] = [[0, count - 1]];
	while (stack.length > 0) {
		const [a, b] = stack.pop()!;
		const ax = flat[a * 2];
		const ay = flat[a * 2 + 1];
		const bx = flat[b * 2];
		const by = flat[b * 2 + 1];
		const len = Math.hypot(bx - ax, by - ay);
		let worst = -1;
		let worstDistance = 0;
		for (let i = a + 1; i < b; i++) {
			const px = flat[i * 2];
			const py = flat[i * 2 + 1];
			const distance =
				len === 0
					? Math.hypot(px - ax, py - ay)
					: Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / len;
			if (distance > worstDistance) {
				worstDistance = distance;
				worst = i;
			}
		}
		if (worst !== -1 && worstDistance > epsilon) {
			keep[worst] = 1;
			stack.push([a, worst], [worst, b]);
		}
	}
	const out: number[] = [];
	for (let i = 0; i < count; i++) if (keep[i]) out.push(flat[i * 2], flat[i * 2 + 1]);
	return out;
}

function hashString(text: string): string {
	let h1 = 0x811c9dc5;
	let h2 = 0x01000193;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		h1 = Math.imul(h1 ^ c, 0x01000193);
		h2 = Math.imul(h2 ^ c, 0x5bd1e995);
	}
	return ((h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0")).slice(0, 16);
}

export interface LearnResult {
	library: HandLibrary;
	/** Characters that got a glyph from this sheet. */
	learned: string[];
	/** Characters left empty on the sheet; they fall back to the built-in font. */
	skipped: string[];
}

/**
 * Read filled-in sheet pages back into a library. `pages` maps page id to the
 * page's bytes; `previous`, when given, keeps its glyphs and gains the new
 * ones as extra variants (up to three per character) — fill a second sheet
 * and the hand stops writing every "e" identically.
 */
export function learnHand(
	pending: PendingSheet,
	pages: Map<string, Uint8Array>,
	previous: HandLibrary | null = null,
	now: () => Date = () => new Date(),
): LearnResult {
	const sheet = buildSheet(pending.profile, "letters", pending.version);
	const found = new Map<string, number[][]>();
	pending.pageIds.forEach((pageId, index) => {
		const bytes = pages.get(pageId);
		if (bytes === undefined) return;
		const diff = diffInkPage(sheet.pages[index] ?? [], parseRmScene(bytes));
		const boxes = sheet.boxes.filter((box) => box.page === index + 1);
		for (const stroke of diff.userStrokes) {
			const points = stroke.points;
			if (points.length === 0) continue;
			const cx = points.reduce((sum, point) => sum + point.x, 0) / points.length;
			const cy = points.reduce((sum, point) => sum + point.y, 0) / points.length;
			const box = boxes.find(
				(candidate) =>
					cx >= candidate.left &&
					cx <= candidate.left + candidate.width &&
					cy >= candidate.top &&
					cy <= candidate.top + candidate.height,
			);
			if (box === undefined) continue;
			const cap = box.baseline - box.capLine;
			const flat = points.flatMap((point) => [point.x / cap, (box.baseline - point.y) / cap]);
			const list = found.get(box.char) ?? [];
			list.push(flat);
			found.set(box.char, list);
		}
	});

	const glyphs: Record<string, Glyph[]> = {};
	if (previous !== null) {
		for (const [ch, variants] of Object.entries(previous.glyphs)) glyphs[ch] = [...variants];
	}
	const learned: string[] = [];
	for (const [ch, strokes] of found) {
		let minX = Infinity;
		let maxX = -Infinity;
		for (const stroke of strokes) {
			for (let i = 0; i < stroke.length; i += 2) {
				minX = Math.min(minX, stroke[i]);
				maxX = Math.max(maxX, stroke[i]);
			}
		}
		const sideBearing = 0.07;
		const glyph: Glyph = {
			advance: Math.round((maxX - minX + 2 * sideBearing) * 1000) / 1000,
			strokes: strokes.map((stroke) =>
				simplify(
					stroke.map((value, i) => (i % 2 === 0 ? value - minX + sideBearing : value)),
					0.008,
				).map((value) => Math.round(value * 1000) / 1000),
			),
		};
		const variants = previous === null ? [] : (glyphs[ch] ?? []);
		glyphs[ch] = [...variants, glyph].slice(-3);
		learned.push(ch);
	}

	// A space as wide as a typical narrow letter of this hand.
	const lower = "acemnorsuvwxz"
		.split("")
		.map((ch) => glyphs[ch]?.[0]?.advance)
		.filter((value): value is number => value !== undefined)
		.sort((a, b) => a - b);
	const space = lower.length > 0 ? Math.max(0.3, lower[Math.floor(lower.length / 2)] * 0.75) : 0.38;

	const body = JSON.stringify({ space, glyphs });
	return {
		library: {
			format: 1,
			version: `hand-${hashString(body)}`,
			createdAt: now().toISOString(),
			space,
			glyphs,
		},
		learned: learned.sort(),
		skipped: [...(SHEET_CHARSETS[pending.version] ?? SHEET_CHARS)].filter((ch) => !found.has(ch) && !(ch in glyphs)),
	};
}

/**
 * Read a filled-in word sheet: each box's ink, in device units, by the word
 * it was written for. Empty boxes are left out.
 */
export function learnWords(
	pending: PendingSheet,
	pages: Map<string, Uint8Array>,
): Record<string, { x: number; y: number }[][]> {
	const sheet = buildSheet(pending.profile, "words", pending.version);
	const found: Record<string, { x: number; y: number }[][]> = {};
	pending.pageIds.forEach((pageId, index) => {
		const bytes = pages.get(pageId);
		if (bytes === undefined) return;
		const diff = diffInkPage(sheet.pages[index] ?? [], parseRmScene(bytes));
		const boxes = sheet.boxes.filter((box) => box.page === index + 1);
		for (const stroke of diff.userStrokes) {
			if (stroke.points.length === 0) continue;
			const cx = stroke.points.reduce((sum, point) => sum + point.x, 0) / stroke.points.length;
			const cy = stroke.points.reduce((sum, point) => sum + point.y, 0) / stroke.points.length;
			const box = boxes.find(
				(candidate) =>
					cx >= candidate.left &&
					cx <= candidate.left + candidate.width &&
					cy >= candidate.top &&
					cy <= candidate.top + candidate.height,
			);
			if (box === undefined) continue;
			(found[box.char] ??= []).push(stroke.points.map((point) => ({ x: point.x, y: point.y })));
		}
	});
	return found;
}

/** A library as a glyph source the fonts can draw from. */
export function handSource(library: HandLibrary): GlyphSource {
	return {
		id: "hand",
		version: library.version,
		name: "My handwriting",
		glyphs: new Map(Object.entries(library.glyphs)),
		space: library.space,
	};
}

/** Cap height in points for a font size; shared so previews match sends. */
export function capPoints(size: number): number {
	return size * CAP_RATIO;
}
