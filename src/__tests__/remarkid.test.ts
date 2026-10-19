import { describe, expect, it } from "vitest";
import { isRemarkIdLine, remarkId, remarkIdLine } from "../incoming/remarkid";

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
