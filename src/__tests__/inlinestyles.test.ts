import { describe, expect, it } from "vitest";
import { parseBlocks, stripInline, stripInlineStyles } from "../convert/mdblocks";
import { inkOptionsFor } from "../ink/inkfonts";
import { DEVICE_PROFILES, inkPagesToRm, renderInk } from "../ink/inkrender";
import { PEN, PEN_COLOR } from "../ink/rmwrite";
import type { InkSnapshot } from "../id/mapping";
import { diffInkPage } from "../incoming/inkdiff";
import { parseRmScene } from "../incoming/rmscene";

const SNAPSHOT: InkSnapshot = {
	pageIds: ["page-1"],
	font: "readability",
	fallbackFont: "readability",
	pen: "medium",
	color: 0,
	jitter: 0,
	profile: DEVICE_PROFILES.paperpro,
	shape: 1,
};
const NOTE = "Plain **bold** and *slanted* then ~~gone~~ and ==marked== with <u>under</u> plus <mark style=\"background: #a5d8ff\">blue</mark> end.";

function render(inline: boolean, markdown = NOTE) {
	const snapshot = inline ? { ...SNAPSHOT, inline: true as const } : SNAPSHOT;
	const options = inkOptionsFor(snapshot, "doc-1", () => null)!;
	return { options, render: renderInk(parseBlocks(markdown, { html: inline }), "Styles", {}, options) };
}

function wordStrokes(r: ReturnType<typeof render>["render"], text: string) {
	const word = r.layout.lines.flatMap((line) => line.words).find((w) => w.text === text)!;
	return r.pages[0].filter((s) => s.wordId === word.id);
}

describe("inline style parsing", () => {
	it("flags each styled word, the text staying exactly stripInline's", () => {
		const raw = "a **b c** *d* ~~e~~ ==f== `g`";
		const { text, inline } = stripInlineStyles(raw);
		expect(text).toBe(stripInline(raw));
		expect(inline).toEqual({
			bold: [1, 2],
			italic: [3],
			strike: [4],
			highlight: [{ word: 5 }],
			code: [6],
		});
	});

	it("reads inline HTML as styling when asked, colour included", () => {
		const { text, inline } = stripInlineStyles(
			'see <u>this</u> and <mark style="background: #ffc9de">that one</mark> <b>now</b>',
			{ html: true },
		);
		expect(text).toBe("see this and that one now");
		expect(inline.underline).toEqual([1]);
		expect(inline.highlight).toEqual([
			{ word: 3, rgb: "#ffc9de" },
			{ word: 4, rgb: "#ffc9de" },
		]);
		expect(inline.bold).toEqual([5]);
	});

	it("leaves inline HTML in the text for sends made before it was read", () => {
		expect(stripInlineStyles("see <u>this</u>").text).toBe("see <u>this</u>");
	});
});

describe("inline style rendering", () => {
	it("moves no word: the layout is the same with styling on or off", () => {
		const plain = renderInk(parseBlocks(NOTE, { html: true }), "Styles", {}, inkOptionsFor(SNAPSHOT, "doc-1", () => null)!);
		const styled = render(true).render;
		const boxes = (r: typeof plain) => r.layout.lines.flatMap((l) => l.words.map((w) => [w.text, w.x, w.width]));
		expect(boxes(styled)).toEqual(boxes(plain));
	});

	it("writes bold thicker and italic slanted", () => {
		const { render: r, options } = render(true);
		const plainScale = wordStrokes(r, "Plain")[0].thicknessScale;
		expect(wordStrokes(r, "bold")[0].thicknessScale).toBeGreaterThan(plainScale);
		expect(wordStrokes(r, "slanted")[0].thicknessScale).toBe(plainScale);
		const unstyled = render(false).render;
		expect(wordStrokes(r, "slanted").map((s) => s.points)).not.toEqual(
			wordStrokes(unstyled, "slanted").map((s) => s.points),
		);
		expect(options.inline).toBe(true);
	});

	it("draws strike-through and underline as pen lines, highlights with the highlighter", () => {
		const strokes = render(true).render.pages.flat();
		const lines = strokes.filter((s) => s.wordId === null && s.tool !== PEN.highlighter);
		expect(lines.length).toBe(2);
		const bands = strokes.filter((s) => s.tool === PEN.highlighter);
		expect(new Set(bands.map((s) => s.color))).toEqual(new Set([PEN_COLOR.yellow, PEN_COLOR.blue]));
	});

	it("draws nothing extra for a send made before inline styling", () => {
		const r = render(false).render;
		expect(r.pages.flat().some((s) => s.wordId === null)).toBe(false);
	});

	it("recognises its own strike, underline and highlight strokes on the way back", () => {
		const { render: r, options } = render(true);
		const [page] = inkPagesToRm(r, options);
		const diff = diffInkPage(r.pages[0], parseRmScene(page));
		expect(diff.userStrokes).toEqual([]);
		expect(diff.erasedWords).toEqual([]);
		expect(diff.trustworthy).toBe(true);
	});
});
