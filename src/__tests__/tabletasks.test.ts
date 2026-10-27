/**
 * The first real-device test of two-way sync, rebuilt synthetically: a table
 * a task list follows straight on, its last task empty, a frontmatter
 * timestamp shown as a title block and rewritten by another plugin between
 * syncs. On the tablet: a tick, a word in a table cell, a word after the
 * empty task, a sentence below it all.
 */
import { describe, expect, it } from "vitest";
import { parseBlocks } from "../convert/mdblocks";
import type { LaidOutLine, PdfLayout } from "../convert/pdf";
import type { InkSnapshot, MappingEntry } from "../id/mapping";
import { collectInkAnnotations } from "../incoming/inkpull";
import { rowsOf } from "../incoming/marks";
import type { DocumentFile, ImportedMark, PullDeps } from "../incoming/pull";
import { findRemark, remarkId } from "../incoming/remarkid";
import { blockEnd, joinBlocks, placeAfterBlocks } from "../incoming/sourceprojection";
import { inkOptionsFor } from "../ink/inkfonts";
import { DEVICE_PROFILES, inkPagesToRm, renderInk, type InkRender } from "../ink/inkrender";
import { corrections, emptyStore, isReadingText, knownText, learnFromNotes, withEarlierReadings, type RemarkRecord } from "../ocr/samples";
import { preprocess, splitNote } from "../preprocess/preprocess";
import { mergeTabletChanges } from "../sync/twoway";
import { notebookOf, penLine, TabletPage, toDevice } from "./helpers/tabletedits";

const SNAPSHOT: InkSnapshot = {
	pageIds: ["page-1"],
	font: "readability",
	fallbackFont: "readability",
	pen: "medium",
	color: 0,
	jitter: 0.3,
	profile: DEVICE_PROFILES.move,
	shape: 1,
	imageStyle: "colour-hatch",
};
const OPTIONS = inkOptionsFor(SNAPSHOT, "doc", () => null)!;
const LAYOUT = { fontSize: 14, lineHeight: 1.6, margin: 40 };
const BODY = ["", "| Test | Table |", "| ---- | ----- |", "| with | row   |", "- [ ] checklist⏫ ", "- [ ] "].join("\n");
const note = (modified: string) => `---\nmodified: ${modified}\nremarkable-id: doc\n---\n${BODY}`;

/** A send: the note preprocessed with its frontmatter as a title block, typeset as handwriting. */
function send(text: string, typo?: number) {
	const markdown = preprocess(text, { frontmatterAsTitleBlock: true }).markdown;
	const render = renderInk(parseBlocks(markdown, { html: true, quotePictures: true, nestedQuotes: true }), "Test Sync", { ...LAYOUT, ...(typo === undefined ? {} : { typo }) }, OPTIONS);
	return { markdown, render, book: notebookOf(render, OPTIONS), files: inkPagesToRm(render, OPTIONS) };
}

/** Handwriting in a box (PDF points, y up): open zigzags, a letter each, no shape a mark is read from. */
function writing(layout: PdfLayout, left: number, top: number, letters: number, height = 12) {
	return Array.from({ length: letters }, (_, i) => {
		const x = left + i * 9;
		const points = [
			{ x, y: top },
			{ x: x + 2, y: top - height },
			{ x: x + 4, y: top - height * 0.4 },
			{ x: x + 6, y: top - height },
			{ x: x + 7, y: top - 1 },
		];
		return penLine(points.map((point) => toDevice(layout, point)));
	});
}

const ENTRY = { docId: "doc", deviceDocId: "dev", notePath: "Projects/Test Sync.md", format: "ink", ink: SNAPSHOT } as unknown as MappingEntry;

async function importPage(render: InkRender, page: Uint8Array): Promise<ImportedMark[]> {
	const files = new Map([["dev/page-1.rm", page]]);
	const deps: PullDeps = {
		listDocumentHashes: async () => new Map(),
		listDocumentFiles: async () => [...files.keys()].map((id) => ({ id, hash: id })),
		readFile: async (file: DocumentFile) => new TextDecoder().decode(files.get(file.id)),
		readBytes: async (file: DocumentFile) => files.get(file.id)!,
		loadInk: async () => render,
		writeAnnotations: async () => undefined,
		renderStrokes: async (request) => `handwriting/dev-p01-${remarkId(request.strokes)}.png`,
		transcribe: async (request) => ({ text: `reading of ${request.strokes.length} strokes` }),
	};
	return (await collectInkAnnotations(ENTRY, "h", deps)).marks;
}

const lineWith = (layout: PdfLayout, test: (line: LaidOutLine) => boolean) => {
	const line = layout.lines.find(test);
	if (line === undefined) throw new Error("line not laid out");
	return line;
};

describe("a table a task list follows straight on, its last task empty (first device test)", () => {
	it("typesets the empty task as its box, not as the text “[ ]”; older sends replay the text", () => {
		const now = send(note("2026-10-27T22:49:49+01:00")).render.layout;
		const boxes = now.lines.filter((line) => line.checkbox !== undefined);
		expect(boxes.map((line) => line.text)).toEqual(["checklist?", ""]);
		expect(now.lines.some((line) => line.text.includes("[ ]"))).toBe(false);
		const old = send(note("2026-10-27T22:49:49+01:00"), 10).render.layout;
		expect(old.lines.filter((line) => line.checkbox !== undefined)).toHaveLength(1);
		expect(rowsOf(old, 1).map((row) => row.text)).toContain("[ ]");
	});

	it("brings the tick, the cell remark, the remark on the empty task and the sentence below each to its place", async () => {
		const sent = send(note("2026-10-27T22:49:49+01:00"));
		const { layout } = sent.render;
		const page = new TabletPage(sent.book, 1);
		const task = lineWith(layout, (line) => line.text.startsWith("checklist"));
		const empty = lineWith(layout, (line) => line.checkbox !== undefined && line.words.length === 0);
		const row = lineWith(layout, (line) => line.text.trim() === "row");
		page.tick(task);
		page.tick(empty);
		// In the table's second row, after its last word.
		page.write(...writing(layout, row.x + row.words[0].width + 8, row.y + 11, 3));
		// On the empty task's line, right of its box.
		page.write(...writing(layout, empty.checkbox!.x + 25, empty.y + 11, 4));
		// Free, a line and a half below the last task.
		page.write(...writing(layout, 44, empty.y - 22, 12));

		const marks = await importPage(sent.render, page.bytes());
		const notes = marks.filter((mark) => mark.kind === "note");
		// Three writings in three places: three remarks, the one on the empty task knowing it is.
		expect(notes).toHaveLength(3);
		expect(notes.filter((mark) => mark.task !== undefined)).toHaveLength(1);
		expect(marks.filter((mark) => mark.kind === "checkbox")).toHaveLength(2);

		// The timestamp plugin rewrote the frontmatter since the send.
		const current = note("2026-10-27T22:53:25+01:00");
		const { head, body: ours } = splitNote(current);
		const merged = mergeTabletChanges({
			base: splitNote(note("2026-10-27T22:49:49+01:00")).body,
			ours,
			layout,
			highlights: [],
			marks,
			erasedAs: "delete",
			sourcePath: "Projects/Test Sync.md",
			sourceName: "Test Sync",
			importedAt: "2026-10-27 21:57",
		});
		const lines = merged.body.split("\n");
		const ids = notes.map((mark) => `> ^ink-${mark.id}`);
		const cell = notes.find((mark) => mark.quote === "with row")!;
		expect(cell).toBeDefined();
		// The cell's remark goes after the table, before the list; the other two after the list.
		expect(lines.slice(0, 5)).toEqual(["", "| Test | Table |", "| ---- | ----- |", "| with | row   |", ""]);
		expect(lines[5]).toBe("> [!note] Remark");
		expect(lines.indexOf(`> ^ink-${cell.id}`)).toBeLessThan(lines.indexOf("- [x] checklist⏫ "));
		expect(lines).toContain("- [x] ");
		expect(lines.indexOf("- [x] ")).toBeLessThan(Math.min(...ids.filter((id) => id !== `> ^ink-${cell.id}`).map((id) => lines.indexOf(id))));
		// Every callout stands apart: a blank line before each, and a blank line after unless the note ends.
		lines.forEach((line, at) => {
			if (line.startsWith("> [!note]")) expect(lines[at - 1]).toBe("");
			if (ids.includes(line.trimEnd()) && at + 1 < lines.length) expect(lines[at + 1]).toBe("");
		});
		expect(merged.body.split("\n").filter((line) => line.startsWith("> [!note]"))).toHaveLength(3);
		expect(lines.some((line) => line.startsWith("> >"))).toBe(false);
		expect(head).toContain("22:53:25");

		// The same pages read again against what this merge wrote: nothing changes.
		const again = mergeTabletChanges({
			base: splitNote(note("2026-10-27T22:49:49+01:00")).body,
			mergedBase: merged.projected ?? undefined,
			ours: merged.body,
			layout,
			highlights: [],
			marks,
			erasedAs: "delete",
			sourcePath: "Projects/Test Sync.md",
			sourceName: "Test Sync",
			importedAt: "2026-10-27 22:10",
		});
		expect(again.body).toBe(merged.body);
	});

	it("reads a word written on a row and a sentence below it as two remarks, on a send from before empty boxes", async () => {
		const sent = send(note("2026-10-27T22:49:49+01:00"), 10);
		const { layout } = sent.render;
		const empty = lineWith(layout, (line) => line.text.trim() === "[ ]");
		const end = empty.words[empty.words.length - 1];
		const page = new TabletPage(sent.book, 1).write(...writing(layout, end.x + end.width + 12, empty.y + 11, 4), ...writing(layout, 44, empty.y - 22, 12));
		const notes = (await importPage(sent.render, page.bytes())).filter((mark) => mark.kind === "note");
		expect(notes.map((mark) => mark.strokes?.length)).toEqual([4, 12]);
	});

	it("keeps a remark of two lines written in free space together", async () => {
		const sent = send(note("2026-10-27T22:49:49+01:00"));
		const { layout } = sent.render;
		const empty = lineWith(layout, (line) => line.checkbox !== undefined && line.words.length === 0);
		const page = new TabletPage(sent.book, 1).write(...writing(layout, 44, empty.y - 22, 6), ...writing(layout, 44, empty.y - 40, 6));
		const notes = (await importPage(sent.render, page.bytes())).filter((mark) => mark.kind === "note");
		expect(notes).toHaveLength(1);
		expect(notes[0].task).toBeUndefined();
	});
});

describe("where a remark's callout goes", () => {
	it("ends a table at its last row when a list follows straight on", () => {
		const lines = ["| a | b |", "| - | - |", "| c | d |", "- [ ] task", "- [ ] other", "", "After."];
		expect(blockEnd(lines, 0)).toBe(2);
		expect(blockEnd(lines, 2)).toBe(2);
		expect(blockEnd(lines, 3)).toBe(4);
	});

	it("sets a callout placed between a table and its list apart on both sides", () => {
		const placed = placeAfterBlocks(["| a |", "| - |", "| c |", "- [ ] task"], new Map([[2, ["> [!note] Remark", "> ^ink-0123456789ab"]]]));
		expect(placed).toBe("| a |\n| - |\n| c |\n\n> [!note] Remark\n> ^ink-0123456789ab\n\n- [ ] task");
	});

	it("keeps two callouts in one place apart: glued, they are one callout", () => {
		expect(joinBlocks(["> [!note] Remark", "> ^ink-aaaaaaaaaaaa"], ["> [!note] Remark", "> ^ink-bbbbbbbbbbbb"])).toEqual([
			"> [!note] Remark",
			"> ^ink-aaaaaaaaaaaa",
			"",
			"> [!note] Remark",
			"> ^ink-bbbbbbbbbbbb",
		]);
	});
});

describe("a remark's text when callouts ran into one another", () => {
	// A clash callout quoting glued remark callouts, as an earlier import wrote one.
	const NOTE = [
		"> [!warning] Also changed on the reMarkable",
		"> ",
		"> > [!note] Remark",
		"> > s",
		"> > ![[handwriting/x-p01-111111111111.png]]",
		"> > ^ink-111111111111",
		"> > [!note] Remark",
		"> > ![[handwriting/x-p01-222222222222.png]]",
		"> > ^ink-222222222222",
		"> > [!note] Remark",
		"> > «",
		"> > ^ink-333333333333",
	].join("\n");

	it("reads a nested callout at its own depth: its lines only, no neighbour's title or reading", () => {
		expect(findRemark(NOTE, { id: "111111111111" })).toMatchObject({ titled: true, text: "s" });
		expect(findRemark(NOTE, { id: "222222222222" })).toMatchObject({ titled: true, text: "" });
		expect(findRemark(NOTE, { id: "333333333333" })).toMatchObject({ titled: true, text: "«" });
	});

	it("learns no correction from it, and never offers note structure as a worked example", () => {
		const store = emptyStore();
		const record = (transcript: string, over: Partial<RemarkRecord> = {}): RemarkRecord => ({ strokes: [[{ x: 0, y: 0 }, { x: 5, y: 5 }]], transcript, at: "2026-10-20T10:00:00Z", note: "Test.md", ...over });
		store.remarks["222222222222"] = record("");
		const poisoned = "> [!note] Remark\n> s\n> [!note] Remark";
		store.remarks["999999999999"] = record(poisoned, { corrected: true });
		store.remarks["888888888888"] = record("YAY", { corrected: true, at: "2026-10-19T10:00:00Z" });
		learnFromNotes(store, () => NOTE);
		expect(store.remarks["222222222222"].corrected).toBeUndefined();
		expect(corrections(store).map(([key]) => key)).toEqual(["888888888888"]);
		expect(knownText(store, "999999999999")).toBeNull();
		expect(isReadingText(poisoned)).toBe(false);
		expect(isReadingText("What?\nHi da is er ja endlich")).toBe(true);
		// The callout showing it takes a new reading.
		expect(withEarlierReadings(store, [{ kind: "note", id: "999999999999", transcript: "Hi" }])[0].replaces).toBe(poisoned);
	});
});
