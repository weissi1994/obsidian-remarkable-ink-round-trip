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
import type { DocumentFile, ImportedMark, PullDeps, StrokeRenderRequest } from "../incoming/pull";
import { findRemark, remarkId } from "../incoming/remarkid";
import { blockEnd, joinBlocks, placeAfterBlocks } from "../incoming/sourceprojection";
import { inkOptionsFor } from "../ink/inkfonts";
import { inkStrokesOf } from "../ink/inkimage";
import { DEVICE_PROFILES, inkPagesToRm, renderInk, type InkRender } from "../ink/inkrender";
import { corrections, emptyStore, isReadingText, knownText, learnFromNotes, notedReadings, withEarlierReadings, type RemarkRecord } from "../ocr/samples";
import { preprocess, splitNote, type EmbedResolver } from "../preprocess/preprocess";
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

async function importPage(render: InkRender, page: Uint8Array, transcribe: PullDeps["transcribe"] = async (request) => ({ text: `reading of ${request.strokes.length} strokes` }), requests: StrokeRenderRequest[] = []): Promise<ImportedMark[]> {
	const files = new Map([["dev/page-1.rm", page]]);
	const deps: PullDeps = {
		listDocumentHashes: async () => new Map(),
		listDocumentFiles: async () => [...files.keys()].map((id) => ({ id, hash: id })),
		readFile: async (file: DocumentFile) => new TextDecoder().decode(files.get(file.id)),
		readBytes: async (file: DocumentFile) => files.get(file.id)!,
		loadInk: async () => render,
		writeAnnotations: async () => undefined,
		renderStrokes: async (request) => {
			requests.push(request);
			return `handwriting/dev-p01-${remarkId(request.strokes)}.png`;
		},
		transcribe,
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

describe("handwriting where it was written (inline), the first device test again", () => {
	const SENT = "2026-10-27T22:49:49+01:00";
	const READINGS: Record<number, string> = { 3: "YAY", 4: "What", 12: "Hi da is er ja endlich" };
	const base = splitNote(note(SENT)).body;

	/** The device test's page: a tick on each task, a word in a cell, a word on the empty task, a sentence below. */
	async function deviceTest(confident: (letters: number) => boolean) {
		const sent = send(note(SENT));
		const { layout } = sent.render;
		const page = new TabletPage(sent.book, 1);
		const task = lineWith(layout, (line) => line.text.startsWith("checklist"));
		const empty = lineWith(layout, (line) => line.checkbox !== undefined && line.words.length === 0);
		const row = lineWith(layout, (line) => line.text.trim() === "row");
		page.tick(task).tick(empty);
		page.write(...writing(layout, row.x + row.words[0].width + 8, row.y + 11, 3));
		page.write(...writing(layout, empty.checkbox!.x + 25, empty.y + 11, 4));
		page.write(...writing(layout, 44, empty.y - 22, 12));
		const requests: StrokeRenderRequest[] = [];
		const marks = await importPage(
			sent.render,
			page.bytes(),
			async (request) => ({ text: READINGS[request.strokes.length], confident: confident(request.strokes.length) }),
			requests,
		);
		const idOf = (letters: number) => remarkId(requests.find((request) => request.strokes.length === letters)!.strokes);
		return { sent, marks, requests, cell: idOf(3), task: idOf(4), free: idOf(12) };
	}

	const merge = (layout: PdfLayout, marks: ImportedMark[], ours: string, mergedBase?: string) =>
		mergeTabletChanges({
			base,
			ours,
			layout,
			highlights: [],
			marks,
			erasedAs: "delete",
			sourcePath: "Projects/Test Sync.md",
			sourceName: "Test Sync",
			importedAt: "2026-10-27 21:57",
			remarksForm: "inline",
			...(mergedBase === undefined ? {} : { mergedBase }),
		});

	it("puts confident readings in the cell, on the empty task and as a paragraph below — no callout", async () => {
		const { sent, marks, cell, task, free } = await deviceTest(() => true);
		const merged = merge(sent.render.layout, marks, base);
		expect(merged.body).toBe(
			[
				"",
				"| Test | Table |",
				"| ---- | ----- |",
				`| with | row YAY%%ink-${cell}%% |`,
				"- [x] checklist⏫ ",
				`- [x] What%%ink-${task}%%`,
				"",
				`Hi da is er ja endlich%%ink-${free}%%`,
			].join("\n"),
		);
		expect(merged.outcome.conflicts).toBe(0);
		// The table stays a table, the list a list.
		const rows = parseBlocks(merged.body, { html: true });
		expect(rows.map((block) => block.type)).toEqual(["table", "list", "paragraph"]);
	});

	it("puts the ink in those places when it could not be read with confidence", async () => {
		const { sent, marks, cell, task, free } = await deviceTest((letters) => letters === 4);
		const lines = merge(sent.render.layout, marks, base).body.split("\n");
		const image = (id: string, pipe: string) => `!\\[\\[handwriting/dev-p01-${id}\\.png${pipe}\\d+\\]\\]%%ink-${id}%%`;
		expect(lines[3]).toMatch(new RegExp(`^\\| with \\| row ${image(cell, "\\\\\\|")} \\|$`));
		expect(lines[5]).toBe(`- [x] What%%ink-${task}%%`);
		expect(lines[7]).toMatch(new RegExp(`^${image(free, "\\|")}$`));
		expect(lines.some((line) => line.startsWith(">"))).toBe(false);
	});

	it("changes nothing when the same page is read again, against what the merge kept or what was sent", async () => {
		for (const confident of [() => true, () => false]) {
			const { sent, marks } = await deviceTest(confident);
			const first = merge(sent.render.layout, marks, base);
			expect(merge(sent.render.layout, marks, first.body, first.projected!).body).toBe(first.body);
			expect(merge(sent.render.layout, marks, first.body).body).toBe(first.body);
		}
	});

	it("keeps an edit the owner made, and lets an untouched reading give way to a better one", async () => {
		const { sent, marks, cell, task } = await deviceTest(() => true);
		const first = merge(sent.render.layout, marks, base);
		const edited = first.body.replace(`What%%ink-${task}%%`, `What now?%%ink-${task}%%`);
		const reread = marks.map((mark) =>
			mark.id === cell ? { ...mark, transcript: "YAY!", replaces: "YAY" } : mark.id === task ? { ...mark, transcript: "Wheat", replaces: "What" } : mark,
		);
		const again = merge(sent.render.layout, reread, edited, first.projected!);
		expect(again.body).toContain(`| with | row YAY!%%ink-${cell}%% |`);
		expect(again.body).toContain(`- [x] What now?%%ink-${task}%%`);
		expect(again.refreshed).toEqual([cell]);
	});

	it("replaces the ink with text once a reading is confident", async () => {
		const unsure = await deviceTest(() => false);
		const first = merge(unsure.sent.render.layout, unsure.marks, base);
		const sure = unsure.marks.map((mark) => (mark.kind === "note" ? { ...mark, confident: true } : mark));
		const again = merge(unsure.sent.render.layout, sure, first.body, first.projected!);
		expect(again.body).toContain(`| with | row YAY%%ink-${unsure.cell}%% |`);
		expect(again.body).toContain(`Hi da is er ja endlich%%ink-${unsure.free}%%`);
		expect(again.body).not.toContain("![[");
	});

	it("sends text taken in as text, and ink still shown as an image back as the owner's strokes where they were", async () => {
		const confident = await deviceTest(() => true);
		const withText = preprocess(`---\nremarkable-id: doc\n---\n${merge(confident.sent.render.layout, confident.marks, base).body}`).markdown;
		expect(withText).not.toContain("%%");
		expect(withText).toContain("| with | row YAY |");
		const typeset = renderInk(parseBlocks(withText, { html: true, quotePictures: true, nestedQuotes: true }), "Test Sync", LAYOUT, OPTIONS);
		expect(typeset.layout.lines.map((line) => line.text)).toEqual(expect.arrayContaining(["row YAY", "What", "Hi da is er ja endlich"]));
		expect(typeset.layout.remarksInPlace).toBeUndefined();

		const unsure = await deviceTest(() => false);
		const body = merge(unsure.sent.render.layout, unsure.marks, base).body;
		const names = [unsure.cell, unsure.task, unsure.free].map((id) => `dev-p01-${id}.png`);
		// Sent as the first send was: frontmatter as a title block.
		const sendText = (text: string, resolveEmbed?: EmbedResolver) => preprocess(`---\nmodified: ${SENT}\nremarkable-id: doc\n---\n${text}`, { frontmatterAsTitleBlock: true, resolveEmbed }).markdown;
		const markdown = sendText(body, (target) => ({ kind: "image", name: target, inPlace: true }));
		for (const name of names) expect(markdown).toContain(`*[remark: ${name}]*`);
		expect(markdown).toContain("| with | row |");
		const images = Object.fromEntries(
			unsure.requests.map((request) => [`dev-p01-${remarkId(request.strokes)}.png`, { ...inkStrokesOf(request.strokes, DEVICE_PROFILES.move.dpi)!, at: request.at }]),
		);
		const parse = (text: string) => parseBlocks(text, { html: true, quotePictures: true, nestedQuotes: true });
		const back = renderInk(parse(markdown), "Test Sync", LAYOUT, { ...OPTIONS, images });
		const plain = renderInk(parse(sendText(body.replace(/ ?!\[\[[^\]]*\]\]%%ink-[0-9a-f]+%%/g, ""))), "Test Sync", LAYOUT, OPTIONS);
		expect([...(back.layout.remarksInPlace ?? [])].sort()).toEqual([...names].sort());
		expect(back.layout.lines.map((line) => line.text)).toEqual(plain.layout.lines.map((line) => line.text));
		// Exactly the owner's strokes come back on top: 3 in the cell, 4 on the task, 12 below.
		expect(back.pages[0].length - plain.pages[0].length).toBe(19);
		const box = (points: { x: number; y: number }[]) => [Math.min(...points.map((p) => p.x)), Math.min(...points.map((p) => p.y)), Math.max(...points.map((p) => p.x)), Math.max(...points.map((p) => p.y))];
		const drawn = box(back.pages[0].slice(plain.pages[0].length).flatMap((stroke) => stroke.points));
		const written = box(unsure.requests.flatMap((request) => request.strokes.flatMap((stroke) => stroke.points)));
		drawn.forEach((value, i) => expect(Math.abs(value - written[i])).toBeLessThan(3));
	});

	it("learns from the owner fixing taken-in text, and from text typed in place of the ink", async () => {
		const { sent, marks, requests, cell, free } = await deviceTest((letters) => letters !== 12);
		const body = merge(sent.render.layout, marks, base).body;
		const store = emptyStore();
		const strokesOf = (id: string) => requests.find((request) => remarkId(request.strokes) === id)!.strokes.map((stroke) => stroke.points.map(({ x, y }) => ({ x, y })));
		for (const id of [cell, free]) store.remarks[id] = { strokes: strokesOf(id), transcript: "unsure reading", read: "unsure reading", at: "2026-10-27T21:57:00Z", note: "Projects/Test Sync.md" };
		// After the write: what the note shows is the plugin's.
		notedReadings(store, marks, body);
		expect(store.remarks[cell].transcript).toBe("YAY");
		expect(store.remarks[free].transcript).toBe("");
		const fixed = body
			.replace(`row YAY%%ink-${cell}%%`, `row YEAH%%ink-${cell}%%`)
			.replace(/!\[\[[^\]]*\]\](%%ink-[0-9a-f]+%%)$/, "Hi there is one at last$1");
		learnFromNotes(store, () => fixed);
		expect(store.remarks[cell]).toMatchObject({ transcript: "YEAH", corrected: true });
		expect(store.remarks[free]).toMatchObject({ transcript: "Hi there is one at last", corrected: true });
	});

	it("leaves a note's remark callouts from before as they are", async () => {
		const { sent, marks } = await deviceTest(() => true);
		const classic = mergeTabletChanges({
			base,
			ours: base,
			layout: sent.render.layout,
			highlights: [],
			marks,
			erasedAs: "delete",
			sourcePath: "Projects/Test Sync.md",
			sourceName: "Test Sync",
			importedAt: "2026-10-27 21:57",
		});
		expect(classic.body.split("\n").filter((line) => line.startsWith("> [!note] Remark"))).toHaveLength(3);
		const inline = merge(sent.render.layout, marks, classic.body, classic.projected!);
		expect(inline.body).toBe(classic.body);
	});
});
