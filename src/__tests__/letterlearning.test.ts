/**
 * Letter-level learning from corrections (issue #5, Direction 1).
 *
 * Exercises the real `learnCorrection` → `store.letters` → `lettersTemplates`
 * path on a synthetic *labelled* set (the repo's font-render methodology: a
 * font is a known "hand"). Two properties are asserted:
 *
 *  1. On a *separable* hand that differs from the generic templates, feeding
 *     TRAIN words as corrections lowers the held-out CER on words the owner
 *     never corrected — the generalisation today's word-level learning cannot
 *     give. Red gate: with no learned letters (baseline templates) the same
 *     held-out read is no better, so the assertion fails before the change.
 *  2. On *joined cursive* no letter shapes are learned at all (the separability
 *     gate in cutLetters) — cursive stays owned by WritePad / the local VLM.
 *
 * (The broader CER table across readers lives in the #5 spike harness; this is
 * the focused unit test the MR ships.)
 */
import { describe, expect, it } from "vitest";
import { parseBlocks } from "../convert/mdblocks";
import { builtinFont, HandFont, type HandFontStyle } from "../ink/glyphs";
import { DEVICE_PROFILES, INK_PENS, renderInk } from "../ink/inkrender";
import { Lexicon, lettersTemplates, type Point, recognize, splitWords, templatesFrom } from "../ocr/recognize";
import { emptyStore, learnCorrection, type RemarkRecord } from "../ocr/samples";

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
	const tokens = text.split(/\s+/).filter((w) => w !== "");
	const flat = splitWords(hand(text, font, style)).flat();
	if (flat.length !== tokens.length) return [];
	return flat.map((strokes, i) => ({ text: tokens[i], strokes }));
}

/** Character error rate: Levenshtein distance over the wanted length. */
function cer(got: string, want: string): number {
	const d = Array.from({ length: got.length + 1 }, (_, i) => [i, ...new Array<number>(want.length).fill(0)]);
	for (let j = 1; j <= want.length; j++) d[0][j] = j;
	for (let i = 1; i <= got.length; i++)
		for (let j = 1; j <= want.length; j++)
			d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (got[i - 1] === want[j - 1] ? 0 : 1));
	return d[got.length][want.length] / Math.max(1, want.length);
}

function meanCer(set: { text: string; strokes: Point[][] }[], read: (s: Point[][]) => string): number {
	let sum = 0;
	for (const { text, strokes } of set) sum += cer(read(strokes), text);
	return sum / Math.max(1, set.length);
}

/** A remark record carrying just the ink `learnCorrection` reads. */
function remark(strokes: Point[][]): RemarkRecord {
	return { strokes, transcript: "", at: "" };
}

// Corpus: the same train/held-out split the #5 spike measured. HELD_OUT words
// are never fed as corrections, so a gain there is pure letter-level transfer.
const TRAIN = [
	"und nicht die der das ist auch noch wenn aber schon heute morgen Termin",
	"the and that with this have from will what about which when could think",
];
const HELD_OUT = [
	"prüfen wichtig Frage danke bitte können müssen Woche später Idee",
	"check again meeting question today tomorrow because maybe should next",
];
const allText = [...TRAIN, ...HELD_OUT].join(" ");

describe("letter-level learning from corrections (#5 Direction 1)", () => {
	it("generalises to held-out words on a separable hand, where baseline does not", () => {
		const lexicon = Lexicon.fromText([allText]);
		// Generic templates that DIFFER from the owner's hand (as the bundled
		// print fonts differ from how the owner writes).
		const baseline = templatesFrom([{ glyphs: builtinFont("hershey-sans").glyphs, weight: 1 }]);
		const style: HandFontStyle = { slant: 0.25 };

		// Feed every TRAIN line as a correction through the real path.
		const store = emptyStore();
		for (const line of TRAIN) learnCorrection(store, remark(hand(line, "readability", style)), line);

		const learnedTemplates = [...baseline, ...lettersTemplates(store)];
		expect(lettersTemplates(store).length).toBeGreaterThan(0);

		const heldSet = HELD_OUT.flatMap((t) => wordInk(t, "readability", style));
		expect(heldSet.length).toBeGreaterThan(0);

		const readBaseline = (s: Point[][]) => recognize(s, baseline, lexicon)?.text ?? "";
		const readLearned = (s: Point[][]) => recognize(s, learnedTemplates, lexicon)?.text ?? "";

		const cerBaseline = meanCer(heldSet, readBaseline);
		const cerLearned = meanCer(heldSet, readLearned);
		// The generalisation claim: learned letters beat the generic templates on
		// words the owner never corrected. (Red gate: with `baseline` on both
		// sides this is an equality, so it fails before the change.)
		expect(cerLearned).toBeLessThan(cerBaseline);
	}, 60000);

	it("learns no letter shapes from joined-cursive ink", () => {
		const store = emptyStore();
		for (const line of TRAIN) learnCorrection(store, remark(hand(line, "allure")), line);
		// The whole-word path still runs; only letter shapes are gated off.
		expect(Object.keys(store.words ?? {}).length).toBeGreaterThan(0);
		expect(Object.keys(store.letters ?? {}).length).toBe(0);
	}, 60000);
});
