/**
 * Handwriting recognition on the device's own strokes, with nothing but the
 * plugin itself (ink fork).
 *
 * A remark arrives as pen strokes in drawing order, so no picture has to be
 * read: strokes are grouped into lines, letters and words, and every letter
 * is compared with templates — the owner's own hand from the handwriting
 * sheet when there is one, and the bundled print fonts — by the $P
 * point-cloud distance (Vatavu, Anthony & Wobbrock 2012) plus where the
 * letter sits on its line, which tells `o` from `O` and `,` from `'`. Words
 * are then corrected against a word list taken from the vault, which is why
 * any language the owner writes in works without a dictionary.
 *
 * Built for separate print letters; joined-up writing comes back with a low
 * confidence and is then left to the image.
 */

import type { Glyph } from "../ink/glyphs";

export interface Point {
	x: number;
	y: number;
}

/** One reference shape of a character, normalised for matching. */
export interface Template {
	ch: string;
	cloud: Point[];
	/** Top, bottom (relative to the baseline) and width, in cap heights (y up). */
	top: number;
	bottom: number;
	width: number;
	/** Preferred source (the owner's own hand) scores slightly better. */
	weight: number;
}

/** Characters worth recognising: letters incl. German, digits, punctuation. */
export const OCR_CHARS =
	"abcdefghijklmnopqrstuvwxyzäöüßABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÜ0123456789.,;:!?-'\"()/&+" +
	"[]{}<>_~^|\\$€£°@#%=*„“”‘’«»…–✓✗→←↑↓";

const CLOUD_SIZE = 32;

function pathLength(points: Point[]): number {
	let total = 0;
	for (let i = 1; i < points.length; i++) total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
	return total;
}

/** Resample strokes to `n` points spread evenly over their combined length. */
function resample(strokes: Point[][], n: number): Point[] {
	const total = strokes.reduce((sum, stroke) => sum + pathLength(stroke), 0);
	const all = strokes.flat();
	if (total === 0 || all.length === 0) return Array.from({ length: n }, () => ({ ...(all[0] ?? { x: 0, y: 0 }) }));
	const step = total / (n - 1);
	const out: Point[] = [{ ...strokes.find((s) => s.length > 0)![0] }];
	let carried = 0;
	for (const stroke of strokes) {
		for (let i = 1; i < stroke.length; i++) {
			let a = stroke[i - 1];
			const b = stroke[i];
			let segment = Math.hypot(b.x - a.x, b.y - a.y);
			while (carried + segment >= step && out.length < n) {
				const t = (step - carried) / segment;
				const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
				out.push(p);
				a = p;
				segment = Math.hypot(b.x - a.x, b.y - a.y);
				carried = 0;
			}
			carried += segment;
		}
	}
	while (out.length < n) out.push({ ...all[all.length - 1] });
	return out;
}

/** Centre on the centroid and scale the larger side to 1, keeping the aspect. */
function normalise(points: Point[]): Point[] {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	let cx = 0;
	let cy = 0;
	for (const p of points) {
		minX = Math.min(minX, p.x);
		minY = Math.min(minY, p.y);
		maxX = Math.max(maxX, p.x);
		maxY = Math.max(maxY, p.y);
		cx += p.x;
		cy += p.y;
	}
	cx /= points.length;
	cy /= points.length;
	const size = Math.max(maxX - minX, maxY - minY) || 1;
	return points.map((p) => ({ x: (p.x - cx) / size, y: (p.y - cy) / size }));
}

export function cloudOf(strokes: Point[][]): Point[] {
	return normalise(resample(strokes.filter((s) => s.length > 0), CLOUD_SIZE));
}

function cloudDistance(a: Point[], b: Point[], start: number): number {
	const matched = new Uint8Array(b.length);
	let sum = 0;
	let i = start;
	do {
		let best = Infinity;
		let index = -1;
		for (let j = 0; j < b.length; j++) {
			if (matched[j]) continue;
			const d = Math.hypot(a[i].x - b[j].x, a[i].y - b[j].y);
			if (d < best) {
				best = d;
				index = j;
			}
		}
		matched[index] = 1;
		const weight = 1 - ((i - start + a.length) % a.length) / a.length;
		sum += weight * best;
		i = (i + 1) % a.length;
	} while (i !== start);
	return sum;
}

/** $P greedy cloud match, both directions, a few starting points (`starts` caps them). */
export function matchDistance(a: Point[], b: Point[], starts = Infinity): number {
	const step = Number.isFinite(starts) ? Math.max(1, Math.floor(a.length / starts)) : Math.floor(Math.sqrt(a.length));
	let best = Infinity;
	for (let start = 0; start < a.length; start += step) {
		best = Math.min(best, cloudDistance(a, b, start), cloudDistance(b, a, start));
	}
	return best / a.length;
}

/** Templates from glyph sets in cap units (y up, baseline 0, cap 1). */
export function templatesFrom(sources: { glyphs: Map<string, Glyph[]> | Record<string, Glyph[]>; weight: number }[]): Template[] {
	const out: Template[] = [];
	for (const source of sources) {
		const entries = source.glyphs instanceof Map ? [...source.glyphs.entries()] : Object.entries(source.glyphs);
		for (const [ch, variants] of entries) {
			if (!OCR_CHARS.includes(ch)) continue;
			for (const glyph of variants) {
				const strokes = glyph.strokes.map((flat) => {
					const points: Point[] = [];
					for (let i = 0; i + 1 < flat.length; i += 2) points.push({ x: flat[i], y: -flat[i + 1] });
					return points;
				});
				const ys = glyph.strokes.flatMap((flat) => flat.filter((_, i) => i % 2 === 1));
				const xs = glyph.strokes.flatMap((flat) => flat.filter((_, i) => i % 2 === 0));
				if (ys.length === 0) continue;
				out.push({
					ch,
					cloud: cloudOf(strokes),
					top: Math.max(...ys),
					bottom: Math.min(...ys),
					width: Math.max(...xs) - Math.min(...xs),
					weight: source.weight,
				});
			}
		}
	}
	return out;
}

interface Box {
	minX: number;
	maxX: number;
	minY: number;
	maxY: number;
}

function boxOf(strokes: Point[][]): Box {
	const box = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
	for (const p of strokes.flat()) {
		box.minX = Math.min(box.minX, p.x);
		box.maxX = Math.max(box.maxX, p.x);
		box.minY = Math.min(box.minY, p.y);
		box.maxY = Math.max(box.maxY, p.y);
	}
	return box;
}

const median = (values: number[]) => {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)];
};

/** Strokes (device units, y down) → lines, top to bottom. */
function splitLines(strokes: Point[][]): Point[][][] {
	const items = strokes.map((stroke) => ({ stroke, box: boxOf([stroke]) }));
	const height = median(items.map((item) => item.box.maxY - item.box.minY)) || 1;
	items.sort((a, b) => (a.box.minY + a.box.maxY) / 2 - (b.box.minY + b.box.maxY) / 2);
	const lines: { strokes: Point[][]; centre: number }[] = [];
	for (const item of items) {
		const centre = (item.box.minY + item.box.maxY) / 2;
		const line = lines.find((l) => Math.abs(l.centre - centre) < height * 1.1);
		if (line === undefined) lines.push({ strokes: [item.stroke], centre });
		else {
			line.strokes.push(item.stroke);
			line.centre = (line.centre * (line.strokes.length - 1) + centre) / line.strokes.length;
		}
	}
	return lines.sort((a, b) => a.centre - b.centre).map((l) => l.strokes);
}

interface Group {
	strokes: Point[][];
	box: Box;
}

/**
 * A line's strokes → stroke clusters, left to right. Strokes that overlap
 * sideways belong together (the bar of a t, the dots of an ü); so does a
 * small mark sitting over or under its neighbour (the dot of an i).
 */
function clusterStrokes(strokes: Point[][], unit: number): Group[] {
	const items = strokes.map((stroke) => ({ strokes: [stroke], box: boxOf([stroke]) }));
	items.sort((a, b) => a.box.minX - b.box.minX);
	const groups: Group[] = [];
	for (const item of items) {
		const last = groups[groups.length - 1];
		if (last !== undefined) {
			const overlap = Math.min(last.box.maxX, item.box.maxX) - Math.max(last.box.minX, item.box.minX);
			const narrower = Math.min(last.box.maxX - last.box.minX, item.box.maxX - item.box.minX);
			const centre = (item.box.minX + item.box.maxX) / 2;
			const small = Math.max(item.box.maxX - item.box.minX, item.box.maxY - item.box.minY) < unit * 0.3;
			const above = small && centre >= last.box.minX - unit * 0.15 && centre <= last.box.maxX + unit * 0.15;
			if (overlap > Math.max(narrower, unit * 0.05) * 0.4 || above) {
				last.strokes.push(...item.strokes);
				last.box = boxOf(last.strokes);
				continue;
			}
		}
		groups.push(item);
	}
	return groups;
}

function merged(groups: Group[]): Group {
	const strokes = groups.flatMap((g) => g.strokes);
	return { strokes, box: boxOf(strokes) };
}

export interface Candidate {
	ch: string;
	cost: number;
}

/** Cost of an unrecognised position in a dictionary match. */
const MISS = 1.2;

/**
 * Most templates kept per character. A per-writer store that grows (learned
 * letter templates, many variants of a glyph) must not grow the per-letter
 * recognition work without bound; this caps the total template count at
 * roughly OCR_CHARS × TEMPLATE_CAP whatever the store size. The bundled fonts
 * have at most ~2 variants per character, so nothing bundled is dropped.
 */
export const TEMPLATE_CAP = 6;

/**
 * Keep at most TEMPLATE_CAP templates per character, so read-time work stays
 * bounded as the store grows. The owner's own hand (lower `weight`) is kept in
 * preference to the bundled fonts when a character has more variants than the cap.
 */
function capPerChar(templates: Template[], cap = TEMPLATE_CAP): Template[] {
	const byChar = new Map<string, Template[]>();
	for (const template of templates) {
		const list = byChar.get(template.ch);
		if (list === undefined) byChar.set(template.ch, [template]);
		else list.push(template);
	}
	let over = false;
	for (const list of byChar.values()) if (list.length > cap) over = true;
	if (!over) return templates;
	const out: Template[] = [];
	for (const list of byChar.values()) {
		if (list.length <= cap) out.push(...list);
		else out.push(...[...list].sort((a, b) => a.weight - b.weight).slice(0, cap));
	}
	return out;
}

function classify(
	group: Group,
	line: { baseline: number; cap: number },
	templates: Template[],
	keep = 6,
): Candidate[] {
	const cloud = cloudOf(group.strokes);
	const top = (line.baseline - group.box.minY) / line.cap;
	const bottom = (line.baseline - group.box.maxY) / line.cap;
	const width = (group.box.maxX - group.box.minX) / line.cap;
	// The baseline-relative metric penalty uses only the cheap scalars already on
	// Template, and — the shape distance being non-negative — is a lower bound on
	// the full cost. So a template whose metric penalty alone already beats the
	// 24th-best full cost cannot reach the shortlist, and need not be shape-matched.
	const metricOf = (t: Template) =>
		(0.35 * (Math.abs(top - t.top) + Math.abs(bottom - t.bottom)) + 0.25 * Math.abs(width - t.width)) * t.weight;
	const costOf = (template: Template, shape: number) => template.weight * shape + metricOf(template);
	// Rank by the cheap metric lower bound, then run the quick shape pass in that
	// order, stopping as soon as no unseen template could beat the 24 kept. Same
	// "quick pass → top-24 → full match" as before; the quick pass just stops
	// being unconditionally O(all templates) as the store grows.
	const ranked = templates
		.map((template) => ({ template, metric: metricOf(template) }))
		.sort((a, b) => a.metric - b.metric);
	const kept: { template: Template; cost: number }[] = []; // ascending by cost, length <= 24
	for (const { template, metric } of ranked) {
		if (kept.length === 24 && metric >= kept[23].cost) break;
		const cost = costOf(template, matchDistance(cloud, template.cloud, 1));
		if (kept.length < 24) {
			let pos = kept.length;
			while (pos > 0 && kept[pos - 1].cost > cost) pos--;
			kept.splice(pos, 0, { template, cost });
		} else if (cost < kept[23].cost) {
			kept.pop();
			let pos = 23;
			while (pos > 0 && kept[pos - 1].cost > cost) pos--;
			kept.splice(pos, 0, { template, cost });
		}
	}
	const best = new Map<string, number>();
	for (const { template } of kept) {
		const cost = costOf(template, matchDistance(cloud, template.cloud));
		if (cost < (best.get(template.ch) ?? Infinity)) best.set(template.ch, cost);
	}
	return [...best.entries()]
		.map(([ch, cost]) => ({ ch, cost }))
		.sort((a, b) => a.cost - b.cost)
		.slice(0, keep);
}

/** Words to correct against, bucketed by length, with their usual spelling. */
export class Lexicon {
	private readonly byLength = new Map<number, Map<string, Map<string, number>>>();

	constructor(words: Iterable<string>) {
		for (const word of words) this.add(word);
	}

	add(word: string): void {
		if (word.length < 2 || word.length > 30 || !/\p{L}/u.test(word)) return;
		const key = word.toLowerCase();
		let bucket = this.byLength.get(key.length);
		if (bucket === undefined) {
			bucket = new Map();
			this.byLength.set(key.length, bucket);
		}
		const forms = bucket.get(key) ?? new Map<string, number>();
		forms.set(word, (forms.get(word) ?? 0) + 1);
		bucket.set(key, forms);
	}

	/** Every word of a text: letters (any alphabet) and digits. */
	static fromText(texts: Iterable<string>): Lexicon {
		const lexicon = new Lexicon([]);
		for (const text of texts) for (const match of text.matchAll(/[\p{L}\p{N}]+/gu)) lexicon.add(match[0]);
		return lexicon;
	}

	has(word: string): boolean {
		const key = word.toLowerCase();
		return this.byLength.get(key.length)?.has(key) === true;
	}

	/** Every word, lower case with its most common spelling. */
	*words(): Iterable<[string, string]> {
		for (const length of this.byLength.keys()) yield* this.ofLength(length);
	}

	/** Lower-case words of a length, each with its most common spelling. */
	*ofLength(length: number): Iterable<[string, string]> {
		for (const [key, forms] of this.byLength.get(length) ?? []) {
			let best = key;
			let count = -1;
			for (const [form, n] of forms) {
				if (n > count) {
					best = form;
					count = n;
				}
			}
			yield [key, best];
		}
	}
}

/**
 * How well a word explains the letter candidates, letters aligned with one
 * skip or split allowed either way (a w read as vv, an ß as two letters).
 */
function alignCost(word: string, positions: Candidate[][], limit: number): number {
	const n = positions.length;
	const m = word.length;
	let prev = Array.from({ length: m + 1 }, (_, j) => j * MISS);
	for (let i = 1; i <= n; i++) {
		const row = [i * MISS];
		let rowBest = row[0];
		for (let j = 1; j <= m; j++) {
			const hit = positions[i - 1].find((c) => c.ch.toLowerCase() === word[j - 1]);
			const match = prev[j - 1] + (hit === undefined ? MISS : hit.cost);
			row[j] = Math.min(match, prev[j] + MISS, row[j - 1] + MISS);
			rowBest = Math.min(rowBest, row[j]);
		}
		if (rowBest > limit) return Infinity;
		prev = row;
	}
	return prev[m];
}

/** Pick the dictionary word the letter candidates explain best, if it is close enough. */
function correct(positions: Candidate[][], lexicon: Lexicon | undefined): { text: string; cost: number } {
	const raw = positions.map((cands) => cands[0]);
	const rawCost = raw.reduce((sum, c) => sum + c.cost, 0);
	const rawText = raw.map((c) => c.ch).join("");
	if (lexicon === undefined || !/\p{L}/u.test(rawText)) return { text: rawText, cost: rawCost };
	// Punctuation at the ends stays as recognised; the word in between is corrected.
	const lead = rawText.match(/^[^\p{L}\p{N}]*/u)![0].length;
	const trail = rawText.match(/[^\p{L}\p{N}]*$/u)![0].length;
	const core = positions.slice(lead, positions.length - trail);
	if (core.length === 0) return { text: rawText, cost: rawCost };
	const rawCore = core.reduce((sum, cands) => sum + cands[0].cost, 0);
	// A known word wins unless it has to explain away clearly better shapes.
	let limit = rawCore + 0.25 * core.length;
	let best: { key: string; form: string; cost: number } | null = null;
	for (const length of [core.length, core.length - 1, core.length + 1]) {
		for (const [key, form] of lexicon.ofLength(length)) {
			const cost = alignCost(key, core, limit);
			if (cost <= limit && (best === null || cost < best.cost)) {
				best = { key, form, cost };
				limit = cost;
			}
		}
	}
	if (best === null) return { text: rawText, cost: rawCost };
	// The writer's capitals where a letter was clearly read, else the usual spelling.
	const cased =
		best.key.length === core.length
			? [...best.form]
					.map((ch, i) => {
						const seen = core[i][0].ch;
						if (seen.toLowerCase() !== ch.toLowerCase()) return ch;
						return seen;
					})
					.join("")
			: best.form;
	return {
		text: rawText.slice(0, lead) + cased + rawText.slice(rawText.length - trail),
		cost: rawCost - rawCore + best.cost,
	};
}

/** Cost added per letter, so splitting a letter in two is not free. */
const PER_LETTER = 0.2;

/**
 * Split a word's clusters into letters: each letter is one to three
 * neighbouring clusters, chosen so the letters match their best shapes
 * (the arm of a k, the halves of an H drawn apart).
 */
function segment(word: Group[], line: { baseline: number; cap: number }, templates: Template[]): Candidate[][] {
	const best: { cost: number; letters: Candidate[][] }[] = [{ cost: 0, letters: [] }];
	for (let end = 1; end <= word.length; end++) {
		best[end] = { cost: Infinity, letters: [] };
		for (let size = 1; size <= 3 && size <= end; size++) {
			const parts = word.slice(end - size, end);
			// Only clusters that touch can be one letter: separate letters
			// leave a gap, the arm of a k does not.
			if (parts.some((part, i) => i > 0 && part.box.minX - parts[i - 1].box.maxX > line.cap * 0.06)) continue;
			const group = size === 1 ? parts[0] : merged(parts);
			const candidates = classify(group, line, templates);
			const cost = best[end - size].cost + (candidates[0]?.cost ?? MISS) + PER_LETTER;
			if (cost < best[end].cost) best[end] = { cost, letters: [...best[end - size].letters, candidates] };
		}
	}
	return best[word.length].letters;
}

/**
 * Below this the image alone is the safer answer.
 *
 * Calibrated against the labelled fixture set in
 * src/__tests__/fixtures/handwriting.ts (deterministic renders of print vs
 * cursive bundled fonts, jitter 0.5). The two classes separate with a clean
 * gap: legitimate print reads at 0.83–0.98 (minimum: hershey-sans "update the
 * spreadsheet now" ≈ 0.831), while mis-segmented cursive tops out at ≈ 0.739
 * (hershey-script "we should talk soon"). 0.78 sits in that gap with headroom
 * on both sides (~0.05 below the print floor, ~0.04 above the cursive ceiling).
 *
 * The old value of 0.65 leaked: hershey-script "Check this again tomorrow"
 * scored 0.669 and returned junk ("C%% @w mm %mmm"). A per-letter-cost ceiling
 * would NOT have caught that case (its per-letter cost is low, ≈0.20, because
 * symbol glyphs match cheaply), so the threshold is the right guard here.
 */
export const OCR_TRUST = 0.78;

/**
 * Above this share of symbols a reading is junk, however confident.
 *
 * OCR_TRUST alone leaked on the first real capture of the owner's hand
 * (handwriting-samples/test-sheets/2026-10-21-001026): fast joined cursive,
 * tiled with the hand's own symbol glyphs (@ → ✗ « ↑ % € …), cleared it.
 * "/IäI→✗rl…,%«%.Jl€" read at 0.784 and "@:@+m«↑@&↑3]" at 0.788, both above
 * the 0.739 bundled-font cursive ceiling and too close to the ≈0.83 print
 * floor for a higher threshold to buy any margin. Their symbol fractions are
 * 0.59 and 0.83, while every one of the 18 test-sheet prompts scores at most
 * 0.21 (highest: "later → done ✓, not now ✗" ≈ 0.21, "Frage: ja oder nein?
 * (siehe #14)" ≈ 0.19). 0.3 sits in that gap. Unlike a known-word gate it needs
 * no vault words and keeps print that is mostly numbers ("Termin am 14.03. um
 * 9:30 Uhr").
 */
export const OCR_MAX_SYMBOLS = 0.3;

export interface Recognition {
	text: string;
	/** 0–1: how well the shapes matched; low means "trust the image". */
	confidence: number;
}

/** Share of the non-space characters that are neither letters nor digits; 1 for none. */
function symbolFraction(text: string): number {
	const chars = [...text.replace(/\s/gu, "")];
	if (chars.length === 0) return 1;
	return chars.filter((ch) => !/[\p{L}\p{N}]/u.test(ch)).length / chars.length;
}

/** Whether the built-in reading may stand, or the next reader (or the image) should take over. */
export function builtinTrusted(r: Recognition | null): boolean {
	return r !== null && r.confidence >= OCR_TRUST && symbolFraction(r.text) <= OCR_MAX_SYMBOLS;
}

interface LineWords {
	line: { baseline: number; cap: number };
	words: Group[][];
}

/** Strokes (device units, y down) → lines of words of letter clusters. */
function layoutOf(strokes: Point[][]): LineWords[] {
	const out: LineWords[] = [];
	for (const lineStrokes of splitLines(strokes.filter((stroke) => stroke.length > 0))) {
		const lineBox = boxOf(lineStrokes);
		const groups = clusterStrokes(lineStrokes, (lineBox.maxY - lineBox.minY) * 0.6 || 1);
		// The baseline sits where most letters end; the tallest letters give the cap.
		const baseline = median(groups.map((g) => g.box.maxY));
		const tops = groups.map((g) => baseline - g.box.minY).sort((a, b) => a - b);
		const tallest = tops[tops.length - 1] || 1;
		// Lower case is about 0.7 of a capital. A line of letters all about the
		// same height is far more often lower case than capitals.
		const typical = median(tops) || 1;
		const cap =
			tallest > typical * 1.2 ? Math.max(tops[Math.floor(tops.length * 0.8)], typical * 1.2) : typical / 0.7;
		const gaps: number[] = [];
		for (let i = 1; i < groups.length; i++) gaps.push(groups[i].box.minX - groups[i - 1].box.maxX);
		const space = Math.max(cap * 0.45, median(gaps) * 2.2);
		const words: Group[][] = [[]];
		for (const [i, group] of groups.entries()) {
			if (i > 0 && gaps[i - 1] > space) words.push([]);
			words[words.length - 1].push(group);
		}
		out.push({ line: { baseline, cap }, words: words.filter((word) => word.length > 0) });
	}
	return out;
}

/** The strokes of each word, line by line — how a remark is cut into words. */
export function splitWords(strokes: Point[][]): Point[][][][] {
	return layoutOf(strokes).map((line) => line.words.map((word) => word.flatMap((group) => group.strokes)));
}

/**
 * Cut stroke clusters into exactly `count` groups at their widest gaps. Needs
 * at least `count` clusters; when `minGap` is given every cut must fall on a
 * gap at least that wide, so a join that never opens up is not cut through.
 */
function cutGroups(groups: Group[], count: number, minGap?: number): Point[][][] | null {
	if (count < 1 || groups.length < count) return null;
	const chosen = groups
		.slice(1)
		.map((group, i) => ({ at: i + 1, gap: group.box.minX - groups[i].box.maxX }))
		.sort((a, b) => b.gap - a.gap)
		.slice(0, count - 1);
	if (minGap !== undefined && chosen.some((cut) => cut.gap < minGap)) return null;
	const cuts = chosen.map((cut) => cut.at).sort((a, b) => a - b);
	const out: Point[][][] = [];
	let start = 0;
	for (const cut of [...cuts, groups.length]) {
		out.push(groups.slice(start, cut).flatMap((group) => group.strokes));
		start = cut;
	}
	return out;
}

/**
 * One line's strokes cut into exactly `count` words at its widest gaps — for
 * when the number of words is known (a corrected remark), which beats any
 * guess at how wide a space is.
 */
export function splitLineInto(strokes: Point[][], count: number): Point[][][] | null {
	const box = boxOf(strokes);
	const groups = clusterStrokes(strokes, (box.maxY - box.minY) * 0.6 || 1);
	return cutGroups(groups, count);
}

/** A cut between letters must open at least this fraction of the word's height. */
const LETTER_GAP = 0.08;

/**
 * One word's strokes cut into exactly `count` letters at its widest gaps — but
 * only when the ink truly separates into that many letters: there must be at
 * least `count` stroke clusters and every cut must fall on a clear gap (wider
 * than a fraction of the word's height). Joined-up cursive runs together into
 * too few clusters, or into letters with no clear break, and returns null — so
 * letter shapes are never guessed from ink that cannot be segmented.
 */
export function cutLetters(wordStrokes: Point[][], count: number): Point[][][] | null {
	const box = boxOf(wordStrokes);
	const height = box.maxY - box.minY || 1;
	const groups = clusterStrokes(wordStrokes, height * 0.6 || 1);
	return cutGroups(groups, count, height * LETTER_GAP);
}

/**
 * Below the print fonts (weight 1) and no lower than the handwriting sheet
 * (0.9), so a letter accumulated in the owner's own hand is preferred over the
 * bundled print letters without ever outweighing the dedicated sheet.
 */
export const LEARNED_LETTER_WEIGHT = 0.9;

/**
 * Templates from the per-letter ink learned from corrections (samples.ts).
 * Each stored sample is a letter's strokes in cap units with the word baseline
 * at y = 0 (device y-down kept, so the shape matches a read letter's as
 * templatesFrom's does); top/bottom (y up, baseline-relative) are then the
 * negated box and width its x range. `store.letters` may be absent (old stores).
 */
export function lettersTemplates(
	store: { letters?: Record<string, Point[][][]> },
	weight = LEARNED_LETTER_WEIGHT,
): Template[] {
	const out: Template[] = [];
	for (const [ch, samples] of Object.entries(store.letters ?? {})) {
		if (!OCR_CHARS.includes(ch)) continue;
		for (const sample of samples) {
			const strokes = sample.filter((stroke) => stroke.length > 0);
			if (strokes.flat().length < 2) continue;
			const box = boxOf(strokes);
			out.push({
				ch,
				cloud: cloudOf(strokes),
				top: -box.minY,
				bottom: -box.maxY,
				width: box.maxX - box.minX,
				weight,
			});
		}
	}
	return out;
}

/** Reads a whole word at once, for joined-up writing (see words.ts). */
export interface WholeWordReader {
	/** The best match and how close it is; `trusted` when close enough to use. */
	read(strokes: Point[][], lexicon: Lexicon | undefined): { word: string; cost: number; trusted: boolean } | null;
}

/** A letter cost per letter that counts as "the letter reader is unsure". */
const UNSURE = 0.3;

/**
 * Read strokes (device units, y down) as text. `lexicon` corrects whole
 * words; `words` reads joined-up words whole — the owner's own samples first.
 */
export function recognize(
	strokes: Point[][],
	templates: Template[],
	lexicon?: Lexicon,
	words?: WholeWordReader,
): Recognition | null {
	const usable = strokes.filter((stroke) => stroke.length > 0);
	if (usable.length === 0 || templates.length === 0) return null;
	const capped = capPerChar(templates);
	const lines: string[] = [];
	let cost = 0;
	let letters = 0;
	for (const { line, words: wordGroups } of layoutOf(usable)) {
		const out: string[] = [];
		for (const groups of wordGroups) {
			const letterCandidates = segment(groups, line, capped);
			if (letterCandidates.length === 0) continue;
			const corrected = correct(letterCandidates, lexicon);
			let text = corrected.text;
			let wordCost = corrected.cost;
			let wordLetters = letterCandidates.length;
			if (words !== undefined) {
				const whole = words.read(groups.flatMap((g) => g.strokes), lexicon);
				const unsure = corrected.cost / letterCandidates.length > UNSURE;
				if (whole !== null && whole.trusted && (unsure || whole.cost < 0.1)) {
					text = whole.word;
					wordLetters = [...whole.word].length;
					wordCost = whole.cost * wordLetters;
				}
			}
			out.push(text);
			cost += wordCost;
			letters += wordLetters;
		}
		lines.push(out.join(" "));
	}
	if (letters === 0) return null;
	const perLetter = cost / letters;
	return { text: lines.join("\n"), confidence: Math.max(0, Math.min(1, 1 - perLetter / 0.6)) };
}
