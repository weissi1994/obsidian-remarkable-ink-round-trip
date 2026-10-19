import { beforeAll, describe, expect, it } from "vitest";
import { parseBlocks } from "../convert/mdblocks";
import { PdfLayout } from "../convert/pdf";
import { renderPdf } from "./helpers/pdfrender";
import { preprocess } from "../preprocess/preprocess";
import { mergeTabletChanges, settleRemarks } from "../sync/twoway";
import type { ImportedMark } from "../incoming/pull";

/*
 * Every import reads the whole notebook again. A remark the note already
 * shows — its text perhaps corrected by the owner — must come through that
 * untouched: no second copy, no conflict offering the old reading again.
 */

const SOURCE = ["First paragraph with some words.", "", "Second paragraph with other words.", "", "Third one here."].join("\n");
let layout: PdfLayout;
beforeAll(async () => {
	const pre = preprocess(SOURCE, { resolveEmbed: () => ({ kind: "missing" }) });
	layout = (await renderPdf(parseBlocks(pre.markdown), { title: "T", docId: "d" })).layout;
});

const common = { sourcePath: "T.md", sourceName: "T", importedAt: "2026-10-19 12:00", highlights: [] };
const misread: ImportedMark = {
	kind: "note",
	page: 1,
	quote: "First paragraph with some words.",
	path: "img/dev-p01-aaaaaaaaaaaa.png",
	id: "aaaaaaaaaaaa",
	transcript: "helo wrld",
};
const another: ImportedMark = {
	kind: "note",
	page: 1,
	quote: "Third one here.",
	path: "img/dev-p01-bbbbbbbbbbbb.png",
	id: "bbbbbbbbbbbb",
	transcript: "second remark",
};

const copy = (ours: string, marks: ImportedMark[]) =>
	mergeTabletChanges({ ...common, layout, marks, base: SOURCE, ours });
const summary = (ours: string, marks: ImportedMark[]) =>
	mergeTabletChanges({ ...common, layout: null, marks, base: null, ours });
const count = (text: string, part: string) => text.split(part).length - 1;

describe("a remark the note already has (annotated copy)", () => {
	it("keeps the owner's correction through the next import", () => {
		const first = copy(SOURCE, [misread]).body;
		expect(first).toContain("> helo wrld");
		const corrected = first.replace("helo wrld", "hello world");

		const again = copy(corrected, [misread]);
		expect(again.body).toBe(corrected);
		expect(again.outcome.conflicts).toBe(0);
	});

	it("still places a new remark, once, next to the corrected one", () => {
		const corrected = copy(SOURCE, [misread]).body.replace("helo wrld", "hello world");
		const { body, outcome } = copy(corrected, [misread, another]);
		expect(outcome.conflicts).toBe(0);
		expect(body).toContain("> hello world");
		expect(body).not.toContain("helo wrld");
		expect(count(body, "^ink-aaaaaaaaaaaa")).toBe(1);
		expect(count(body, "> second remark")).toBe(1);
	});

	it("leaves a remark where the owner moved it", () => {
		const first = copy(SOURCE, [misread]).body;
		const callout = first.slice(first.indexOf("> [!note]"), first.indexOf("^ink-aaaaaaaaaaaa") + 17);
		const moved = `${first.replace(`${callout}\n\n`, "")}\n\n${callout}`;
		const { body, outcome } = copy(moved, [misread]);
		expect(body).toBe(moved);
		expect(outcome.conflicts).toBe(0);
	});

	it("fills in a remark that came back as an image only, once it can be read", () => {
		const unread = { ...misread, transcript: undefined };
		const first = copy(SOURCE, [unread]).body;
		expect(first).not.toContain("helo");
		const { body, refreshed } = copy(first, [{ ...misread, transcript: "hello world", replaces: "" }]);
		expect(refreshed).toEqual(["aaaaaaaaaaaa"]);
		const lines = body.split("\n");
		const title = lines.indexOf("> [!note] Remark");
		expect(lines.slice(title, title + 4)).toEqual([
			"> [!note] Remark",
			"> hello world",
			"> ![[img/dev-p01-aaaaaaaaaaaa.png]]",
			"> ^ink-aaaaaaaaaaaa",
		]);
	});

	it("finds a remark from before ids by its image, and gives it its id", () => {
		const old = copy(SOURCE, [{ ...misread, id: undefined }]).body.replace("helo wrld", "hello world");
		expect(old).not.toContain("^ink-");
		const { body, outcome } = copy(old, [misread]);
		expect(outcome.conflicts).toBe(0);
		expect(body).toContain("> hello world\n> ![[img/dev-p01-aaaaaaaaaaaa.png]]\n> ^ink-aaaaaaaaaaaa");
		expect(body).not.toContain("helo wrld");
	});

	it("finds a remark by its id when its image is switched off", () => {
		const imageless = { ...misread, path: undefined };
		const corrected = copy(SOURCE, [imageless]).body.replace("helo wrld", "hello world");
		expect(copy(corrected, [imageless]).body).toBe(corrected);
	});
});

describe("a reading nobody touched", () => {
	const first = () => copy(SOURCE, [misread]).body;

	it("gives way to a new, different reading", () => {
		const { body, outcome, refreshed } = copy(first(), [{ ...misread, transcript: "hello world", replaces: "helo wrld" }]);
		expect(outcome.conflicts).toBe(0);
		expect(refreshed).toEqual(["aaaaaaaaaaaa"]);
		expect(body).toBe(first().replace("> helo wrld", "> hello world"));
	});

	it("replaces every line of a reading, and only the reading", () => {
		const twoLines = copy(SOURCE, [{ ...misread, transcript: "helo\nwrld" }]).body;
		const { body } = copy(twoLines, [{ ...misread, transcript: "hello world", replaces: "helo\nwrld" }]);
		const lines = body.split("\n");
		const title = lines.indexOf("> [!note] Remark");
		expect(lines.slice(title, title + 5)).toEqual([
			"> [!note] Remark",
			"> hello world",
			"> ![[img/dev-p01-aaaaaaaaaaaa.png]]",
			"> ^ink-aaaaaaaaaaaa",
			"",
		]);
	});

	it("stays when the reader is unsure this time", () => {
		const { body, refreshed } = copy(first(), [{ ...misread, transcript: undefined, replaces: "helo wrld" }]);
		expect(body).toBe(first());
		expect(refreshed).toEqual([]);
	});

	it("is not replaced once the owner changed it — not even mid-sync", () => {
		// The store still thinks the note shows "helo wrld", but the owner has
		// just typed over it: their text wins and is found as a correction next time.
		const edited = first().replace("helo wrld", "hello wörld");
		const { body, refreshed } = copy(edited, [{ ...misread, transcript: "hello world", replaces: "helo wrld" }]);
		expect(body).toBe(edited);
		expect(refreshed).toEqual([]);
	});

	it("gives way in the summary block too", () => {
		const block = summary(SOURCE, [misread]).body;
		const { body, refreshed } = summary(block, [{ ...misread, transcript: "hello world", replaces: "helo wrld" }]);
		expect(body).toContain("> hello world");
		expect(body).not.toContain("helo wrld");
		expect(refreshed).toEqual(["aaaaaaaaaaaa"]);
	});
});

describe("a confirmed reading", () => {
	it("is never replaced, even by a better one", () => {
		const checked = copy(SOURCE, [misread]).body.replace("> [!note] Remark", "> [!note] Remark ✓");
		const { body, refreshed } = copy(checked, [{ ...misread, transcript: "hello world", replaces: "helo wrld" }]);
		expect(body).toBe(checked);
		expect(refreshed).toEqual([]);
	});

	it("keeps its ✓ when the summary block is written again", () => {
		const block = summary(SOURCE, [misread]).body.replace("Note at: “First paragraph with some words.”", "$& ✓");
		const { body } = summary(block, [{ ...misread, transcript: "hello world", replaces: "helo wrld" }]);
		expect(body).toContain("Note at: “First paragraph with some words.” ✓");
		expect(body).toContain("> helo wrld");
	});

	it("is written with its ✓ when placed again", () => {
		expect(copy(SOURCE, [{ ...misread, confirmed: true }]).body).toContain("> [!note] Remark ✓");
	});
});

describe("a remark the note already has (summary block)", () => {
	it("keeps the owner's correction when the block is written again", () => {
		const first = summary(SOURCE, [misread]).body;
		expect(first).toContain("> helo wrld");
		const corrected = first.replace("helo wrld", "hello world");
		const { body } = summary(corrected, [misread, another]);
		expect(body).toContain("> hello world");
		expect(body).not.toContain("helo wrld");
		expect(body).toContain("> second remark");
	});
});

describe("settleRemarks", () => {
	it("passes on remarks the note does not have, and other marks", () => {
		const erased: ImportedMark = { kind: "erased", page: 1, target: "some" };
		const { ours, marks, refreshed } = settleRemarks(SOURCE, [misread, erased]);
		expect(refreshed).toEqual([]);
		expect(ours).toBe(SOURCE);
		expect(marks).toEqual([misread, erased]);
	});
});
