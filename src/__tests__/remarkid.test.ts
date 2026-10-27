import { describe, expect, it } from "vitest";
import {
	confirmAllRemarks,
	confirmRemarkAt,
	findRemark,
	isPluginIdLine,
	isRemarkIdLine,
	isSameRemark,
	remarkAt,
	remarkId,
	remarkIdLine,
	setRemarkTextAt,
	textId,
} from "../incoming/remarkid";

const stroke = (...xy: [number, number][]) => ({ points: xy.map(([x, y]) => ({ x, y })) });

describe("remark id", () => {
	const ink = [stroke([10, 20], [30, 40], [50, 45]), stroke([60, 20], [61, 44])];

	it("is the same for the same ink, however often it is read", () => {
		const reread = ink.map((s) => ({ points: s.points.map((p) => ({ x: p.x + 0.2, y: p.y - 0.3 })) }));
		expect(remarkId(ink)).toBe(remarkId(reread));
		expect(remarkId(ink)).toMatch(/^[0-9a-f]{12}$/);
	});

	it("changes when the ink does — moved, extended, or split differently", () => {
		const moved = ink.map((s) => ({ points: s.points.map((p) => ({ x: p.x + 5, y: p.y })) }));
		const extended = [...ink, stroke([70, 20], [72, 40])];
		const regrouped = [stroke([10, 20], [30, 40], [50, 45], [60, 20], [61, 44])];
		const ids = new Set([ink, moved, extended, regrouped].map(remarkId));
		expect(ids.size).toBe(4);
	});

	it("does not depend on the remark's position on the page", () => {
		// The whole point: a new remark above this one must not rename it.
		expect(remarkId(ink)).toBe(remarkId([...ink]));
	});

	it("is written as a block id and recognised again", () => {
		expect(remarkIdLine("3f9a2c1b0d4e")).toBe("> ^ink-3f9a2c1b0d4e");
		expect(remarkIdLine("3f9a2c1b0d4e", false)).toBe("^ink-3f9a2c1b0d4e");
		expect(isRemarkIdLine("> ^ink-3f9a2c1b0d4e")).toBe(true);
		expect(isRemarkIdLine("^ink-3f9a2c1b0d4e")).toBe(true);
		expect(isRemarkIdLine("> see ^ink-3f9a2c1b0d4e")).toBe(false);
		expect(isRemarkIdLine("> hello")).toBe(false);
	});
});

describe("a remark whose ink changed", () => {
	const line = (x: number, y: number, n = 6) => Array.from({ length: n }, (_, i) => ({ x: x + i * 4, y: y + (i % 2) * 7 }));
	const word = [line(100, 300), line(130, 300), line(160, 302)];

	it("is the same remark with a stroke added or one erased", () => {
		expect(isSameRemark({ page: 1, strokes: word }, { page: 1, strokes: [...word, line(190, 301)] })).toBe(true);
		expect(isSameRemark({ page: 1, strokes: word }, { page: 1, strokes: word.slice(1) })).toBe(true);
	});

	it("is recognised from ink kept from its own corner, or lassoed elsewhere whole", () => {
		const shift = (strokes: typeof word, dx: number, dy: number) => strokes.map((s) => s.map((p) => ({ x: p.x + dx, y: p.y + dy })));
		expect(isSameRemark({ strokes: shift(word, -100, -300) }, { page: 2, strokes: [...word, line(190, 301)] })).toBe(true);
		expect(isSameRemark({ page: 1, strokes: word }, { page: 1, strokes: shift(word, 0, 400) })).toBe(true);
	});

	it("is another remark on another page, or with mostly other ink", () => {
		expect(isSameRemark({ page: 1, strokes: word }, { page: 2, strokes: word })).toBe(false);
		const other = [line(100, 900, 9), line(140, 905, 9), line(180, 910, 9), line(220, 915, 9)];
		expect(isSameRemark({ page: 1, strokes: word }, { page: 1, strokes: other })).toBe(false);
		// One stroke in common is not "mostly shared".
		expect(isSameRemark({ page: 1, strokes: word }, { page: 1, strokes: [word[0], ...other] })).toBe(false);
	});
});

describe("ids of other blocks the plugin writes", () => {
	it("are stable for the same text and told apart from a remark's", () => {
		expect(textId("> The quick ~~brown~~ fox")).toBe(textId("> The quick ~~brown~~ fox"));
		expect(textId("> The quick ~~brown~~ fox")).not.toBe(textId("> The quick brown fox"));
		expect(textId("x")).toMatch(/^[0-9a-f]{12}$/);
		expect(isRemarkIdLine("> ^ink-conflict-3f9a2c1b0d4e")).toBe(false);
		expect(isRemarkIdLine("> ^ink-pending")).toBe(false);
		for (const id of ["> ^ink-3f9a2c1b0d4e", "> ^ink-conflict-3f9a2c1b0d4e", "> ^ink-conflict-3f9a2c1b0d4e-2", "> ^ink-pending"]) {
			expect(isPluginIdLine(id)).toBe(true);
		}
		expect(isPluginIdLine("> ^ink-pendingX")).toBe(false);
	});
});

describe("confirming and correcting in the note", () => {
	const NOTE = [
		"Text.",
		"",
		"> [!note] Remark",
		"> helo wrld",
		"> ![[img/a.png]]",
		"> ^ink-aaaaaaaaaaaa",
		"",
		"> [!tip] Not a remark",
		"> keep",
		"",
		"> [!note] Remark",
		"> ![[img/b.png]]",
		"> ^ink-bbbbbbbbbbbb",
	].join("\n");

	it("confirms the remark around a line, once", () => {
		const once = confirmRemarkAt(NOTE, 4)!;
		expect(once.split("\n")[2]).toBe("> [!note] Remark ✓");
		expect(confirmRemarkAt(once, 2)).toBe(once);
		expect(findRemark(once, { id: "aaaaaaaaaaaa" })?.confirmed).toBe(true);
		expect(findRemark(once, { id: "bbbbbbbbbbbb" })?.confirmed).toBe(false);
	});

	it("does nothing outside a remark callout", () => {
		expect(confirmRemarkAt(NOTE, 0)).toBeNull();
		expect(confirmRemarkAt(NOTE, 8)).toBeNull();
		expect(remarkAt(NOTE, 8)).toBeNull();
	});

	it("confirms every remark in a note, and only remarks", () => {
		const { note, confirmed } = confirmAllRemarks(NOTE);
		expect(confirmed).toBe(2);
		expect(note).toContain("> [!tip] Not a remark\n");
		expect(confirmAllRemarks(note).confirmed).toBe(0);
	});

	it("does not take handwritten ✓ in the text for a confirmation", () => {
		const ticked = NOTE.replace("> helo wrld", "> done ✓");
		expect(findRemark(ticked, { id: "aaaaaaaaaaaa" })?.confirmed).toBe(false);
	});

	it("sets a remark's text, keeping title, image and id", () => {
		const fixed = setRemarkTextAt(NOTE, 5, "hello\n\nworld ")!;
		expect(fixed.split("\n").slice(2, 8)).toEqual([
			"> [!note] Remark",
			"> hello",
			"> world",
			"> ![[img/a.png]]",
			"> ^ink-aaaaaaaaaaaa",
			"",
		]);
		const filled = setRemarkTextAt(NOTE, 11, "typed in")!;
		expect(remarkAt(filled, 11)).toEqual({ id: "bbbbbbbbbbbb", text: "typed in", confirmed: false, title: 10 });
	});
});
