import { describe, expect, it } from "vitest";
import { parseBlocks } from "../convert/mdblocks";
import { DrawPage, LaidOutLine, TypesetBackend, typesetBlocks } from "../convert/pdf";
import { builtinFont, HandFont } from "../ink/glyphs";

interface Line {
	page: number;
	x1: number;
	y1: number;
	x2: number;
	y2: number;
	thickness: number;
}

/** Typeset with handwriting metrics, recording every rule drawn. */
function typeset(markdown: string, typo?: number, pageHeight?: number) {
	const f = builtinFont("readability");
	const face = new HandFont(f, f);
	const lines: Line[] = [];
	const highlights: string[] = [];
	let page = 0;
	const backend: TypesetBackend = {
		body: face,
		bold: face,
		italic: face,
		mono: face,
		addPage(): DrawPage {
			page++;
			const current = page;
			return {
				drawText: () => undefined,
				drawRectangle: () => undefined,
				drawLine: (o) =>
					lines.push({ page: current, x1: o.start.x, y1: o.start.y, x2: o.end.x, y2: o.end.y, thickness: o.thickness ?? 1 }),
				drawHighlight: (o) => highlights.push(o.kind),
			};
		},
	};
	const options = { ...(typo === undefined ? {} : { typo }), ...(pageHeight === undefined ? {} : { pageHeight }) };
	const layout = typesetBlocks(parseBlocks(markdown), "t", options, backend);
	return { lines, highlights, layout };
}

const TABLE = [
	"| Day | Task | Status |",
	"|---|---|---|",
	"| Monday | Review the pull request and write notes on the open questions | done |",
	"| Wednesday | Meeting | open |",
].join("\n");

const vertical = (l: Line) => Math.abs(l.x1 - l.x2) < 0.01 && Math.abs(l.y1 - l.y2) > 0.01;
const horizontal = (l: Line) => Math.abs(l.y1 - l.y2) < 0.01;

describe("table grid (typo 10)", () => {
	it("draws border, column lines and a rule under every row", () => {
		const { lines, highlights } = typeset(TABLE);
		const xs = new Set(lines.filter(vertical).map((l) => Math.round(l.x1)));
		expect(xs.size).toBe(4); // left, right and two column lines
		const ys = new Set(lines.filter(horizontal).map((l) => Math.round(l.y1)));
		expect(ys.size).toBe(4); // top, under the header, between rows, bottom
		expect(Math.max(...lines.filter(horizontal).map((l) => l.thickness))).toBeGreaterThanOrEqual(1.2);
		expect(highlights).toContain("table-header");
	});

	it("keeps cell text off the lines", () => {
		const { lines, layout } = typeset(TABLE);
		const columnXs = [...new Set(lines.filter(vertical).map((l) => l.x1))];
		const cells = layout.lines.filter((l: LaidOutLine) => l.role === "table");
		for (const cell of cells) {
			for (const x of columnXs) expect(Math.abs(cell.x - x)).toBeGreaterThan(2);
		}
	});

	it("does not break a word its column has room for", () => {
		const { layout } = typeset(TABLE);
		const words = layout.lines.filter((l) => l.role === "table").flatMap((l) => l.words.map((w) => w.text));
		expect(words).toContain("Wednesday");
	});

	it("closes the grid again on a page a table continues on", () => {
		const long = ["| A | B |", "|---|---|", ...Array.from({ length: 40 }, (_, i) => `| row ${i} | value ${i} |`)].join("\n");
		const { lines } = typeset(long, undefined, 300);
		const pages = new Set(lines.map((l) => l.page));
		expect(pages.size).toBeGreaterThan(1);
		for (const page of pages) {
			const onPage = lines.filter((l) => l.page === page && horizontal(l));
			const top = Math.max(...onPage.map((l) => l.y1));
			const verticalTops = lines.filter((l) => l.page === page && vertical(l)).map((l) => Math.max(l.y1, l.y2));
			expect(Math.max(...verticalTops)).toBeLessThanOrEqual(top + 0.01);
		}
	});

	it("leaves tables of older sends as they were: one rule, no grid", () => {
		const { lines, highlights } = typeset(TABLE, 9);
		expect(lines.filter(vertical)).toHaveLength(0);
		expect(lines.filter(horizontal)).toHaveLength(1);
		expect(highlights).not.toContain("table-header");
	});
});
