import { describe, expect, it } from "vitest";
import { preprocess } from "../preprocess/preprocess";
import {
	imageRefTargets,
	parseBlocks,
	substituteDiagrams,
	substituteVaultImages,
	type Block,
} from "../convert/mdblocks";
import { renderPdf } from "../convert/pdf";

/** A minimal valid 1×1 white PNG, for embed-path tests. */
const TINY_PNG = Uint8Array.from(
	atob(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4//8/AwAI/AL+p5qgoAAAAABJRU5ErkJggg==",
	),
	(c) => c.charCodeAt(0),
);

const imagerefs = (blocks: Block[]) =>
	blocks.filter((b): b is Block & { type: "imageref" } => b.type === "imageref");

describe("preprocess with imagesAsBlocks off (the default)", () => {
	it("flattens a standalone image exactly as before", () => {
		const out = preprocess("before\n\n![[pic.png]]\n\nafter");
		expect(out.markdown).toContain("*[image: pic.png]*");
		expect(out.markdown).not.toContain("![[pic.png]]");
	});
});

describe("preprocess with imagesAsBlocks on", () => {
	it("keeps a wiki image that is the whole line", () => {
		const out = preprocess("before\n\n![[pic.png]]\n\nafter", { imagesAsBlocks: true });
		expect(out.markdown).toContain("![[pic.png]]");
	});

	it("keeps a markdown image that is the whole line", () => {
		const out = preprocess("![shot](assets/shot.png)", { imagesAsBlocks: true });
		expect(out.markdown).toContain("![shot](assets/shot.png)");
	});

	it("still flattens an image sitting inside a sentence", () => {
		// A paragraph cannot break around a picture, so inline stays text.
		const out = preprocess("see ![[pic.png]] here", { imagesAsBlocks: true });
		expect(out.markdown).toContain("*[image: pic.png]*");
		expect(out.markdown).not.toContain("![[pic.png]]");
	});

	it("does not let the wikilink pass strip a preserved image", () => {
		// Regression: WIKILINK_RE without a lookbehind turned "![[pic.png]]"
		// into "![pic.png]" and the block was never recognised.
		const out = preprocess("![[pic.png]]", { imagesAsBlocks: true });
		expect(out.markdown).toContain("![[pic.png]]");
		expect(out.markdown).not.toMatch(/(?<!\[)\[pic\.png\](?!\])/);
	});

	it("leaves a note transclusion alone", () => {
		const out = preprocess("![[Some Note]]", {
			imagesAsBlocks: true,
			resolveEmbed: () => ({ kind: "missing" }),
		});
		expect(out.markdown).toContain("missing embed");
	});
});

describe("parseBlocks image refs", () => {
	it("turns a standalone image into an imageref block with target and alt", () => {
		const blocks = parseBlocks("![[assets/pic.png|a caption]]");
		expect(blocks).toEqual([
			{ type: "imageref", target: "assets/pic.png", alt: "a caption" },
		]);
	});

	it("reads the markdown form", () => {
		expect(parseBlocks("![alt text](a/b.png)")).toEqual([
			{ type: "imageref", target: "a/b.png", alt: "alt text" },
		]);
	});

	it("does not treat an image inside a sentence as a block", () => {
		const blocks = parseBlocks("text ![[pic.png]] more");
		expect(imagerefs(blocks)).toHaveLength(0);
		expect(blocks[0].type).toBe("paragraph");
	});

	it("reports targets in occurrence order", () => {
		const blocks = parseBlocks("![[a.png]]\n\nmiddle\n\n![[b.png]]");
		expect(imageRefTargets(blocks)).toEqual(["a.png", "b.png"]);
	});
});

describe("substituteVaultImages", () => {
	const NOTE = "![[a.png]]\n\nmiddle\n\n![[b.png]]";

	it("fills placeholders by occurrence order", () => {
		const blocks = substituteVaultImages(parseBlocks(NOTE), [
			{ w: 100, h: 50, png: TINY_PNG },
			{ w: 200, h: 80, png: TINY_PNG },
		]);
		expect(blocks.map((b) => b.type)).toEqual(["image", "paragraph", "image"]);
		const images = blocks.filter((b): b is Block & { type: "image" } => b.type === "image");
		expect(images.map((i) => [i.w, i.h])).toEqual([
			[100, 50],
			[200, 80],
		]);
	});

	it("falls back to placeholder text for a picture that would not load", () => {
		const blocks = substituteVaultImages(parseBlocks("![[missing.png]]"), [null]);
		expect(blocks).toEqual([
			{ type: "paragraph", text: "[image: missing.png]", style: "italic" },
		]);
	});

	it("uses the alt text in the fallback when there is one", () => {
		const blocks = substituteVaultImages(parseBlocks("![[x.png|The chart]]"), [null]);
		expect(blocks[0]).toMatchObject({ text: "[image: The chart]" });
	});

	it("treats a slot past the end as unloaded", () => {
		const blocks = substituteVaultImages(parseBlocks(NOTE), [
			{ w: 100, h: 50, png: TINY_PNG },
		]);
		expect(blocks.map((b) => b.type)).toEqual(["image", "paragraph", "paragraph"]);
	});

	it("rejects nonsense geometry rather than drawing a zero-sized picture", () => {
		const blocks = substituteVaultImages(parseBlocks("![[a.png]]"), [
			{ w: 0, h: 50, png: TINY_PNG },
		]);
		expect(blocks[0].type).toBe("paragraph");
	});

	it("carries geometry alone at import time, without bytes", () => {
		const blocks = substituteVaultImages(parseBlocks("![[a.png]]"), [{ w: 120, h: 60 }]);
		expect(blocks[0]).toEqual({ type: "image", w: 120, h: 60 });
	});
});

describe("diagrams and pictures in one note", () => {
	// The reason vaultImages is its own list: one shared array would pair the
	// first picture with the diagram's slot as soon as a note held both.
	const NOTE = [
		"![[first.png]]",
		"",
		"```mermaid",
		"graph TD",
		"  A --> B",
		"```",
		"",
		"![[second.png]]",
	].join("\n");

	it("substitutes each kind from its own array, whatever the order", () => {
		let blocks = parseBlocks(NOTE);
		blocks = substituteDiagrams(blocks, [{ w: 300, h: 200, png: TINY_PNG }]);
		blocks = substituteVaultImages(blocks, [
			{ w: 10, h: 11, png: TINY_PNG },
			{ w: 20, h: 21, png: TINY_PNG },
		]);
		const images = blocks.filter((b): b is Block & { type: "image" } => b.type === "image");
		expect(images.map((i) => [i.w, i.h])).toEqual([
			[10, 11],
			[300, 200],
			[20, 21],
		]);
	});

	it("does not consume a picture slot for the diagram", () => {
		const blocks = substituteVaultImages(parseBlocks(NOTE), [
			{ w: 10, h: 11, png: TINY_PNG },
			{ w: 20, h: 21, png: TINY_PNG },
		]);
		// The mermaid fence is untouched by the picture pass.
		expect(blocks.some((b) => b.type === "code" && b.lang === "mermaid")).toBe(true);
	});
});

describe("typesetting", () => {
	it("embeds a substituted picture into the PDF", async () => {
		const blocks = substituteVaultImages(parseBlocks("![[a.png]]"), [
			{ w: 100, h: 50, png: TINY_PNG },
		]);
		const { bytes } = await renderPdf(blocks, { title: "t", docId: "d" });
		const text = new TextDecoder("latin1").decode(bytes);
		expect(text).toContain("/Subtype /Image");
	});

	it("draws a leftover imageref as its placeholder text instead of crashing", async () => {
		const { bytes, layout } = await renderPdf(parseBlocks("![[a.png]]"), {
			title: "t",
			docId: "d",
		});
		expect(bytes.length).toBeGreaterThan(0);
		const words = layout.lines.flatMap((l) => l.words.map((w) => w.text));
		expect(words.join(" ")).toContain("[image:");
	});
});
