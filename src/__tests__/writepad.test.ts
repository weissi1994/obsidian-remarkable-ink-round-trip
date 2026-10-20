import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseBlocks } from "../convert/mdblocks";
import { builtinFont, HandFont } from "../ink/glyphs";
import { DEVICE_PROFILES, INK_PENS, renderInk } from "../ink/inkrender";
import { Lexicon, recognize, templatesFrom } from "../ocr/recognize";
import { cer } from "../ocr/testcapture";
import { choose, WritePad } from "../ocr/writepad";

/** A text "handwritten" in a bundled font, as device strokes. */
function write(text: string, font: string, jitter = 0.5) {
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

describe("WritePad", () => {
	let engine: WritePad;
	beforeAll(async () => {
		engine = await WritePad.load();
	});
	afterAll(() => engine.free());

	it("reads joined-up writing better than the letter reader", () => {
		const sentence = "Check this again tomorrow";
		const strokes = write(sentence, "allure");
		const letters = recognize(strokes, templatesFrom([{ glyphs: builtinFont("readability").glyphs, weight: 1 }]));
		const result = engine.read(strokes)!;
		expect(result.text.split(" ")[0]).toBe("Check");
		expect(cer(result.text, sentence)).toBeLessThan(cer(letters?.text ?? "", sentence));
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

	// WritePad's confidence does not rank reads by correctness: this junk read
	// scores 0.72 (above WRITEPAD_TRUST=0.7), so a threshold alone would accept
	// it. Only 3 of its 5 words are vault-known, so the quality gate rejects it.
	it("rejects a high-scoring read that is mostly junk words", () => {
		const strokes = write("the quick brown fox jumps", "allure", 0.5);
		const lexicon = Lexicon.fromText(["the quick brown fox jumps"]);
		// Reads as "the quick brown po,frjunql5" at confidence 0.72 on today's code.
		expect(engine.read(strokes, lexicon)).toBeNull();
	});

	// The mirror image: a read whose words the vault all knows must survive the
	// gate — otherwise it would be silently rejecting everything.
	it("keeps a read whose words the vault knows", () => {
		const sentence = "meeting is on Monday";
		const strokes = write(sentence, "allure", 0.5);
		const lexicon = Lexicon.fromText([sentence]);
		const result = engine.read(strokes, lexicon);
		expect(result).not.toBeNull();
		expect(cer(result!.text, sentence)).toBeLessThan(0.2);
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
