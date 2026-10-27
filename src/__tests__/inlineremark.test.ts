import { describe, expect, it } from "vitest";
import { parseBlocks } from "../convert/mdblocks";
import type { InkSnapshot } from "../id/mapping";
import {
	appendToCell,
	appendToLine,
	hiddenInlineRanges,
	inlineImageAt,
	inlineItem,
	inlineRemarkText,
	setInlineRemark,
} from "../incoming/inlineremark";
import type { ImportedMark } from "../incoming/pull";
import { cellsOf } from "../incoming/remarkinsert";
import { projectOntoSource } from "../incoming/sourceprojection";
import { inkOptionsFor } from "../ink/inkfonts";
import { DEVICE_PROFILES, renderInk } from "../ink/inkrender";
import { isConfidentReading } from "../ocr/samples";
import { preprocess } from "../preprocess/preprocess";
import { settleRemarks } from "../sync/twoway";

const A = "aaaaaaaaaaaa";
const B = "bbbbbbbbbbbb";

describe("whether a reading is confident enough to go in as text", () => {
	const known = (words: string[]) => (word: string) => words.includes(word.toLowerCase());

	it("takes a scored reading clearly above its reader's cut-off, not one just over it", () => {
		expect(isConfidentReading({ text: "YAY", by: "writepad", score: 0.6 })).toBe(true);
		expect(isConfidentReading({ text: "YAY", by: "builtin", score: 0.3 })).toBe(false);
	});

	it("takes an endpoint reading whose every word is known, or that the local reader agrees with", () => {
		expect(isConfidentReading({ text: "Buy milk", by: "endpoint" }, { isWord: known(["buy", "milk"]) })).toBe(true);
		expect(isConfidentReading({ text: "Buy 12 apples", by: "endpoint" }, { isWord: known(["buy", "apples"]) })).toBe(true);
		expect(isConfidentReading({ text: "Buy mlik", by: "endpoint" }, { isWord: known(["buy", "milk"]) })).toBe(false);
		expect(isConfidentReading({ text: "Buy mlik", by: "endpoint" }, { otherReading: "buy mlik." })).toBe(true);
		expect(isConfidentReading({ text: "Buy mlik", by: "endpoint" }, { otherReading: "Bay mlik" })).toBe(false);
		expect(isConfidentReading({ text: "Buy mlik", by: "endpoint" })).toBe(false);
	});

	it("never takes junk symbols or note structure, always the owner's own text", () => {
		expect(isConfidentReading({ text: "Buy ⊕ milk", score: 0.9 })).toBe(false);
		expect(isConfidentReading({ text: "Ok, see page 14 (right?)", score: 0.9 })).toBe(true);
		expect(isConfidentReading({ text: "> [!note] Remark", score: 0.9 })).toBe(false);
		expect(isConfidentReading({ text: "?!", score: 0.9 }, { otherReading: "" })).toBe(false);
		expect(isConfidentReading({ text: "Hi da is er", known: true })).toBe(true);
	});
});

describe("an inline item in its line", () => {
	it("goes into its table cell, pipes escaped, the row keeping its cells", () => {
		const row = appendToCell("| with | row   |", 1, inlineItem({ text: "a|b" }, A, true));
		expect(row).toBe(`| with | row a\\|b%%ink-${A}%% |`);
		expect(cellsOf(row)).toHaveLength(2);
		expect(appendToCell("| a |  |", 1, inlineItem({ text: "YAY" }, A, true))).toBe(`| a | YAY%%ink-${A}%% |`);
		expect(appendToCell("> | a | b |", 0, "x")).toBe("> | a x | b |");
		expect(inlineItem({ image: "handwriting/a.png", width: 40 }, A, true)).toBe(`![[handwriting/a.png\\|40]]%%ink-${A}%%`);
		expect(inlineItem({ image: "handwriting/a.png", width: 40 }, A)).toBe(`![[handwriting/a.png|40]]%%ink-${A}%%`);
	});

	it("is an empty task's text, and goes at the end of a line's text — before a block id", () => {
		expect(appendToLine("- [ ] ", inlineItem({ text: "What" }, A))).toBe(`- [ ] What%%ink-${A}%%`);
		expect(appendToLine("- [x] checklist⏫ ", "What")).toBe("- [x] checklist⏫ What");
		expect(appendToLine("Some text ^block-1", "more")).toBe("Some text more ^block-1");
		expect(appendToLine("# Plan", "ok")).toBe("# Plan ok");
	});

	it("says what it says: the plugin's reading while the line ends in it, else as many words as the ink has", () => {
		const note = `| with | row YAY%%ink-${A}%% |`;
		expect(inlineRemarkText(note, A, "YAY")).toBe("YAY");
		expect(inlineRemarkText(note.replace("YAY", "YEAH"), A, "YAY", 1)).toBe("YEAH");
		expect(inlineRemarkText(note.replace("YAY", "YEAH"), A)).toBe("row YEAH");
		expect(inlineRemarkText(`- [ ] What now%%ink-${A}%%`, A)).toBe("What now");
		expect(inlineRemarkText(`Text one%%ink-${A}%% two words%%ink-${B}%%`, B)).toBe("two words");
		expect(inlineRemarkText(`| a | x ![[h/a.png\\|40]]%%ink-${A}%% |`, A)).toBe("");
		expect(inlineRemarkText("```\nx%%ink-aaaaaaaaaaaa%%\n```", A)).toBeNull();
	});

	it("takes text in place of its image, or a new reading in place of the plugin's", () => {
		expect(setInlineRemark(`| x | ![[h/a.png\\|40]]%%ink-${A}%% |`, A, { text: "a|b" })).toBe(`| x | a\\|b%%ink-${A}%% |`);
		expect(setInlineRemark(`- [ ] call mum What%%ink-${A}%%`, A, { text: "Wheat" }, "What")).toBe(`- [ ] call mum Wheat%%ink-${A}%%`);
	});

	it("is found by the cursor when it still shows its image", () => {
		const note = `one\nrow ![[h/a.png|40]]%%ink-${A}%% and ![[h/b.png|40]]%%ink-${B}%%`;
		expect(inlineImageAt(note, 1, 2)?.id).toBe(A);
		expect(inlineImageAt(note, 1, note.split("\n")[1].length)?.id).toBe(B);
		expect(inlineImageAt(note, 0, 0)).toBeNull();
	});

	it("hides its marker and its image from the line-up with the page", () => {
		const source = `row YAY%%ink-${A}%% and ![[h/b.png|40]]%%ink-${B}%% %%note%%`;
		expect(hiddenInlineRanges(source).map((range) => source.slice(range.start, range.end))).toEqual([
			`%%ink-${A}%%`,
			`![[h/b.png|40]]%%ink-${B}%%`,
			"%%note%%",
		]);
	});
});

describe("where an inline remark goes in the note", () => {
	const SNAPSHOT: InkSnapshot = {
		pageIds: ["p"],
		font: "readability",
		fallbackFont: "readability",
		pen: "medium",
		color: 0,
		jitter: 0.3,
		profile: DEVICE_PROFILES.move,
		shape: 1,
		imageStyle: "colour-hatch",
	};
	const OPTIONS = inkOptionsFor(SNAPSHOT, "doc-i", () => null)!;
	const NOTE = ["# Plan", "", "Some text here.", "", "```", "const x = 1;", "```", "", "After code."].join("\n");
	const layout = renderInk(parseBlocks(NOTE, { html: true }), "Notes", { fontSize: 11, lineHeight: 1.5, margin: 32 }, OPTIONS).layout;
	const remark = (id: string, quote: string, onRow: boolean, text: string): ImportedMark => ({
		kind: "note",
		page: 1,
		id,
		quote,
		...(onRow ? { onRow } : {}),
		transcript: text,
		confident: true,
	});
	const project = (marks: ImportedMark[]) =>
		projectOntoSource({ source: NOTE, layout, highlights: [], marks, remarksForm: "inline", listUnplaced: false })!;

	it("appends to a heading, to a line in the margin of which it was written, and leaves code alone", () => {
		const out = project([
			remark(A, "Plan", true, "ok"),
			remark(B, "After code.", true, "noted"),
			remark("cccccccccccc", "const x = 1;", true, "in code"),
		]).markdown;
		expect(out).toBe(
			["# Plan ok%%ink-aaaaaaaaaaaa%%", "", "Some text here.", "", "```", "const x = 1;", "```", "", "in code%%ink-cccccccccccc%%", "", "After code. noted%%ink-bbbbbbbbbbbb%%"].join("\n"),
		);
	});

	it("puts writing between blocks in a paragraph of its own there, an image when unsure", () => {
		const unsure: ImportedMark = { ...remark(B, "Some text here.", false, "maybe"), confident: undefined, path: "handwriting/doc-p01-b.png" };
		const result = project([remark(A, "Some text here.", false, "Free words"), unsure]);
		expect(result.markdown).toBe(
			[
				"# Plan",
				"",
				"Some text here.",
				"",
				"Free words%%ink-aaaaaaaaaaaa%%",
				"",
				"![[handwriting/doc-p01-b.png|88]]%%ink-bbbbbbbbbbbb%%",
				"",
				"```",
				"const x = 1;",
				"```",
				"",
				"After code.",
			].join("\n"),
		);
		// What the next import merges against leaves them out: from now on they are the note's.
		expect(result.withoutInline).toBe(NOTE);
	});

	it("stays a callout for a page added on the tablet", () => {
		const added: ImportedMark = { ...remark(A, "", false, "A page"), addedPage: 2 };
		expect(project([added]).markdown).toContain("> [!note] Page added on the reMarkable (page 2)");
	});
});

describe("an inline remark the note already shows", () => {
	const stroke = (x: number) => Array.from({ length: 6 }, (_, i) => ({ x: x + i * 3, y: 100 + (i % 2) * 8 }));

	it("is the same writing once the owner wrote more on it: its marker follows, its untouched text takes the new reading", () => {
		const ours = `- [ ] What%%ink-${A}%%`;
		const mark: ImportedMark = { kind: "note", page: 1, id: B, strokes: [stroke(0), stroke(40), stroke(80)], transcript: "What now", confident: true };
		const kept = (id: string) => (id === A ? { strokes: [stroke(0), stroke(40)], text: "What" } : null);
		const settled = settleRemarks(ours, [mark], kept);
		expect(settled.ours).toBe(`- [ ] What now%%ink-${B}%%`);
		expect(settled.marks).toEqual([]);
		expect(settled.refreshed).toEqual([B]);
	});

	it("keeps the owner's text and an unsure image, and takes a confident reading for the image", () => {
		const mark: ImportedMark = { kind: "note", page: 1, id: A, transcript: "Wheat", replaces: "What", confident: true };
		expect(settleRemarks(`- [ ] What?!%%ink-${A}%%`, [mark]).ours).toBe(`- [ ] What?!%%ink-${A}%%`);
		const image = `| x | ![[h/a.png\\|40]]%%ink-${A}%% |`;
		expect(settleRemarks(image, [{ ...mark, confident: undefined }]).ours).toBe(image);
		expect(settleRemarks(image, [mark]).ours).toBe(`| x | Wheat%%ink-${A}%% |`);
	});
});

describe("an inline remark sent back", () => {
	const resolver = (inPlace: boolean) => (target: string) => ({ kind: "image" as const, name: target, ...(inPlace ? { inPlace } : {}) });

	it("goes as plain text, its marker stripped", () => {
		expect(preprocess(`- [x] What%%ink-${A}%%\n`).markdown).toBe("- [x] What\n");
	});

	it("goes, still an image, after its block — drawn in place, or as the picture when it cannot be", () => {
		const note = `| a | b |\n| - | - |\n| c | d ![[h/doc-p01-a.png\\|40]]%%ink-${A}%% |\n\nNext.`;
		expect(preprocess(note, { resolveEmbed: resolver(true) }).markdown).toBe("| a | b |\n| - | - |\n| c | d |\n\n*[remark: doc-p01-a.png]*\n\nNext.\n");
		expect(preprocess(note, { resolveEmbed: resolver(false), imagesAsBlocks: true }).markdown).toBe("| a | b |\n| - | - |\n| c | d |\n\n![[h/doc-p01-a.png]]\n\nNext.\n");
		const alone = `Before.\n\n![[h/doc-p01-a.png|40]]%%ink-${A}%%\n\nAfter.`;
		expect(preprocess(alone, { resolveEmbed: resolver(true) }).markdown).toBe("Before.\n\n*[remark: doc-p01-a.png]*\n\nAfter.\n");
	});
});
