/**
 * Whole-word recognition for joined-up writing (ink fork).
 *
 * In joined-up writing one stroke runs through several letters, so there is
 * nothing to cut into letters. Instead the word's trace is compared with the
 * trace each candidate word would leave — written in the bundled script
 * fonts, which join their letters, and in the owner's own letters from the
 * handwriting sheet, linked end to start. Traces are compared by dynamic time
 * warping, which forgives uneven letter widths and sloppy joins.
 *
 * Candidates come from the vault's own vocabulary (see Lexicon), narrowed
 * first by width and by a coarse up-and-down profile, so only a few dozen get
 * the full comparison. A word that appears nowhere in the vault cannot be
 * read this way; the letter reader's guess or the image stands then.
 */

import { GlyphSource, resolveGlyph } from "../ink/glyphs";
import type { Lexicon, Point, WholeWordReader } from "./recognize";

const N = 48;
const PROFILE_BINS = 8;

interface Trace {
	points: Point[];
	/** Width in units of the word's height. */
	width: number;
	profile: Float32Array;
}

/** Main strokes as one polyline, in pen order: only dots left out. */
function mainLine(strokes: Point[][]): Point[] {
	let top = Infinity;
	let bottom = -Infinity;
	for (const p of strokes.flat()) {
		top = Math.min(top, p.y);
		bottom = Math.max(bottom, p.y);
	}
	const height = bottom - top || 1;
	// Joined-up strokes overlap, so where they start says little: the order
	// they were drawn in is the word's own order.
	return strokes
		.filter((stroke) => {
			let minX = Infinity;
			let maxX = -Infinity;
			let minY = Infinity;
			let maxY = -Infinity;
			for (const p of stroke) {
				minX = Math.min(minX, p.x);
				maxX = Math.max(maxX, p.x);
				minY = Math.min(minY, p.y);
				maxY = Math.max(maxY, p.y);
			}
			return Math.max(maxX - minX, maxY - minY) >= height * 0.12;
		})
		.flat();
}

function resample(points: Point[], n: number): Point[] {
	if (points.length < 2) return Array.from({ length: n }, () => ({ ...(points[0] ?? { x: 0, y: 0 }) }));
	const lengths = [0];
	for (let i = 1; i < points.length; i++) {
		lengths.push(lengths[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
	}
	const total = lengths[lengths.length - 1] || 1;
	const out: Point[] = [];
	let j = 1;
	for (let k = 0; k < n; k++) {
		const target = (total * k) / (n - 1);
		while (j < points.length - 1 && lengths[j] < target) j++;
		const span = lengths[j] - lengths[j - 1] || 1;
		const t = Math.min(1, Math.max(0, (target - lengths[j - 1]) / span));
		out.push({
			x: points[j - 1].x + (points[j].x - points[j - 1].x) * t,
			y: points[j - 1].y + (points[j].y - points[j - 1].y) * t,
		});
	}
	return out;
}

/**
 * A word's trace in units of its own height (y down, top at 0): the same
 * word comes out the same whatever the size of the writing.
 */
export function traceOf(strokes: Point[][]): Trace | null {
	const line = mainLine(strokes.filter((s) => s.length > 0));
	if (line.length < 2) return null;
	const sampled = resample(line, N);
	const minX = Math.min(...sampled.map((p) => p.x));
	const minY = Math.min(...sampled.map((p) => p.y));
	const height = Math.max(...sampled.map((p) => p.y)) - minY || 1;
	const points = sampled.map((p) => ({ x: (p.x - minX) / height, y: (p.y - minY) / height }));
	const width = Math.max(...points.map((p) => p.x)) || 1;
	const profile = new Float32Array(PROFILE_BINS * 2);
	profile.fill(Number.NaN);
	for (const p of points) {
		const bin = Math.min(PROFILE_BINS - 1, Math.floor((p.x / width) * PROFILE_BINS));
		profile[bin * 2] = Number.isNaN(profile[bin * 2]) ? p.y : Math.max(profile[bin * 2], p.y);
		profile[bin * 2 + 1] = Number.isNaN(profile[bin * 2 + 1]) ? p.y : Math.min(profile[bin * 2 + 1], p.y);
	}
	// A bin the pen skipped over sits in the middle.
	for (let i = 0; i < profile.length; i++) if (Number.isNaN(profile[i])) profile[i] = 0.5;
	return { points, width, profile };
}

/** Unit direction of travel at each point of a trace. */
function directions(points: Point[]): Point[] {
	return points.map((_, i) => {
		const a = points[Math.max(0, i - 1)];
		const b = points[Math.min(points.length - 1, i + 1)];
		const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
		return { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
	});
}

/**
 * Dynamic time warping over two traces: direction of travel and height on
 * the line, the two things joined-up writing keeps whatever the hand —
 * position along the word only lightly, since letter widths vary most.
 */
function dtw(a: Trace, b: Trace): number {
	const scale = b.width / a.width;
	const da = directions(a.points);
	const db = directions(b.points);
	const band = Math.ceil(N * 0.2);
	let prev = new Float64Array(N + 1).fill(Infinity);
	prev[0] = 0;
	for (let i = 1; i <= N; i++) {
		const row = new Float64Array(N + 1).fill(Infinity);
		const p = a.points[i - 1];
		for (let j = Math.max(1, i - band); j <= Math.min(N, i + band); j++) {
			const q = b.points[j - 1];
			const d =
				0.5 * Math.hypot(da[i - 1].x - db[j - 1].x, da[i - 1].y - db[j - 1].y) +
				Math.abs(p.y - q.y) +
				0.15 * Math.abs(p.x * scale - q.x);
			row[j] = d + Math.min(prev[j - 1], prev[j], row[j - 1]);
		}
		prev = row;
	}
	return prev[N] / N;
}

function profileDistance(a: Float32Array, b: Float32Array): number {
	let sum = 0;
	for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
	return sum / a.length;
}

/** A word written in one glyph source, letters placed by their advances. */
function written(word: string, source: GlyphSource, fallback: GlyphSource): Point[][] {
	const strokes: Point[][] = [];
	let x = 0;
	for (const ch of word) {
		const glyph = resolveGlyph(ch, source, fallback);
		for (const flat of glyph.strokes) {
			const stroke: Point[] = [];
			for (let i = 0; i + 1 < flat.length; i += 2) stroke.push({ x: x + flat[i], y: -flat[i + 1] });
			strokes.push(stroke);
		}
		x += glyph.advance;
	}
	return strokes;
}

export interface WordMatch {
	/** The word as the vault usually spells it, or as the owner wrote it. */
	word: string;
	/** Mean trace distance in word heights; lower is closer. */
	cost: number;
	/** Close enough to put in the note. */
	trusted: boolean;
}

/**
 * How close a match must be to be trusted. A word the owner wrote before
 * varies only as handwriting does; a font is a different hand altogether,
 * so only a near-exact match to one counts.
 */
export const SAMPLE_TRUST = 0.2;
export const FONT_TRUST = 0.08;

/** Joined-up word reader: the owner's own word samples, then script fonts over the vault's words. */
export class WordReader implements WholeWordReader {
	private readonly traces = new Map<string, Trace | null>();
	private readonly samples: { word: string; trace: Trace }[] = [];

	constructor(
		private readonly sources: GlyphSource[],
		private readonly fallback: GlyphSource,
		samples: Record<string, Point[][][]> = {},
	) {
		for (const [word, written] of Object.entries(samples)) {
			for (const strokes of written) {
				const trace = traceOf(strokes);
				if (trace !== null) this.samples.push({ word, trace });
			}
		}
	}

	private traceFor(word: string, source: number): Trace | null {
		const key = `${source}\u0000${word}`;
		let trace = this.traces.get(key);
		if (trace === undefined) {
			trace = traceOf(written(word, this.sources[source], this.fallback));
			this.traces.set(key, trace);
		}
		return trace;
	}

	/** Width of a word in a source, in cap heights, from advances alone. */
	private estimatedWidth(word: string, source: number): number {
		let width = 0;
		for (const ch of word) width += resolveGlyph(ch, this.sources[source], this.fallback).advance;
		return width;
	}

	/** The closest word: among the owner's samples first, then the vault's words in the fonts. */
	read(strokes: Point[][], lexicon: Lexicon | undefined): WordMatch | null {
		const trace = traceOf(strokes);
		if (trace === null) return null;
		let own: WordMatch | null = null;
		for (const sample of this.samples) {
			const ratio = sample.trace.width / trace.width;
			if (ratio < 0.6 || ratio > 1.7) continue;
			const cost = dtw(trace, sample.trace) + 0.2 * Math.abs(Math.log(ratio));
			if (own === null || cost < own.cost) own = { word: sample.word, cost, trusted: cost < SAMPLE_TRUST };
		}
		if (own?.trusted === true || lexicon === undefined || this.sources.length === 0) return own;
		const font = this.readFonts(trace, lexicon);
		if (own === null) return font;
		if (font === null) return own;
		return font.trusted && font.cost < own.cost ? font : own;
	}

	private readFonts(trace: Trace, lexicon: Lexicon): WordMatch | null {
		const shortlist: { word: string; source: number; score: number }[] = [];
		for (const [, form] of lexicon.words()) {
			if (!/^\p{L}+$/u.test(form)) continue;
			for (let source = 0; source < this.sources.length; source++) {
				// Advances only roughly predict a trace's width: a loose cut first.
				const estimate = this.estimatedWidth(form, source) / trace.width;
				if (estimate < 0.3 || estimate > 3.5) continue;
				const candidate = this.traceFor(form, source);
				if (candidate === null) continue;
				const ratio = candidate.width / trace.width;
				if (ratio < 0.6 || ratio > 1.7) continue;
				shortlist.push({
					word: form,
					source,
					score: profileDistance(trace.profile, candidate.profile) + 0.3 * Math.abs(Math.log(ratio)),
				});
			}
		}
		shortlist.sort((a, b) => a.score - b.score);
		let best: WordMatch | null = null;
		for (const { word, source } of shortlist.slice(0, 150)) {
			const candidate = this.traceFor(word, source)!;
			const cost = dtw(trace, candidate) + 0.2 * Math.abs(Math.log(candidate.width / trace.width));
			if (best === null || cost < best.cost) best = { word, cost, trusted: cost < FONT_TRUST };
		}
		return best;
	}
}
