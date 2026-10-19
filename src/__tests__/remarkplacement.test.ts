import { beforeAll, describe, expect, it } from "vitest";
import { parseBlocks } from "../convert/mdblocks";
import type { PdfLayout } from "../convert/pdf";
import { renderPdf } from "./helpers/pdfrender";
import { preprocess } from "../preprocess/preprocess";
import { blockEnd, projectOntoSource } from "../incoming/sourceprojection";

/*
 * A remark callout inserted in the middle of a block splits it: a table
 * loses its later rows (they ran on into the remark), a callout its later
 * lines, a code fence swallowed the callout as code. Remarks go after the
 * whole block.
 */

const SOURCE = [
	"Intro line.",
	"",
	"| Name | Value |",
	"| --- | --- |",
	"| alpha row | one |",
	"| beta row | two |",
	"",
	"> [!info] Box",
	"> inside callout text",
	"> second callout line",
	"",
	"- item one here",
	"- item two here",
	"",
	"```",
	"code line one",
	"code line two",
	"```",
	"",
	"Outro.",
].join("\n");

let layout: PdfLayout;
beforeAll(async () => {
	const pre = preprocess(SOURCE, { resolveEmbed: () => ({ kind: "missing" }) });
	layout = (await renderPdf(parseBlocks(pre.markdown), { title: "T", docId: "d" })).layout;
});

const remarkAt = (quote: string) =>
	projectOntoSource({
		source: SOURCE,
		layout,
		highlights: [],
		marks: [{ kind: "note", page: 1, quote, id: "aaaaaaaaaaaa", transcript: "HANDWRITTEN" }],
	})!.markdown;

const CALLOUT = ["> [!note] Remark", "> HANDWRITTEN", "> ^ink-aaaaaaaaaaaa"];

/** The note with the remark callout taken out again (and the blank lines it brought). */
const without = (markdown: string) => markdown.replace(`\n\n${CALLOUT.join("\n")}\n`, "\n");

describe("a remark next to a block", () => {
	it.each([
		["a table row", "alpha row one", "| beta row | two |"],
		["a callout line", "inside callout text", "> second callout line"],
		["a list item", "item one here", "- item two here"],
		["a code line", "code line one", "```"],
	])("next to %s goes after the whole block, leaving it intact", (_, quote, lastLine) => {
		const out = remarkAt(quote);
		const lines = out.split("\n");
		const title = lines.indexOf(CALLOUT[0]);
		expect(lines.slice(title - 2, title + 4)).toEqual([lastLine, "", ...CALLOUT, ""]);
		expect(without(out)).toBe(SOURCE);
	});

	it("still goes right under a paragraph", () => {
		const lines = remarkAt("Intro line.").split("\n");
		expect(lines.slice(0, 5)).toEqual(["Intro line.", "", ...CALLOUT]);
	});
});

describe("blockEnd", () => {
	it("carries a list across blank lines between its items", () => {
		const loose = ["- one", "", "- two", "  more of two", "", "After."];
		expect(blockEnd(loose, 0)).toBe(3);
		expect(blockEnd(loose, 5)).toBe(5);
	});

	it("knows a line is inside a fence even when it looks like a list or a table", () => {
		const fenced = ["~~~", "- not a list", "", "| not | a table |", "~~~", "x"];
		expect(blockEnd(fenced, 1)).toBe(4);
		expect(blockEnd(fenced, 3)).toBe(4);
		expect(blockEnd(fenced, 5)).toBe(5);
	});
});
