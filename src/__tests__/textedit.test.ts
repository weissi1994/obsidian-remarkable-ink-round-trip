import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { idKey, parseRmScene, readRootTextBlock, type TypedParagraph } from "../incoming/rmscene";
import { HEADER } from "../ink/rmbytes";
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

/** The page's RootText block: its body, and as read. */
function rootTextOf(page: Uint8Array) {
	const view = new DataView(page.buffer, page.byteOffset, page.byteLength);
	for (let offset = HEADER.length; offset + 8 <= page.length; offset += 8 + view.getUint32(offset, true)) {
		if (page[offset + 7] !== 0x07) continue;
		const end = offset + 8 + view.getUint32(offset, true);
		return { start: offset, body: page.subarray(offset + 8, end), raw: readRootTextBlock(page, offset + 8, end) };
	}
	throw new Error("no text block");
}

/**
 * The page with `field` added at the end of the text item holding `text`,
 * every enclosing length grown to match: block, text body, item list's
 * outer and inner subblocks, the item.
 */
function withItemField(page: Uint8Array, text: string, field: number[]): Uint8Array {
	const { start } = rootTextOf(page);
	const out = page.slice();
	const view = new DataView(out.buffer);
	const bodyAt = start + 8;
	// Block id (tag, author byte, varuint counter), then the length-prefixed subblocks.
	let at = bodyAt + 2;
	while ((out[at] & 0x80) !== 0) at++;
	at++;
	const lengths = [start];
	for (let level = 0; level < 3; level++) {
		lengths.push(at + 1);
		at += 5;
	}
	let count = 0;
	for (let shift = 0; ; shift += 7) {
		count += (out[at] & 0x7f) << shift;
		if ((out[at++] & 0x80) === 0) break;
	}
	const wanted = new TextEncoder().encode(text);
	for (let item = 0; item < count; item++) {
		const length = view.getUint32(at + 1, true);
		const itemEnd = at + 5 + length;
		const holds = Buffer.from(out.subarray(at + 5, itemEnd)).includes(Buffer.from(wanted));
		if (holds) {
			for (const offset of [...lengths, at + 1]) view.setUint32(offset, view.getUint32(offset, true) + field.length, true);
			const grown = new Uint8Array(out.length + field.length);
			grown.set(out.subarray(0, itemEnd));
			grown.set(field, itemEnd);
			grown.set(out.subarray(itemEnd), itemEnd + field.length);
			return grown;
		}
		at = itemEnd;
	}
	throw new Error(`no item holds ${text}`);
}

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

	it("keeps fields of the text block it does not know, and refuses an edit that would split them", () => {
		// The tablet's page carries a field after the width this reader does not know.
		const tablet = fixture("text-crdt-ordering.rm");
		const tail = rootTextOf(tablet).raw.tails.block;
		expect(tail.length).toBeGreaterThan(0);
		const next = edited(tablet, `${markdownOf(tablet)}\nMore`);
		const after = rootTextOf(next);
		expect(Array.from(after.body.subarray(after.body.length - tail.length))).toEqual(Array.from(tail));

		// An unknown field inside the item holding "Hello world".
		const page = withItemField(buildTextPageRm(markdownToTypedText("Hello world"), [], PAPER), "Hello world", [0x74, 9, 8, 7, 6]);
		expect(Array.from(rootTextOf(page).raw.tails.perItem.find((item) => item.item.length > 0)!.item)).toEqual([0x74, 9, 8, 7, 6]);
		// Kept whole: the field stays with it.
		const appended = edited(page, "Hello world\nMore");
		expect(markdownOf(appended)).toBe("Hello world\nMore");
		expect(rootTextOf(appended).raw.tails.perItem.filter((item) => item.item.length > 0).map((item) => Array.from(item.item))).toEqual([[0x74, 9, 8, 7, 6]]);
		// Split by a deletion: which half the field belongs to is unknown.
		expect(editTypedPage(page, markdownToTypedText("Hello"))).toMatchObject({ kind: "refused" });
	});

	it("rewrites a large page in bounded time and memory, paragraphs that stay keeping their characters", () => {
		const words = (seed: number, count: number) =>
			Array.from({ length: count }, (_, i) => `w${((i * 7919 + seed) % 9973).toString(36)}`).join(" ");
		const before = Array.from({ length: 10 }, (_, i) => words(i, 200));
		const after = before.map((paragraph, i) => (i === 3 || i === 7 ? words(i + 100, 220) : i === 5 ? `${paragraph} end` : paragraph));
		const page = buildTextPageRm(markdownToTypedText(before.join("\n")), [], PAPER);
		const next = edited(page, after.join("\n"));
		expect(markdownOf(next)).toBe(after.join("\n"));
		const kept = parseRmScene(page).text!.paragraphs;
		const now = parseRmScene(next).text!.paragraphs;
		for (const at of [0, 1, 2, 4, 6, 8, 9]) expect(now[at].charIds.map(idKey)).toEqual(kept[at].charIds.map(idKey));
		expect(now[5].charIds.slice(0, kept[5].charIds.length).map(idKey)).toEqual(kept[5].charIds.map(idKey));
		// One paragraph of 12,000 characters rewritten with none of them kept:
		// a full Myers trace of it takes seconds and gigabytes.
		const letters = (from: string, count: number) =>
			Array.from({ length: count }, (_, i) => String.fromCharCode(from.charCodeAt(0) + ((i * 7) % 13))).join("");
		const single = buildTextPageRm(markdownToTypedText(letters("a", 12000)), [], PAPER);
		const started = performance.now();
		const rewritten = edited(single, letters("n", 12000));
		expect(performance.now() - started).toBeLessThan(1500);
		expect(markdownOf(rewritten)).toBe(letters("n", 12000));
	});
});
