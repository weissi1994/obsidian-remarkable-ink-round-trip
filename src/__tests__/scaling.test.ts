/**
 * Read-time scaling guards (#13, Direction 2).
 *
 * The per-writer store is about to grow (more word samples; learned letter
 * templates). Two read-time hot paths used to scale *linearly with store size*:
 *
 *  - `WordReader.read` ran a full `dtw()` over every owner sample (words.ts),
 *  - `classify`'s quick pass ran `matchDistance` over every template
 *    (recognize.ts), and `segment` calls `classify` per letter window.
 *
 * Both are now bounded: the owner samples are shortlisted by the cheap profile
 * signal before DTW, and the template quick pass is a metric branch-and-bound
 * over a per-character-capped set. The key property these tests lean on is that
 * the bounded cost is *flat* in store size — so a deliberately oversized store
 * blows the budget on the old code but not the new, with wide hardware headroom.
 *
 * Methodology mirrors recognize.test.ts / words.test.ts: words are "written"
 * through a bundled font (a known hand) to make device strokes, and the
 * template store is scaled by duplicating the bundled templates (the scope note
 * sanctions synthetic `Template[]` built from duplicates).
 */

import { describe, expect, it } from "vitest";
import { parseBlocks } from "../convert/mdblocks";
import { builtinFont, HandFont } from "../ink/glyphs";
import { DEVICE_PROFILES, INK_PENS, renderInk } from "../ink/inkrender";
import { Lexicon, Point, recognize, Template, templatesFrom } from "../ocr/recognize";
import { WordReader } from "../ocr/words";

/** A sentence "handwritten" in a bundled font, as device strokes (one word per entry). */
function words(text: string, font: string, seed = text, jitter = 0.5) {
	const source = builtinFont(font);
	const face = new HandFont(source, source);
	const r = renderInk(parseBlocks(text), "t", {}, {
		profile: DEVICE_PROFILES.rm2,
		fonts: { body: face, bold: face, italic: face, mono: face },
		pen: INK_PENS.medium,
		jitter,
		seed,
	});
	return r.layout.lines
		.filter((line) => line.role !== "title")
		.flatMap((line) => line.words)
		.map((word) => ({ text: word.text, strokes: r.pages[0].filter((s) => s.wordId === word.id).map((s) => s.points) }));
}

/** All strokes of a sentence written in a font, flattened — for `recognize`. */
function write(text: string, font: string, seed = text, jitter = 0.5): Point[][] {
	return words(text, font, seed, jitter).flatMap((w) => w.strokes);
}

const templates = (...fonts: string[]) =>
	templatesFrom(fonts.map((id) => ({ glyphs: builtinFont(id).glyphs, weight: 1 })));

/** Duplicate a template set `factor` times — a synthetic large store (per the scope note). */
function inflate(base: Template[], factor: number): Template[] {
	const out: Template[] = [];
	for (let i = 0; i < factor; i++) out.push(...base.map((t) => ({ ...t })));
	return out;
}

/** Fastest of a few runs, after a warm-up — robust against GC/JIT noise. */
function fastest(run: () => void): number {
	run();
	let best = Infinity;
	for (let i = 0; i < 3; i++) {
		const t0 = performance.now();
		run();
		best = Math.min(best, performance.now() - t0);
	}
	return best;
}

const VOCAB = [
	"meeting", "monday", "please", "review", "draft", "team", "quick", "brown",
	"tomorrow", "project", "deadline", "summary", "approve", "schedule", "budget", "report",
];

/** `n` owner samples: VOCAB words rendered through a script font (each render a
 * distinct noisy instance keyed under its real word, as the store would hold them). */
function syntheticStore(n: number, font = "allure"): Record<string, Point[][][]> {
	const store: Record<string, Point[][][]> = {};
	for (let i = 0; i < n; i++) {
		const word = VOCAB[i % VOCAB.length];
		const ws = words(word, font, `${word}-${i}`)[0];
		(store[word] ??= []).push(ws.strokes);
	}
	return store;
}

describe("read-time scaling", () => {
	// Red gate 1 — WordReader.read must not scale with the owner store.
	// On the old code a 3000-sample store took ~80 ms/word (and ~180 ms on this
	// runner); the shortlist keeps it flat at a few ms. Budget 50 ms fails the
	// old code on any plausible machine and passes the new with wide headroom.
	it("reads a word in bounded time against a large owner store", () => {
		const store = syntheticStore(3000);
		const reader = new WordReader([builtinFont("allure")], builtinFont("readability"), store);
		const lexicon = Lexicon.fromText([VOCAB.join(" ")]);
		const probe = words("meeting", "allure", "held-out-probe")[0];
		const ms = fastest(() => reader.read(probe.strokes, lexicon));
		expect(ms, `WordReader.read over 3000 samples took ${ms.toFixed(1)} ms`).toBeLessThan(50);
	}, 60000);

	// Red gate 2 — recognize's quick pass must not scale with the template count.
	// The cost is bounded (cap + metric branch-and-bound), so an oversized store
	// is read in roughly the time of the bundled fonts. Old code: ~0.24 ms /
	// template / word, so ~2160 templates ≈ 600 ms. Budget 250 ms fails the old
	// code and passes the new (which stays ~100 ms regardless of store size).
	it("recognizes a word in bounded time against a large template store", () => {
		const base = templates("readability", "hershey-sans"); // 216
		const big = inflate(base, 10); // ~2160 templates
		const strokes = write("meeting", "readability");
		const ms = fastest(() => recognize(strokes, big));
		expect(ms, `recognize over ${big.length} templates took ${ms.toFixed(1)} ms`).toBeLessThan(250);
	}, 60000);

	// Accuracy guard 1 — shortlisting the owner samples must not drop the right
	// one. The correct word's sample is buried among thousands of distractors;
	// the profile shortlist must still surface it so a held-out instance reads
	// back correctly and trusted.
	it("still finds the owner's own word among a large store of distractors", () => {
		// 3000 samples across VOCAB; the target word ("review") is one of many,
		// buried among ~2800 distractors of other words.
		const store = syntheticStore(3000);
		const reader = new WordReader([builtinFont("allure")], builtinFont("readability"), store);
		const lexicon = Lexicon.fromText([VOCAB.join(" ")]);
		const probe = words("review", "allure", "held-out-review")[0];
		const match = reader.read(probe.strokes, lexicon);
		expect(match?.word).toBe("review");
		expect(match?.trusted).toBe(true);
	}, 60000);

	// Accuracy guard 2 — the template cap and branch-and-bound must not regress a
	// read that is correct today. A print sentence that reads exactly on the
	// bundled font (see recognize.test.ts) must still read exactly, and with the
	// identical confidence, when the template store is inflated 10×.
	it("reads print letters correctly despite a large template store", () => {
		const base = templates("readability");
		const sentence = "Größe und Länge stimmen nicht";
		const strokes = write(sentence, "readability");
		const plain = recognize(strokes, base)!;
		const inflated = recognize(strokes, inflate(base, 10))!;
		expect(plain.text).toBe(sentence); // sanity: correct today
		expect(inflated.text).toBe(plain.text); // unchanged under load
		expect(inflated.confidence).toBeCloseTo(plain.confidence, 10);
	}, 60000);
});
