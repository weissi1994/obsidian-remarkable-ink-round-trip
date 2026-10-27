import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { idKey, parseRmScene, type TypedParagraph } from "../incoming/rmscene";
import { buildTextPageRm, markdownToTypedText } from "../ink/roottext";
import { editTypedPage } from "../ink/textedit";
import { typedTextToMarkdown } from "../incoming/typedtext";

const fixture = (name: string) =>
	new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))));

const PAPER = { paperSize: { width: 1404, height: 1872 } };

function edited(page: Uint8Array, markdown: string): Uint8Array {
	const result = editTypedPage(page, markdownToTypedText(markdown));
	if (result.kind !== "edited") throw new Error(`not edited: ${JSON.stringify(result)}`);
	return result.bytes;
}

const markdownOf = (page: Uint8Array) => typedTextToMarkdown(parseRmScene(page).text?.paragraphs ?? []);

/** Character id of every live character, by text position. */
const idsOf = (page: Uint8Array) =>
	(parseRmScene(page).text?.paragraphs ?? []).flatMap((paragraph) => paragraph.charIds.map(idKey));

describe("typed text edited in place", () => {
	it("leaves a page alone that already reads as the text", () => {
		for (const name of ["text-bold-heading-bullet.rm", "text-inline-formats.rm", "text-crdt-ordering.rm", "text-deleted-chars.rm"]) {
			const page = fixture(name);
			const paragraphs: TypedParagraph[] = parseRmScene(page).text!.paragraphs;
			expect(editTypedPage(page, paragraphs).kind).toBe("unchanged");
		}
		const ours = buildTextPageRm(markdownToTypedText("# Title\n\nSome **bold** text\n- item"), [], PAPER);
		expect(editTypedPage(ours, markdownToTypedText("# Title\n\nSome **bold** text\n- item")).kind).toBe("unchanged");
	});

	it("writes only the difference: kept characters keep their ids", () => {
		const page = buildTextPageRm(markdownToTypedText("Hello world\nSecond line"), [], PAPER);
		const before = parseRmScene(page).text!.paragraphs;
		const next = edited(page, "Hello brave world\n# Second line");
		expect(markdownOf(next)).toBe("Hello brave world\n# Second line");
		const after = parseRmScene(next).text!.paragraphs;
		// "Hello " and "world" are the same characters.
		expect(after[0].charIds.slice(0, 6).map(idKey)).toEqual(before[0].charIds.slice(0, 6).map(idKey));
		expect(after[0].charIds.slice(12).map(idKey)).toEqual(before[0].charIds.slice(6).map(idKey));
		expect(after[1].charIds.map(idKey)).toEqual(before[1].charIds.map(idKey));
		// The restyled paragraph opens with a new break; the old one is a tombstone.
		expect(idKey(after[1].startId)).not.toBe(idKey(before[1].startId));
		expect(after[1].style).toBe("heading");
	});

	it("erases characters as tombstones under their own ids and keeps emphasis right around inserts", () => {
		const page = buildTextPageRm(markdownToTypedText("Keep **this bold** part"), [], PAPER);
		const removed = edited(page, "Keep **bold** part");
		expect(markdownOf(removed)).toBe("Keep **bold** part");
		const added = edited(removed, "Keep **bold** and *new* part");
		expect(markdownOf(added)).toBe("Keep **bold** and *new* part");
		expect(idsOf(added).length).toBe(Array.from("Keep bold and new part").length);
		// Ids never repeat across the edits.
		expect(new Set(idsOf(added)).size).toBe(idsOf(added).length);
	});

	it("changes the first paragraph's style and empties and refills a page", () => {
		const page = buildTextPageRm(markdownToTypedText("Plain start\nrest"), [], PAPER);
		expect(markdownOf(edited(page, "# Plain start\nrest"))).toBe("# Plain start\nrest");
		const empty = edited(page, "");
		expect(parseRmScene(empty).text!.paragraphs).toEqual([]);
		expect(markdownOf(edited(empty, "Again\n- here"))).toBe("Again\n- here");
	});

	it("keeps the tablet's own edits and ink: anchored strokes stay on their characters", () => {
		const page = fixture("text-inline-formats.rm");
		const scene = parseRmScene(page);
		const anchored = scene.lines.filter((line) => line.anchorId !== undefined);
		expect(anchored.length).toBeGreaterThan(0);
		const markdown = markdownOf(page);
		const lines = markdown.split("\n");
		// Insert a paragraph at the top and a word into the last line.
		const changed = ["New first line", ...lines.slice(0, -1), `${lines[lines.length - 1]} extra`].join("\n");
		const next = edited(page, changed);
		expect(markdownOf(next)).toBe(changed);
		const after = parseRmScene(next);
		const live = new Set(after.text!.paragraphs.flatMap((paragraph) => [idKey(paragraph.startId), ...paragraph.charIds.map(idKey)]));
		for (const line of anchored) {
			const same = after.lines.find((one) => idKey(one.id) === idKey(line.id))!;
			expect(idKey(same.anchorId!)).toBe(idKey(line.anchorId!));
			expect(live.has(idKey(line.anchorId!))).toBe(true);
			expect(same.stroke.points).toEqual(line.stroke.points);
		}
		expect(after.lines.length).toBe(scene.lines.length);
	});

	it("says when a page has no text, and refuses a page it cannot read", () => {
		expect(editTypedPage(fixture("lines-v2.rm"), markdownToTypedText("x")).kind).toBe("no-text");
		expect(editTypedPage(new Uint8Array([1, 2, 3]), markdownToTypedText("x")).kind).toBe("refused");
		const page = buildTextPageRm(markdownToTypedText("abc"), [], PAPER);
		expect(editTypedPage(page.subarray(0, page.length - 3), markdownToTypedText("x")).kind).toBe("refused");
	});
});
