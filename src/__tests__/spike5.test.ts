/**
 * SPIKE harness for issue #5 (reference artifact for the Direction-1 MR).
 *
 * Measures CER of the in-repo readers on a synthetic *labelled* set (the repo's
 * own methodology: render text through a font = a known "hand"), and prototypes
 * Direction 1 (letter-level learning from corrections) to measure whether it
 * generalises to held-out/unseen words where today's word-level learning cannot.
 *
 * Run:  npx vitest run src/__tests__/spike5.test.ts --reporter=verbose
 *
 * The implementation agent should REPLACE this with a focused held-out unit
 * test on the real learnCorrection→letter-template path (see the MR task).
 * `learnLetters()` below is a throwaway prototype, not the shipping design.
 */
import { describe, it } from "vitest";
import { parseBlocks } from "../convert/mdblocks";
import { builtinFont, HandFont, type HandFontStyle } from "../ink/glyphs";
import { DEVICE_PROFILES, INK_PENS, renderInk } from "../ink/inkrender";
import {
	cloudOf,
	Lexicon,
	type Point,
	recognize,
	splitLineInto,
	splitWords,
	type Template,
	templatesFrom,
} from "../ocr/recognize";
import { addSample, emptyStore } from "../ocr/samples";
import { WordReader } from "../ocr/words";
import { WritePad } from "../ocr/writepad";

/** Render a line of text in a given "hand" (font + optional style), as device strokes. */
function hand(text: string, font: string, style: HandFontStyle = {}, seed = text): Point[][] {
	const source = builtinFont(font);
	const face = new HandFont(source, source, style);
	const r = renderInk(parseBlocks(text), "t", {}, {
		profile: DEVICE_PROFILES.rm2,
		fonts: { body: face, bold: face, italic: face, mono: face },
		pen: INK_PENS.medium,
		jitter: 0.5,
		seed,
	});
	const words = r.layout.lines.filter((l) => l.role !== "title").flatMap((l) => l.words);
	// Nudge words apart so word-splitting is reliable (script fonts touch).
	return words.flatMap((word, i) =>
		r.pages[0].filter((s) => s.wordId === word.id).map((s) => s.points.map((p) => ({ x: p.x + i * 16, y: p.y }))),
	);
}

/** Per-word strokes paired with the word's text (single line inputs). */
function wordInk(text: string, font: string, style: HandFontStyle = {}): { text: string; strokes: Point[][] }[] {
	const lines = splitWords(hand(text, font, style));
	const tokens = text.split(/\s+/).filter((w) => w !== "");
	const flat = lines.flat();
	if (flat.length !== tokens.length) return [];
	return flat.map((strokes, i) => ({ text: tokens[i], strokes }));
}

function cer(got: string, want: string): number {
	const d = Array.from({ length: got.length + 1 }, (_, i) => [i, ...new Array<number>(want.length).fill(0)]);
	for (let j = 1; j <= want.length; j++) d[0][j] = j;
	for (let i = 1; i <= got.length; i++)
		for (let j = 1; j <= want.length; j++)
			d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (got[i - 1] === want[j - 1] ? 0 : 1));
	return d[got.length][want.length] / Math.max(1, want.length);
}

function box(strokes: Point[][]) {
	let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
	for (const p of strokes.flat()) {
		minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
		minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
	}
	return { minX, maxX, minY, maxY };
}

/**
 * DIRECTION-1 PROTOTYPE: derive per-letter $P templates from a corrected word
 * whose ink is separable. Cut the word ink into `text.length` letters at the
 * widest gaps (reusing splitLineInto, which clusters strokes then cuts at gaps),
 * and build a Template from each letter (shape cloud + baseline-relative metrics).
 * `weight` < 1 makes the owner's own letters preferred, as templatesFrom does.
 */
function learnLetters(wordStrokes: Point[][], text: string, weight = 0.95): Template[] {
	const chars = [...text];
	const letters = splitLineInto(wordStrokes, chars.length);
	if (letters === null || letters.length !== chars.length) return [];
	const b = box(wordStrokes);
	const baseline = b.maxY;            // device y-down: baseline ≈ bottom of the word body
	const cap = (b.maxY - b.minY) || 1; // word height as the cap unit
	const out: Template[] = [];
	for (let i = 0; i < chars.length; i++) {
		const strokes = letters[i];
		if (strokes.flat().length < 2) continue;
		const lb = box(strokes);
		out.push({
			ch: chars[i],
			cloud: cloudOf(strokes),
			top: (baseline - lb.minY) / cap,   // y up, baseline 0
			bottom: (baseline - lb.maxY) / cap,
			width: (lb.maxX - lb.minX) / cap,
			weight,
		});
	}
	return out;
}

/** Mean CER of a read function over a labelled set. */
function meanCer(set: { text: string; strokes: Point[][] }[], read: (s: Point[][]) => string): number {
	let sum = 0;
	for (const { text, strokes } of set) sum += cer(read(strokes), text);
	return sum / Math.max(1, set.length);
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

// ---- Corpus: the word sheet + a few remark-like phrases, split train/held-out ----
const TRAIN = [
	"und nicht die der das ist auch noch wenn aber schon heute morgen Termin",
	"the and that with this have from will what about which when could think",
];
const HELD_OUT = [
	"prüfen wichtig Frage danke bitte können müssen Woche später Idee",
	"check again meeting question today tomorrow because maybe should next",
];
const allText = [...TRAIN, ...HELD_OUT].join(" ");

describe("SPIKE #5 — CER measurement", () => {
	it("prints the CER table", async () => {
		// Vault vocabulary available to every reader (the Lexicon the real pipeline builds).
		const lexicon = Lexicon.fromText([allText]);
		const printTemplates = templatesFrom([
			{ glyphs: builtinFont("hershey-sans").glyphs, weight: 1 },
		]);

		// Two owner "hands" to probe two regimes:
		//  - PRINT-ish separable hand that DIFFERS from the template font (readability, slanted)
		//  - JOINED cursive hand (allure script) where letters run together
		const regimes: { name: string; font: string; style: HandFontStyle }[] = [
			{ name: "separable (readability, slant .25) vs hershey-sans templates", font: "readability", style: { slant: 0.25 } },
			{ name: "joined cursive (allure)", font: "allure", style: {} },
		];

		const writepad = await WritePad.load();
		writepad.addWords(allText.split(/\s+/));

		for (const regime of regimes) {
			console.log(`\n==== REGIME: ${regime.name} ====`);
			// Labelled sets
			const trainSet = TRAIN.flatMap((t) => wordInk(t, regime.font, regime.style));
			const heldSet = HELD_OUT.flatMap((t) => wordInk(t, regime.font, regime.style));
			console.log(`train words paired: ${trainSet.length}, held-out words paired: ${heldSet.length}`);
			if (heldSet.length === 0) { console.log("(word splitting failed for this hand — skip)"); continue; }

			// A. Baseline built-in letter reader (generic print templates + vault lexicon)
			const readBuiltin = (s: Point[][]) => recognize(s, printTemplates, lexicon)?.text ?? "";

			// B. Today's word-level learning: WordReader seeded from TRAIN-word samples.
			const store = emptyStore();
			for (const { text, strokes } of trainSet) addSample(store, text, [strokes.flat()]);
			const wr = new WordReader([builtinFont("allure"), builtinFont("hershey-script")], builtinFont("readability"), store.words);
			const readWord = (s: Point[][]) => recognize(s, printTemplates, lexicon, wr)?.text ?? "";

			// C. DIRECTION 1: letter templates learned from TRAIN corrections, added to generic set.
			const learned = trainSet.flatMap(({ text, strokes }) => learnLetters(strokes, text));
			const d1Templates = [...printTemplates, ...learned];
			console.log(`Direction-1 letter templates learned from train corrections: ${learned.length}`);
			const readD1 = (s: Point[][]) => recognize(s, d1Templates, lexicon)?.text ?? "";

			// CONTROL: add the SAME number of *generic* extra templates (wrong hand:
			// script fonts) at the same weight, to prove the D1 gain is from matching
			// the owner's shapes, not merely from having more templates.
			const extra = templatesFrom([
				{ glyphs: builtinFont("allure").glyphs, weight: 0.95 },
				{ glyphs: builtinFont("hershey-script").glyphs, weight: 0.95 },
			]);
			const ctrlTemplates = [...printTemplates, ...extra];
			const readCtrl = (s: Point[][]) => recognize(s, ctrlTemplates, lexicon)?.text ?? "";

			// D. WritePad cursive engine
			const readWp = (s: Point[][]) => writepad.read(s, lexicon)?.text ?? "";

			console.log("-- CER on TRAIN words (seen by learners) --");
			console.log(`  A built-in letter      : ${pct(meanCer(trainSet, readBuiltin))}`);
			console.log(`  B +word-level (today)  : ${pct(meanCer(trainSet, readWord))}`);
			console.log(`  C +letter-level (D1)   : ${pct(meanCer(trainSet, readD1))}`);
			console.log(`  D WritePad             : ${pct(meanCer(trainSet, readWp))}`);
			console.log("-- CER on HELD-OUT words (never corrected) — the generalisation test --");
			console.log(`  A built-in letter      : ${pct(meanCer(heldSet, readBuiltin))}`);
			console.log(`  B +word-level (today)  : ${pct(meanCer(heldSet, readWord))}`);
			console.log(`  C +letter-level (D1)   : ${pct(meanCer(heldSet, readD1))}`);
			console.log(`  C' control +extra generic templates: ${pct(meanCer(heldSet, readCtrl))}`);
			console.log(`  D WritePad             : ${pct(meanCer(heldSet, readWp))}`);
		}
		writepad.free();
	}, 120000);
});
