import { describe, expect, it } from "vitest";
import { parseBlocks } from "../convert/mdblocks";
import type { InkSnapshot } from "../id/mapping";
import { readMarks } from "../incoming/marks";
import type { Stroke } from "../incoming/rmlines";
import { hiddenRemarks, projectOntoSource } from "../incoming/sourceprojection";
import { inkOptionsFor } from "../ink/inkfonts";
import { inkStrokesOf, InkStrokes } from "../ink/inkimage";
import { DEVICE_PROFILES, renderInk } from "../ink/inkrender";
import { PEN, PEN_COLOR } from "../ink/rmwrite";
import { preprocess, type EmbedContent } from "../preprocess/preprocess";

const SNAPSHOT: InkSnapshot = {
	pageIds: ["p"],
	font: "readability",
	fallbackFont: "readability",
	pen: "medium",
	color: 0,
	jitter: 0.4,
	profile: DEVICE_PROFILES.move,
	shape: 1,
	imageStyle: "colour-hatch",
};
const LAYOUT = { fontSize: 11, lineHeight: 1.5, margin: 32 };
const OPTIONS = inkOptionsFor(SNAPSHOT, "doc-r", () => null)!;
const IMAGE = "doc-p01-0123456789ab.png";

const NOTE = ["First paragraph line here.", "", "Second paragraph with words.", "", "Third paragraph at the end."].join("\n");
const CALLOUT = [
	"> [!note] Remark ✓",
	"> what was read",
	`> ![[handwriting/${IMAGE}]]`,
	"> ^ink-0123456789ab",
].join("\n");
/** The note with the callout before its last paragraph (after the one it was written under). */
const withCallout = (note: string, callout = CALLOUT) => {
	const paragraphs = note.split("\n\n");
	return [...paragraphs.slice(0, -1), callout, paragraphs[paragraphs.length - 1]].join("\n\n");
};

const resolver =
	(inPlace: boolean) =>
	(target: string): EmbedContent =>
		target.endsWith(".png") ? { kind: "image", name: IMAGE.replace(/\.png$/, ""), ...(inPlace ? { inPlace } : {}) } : { kind: "missing" };

function render(markdown: string, images: Record<string, InkStrokes> = {}) {
	// Parsed as a send parses it (sync/send.ts).
	return renderInk(parseBlocks(markdown, { html: true, quotePictures: true, nestedQuotes: true }), "Remarks", LAYOUT, { ...OPTIONS, images });
}

/** A scribbled word just under a row, in device units, written the way the tablet stores it. */
function scribbleBeside(layout: ReturnType<typeof render>["layout"], text: string): Stroke[] {
	const line = layout.lines.find((l) => l.text.trim() === text)!;
	const sx = DEVICE_PROFILES.move.width / layout.pageWidth;
	const sy = DEVICE_PROFILES.move.height / layout.pageHeight;
	const left = (line.x + 20) * sx - DEVICE_PROFILES.move.width / 2;
	const baseline = (layout.pageHeight - line.y) * sy;
	// Three letter-like loops, a little apart: handwriting, not a line or a ring.
	const letter = (dx: number) =>
		Array.from({ length: 16 }, (_, i) => ({
			x: left + dx + 14 * Math.sin((i / 15) * Math.PI * 3),
			y: baseline + 12 + i * 1.5,
			speed: 0,
			direction: 0,
			width: 16,
			pressure: 0.5,
		}));
	return [0, 40, 80].map((dx) => ({ tool: PEN.fineliner, color: PEN_COLOR.black, thicknessScale: 2, points: letter(dx) }));
}

function bounds(points: { x: number; y: number }[]) {
	return {
		minX: Math.min(...points.map((p) => p.x)),
		minY: Math.min(...points.map((p) => p.y)),
		maxX: Math.max(...points.map((p) => p.x)),
		maxY: Math.max(...points.map((p) => p.y)),
	};
}

/** The remark as an import records it: its strokes and where it sits beside its row. */
function recordedRemark() {
	const sent = render(NOTE);
	const strokes = scribbleBeside(sent.layout, "Second paragraph with words.");
	const marks = readMarks(strokes, 1, sent.layout);
	const note = marks.find((mark) => mark.kind === "note")!;
	const ink = { ...inkStrokesOf(strokes, DEVICE_PROFILES.move.dpi)!, at: note.at };
	return { sent, strokes, note, ink };
}

describe("handwritten remarks drawn back where they were written", () => {
	it("records where a remark sits beside the row it was written against", () => {
		const { note } = recordedRemark();
		expect(note.quote).toBe("Second paragraph with words.");
		expect(note.at?.text).toBe("Second paragraph with words.");
		expect(note.at?.x).toBeGreaterThan(40);
		expect(note.at?.below).toBeGreaterThan(0); // under the baseline
	});

	it("sends an in-place remark's callout as one placeholder line, and keeps others minus the id", () => {
		const inPlace = preprocess(withCallout(NOTE), { resolveEmbed: resolver(true) }).markdown;
		expect(inPlace).toContain(`*[remark: ${IMAGE}]*`);
		expect(inPlace).not.toContain("what was read");
		expect(inPlace).not.toContain("^ink-");

		const callout = preprocess(withCallout(NOTE), { resolveEmbed: resolver(false) }).markdown;
		expect(callout).toContain("what was read");
		expect(callout).not.toContain("[remark:");
		expect(callout).not.toContain("^ink-");
	});

	it("leaves a remark callout inside a code block alone", () => {
		const fenced = ["```", CALLOUT, "```"].join("\n");
		const out = preprocess(fenced, { resolveEmbed: resolver(true) }).markdown;
		expect(out).toContain("> ^ink-0123456789ab");
		expect(out).not.toContain("[remark:");
	});

	it("draws the ink at its original spot, taking no room on the page", () => {
		const { sent, strokes, ink } = recordedRemark();
		const markdown = preprocess(withCallout(NOTE), { resolveEmbed: resolver(true) }).markdown;
		const back = render(markdown, { [IMAGE]: ink });

		// The text is laid out exactly as without the remark.
		const placed = (r: typeof back) => r.layout.lines.map((l) => `${l.page}|${l.x}|${l.y}|${l.text}`);
		expect(placed(back)).toEqual(placed(sent));
		expect(back.layout.remarksInPlace).toEqual([IMAGE]);

		// The extra strokes are the remark, where it was written.
		const added = back.pages[0].slice(sent.pages[0].length);
		expect(added).toHaveLength(strokes.length);
		const drawn = bounds(added.flatMap((s) => s.points));
		const written = bounds(strokes.flatMap((s) => s.points));
		for (const key of ["minX", "minY", "maxX", "maxY"] as const) {
			expect(Math.abs(drawn[key] - written[key])).toBeLessThan(2);
		}
		expect(added.every((s) => s.wordId === null && s.tool === PEN.fineliner)).toBe(true);
	});

	it("follows its row when text above it grows", () => {
		const { ink } = recordedRemark();
		const longer = NOTE.replace("First paragraph line here.", "First paragraph line here.\n\nAn inserted paragraph pushes everything down.");
		const markdown = preprocess(withCallout(longer), { resolveEmbed: resolver(true) }).markdown;
		const back = render(markdown, { [IMAGE]: ink });
		const plain = render(longer);
		const row = plain.layout.lines.find((l) => l.text.trim() === "Second paragraph with words.")!;
		const rowY = (back.layout.pageHeight - row.y) * (DEVICE_PROFILES.move.height / back.layout.pageHeight);
		const added = back.pages[0].slice(plain.pages[0].length);
		const drawn = bounds(added.flatMap((s) => s.points));
		// Within a line of its row, as when it was written.
		expect(Math.abs(drawn.maxY - rowY)).toBeLessThan(60);
	});

	it("goes under the text it follows when its row is gone", () => {
		const { ink } = recordedRemark();
		const edited = NOTE.replace("Second paragraph with words.", "A rewritten second paragraph.");
		const markdown = preprocess(withCallout(edited), { resolveEmbed: resolver(true) }).markdown;
		const back = render(markdown, { [IMAGE]: ink });
		const plain = render(edited);
		const second = plain.layout.lines.find((l) => l.text.trim() === "A rewritten second paragraph.")!;
		const third = plain.layout.lines.find((l) => l.text.trim() === "Third paragraph at the end.")!;
		const toY = (y: number) => (back.layout.pageHeight - y) * (DEVICE_PROFILES.move.height / back.layout.pageHeight);
		const drawn = bounds(back.pages[0].slice(plain.pages[0].length).flatMap((s) => s.points));
		expect(drawn.minY).toBeGreaterThan(toY(second.y));
		expect(drawn.minY).toBeLessThan(toY(third.y));
	});

	it("falls back to drawing the ink in the flow when its place was never recorded", () => {
		const { ink } = recordedRemark();
		const markdown = preprocess(withCallout(NOTE), { resolveEmbed: resolver(true) }).markdown;
		const back = render(markdown, { [IMAGE]: { ...ink, at: undefined } });
		expect(back.layout.remarksInPlace).toBeUndefined();
		expect(back.pages[0].length).toBeGreaterThan(render(NOTE).pages[0].length);
	});
});

describe("the import lines up a note whose remarks are drawn in place", () => {
	it("finds the callouts of in-place remarks in the note", () => {
		const source = withCallout(NOTE);
		const ranges = hiddenRemarks(source, [IMAGE]);
		expect(ranges).toHaveLength(1);
		expect(source.slice(ranges[0].start, ranges[0].end)).toBe(CALLOUT);
		expect(hiddenRemarks(source, ["other.png"])).toEqual([]);
	});

	it("places marks after a long remark callout that is not on the page", () => {
		const { ink } = recordedRemark();
		const long = [
			"> [!note] Remark",
			...Array.from({ length: 12 }, (_, i) => `> a long reading of the remark, line number ${i} of it`),
			`> ![[handwriting/${IMAGE}]]`,
			"> ^ink-0123456789ab",
		].join("\n");
		const source = withCallout(NOTE, long);
		const markdown = preprocess(source, { resolveEmbed: resolver(true) }).markdown;
		const layout = render(markdown, { [IMAGE]: ink }).layout;
		const third = layout.lines.find((l) => l.text.trim() === "Third paragraph at the end.")!;
		const projected = projectOntoSource({
			source,
			layout,
			highlights: [],
			marks: [{ kind: "strikethrough", page: 1, words: [third.words[0].id], target: "Third" }],
		});
		expect(projected?.markdown).toContain("~~Third~~ paragraph at the end.");
		expect(projected?.markdown).toContain(long);
	});
});
