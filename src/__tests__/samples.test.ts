import { describe, expect, it } from "vitest";
import { parseBlocks } from "../convert/mdblocks";
import { builtinFont, HandFont } from "../ink/glyphs";
import { buildSheet, learnWords, WORD_SHEET_WORDS } from "../ink/handsheet";
import { DEVICE_PROFILES, INK_PENS, renderInk, toInkLines } from "../ink/inkrender";
import { buildScenePageRm, INK_AUTHOR, SceneItemSpec } from "../ink/rmwrite";
import { Lexicon, OCR_TRUST, Point, recognize, templatesFrom } from "../ocr/recognize";
import {
	addSample,
	emptyStore,
	learnCorrection,
	learnFromNotes,
	rememberRemark,
	remarkText,
} from "../ocr/samples";
import { WordReader } from "../ocr/words";

/** A remark "handwritten" joined-up (a script font), as device strokes. */
function joinedUp(text: string, seed: string, font = "allure"): Point[][] {
	const source = builtinFont(font);
	const face = new HandFont(source, source);
	const r = renderInk(parseBlocks(text), "t", {}, {
		profile: DEVICE_PROFILES.rm2,
		fonts: { body: face, bold: face, italic: face, mono: face },
		pen: INK_PENS.medium,
		jitter: 0.5,
		seed,
	});
	// The script font sets words almost touching; people leave a gap.
	const words = r.layout.lines.filter((l) => l.role !== "title").flatMap((l) => l.words);
	return words.flatMap((word, index) =>
		r.pages[0].filter((s) => s.wordId === word.id).map((s) => s.points.map((p) => ({ x: p.x + index * 14, y: p.y }))),
	);
}

const printTemplates = templatesFrom([
	{ glyphs: builtinFont("readability").glyphs, weight: 1 },
	{ glyphs: builtinFont("hershey-sans").glyphs, weight: 1 },
]);
const lexicon = Lexicon.fromText(["Termin morgen prüfen, die Woche ist voll"]);
const IMAGE = "reMarkable-in/handwriting/dev-1-p01-1.png";

describe("remark text in the note", () => {
	const note = [
		"Some text.",
		"",
		"> [!note] Remark",
		"> Termin morgen",
		"> prüfen",
		`> ![[${IMAGE}]]`,
		"",
		"> [!note] Remark",
		"> ![[other.png]]",
	].join("\n");

	it("is the callout's quoted lines, title and image left out", () => {
		expect(remarkText(note, IMAGE)).toBe("Termin morgen\nprüfen");
		expect(remarkText(note, "other.png")).toBe("");
		expect(remarkText(note, "gone.png")).toBeNull();
	});
});

describe("learning from a correction", () => {
	it("pairs words with their ink only when the counts agree", () => {
		const store = emptyStore();
		const strokes = joinedUp("Termin morgen prüfen", "r1");
		rememberRemark(store, IMAGE, strokes, "", new Date("2026-10-19"));
		expect(learnCorrection(store, store.remarks[IMAGE], "Termin")).toBe(0);
		expect(learnCorrection(store, store.remarks[IMAGE], "Termin, morgen prüfen!")).toBe(3);
		expect(Object.keys(store.words).sort()).toEqual(["Termin", "morgen", "prüfen"]);
	});

	it("keeps three samples per word, newest last", () => {
		const store = emptyStore();
		for (let i = 0; i < 5; i++) addSample(store, "Termin", [[{ x: i, y: i }]]);
		expect(store.words.Termin.map((s) => s[0][0].x)).toEqual([2, 3, 4]);
	});

	it("reads joined-up words once the owner has corrected them", () => {
		const store = emptyStore();
		// First sync: joined-up writing is too uncertain, so the remark stays an image…
		const first = joinedUp("Termin morgen prüfen", "first");
		const before = recognize(first, printTemplates, lexicon, new WordReader([], builtinFont("readability"), store.words));
		expect(before === null || before.confidence < OCR_TRUST).toBe(true);
		rememberRemark(store, IMAGE, first, "", new Date("2026-10-19"));

		// …the owner types what it says under the image…
		const note = `> [!note] Remark\n> Termin morgen prüfen\n> ![[${IMAGE}]]`;
		expect(learnFromNotes(store, (path) => (path === IMAGE ? note : null))).toEqual({ remarks: 1, words: 3 });
		// …and is not taught the same thing twice.
		expect(learnFromNotes(store, (path) => (path === IMAGE ? note : null))).toEqual({ remarks: 0, words: 0 });

		// Next time the same words, written anew, are read.
		const later = recognize(
			joinedUp("prüfen Termin morgen", "later"),
			printTemplates,
			lexicon,
			new WordReader([], builtinFont("readability"), store.words),
		);
		expect(later?.text).toBe("prüfen Termin morgen");
		expect(later!.confidence).toBeGreaterThanOrEqual(OCR_TRUST);
	});

	it("does not trust a bundled script font for a hand it has not seen", () => {
		const reader = new WordReader([builtinFont("hershey-script")], builtinFont("readability"), {});
		const match = reader.read(joinedUp("morgen", "x"), lexicon);
		expect(match?.trusted ?? false).toBe(false);
	});
});

describe("word sheet", () => {
	it("lays out every word and reads each box back as that word's ink", () => {
		const profile = DEVICE_PROFILES.rm2;
		const sheet = buildSheet(profile, "words");
		expect(sheet.boxes.map((b) => b.char)).toEqual(WORD_SHEET_WORDS);
		for (const box of sheet.boxes) {
			expect(box.left).toBeGreaterThanOrEqual(-profile.width / 2);
			expect(box.left + box.width).toBeLessThanOrEqual(profile.width / 2);
			expect(box.top + box.height).toBeLessThanOrEqual(profile.height);
		}
		const hand = builtinFont("allure");
		const pageIds = sheet.pages.map((_, i) => `w-${i + 1}`);
		const filled = new Map<string, Uint8Array>();
		sheet.pages.forEach((strokes, index) => {
			const items: SceneItemSpec[] = toInkLines(strokes, { tool: 17, color: 1, thicknessScale: 1, width: 8 }).map(
				(line) => ({ author: INK_AUTHOR, counter: line.counter, line }),
			);
			let counter = 5000;
			for (const box of sheet.boxes.filter((b) => b.page === index + 1 && ["und", "today"].includes(b.char))) {
				const cap = box.baseline - box.capLine;
				let x = box.left + box.width * 0.2;
				for (const ch of box.char) {
					const glyph = hand.glyphs.get(ch)![0];
					for (const path of glyph.strokes) {
						const points = [];
						for (let i = 0; i + 1 < path.length; i += 2) {
							points.push({ x: x + path[i] * cap, y: box.baseline - path[i + 1] * cap, width: 16, pressure: 200, speed: 5, direction: 0 });
						}
						if (points.length > 1) items.push({ author: 2, counter: counter++, line: { tool: 15, color: 0, thicknessScale: 2, points } });
					}
					x += glyph.advance * cap;
				}
			}
			filled.set(pageIds[index], buildScenePageRm(items, { paperSize: { width: profile.width, height: profile.height } }));
		});
		const found = learnWords({ deviceDocId: "w", pageIds, profile, version: 1, kind: "words" }, filled);
		expect(Object.keys(found).sort()).toEqual(["today", "und"]);
		expect(found.und.length).toBeGreaterThan(0);
	});

	it("leaves the letter sheet as it was", () => {
		expect(buildSheet(DEVICE_PROFILES.rm2)).toEqual(buildSheet(DEVICE_PROFILES.rm2, "letters"));
	});
});
