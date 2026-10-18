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
import type { Lexicon, Point } from "./recognize";

const N = 48;
const PROFILE_BINS = 8;

interface Trace {
	points: Point[];
	/** Width in x-heights. */
	width: number;
	profile: Float32Array;
}

function quantile(sorted: number[], q: number): number {
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)))];
}

/** Main strokes left to right as one polyline: dots and small marks left out. */
function mainLine(strokes: Point[][]): Point[] {
	const boxes = strokes.map((stroke) => {
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
		return { stroke, minX, size: Math.max(maxX - minX, maxY - minY) };
	});
	const largest = Math.max(...boxes.map((b) => b.size), 0);
	return boxes
		.filter((b) => b.size >= largest * 0.25)
		.sort((a, b) => a.minX - b.minX)
		.flatMap((b) => b.stroke);
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
 * A word's trace in its own x-height units (y down, baseline at 0): where
 * most of the ink sits gives the baseline and the middle line, whatever the
 * size of the writing.
 */
export function traceOf(strokes: Point[][]): Trace | null {
	const line = mainLine(strokes.filter((s) => s.length > 0));
	if (line.length < 2) return null;
	const sampled = resample(line, N);
	const ys = sampled.map((p) => p.y).sort((a, b) => a - b);
	const baseline = quantile(ys, 0.85);
	const middle = quantile(ys, 0.2);
	const xh = baseline - middle || 1;
	const minX = Math.min(...sampled.map((p) => p.x));
	const points = sampled.map((p) => ({ x: (p.x - minX) / xh, y: (p.y - baseline) / xh }));
	const width = Math.max(...points.map((p) => p.x)) || 1;
	const profile = new Float32Array(PROFILE_BINS * 2);
	for (let bin = 0; bin < PROFILE_BINS; bin++) {
		profile[bin * 2] = 0;
		profile[bin * 2 + 1] = -1;
	}
	for (const p of points) {
		const bin = Math.min(PROFILE_BINS - 1, Math.floor((p.x / width) * PROFILE_BINS));
		profile[bin * 2] = Math.max(profile[bin * 2], p.y);
		profile[bin * 2 + 1] = Math.min(profile[bin * 2 + 1], p.y);
	}
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
	/** The word as the vault usually spells it. */
	word: string;
	/** Mean trace distance in x-heights; lower is closer. */
	cost: number;
}

/** Joined-up word reader over a set of letter sources (script fonts, the owner's hand). */
export class WordReader {
	private readonly traces = new Map<string, Trace | null>();
	private readonly xHeights: number[];

	constructor(
		private readonly sources: GlyphSource[],
		private readonly fallback: GlyphSource,
	) {
		this.xHeights = sources.map((source) => {
			const x = resolveGlyph("x", source, fallback);
			const ys = x.strokes.flatMap((flat) => flat.filter((_, i) => i % 2 === 1));
			return ys.length === 0 ? 0.7 : Math.max(...ys) - Math.min(...ys) || 0.7;
		});
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

	/** Width of a word in a source, in x-heights, from advances alone. */
	private estimatedWidth(word: string, source: number): number {
		let width = 0;
		for (const ch of word) width += resolveGlyph(ch, this.sources[source], this.fallback).advance;
		return width / this.xHeights[source];
	}

	/** The vault word whose written trace is closest to `strokes`, if any. */
	read(strokes: Point[][], lexicon: Lexicon): WordMatch | null {
		const trace = traceOf(strokes);
		if (trace === null) return null;
		const shortlist: { word: string; source: number; score: number }[] = [];
		for (const [, form] of lexicon.words()) {
			if (!/^\p{L}+$/u.test(form)) continue;
			for (let source = 0; source < this.sources.length; source++) {
				// Advances only roughly predict a trace's width: a loose cut first.
				const estimate = this.estimatedWidth(form, source) / trace.width;
				if (estimate < 0.4 || estimate > 2.5) continue;
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
			if (best === null || cost < best.cost) best = { word, cost };
		}
		return best;
	}
}
