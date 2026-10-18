import { describe, expect, it } from "vitest";
import { RM_V6_HEADER, parseRmPage } from "../incoming/rmlines";
import { builtinFont, resolveGlyph } from "../ink/glyphs";

/**
 * Build a `.rm` v6 file holding one glyph block — the shape the tablet writes
 * when you highlight text on a PDF layer. Beta finding 2026-07-26: the
 * account carried no `.highlights/*.json` at all, so this is where the
 * highlights were hiding.
 */
function glyphFile(text: string, color?: number, blockType = 0x03, rgb?: number[]): Uint8Array {
	const encoded = new TextEncoder().encode(text);
	const body: number[] = [];

	// Four tagged CRDT ids (tag byte, author byte, varint) plus the deleted
	// length — the same preamble every scene item carries.
	for (let i = 1; i <= 4; i++) body.push((i << 4) | 0xf, 1, 0);
	body.push(0x5f, 0, 0, 0, 0);

	if (color !== undefined) {
		body.push(0x44, color, 0, 0, 0); // tag 4 / uint32
	}
	// tag 5 as a length-prefixed block: varint length, is-ascii flag, bytes.
	const blockLength = 1 + 1 + encoded.length;
	body.push(0x5c, blockLength & 0xff, (blockLength >> 8) & 0xff, 0, 0);
	body.push(encoded.length, 1, ...encoded);
	// The real colour trails the text: 0xa4 0x01 then the BGRA bytes.
	if (rgb !== undefined) body.push(0xa4, 0x01, ...rgb);

	const header = new TextEncoder().encode(RM_V6_HEADER);
	const out = new Uint8Array(header.length + 8 + body.length);
	out.set(header, 0);
	const view = new DataView(out.buffer);
	view.setUint32(header.length, body.length, true);
	out[header.length + 4] = 0; // unknown
	out[header.length + 5] = 1; // min version
	out[header.length + 6] = 2; // current version
	out[header.length + 7] = blockType;
	out.set(body, header.length + 8);
	return out;
}

describe("parseRmPage on glyph blocks", () => {
	it("reads the highlighted text out of the pen layer", () => {
		const page = parseRmPage(glyphFile("Maar is er altijd zekerheid uit data?", 2));
		expect(page.highlights[0]).toMatchObject({
			text: "Maar is er altijd zekerheid uit data?",
			color: 2,
		});
		// Every small tagged integer comes along, so the real colour field can
		// be identified from a device report (GP_E3_S13).
		expect(page.highlights[0].fields).toMatchObject({ "4:4": 2 });
		expect(page.strokes).toEqual([]);
	});

	it("reads the highlighter colour the device really sends", () => {
		// Device report 2026-07-27: the colour is tag 0xa4, 0x01, then BGRA.
		// These three values came back from a real account and match what the
		// tablet showed — yellow, pink and light blue (GP_E3_S16).
		const cases: [number[], string][] = [
			[[0x75, 0xed, 0xff, 0xff], "#ffed75"],
			[[0xff, 0x9e, 0xf2, 0xff], "#f29eff"],
			[[0xfe, 0xea, 0xbe, 0xff], "#beeafe"],
		];
		for (const [bgra, expected] of cases) {
			const page = parseRmPage(glyphFile("gemarkeerde tekst", 9, 0x03, bgra));
			expect(page.highlights[0].rgb).toBe(expected);
		}
	});

	it("leaves the colour undefined rather than guessing at a stray 0xa4", () => {
		// Alpha must be 0xff; anything else is a byte pair that happens to look
		// like the marker.
		const page = parseRmPage(glyphFile("iets", 9, 0x03, [0x10, 0x20, 0x30, 0x00]));
		expect(page.highlights[0].rgb).toBeUndefined();
	});

	it("reports the bytes and coordinates around the text, for diagnosis", () => {
		// GP_E3_S15: the colour is in none of the named fields, and the glyph
		// rectangles — if they are in there — would calibrate where the page's
		// ink really sits. Both questions are settled by looking, not guessing.
		const page = parseRmPage(glyphFile("iets", 2));
		expect(page.highlights[0].head).toMatch(/^[0-9a-f]+$/);
		expect(page.highlights[0].tail).toBeDefined();
		expect(Array.isArray(page.highlights[0].coords)).toBe(true);
	});

	it("keeps non-ASCII text intact", () => {
		const page = parseRmPage(glyphFile("Ze vertellen niet wáárom mensen — lid worden"));
		expect(page.highlights[0].text).toBe("Ze vertellen niet wáárom mensen — lid worden");
	});

	it("reports which block types a page held, so an empty result is explainable", () => {
		const page = parseRmPage(glyphFile("iets", 3));
		expect(page.blockTypes).toEqual({ 3: 1 });
	});

	it("ignores a glyph-shaped payload in a block of another type", () => {
		const page = parseRmPage(glyphFile("niet als highlight bedoeld", 3, 0x07));
		expect(page.highlights).toEqual([]);
		expect(page.blockTypes).toEqual({ 7: 1 });
	});

	it("returns nothing for a file that is not v6", () => {
		const page = parseRmPage(new Uint8Array([1, 2, 3]));
		expect(page).toEqual({ strokes: [], highlights: [], blockTypes: {} });
	});
});

describe("drawn symbols", () => {
	it("draws check, cross and arrows no font carries, look-alikes included", () => {
		const f = builtinFont("readability");
		for (const ch of ["✓", "✗", "→", "←", "↑", "↓", "↔"]) {
			const glyph = resolveGlyph(ch, f, f);
			expect(glyph.strokes.length, ch).toBeGreaterThan(0);
			expect(glyph.strokes[0]).not.toEqual([0.05, 0, 0.5, 0, 0.5, 0.75, 0.05, 0.75, 0.05, 0]);
		}
		expect(resolveGlyph("✔", f, f)).toEqual(resolveGlyph("✓", f, f));
		expect(resolveGlyph("✘", f, f)).toEqual(resolveGlyph("✗", f, f));
	});
});

describe("symbols in a handwritten note", () => {
	it("writes ✓ and → as drawn symbols, and an older send as before", async () => {
		const { parseBlocks } = await import("../convert/mdblocks");
		const { renderInk, DEVICE_PROFILES, INK_PENS } = await import("../ink/inkrender");
		const { HandFont } = await import("../ink/glyphs");
		const f = builtinFont("readability");
		const face = new HandFont(f, f);
		const options = { profile: DEVICE_PROFILES.rm2, fonts: { body: face, bold: face, italic: face, mono: face }, pen: INK_PENS.medium, jitter: 0, seed: "s" };
		const words = (typo?: number) =>
			renderInk(parseBlocks("done ✓ next → later"), "t", typo === undefined ? {} : { typo }, options).layout.lines
				.flatMap((l) => l.words.map((w) => w.text));
		expect(words()).toEqual(expect.arrayContaining(["✓", "→"]));
		expect(words(8)).toEqual(expect.arrayContaining(["?", "->"]));
	});
});
