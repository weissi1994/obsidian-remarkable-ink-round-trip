import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { type Block, parseBlocks } from "../convert/mdblocks";
import { builtinFont, HandFont } from "../ink/glyphs";
import { inkOptionsFor } from "../ink/inkfonts";
import {
	diagramKey,
	drawingStrokes,
	ellipsePoints,
	InkDrawing,
	occlude,
	pathToPolylines,
	rectPoints,
} from "../ink/inkdrawing";
import { mermaidBlocks, withInkTheme } from "../ink/mermaidtheme";
import { DEVICE_PROFILES, inkPagesToRm, renderInk, withImageBlocks } from "../ink/inkrender";
import { PEN_COLOR } from "../ink/rmwrite";
import type { InkSnapshot } from "../id/mapping";
import { diffInkPage } from "../incoming/inkdiff";
import { parseRmScene } from "../incoming/rmscene";

const fixture = (name: string) => JSON.parse(readFileSync(join(__dirname, "fixtures", name), "utf8")) as unknown;
// Traced in headless Chromium from Mermaid 11 output (see svgextract.ts).
const FLOWCHART = fixture("mermaid-flowchart.json") as InkDrawing;
const PIE = fixture("mermaid-pie.json") as InkDrawing;
const SOURCES = fixture("mermaid-sources.json") as { flowchart: string; pie: string };

describe("SVG geometry", () => {
	it("flattens absolute, relative, curve and arc commands", () => {
		const [line] = pathToPolylines("M10 10 h20 v20 H10 Z");
		expect(line.closed).toBe(true);
		expect(line.points).toEqual([
			[10, 10],
			[30, 10],
			[30, 30],
			[10, 30],
			[10, 10],
		]);
		const rel = pathToPolylines("m5 5 l10 0 l0 10");
		expect(rel[0].points[2]).toEqual([15, 15]);
		const curve = pathToPolylines("M0 0 C 0 10 10 10 10 0 S 20 -10 20 0");
		expect(curve[0].points[curve[0].points.length - 1]).toEqual([20, 0]);
		const arc = pathToPolylines("M0 0 A 10 10 0 0 1 20 0");
		const ys = arc[0].points.map((p) => p[1]);
		expect(Math.min(...ys)).toBeCloseTo(-10, 0); // a half circle above
		expect(arc[0].points[arc[0].points.length - 1]).toEqual([20, 0]);
		expect(pathToPolylines("M0 0 L5 5 M10 10 L20 20")).toHaveLength(2);
	});

	it("draws closed rectangles and ellipses", () => {
		const rounded = rectPoints(0, 0, 40, 20, 5);
		expect(rounded[0]).toEqual(rounded[rounded.length - 1]);
		expect(Math.max(...rounded.map((p) => p[0]))).toBeCloseTo(40, 5);
		const circle = ellipsePoints(0, 0, 10, 10);
		for (const [x, y] of circle) expect(Math.hypot(x, y)).toBeCloseTo(10, 5);
	});

	it("cuts lines where a later opaque shape covers them, but not its own outline", () => {
		const box = rectPoints(40, -10, 20, 20).flat();
		const [left, right, outline] = [
			...occlude(
				[
					{ points: [0, 0, 100, 0], order: 1 },
					{ points: box, closed: true, order: 2 },
				],
				[{ points: box, order: 2 }],
			),
		];
		expect(Math.max(...left.points.filter((_, i) => i % 2 === 0))).toBeLessThanOrEqual(42);
		expect(Math.min(...right.points.filter((_, i) => i % 2 === 0))).toBeGreaterThanOrEqual(58);
		expect(outline.closed).toBe(true);
		// A line painted after the box stays whole.
		expect(occlude([{ points: [0, 0, 100, 0], order: 3 }], [{ points: box, order: 2 }])).toHaveLength(1);
	});
});

describe("Mermaid sources", () => {
	it("finds fenced diagrams exactly as the block parser sees them", () => {
		const md = `Intro\n\n\`\`\`mermaid\n${SOURCES.flowchart}\n\`\`\`\n\n\`\`\`js\nconsole.log(1)\n\`\`\``;
		const found = mermaidBlocks(md);
		expect(found).toEqual([SOURCES.flowchart]);
		const code = parseBlocks(md).filter((b) => b.type === "code");
		expect(code[0].type === "code" && diagramKey(code[0].lines.join("\n"))).toBe(diagramKey(found[0]));
	});

	// Every code block the nested-quote parse finds, at any quote depth.
	const nestedCode = (blocks: Block[]): string[] =>
		blocks.flatMap((b) =>
			b.type === "code" ? [b.lines.join("\n")] : b.type === "quote" ? nestedCode(b.blocks ?? []) : [],
		);
	const quoted = (prefix: string, source: string) =>
		source
			.split("\n")
			.map((line) => `${prefix}${line}`)
			.join("\n");

	it("finds a diagram inside a callout as the nested-quote parse sees it", () => {
		const md = `> **Note**\n> \`\`\`mermaid\n${quoted("> ", SOURCES.flowchart)}\n> \`\`\``;
		const found = mermaidBlocks(md);
		expect(found).toEqual([SOURCES.flowchart]);
		expect(nestedCode(parseBlocks(md, { nestedQuotes: true })).map(diagramKey)).toEqual([diagramKey(found[0])]);
	});

	it("finds a diagram in a quote inside a quote, keeping its indentation", () => {
		const source = `${SOURCES.flowchart}\n  a --> b`;
		const md = `> outer\n> > \`\`\`mermaid\n${quoted("> > ", SOURCES.flowchart)}\n> >   a --> b\n> > \`\`\`\n> after`;
		const found = mermaidBlocks(md);
		expect(found).toEqual([source]);
		expect(found[0].endsWith("\n  a --> b")).toBe(true);
		expect(nestedCode(parseBlocks(md, { nestedQuotes: true })).map(diagramKey)).toEqual([diagramKey(source)]);
	});

	it("ends an unclosed quoted diagram with its quote, and still finds the next", () => {
		const md = `> \`\`\`mermaid\n> flowchart LR\n>   a --> b\n\nPlain text\n\n\`\`\`mermaid\n${SOURCES.pie}\n\`\`\``;
		const found = mermaidBlocks(md);
		expect(found).toEqual(["flowchart LR\n  a --> b", SOURCES.pie]);
		expect(nestedCode(parseBlocks(md, { nestedQuotes: true })).map(diagramKey)).toEqual(found.map(diagramKey));
	});

	it("swaps a quoted diagram for its drawing", () => {
		const md = `> **Note**\n> \`\`\`mermaid\n${quoted("> ", SOURCES.flowchart)}\n> \`\`\``;
		const [source] = mermaidBlocks(md);
		const blocks = withImageBlocks(parseBlocks(md, { nestedQuotes: true }), undefined, {
			[diagramKey(source)]: FLOWCHART,
		});
		const quote = blocks.find((b) => b.type === "quote");
		const inner = quote?.type === "quote" ? (quote.blocks ?? []) : [];
		expect(inner.some((b) => b.type === "inkimage")).toBe(true);
		expect(inner.some((b) => b.type === "code")).toBe(false);
	});

	it("puts the pen theme first, but after a front matter block", () => {
		expect(withInkTheme("flowchart TD\n A-->B")).toMatch(/^%%\{init: \{"theme":"base"/);
		const fm = withInkTheme("---\ntitle: X\n---\nflowchart TD\n A-->B");
		expect(fm.startsWith("---\ntitle: X\n---\n%%{init:")).toBe(true);
	});
});

describe("drawing a traced diagram", () => {
	const font = new HandFont(builtinFont("readability"), builtinFont("readability"));
	const base = {
		font,
		color: PEN_COLOR.black,
		thickness: 1.5,
		jitter: 0.5,
		seed: "s",
		unit: 226 / 72,
		colour: true,
	};

	it("keeps every stroke inside its box and writes every label", () => {
		const box = { left: -300, top: 200, width: 600, height: 1200 };
		const strokes = drawingStrokes(FLOWCHART, { ...base, box });
		expect(strokes.length).toBeGreaterThan(FLOWCHART.paths.length);
		for (const stroke of strokes) {
			for (const p of stroke.points) {
				expect(p.x).toBeGreaterThan(box.left - 8);
				expect(p.x).toBeLessThan(box.left + box.width + 8);
				expect(p.y).toBeGreaterThan(box.top - 8);
				expect(p.y).toBeLessThan(box.top + box.height + 8);
			}
		}
		expect(FLOWCHART.labels.map((l) => l.text)).toEqual(
			expect.arrayContaining(["Client", "Envoy Gateway", "Rate limit?", "HTTPS", "429"]),
		);
	});

	it("hatches pie slices in the tablet's inks, or grey on request", () => {
		const box = { left: -300, top: 0, width: 600, height: 480 };
		const colours = new Set(drawingStrokes(PIE, { ...base, box }).map((s) => s.color));
		expect(colours).toEqual(expect.objectContaining({}));
		for (const ink of [PEN_COLOR.blue, PEN_COLOR.red, PEN_COLOR.green]) expect(colours.has(ink)).toBe(true);
		const grey = new Set(drawingStrokes(PIE, { ...base, box, colour: false }).map((s) => s.color));
		expect(grey.has(PEN_COLOR.blue)).toBe(false);
		expect(grey.has(PEN_COLOR.grey)).toBe(true);
	});

	it("wobbles deterministically, and not at all at zero jitter", () => {
		const box = { left: 0, top: 0, width: 300, height: 600 };
		expect(drawingStrokes(FLOWCHART, { ...base, box })).toEqual(drawingStrokes(FLOWCHART, { ...base, box }));
		const straight = drawingStrokes({ width: 100, height: 10, paths: [{ points: [0, 5, 100, 5] }], fills: [], labels: [] }, {
			...base,
			box: { left: 0, top: 0, width: 100, height: 10 },
			jitter: 0,
		});
		expect(straight[0].points.every((p) => p.y === 5)).toBe(true);
	});
});

describe("Mermaid in a handwritten notebook", () => {
	const SNAPSHOT: InkSnapshot = {
		pageIds: ["p"],
		font: "readability",
		fallbackFont: "readability",
		pen: "medium",
		color: 0,
		jitter: 0.5,
		profile: DEVICE_PROFILES.paperpro,
		shape: 1,
		imageStyle: "colour-hatch",
	};
	const NOTE = `Request path:\n\n\`\`\`mermaid\n${SOURCES.flowchart}\n\`\`\`\n\nAfter the diagram.`;

	function render(drawings: Record<string, InkDrawing> | undefined) {
		const options = { ...inkOptionsFor(SNAPSHOT, "doc-m", () => null)!, drawings };
		return { options, render: renderInk(parseBlocks(NOTE), "Mermaid", { fontSize: 11, lineHeight: 1.5, margin: 40 }, options) };
	}

	it("draws the diagram instead of writing its source", () => {
		const withDiagram = render({ [diagramKey(SOURCES.flowchart)]: FLOWCHART }).render;
		const asCode = render(undefined).render;
		expect(asCode.layout.lines.some((l) => l.text.includes("flowchart TD"))).toBe(true);
		expect(withDiagram.layout.lines.some((l) => l.text.includes("flowchart TD"))).toBe(false);
		const diagramInk = withDiagram.pages.flat().filter((s) => s.wordId === null);
		expect(diagramInk.length).toBeGreaterThan(80);
	});

	it("regenerates exactly and stays trustworthy for the import", () => {
		const a = render({ [diagramKey(SOURCES.flowchart)]: FLOWCHART });
		const b = render({ [diagramKey(SOURCES.flowchart)]: FLOWCHART });
		expect(a.render.pages).toEqual(b.render.pages);
		const pages = inkPagesToRm(a.render, a.options);
		pages.forEach((page, i) => {
			const diff = diffInkPage(a.render.pages[i], parseRmScene(page));
			expect(diff.trustworthy).toBe(true);
			expect(diff.userStrokes).toEqual([]);
		});
	});
});
