import { describe, expect, it } from "vitest";
import type { InkStrokes } from "../ink/inkimage";
import { findWordRun, overlayBox, pendingRemarks, remarkAnchor } from "../incoming/remarkoverlay";

/*
 * An unconfirmed remark is shown faded over the note, roughly where the ink
 * sat on the page: the tablet's text column is stretched onto the note's,
 * and the strokes — not the padded picture around them — land at the
 * recorded spot.
 */

const PAGE = { pageWidth: 447, margin: 40 };
const COLUMN_PT = PAGE.pageWidth - 2 * PAGE.margin;

/** Ink of a given size in points; 226 dpi device units, as an rM2 reads it. */
function ink(widthPt: number, heightPt: number, at?: InkStrokes["at"]): InkStrokes {
	const dpi = 226;
	return {
		kind: "strokes",
		sourceWidth: widthPt / 0.75,
		sourceHeight: heightPt / 0.75,
		width: (widthPt * dpi) / 72,
		height: (heightPt * dpi) / 72,
		strokes: [],
		...(at === undefined ? {} : { at }),
	};
}

describe("overlayBox", () => {
	const columnPx = 734;
	const s = columnPx / COLUMN_PT;

	it("puts ink written at the column's edge at the column's edge, under the row", () => {
		const box = overlayBox(ink(60, 20, { text: "a row", x: PAGE.margin, below: 2 }), PAGE, columnPx);
		expect(box).not.toBeNull();
		expect(box!.leftPx + box!.padPx).toBeCloseTo(0, 6);
		expect(box!.topPx + box!.padPx).toBeCloseTo(2 * s, 6);
		// The ink itself keeps its size, scaled like the column.
		expect(box!.widthPx - 2 * box!.padPx).toBeCloseTo(60 * s, 6);
		expect(box!.heightPx - 2 * box!.padPx).toBeCloseTo(20 * s, 6);
	});

	it("keeps ink written in the right margin in view", () => {
		const x = PAGE.pageWidth - 15; // most of the 30 pt wide ink is off the column's right
		const box = overlayBox(ink(30, 10, { text: "a row", x, below: -8 }), PAGE, columnPx, { room: { left: 0, right: 20 } });
		expect(box).not.toBeNull();
		const inkLeft = box!.leftPx + box!.padPx;
		const inkRight = inkLeft + 30 * s;
		expect(inkRight).toBeCloseTo(columnPx + 20, 6);
		expect(inkLeft).toBeGreaterThan(columnPx / 2);
	});

	it("keeps ink written in the left margin in view", () => {
		const box = overlayBox(ink(30, 10, { text: "a row", x: 2, below: 0 }), PAGE, columnPx);
		expect(box!.leftPx + box!.padPx).toBeCloseTo(0, 6);
	});

	it("leaves ink that fits where it was written", () => {
		const box = overlayBox(ink(30, 10, { text: "a row", x: 200, below: 5 }), PAGE, columnPx);
		expect(box!.leftPx + box!.padPx).toBeCloseTo((200 - PAGE.margin) * s, 6);
	});

	it("shows nothing for ink without a recorded place", () => {
		expect(overlayBox(ink(30, 10), PAGE, columnPx)).toBeNull();
	});

	it("offsets the picture by its padding, so the strokes land at x", () => {
		// planRender pads the ink by 40 device units on each side.
		const widthPt = 60;
		const box = overlayBox(ink(widthPt, 20, { text: "a row", x: 100, below: 0 }), PAGE, columnPx)!;
		const padPt = (40 * 72) / 226;
		expect(box.padPx).toBeCloseTo(padPt * s, 6);
		expect(box.leftPx).toBeCloseTo((100 - PAGE.margin - padPt) * s, 6);
		expect(box.topPx).toBeCloseTo(-padPt * s, 6);
		expect(box.widthPx).toBeCloseTo((widthPt + 2 * padPt) * s, 6);
	});

	it("spaces the offset under the row by the note's line pitch", () => {
		const box = overlayBox(ink(30, 10, { text: "a row", x: PAGE.margin, below: 20 }), PAGE, columnPx, { lineRatio: 0.5 })!;
		expect(box.topPx + box.padPx).toBeCloseTo(10 * s, 6);
	});
});

describe("pendingRemarks", () => {
	const NOTE = [
		"First paragraph with some words.",
		"",
		"> [!note] Remark",
		"> looks fine",
		"> ![[doc-p01-aaaa.png]]",
		"> ^ink-aaaa",
		"",
		"> [!note] Remark ✓",
		"> done",
		"> ![[doc-p01-bbbb.png]]",
		"> ^ink-bbbb",
		"",
		"> [!note] Remark",
		"> no picture",
		"> ^ink-cccc",
	].join("\n");

	it("lists the unconfirmed remarks that show ink", () => {
		expect(pendingRemarks(NOTE)).toEqual([{ id: "aaaa", start: 2, image: "doc-p01-aaaa.png" }]);
	});

	it("finds nothing in a note without remarks", () => {
		expect(pendingRemarks("Just text.\n\n> a quote")).toEqual([]);
	});
});

describe("remarkAnchor", () => {
	const LINES = [
		"Some intro.",
		"The **quick** brown fox jumps over the lazy dog, and then",
		"another line follows",
		"",
		"> [!note] Remark",
	];

	it("finds the printed row's words in the nearest line above, at their offset", () => {
		const anchor = remarkAnchor(LINES, 4, "fox jumps over the lazy");
		expect(anchor).toEqual({ line: 1, offset: LINES[1].indexOf("fox") });
	});

	it("is null when the row is no longer in the note", () => {
		expect(remarkAnchor(LINES, 4, "words that are gone")).toBeNull();
	});
});

describe("findWordRun", () => {
	it("finds the words as rendered, markdown and punctuation aside", () => {
		const text = "Intro. The quick brown fox, jumps!";
		expect(findWordRun(text, "quick brown fox jumps")).toEqual([{ start: text.indexOf("quick"), end: text.indexOf("quick") + 5 }]);
	});
});
