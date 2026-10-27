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

	it("makes an edit of one of two equal lines a replacement of that line", () => {
		// Plain Myers matched the first line to the second: "insert before
		// line 1, delete line 2" — which let the other side's edit of line 2
		// cut the owner's line apart without a clash.
		expect(diffHunks(["same", "same"], ["edited", "same"])).toEqual([{ oStart: 0, oEnd: 1, xStart: 0, xEnd: 1, side: "ours" }]);
		expect(diffHunks(["same", "same"], ["same", "edited"])).toEqual([{ oStart: 1, oEnd: 2, xStart: 1, xEnd: 2, side: "ours" }]);
		expect(diffHunks(["a", "same", "same", "b"], ["a", "same", "same 2", "b"])).toEqual([
			{ oStart: 2, oEnd: 3, xStart: 2, xEnd: 3, side: "ours" },
		]);
	});

	it("slides a lone insertion among equal lines as far down as it goes", () => {
		expect(diffHunks(["x", "", "y"], ["x", "", "", "y"])).toEqual([{ oStart: 2, oEnd: 2, xStart: 2, xEnd: 3, side: "ours" }]);
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

describe("merge3 at the edges of what one side removed", () => {
	const BASE3 = "a\nfoo bar\nc";

	it("clashes on words added to a line the other side removed, instead of leaving them stranded", () => {
		for (const [ours, theirs] of [
			["a\nfoo bar baz\nc", "a\nc"],
			["a\nc", "a\nfoo bar baz\nc"],
			["a\nbaz foo bar\nc", "a\nc"],
		]) {
			const merged = merge3(BASE3, ours, theirs);
			expect(merged.conflicts).toBe(1);
			expect(merged.text).not.toMatch(/^ ?baz ?$/m);
		}
		// The note's words stay, the tablet's removal is shown.
		const kept = merge3(BASE3, "a\nfoo bar baz\nc", "a\nc").text;
		expect(kept.startsWith("a\nfoo bar baz\n\n> [!warning] Also changed on the reMarkable\n> *(removed there)*\n")).toBe(true);
	});

	it("still merges an erased word next to an edit of the word beside it", () => {
		const base = "The quick brown fox.";
		expect(merge3(base, "The quick red fox.", "The brown fox.")).toEqual({ text: "The red fox.", conflicts: 0 });
	});
});

describe("merge3 with lines that repeat", () => {
	it("keeps the owner's edit of the second of two equal lines next to the tablet's of the first", () => {
		const base = "- [ ] call mum today\n- [ ] call mum today";
		const ours = "- [ ] call mum today\n- [ ] call mum today and dad";
		const theirs = "- [ ] call ~~mum~~ today\n- [ ] call mum today";
		const merged = merge3(base, ours, theirs);
		expect(merged).toEqual({ text: "- [ ] call ~~mum~~ today\n- [ ] call mum today and dad", conflicts: 0 });
		expect(merge3(base, merged.text, theirs)).toEqual(merged);
	});
});

describe("merge3 run again on its own result", () => {
	it("does not apply the tablet's change on top of itself", () => {
		const base = "Buy milk today.";
		const theirs = "Buy ~~milk~~ today.";
		const first = merge3(base, "Buy oat milk today.", theirs);
		expect(first).toEqual({ text: "Buy oat ~~milk~~ today.", conflicts: 0 });
		expect(merge3(base, first.text, theirs)).toEqual(first);
	});

	it("does not add the tablet's line a second time after the owner's", () => {
		const first = merge3("a\nb", "a\nb\nmine", "a\nb\ntheirs");
		expect(first.text).toBe("a\nb\nmine\ntheirs");
		expect(merge3("a\nb", first.text, "a\nb\ntheirs")).toEqual(first);
	});

	it("still clashes when the tablet's change is missing from the owner's text", () => {
		expect(merge3("Buy milk today.", "Buy oat today.", "Buy ~~milk~~ today.").conflicts).toBe(1);
	});
});

describe("merge3 with the same clash twice", () => {
	const base = "Same words here.\n\nBetween.\n\nSame words here.";
	const ours = base.replace(/words/g, "lines");
	const theirs = base.replace(/words/g, "~~words~~");

	it("gives each callout its own block id", () => {
		const merged = merge3(base, ours, theirs);
		expect(merged.conflicts).toBe(2);
		const ids = merged.text.match(/\^ink-conflict-[0-9a-f-]+/g) ?? [];
		expect(ids).toHaveLength(2);
		expect(new Set(ids).size).toBe(2);
		expect(merge3(base, merged.text, theirs)).toEqual(merged);
	});

	it("keeps the other callout when the owner edits one", () => {
		const merged = merge3(base, ours, theirs).text;
		const at = merged.lastIndexOf("> Same ~~words~~ here.");
		const edited = `${merged.slice(0, at)}> Same ~~words~~ here. (fine as it is)${merged.slice(at + "> Same ~~words~~ here.".length)}`;
		const again = merge3(base, edited, theirs);
		expect(again.text).toBe(edited);
		expect(again.text.match(/\[!warning\]/g)).toHaveLength(2);
	});
});
