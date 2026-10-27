import { describe, expect, it } from "vitest";
import { parseBlocks } from "../convert/mdblocks";
import { inkOptionsFor } from "../ink/inkfonts";
import { DEVICE_PROFILES, InkRender, renderInk, toInkLines } from "../ink/inkrender";
import { buildScenePageRm, INK_AUTHOR, InkLine, SceneItemSpec } from "../ink/rmwrite";
import type { InkSnapshot, MappingEntry } from "../id/mapping";
import { PENDING_TITLE } from "../incoming/annotationnote";
import { collectInkAnnotations } from "../incoming/inkpull";
import type { ImportedMark, PullDeps } from "../incoming/pull";
import { remarkId } from "../incoming/remarkid";
import { preprocess } from "../preprocess/preprocess";
import { mergeTabletChanges, TabletChanges } from "../sync/twoway";

const NOTE = [
	"Some intro words here.",
	"",
	"## Tasks",
	"",
	"- second item",
	"",
	"The quick brown fox jumps over the lazy dog.",
].join("\n");

const SNAPSHOT: InkSnapshot = {
	pageIds: ["page-1"],
	font: "readability",
	fallbackFont: "readability",
	pen: "medium",
	color: 0,
	jitter: 0.5,
	profile: DEVICE_PROFILES.rm2,
	shape: 1,
};

const ENTRY: MappingEntry = {
	docId: "doc-1",
	notePath: "Ink.md",
	deviceDocId: "dev-1",
	uploadedAt: "2026-10-18T00:00:00Z",
	contentHash: "x",
	format: "ink",
	ink: SNAPSHOT,
};

const options = inkOptionsFor(SNAPSHOT, "doc-1", () => null)!;

/** A note sent as a handwritten notebook: what the plugin wrote, and the strokes as lines. */
interface Notebook {
	note: string;
	render: InkRender;
	lines: InkLine[];
}

function notebook(note: string): Notebook {
	const render = renderInk(parseBlocks(preprocess(note).markdown), "Ink", {}, options);
	return { note, render, lines: toInkLines(render.pages[0], options.pen) };
}

const book = notebook(NOTE);
const { render: sent, lines } = book;

const wordOf = (render: InkRender, text: string) => render.layout.lines.flatMap((line) => line.words).find((word) => word.text === text)!;

/** The device box of a word's strokes. */
function boxOf(text: string) {
	const points = sent.pages[0].filter((stroke) => stroke.wordId === wordOf(sent, text).id).flatMap((stroke) => stroke.points);
	return {
		left: Math.min(...points.map((p) => p.x)),
		right: Math.max(...points.map((p) => p.x)),
		top: Math.min(...points.map((p) => p.y)),
		bottom: Math.max(...points.map((p) => p.y)),
	};
}

function userLine(counter: number, points: { x: number; y: number }[]): SceneItemSpec {
	return {
		author: 2,
		counter,
		line: { tool: 15, color: 0, thicknessScale: 2, points: points.map((p) => ({ ...p, width: 16, pressure: 200, speed: 5, direction: 0 })) },
	};
}

/** Three strokes of handwriting in the right margin beside "second item", plus `more` strokes after them. */
function remarkStrokes(more = 0): SceneItemSpec[] {
	const y = boxOf("second").bottom;
	return Array.from({ length: 3 + more }, (_, k) =>
		userLine(800 + k, [
			{ x: 480 + k * 25, y: y - 30 },
			{ x: 480 + k * 25 + 10, y },
			{ x: 480 + k * 25 + 20, y: y - 30 },
		]),
	);
}

type Treat = (stroke: (typeof sent.pages)[0][0], index: number) => SceneItemSpec[] | null;

/**
 * The notebook as sent, with `treat` deciding what became of each of our
 * strokes (null: untouched), `extra` ink of the owner's, read back by the import.
 */
async function readTablet(treat: Treat = () => null, extra: SceneItemSpec[] = [], deps: Partial<PullDeps> = {}, from: Notebook = book) {
	const items: SceneItemSpec[] = from.render.pages[0].flatMap(
		(stroke, index) => treat(stroke, index) ?? [{ author: INK_AUTHOR, counter: stroke.counter, line: from.lines[index] }],
	);
	const page = buildScenePageRm([...items, ...extra], { paperSize: { width: 1404, height: 1872 } });
	const all: PullDeps = {
		listDocumentHashes: async () => new Map([["dev-1", "h"]]),
		listDocumentFiles: async () => [{ id: "dev-1/page-1.rm", hash: "p" }],
		readFile: async () => "{}",
		readBytes: async () => page,
		loadInk: async () => from.render,
		writeAnnotations: async () => undefined,
		...deps,
	};
	const { highlights, marks } = await collectInkAnnotations(ENTRY, "h", all);
	return { layout: from.render.layout, highlights, marks };
}

/** Every stroke of the first word `text` rubbed out. */
const erase = (text: string, from: Notebook = book): Treat => (stroke) =>
	stroke.wordId === wordOf(from.render, text).id ? [{ author: INK_AUTHOR, counter: stroke.counter, deletedLength: 1 }] : null;

/** The notebook as sent, with every stroke of `word` rubbed out on the tablet. */
const tabletChanges = (word: string) => readTablet(erase(word));

const common = { sourcePath: "Ink.md", sourceName: "Ink", importedAt: "2026-10-18 12:00" };
const merge = (changes: Omit<TabletChanges, keyof typeof common | "base" | "ours">, ours: string, extra: Partial<TabletChanges> = {}) =>
	mergeTabletChanges({ ...common, ...changes, base: NOTE, ours, ...extra });

describe("two-way sync", () => {
	it("erases a word in the note itself", async () => {
		const changes = await tabletChanges("quick");
		const { body, outcome } = mergeTabletChanges({ ...common, ...changes, base: NOTE, ours: NOTE });
		expect(body).toContain("The brown fox jumps over the lazy dog.");
		expect(body).not.toContain("quick");
		expect(outcome).toMatchObject({ form: "copy", conflicts: 0 });
	});

	it("keeps a vault edit made while the notebook was out", async () => {
		const changes = await tabletChanges("quick");
		const ours = NOTE.replace("Some intro words here.", "Some new intro words here.").replace(
			"- second item",
			"- second item\n- third item",
		);
		const { body, outcome } = mergeTabletChanges({ ...common, ...changes, base: NOTE, ours });
		expect(body).toContain("Some new intro words here.");
		expect(body).toContain("- third item");
		expect(body).toContain("The brown fox jumps");
		expect(outcome.conflicts).toBe(0);
	});

	it("keeps the note's words where both sides changed them, and says so once", async () => {
		const changes = await tabletChanges("quick");
		const ours = NOTE.replace("quick", "speedy");
		const { body, outcome } = mergeTabletChanges({ ...common, ...changes, base: NOTE, ours });
		expect(body).toContain("The speedy brown fox");
		expect(body).toContain("Also changed on the reMarkable");
		expect(outcome.conflicts).toBe(1);
		// The same import again finds the clash again — and the note as it is.
		const again = mergeTabletChanges({ ...common, ...changes, base: NOTE, ours: body });
		expect(again.body).toBe(body);
		expect(again.body.match(/Also changed on the reMarkable/g)).toHaveLength(1);
	});

	it("falls back to a summary block without a merge base", async () => {
		const changes = await tabletChanges("quick");
		const { body, outcome } = mergeTabletChanges({ ...common, ...changes, base: null, ours: NOTE });
		expect(body.startsWith(NOTE)).toBe(true);
		expect(body).toContain("erased on the reMarkable");
		expect(outcome.form).toBe("summary");
	});

	it("keeps a line added at the end in the vault and a remark written at the end, the note's first", async () => {
		const { layout } = await readTablet();
		const remark: ImportedMark = {
			kind: "note",
			page: 1,
			quote: "The quick brown fox jumps over the lazy dog.",
			transcript: "call Anna",
			id: "aaaaaaaaaaaa",
		};
		const ours = `${NOTE}\n\nA new closing paragraph.`;
		const { body, outcome } = merge({ layout, highlights: [], marks: [remark] }, ours);
		expect(outcome.conflicts).toBe(0);
		expect(body).toBe(`${ours}\n\n> [!note] Remark\n> call Anna\n> ^ink-aaaaaaaaaaaa`);
	});
});

describe("tablet changes the note does not show", () => {
	const jumps = sent.pages[0].filter((stroke) => stroke.wordId === wordOf(sent, "jumps").id).map((stroke) => stroke.counter);
	/** Erased "quick", lassoed "brown" into the empty bottom of the page, rubbed at a corner of "jumps". */
	const edits: Treat = (stroke, index) => {
		if (stroke.wordId === wordOf(sent, "quick").id) return [{ author: INK_AUTHOR, counter: stroke.counter, deletedLength: 1 }];
		if (stroke.wordId === wordOf(sent, "brown").id) {
			return [
				{ author: INK_AUTHOR, counter: stroke.counter, deletedLength: 1 },
				{
					author: 2,
					counter: 600 + index,
					moveFrom: { author: INK_AUTHOR, counter: stroke.counter },
					line: { ...lines[index], points: lines[index].points.map((p) => ({ ...p, y: p.y + 1200 })) },
				},
			];
		}
		const nick = jumps.indexOf(stroke.counter);
		const half = Math.floor(jumps.length / 2);
		if (nick !== -1 && nick < half) return [{ author: INK_AUTHOR, counter: stroke.counter, deletedLength: 1 }];
		if (nick === half) {
			return [
				{ author: INK_AUTHOR, counter: stroke.counter, deletedLength: 1 },
				{ author: 2, counter: 700, line: { ...lines[index], points: lines[index].points.slice(0, Math.ceil(lines[index].points.length / 2)) } },
			];
		}
		return null;
	};

	it("are listed in one pending callout, and the same import again changes nothing", async () => {
		// Handwriting import off: the remark beside "second item" cannot come in.
		const changes = await readTablet(edits, remarkStrokes());
		const { body, outcome } = merge(changes, NOTE);
		expect(body).toContain("The brown fox jumps over the lazy dog.");
		expect(body).not.toContain("quick");
		const callout = body.slice(body.indexOf(PENDING_TITLE)).split("\n");
		expect(callout[callout.length - 1]).toBe("> ^ink-pending");
		expect(callout).toContain("> - Page 1: “brown” moved — not next to any word, so its new place in the text is unclear");
		expect(callout).toContain("> - Page 1: “jumps” partly erased — erase the whole word to remove it");
		expect(callout.some((line) => /^> - Page 1: a handwritten remark near “.*second item.*” — not imported: handwriting import is off$/.test(line))).toBe(true);
		expect(outcome.pending).toHaveLength(3);
		expect(body.match(/\[!info\]/g)).toHaveLength(1);

		const again = merge(changes, body);
		expect(again.body).toBe(body);
		expect(again.outcome.pending).toEqual(outcome.pending);
	});

	it("include a page whose handwriting no longer matches what was sent", async () => {
		const shifted: Treat = (stroke, index) => [
			{ author: INK_AUTHOR, counter: stroke.counter, line: { ...lines[index], points: lines[index].points.map((p) => ({ ...p, x: p.x + 40 })) } },
		];
		const { body } = merge(await readTablet(shifted), NOTE);
		expect(body).toBe(
			`${NOTE}\n\n${PENDING_TITLE}\n` +
				"> Changed on the reMarkable, but not in this note yet — make these changes here, or redo them on the tablet:\n" +
				"> - Page 1: not read — its handwriting no longer matches what was sent, so your changes on it cannot be told apart\n" +
				"> ^ink-pending",
		);
	});

	it("include pages that could not be downloaded", async () => {
		const { body } = merge(await readTablet(erase("quick"), [], { readBytes: undefined }), NOTE);
		expect(body).toContain("> - 1 page(s) not read — they could not be downloaded");
		expect(body).toContain("quick");
	});

	it("include an erase whose words are not in the note", async () => {
		const { layout } = await readTablet();
		const { body, outcome } = merge({ layout, highlights: [], marks: [{ kind: "erased", page: 1, words: [9999], target: "ghost" }] }, NOTE);
		expect(body).toContain("> - Page 1: “ghost” erased — not found in the note");
		expect(outcome.pending).toEqual(["Page 1: “ghost” erased — not found in the note"]);
	});

	it("are gone from the note once nothing is pending, and a note without any is left as it is", async () => {
		const { layout } = await readTablet();
		const listed = merge({ layout, highlights: [], marks: [{ kind: "skipped", page: 1, unapplied: "not read — x" }] }, NOTE).body;
		expect(listed).toContain(PENDING_TITLE);
		expect(merge({ layout, highlights: [], marks: [] }, listed).body).toBe(NOTE);
		expect(merge({ layout, highlights: [], marks: [] }, `${NOTE}\n`).body).toBe(`${NOTE}\n`);
	});
});

describe("a remark the owner wrote more on", () => {
	const reading = { renderStrokes: async (request: { strokes: { points: { x: number; y: number }[] }[] }) => `img/dev-1-p01-${remarkId(request.strokes)}.png` };
	const read = (text: (strokes: number) => string): Partial<PullDeps> => ({
		...reading,
		transcribe: async (request) => ({ text: text(request.strokes.length) }),
	});
	const remarkOf = (marks: ImportedMark[]) => marks.find((mark) => mark.kind === "note")!;

	async function twice(firstText = "check this", edit: (body: string) => string = (body) => body) {
		const words = (n: number) => (n > 3 ? "check this now" : firstText);
		const first = await readTablet(() => null, remarkStrokes(), read(words));
		const old = remarkOf(first.marks);
		const before = edit(merge(first, NOTE).body);
		const second = await readTablet(() => null, remarkStrokes(1), read(words));
		const remarkInk = (id: string) => (id === old.id ? { strokes: old.strokes!, text: firstText } : null);
		return { old, now: remarkOf(second.marks), before, after: merge(second, before, { remarkInk }) };
	}

	it("updates its callout in place: new id, new image, the new reading", async () => {
		const { old, now, before, after } = await twice();
		expect(before).toContain(`> check this\n> ![[img/dev-1-p01-${old.id}.png]]\n> ^ink-${old.id}`);
		expect(now.id).not.toBe(old.id);
		expect(after.body.match(/\[!note\] Remark/g)).toHaveLength(1);
		expect(after.body).toContain(`> [!note] Remark\n> check this now\n> ![[img/dev-1-p01-${now.id}.png]]\n> ^ink-${now.id}`);
		expect(after.body).not.toContain(old.id!);
		expect(after.refreshed).toEqual([now.id]);
	});

	it("keeps the owner's own text for it", async () => {
		const { now, after } = await twice("check this", (body) => body.replace("> check this", "> check this with Anna"));
		expect(after.body.match(/\[!note\] Remark/g)).toHaveLength(1);
		expect(after.body).toContain(`> check this with Anna\n> ![[img/dev-1-p01-${now.id}.png]]\n> ^ink-${now.id}`);
		expect(after.refreshed).toEqual([]);
	});
});

describe("merging again after a merge was written", () => {
	const quickErased = NOTE.replace("quick ", "");

	it("does not bring back a clash over a place the owner edited after the tablet's change went in", async () => {
		const changes = await tabletChanges("quick");
		const first = merge(changes, NOTE);
		expect(first.body).toBe(quickErased);
		expect(first.projected).toBe(quickErased);
		const edited = first.body.replace("The brown fox", "The very brown fox");
		// Merged against the text as sent, "quick" erased clashes with "very" typed in its place.
		expect(merge(changes, edited).outcome.conflicts).toBe(1);
		const again = merge(changes, edited, { mergedBase: first.projected! });
		expect(again.body).toBe(edited);
		expect(again.outcome.conflicts).toBe(0);
	});

	it("applies only what changed on the tablet since", async () => {
		const first = merge(await tabletChanges("quick"), NOTE);
		const edited = first.body.replace("The brown fox", "The very brown fox");
		const both = await readTablet((stroke, index) => erase("quick")(stroke, index) ?? erase("lazy")(stroke, index));
		const again = merge(both, edited, { mergedBase: first.projected! });
		expect(again.body).toBe(edited.replace("lazy ", ""));
		expect(again.outcome.conflicts).toBe(0);
	});

	it("leaves a remark callout it placed as the owner left it: edited, or deleted", async () => {
		const handwriting = { renderStrokes: async () => "img/r.png", transcribe: async () => ({ text: "check this" }) };
		const changes = await readTablet(() => null, remarkStrokes(), handwriting);
		const first = merge(changes, NOTE);
		expect(first.body).toContain("> check this\n> ![[img/r.png]]");
		const edited = first.body.replace("> check this", "> check this with Anna");
		expect(merge(changes, edited, { mergedBase: first.projected! }).body).toBe(edited);
		const id = changes.marks.find((mark) => mark.kind === "note")!.id!;
		const deleted = first.body.replace(new RegExp(`\\n\\n> \\[!note\\] Remark\\n> check this\\n> !\\[\\[img/r.png\\]\\]\\n> \\^ink-${id}`), "");
		expect(deleted).toBe(NOTE);
		expect(merge(changes, deleted, { mergedBase: first.projected! }).body).toBe(NOTE);
	});

	it("merges against the text as sent when a page went unread, rather than undo what came from it", async () => {
		const first = merge(await tabletChanges("quick"), NOTE);
		// "quick" was on the page that could not be read this time.
		const lazy = await tabletChanges("lazy");
		const unread: ImportedMark = { kind: "skipped", page: 1, unapplied: "not read — connection lost", unreadPage: true };
		const again = merge({ ...lazy, marks: [...lazy.marks, unread] }, first.body, { mergedBase: first.projected! });
		expect(again.body.startsWith(quickErased.replace("lazy ", ""))).toBe(true);
		expect(again.projected).toBeNull();
	});
});

describe("two equal lines", () => {
	const twin = notebook("- [ ] call mum today\n- [ ] call mum today");

	it("keeps the owner's edit of the second next to the tablet's erase in the first", async () => {
		const changes = await readTablet(erase("mum", twin), [], {}, twin);
		const ours = "- [ ] call mum today\n- [ ] call mum today and dad";
		const first = mergeTabletChanges({ ...common, ...changes, base: twin.note, ours, erasedAs: "strikethrough" });
		expect(first.body).toBe("- [ ] call ~~mum~~ today\n- [ ] call mum today and dad");
		expect(first.outcome.conflicts).toBe(0);
		for (const mergedBase of [undefined, first.projected!]) {
			const again = mergeTabletChanges({ ...common, ...changes, base: twin.note, ours: first.body, erasedAs: "strikethrough", mergedBase });
			expect(again.body).toBe(first.body);
		}
	});
});
