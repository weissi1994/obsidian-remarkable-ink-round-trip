import { describe, expect, it } from "vitest";
import { diffHunks, merge3 } from "../sync/merge3";

const BASE = ["# Plan", "", "The quick brown fox jumps over the lazy dog.", "", "- one", "- two", "- three"].join("\n");

describe("diffHunks", () => {
	it("finds replaced, inserted and removed ranges", () => {
		expect(diffHunks(["a", "b", "c"], ["a", "x", "c", "d"])).toEqual([
			{ oStart: 1, oEnd: 2, xStart: 1, xEnd: 2, side: "ours" },
			{ oStart: 3, oEnd: 3, xStart: 3, xEnd: 4, side: "ours" },
		]);
		expect(diffHunks([], [])).toEqual([]);
		expect(diffHunks(["a"], [])).toEqual([{ oStart: 0, oEnd: 1, xStart: 0, xEnd: 0, side: "ours" }]);
	});
});

describe("merge3", () => {
	it("takes the tablet's changes when the note is unchanged", () => {
		const theirs = BASE.replace("brown ", "");
		expect(merge3(BASE, BASE, theirs)).toEqual({ text: theirs, conflicts: 0 });
	});

	it("keeps the note when the tablet changed nothing", () => {
		const ours = `${BASE}\n- four`;
		expect(merge3(BASE, ours, BASE)).toEqual({ text: ours, conflicts: 0 });
	});

	it("merges changes on different lines", () => {
		const ours = BASE.replace("- two", "- two, edited");
		const theirs = BASE.replace("# Plan", "# ~~Plan~~");
		const merged = merge3(BASE, ours, theirs);
		expect(merged.conflicts).toBe(0);
		expect(merged.text).toContain("- two, edited");
		expect(merged.text).toContain("# ~~Plan~~");
	});

	it("merges different words of the same paragraph", () => {
		const ours = BASE.replace("lazy", "sleepy");
		const theirs = BASE.replace("quick ", "");
		const merged = merge3(BASE, ours, theirs);
		expect(merged.conflicts).toBe(0);
		expect(merged.text).toContain("The brown fox jumps over the sleepy dog.");
	});

	it("accepts the same change from both sides", () => {
		const both = BASE.replace("- three", "- [x] three");
		expect(merge3(BASE, both, both)).toEqual({ text: both, conflicts: 0 });
	});

	it("keeps the note's words and shows the tablet's on a real conflict", () => {
		const ours = BASE.replace("brown", "red");
		const theirs = BASE.replace("brown", "~~brown~~");
		const merged = merge3(BASE, ours, theirs);
		expect(merged.conflicts).toBe(1);
		expect(merged.text).toContain("The quick red fox");
		expect(merged.text).toContain("> [!warning] Also changed on the reMarkable");
		expect(merged.text).toContain("> The quick ~~brown~~ fox");
	});

	it("merges an inserted remark next to an edit elsewhere", () => {
		const ours = BASE.replace("- one", "- one!");
		const theirs = BASE.replace("- three", "- three\n\n> [!note] Remark\n> ![[ink.png]]");
		const merged = merge3(BASE, ours, theirs);
		expect(merged.conflicts).toBe(0);
		expect(merged.text.endsWith("- three\n\n> [!note] Remark\n> ![[ink.png]]")).toBe(true);
		expect(merged.text).toContain("- one!");
	});
});
