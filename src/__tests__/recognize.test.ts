import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { parseBlocks } from "../convert/mdblocks";
import { builtinFont, HandFont } from "../ink/glyphs";
import { DEVICE_PROFILES, INK_PENS, renderInk } from "../ink/inkrender";
import { TEST_SHEET_PROMPTS } from "../ink/handsheet";
import { builtinTrusted, Lexicon, OCR_TRUST, recognize, splitWords, templatesFrom } from "../ocr/recognize";
import { itemPoints, parseCapture, replayTemplates } from "../ocr/testcapture";
import { WordReader } from "../ocr/words";
import { CURSIVE_SAMPLES, PRINT_SAMPLES } from "./fixtures/handwriting";

/** A sentence "handwritten" in a bundled font, as device strokes. */
function write(text: string, font: string, jitter: number) {
	const source = builtinFont(font);
	const face = new HandFont(source, source);
	const fonts = { body: face, bold: face, italic: face, mono: face };
	const r = renderInk(parseBlocks(text), "t", {}, {
		profile: DEVICE_PROFILES.rm2,
		fonts,
		pen: INK_PENS.medium,
		jitter,
		seed: text,
	});
	const ids = new Set(r.layout.lines.filter((l) => l.role !== "title").flatMap((l) => l.words.map((w) => w.id)));
	return r.pages[0].filter((s) => s.wordId !== null && ids.has(s.wordId)).map((s) => s.points);
}

/** Character error rate: edit distance over the expected length. */
function cer(got: string, want: string): number {
	const d = Array.from({ length: got.length + 1 }, (_, i) => [i, ...new Array<number>(want.length).fill(0)]);
	for (let j = 1; j <= want.length; j++) d[0][j] = j;
	for (let i = 1; i <= got.length; i++) {
		for (let j = 1; j <= want.length; j++) {
			d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (got[i - 1] === want[j - 1] ? 0 : 1));
		}
	}
	return d[got.length][want.length] / Math.max(1, want.length);
}

const templates = (...fonts: string[]) =>
	templatesFrom(fonts.map((id) => ({ glyphs: builtinFont(id).glyphs, weight: 1 })));

describe("built-in handwriting recognition", () => {
	it("reads print letters in the hand it learned, German included", () => {
		const t = templates("readability");
		for (const sentence of ["Bitte noch einmal prüfen, danke!", "Größe und Länge stimmen nicht"]) {
			const result = recognize(write(sentence, "readability", 0.5), t);
			expect(result?.text).toBe(sentence);
			expect(result!.confidence).toBeGreaterThan(OCR_TRUST);
		}
	});

	it("corrects words against the vault's own vocabulary", () => {
		const sentence = "Die Besprechung ist am Montag";
		const strokes = write(sentence, "readability", 0.5);
		const t = templates("hershey-sans");
		const lexicon = Lexicon.fromText(["Besprechung am Montag, die Woche ist voll."]);
		const raw = recognize(strokes, t)!;
		const corrected = recognize(strokes, t, lexicon)!;
		expect(cer(corrected.text, sentence)).toBeLessThan(cer(raw.text, sentence));
		expect(corrected.text).toBe(sentence);
	});

	// Calibration against the whole labelled set: every print sample stays
	// trusted, and joined-up writing is declined rather than read as junk
	// (hershey-script "Check this again tomorrow" once leaked "C%% @w mm %mmm").
	it("reads print and declines joined-up writing across the labelled fixture set", () => {
		const t = templates("readability", "hershey-sans");
		for (const sample of PRINT_SAMPLES) {
			const result = recognize(write(sample.text, sample.font, sample.jitter), t)!;
			expect(result.confidence, `print "${sample.text}" (${sample.font})`).toBeGreaterThan(OCR_TRUST);
		}
		for (const sample of CURSIVE_SAMPLES) {
			const result = recognize(write(sample.text, sample.font, sample.jitter), t);
			expect(result, `cursive "${sample.text}" (${sample.font}) read "${result?.text}"`).toBeNull();
		}
	}, 20000); // renders + recognises the whole set — well over the 5s default

	// Red gate for the first real capture (test sheet 2026-10-21-001026): the
	// owner's joined cursive was tiled with symbol glyphs and these two readings
	// cleared OCR_TRUST, so WritePad was never asked. Confidence alone cannot
	// tell them from print; the share of symbols can.
	it("does not trust a reading that is mostly symbols, however confident", () => {
		expect(builtinTrusted({ text: "/IäI→✗rl…,%«%.Jl€", confidence: 0.79 })).toBe(false);
		expect(builtinTrusted({ text: "@:@+m«↑@&↑3]", confidence: 0.79 })).toBe(false);
		expect(builtinTrusted({ text: "", confidence: 0.99 })).toBe(false);
		expect(builtinTrusted(null)).toBe(false);
	});

	it("trusts every test-sheet prompt, symbols and numbers included", () => {
		for (const prompt of Object.values(TEST_SHEET_PROMPTS).flat()) {
			expect(builtinTrusted({ text: prompt, confidence: 0.9 }), prompt).toBe(true);
			expect(builtinTrusted({ text: prompt, confidence: OCR_TRUST - 0.01 }), prompt).toBe(false);
		}
	});

	it("keeps every print fixture trusted under the symbol gate", () => {
		const t = templates("readability", "hershey-sans");
		for (const sample of PRINT_SAMPLES) {
			const result = recognize(write(sample.text, sample.font, sample.jitter), t);
			expect(builtinTrusted(result), `print "${sample.text}" (${sample.font}) read "${result?.text}"`).toBe(true);
		}
	}, 20000);

	it("keeps lines apart", () => {
		const one = write("first line", "readability", 0.3);
		const two = write("second", "readability", 0.3).map((stroke) => stroke.map((p) => ({ ...p, y: p.y + 120 })));
		expect(recognize([...one, ...two], templates("readability"))?.text).toBe("first line\nsecond");
	});

	it("returns nothing for no strokes", () => {
		expect(recognize([], templates("readability"))).toBeNull();
	});
});

// The owner's fast joined-up hand, as filled in on a real test sheet.
describe("the owner's joined-up hand (test sheet 2026-10-21-004942)", () => {
	const capture = parseCapture(
		readFileSync(
			fileURLToPath(
				new URL(
					"../../handwriting-samples/test-sheets/2026-10-21-004942/handwriting-test-2026-10-21-004942.json",
					import.meta.url,
				),
			),
			"utf8",
		),
	);

	// Word cuts are what corrections teach whole words from (learnCorrection).
	it("cuts lines of plain words into their words", () => {
		const plain = capture.items.filter((item) => /^[\p{L} ]+$/u.test(item.prompt));
		expect(plain.length).toBeGreaterThan(5);
		for (const item of plain) {
			expect(splitWords(itemPoints(item)).flat(), item.prompt).toHaveLength(item.prompt.split(" ").length);
		}
	});

	it("trusts no reading of it, even with every right word in the vault", () => {
		const templates = replayTemplates(capture.hand);
		const lexicon = Lexicon.fromText(capture.items.map((item) => item.prompt));
		const words = new WordReader([builtinFont("allure"), builtinFont("hershey-script")], builtinFont("readability"));
		for (const item of capture.items) {
			const result = recognize(itemPoints(item), templates, lexicon, words);
			expect(builtinTrusted(result), `${item.prompt} read "${result?.text}"`).toBe(false);
		}
	}, 20000);
});

describe("Lexicon", () => {
	it("keeps the most common spelling of a word", () => {
		const lexicon = Lexicon.fromText(["Montag montag Montag", "Größe"]);
		expect([...lexicon.ofLength(6)]).toEqual([["montag", "Montag"]]);
		expect([...lexicon.ofLength(5)]).toEqual([["größe", "Größe"]]);
	});
});
