import { describe, expect, it } from "vitest";
import { parseBlocks, substituteDiagrams, type Block } from "../convert/mdblocks";
import { renderPdf } from "../convert/pdf";

/** A minimal valid 1×1 white PNG, for embed-path tests. */
const TINY_PNG = Uint8Array.from(
	atob(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4//8/AwAI/AL+p5qgoAAAAABJRU5ErkJggg==",
	),
	(c) => c.charCodeAt(0),
);

const NOTE = [
	"Intro paragraph.",
	"",
	"```mermaid",
	"graph TD",
	"  A --> B",
	"```",
	"",
	"```js",
	"console.log(1);",
	"```",
	"",
	"```mermaid",
	"graph LR",
	"  C --> D",
	"```",
	"",
	"Outro paragraph.",
].join("\n");

describe("fence language capture", () => {
	it("keeps plain fences shaped exactly as before", () => {
		const blocks = parseBlocks("```\ncode\n```");
		expect(blocks).toEqual([{ type: "code", lines: ["code"] }]);
	});

	it("records the info string, lowercased", () => {
		const blocks = parseBlocks("```Mermaid\ngraph TD\n```");
		expect(blocks).toEqual([
			{ type: "code", lines: ["graph TD"], lang: "mermaid" },
		]);
	});
});

describe("substituteDiagrams", () => {
	it("pairs mermaid fences with images by occurrence order, skipping other fences", () => {
		const blocks = substituteDiagrams(parseBlocks(NOTE), [
			{ w: 300, h: 200, png: TINY_PNG },
			{ w: 150, h: 100 },
		]);
		expect(blocks.map((b) => b.type)).toEqual([
			"paragraph",
			"image",
			"code",
			"image",
			"paragraph",
		]);
		const images = blocks.filter((b): b is Block & { type: "image" } => b.type === "image");
		expect(images[0]).toMatchObject({ w: 300, h: 200 });
		expect(images[0].png).toBe(TINY_PNG);
		expect(images[1]).toEqual({ type: "image", w: 150, h: 100 });
	});

	it("leaves a fence as code when its render failed (null) or is missing", () => {
		const blocks = substituteDiagrams(parseBlocks(NOTE), [null]);
		expect(blocks.map((b) => b.type)).toEqual([
			"paragraph",
			"code",
			"code",
			"code",
			"paragraph",
		]);
	});

	it("leaves a fence as code on degenerate dimensions", () => {
		const blocks = substituteDiagrams(parseBlocks("```mermaid\ngraph TD\n```"), [
			{ w: 0, h: 100 },
		]);
		expect(blocks[0].type).toBe("code");
	});
});

describe("image block typesetting", () => {
	const meta = { title: "Note", docId: "doc-1" };

	it("reserves identical geometry with and without PNG bytes (layout replay)", async () => {
		const withPng = substituteDiagrams(parseBlocks(NOTE), [
			{ w: 300, h: 200, png: TINY_PNG },
			{ w: 150, h: 100, png: TINY_PNG },
		]);
		const geometryOnly = substituteDiagrams(parseBlocks(NOTE), [
			{ w: 300, h: 200 },
			{ w: 150, h: 100 },
		]);
		const sent = await renderPdf(withPng, meta);
		const replayed = await renderPdf(geometryOnly, meta);
		// The layout map is what anchors ink; it must not depend on pixels.
		expect(replayed.layout).toEqual(sent.layout);
	});

	it("moves the text after a diagram down by the diagram's height", async () => {
		const plain = await renderPdf(parseBlocks("One.\n\nTwo."), meta);
		const withImage = await renderPdf(
			substituteDiagrams(parseBlocks("One.\n\n```mermaid\ngraph TD\n```\n\nTwo."), [
				{ w: 100, h: 100 },
			]),
			meta,
		);
		const two = (r: { layout: { lines: { text: string; y: number }[] } }) =>
			r.layout.lines.find((l) => l.text === "Two.");
		expect(two(plain)).toBeDefined();
		expect(two(withImage)).toBeDefined();
		expect(two(withImage)!.y).toBeLessThan(two(plain)!.y);
	});

	it("scales an oversized diagram to fit one page rather than breaking it", async () => {
		const { layout } = await renderPdf(
			substituteDiagrams(parseBlocks("```mermaid\ngraph TD\n```\n\nAfter."), [
				{ w: 2000, h: 5000 },
			]),
			meta,
		);
		// Page 1 holds the title, the capped diagram fills page 2 whole
		// (no text line shares it), and the paragraph opens page 3 — the
		// diagram was scaled to one page, never split across two.
		expect(layout.lines.filter((l) => l.page === 2)).toEqual([]);
		expect(layout.lines.find((l) => l.text === "After.")?.page).toBe(3);
		expect(layout.pageCount).toBe(3);
	});

	it("keeps a diagram whole: near a page edge it moves to the next page", async () => {
		const filler = Array.from({ length: 40 }, (_, i) => `Line ${i}.`).join("\n\n");
		const { layout } = await renderPdf(
			substituteDiagrams(parseBlocks(`${filler}\n\n\`\`\`mermaid\ngraph TD\n\`\`\`\n\nAfter.`), [
				{ w: 200, h: 200 },
			]),
			meta,
		);
		const after = layout.lines.find((l) => l.text === "After.");
		expect(after).toBeDefined();
		// "After." sits directly under the diagram; if the diagram had been
		// split across the page edge the paragraph would sit high on a page
		// that also holds filler lines. Instead the whole diagram moved.
		const pageOfAfter = after!.page;
		const fillerOnSamePage = layout.lines.filter(
			(l) => l.page === pageOfAfter && l.text.startsWith("Line"),
		);
		expect(fillerOnSamePage.length).toBe(0);
	});

	it("embeds the PNG into the saved PDF bytes", async () => {
		const { bytes } = await renderPdf(
			substituteDiagrams(parseBlocks("```mermaid\ngraph TD\n```"), [
				{ w: 100, h: 80, png: TINY_PNG },
			]),
			meta,
		);
		// pdf-lib stores embedPng images as PNG-decoded XObjects; the page
		// content must reference an image XObject (Do operator on an /Im).
		const text = new TextDecoder("latin1").decode(bytes);
		expect(text).toContain("/XObject");
	});
});
