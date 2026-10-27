import { describe, expect, it } from "vitest";
import { parseBlocks } from "../convert/mdblocks";
import { typesetBlocks } from "../convert/pdf";
import { builtinFont, HandFont, resolveGlyph } from "../ink/glyphs";
import { inkOptionsFor } from "../ink/inkfonts";
import { DEVICE_PROFILES, GeneratedStroke, inkPagesToRm, renderInk, toInkLines } from "../ink/inkrender";
import { buildScenePageRm, SceneItemSpec, INK_AUTHOR } from "../ink/rmwrite";
import type { InkSnapshot, MappingEntry } from "../id/mapping";
import { diffInkPage } from "../incoming/inkdiff";
import { collectInkAnnotations } from "../incoming/inkpull";
import { parseRmScene } from "../incoming/rmscene";
import { parseRmLines } from "../incoming/rmlines";
import { projectOntoSource } from "../incoming/sourceprojection";
import { pullAnnotations, type ImportedMark, type PullDeps } from "../incoming/pull";

const NOTE = [
	"Some intro words here.",
	"",
	"## Tasks",
	"",
	"- [ ] alpha task",
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
const LAYOUT = { fontSize: 11, lineHeight: 1.5, margin: 40 };

function render(markdown = NOTE, snapshot = SNAPSHOT) {
	const options = inkOptionsFor(snapshot, "doc-1", () => null)!;
	return { options, render: renderInk(parseBlocks(markdown), "Ink test", LAYOUT, options) };
}

function wordId(r: ReturnType<typeof render>["render"], text: string): number {
	const word = r.layout.lines.flatMap((line) => line.words).find((w) => w.text === text);
	if (word === undefined) throw new Error(`no word ${text}`);
	return word.id;
}

/** A word's box in device units. */
function deviceBox(r: ReturnType<typeof render>["render"], text: string) {
	const layout = r.layout;
	const grid = layout.grid!;
	for (const line of layout.lines) {
		const word = line.words.find((w) => w.text === text);
		if (word === undefined) continue;
		const sx = grid.width / layout.pageWidth;
		const sy = grid.height / layout.pageHeight;
		return {
			left: word.x * sx - grid.width / 2,
			right: (word.x + word.width) * sx - grid.width / 2,
			baseline: (layout.pageHeight - line.y) * sy,
			xHeight: line.size * 0.5 * sy,
		};
	}
	throw new Error(`no word ${text}`);
}

function userLine(counter: number, points: { x: number; y: number }[], tool = 15, color = 0): SceneItemSpec {
	return {
		author: 2,
		counter,
		line: {
			tool,
			color,
			thicknessScale: 2,
			points: points.map((p) => ({ ...p, width: 16, pressure: 200, speed: 5, direction: 0 })),
		},
	};
}

describe("glyphs", () => {
	it("normalises every bundled font to a cap height of 1", () => {
		for (const id of ["readability", "allure", "hershey-script", "hershey-sans"]) {
			const source = builtinFont(id);
			const h = source.glyphs.get("H")![0];
			const top = Math.max(...h.strokes.flatMap((s) => s.filter((_, i) => i % 2 === 1)));
			expect(top).toBeCloseTo(1, 2);
		}
	});

	it("composes accents and stand-ins the font lacks", () => {
		const font = builtinFont("hershey-sans");
		const plain = resolveGlyph("o", font, font);
		const accented = resolveGlyph("ő", font, font); // not in Latin-1
		expect(accented.strokes.length).toBeGreaterThan(plain.strokes.length);
		const ellipsis = resolveGlyph("…", font, font);
		expect(ellipsis.advance).toBeCloseTo(resolveGlyph(".", font, font).advance * 3, 5);
	});

	it("measures exactly what it draws", () => {
		const font = new HandFont(builtinFont("readability"), builtinFont("readability"));
		const width = font.widthOfTextAtSize("Größe", 10);
		const sum = [..."Größe"].reduce((total, ch) => total + font.advanceOf(ch), 0) * 7;
		expect(width).toBeCloseTo(sum, 6);
	});
});

describe("ink render", () => {
	it("lays out exactly as the shared typesetter does", () => {
		const { render: r, options } = render();
		const again = typesetBlocks(parseBlocks(NOTE), "Ink test", { ...LAYOUT, pageWidth: r.layout.pageWidth, pageHeight: r.layout.pageHeight }, {
			...options.fonts,
			addPage: () => ({ drawText: () => undefined, drawLine: () => undefined, drawRectangle: () => undefined }),
		});
		expect(again.lines).toEqual(r.layout.lines);
	});

	it("is deterministic, jitter included", () => {
		const a = render().render;
		const b = render().render;
		expect(a.pages).toEqual(b.pages);
	});

	it("tags word strokes with their word and keeps them inside the word box", () => {
		const { render: r } = render();
		const id = wordId(r, "brown");
		const strokes = r.pages[0].filter((s) => s.wordId === id);
		expect(strokes.length).toBeGreaterThan(2);
		const box = deviceBox(r, "brown");
		for (const stroke of strokes) {
			for (const point of stroke.points) {
				expect(point.x).toBeGreaterThan(box.left - 6);
				expect(point.x).toBeLessThan(box.right + 6);
			}
		}
	});

	it("writes pages the upstream stroke reader can read back", () => {
		const { render: r, options } = render();
		const [page] = inkPagesToRm(r, options);
		const strokes = parseRmLines(page);
		expect(strokes.length).toBe(r.pages[0].length);
		const scene = parseRmScene(page);
		expect(scene.paperSize).toEqual({ width: 1404, height: 1872 });
		expect(scene.lines[0].id).toEqual({ author: INK_AUTHOR, counter: r.pages[0][0].counter });
	});

	it("draws task checkboxes where the layout says they are", () => {
		const { render: r } = render();
		const task = r.layout.lines.find((line) => line.checkbox !== undefined);
		expect(task?.text).toBe("alpha task");
		const boxes = r.pages[0].filter((s) => s.wordId === null && s.points.length > 4);
		expect(boxes.length).toBeGreaterThan(0);
	});

	it("fits the Paper Pro Move canvas", () => {
		const { render: r } = render(NOTE, { ...SNAPSHOT, profile: DEVICE_PROFILES.move });
		expect(r.layout.grid).toEqual({ width: 954, height: 1696 });
		for (const stroke of r.pages.flat()) {
			for (const point of stroke.points) {
				expect(Math.abs(point.x)).toBeLessThanOrEqual(954 / 2);
				expect(point.y).toBeGreaterThanOrEqual(0);
				expect(point.y).toBeLessThanOrEqual(1696);
			}
		}
	});
});

/** Build the page the way a tablet leaves it after the owner worked on it. */
function editedPage(r: ReturnType<typeof render>["render"], options: ReturnType<typeof render>["options"]) {
	const strokes = r.pages[0];
	const lines = toInkLines(strokes, options.pen);
	const quick = wordId(r, "quick");
	const brown = wordId(r, "brown");
	const jumps = wordId(r, "jumps");
	const items: SceneItemSpec[] = [];
	let user = 500;
	const foxBox = deviceBox(r, "fox");
	const brownBox = deviceBox(r, "brown");
	// Move "brown" to just after "fox", same line.
	const dx = foxBox.right + 10 - brownBox.left;
	const jumpsStrokes = strokes.filter((s) => s.wordId === jumps).map((s) => s.counter);
	const nicked = Math.floor(jumpsStrokes.length / 2);
	for (const [index, stroke] of strokes.entries()) {
		const line = lines[index];
		if (stroke.wordId === quick) {
			items.push({ author: INK_AUTHOR, counter: stroke.counter, deletedLength: 1 });
		} else if (stroke.wordId === brown) {
			items.push({ author: INK_AUTHOR, counter: stroke.counter, deletedLength: 1 });
			items.push({
				author: 2,
				counter: user++,
				moveFrom: { author: INK_AUTHOR, counter: stroke.counter },
				line: { ...line, points: line.points.map((p) => ({ ...p, x: p.x + dx })) },
			});
		} else if (stroke.wordId === jumps && jumpsStrokes.indexOf(stroke.counter) < nicked) {
			// The eraser took a corner of "jumps": some strokes gone entirely…
			items.push({ author: INK_AUTHOR, counter: stroke.counter, deletedLength: 1 });
		} else if (stroke.wordId === jumps && jumpsStrokes.indexOf(stroke.counter) === nicked) {
			// …and one cut in half, the half that survives a new line.
			items.push({ author: INK_AUTHOR, counter: stroke.counter, deletedLength: 1 });
			items.push({ author: 2, counter: user++, line: { ...line, points: line.points.slice(0, Math.ceil(line.points.length / 2)) } });
		} else {
			items.push({ author: INK_AUTHOR, counter: stroke.counter, line });
		}
	}
	// Strike through "lazy dog".
	const lazy = deviceBox(r, "lazy");
	const dog = deviceBox(r, "dog.");
	const strikeY = dog.baseline - dog.xHeight * 0.55;
	items.push(userLine(user++, [
		{ x: lazy.left - 4, y: strikeY },
		{ x: (lazy.left + dog.right) / 2, y: strikeY + 1 },
		{ x: dog.right + 4, y: strikeY },
	]));
	// Highlight "intro words".
	const intro = deviceBox(r, "intro");
	const words = deviceBox(r, "words");
	const hy = intro.baseline - intro.xHeight * 0.5;
	items.push(userLine(user++, [
		{ x: intro.left, y: hy },
		{ x: (intro.left + words.right) / 2, y: hy },
		{ x: words.right, y: hy },
	], 18, 3));
	// A note in the right margin next to "second item".
	const second = deviceBox(r, "second");
	const nx = 560;
	for (let k = 0; k < 3; k++) {
		items.push(userLine(user++, [
			{ x: nx + k * 25, y: second.baseline - 30 },
			{ x: nx + k * 25 + 10, y: second.baseline },
			{ x: nx + k * 25 + 20, y: second.baseline - 30 },
		]));
	}
	return buildScenePageRm(items, { paperSize: { width: 1404, height: 1872 } });
}

describe("ink diff", () => {
	it("tells erased, moved, nicked and own ink apart", () => {
		const { render: r, options } = render();
		const page = editedPage(r, options);
		const diff = diffInkPage(r.pages[0], parseRmScene(page));
		expect(diff.erasedWords).toEqual([wordId(r, "quick")]);
		expect(diff.movedWords.map((w) => w.wordId)).toEqual([wordId(r, "brown")]);
		expect(diff.partialWords.map((w) => w.wordId)).toEqual([wordId(r, "jumps")]);
		expect(diff.stats.remnants).toBe(1);
		// strike + highlight + 3 note strokes
		expect(diff.userStrokes.length).toBe(5);
	});

	it("survives a tablet that rewrote every id", () => {
		const { render: r, options } = render();
		const lines = toInkLines(r.pages[0], options.pen);
		const page = buildScenePageRm(
			lines.map((line, i) => ({ author: 3, counter: 9000 + i, line })),
			{ paperSize: { width: 1404, height: 1872 } },
		);
		const diff = diffInkPage(r.pages[0], parseRmScene(page));
		expect(diff.erasedWords).toEqual([]);
		expect(diff.userStrokes).toEqual([]);
		expect(diff.stats.recoveredByGeometry).toBe(r.pages[0].length);
	});
});

describe("ink import end to end", () => {
	it("turns the edited page into an annotated copy", async () => {
		const { render: r, options } = render();
		const page = editedPage(r, options);
		const entry: MappingEntry = {
			docId: "doc-1",
			notePath: "Ink.md",
			deviceDocId: "dev-1",
			uploadedAt: "2026-10-18T00:00:00Z",
			contentHash: "x",
			format: "ink",
			ink: SNAPSHOT,
		};
		const deps: PullDeps = {
			listDocumentHashes: async () => new Map([["dev-1", "h"]]),
			listDocumentFiles: async () => [
				{ id: "dev-1.content", hash: "c" },
				{ id: "dev-1/page-1.rm", hash: "p" },
			],
			readFile: async () => "{}",
			readBytes: async () => page,
			renderStrokes: async (request) => `ink-${request.page}-${request.remark}.png`,
			transcribe: async () => ({ text: "check this", by: "builtin", score: 0.5 }),
			loadInk: async () => r,
			writeAnnotations: async () => undefined,
		};
		const { highlights, marks, scan } = await collectInkAnnotations(entry, "h", deps);
		expect(scan.ink).toMatchObject({ erasedWords: 1, movedWords: 1, partialWords: 1, transcribed: 1 });
		expect(highlights.map((h) => h.text)).toEqual(["intro words"]);
		const kinds = marks.map((m) => m.kind).sort();
		// The half-erased "jumps" is not applied, but listed rather than dropped.
		expect(kinds).toEqual(["erased", "moved", "note", "skipped", "strikethrough"]);
		expect(marks.find((m) => m.kind === "skipped")?.unapplied).toContain("“jumps” partly erased");
		const moved = marks.find((m) => m.kind === "moved")!;
		expect(moved.moveAfter).toBe(wordId(r, "fox"));

		const copy = projectOntoSource({ source: NOTE, layout: r.layout, highlights, marks });
		expect(copy).not.toBeNull();
		const text = copy!.markdown;
		expect(text).toContain("The fox brown jumps over the ~~lazy dog~~.");
		expect(text).toContain('<mark style="background: #ffed75">intro words</mark>');
		expect(text).toContain("> [!note] Remark\n> check this\n> ![[ink-1-");
		expect(text).not.toContain("quick");
	});

	it("is what pullAnnotations runs for an ink mapping", async () => {
		const { render: r, options } = render();
		const page = editedPage(r, options);
		const entry: MappingEntry = {
			docId: "doc-1",
			notePath: "Ink.md",
			deviceDocId: "dev-1",
			uploadedAt: "2026-10-18T00:00:00Z",
			contentHash: "x",
			format: "ink",
			ink: SNAPSHOT,
		};
		let written: ImportedMark[] = [];
		const { results } = await pullAnnotations(
			{ "doc-1": entry },
			{
				listDocumentHashes: async () => new Map([["dev-1", "h"]]),
				listDocumentFiles: async () => [{ id: "dev-1/page-1.rm", hash: "p" }],
				readFile: async () => "{}",
				readBytes: async () => page,
				loadInk: async () => r,
				writeAnnotations: async (_entry, _highlights, marks) => {
					written = marks;
				},
			},
		);
		expect(results[0].ok).toBe(true);
		expect(written.map((m) => m.kind)).toContain("erased");
	});

	it("can keep erased words as struck text instead", () => {
		const { render: r } = render();
		const id = wordId(r, "quick");
		const copy = projectOntoSource({
			source: NOTE,
			layout: r.layout,
			highlights: [],
			marks: [{ kind: "erased", page: 1, words: [id], target: "quick" }],
			erasedAs: "strikethrough",
		});
		expect(copy!.markdown).toContain("The ~~quick~~ brown fox");
	});

	it("reports, but does not move, words whose landing spot is unclear", () => {
		const { render: r } = render();
		const id = wordId(r, "brown");
		const copy = projectOntoSource({
			source: NOTE,
			layout: r.layout,
			highlights: [],
			marks: [{ kind: "moved", page: 1, words: [id], target: "brown" }],
		});
		expect(copy!.markdown).toContain("The quick brown fox");
	});

	it("leaves strokes it never wrote to the mark reader when nothing matches", () => {
		const { render: r } = render();
		const fake: GeneratedStroke[] = [];
		const diff = diffInkPage(fake, parseRmScene(inkPagesToRm(r, render().options)[0]));
		expect(diff.userStrokes.length).toBe(r.pages[0].length);
	});
});

import {
	buildSheet,
	handSource,
	learnHand,
	SHEET_CHARS,
	SHEET_CHARSETS,
	SHEET_LAYERS,
	SHEET_VERSION,
	sheetPagesToRm,
} from "../ink/handsheet";

describe("handwriting capture", () => {
	/** Fill a sheet "by hand", using a script font as the owner's writing. */
	function filledSheet(profile = DEVICE_PROFILES.rm2, skip = "", version = SHEET_VERSION) {
		const sheet = buildSheet(profile, "letters", version);
		const hand = builtinFont("hershey-script");
		const pages = sheetPagesToRm(sheet, profile);
		const pageIds = pages.map((_, i) => `sheet-${i + 1}`);
		const filled = new Map<string, Uint8Array>();
		sheet.pages.forEach((strokes, index) => {
			const items: SceneItemSpec[] = toInkLines(strokes, { tool: 17, color: 1, thicknessScale: 1, width: 8 }).map((line) => ({
				author: INK_AUTHOR,
				counter: line.counter,
				line,
			}));
			let counter = 5000;
			for (const box of sheet.boxes.filter((b) => b.page === index + 1)) {
				if (skip.includes(box.char)) continue;
				const glyph = hand.glyphs.get(box.char)?.[0];
				if (glyph === undefined) continue;
				const cap = box.baseline - box.capLine;
				const x0 = box.left + box.width * 0.3;
				for (const path of glyph.strokes) {
					const points = [];
					for (let i = 0; i + 1 < path.length; i += 2) {
						points.push({ x: x0 + path[i] * cap, y: box.baseline - path[i + 1] * cap, width: 16, pressure: 200, speed: 5, direction: 0 });
					}
					if (points.length < 2) continue;
					// On the layer the sheet opens on, as the tablet writes it.
					items.push({ author: 2, counter: counter++, line: { tool: 15, color: 0, thicknessScale: 2, points }, onWritingLayer: true });
				}
			}
			filled.set(
				pageIds[index],
				buildScenePageRm(items, { paperSize: { width: profile.width, height: profile.height }, layers: SHEET_LAYERS }),
			);
		});
		return { sheet, pageIds, filled, profile };
	}

	it("sends the sheet with an empty layer on top to write on, and reads the ink from it", () => {
		const { pageIds, filled } = filledSheet();
		const sent = sheetPagesToRm(buildSheet(DEVICE_PROFILES.rm2), DEVICE_PROFILES.rm2)[0];
		const text = new TextDecoder("latin1").decode(sent);
		expect(text).toContain("Your handwriting");
		expect(text).toContain("Sheet");
		const scene = parseRmScene(filled.get(pageIds[0])!);
		const owners = scene.lines.filter((line) => line.id.author === 2);
		expect(owners.length).toBeGreaterThan(0);
		expect(owners.every((line) => line.parent.author === 0 && line.parent.counter === 14)).toBe(true);
		expect(scene.lines.filter((line) => line.id.author === INK_AUTHOR).every((line) => line.parent.counter === 11)).toBe(true);
	});

	it("still reads back a sheet sent with the first layout", () => {
		const { pageIds, filled, profile } = filledSheet(DEVICE_PROFILES.rm2, "", 1);
		const result = learnHand({ deviceDocId: "s", pageIds, profile, version: 1 }, filled);
		expect(result.learned.join("")).toBe([...SHEET_CHARSETS[1]].filter((ch) => builtinFont("hershey-script").glyphs.has(ch)).sort().join(""));
		expect(buildSheet(profile, "letters", 1).boxes.map((b) => b.char).join("")).toBe(SHEET_CHARSETS[1]);
	});

	it("puts a full-size reference beside each box's writing space, on the same guides", () => {
		const profile = DEVICE_PROFILES.rm2;
		const sheet = buildSheet(profile);
		const box = sheet.boxes.find((b) => b.char === "g")!;
		// Reference strokes sit in the left column and reach below the baseline.
		const inBox = sheet.pages[box.page - 1].filter((s) =>
			s.points.every((p) => p.x >= box.left && p.x <= box.left + box.width * 0.4 && p.y > box.top && p.y < box.top + box.height),
		);
		const lowest = Math.max(...inBox.flatMap((s) => s.points.map((p) => p.y)));
		expect(lowest).toBeGreaterThan(box.baseline);
		expect(SHEET_CHARS).toContain("„");
		expect(SHEET_CHARS).not.toContain("§");
	});

	it("lays the whole charset out on the canvas", () => {
		for (const profile of Object.values(DEVICE_PROFILES)) {
			const sheet = buildSheet(profile);
			expect(sheet.boxes.map((b) => b.char).join("")).toBe(SHEET_CHARS);
			for (const box of sheet.boxes) {
				expect(box.left).toBeGreaterThanOrEqual(-profile.width / 2);
				expect(box.left + box.width).toBeLessThanOrEqual(profile.width / 2);
				expect(box.top + box.height).toBeLessThanOrEqual(profile.height);
			}
		}
	});

	it("learns a glyph per filled box and skips the empty ones", () => {
		const { pageIds, filled, profile } = filledSheet(DEVICE_PROFILES.move, "XQ");
		const result = learnHand({ deviceDocId: "s", pageIds, profile, version: SHEET_VERSION }, filled);
		expect(result.skipped).toEqual(expect.arrayContaining(["X", "Q"]));
		expect(result.learned).toContain("a");
		const a = result.library.glyphs.a[0];
		const ys = a.strokes.flatMap((s) => s.filter((_, i) => i % 2 === 1));
		// Lowercase "a" sits on the baseline and stays under the cap line.
		expect(Math.min(...ys)).toBeGreaterThan(-0.1);
		expect(Math.max(...ys)).toBeLessThan(1);
		expect(result.library.version).toMatch(/^hand-[0-9a-f]{16}$/);
	});

	it("adds variants on a second sheet and writes notes in the learned hand", () => {
		const { pageIds, filled, profile } = filledSheet();
		const first = learnHand({ deviceDocId: "s", pageIds, profile, version: SHEET_VERSION }, filled);
		const second = learnHand({ deviceDocId: "s", pageIds, profile, version: SHEET_VERSION }, filled, first.library);
		expect(second.library.glyphs.e.length).toBe(2);
		const snapshot: InkSnapshot = { ...SNAPSHOT, font: "hand", hand: second.library.version };
		const options = inkOptionsFor(snapshot, "doc-2", (version) =>
			version === second.library.version ? handSource(second.library) : null,
		)!;
		const r = renderInk(parseBlocks(NOTE), "Ink test", LAYOUT, options);
		expect(r.pages[0].length).toBeGreaterThan(50);
		// A send recorded with a hand that no longer exists cannot be replayed.
		expect(inkOptionsFor(snapshot, "doc-2", () => null)).toBeNull();
	});
});

import { renderAnnotationBlock } from "../incoming/annotationnote";

describe("annotation block", () => {
	it("passes the erased-word choice through to the annotated copy", () => {
		const { render: r } = render();
		const id = wordId(r, "quick");
		const marks: ImportedMark[] = [{ kind: "erased", page: 1, words: [id], target: "quick" }];
		const base = { sourcePath: "Ink.md", sourceName: "Ink", highlights: [], marks, importedAt: "now", layout: r.layout, source: NOTE };
		expect(renderAnnotationBlock({ ...base }).text).toContain("The brown fox");
		expect(renderAnnotationBlock({ ...base, erasedAs: "strikethrough" }).text).toContain("The ~~quick~~ brown fox");
	});

	it("describes erased and moved words in the summary form, erased apart from struck through", () => {
		const { render: r } = render();
		const block = (erasedAs?: "delete" | "strikethrough") =>
			renderAnnotationBlock({
				sourcePath: "Ink.md",
				sourceName: "Ink",
				highlights: [],
				importedAt: "now",
				erasedAs,
				marks: [
					{ kind: "erased", page: 1, words: [wordId(r, "quick")], target: "quick" },
					{ kind: "strikethrough", page: 1, words: [wordId(r, "lazy")], target: "lazy" },
					{ kind: "moved", page: 1, words: [wordId(r, "brown")], target: "brown", quote: "The quick brown fox" },
					{ kind: "note", page: 1, quote: "second item", transcript: "check this", path: "x.png" },
				],
			}).text;
		const text = block();
		expect(text).toContain("“quick” — erased on the reMarkable");
		expect(text).toContain("~~lazy~~ — struck through");
		expect(text).toContain("“brown” — moved on the reMarkable");
		expect(text).toContain("> check this");
		// Kept struck through, as the copy would show it, and still named as erased.
		expect(block("strikethrough")).toContain("~~quick~~ — erased on the reMarkable");
	});
});

describe("annotated copy stays well-formed under erase and move (review findings)", () => {
	function copyOf(note: string, marks: (ids: (t: string) => number) => ImportedMark[], highlights: { text: string; page: number }[] = []) {
		const r = render(note).render;
		const id = (t: string) => wordId(r, t);
		return projectOntoSource({ source: note, layout: r.layout, highlights, marks: marks(id) })!.markdown;
	}

	it("drops a highlight's markup from erased words", () => {
		const out = copyOf("Some intro words here.", (id) => [{ kind: "erased", page: 1, words: [id("words")] }], [
			{ text: "intro words", page: 1 },
		]);
		expect(out).toBe("Some ==intro== here.");
	});

	it("never merges lines when removals meet", () => {
		const out = copyOf("One two three four.\nNext line here.", (id) => [
			{ kind: "moved", page: 1, words: [id("three")], moveBefore: id("One") },
			{ kind: "erased", page: 1, words: [id("four.")] },
		]);
		expect(out).toBe("three One two\nNext line here.");
	});

	it("keeps headings and task ticks when an erased run spans lines", () => {
		const note = "Alpha beta gamma\n\n## Delta epsilon\n\n- [ ] task two";
		const out = copyOf(note, (id) => [
			{ kind: "erased", page: 1, words: [id("gamma"), id("Delta")] },
			{ kind: "checkbox", page: 1, words: [id("task"), id("two")] },
		]);
		expect(out).toBe("Alpha beta\n\n## epsilon\n\n- [x] task two");
	});

	it("does not move a phrase that cuts through markup or skips words", () => {
		const note = "The **quick brown** fox jumps.";
		expect(
			copyOf(note, (id) => [{ kind: "moved", page: 1, words: [id("brown"), id("fox")], moveAfter: id("jumps.") }]),
		).toBe(note);
		expect(
			copyOf(note, (id) => [{ kind: "moved", page: 1, words: [id("quick"), id("fox")], moveAfter: id("jumps.") }]),
		).toBe(note);
	});

	it("moves whole emphasised words and inserts outside the anchor's emphasis", () => {
		const out = copyOf("Plain **bold** words end.", (id) => [
			{ kind: "moved", page: 1, words: [id("words")], moveAfter: id("bold") },
		]);
		expect(out).toBe("Plain **bold** words end.");
		const out2 = copyOf("Plain **bold** extra end.", (id) => [
			{ kind: "moved", page: 1, words: [id("end.")], moveAfter: id("bold") },
		]);
		expect(out2).toBe("Plain **bold** end. extra");
	});

	it("takes emptied emphasis with an erased word", () => {
		expect(copyOf("The **quick** fox.", (id) => [{ kind: "erased", page: 1, words: [id("quick")] }])).toBe("The fox.");
	});
});

import { readFileSync } from "fs";
import { join } from "path";

describe("tablet-written pages (rmscene fixtures)", () => {
	it("resolves a lasso group anchored to the end-of-text marker on a page without text", () => {
		// orig.rm: "The quick brown fox…" written for the Paper Pro, doc-x seed;
		// its first stroke moved by (50, 40) into a marker-anchored group.
		const bytes = new Uint8Array(readFileSync(join(__dirname, "fixtures", "ink-anchored-move.rm")));
		const scene = parseRmScene(bytes);
		const moved = scene.lines.find((line) => line.moveFrom !== undefined)!;
		expect(moved.anchored).toBe(false);
		const snapshot: InkSnapshot = { ...SNAPSHOT, profile: DEVICE_PROFILES.paperpro };
		const options = inkOptionsFor(snapshot, "doc-x", () => null)!;
		const r = renderInk(parseBlocks("The quick brown fox jumps over the lazy dog."), "T", LAYOUT, options);
		const diff = diffInkPage(r.pages[0], scene);
		expect(diff.stats.moved).toBe(1);
		const offset = diff.movedWords.length > 0 ? diff.movedWords[0] : undefined;
		if (offset !== undefined) {
			expect(offset.dx).toBeCloseTo(50, 0);
			expect(offset.dy).toBeCloseTo(40, 0);
		}
		expect(diff.userStrokes).toEqual([]);
	});

	it("treats a second move of a moved word as a move, not as ink of the owner", () => {
		const { render: r, options } = render();
		const brown = wordId(r, "brown");
		const lines = toInkLines(r.pages[0], options.pen);
		const items: SceneItemSpec[] = [];
		let counter = 700;
		for (const [index, stroke] of r.pages[0].entries()) {
			const line = lines[index];
			if (stroke.wordId !== brown) {
				items.push({ author: INK_AUTHOR, counter: stroke.counter, line });
				continue;
			}
			// First move (tombstoned), then a second move pointing at the first copy.
			items.push({ author: INK_AUTHOR, counter: stroke.counter, deletedLength: 1 });
			const first = counter++;
			items.push({ author: 2, counter: first, deletedLength: 1 });
			items.push({
				author: 2,
				counter: counter++,
				moveFrom: { author: 2, counter: first },
				line: { ...line, points: line.points.map((p) => ({ ...p, x: p.x + 120, y: p.y + 30 })) },
			});
		}
		const diff = diffInkPage(r.pages[0], parseRmScene(buildScenePageRm(items, { paperSize: { width: 1404, height: 1872 } })));
		expect(diff.movedWords.map((w) => w.wordId)).toEqual([brown]);
		expect(diff.erasedWords).toEqual([]);
		expect(diff.userStrokes).toEqual([]);
	});

	it("refuses to read a page whose strokes it cannot reproduce", () => {
		const { render: r, options } = render();
		const [page] = inkPagesToRm(r, options);
		const renamed = renderInk(parseBlocks(NOTE), "A different title", LAYOUT, options);
		expect(diffInkPage(renamed.pages[0], parseRmScene(page)).trustworthy).toBe(false);
		expect(diffInkPage(r.pages[0], parseRmScene(page)).trustworthy).toBe(true);
	});

	it("refuses to regenerate with font shapes other than the ones sent", () => {
		const { options } = render();
		const versions = [options.fonts.body.primary.version, options.fonts.body.fallback.version, "builtin-hershey-sans-old"];
		expect(inkOptionsFor({ ...SNAPSHOT, fontVersions: versions }, "doc-1", () => null)).toBeNull();
	});
});
