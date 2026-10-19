import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseBlocks } from "../convert/mdblocks";
import { builtinFont, HandFont } from "../ink/glyphs";
import { DEVICE_PROFILES, INK_PENS, renderInk } from "../ink/inkrender";
import { Lexicon, recognize, templatesFrom } from "../ocr/recognize";
import { choose, WritePad } from "../ocr/writepad";

/** A text "handwritten" in a bundled font, as device strokes. */
function write(text: string, font: string) {
	const source = builtinFont(font);
	const face = new HandFont(source, source);
	const fonts = { body: face, bold: face, italic: face, mono: face };
	const r = renderInk(parseBlocks(text), "t", {}, {
		profile: DEVICE_PROFILES.rm2,
		fonts,
		pen: INK_PENS.medium,
		jitter: 0.5,
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

describe("WritePad", () => {
	let engine: WritePad;
	beforeAll(async () => {
		engine = await WritePad.load();
	});
	afterAll(() => engine.free());

	it("reads joined-up writing better than the letter reader", () => {
		const sentence = "Check this again tomorrow";
		const strokes = write(sentence, "allure");
		const letters = recognize(strokes, templatesFrom([{ glyphs: builtinFont("readability").glyphs, weight: 1 }]))!;
		const result = engine.read(strokes)!;
		expect(result.text.split(" ")[0]).toBe("Check");
		expect(cer(result.text, sentence)).toBeLessThan(cer(letters.text, sentence));
	});

	it("learns the vault's words, Latin-1 only", () => {
		expect(engine.addWords(["Besprechung", "Größe", "x", "日本語"])).toBe(2);
	});

	it("keeps lines apart", () => {
		const result = engine.read(write("Check this\n\ntomorrow again", "allure"));
		expect(result?.text.split("\n")).toHaveLength(2);
	});

	it("has nothing to say about no strokes", () => {
		expect(engine.read([])).toBeNull();
	});
});

describe("choosing among WritePad's alternatives", () => {
	const lexicon = Lexicon.fromText(["Wir sehen uns am Montag zur Besprechung."]);

	it("prefers the vault's word when it scores close to the top", () => {
		const read = choose([[["Mantag", 70], ["Montag", 64]], [["is a", 80]]], lexicon);
		expect(read.text).toBe("Montag is a");
		expect(read.score).toBe(64 + 5 + 80);
	});

	it("keeps the engine's best when the vault's word is far behind", () => {
		expect(choose([[["Mantag", 90], ["Montag", 60]]], lexicon).text).toBe("Mantag");
	});
});
