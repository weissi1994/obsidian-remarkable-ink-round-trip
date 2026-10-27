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

	const SENTENCE = "The quick brown fox jumps over the lazy dog today.";

	it("applies the tablet's other edits in a paragraph where one word clashes", () => {
		const ours = SENTENCE.replace("lazy", "sleepy");
		const theirs = SENTENCE.replace("quick ", "").replace("lazy ", "");
		const merged = merge3(SENTENCE, ours, theirs);
		expect(merged.conflicts).toBe(1);
		const [text, ...rest] = merged.text.split("\n");
		// "quick" was erased on the tablet and nobody touched it in the vault.
		expect(text).toBe("The brown fox jumps over the sleepy dog today.");
		// The callout shows the tablet's side with the clean edits in.
		expect(rest).toContain("> The brown fox jumps over the dog today.");
	});

	it("does not clash over edits that only touch", () => {
		const ours = SENTENCE.replace("quick", "quick and very");
		const theirs = SENTENCE.replace("brown", "~~brown~~");
		expect(merge3(SENTENCE, ours, theirs)).toEqual({
			text: "The quick and very ~~brown~~ fox jumps over the lazy dog today.",
			conflicts: 0,
		});
	});

	it("keeps a line added in the vault and a remark added at the end on the tablet, the note's first", () => {
		const ours = `${BASE}\n- four`;
		const theirs = `${BASE}\n\n> [!note] Remark\n> call Anna\n> ^ink-aaaaaaaaaaaa`;
		const merged = merge3(BASE, ours, theirs);
		expect(merged.conflicts).toBe(0);
		expect(merged.text).toBe(`${BASE}\n- four\n\n> [!note] Remark\n> call Anna\n> ^ink-aaaaaaaaaaaa`);
		expect(merged.text).not.toContain("> >");
		expect(merged.text).not.toContain("[!warning]");
	});

	it("adds the same insertion from both sides once", () => {
		const both = `${BASE}\n- four`;
		expect(merge3(BASE, both, both)).toEqual({ text: both, conflicts: 0 });
		const ours = `${BASE}\n- four`;
		const theirs = BASE.replace("# Plan", "# ~~Plan~~") + "\n- four";
		expect(merge3(BASE, ours, theirs).text).toBe(theirs);
	});

	it("does not add a clash's callout again when the same versions are merged again", () => {
		const ours = BASE.replace("brown", "red");
		const theirs = BASE.replace("brown", "~~brown~~");
		const first = merge3(BASE, ours, theirs);
		const again = merge3(BASE, first.text, theirs);
		expect(again).toEqual(first);
		expect(first.text.match(/\[!warning\]/g)).toHaveLength(1);
		expect(first.text).toMatch(/^> \^ink-conflict-[0-9a-f]{12}$/m);
	});

	it("does not repeat a clash whose callout the owner edited", () => {
		const ours = BASE.replace("brown", "red");
		const theirs = BASE.replace("brown", "~~brown~~");
		const edited = merge3(BASE, ours, theirs).text.replace("> The quick ~~brown~~ fox", "> The quick ~~brown~~ fox (I prefer red)");
		const again = merge3(BASE, edited, theirs);
		expect(again.text).toBe(edited);
		expect(again.conflicts).toBe(1);
	});

	it("keeps a callout whose clash is gone, rather than losing the tablet's words", () => {
		const ours = BASE.replace("brown", "red");
		const first = merge3(BASE, ours, BASE.replace("brown", "~~brown~~"));
		// The notebook was sent again: the tablet now shows what was sent.
		const after = merge3(BASE, first.text, BASE.replace("- one", "~~- one~~"));
		expect(after.conflicts).toBe(0);
		expect(after.text).toContain("> The quick ~~brown~~ fox");
		expect(after.text).toContain("~~- one~~");
		expect(after.text.match(/\[!warning\]/g)).toHaveLength(1);
	});
});
