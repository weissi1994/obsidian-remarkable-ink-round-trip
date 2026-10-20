import { describe, expect, it } from "vitest";
import { type Block, parseBlocks } from "../convert/mdblocks";
import { type DrawPage, type HighlightKind, type MeasureFont, type TypesetBackend, typesetBlocks } from "../convert/pdf";
import { builtinFont, HandFont } from "../ink/glyphs";

interface Rule {
	page: number;
	x1: number;
	y1: number;
	x2: number;
	y2: number;
	thickness: number;
}

interface Band {
	page: number;
	kind: HighlightKind;
	x: number;
	y: number;
	width: number;
	height: number;
}

const MARGIN = 40;

/** Typeset with handwriting metrics, recording the rules, bands and fonts of every call. */
function typeset(input: string | Block[], pageHeight?: number) {
	const f = builtinFont("readability");
	const face = new HandFont(f, f);
	// One wrapper per role, so a test can tell which font a line was set in.
	const font = (): MeasureFont => ({ widthOfTextAtSize: (text, size) => face.widthOfTextAtSize(text, size) });
	const fonts = { body: font(), bold: font(), italic: font(), mono: font() };
	const rules: Rule[] = [];
	const bands: Band[] = [];
	const texts: { page: number; text: string; font: keyof typeof fonts }[] = [];
	let page = 0;
	const backend: TypesetBackend = {
		...fonts,
		addPage(): DrawPage {
			const current = ++page;
			return {
				drawText: (text, o) => {
					const role = (Object.keys(fonts) as (keyof typeof fonts)[]).find((k) => fonts[k] === o.font)!;
					texts.push({ page: current, text, font: role });
				},
				drawRectangle: () => undefined,
				drawLine: (o) =>
					rules.push({ page: current, x1: o.start.x, y1: o.start.y, x2: o.end.x, y2: o.end.y, thickness: o.thickness ?? 1 }),
				drawHighlight: (o) => bands.push({ page: current, kind: o.kind, x: o.x, y: o.y, width: o.width, height: o.height }),
			};
		},
	};
	const blocks = typeof input === "string" ? parseBlocks(input, { html: true, quotePictures: true, nestedQuotes: true }) : input;
	const layout = typesetBlocks(blocks, "t", pageHeight === undefined ? {} : { pageHeight }, backend);
	return { layout, rules, bands, texts };
}

/** The quote bars: grey 1.5 pt verticals. */
const bars = (rules: Rule[]) => rules.filter((r) => r.thickness === 1.5 && Math.abs(r.x1 - r.x2) < 0.01);

const overlaps = (a: Band, b: Band) =>
	a.page === b.page && a.y < b.y + b.height - 0.01 && b.y < a.y + a.height - 0.01 && a.x < b.x + b.width && b.x < a.x + a.width;

describe("blocks inside a quote (#22)", () => {
	const TABLE = "> **Note**\n> | Col A | Col B |\n> | --- | --- |\n> | 1 | 2 |";

	it("sets a quoted table in by the bar, as a table", () => {
		const { layout } = typeset(TABLE);
		const cells = layout.lines.filter((l) => l.role === "table");
		expect(cells.map((l) => l.text)).toEqual(["Col A", "Col B", "1", "2"]);
		for (const cell of cells) expect(cell.x).toBeGreaterThanOrEqual(MARGIN + 14);
		// The divider row is not drawn, and no pipe is.
		expect(layout.lines.some((l) => l.text.includes("|") || l.text.includes("---"))).toBe(false);
	});

	it("puts the callout title on a line of its own, in bold", () => {
		const { layout, texts } = typeset("> **Note**\n> Intro text");
		expect(layout.lines.map((l) => l.text)).toEqual(["t", "Note", "Intro text"]);
		expect(texts.find((t) => t.text === "Note")?.font).toBe("bold");
		// A plain paragraph keeps the italic of a quote.
		expect(texts.find((t) => t.text === "Intro text")?.font).toBe("italic");
	});

	it("draws a box to tick for a task inside a quote", () => {
		const { layout } = typeset("> - [ ] task one\n> - item two");
		const task = layout.lines.find((l) => l.text === "task one")!;
		expect(task.role).toBe("list");
		expect(task.checkbox).toBeDefined();
		expect(task.checkbox!.x).toBeGreaterThanOrEqual(MARGIN + 14);
		expect(layout.lines.find((l) => l.text === "item two")?.checkbox).toBeUndefined();
	});

	it("keeps code as code, in its own band", () => {
		const { layout, bands, texts } = typeset("> ```\n> code()\n> ```");
		expect(layout.lines.find((l) => l.text === "code()")?.role).toBe("code");
		expect(texts.find((t) => t.text === "code()")?.font).toBe("mono");
		expect(bands.map((b) => b.kind)).toEqual(["code"]);
	});

	it("draws one bar along the whole quote, and the quote band only behind text", () => {
		const { rules, bands } = typeset(
			["> Intro text", "> | A | B |", "> |---|---|", "> | 1 | 2 |", "> ```", "> code()", "> ```", "> - item", "", "after"].join("\n"),
		);
		const quoteBars = bars(rules);
		expect(quoteBars).toHaveLength(1);
		expect(quoteBars[0].x1).toBeCloseTo(MARGIN + 3);
		const quote = bands.filter((b) => b.kind === "quote");
		expect(quote).toHaveLength(2); // the intro line and the list item
		for (const other of bands.filter((b) => b.kind === "code" || b.kind === "table-header")) {
			for (const band of quote) expect(overlaps(band, other)).toBe(false);
		}
	});

	it("gives a nested quote its own bar and band, further in", () => {
		const { rules, bands, layout } = typeset("> outer\n> > inner");
		const xs = bars(rules).map((r) => r.x1).sort((a, b) => a - b);
		expect(xs).toHaveLength(2);
		expect(xs[0]).toBeCloseTo(MARGIN + 3);
		expect(xs[1]).toBeCloseTo(MARGIN + 14 + 3);
		const quote = bands.filter((b) => b.kind === "quote");
		expect(quote).toHaveLength(2);
		expect(quote.filter((a) => quote.some((b) => a !== b && overlaps(a, b)))).toEqual([]);
		expect(layout.lines.find((l) => l.text === "inner")!.x).toBeCloseTo(MARGIN + 28);
	});

	it("breaks the bar with the page, and picks it up on the next", () => {
		const long = ["> | A | B |", "> |---|---|", ...Array.from({ length: 30 }, (_, i) => `> | row ${i} | value ${i} |`)].join("\n");
		const { rules } = typeset(long, 300);
		const quoteBars = bars(rules);
		const pages = [...new Set(quoteBars.map((r) => r.page))];
		expect(pages.length).toBeGreaterThan(1);
		// One segment per page; every one before the last reaches the foot.
		expect(pages).toHaveLength(quoteBars.length);
		for (const bar of quoteBars.slice(0, -1)) expect(Math.min(bar.y1, bar.y2)).toBeCloseTo(MARGIN);
		for (const bar of quoteBars.slice(1)) expect(Math.max(bar.y1, bar.y2)).toBeGreaterThan(300 - MARGIN - 5);
	});

	it("lays a one-paragraph quote out exactly as the flat quote", () => {
		const text = "a quote that is long enough to wrap over more than one line on the page, and then some more words";
		const flat = typeset([{ type: "quote", lines: [text] }, { type: "paragraph", text: "after" }]);
		const nested = typeset(`> ${text}\n\nafter`);
		const where = (r: typeof flat) => r.layout.lines.map((l) => [l.page, l.x, l.y, l.text]);
		expect(where(nested)).toEqual(where(flat));
		expect(nested.bands).toEqual(flat.bands);
	});

	it("draws nothing for a page break inside a quote", () => {
		const { layout } = typeset("> one\n> \\pagebreak\n> two");
		expect(layout.pageCount).toBe(1);
		expect(layout.lines.map((l) => l.text)).toEqual(["t", "one", "two"]);
	});
});

describe("layout outside quotes (inset 0)", () => {
	// A note with every kind of block. The fixture was written by the
	// typesetter as it was before quotes held blocks: anchored marks of sent
	// notebooks rely on every point of it.
	const NOTE = [
		"# Title",
		"Intro **bold** and `code` and ==mark== text that goes on long enough to wrap across a couple of lines.",
		"",
		"> a flat quote with *italic*, long enough to wrap over the edge of the page as well",
		"",
		"- one",
		"  - two",
		"- [ ] task",
		"- [x] done",
		"1. first",
		"",
		"```",
		"const x = 1;",
		"```",
		"",
		"| A | B | C |",
		"|---|---|---|",
		"| 1 | a much longer cell that wraps around | |",
		"| label | | |",
		"| | | |",
		"",
		"---",
		"",
		"## Sub",
		"",
		"**Doel**",
		"",
		...Array.from({ length: 30 }, (_, i) => `paragraph ${i} with some words to fill the page`),
	].join("\n");

	it("places every line where it always did", async () => {
		const blocks: Block[] = [
			...parseBlocks(NOTE, { html: true, quotePictures: true }),
			{ type: "inkimage", name: "p", width: 500, height: 200 },
			{ type: "image", w: 800, h: 300 },
		];
		const { layout, rules, bands } = typeset(blocks, 400);
		const placed = layout.lines.map((l) => ({ page: l.page, x: l.x, y: l.y, role: l.role, text: l.text, checkbox: l.checkbox }));
		await expect(JSON.stringify({ placed, rules, bands }, null, 1)).toMatchFileSnapshot("fixtures/layout-inset0.json");
	});
});
