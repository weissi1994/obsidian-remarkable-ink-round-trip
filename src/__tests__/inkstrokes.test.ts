import { describe, expect, it } from "vitest";
import { parseBlocks } from "../convert/mdblocks";
import { inkOptionsFor } from "../ink/inkfonts";
import { inkStrokesOf, type Picture } from "../ink/inkimage";
import { DEVICE_PROFILES, inkPagesToRm, renderInk, withImageBlocks } from "../ink/inkrender";
import { PEN, PEN_COLOR } from "../ink/rmwrite";
import type { InkSnapshot, MappingEntry } from "../id/mapping";
import { InkEdge, type InkHost } from "../inkedge";
import { diffInkPage } from "../incoming/inkdiff";
import { parseRmScene } from "../incoming/rmscene";
import { preprocess } from "../preprocess/preprocess";

const SNAPSHOT: InkSnapshot = {
	pageIds: ["page-1"],
	font: "readability",
	fallbackFont: "readability",
	pen: "medium",
	color: 0,
	jitter: 0,
	profile: DEVICE_PROFILES.paperpro,
	shape: 1,
	imageStyle: "colour-hatch",
	inline: true,
	quotePictures: true,
};

const IMAGE = "reMarkable-in/handwriting/dev-p01-1.png";
const NOTE = `Some text.\n\n> [!note] Remark\n> check this\n> ![[${IMAGE}]]\n\nAfter.`;

/** A remark as the tablet wrote it: two ballpoint strokes in blue, absolute page coordinates. */
const REMARK = [
	{ tool: PEN.ballpoint, color: PEN_COLOR.blue, thicknessScale: 2, points: [{ x: 100, y: 900, width: 14 }, { x: 160, y: 930, width: 18 }, { x: 220, y: 900, width: 14 }] },
	{ tool: PEN.ballpoint, color: PEN_COLOR.blue, thicknessScale: 2, points: [{ x: 120, y: 950, width: 14 }, { x: 200, y: 950, width: 16 }] },
];

function render(snapshot: InkSnapshot, images: Record<string, Picture>) {
	const options = { ...inkOptionsFor(snapshot, "doc-1", () => null)!, images };
	const markdown = preprocess(NOTE, { resolveEmbed: () => ({ kind: "image", name: "dev-p01-1.png" }) }).markdown;
	return {
		options,
		render: renderInk(
			parseBlocks(markdown, { html: true, quotePictures: snapshot.quotePictures === true }),
			"Remarks",
			{},
			options,
		),
	};
}

describe("the owner's ink, sent back as itself", () => {
	const ink = inkStrokesOf(REMARK, DEVICE_PROFILES.paperpro.dpi)!;

	it("keeps the strokes at their own size, from the origin", () => {
		expect(ink.width).toBe(120);
		expect(ink.height).toBe(50);
		expect(ink.strokes[0].points.slice(0, 3)).toEqual([0, 0, 14]);
		// Physical size kept: 120 device pixels at 229 dpi ≈ 37.7 pt.
		expect(ink.sourceWidth * 0.75).toBeCloseTo((120 * 72) / 229, 5);
	});

	it("turns a picture in a callout into a picture block, not its placeholder text", () => {
		const markdown = preprocess(NOTE, { resolveEmbed: () => ({ kind: "image", name: "x" }) }).markdown;
		const now = parseBlocks(markdown, { quotePictures: true });
		expect(now.map((b) => b.type)).toEqual(["paragraph", "quote", "paragraph", "paragraph"]);
		const before = parseBlocks(markdown);
		expect(before.map((b) => b.type)).toEqual(["paragraph", "quote", "paragraph"]);
	});

	it("writes the remark's own strokes — pen, colour and shape — where its image was", () => {
		const r = render(SNAPSHOT, { "dev-p01-1.png": ink }).render;
		const remark = r.pages[0].filter((s) => s.tool === PEN.ballpoint);
		expect(remark).toHaveLength(2);
		expect(remark.every((s) => s.color === PEN_COLOR.blue && s.wordId === null)).toBe(true);
		const first = remark[0].points;
		expect(first[first.length - 1].x - first[0].x).toBeCloseTo(120, 0);
	});

	it("does so even with pictures left as placeholders — it is not a picture the owner embedded", () => {
		const placeholders = { ...SNAPSHOT, imageStyle: undefined };
		const r = render(placeholders, { "dev-p01-1.png": ink }).render;
		expect(r.pages[0].filter((s) => s.tool === PEN.ballpoint)).toHaveLength(2);
		const hatch = { width: 1, height: 1, sourceWidth: 10, sourceHeight: 10, cells: "BA==" };
		const plain = render(placeholders, { "dev-p01-1.png": hatch }).render;
		expect(plain.layout.lines.some((l) => l.text.includes("[image:"))).toBe(true);
	});

	it("is recognised as the plugin's own when the page comes back", () => {
		const { render: r, options } = render(SNAPSHOT, { "dev-p01-1.png": ink });
		const [page] = inkPagesToRm(r, options);
		const diff = diffInkPage(r.pages[0], parseRmScene(page));
		expect(diff.userStrokes).toEqual([]);
		expect(diff.trustworthy).toBe(true);
	});
});

describe("pictures and replay inside quotes that hold blocks (#22)", () => {
	const ink = inkStrokesOf(REMARK, DEVICE_PROFILES.paperpro.dpi)!;

	it("turns a picture inside a nested quote into a picture block", () => {
		const blocks = parseBlocks("> outer\n> > inner\n> > *[image: dev-p01-1.png]*", { quotePictures: true, nestedQuotes: true });
		const [outer] = withImageBlocks(blocks, { "dev-p01-1.png": ink });
		if (outer.type !== "quote") throw new Error("expected a quote");
		const nested = outer.blocks?.[1];
		if (nested?.type !== "quote") throw new Error("expected a nested quote");
		expect(nested.blocks?.map((b) => b.type)).toEqual(["paragraph", "inkimage"]);
	});

	/** An edge whose kept send is `markdown`, replaying `ink`. */
	async function replay(markdown: string, ink: InkSnapshot) {
		const sent = { title: "Quotes", markdown };
		const host = { manifest: { dir: "x" }, settings: {}, state: { readSent: () => Promise.resolve(sent) } } as unknown as InkHost;
		const entry = { docId: "doc-1", ink, pdfLayout: { typo: 10 } } as unknown as MappingEntry;
		return (await new InkEdge(host).loadInk(entry))!.layout;
	}

	const QUOTED_TABLE = "> **Note**\n> | A | B |\n> | --- | --- |\n> | 1 | 2 |\n";

	it("replays a send made before it with the flat quote", async () => {
		const layout = await replay(QUOTED_TABLE, SNAPSHOT);
		expect(layout.lines.some((l) => l.role === "table")).toBe(false);
		expect(layout.lines.filter((l) => l.role === "quote").map((l) => l.text).join(" ")).toContain("| A | B |");
	});

	it("replays a send made with it with the quote's table", async () => {
		const layout = await replay(QUOTED_TABLE, { ...SNAPSHOT, nestedQuotes: true });
		expect(layout.lines.filter((l) => l.role === "table").map((l) => l.text)).toEqual(["A", "B", "1", "2"]);
	});
});
