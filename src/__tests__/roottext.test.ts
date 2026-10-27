import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { idKey, parseRmScene, type TypedParagraph } from "../incoming/rmscene";
import { typedTextToMarkdown } from "../incoming/typedtext";
import { buildTextPageRm, DEFAULT_TEXT_BOX, markdownToTypedText } from "../ink/roottext";
import { buildInkPageRm, INK_AUTHOR, PEN, PEN_COLOR, type InkLine } from "../ink/rmwrite";
import { HEADER } from "../ink/rmbytes";

const PAPER = { paperSize: { width: 1404, height: 1872 } };

const NOTE = [
	"# Shopping",
	"Buy **milk**, *eggs* and ***bread***.",
	"",
	"## Errands",
	"- post **office**",
	"\t- stamps",
	"- [ ] call *Anna*",
	"- [x] book flights",
	"café ✓ 🙂",
].join("\n");

const stroke = (counter: number, y: number): InkLine => ({
	counter,
	tool: PEN.fineliner,
	color: PEN_COLOR.black,
	thicknessScale: 1,
	points: [
		{ x: 10, y, width: 8, pressure: 100, speed: 0, direction: 0 },
		{ x: 60, y: y + 5, width: 8, pressure: 100, speed: 0, direction: 0 },
	],
});

function blockTypes(bytes: Uint8Array): number[] {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const types: number[] = [];
	for (let offset = HEADER.length; offset + 8 <= bytes.length; offset += 8 + view.getUint32(offset, true)) {
		types.push(bytes[offset + 7]);
	}
	return types;
}

describe("buildTextPageRm", () => {
	it("writes text our reader returns paragraph for paragraph, styles and emphasis included", () => {
		const paragraphs = markdownToTypedText(NOTE);
		const text = parseRmScene(buildTextPageRm(paragraphs, [], PAPER)).text!;
		expect(text.paragraphs.map((p) => ({ style: p.style, spans: p.spans }))).toEqual(paragraphs);
		expect(typedTextToMarkdown(text.paragraphs)).toBe(NOTE);
		expect({ x: text.x, y: text.y, width: text.width }).toEqual(DEFAULT_TEXT_BOX);
	});

	it("ends emphasis with its paragraph, so the next one does not inherit it", () => {
		const paragraphs: TypedParagraph[] = [
			{ style: "plain", spans: [{ text: "all bold", bold: true, italic: true }] },
			{ style: "plain", spans: [{ text: "plain again", bold: false, italic: false }] },
		];
		const text = parseRmScene(buildTextPageRm(paragraphs, [], PAPER)).text!;
		expect(text.paragraphs[1].spans).toEqual([{ text: "plain again", bold: false, italic: false }]);
	});

	it("gives every code point its own id, emoji and accents included", () => {
		const text = parseRmScene(buildTextPageRm(markdownToTypedText("a🙂é\nb"), [], PAPER)).text!;
		const ids = text.paragraphs.flatMap((p) => p.charIds);
		expect(text.paragraphs[0].charIds.length).toBe(3);
		expect(ids.every((id) => id.author === INK_AUTHOR)).toBe(true);
		// a, 🙂, é, then the newline, then b: one counter each.
		expect(ids.map((id) => id.counter - ids[0].counter)).toEqual([0, 1, 2, 4]);
	});

	it("keeps pen strokes intact and gives the text ids none of them has", () => {
		const lines = [stroke(100, 500), stroke(101, 520), stroke(140, 540)];
		const scene = parseRmScene(buildTextPageRm(markdownToTypedText(NOTE), lines, PAPER));
		const strokesOnly = parseRmScene(buildInkPageRm(lines, PAPER));
		expect(scene.lines).toEqual(strokesOnly.lines);
		const textIds = scene.text!.paragraphs.flatMap((p) => [p.startId, ...p.charIds]).filter((id) => id.counter > 0);
		expect(Math.min(...textIds.map((id) => id.counter))).toBeGreaterThan(140);
		expect(new Set(textIds.map(idKey)).size).toBe(textIds.length);
	});

	it("lays the blocks out as the tablet does: text after the scene tree, before the tree nodes", () => {
		const tablet = new Uint8Array(
			readFileSync(fileURLToPath(new URL("./fixtures/text-crdt-ordering.rm", import.meta.url))),
		);
		expect(blockTypes(buildTextPageRm(markdownToTypedText("A12_Z"), [], PAPER))).toEqual(blockTypes(tablet));
		expect(blockTypes(buildTextPageRm(markdownToTypedText("x"), [stroke(100, 500)], PAPER)).slice(-2)).toEqual([
			0x04, 0x05,
		]);
	});

	it("writes an empty note as a page with no text", () => {
		const text = parseRmScene(buildTextPageRm(markdownToTypedText(""), [], PAPER)).text!;
		expect(text.paragraphs).toEqual([]);
		expect(typedTextToMarkdown(text.paragraphs)).toBe("");
	});

	it("keeps blank lines at either end as empty paragraphs", () => {
		const md = "\nmiddle\n";
		const text = parseRmScene(buildTextPageRm(markdownToTypedText(md), [], PAPER)).text!;
		expect(text.paragraphs.map((p) => p.text)).toEqual(["", "middle", ""]);
		expect(typedTextToMarkdown(text.paragraphs)).toBe(md);
	});

	it("places the text box where it is asked to", () => {
		const box = { x: -540, y: 300, width: 1080 };
		const text = parseRmScene(buildTextPageRm(markdownToTypedText("x"), [], { ...PAPER, textBox: box })).text!;
		expect({ x: text.x, y: text.y, width: text.width }).toEqual(box);
	});
});
