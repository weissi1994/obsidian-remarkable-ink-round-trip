import { readFileSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseBlocks } from "../convert/mdblocks";
import { builtinFont, HandFont } from "../ink/glyphs";
import {
	boxInk,
	buildSheet,
	PendingSheet,
	SHEET_LAYERS,
	sheetPagesToRm,
	TEST_SHEET_PROMPTS,
	TEST_SHEET_VERSION,
} from "../ink/handsheet";
import { DEVICE_PROFILES, INK_PENS, renderInk, toInkLines } from "../ink/inkrender";
import { buildScenePageRm, INK_AUTHOR, SceneItemSpec } from "../ink/rmwrite";
import { OCR_TRUST, Point, recognize } from "../ocr/recognize";
import type { ReaderName } from "../ocr/samples";
import {
	CAPTURE_FORMAT,
	captureItems,
	captureMarkdown,
	captureStamp,
	cer,
	HandwritingCapture,
	itemCer,
	itemPoints,
	parseCapture,
	READER_LABELS,
	replayTemplates,
	summarize,
	unflattenStroke,
} from "../ocr/testcapture";
import { WRITEPAD_TRUST, WritePad } from "../ocr/writepad";

const profile = DEVICE_PROFILES.rm2;

/** A text "handwritten" in a bundled font, as device strokes (writepad.test.ts). */
function write(text: string, font = "allure", jitter = 0.5): Point[][] {
	const source = builtinFont(font);
	const face = new HandFont(source, source);
	const fonts = { body: face, bold: face, italic: face, mono: face };
	const r = renderInk(parseBlocks(text), "t", {}, { profile, fonts, pen: INK_PENS.medium, jitter, seed: text });
	const ids = new Set(r.layout.lines.filter((l) => l.role !== "title").flatMap((l) => l.words.map((w) => w.id)));
	return r.pages[0].filter((s) => s.wordId !== null && ids.has(s.wordId)).map((s) => s.points);
}

/** Strokes moved and scaled onto a box's writing line, as the owner would write there. */
function intoBox(strokes: Point[][], box: { left: number; width: number; baseline: number; capLine: number }): Point[][] {
	const all = strokes.flat();
	const minX = Math.min(...all.map((p) => p.x));
	const maxX = Math.max(...all.map((p) => p.x));
	const minY = Math.min(...all.map((p) => p.y));
	const maxY = Math.max(...all.map((p) => p.y));
	const cap = box.baseline - box.capLine;
	const scale = Math.min((box.width - 60) / (maxX - minX), (cap * 1.4) / (maxY - minY));
	return strokes.map((stroke) =>
		stroke.map((p) => ({ x: box.left + 30 + (p.x - minX) * scale, y: box.capLine - cap * 0.05 + (p.y - minY) * scale })),
	);
}

/** Fill the test sheet "by hand": each prompt written in allure under itself, on the writing layer. */
function filledTestSheet(skip: string[] = []) {
	const sheet = buildSheet(profile, "test");
	const pages = sheetPagesToRm(sheet, profile);
	const pageIds = pages.map((_, i) => `test-${i + 1}`);
	const filled = new Map<string, Uint8Array>();
	/** How many strokes went into each prompt's box. */
	const written = new Map<string, number>();
	sheet.pages.forEach((strokes, index) => {
		const items: SceneItemSpec[] = toInkLines(strokes, { tool: 17, color: 1, thicknessScale: 1, width: 8 }).map((line) => ({
			author: INK_AUTHOR,
			counter: line.counter,
			line,
		}));
		let counter = 5000;
		for (const box of sheet.boxes.filter((b) => b.page === index + 1)) {
			if (skip.includes(box.char)) continue;
			let count = 0;
			for (const stroke of intoBox(write(box.char), box)) {
				if (stroke.length < 2) continue;
				const points = stroke.map((p, i) => ({ ...p, width: 16, pressure: 120 + (i % 60), speed: 5, direction: 0 }));
				items.push({ author: 2, counter: counter++, line: { tool: 15, color: 0, thicknessScale: 2, points }, onWritingLayer: true });
				count++;
			}
			written.set(box.char, count);
		}
		filled.set(pageIds[index], buildScenePageRm(items, { paperSize: { width: profile.width, height: profile.height }, layers: SHEET_LAYERS }));
	});
	const pending: PendingSheet = { deviceDocId: "t", pageIds, profile, version: TEST_SHEET_VERSION, kind: "test" };
	return { sheet, pending, filled, written };
}

describe("handwriting test sheet", () => {
	it("lays every prompt out one per row, inside the canvas, with room on every device", () => {
		for (const device of Object.values(DEVICE_PROFILES)) {
			const sheet = buildSheet(device, "test");
			expect(sheet.boxes.map((b) => b.char)).toEqual(TEST_SHEET_PROMPTS[TEST_SHEET_VERSION]);
			for (const box of sheet.boxes) {
				expect(box.left).toBeGreaterThanOrEqual(-device.width / 2);
				expect(box.left + box.width).toBeLessThanOrEqual(device.width / 2);
				expect(box.top + box.height).toBeLessThanOrEqual(device.height);
				// One column: every box spans the content width.
				expect(box.width).toBe(sheet.boxes[0].width);
				expect(box.baseline).toBeLessThan(box.top + box.height);
				expect(box.capLine).toBeGreaterThan(box.top);
			}
			const perPage = sheet.boxes.filter((b) => b.page === 1).length;
			expect(perPage).toBeGreaterThanOrEqual(2);
		}
		expect(buildSheet(profile, "test").pages.length).toBeLessThanOrEqual(3);
	});

	it("prints each prompt in black above its writing line", () => {
		const sheet = buildSheet(profile, "test");
		const box = sheet.boxes[0];
		const black = sheet.pages[0].filter(
			(s) => s.color === 0 && s.points.every((p) => p.y > box.top && p.y < box.top + box.height),
		);
		expect(black.length).toBeGreaterThan(10);
		expect(Math.max(...black.flatMap((s) => s.points.map((p) => p.y)))).toBeLessThan(box.capLine);
	});

	it("is deterministic, and leaves the letter and word sheets as they were", () => {
		expect(buildSheet(profile, "test")).toEqual(buildSheet(profile, "test", TEST_SHEET_VERSION));
		expect(buildSheet(profile)).toEqual(buildSheet(profile, "letters", 2));
		expect(buildSheet(profile, "words").boxes[0].width).not.toBe(buildSheet(profile, "test").boxes[0].width);
	});
});

describe("handwriting test capture", () => {
	let engine: WritePad;
	beforeAll(async () => {
		engine = await WritePad.load();
	});
	afterAll(() => engine.free());

	/** Read every item as the save command does, minus the vault's words. */
	function readAll(capture: HandwritingCapture): void {
		const templates = replayTemplates(capture.hand);
		for (const item of capture.items) {
			const strokes = itemPoints(item);
			const letters = recognize(strokes, templates);
			item.readings.builtin = {
				text: letters?.text ?? "",
				confidence: letters?.confidence,
				accepted: letters !== null && letters.confidence >= OCR_TRUST,
			};
			const cursive = engine.read(strokes);
			item.readings.writepad = {
				text: cursive?.text ?? "",
				confidence: cursive?.confidence,
				accepted: cursive !== null && cursive.confidence >= WRITEPAD_TRUST,
			};
		}
	}

	function syntheticCapture(skip: string[] = []) {
		const fixture = filledTestSheet(skip);
		const ink = boxInk(fixture.pending, fixture.filled, "test");
		const capture: HandwritingCapture = {
			format: CAPTURE_FORMAT,
			version: 1,
			createdAt: "2026-10-20T21:30:00.000Z",
			pluginVersion: "test",
			sheet: { kind: "test", version: TEST_SHEET_VERSION },
			profile,
			hand: null,
			items: captureItems(fixture.sheet.boxes, ink),
		};
		return { ...fixture, ink, capture };
	}

	it("measures character error rate", () => {
		expect(cer("Termin", "Termin")).toBe(0);
		expect(cer("Termln", "Termin")).toBeCloseTo(1 / 6);
		expect(cer("", "abcd")).toBe(1);
		expect(cer("abcd", "")).toBe(4);
		// A sentence read across two lines is not misread.
		expect(itemCer("Call back\nat 4 pm", "Call back at 4 pm")).toBe(0);
	});

	it("puts every box's strokes under its own prompt, whole, and survives JSON", () => {
		const skipped = TEST_SHEET_PROMPTS[TEST_SHEET_VERSION][3];
		const { capture, written, filled, pending } = syntheticCapture([skipped]);
		const prompts = TEST_SHEET_PROMPTS[TEST_SHEET_VERSION].filter((p) => p !== skipped);
		expect(capture.items.map((item) => item.prompt)).toEqual(prompts);
		for (const item of capture.items) {
			expect(item.strokes.length).toBe(written.get(item.prompt));
			expect(written.get(item.prompt)).toBeGreaterThan(0);
			for (const stroke of item.strokes) {
				expect(stroke.points.length % 4).toBe(0);
				expect(stroke.tool).toBe(15);
				expect(stroke.thicknessScale).toBe(2);
			}
		}
		// Ids are page and row; the row numbering counts the skipped box.
		expect(capture.items[0].id).toBe("p1-01");
		expect(capture.items[3].id).toBe("p1-05");
		expect(capture.items[capture.items.length - 1].id).toBe("p3-06");
		// The pen data comes through: pressure as written.
		const first = unflattenStroke(capture.items[0].strokes[0]);
		expect(first.points.slice(0, 3).map((p) => p.pressure)).toEqual([120, 121, 122]);
		expect(first.points[0].width).toBeGreaterThan(0);
		// Same strokes as the word-sheet path sees, x/y only.
		const raw = [...boxInk(pending, filled, "test").values()].flat().length;
		expect(raw).toBe(capture.items.reduce((n, item) => n + item.strokes.length, 0));

		readAll(capture);
		const text = JSON.stringify(capture);
		expect(parseCapture(text)).toEqual(capture);
		expect(JSON.parse(text)).toEqual(capture);
		if (process.env.HANDWRITING_CAPTURE_OUT) writeFileSync(process.env.HANDWRITING_CAPTURE_OUT, text);
		// Attachable: a full sheet stays well under a megabyte.
		expect(text.length).toBeLessThan(1_000_000);
	}, 120_000);

	it("summarises per reader and writes the note", () => {
		const { capture } = syntheticCapture();
		capture.items = capture.items.slice(0, 3);
		capture.items[0].readings = {
			builtin: { text: capture.items[0].prompt, accepted: true, confidence: 0.9 },
			writepad: { text: "", accepted: false },
			endpoint: null,
		};
		capture.items[1].readings = {
			builtin: { text: "xx", accepted: false, confidence: 0.2 },
			writepad: { text: capture.items[1].prompt, accepted: true, confidence: 0.8 },
		};
		capture.items[2].readings = {};
		const summary = summarize(capture);
		expect(summary.map((s) => s.reader)).toEqual(["builtin", "writepad", "endpoint"]);
		const builtin = summary[0];
		expect(builtin.items).toBe(2);
		expect(builtin.accepted).toBe(1);
		expect(builtin.meanCer).toBeCloseTo(itemCer("xx", capture.items[1].prompt) / 2);
		expect(summary[1].meanCer).toBeCloseTo(0.5);
		expect(summary[2]).toMatchObject({ items: 0, failed: 1 });
		expect(Number.isNaN(summary[2].meanCer)).toBe(true);

		const note = captureMarkdown(capture, new Map([["p1-01", "folder/p1-01.png"]]), "handwriting-test-x.json");
		expect(note).toContain("Attach `handwriting-test-x.json` to the forge issue.");
		expect(note).toContain("| Built-in | 2 | ");
		expect(note).toContain("![[folder/p1-01.png]]");
		expect(note).toContain("xx *(not used)*");
		expect(note).toContain("*failed*");
		// Each readings row has the same number of cells as the header.
		const table = note.split("\n").filter((line) => line.startsWith("| p1-"));
		expect(table).toHaveLength(3);
		for (const row of table) expect(row.split(" | ").length).toBe(2 + 2 * 3);
	});

	it("keeps Markdown in prompts and readings from leaking into the note", () => {
		const { capture } = syntheticCapture();
		capture.items = [{ ...capture.items[0], prompt: "Frage: ja | nein? (siehe #14)", readings: { builtin: { text: "a\nb [[x]]", accepted: true } } }];
		const note = captureMarkdown(capture, new Map());
		expect(note).toContain("Frage: ja \\| nein? (siehe \\#14)");
		expect(note).toContain("a b \\[\\[x\\]\\]");
	});

	it("stamps folders by local time", () => {
		expect(captureStamp(new Date(2026, 9, 20, 9, 5, 7))).toBe("2026-10-20-090507");
	});

	it("refuses a file that is not a capture", () => {
		expect(() => parseCapture(JSON.stringify({ format: "other", version: 1 }))).toThrow(/Not a handwriting test/);
		expect(() => parseCapture(JSON.stringify({ format: CAPTURE_FORMAT, version: 2 }))).toThrow(/version 2/);
	});
});

/**
 * Replay a capture attached to an issue with today's readers:
 *   HANDWRITING_CAPTURE=path/to/handwriting-test-….json npx vitest run src/__tests__/testcapture.test.ts
 * Without the vault's words (they are not in the file), so the replayed CER
 * is the readers' own, not what the owner saw. Reports; asserts no accuracy.
 */
describe.skipIf(!process.env.HANDWRITING_CAPTURE)("replay a handwriting capture", () => {
	it("re-reads every item and prints captured vs replayed CER", async () => {
		const capture = parseCapture(readFileSync(process.env.HANDWRITING_CAPTURE!, "utf8"));
		expect(capture.format).toBe(CAPTURE_FORMAT);
		expect(capture.version).toBe(1);
		const engine = await WritePad.load();
		const templates = replayTemplates(capture.hand);
		const readers: ReaderName[] = ["builtin", "writepad"];
		const totals = new Map(readers.map((r) => [r, { captured: 0, capturedN: 0, replayed: 0, replayedN: 0 }]));
		const rows: string[] = [];
		const pct = (n: number) => (Number.isNaN(n) ? "    —" : `${(n * 100).toFixed(1).padStart(5)}%`);
		for (const item of capture.items) {
			const strokes = itemPoints(item);
			const replayed: Record<string, string> = {
				builtin: recognize(strokes, templates)?.text ?? "",
				writepad: engine.read(strokes)?.text ?? "",
			};
			for (const reader of readers) {
				const t = totals.get(reader)!;
				const was = item.readings[reader];
				const captured = was === undefined || was === null ? NaN : itemCer(was.text, item.prompt);
				const now = itemCer(replayed[reader], item.prompt);
				if (!Number.isNaN(captured)) {
					t.captured += captured;
					t.capturedN++;
				}
				t.replayed += now;
				t.replayedN++;
				rows.push(`${item.id}  ${READER_LABELS[reader].padEnd(8)}  ${pct(captured)}  ${pct(now)}  ${JSON.stringify(replayed[reader])}`);
			}
		}
		engine.free();
		const summary = readers.map((reader) => {
			const t = totals.get(reader)!;
			return `${READER_LABELS[reader].padEnd(8)}  ${String(t.replayedN).padStart(5)}  ${pct(t.captured / t.capturedN)}  ${pct(t.replayed / t.replayedN)}`;
		});
		// Straight to the terminal: the table is the point of this run.
		process.stdout.write(
			[
				`Handwriting capture ${capture.createdAt} (plugin ${capture.pluginVersion}, test sheet v${capture.sheet.version}, ${capture.items.length} items, hand ${capture.hand === null ? "none" : capture.hand.version})`,
				"Captured: as the plugin read it, with the vault's words. Replayed: today's readers, no vault words.",
				"",
				"reader    items  captured  replayed",
				...summary,
				"",
				"item    reader    captured  replayed  replayed text",
				...rows,
				"",
			].join("\n"),
		);
	});
});
