import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { idKey, parseRmScene } from "../incoming/rmscene";
import { ByteWriter, HEADER } from "../ink/rmbytes";

const fixture = (name: string) =>
	new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))));

interface Reference {
	x: number;
	y: number;
	width: number;
	paragraphs: { style: string; startId: string; text: string; spans: [string, boolean, boolean][]; charIds: string[] }[];
	lineAnchorY: Record<string, number>;
}

/** rmscene 0.8.0's TextDocument and rmc's anchor layout on the same pages (fixtures/README.md). */
const reference = JSON.parse(
	readFileSync(fileURLToPath(new URL("./fixtures/rmscene-text.json", import.meta.url)), "utf8"),
) as Record<string, Reference>;

describe("typed text on tablet-written pages", () => {
	for (const [name, expected] of Object.entries(reference)) {
		it(`reads ${name} as rmscene does`, () => {
			const text = parseRmScene(fixture(name)).text!;
			expect({ x: text.x, y: text.y, width: text.width }).toEqual({
				x: expected.x,
				y: expected.y,
				width: expected.width,
			});
			expect(
				text.paragraphs.map((p) => ({
					style: p.style,
					startId: idKey(p.startId),
					text: p.text,
					spans: p.spans.map((s) => [s.text, s.bold, s.italic]),
					charIds: p.charIds.map(idKey),
				})),
			).toEqual(expected.paragraphs);
		});
	}

	it("drops erased characters and orders runs inserted into other runs", () => {
		// "B is " + 10 erased + "a" (another author) + " letter…": three items
		// pointing into each other's middles.
		const text = parseRmScene(fixture("text-bold-heading-bullet.rm")).text!;
		expect(text.paragraphs.map((p) => p.text)).toEqual(["A", "new line", "B is a letter of the alphabet", "C"]);
		// "TEST TEXT\nTest te" + 2 erased + "xt from keyboard".
		const retyped = parseRmScene(fixture("text-deleted-chars.rm")).text!;
		expect(retyped.paragraphs.map((p) => p.text)).toEqual(["TEST TEXT", "Test text from keyboard"]);
		expect(retyped.paragraphs[1].charIds.map(idKey)).not.toContain("1:100");
	});

	it("puts concurrent inserts at one place in the tablet's order: higher author first", () => {
		expect(parseRmScene(fixture("text-crdt-ordering.rm")).text!.paragraphs[0].text).toBe("A12_Z");
	});

	it("reads inline bold and italic from format codes, even one that sits past the newline", () => {
		const text = parseRmScene(fixture("text-inline-formats.rm")).text!;
		// The italic-off code of "…italic" sits after the next newline.
		expect(text.paragraphs[3].spans[0]).toEqual({ text: "Bold", bold: true, italic: false });
		const italic = text.paragraphs[2].spans;
		expect(italic[italic.length - 1]).toEqual({ text: "italic", bold: false, italic: true });
	});

	it("estimates where text-anchored ink sits as rmc does, keeping it flagged as anchored", () => {
		for (const name of ["text-inline-formats.rm", "text-deleted-chars.rm"]) {
			const scene = parseRmScene(fixture(name));
			const expected = reference[name].lineAnchorY;
			const anchored = scene.lines.filter((line) => line.anchored);
			expect(anchored.length).toBeGreaterThan(0);
			for (const line of anchored) expect(line.textAnchorY).toBe(expected[idKey(line.id)]);
			for (const line of scene.lines.filter((l) => !l.anchored)) expect(line.textAnchorY).toBeUndefined();
		}
		// Anchored to characters in three different paragraphs.
		const ys = parseRmScene(fixture("text-inline-formats.rm")).lines.map((line) => line.textAnchorY);
		expect(new Set(ys)).toEqual(new Set([146, 216, 286]));
	});

	it("loses only the text when the text block is unreadable", () => {
		const bytes = fixture("text-inline-formats.rm");
		const intact = parseRmScene(bytes);
		const broken = bytes.slice();
		const start = blockBodies(broken).find((block) => block.type === 0x07)!.start;
		broken.fill(0xff, start + 4, start + 40);
		const scene = parseRmScene(broken);
		expect(scene.text).toBeUndefined();
		expect(scene.lines.length).toBe(intact.lines.length);
		// Still known to be text-anchored; only the estimate is gone.
		expect(scene.lines.filter((line) => line.anchored).length).toBe(intact.lines.filter((l) => l.anchored).length);
		expect(scene.lines.every((line) => line.textAnchorY === undefined)).toBe(true);
	});

	it("rejects a text sequence whose neighbours form a cycle instead of inventing an order", () => {
		// a.left = b and b.left = a: no first character.
		const page = textPage([
			{ counter: 10, left: 11, text: "a" },
			{ counter: 11, left: 10, text: "b" },
		]);
		expect(parseRmScene(page).text).toBeUndefined();
	});

	it("starts with an empty paragraph when the text starts with a newline", () => {
		const page = textPage([{ counter: 10, left: 0, text: "\nx" }]);
		expect(parseRmScene(page).text!.paragraphs.map((p) => [p.text, idKey(p.startId)])).toEqual([
			["", "0:0"],
			["x", "1:10"],
		]);
	});

	it("has no text on pages without a text block", () => {
		expect(parseRmScene(fixture("lines-v2.rm")).text).toBeUndefined();
	});
});

function blockBodies(bytes: Uint8Array): { type: number; start: number }[] {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const blocks: { type: number; start: number }[] = [];
	for (let offset = HEADER.length; offset + 8 <= bytes.length; ) {
		const length = view.getUint32(offset, true);
		blocks.push({ type: bytes[offset + 7], start: offset + 8 });
		offset += 8 + length;
	}
	return blocks;
}

/** A page with nothing but a hand-made text block: author 1 items, all right ids at the end. */
function textPage(items: { counter: number; left: number; text: string }[]): Uint8Array {
	const w = new ByteWriter();
	w.raw(new TextEncoder().encode(HEADER));
	const end = { part1: 0, part2: 0 };
	w.block(0x07, 1, 1, (b) => {
		b.taggedId(1, end);
		b.subblock(2, (body) => {
			body.subblock(1, (outer) =>
				outer.subblock(1, (list) => {
					list.varuint(items.length);
					for (const item of items) {
						list.subblock(0, (s) => {
							s.taggedId(2, { part1: 1, part2: item.counter });
							s.taggedId(3, item.left === 0 ? end : { part1: 1, part2: item.left });
							s.taggedId(4, end);
							s.taggedInt(5, 0);
							s.taggedString(6, item.text);
						});
					}
				}),
			);
			body.subblock(2, (outer) => outer.subblock(1, (list) => list.varuint(0)));
		});
		b.subblock(3, (s) => {
			s.f64(-468);
			s.f64(234);
		});
		b.taggedFloat(4, 936);
	});
	return w.bytes();
}
