import { describe, expect, it } from "vitest";
import { builtinFont, HandFont } from "../ink/glyphs";
import { parseBlocks } from "../convert/mdblocks";
import { DEVICE_PROFILES, INK_PENS, renderInk } from "../ink/inkrender";
import { highlightedText, insertRemarkText } from "../incoming/remarkinsert";
import type { Point } from "../ocr/recognize";

const callout = (id = "aaaaaaaaaaaa", text = "fix this") => ["> [!note] Remark ✓", `> ${text}`, "> ![[img/a.png]]", `> ^ink-${id}`];

const note = (...body: string[]) => [...body, "", ...callout(), "", "After."].join("\n");

describe("taking a remark into the note as text", () => {
	it("puts it into the table cell under the ink, and removes the callout", () => {
		const before = note("| Name | Value |", "| --- | --- |", "| alpha row | one |", "| beta row | two |");
		const out = insertRemarkText(before, "aaaaaaaaaaaa", "fix this", { quote: "alpha row one", column: 1 })!;
		expect(out).toBe(["| Name | Value |", "| --- | --- |", "| alpha row | one fix this |", "| beta row | two |", "", "After."].join("\n"));
	});

	it("fills an empty cell, breaks lines with <br> and escapes pipes", () => {
		const before = note("| A | B |", "| --- | --- |", "| alpha row |  |");
		const out = insertRemarkText(before, "aaaaaaaaaaaa", "x | y\nz", { quote: "alpha row", column: 1 })!;
		expect(out.split("\n")[2]).toBe("| alpha row | x \\| y<br>z |");
	});

	it("adds a line to the callout it was written in", () => {
		const before = note("> [!info] Box", "> inside callout text", "> second callout line");
		const out = insertRemarkText(before, "aaaaaaaaaaaa", "fix this", { quote: "inside callout text" })!;
		expect(out.split("\n").slice(0, 5)).toEqual(["> [!info] Box", "> inside callout text", "> fix this", "> second callout line", ""]);
	});

	it("adds a list item after the item it was written against", () => {
		const before = note("- item one here", "  more of one", "- item two here");
		const out = insertRemarkText(before, "aaaaaaaaaaaa", "fix this\nand that", { quote: "item one here" })!;
		expect(out.split("\n").slice(0, 6)).toEqual(["- item one here", "  more of one", "- fix this", "  and that", "- item two here", ""]);
	});

	it("continues a numbered list, and a task list with a plain item", () => {
		const numbered = insertRemarkText(note("1. first", "2. second"), "aaaaaaaaaaaa", "new", { quote: "first" })!;
		expect(numbered.split("\n").slice(0, 3)).toEqual(["1. first", "2. new", "2. second"]);
		const tasks = insertRemarkText(note("- [ ] task one"), "aaaaaaaaaaaa", "new", { quote: "task one" })!;
		expect(tasks.split("\n").slice(0, 2)).toEqual(["- [ ] task one", "- new"]);
	});

	it("goes after a code block, not into it", () => {
		const before = note("```", "code line one", "code line two", "```");
		const out = insertRemarkText(before, "aaaaaaaaaaaa", "fix this", { quote: "code line one" })!;
		expect(out).toBe(["```", "code line one", "code line two", "```", "", "fix this", "", "After."].join("\n"));
	});

	it("becomes a paragraph after the paragraph it follows", () => {
		const before = ["Some paragraph", "over two lines.", "", ...callout(), "", "After."].join("\n");
		const out = insertRemarkText(before, "aaaaaaaaaaaa", "fix this", { quote: "Some paragraph over two lines." })!;
		expect(out).toBe(["Some paragraph", "over two lines.", "", "fix this", "", "After."].join("\n"));
	});

	it("stays where the callout was when its line cannot be found", () => {
		const out = insertRemarkText(note("Text."), "aaaaaaaaaaaa", "fix this", { quote: "gone" })!;
		expect(out).toBe(["Text.", "", "fix this", "", "After."].join("\n"));
	});

	it("does nothing for a remark the note does not have", () => {
		expect(insertRemarkText(note("Text."), "bbbbbbbbbbbb", "x")).toBeNull();
	});
});

/** Words handwritten in a script font, as device strokes, with a gap between words. */
function written(text: string): { strokes: Point[][]; words: Point[][][] } {
	const face = new HandFont(builtinFont("allure"), builtinFont("allure"));
	const r = renderInk(parseBlocks(text), "t", {}, {
		profile: DEVICE_PROFILES.rm2,
		fonts: { body: face, bold: face, italic: face, mono: face },
		pen: INK_PENS.medium,
		jitter: 0.5,
		seed: "h",
	});
	const ws = r.layout.lines.filter((l) => l.role !== "title").flatMap((l) => l.words);
	const words = ws.map((word, index) =>
		r.pages[0].filter((s) => s.wordId === word.id).map((s) => s.points.map((p) => ({ x: p.x + index * 14, y: p.y }))),
	);
	return { strokes: words.flat(), words };
}

/** A highlighter swipe over the given ink words. */
function swipe(words: Point[][][], rgb: string) {
	const points = words.flat(2);
	const minX = Math.min(...points.map((p) => p.x));
	const maxX = Math.max(...points.map((p) => p.x));
	const y = (Math.min(...points.map((p) => p.y)) + Math.max(...points.map((p) => p.y))) / 2;
	return { rgb, strokes: [[{ x: minX, y }, { x: maxX, y }]] };
}

describe("highlighter over handwriting", () => {
	const ink = written("Termin morgen prüfen");

	it("comes back as the same <mark> an imported highlight gets, on the words it covers", () => {
		const out = highlightedText("Termin morgen prüfen", ink.strokes, [swipe([ink.words[1], ink.words[2]], "#ffed75")]);
		expect(out).toEqual({ text: 'Termin <mark style="background: #ffed75">morgen prüfen</mark>', placed: true });
	});

	it("keeps colours apart", () => {
		const out = highlightedText("Termin morgen prüfen", ink.strokes, [
			swipe([ink.words[0]], "#ffed75"),
			swipe([ink.words[2]], "#b2f2bb"),
		]);
		expect(out.text).toBe('<mark style="background: #ffed75">Termin</mark> morgen <mark style="background: #b2f2bb">prüfen</mark>');
	});

	it("marks the whole text when it is nearly all highlighted but the words do not line up", () => {
		const out = highlightedText("Termin ist morgen, bitte prüfen", ink.strokes, [swipe(ink.words, "#ffed75")]);
		expect(out).toEqual({ text: '<mark style="background: #ffed75">Termin ist morgen, bitte prüfen</mark>', placed: true });
	});

	it("leaves a partial highlight out, and says so, when the words do not line up", () => {
		const out = highlightedText("Termin ist morgen, bitte prüfen", ink.strokes, [swipe([ink.words[1]], "#ffed75")]);
		expect(out).toEqual({ text: "Termin ist morgen, bitte prüfen", placed: false });
	});

	it("is plain text without any highlighter", () => {
		expect(highlightedText("Termin morgen prüfen", ink.strokes, undefined)).toEqual({ text: "Termin morgen prüfen", placed: true });
	});
});
