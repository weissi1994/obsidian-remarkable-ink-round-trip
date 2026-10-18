import { describe, expect, it } from "vitest";
import { parseBlocks } from "../convert/mdblocks";
import { builtinFont, HandFont } from "../ink/glyphs";
import { DEVICE_PROFILES, INK_PENS, renderInk } from "../ink/inkrender";
import { Lexicon } from "../ocr/recognize";
import { WordReader } from "../ocr/words";

/** Each word of a sentence written joined-up in a script font, as device strokes. */
function words(text: string, font: string) {
	const source = builtinFont(font);
	const face = new HandFont(source, source);
	const r = renderInk(parseBlocks(text), "t", {}, {
		profile: DEVICE_PROFILES.rm2,
		fonts: { body: face, bold: face, italic: face, mono: face },
		pen: INK_PENS.medium,
		jitter: 0.5,
		seed: text,
	});
	return r.layout.lines
		.filter((line) => line.role !== "title")
		.flatMap((line) => line.words)
		.map((word) => ({ text: word.text, strokes: r.pages[0].filter((s) => s.wordId === word.id).map((s) => s.points) }));
}

describe("WordReader", () => {
	const sentence = "Bitte prüfen Besprechung tomorrow quick brown";
	const lexicon = Lexicon.fromText([
		sentence,
		"Die Woche ist voll, the meeting moved, bitten prüft Bestellung brownie quickly",
	]);

	it("reads joined-up words written in the style it knows", () => {
		const reader = new WordReader([builtinFont("allure")], builtinFont("readability"));
		const read = words(sentence, "allure").map((w) => reader.read(w.strokes, lexicon));
		expect(read.map((m) => m?.word)).toEqual(sentence.split(" "));
		expect(Math.max(...read.map((m) => m!.cost))).toBeLessThan(0.1);
	});

	it("returns nothing for an empty word", () => {
		const reader = new WordReader([builtinFont("allure")], builtinFont("readability"));
		expect(reader.read([], lexicon)).toBeNull();
	});
});
