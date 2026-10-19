import { describe, expect, it } from "vitest";
import {
	confirmAllRemarks,
	confirmRemarkAt,
	findRemark,
	isRemarkIdLine,
	remarkAt,
	remarkId,
	remarkIdLine,
	setRemarkTextAt,
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
