import { describe, expect, it } from "vitest";
import { parseBlocks } from "../convert/mdblocks";
import { builtinFont, HandFont } from "../ink/glyphs";
import { DEVICE_PROFILES, INK_PENS, renderInk } from "../ink/inkrender";
import { Lexicon, OCR_TRUST, recognize, templatesFrom } from "../ocr/recognize";

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

	it("tells joined-up writing it cannot read by a low confidence", () => {
		const result = recognize(write("Check this again tomorrow", "allure", 0.5), templates("readability", "hershey-sans"));
		expect(result!.confidence).toBeLessThan(OCR_TRUST);
	});

	it("keeps lines apart", () => {
		const one = write("first line", "readability", 0.3);
		const two = write("second", "readability", 0.3).map((stroke) => stroke.map((p) => ({ ...p, y: p.y + 120 })));
		expect(recognize([...one, ...two], templates("readability"))?.text).toBe("first line\nsecond");
	});

	it("returns nothing for no strokes", () => {
		expect(recognize([], templates("readability"))).toBeNull();
	});
});

describe("Lexicon", () => {
	it("keeps the most common spelling of a word", () => {
		const lexicon = Lexicon.fromText(["Montag montag Montag", "Größe"]);
		expect([...lexicon.ofLength(6)]).toEqual([["montag", "Montag"]]);
		expect([...lexicon.ofLength(5)]).toEqual([["größe", "Größe"]]);
	});
});
