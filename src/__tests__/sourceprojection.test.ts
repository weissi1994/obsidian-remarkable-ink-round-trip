import { beforeAll, describe, expect, it } from "vitest";
import { parseBlocks } from "../convert/mdblocks";
import { PdfLayout, toWinAnsi } from "../convert/pdf";
import { renderPdf } from "./helpers/pdfrender";
import { preprocess } from "../preprocess/preprocess";
import { projectOntoSource } from "../incoming/sourceprojection";
import { deviceGridFor } from "../incoming/strokerender";
import type { ImportedMark } from "../incoming/pull";

/** A note with the formatting the first annotated copy used to lose. */
const SOURCE = [
	"**Data belooft zekerheid in een onzekere wereld.**",
	"",
	"## De beperkte blik",
	"",
	"Neem die groeiende ledencijfers. Ze vertellen niet waarom mensen lid worden – ",
	"of ze tevreden zijn.",
	"",
	"### Investeer in analyse bij:",
	"- **Grote financiële beslissingen** – waar je inschatting jaren doorwerkt",
	"- **Strategische koerswijzigingen** – die de hele organisatie raken",
	"",
	'*Reactie: "Precies. Daarom combineren we cijfers met gesprekken."*',
].join("\n");

let layout: PdfLayout;

beforeAll(async () => {
	const pre = preprocess(SOURCE, { resolveEmbed: () => ({ kind: "missing" }) });
	const rendered = await renderPdf(parseBlocks(pre.markdown), {
		title: "Artikel datagedreven organiseren",
		docId: "d",
	});
	layout = rendered.layout;
});

/** Ids of the layout words making up a phrase, as the typesetter placed them. */
function idsOf(phrase: string): number[] {
	const wanted = phrase.split(" ");
	const words = layout.lines.flatMap((line) => line.words);
	for (let at = 0; at + wanted.length <= words.length; at++) {
		const run = words.slice(at, at + wanted.length);
		if (run.every((word, i) => word.text === wanted[i])) return run.map((word) => word.id);
	}
	throw new Error(`phrase not laid out: ${phrase}`);
}

function blockOf(phrase: string): number {
	const line = layout.lines.find((candidate) => candidate.text.includes(phrase));
	if (line === undefined) throw new Error(`phrase not laid out: ${phrase}`);
	return line.block;
}

const project = (
	marks: ImportedMark[],
	highlights: Parameters<typeof projectOntoSource>[0]["highlights"] = [],
) => projectOntoSource({ source: SOURCE, layout, marks, highlights });

describe("projectOntoSource", () => {
	it("keeps the note exactly as it is when nothing was marked", () => {
		expect(project([])?.markdown).toBe(SOURCE.trimEnd());
	});

	it("keeps bold, italics, heading levels and en dashes", () => {
		const out = project([
			{ kind: "circle", page: 1, words: idsOf("groeiende ledencijfers.") },
		])?.markdown;
		expect(out).toContain("**Data belooft zekerheid in een onzekere wereld.**");
		expect(out).toContain("## De beperkte blik");
		expect(out).toContain("– waar je inschatting jaren doorwerkt");
		expect(out).toContain('*Reactie: "Precies.');
	});

	it("marks the words the pen covered, inside the surrounding markdown", () => {
		const out = project([
			{ kind: "strikethrough", page: 1, words: idsOf("of ze tevreden") },
		])?.markdown;
		expect(out).toContain("~~of ze tevreden~~ zijn.");
	});

	it("reaches words that sit inside bold markup", () => {
		// The layout word is "Grote"; the source has "**Grote financiële …**".
		const out = project([
			{ kind: "underline", page: 1, words: idsOf("Grote financiële") },
		])?.markdown;
		expect(out).toContain("<u>Grote financiële</u>");
		expect(out).toContain("**<u>Grote financiële</u> beslissingen**");
	});

	it("merges two marks of the same kind instead of doubling the markup", () => {
		// Beta 2026-07-27: overlapping strike-throughs produced `~~~~`, which
		// markdown reads as nothing at all.
		const out = project([
			{ kind: "strikethrough", page: 1, words: idsOf("Ze vertellen niet") },
			{ kind: "strikethrough", page: 1, words: idsOf("niet waarom mensen") },
		])?.markdown;
		expect(out).not.toContain("~~~~");
		expect(out).toContain("~~Ze vertellen niet waarom mensen~~");
	});

	it("gives a highlight its colour", () => {
		const out = project(
			[],
			[{ text: "Ze vertellen niet waarom mensen", color: 1, page: 1 }],
		)?.markdown;
		expect(out).toContain(
			'<mark style="background: #a5d8ff">Ze vertellen niet waarom mensen</mark>',
		);
	});

	it("uses the exact colour the device sent, not a palette approximation", () => {
		// The device sends real RGB (GP_E3_S16), so the vault can show the same
		// shade the tablet did instead of the nearest name.
		const out = project(
			[],
			[{ text: "Ze vertellen niet waarom mensen", color: 9, rgb: "#beeafe", page: 1 }],
		)?.markdown;
		expect(out).toContain(
			'<mark style="background: #beeafe">Ze vertellen niet waarom mensen</mark>',
		);
	});

	it("marks a quoted phrase inside its quotes, so the delimiters render", () => {
		// Beta 2026-07-28: striking through '"Laten we de cijfers maar eens
		// bekijken."' produced ~~"Laten …"~~, and Obsidian left the tildes in
		// the text — a markdown delimiter that opens against a quote instead of
		// a word does not parse. Marking inside the quotes says the same thing.
		const out = project([
			{ kind: "strikethrough", page: 1, words: idsOf('"Precies. Daarom combineren') },
		])?.markdown;
		expect(out).toContain('"~~Precies. Daarom combineren~~');
		expect(out).not.toContain('~~"Precies');
	});

	it("switches a nested mark to HTML, because markdown does not parse inside a tag", () => {
		// Beta 2026-07-28: <u>"~~Laten we …~~."</u> showed the tildes as text.
		// The quotes were not the problem — the surrounding <u> was.
		const out = project([
			{ kind: "underline", page: 1, words: idsOf("Ze vertellen niet waarom mensen") },
			{ kind: "strikethrough", page: 1, words: idsOf("vertellen niet") },
		])?.markdown;
		expect(out).toContain("<u>Ze <s>vertellen niet</s> waarom mensen</u>");
		expect(out).not.toContain("~~");
	});

	it("follows the configured meaning of a mark", () => {
		// The shapes are fixed; what they mean is the user's convention
		// (owner question, 2026-07-28).
		const out = projectOntoSource({
			source: SOURCE,
			layout,
			marks: [{ kind: "circle", page: 1, words: idsOf("groeiende ledencijfers.") }],
			highlights: [],
			styles: { strikethrough: "strikethrough", circle: "highlight", underline: "italic" },
		})?.markdown;
		expect(out).toContain("==groeiende ledencijfers==.");
		expect(out).not.toContain("**groeiende");
	});

	it("writes no markup at all for a mark set to leave the text alone", () => {
		const out = projectOntoSource({
			source: SOURCE,
			layout,
			marks: [{ kind: "circle", page: 1, words: idsOf("groeiende ledencijfers.") }],
			highlights: [],
			styles: { strikethrough: "strikethrough", circle: "none", underline: "underline" },
		})?.markdown;
		expect(out).toBe(SOURCE.trimEnd());
	});

	it("skips a mark that covers nothing but punctuation", () => {
		// There is no sensible markdown for striking a lone quote mark, and
		// ~~"~~ would only leave litter in the text.
		const out = project([{ kind: "strikethrough", page: 1, words: idsOf("\u2013") }])?.markdown;
		expect(out).not.toContain("~~");
	});

	it("nests a strike that runs into a highlight instead of crossing it", () => {
		// Beta 2026-07-28: the vault showed "maken en~~ investeren in" — the
		// strike closed inside the highlight, so markdown left the ~~ as text.
		const out = project(
			[{ kind: "strikethrough", page: 1, words: idsOf("Neem die groeiende ledencijfers.") }],
			[{ text: "ledencijfers. Ze vertellen niet", rgb: "#f29eff", page: 1 }],
		)?.markdown;
		// Outside the highlight plain markdown; inside it HTML, because markdown
		// is not parsed within an inline HTML tag.
		expect(out).toContain("~~Neem die groeiende~~ ");
		expect(out).toContain('<mark style="background: #f29eff"><s>ledencijfers.</s>');
		const [before, inside] = (out ?? "").split('<mark style="background: #f29eff">');
		expect((before.match(/~~/g) ?? []).length % 2).toBe(0);
		expect(inside.split("</mark>")[0]).not.toContain("~~");
	});

	it("quotes the lines a margin bar ran alongside", () => {
		const out = project([
			{ kind: "margin", page: 1, blocks: [blockOf("Neem die groeiende")] },
		])?.markdown;
		expect(out).toContain("> Neem die groeiende ledencijfers.");
	});

	it("puts a remark under the line it was written against", () => {
		const out = project([
			{
				kind: "note",
				page: 1,
				quote: "Neem die groeiende ledencijfers. Ze vertellen niet waarom mensen lid",
				path: "img/dev-p01-1.png",
				id: "3f9a2c1b0d4e",
			},
		])?.markdown;
		const lines = out?.split("\n") ?? [];
		// The remark's id ends the callout, so it is found again next import.
		expect(lines[lines.indexOf("> ![[img/dev-p01-1.png]]") + 1]).toBe("> ^ink-3f9a2c1b0d4e");
		const text = lines.findIndex((line) => line.includes("Neem die groeiende"));
		const remark = lines.findIndex((line) => line.includes("[!note] Remark"));
		expect(remark).toBeGreaterThan(text);
		expect(out).toContain("> ![[img/dev-p01-1.png]]");
	});

	it("places a page added on the device after the text it follows", () => {
		// GP_E3_S20: it is a sheet of notes, not a remark in the margin, and it
		// says so — a page of thinking must not read as a scribble.
		const out = project([
			{
				kind: "note",
				page: 1,
				addedPage: 3,
				quote: "of ze tevreden zijn.",
				path: "img/dev-p03-1.png",
			},
		])?.markdown;
		expect(out).toContain("[!note] Page added on the reMarkable (page 3)");
		expect(out).toContain("> ![[img/dev-p03-1.png]]");
		const lines = out?.split("\n") ?? [];
		expect(lines.findIndex((line) => line.includes("Page added"))).toBeGreaterThan(
			lines.findIndex((line) => line.includes("of ze tevreden")),
		);
	});

	it("keeps a highlight it cannot find, rather than dropping it", () => {
		const result = project([], [{ text: "staat niet in deze notitie", page: 1 }]);
		expect(result?.unplaced).toHaveLength(1);
		expect(result?.markdown).toContain("could not be placed");
	});

	it("is not thrown off by the title the plugin puts on the document", async () => {
		// Beta 2026-07-27: the typeset document opens with a title the note
		// itself does not carry. Its words ("blik", "analyse") occur further
		// down the note, so a title word matched there and dragged the cursor
		// past everything above it — after which nothing lined up and the
		// projection refused, silently falling back to the old summary.
		const pre = preprocess(SOURCE, { resolveEmbed: () => ({ kind: "missing" }) });
		const titled = await renderPdf(parseBlocks(pre.markdown), {
			title: "Analyse van de beperkte blik",
			docId: "d",
		});

		const result = projectOntoSource({
			source: SOURCE,
			layout: titled.layout,
			marks: [],
			highlights: [],
		});
		expect(result).not.toBeNull();
		expect(result?.markdown).toBe(SOURCE.trimEnd());
	});

	it("refuses to project onto a note that is not the same document", () => {
		expect(
			projectOntoSource({
				source: "Een heel andere tekst zonder enige overlap qua woorden.",
				layout,
				marks: [],
				highlights: [],
			}),
		).toBeNull();
	});
});

describe("projectOntoSource inside a quote that holds blocks (#22)", () => {
	const QUOTED = [
		"Before the callout.",
		"",
		"> [!note] Plan",
		"> Read this first.",
		"> | Day | Task |",
		"> | --- | --- |",
		"> | Monday | Review notes |",
		"> - [ ] call back",
		"",
		"After the callout.",
	].join("\n");

	it("marks the words of a quoted table cell where they are in the note", async () => {
		const pre = preprocess(QUOTED, { resolveEmbed: () => ({ kind: "missing" }) });
		const quoted = (await renderPdf(parseBlocks(pre.markdown, { html: true, quotePictures: true, nestedQuotes: true }), { title: "t", docId: "d" })).layout;
		const words = quoted.lines.flatMap((line) => line.words);
		const id = (text: string) => words.find((word) => word.text === text)!.id;
		const out = projectOntoSource({
			source: QUOTED,
			layout: quoted,
			marks: [
				{ kind: "strikethrough", page: 1, words: [id("Review")] },
				{ kind: "circle", page: 1, words: [id("back")] },
			],
			highlights: [],
		})?.markdown;
		expect(out).toContain("> | Monday | ~~Review~~ notes |");
		expect(out).toContain("> - [ ] call **back**");
		expect(out).toContain("> | --- | --- |");
	});
});

/** A hand-made layout: one laid-out line per row, 30 points apart down each page. */
function layoutOf(rows: { text: string; block: number; page?: number }[]): PdfLayout {
	let id = 0;
	const onPage = new Map<number, number>();
	const lines = rows.map((row) => {
		const page = row.page ?? 1;
		const index = onPage.get(page) ?? 0;
		onPage.set(page, index + 1);
		const words = row.text.split(" ").map((text, k) => ({ id: id++, text, x: 40 + k * 40, width: 35 }));
		return { page, x: 40, y: 550 - index * 30, size: 11, text: row.text, block: row.block, role: "paragraph" as const, words };
	});
	return { pageWidth: 447, pageHeight: 596, pageCount: Math.max(...lines.map((line) => line.page)), lines };
}

/** A remark's ink spanning PDF y from `top` down to `bottom` (points, y upwards), in device units. */
function inkBetween(layout: PdfLayout, top: number, bottom: number) {
	const grid = deviceGridFor(layout);
	const down = (y: number) => ((layout.pageHeight - y) * grid.height) / layout.pageHeight;
	return [[{ x: 0, y: down(top) }, { x: 60, y: down(bottom) }]];
}

const remark = (extra: Partial<ImportedMark>): ImportedMark => ({ kind: "note", page: 1, transcript: "my remark", id: "aaaaaaaaaaaa", ...extra });

describe("projectOntoSource lines words up exactly", () => {
	it("does not take a word for the start of a longer one", () => {
		// The layout has a word the note does not ("theory" was dropped); the
		// next word must not then be found inside it.
		const layout = layoutOf([{ text: "In the plan works and the rest follows.", block: 0 }]);
		const out = projectOntoSource({
			source: "In theory the plan works and the rest follows.",
			layout,
			marks: [{ kind: "strikethrough", page: 1, words: [layout.lines[0].words[1].id] }],
			highlights: [],
		})?.markdown;
		expect(out).toBe("In theory ~~the~~ plan works and the rest follows.");
	});

	it("finds a word the typesetter broke across lines, part by part", async () => {
		// A word wider than the line is hard-broken (pdf.ts breakLongWord): its
		// parts are separate laid-out words, each starting or ending mid-word.
		const url = `https://example.com/${"abcdefghij".repeat(12)}`;
		const source = `Read ${url} today, then the rest.`;
		const typeset = (await renderPdf(parseBlocks(source), { title: "t", docId: "d" })).layout;
		const words = typeset.lines.flatMap((line) => line.words);
		const parts = words.slice(words.findIndex((word) => word.text === "Read") + 1, words.findIndex((word) => word.text === "today,"));
		expect(parts.length).toBeGreaterThan(1);
		expect(parts.map((word) => word.text).join("")).toBe(url);
		const erased = projectOntoSource({
			source,
			layout: typeset,
			marks: [{ kind: "erased", page: 1, words: parts.map((word) => word.id) }],
			highlights: [],
		})!;
		expect(erased.markdown).toBe("Read today, then the rest.");
		expect(erased.unapplied).toEqual([]);
		const after = words.find((word) => word.text === "today,")!;
		const struck = projectOntoSource({ source, layout: typeset, marks: [{ kind: "strikethrough", page: 1, words: [after.id] }], highlights: [] });
		expect(struck?.markdown).toBe(`Read ${url} ~~today~~, then the rest.`);
	});

	it("lines up a compound broken in a narrow column, and text written without spaces", () => {
		const layout = layoutOf([
			{ text: "Die Donaudampf", block: 0 },
			{ text: "schifffahrt fährt heute.", block: 0 },
			{ text: "日本語の", block: 1 },
			{ text: "テキスト です", block: 1 },
		]);
		// The typesetter writes what WinAnsi lacks as "?".
		for (const line of layout.lines) for (const word of line.words) word.text = toWinAnsi(word.text);
		const ids = (line: number) => layout.lines[line].words.map((word) => word.id);
		const result = projectOntoSource({
			source: "Die Donaudampfschifffahrt fährt heute.\n\n日本語のテキスト です",
			layout,
			marks: [
				{ kind: "strikethrough", page: 1, words: [ids(0)[1], ids(1)[0]] },
				{ kind: "erased", page: 1, words: [ids(2)[0], ids(3)[0]] },
			],
			highlights: [],
		})!;
		expect(result.markdown).toBe("Die ~~Donaudampfschifffahrt~~ fährt heute.\n\nです");
		expect(result.unapplied).toEqual([]);
	});

	it("finds its place again after text the page does not show, like a long link", () => {
		const source = [
			"Intro words here for the sync point.",
			"",
			`See [the guide](https://example.com/${"x".repeat(240)}) for details about the plan and more.`,
			"",
			"Closing words of the note.",
		].join("\n");
		const layout = layoutOf([
			{ text: "Intro words here for the sync point.", block: 0 },
			{ text: "See the guide for details about the plan and more.", block: 1 },
			{ text: "Closing words of the note.", block: 2 },
		]);
		const ids = layout.lines[1].words.filter((word) => word.text === "details" || word.text === "about").map((word) => word.id);
		const result = projectOntoSource({ source, layout, marks: [{ kind: "strikethrough", page: 1, words: ids }], highlights: [] });
		expect(result?.markdown).toContain(") for ~~details about~~ the plan");
		expect(result?.unapplied).toEqual([]);
	});

	it("highlights the occurrence of a repeated phrase the highlighter went over", () => {
		const layout = layoutOf([
			{ text: "Remember to call Anna today.", block: 0 },
			{ text: "And later call Anna today.", block: 1 },
		]);
		const second = layout.lines[1].words.slice(2).map((word) => word.id);
		const out = projectOntoSource({
			source: "Remember to call Anna today.\n\nAnd later call Anna today.",
			layout,
			marks: [],
			highlights: [{ text: "call Anna today.", page: 1, rgb: "#ffed75", words: second }],
		})?.markdown;
		expect(out).toBe('Remember to call Anna today.\n\nAnd later <mark style="background: #ffed75">call Anna today.</mark>');
	});

	const REPEATED = ["Check the numbers.", "Something in between here.", "Check the numbers.", "The end of the note."];
	const repeated = layoutOf(REPEATED.map((text, block) => ({ text, block })));
	const project = (marks: ImportedMark[], layout = repeated, source = REPEATED.join("\n\n")) =>
		projectOntoSource({ source, layout, marks, highlights: [] })!.markdown.split("\n");

	it("puts a remark under the occurrence of its line it was written beside", () => {
		// Row 3 sits at y 490: the ink is just under it.
		const lines = project([remark({ quote: "Check the numbers.", strokes: inkBetween(repeated, 485, 470) })]);
		const callout = lines.indexOf("> [!note] Remark");
		expect(callout).toBeGreaterThan(lines.indexOf("Something in between here."));
		expect(callout).toBeLessThan(lines.indexOf("The end of the note."));
		expect(lines.slice(callout - 2, callout)).toEqual(["Check the numbers.", ""]);
	});

	it("puts a free remark after the nearest text above it on its page, not at the end of the note", () => {
		// Between row 2 (y 520) and row 3 (y 490), with no row close enough to quote.
		const lines = project([remark({ strokes: inkBetween(repeated, 512, 500) })]);
		expect(lines.indexOf("> [!note] Remark")).toBe(lines.indexOf("Something in between here.") + 2);
		// Above all the text: before it.
		expect(project([remark({ strokes: inkBetween(repeated, 590, 580) })])[0]).toBe("> [!note] Remark");
	});

	it("puts a free remark without ink after the last text of its page", () => {
		const twoPages = layoutOf([
			{ text: "Page one starts here.", block: 0 },
			{ text: "Page one ends here.", block: 1 },
			{ text: "Page two has more words.", block: 2, page: 2 },
		]);
		const lines = project([remark({})], twoPages, "Page one starts here.\n\nPage one ends here.\n\nPage two has more words.");
		expect(lines.indexOf("> [!note] Remark")).toBe(lines.indexOf("Page one ends here.") + 2);
	});

	it("says which marks it could not apply, and why", () => {
		const layout = layoutOf([{ text: "The quick brown fox jumps over the lazy dog.", block: 0 }]);
		const id = (text: string) => layout.lines[0].words.find((word) => word.text === text)!.id;
		const result = projectOntoSource({
			source: "The quick brown fox jumps over the lazy dog.",
			layout,
			marks: [
				{ kind: "moved", page: 1, words: [id("brown")], target: "brown" },
				{ kind: "erased", page: 1, words: [999], target: "ghost" },
				{ kind: "strikethrough", page: 1, words: [998], target: "phantom" },
				{ kind: "margin", page: 1, blocks: [7], quote: "elsewhere" },
			],
			highlights: [],
		})!;
		expect(result.markdown).toBe("The quick brown fox jumps over the lazy dog.");
		expect(result.unapplied).toEqual([
			{ page: 1, text: "“ghost” erased — not found in the note" },
			{ page: 1, text: "“brown” moved — not next to any word, so its new place in the text is unclear" },
			{ page: 1, text: "“phantom” struck through — not found in the note" },
			{ page: 1, text: "marked in the margin beside “elsewhere” — not found in the note" },
		]);
	});

	/** The ids of the typeset words with this text, in order. */
	const idsIn = (layout: PdfLayout, text: string) => layout.lines.flatMap((line) => line.words).filter((word) => word.text === text).map((word) => word.id);

	it("moves past the rest of a code line cut at the page edge", async () => {
		const options = Array.from({ length: 12 }, (_, i) => `--option-${i} value.with.dots.${i}`).join(" ");
		const source = ["Intro words here for the sync point.", "", "```bash", `run the tool ${options}`, "```", "", "Closing words."].join("\n");
		const layout = (await renderPdf(parseBlocks(source), { title: "t", docId: "d" })).layout;
		const code = layout.lines.find((line) => line.role === "code")!;
		expect(code.text.length).toBeLessThan(`run the tool ${options}`.length - 200);
		const result = projectOntoSource({ source, layout, marks: [{ kind: "strikethrough", page: 1, words: idsIn(layout, "Closing") }], highlights: [] })!;
		expect(result.markdown).toBe(source.replace("Closing", "~~Closing~~"));
		expect(result.unapplied).toEqual([]);
	});

	it("lines up a run of links, whose targets the page does not show", async () => {
		const link = (n: number) => `[https://example.com/${n}](https://example.com/${"x".repeat(60)}/${n})`;
		const source = ["Intro words here for the sync point.", "", ...[1, 2, 3, 4, 5, 6].flatMap((n) => [link(n), ""]), "Closing words of the note."].join("\n");
		const layout = (await renderPdf(parseBlocks(source), { title: "t", docId: "d" })).layout;
		const result = projectOntoSource({ source, layout, marks: [{ kind: "strikethrough", page: 1, words: idsIn(layout, "https://example.com/3") }], highlights: [] })!;
		expect(result.markdown).toBe(source.replace("[https://example.com/3]", "[~~https://example.com/3~~]"));
		expect(result.unapplied).toEqual([]);
	});

	it("does not take the title for the note's first heading when the page shows both", async () => {
		const filler = "Filler sentence that keeps the later words far from the start. ".repeat(8).trim();
		const body = ["# Weekly Review Notes", "", "Some opening words of the review.", "", "The quick brown fox jumps over the lazy dog.", "", filler, "", "Later on: the plan for next week is set."].join("\n");
		const pre = preprocess(`---\nsummary: the plan for next week\n---\n${body}`, { resolveEmbed: () => ({ kind: "missing" }), frontmatterAsTitleBlock: true });
		const layout = (await renderPdf(parseBlocks(pre.markdown), { title: "Weekly Review Notes", docId: "d" })).layout;
		expect(layout.lines.filter((line) => line.text.trim() === "Weekly Review Notes").map((line) => line.role)).toEqual(["title", "heading"]);
		const result = projectOntoSource({ source: body, layout, marks: [{ kind: "strikethrough", page: 1, words: idsIn(layout, "fox") }], highlights: [] })!;
		expect(result.markdown).toBe(body.replace("fox", "~~fox~~"));
	});

	it("does not take the title's words for the note's own when the note does not open with it", async () => {
		const body = ["Some words on the plan here.", "", "The quick brown fox jumps over the lazy dog.", "", "The next quarter budget is due soon."].join("\n");
		const pre = preprocess(`---\nrelated: next quarter budget\n---\n${body}`, { resolveEmbed: () => ({ kind: "missing" }), frontmatterAsTitleBlock: true });
		const layout = (await renderPdf(parseBlocks(pre.markdown), { title: "Notes on the plan", docId: "d" })).layout;
		const result = projectOntoSource({ source: body, layout, marks: [{ kind: "strikethrough", page: 1, words: idsIn(layout, "fox") }], highlights: [] })!;
		expect(result.markdown).toBe(body.replace("fox", "~~fox~~"));
	});
});
