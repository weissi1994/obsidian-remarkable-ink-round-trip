import { describe, expect, it } from "vitest";
import { parseBlocks } from "../convert/mdblocks";
import { inkOptionsFor } from "../ink/inkfonts";
import { gridSizeFor, hatchImage, IMAGE_INKS, InkImage, quantizeImage, quantizePixel } from "../ink/inkimage";
import { DEVICE_PROFILES, inkPagesToRm, renderInk, toInkLines, withImageBlocks } from "../ink/inkrender";
import { buildScenePageRm, INK_AUTHOR, PEN_COLOR, SceneItemSpec } from "../ink/rmwrite";
import type { InkSnapshot } from "../id/mapping";
import { diffInkPage } from "../incoming/inkdiff";
import { parseRmScene } from "../incoming/rmscene";

const ink = (code: number) => IMAGE_INKS[code >> 2].name;

/** A 40×20 picture: left half sky blue, right half dark red, a white stripe on top. */
function picture(): InkImage {
	const w = 40;
	const h = 20;
	const rgba = new Uint8Array(w * h * 4);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const i = (y * w + x) * 4;
			const [r, g, b] = y < 3 ? [255, 255, 255] : x < 20 ? [70, 130, 230] : [150, 20, 20];
			rgba.set([r, g, b, 255], i);
		}
	}
	return quantizeImage(rgba, w, h, 400, 200);
}

const SNAPSHOT: InkSnapshot = {
	pageIds: ["p"],
	font: "readability",
	fallbackFont: "readability",
	pen: "medium",
	color: 0,
	jitter: 0.4,
	profile: DEVICE_PROFILES.move,
	shape: 1,
	imageStyle: "colour-hatch",
};
const NOTE = "Before the picture.\n\n*[image: house.png]*\n\nAfter the picture.";
const LAYOUT = { fontSize: 11, lineHeight: 1.5, margin: 32 };

function render(images: Record<string, InkImage> | undefined = { "house.png": picture() }, style = SNAPSHOT.imageStyle) {
	const options = { ...inkOptionsFor({ ...SNAPSHOT, imageStyle: style }, "doc-i", () => null)!, images };
	return { options, render: renderInk(parseBlocks(NOTE), "Pic", LAYOUT, options) };
}

describe("quantising pixels to the tablet's inks", () => {
	it("maps colours to their ink and darkness to the number of passes", () => {
		expect(quantizePixel(255, 255, 255)).toBe(0);
		expect(quantizePixel(0, 0, 0, 0)).toBe(0); // transparent = paper
		expect(ink(quantizePixel(10, 10, 10))).toBe("black");
		expect(quantizePixel(10, 10, 10) & 3).toBe(3);
		expect(ink(quantizePixel(150, 150, 150))).toBe("grey");
		expect(ink(quantizePixel(40, 90, 220))).toBe("blue");
		expect(ink(quantizePixel(220, 40, 40))).toBe("red");
		expect(ink(quantizePixel(40, 160, 60))).toBe("green");
		expect(ink(quantizePixel(245, 205, 40))).toBe("yellow");
		expect(ink(quantizePixel(230, 80, 170))).toBe("pink");
		expect(quantizePixel(255, 210, 210) & 3).toBe(1); // pale pink: one light pass
		expect(quantizePixel(120, 10, 10) & 3).toBeGreaterThanOrEqual(2);
	});

	it("caps the stored grid", () => {
		expect(gridSizeFor(4000, 1000)).toEqual({ width: 200, height: 50 });
		expect(gridSizeFor(80, 60)).toEqual({ width: 80, height: 60 });
	});
});

describe("hatching", () => {
	const box = { left: -200, top: 100, width: 400, height: 200 };

	it("stays inside its box and uses each region's ink", () => {
		const strokes = hatchImage(picture(), { box, style: "colour-hatch", unit: 264 / 72 });
		expect(strokes.length).toBeGreaterThan(20);
		const colours = new Set(strokes.map((s) => s.color));
		expect(colours).toEqual(new Set([PEN_COLOR.blue, PEN_COLOR.red]));
		for (const stroke of strokes) {
			for (const p of stroke.points) {
				expect(p.x).toBeGreaterThanOrEqual(box.left - 1);
				expect(p.x).toBeLessThanOrEqual(box.left + box.width + 1);
				expect(p.y).toBeGreaterThanOrEqual(box.top + 0.15 * box.height - 3); // white stripe stays paper
				expect(p.y).toBeLessThanOrEqual(box.top + box.height + 1);
			}
		}
		// Blue (light/mid) sits left, red (dark) right; dark red is cross-hatched.
		const blue = strokes.filter((s) => s.color === PEN_COLOR.blue);
		const red = strokes.filter((s) => s.color === PEN_COLOR.red);
		expect(Math.max(...blue.flatMap((s) => s.points.map((p) => p.x)))).toBeLessThan(5);
		expect(Math.min(...red.flatMap((s) => s.points.map((p) => p.x)))).toBeGreaterThan(-5);
		const angles = new Set(red.map((s) => Math.round((Math.atan2(s.points[1].y - s.points[0].y, s.points[1].x - s.points[0].x) * 180) / Math.PI / 5) * 5));
		expect(angles.size).toBeGreaterThanOrEqual(2);
	});

	it("draws grey only in grey-hatch mode", () => {
		const strokes = hatchImage(picture(), { box, style: "mono-hatch", unit: 264 / 72 });
		expect(new Set(strokes.map((s) => s.color))).toEqual(new Set([PEN_COLOR.grey]));
	});

	it("widens its spacing to stay inside the point budget", () => {
		const full = hatchImage(picture(), { box, style: "colour-hatch", unit: 264 / 72 });
		const capped = hatchImage(picture(), { box, style: "colour-hatch", unit: 264 / 72, maxPoints: 60 });
		expect(capped.length).toBeLessThan(full.length);
	});
});

describe("pictures in a handwritten notebook", () => {
	it("replaces the placeholder line with an image block only when the picture is known", () => {
		const blocks = parseBlocks(NOTE);
		expect(withImageBlocks(blocks, {}).map((b) => b.type)).toEqual(["paragraph", "paragraph", "paragraph"]);
		const swapped = withImageBlocks(blocks, { "house.png": picture() });
		expect(swapped[1]).toEqual({ type: "inkimage", name: "house.png", width: 300, height: 150 });
	});

	it("reserves the picture's space between the text and hatches it there", () => {
		const { render: r } = render();
		const before = r.layout.lines.find((l) => l.text.startsWith("Before"))!;
		const after = r.layout.lines.find((l) => l.text.startsWith("After"))!;
		const coloured = r.pages[0].filter((s) => s.color === PEN_COLOR.blue || s.color === PEN_COLOR.red);
		expect(coloured.length).toBeGreaterThan(20);
		expect(coloured.every((s) => s.wordId === null)).toBe(true);
		const toY = (y: number) => (r.layout.pageHeight - y) * (1696 / r.layout.pageHeight);
		const ys = coloured.flatMap((s) => s.points.map((p) => p.y));
		expect(Math.min(...ys)).toBeGreaterThan(toY(before.y));
		expect(Math.max(...ys)).toBeLessThan(toY(after.y));
		// Text after the picture moved down by roughly the picture's height.
		const without = render({}).render.layout.lines.find((l) => l.text.startsWith("After"))!;
		expect(without.y - after.y).toBeGreaterThan(70);
	});

	it("is deterministic and leaves the page trustworthy for the import", () => {
		const a = render();
		const b = render();
		expect(a.render.pages).toEqual(b.render.pages);
		const [page] = inkPagesToRm(a.render, a.options);
		const diff = diffInkPage(a.render.pages[0], parseRmScene(page));
		expect(diff.trustworthy).toBe(true);
		expect(diff.userStrokes).toEqual([]);
	});

	it("does not report words when the owner erases part of the picture", () => {
		const { render: r, options } = render();
		const lines = toInkLines(r.pages[0], options.pen);
		const items: SceneItemSpec[] = r.pages[0].map((stroke, i) =>
			stroke.color === PEN_COLOR.red
				? { author: INK_AUTHOR, counter: stroke.counter, deletedLength: 1 }
				: { author: INK_AUTHOR, counter: stroke.counter, line: lines[i] },
		);
		const diff = diffInkPage(r.pages[0], parseRmScene(buildScenePageRm(items, { paperSize: { width: 954, height: 1696 } })));
		expect(diff.erasedWords).toEqual([]);
		expect(diff.userStrokes).toEqual([]);
	});

	it("keeps the placeholder when pictures are switched off", () => {
		const { render: r } = render({ "house.png": picture() }, undefined);
		expect(r.pages[0].some((s) => s.color === PEN_COLOR.blue)).toBe(true); // images passed but…
		const off = { ...inkOptionsFor({ ...SNAPSHOT, imageStyle: undefined }, "doc-i", () => null)!, images: undefined };
		const plain = renderInk(parseBlocks(NOTE), "Pic", LAYOUT, off);
		expect(plain.layout.lines.some((l) => l.text === "[image: house.png]")).toBe(true);
	});
});
