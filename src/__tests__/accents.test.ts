import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { parseBlocks, stripInline, stripInlineStyles } from "../convert/mdblocks";
import { builtinFont, HandFont } from "../ink/glyphs";
import { drawingStrokes, InkDrawing } from "../ink/inkdrawing";
import { inkOptionsFor } from "../ink/inkfonts";
import { highlighterColorOf } from "../ink/inkimage";
import { ACCENT_COLORS, DEVICE_PROFILES, inkPagesToRm, renderInk, toInkLines } from "../ink/inkrender";
import { diffInkPage } from "../incoming/inkdiff";
import { parseRmScene } from "../incoming/rmscene";
import { PEN, PEN_COLOR } from "../ink/rmwrite";
import type { InkSnapshot } from "../id/mapping";

const SNAPSHOT: InkSnapshot = {
	pageIds: ["page-1"],
	font: "readability",
	fallbackFont: "readability",
	pen: "medium",
	color: 0,
	jitter: 0.5,
	profile: DEVICE_PROFILES.paperpro,
	shape: 1,
};
const LAYOUT = { fontSize: 11, lineHeight: 1.5, margin: 40 };

const NOTE = [
	"Run `npm test` before you push, then `git push`.",
	"",
	"- [ ] check `tsc --noEmit` output",
	"",
	"> A quote with `code` in it",
	"> over two lines.",
	"",
	"```",
	"const a = 1;",
	"const b = 2;",
	"```",
].join("\n");

function render(accents: boolean) {
	const options = inkOptionsFor(accents ? { ...SNAPSHOT, accents: true } : SNAPSHOT, "doc-1", () => null)!;
	return { options, render: renderInk(parseBlocks(NOTE), "Accents", LAYOUT, options) };
}

describe("inline code words", () => {
	it("flags the words of code spans without changing the text", () => {
		const raw = "Run `npm test` and **then** `x`.";
		const { text, inline } = stripInlineStyles(raw);
		expect(text).toBe(stripInline(raw));
		expect(text.split(" ")).toEqual(["Run", "npm", "test", "and", "then", "x."]);
		expect(inline.code).toEqual([1, 2, 5]);
		expect(inline.bold).toEqual([4]);
	});

	it("keeps blocks without inline code in their old shape", () => {
		expect(parseBlocks("plain words")).toEqual([{ type: "paragraph", text: "plain words" }]);
	});

	it("carries the flags through quotes, continuations and task items", () => {
		const blocks = parseBlocks(NOTE);
		const quote = blocks.find((b) => b.type === "quote");
		expect(quote).toMatchObject({ inline: { code: [3] } });
		const r = render(true).render;
		const coded = r.layout.lines.flatMap((l) => l.words).filter((w) => w.style?.code === true);
		expect(coded.map((w) => w.text)).toEqual(expect.arrayContaining(["npm", "test", "tsc", "--noEmit", "code"]));
		expect(coded.map((w) => w.text)).not.toContain("Run");
		expect(coded.map((w) => w.text)).not.toContain("check");
	});
});

describe("colour accents", () => {
	it("draws highlighter bands behind code, inline code and quotes", () => {
		const strokes = render(true).render.pages.flat();
		const bands = strokes.filter((s) => s.tool === PEN.highlighter);
		const colours = new Set(bands.map((s) => s.color));
		for (const kind of ["code", "inline-code", "quote"] as const) expect(colours.has(ACCENT_COLORS[kind])).toBe(true);
		for (const band of bands) {
			expect(band.wordId).toBeNull();
			expect(band.width).toBeGreaterThan(40);
		}
		const lines = toInkLines(bands, render(true).options.pen);
		lines.forEach((line, i) => {
			for (const point of line.points) expect(point.width).toBe(bands[i].width);
		});
	});

	it("writes the highlighter's light tints, not the pen palette's dark ones", () => {
		const { render: r, options } = render(true);
		const [page] = inkPagesToRm(r, options);
		const scene = parseRmScene(page);
		const bands = scene.lines.filter((line) => line.stroke.tool === PEN.highlighter);
		const tints = new Set(bands.map((line) => line.rgb));
		expect(tints).toEqual(new Set(["#beeafe", "#f29eff", "#ffed75"]));
		// The Paper Pro shows an exact colour only on its "highlight" entry.
		expect(bands.every((line) => line.stroke.color === PEN_COLOR.highlight)).toBe(true);
		// Pen strokes carry no colour of their own: they stay in the palette.
		expect(scene.lines.filter((line) => line.stroke.tool !== PEN.highlighter).every((line) => line.rgb === undefined)).toBe(true);
	});

	it("keeps palette colours on a reMarkable 1 or 2", () => {
		const options = inkOptionsFor({ ...SNAPSHOT, profile: DEVICE_PROFILES.rm2, accents: true }, "doc-1", () => null)!;
		const r = renderInk(parseBlocks(NOTE), "Accents", LAYOUT, options);
		const [page] = inkPagesToRm(r, options);
		const bands = parseRmScene(page).lines.filter((line) => line.stroke.tool === PEN.highlighter);
		expect(new Set(bands.map((line) => line.stroke.color))).toEqual(
			new Set([ACCENT_COLORS.code, ACCENT_COLORS["inline-code"], ACCENT_COLORS.quote]),
		);
	});

	it("recognises its own bands when the page comes back", () => {
		const { render: r, options } = render(true);
		const [page] = inkPagesToRm(r, options);
		const scene = parseRmScene(page);
		const diff = diffInkPage(r.pages[0], scene);
		expect(diff.trustworthy).toBe(true);
		expect(diff.userStrokes).toEqual([]);
		expect(diff.erasedWords).toEqual([]);
		expect(diff.stats.intact).toBe(r.pages[0].length);
	});

	it("leaves sends without the flag exactly as before", () => {
		const plain = render(false).render;
		expect(plain.pages.flat().some((s) => s.tool === PEN.highlighter)).toBe(false);
		const accented = render(true).render;
		// Same layout and the same text strokes; only the bands are added.
		expect(accented.layout).toEqual(plain.layout);
		const ink = (r: typeof plain) =>
			r.pages.map((page) => page.filter((s) => s.tool !== PEN.highlighter).map((s) => s.points));
		expect(ink(accented)).toEqual(ink(plain));
	});
});

describe("diagram fills", () => {
	const PIE = JSON.parse(
		readFileSync(join(__dirname, "fixtures", "mermaid-pie.json"), "utf8"),
	) as InkDrawing;
	const base = {
		font: new HandFont(builtinFont("readability"), builtinFont("readability")),
		color: PEN_COLOR.black,
		thickness: 1.5,
		jitter: 0.5,
		seed: "s",
		unit: 229 / 72,
		colour: true,
		box: { left: -300, top: 200, width: 600, height: 1200 },
	};

	it("maps fills to highlighter colours, pastels included", () => {
		expect(highlighterColorOf(255, 255, 255)).toBeNull();
		expect(highlighterColorOf(225, 245, 254)).toBe(PEN_COLOR.blue);
		expect(highlighterColorOf(255, 243, 168)).toBe(PEN_COLOR.yellow);
		expect(highlighterColorOf(255, 153, 255)).toBe(PEN_COLOR.pink);
		expect(highlighterColorOf(200, 200, 200)).toBe(PEN_COLOR.grey);
	});

	it("fills with the highlighter instead of hatching", () => {
		const strokes = drawingStrokes(PIE, { ...base, highlighter: true });
		const fills = strokes.filter((s) => s.tool === PEN.highlighter);
		expect(fills.length).toBeGreaterThan(0);
		expect(new Set(fills.map((s) => s.color)).size).toBeGreaterThan(2);
		const hatched = drawingStrokes(PIE, base);
		expect(hatched.some((s) => s.tool === PEN.highlighter)).toBe(false);
	});
});
