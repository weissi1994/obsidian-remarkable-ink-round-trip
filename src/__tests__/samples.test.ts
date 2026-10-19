import { describe, expect, it } from "vitest";
import { parseBlocks } from "../convert/mdblocks";
import { builtinFont, HandFont } from "../ink/glyphs";
import { buildSheet, learnWords, WORD_SHEET_WORDS } from "../ink/handsheet";
import { DEVICE_PROFILES, INK_PENS, renderInk, toInkLines } from "../ink/inkrender";
import { buildScenePageRm, INK_AUTHOR, SceneItemSpec } from "../ink/rmwrite";
import { Lexicon, OCR_TRUST, Point, recognize, templatesFrom } from "../ocr/recognize";
import {
	addSample,
	corrections,
	describeUnlearned,
	emptyStore,
	knownText,
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
		expect(learnFromNotes(store, (path) => (path === IMAGE ? note : null))).toMatchObject({ remarks: 1, words: 3, unlearned: [] });
		// …and is not taught the same thing twice.
		expect(learnFromNotes(store, (path) => (path === IMAGE ? note : null))).toMatchObject({ remarks: 0, words: 0, unlearned: [] });

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

describe("remembered remarks", () => {
	const ID = "3f9a2c1b0d4e";
	const note = (text: string) => `Text.\n\n> [!note] Remark\n> ${text}\n> ^ink-${ID}`;
	const strokes = () => joinedUp("Termin morgen prüfen", "r");

	it("are found in their note by id, with no image to go by", () => {
		const store = emptyStore();
		rememberRemark(store, ID, strokes(), "Termin morgen prufen", new Date("2026-10-19"), { note: "N.md" });
		expect(learnFromNotes(store, (key, record) => (record.note === "N.md" ? note("Termin morgen prüfen") : null))).toMatchObject({
			remarks: 1,
			words: 3,
		});
		expect(store.remarks[ID]).toMatchObject({ transcript: "Termin morgen prüfen", read: "Termin morgen prufen", corrected: true });
	});

	it("keep the owner's correction when the same ink is read again", () => {
		const store = emptyStore();
		rememberRemark(store, ID, strokes(), "Termin morgen prufen", new Date("2026-10-19"));
		learnFromNotes(store, () => note("Termin morgen prüfen"));
		rememberRemark(store, ID, strokes(), "Termin morgan prufen", new Date("2026-10-20"));
		expect(knownText(store, ID)).toBe("Termin morgen prüfen");
		expect(store.remarks[ID].read).toBe("Termin morgan prufen");
		// Nothing new in the note, so nothing is learned twice.
		expect(learnFromNotes(store, () => note("Termin morgen prüfen"))).toMatchObject({ remarks: 0, words: 0, unlearned: [] });
	});

	it("take a first reading for a remark that had none", () => {
		const store = emptyStore();
		rememberRemark(store, ID, strokes(), "", new Date("2026-10-19"));
		expect(knownText(store, ID)).toBeNull();
		rememberRemark(store, ID, strokes(), "Termin morgen prüfen", new Date("2026-10-20"));
		expect(knownText(store, ID)).toBe("Termin morgen prüfen");
		expect(store.remarks[ID].corrected).toBeUndefined();
	});

	it("lose the never-corrected ones first when there are too many", () => {
		const store = emptyStore();
		const ink = [[{ x: 0, y: 0 }]];
		rememberRemark(store, "kept", ink, "x", new Date("2020-01-01"));
		store.remarks.kept.corrected = true;
		for (let i = 0; i < 501; i++) rememberRemark(store, `r${i}`, ink, "x", new Date(Date.UTC(2026, 0, 1, 0, 0, i)));
		expect(store.remarks.kept).toBeDefined();
		expect(store.remarks.r0).toBeUndefined();
		expect(store.remarks.r500).toBeDefined();
	});
});

describe("a correction that teaches nothing", () => {
	const ID = "3f9a2c1b0d4e";
	const note = (text: string) => `> [!note] Remark\n> ${text}\n> ^ink-${ID}`;

	it("is reported with what did not line up, and still kept as a correction", () => {
		const store = emptyStore();
		rememberRemark(store, ID, joinedUp("Termin morgen prüfen", "u"), "", new Date("2026-10-19"), { note: "Plans.md" });
		const result = learnFromNotes(store, () => note("Termin ist morgen, bitte prüfen"));
		expect(result).toMatchObject({ remarks: 0, words: 0 });
		expect(result.unlearned).toEqual([
			{ key: ID, note: "Plans.md", image: undefined, inkLines: [3], textLines: [5] },
		]);
		expect(describeUnlearned(result.unlearned[0])).toBe("Plans.md: the ink splits into 3 word(s), the text has 5");
		expect(store.remarks[ID]).toMatchObject({ corrected: true, transcript: "Termin ist morgen, bitte prüfen" });
		// Reported once: the same text is not looked at again.
		expect(learnFromNotes(store, () => note("Termin ist morgen, bitte prüfen")).unlearned).toEqual([]);
	});

	it("names a line mismatch as such", () => {
		expect(describeUnlearned({ key: "k", image: "a.png", inkLines: [2], textLines: [1, 1] })).toBe(
			"a.png: the ink reads as 1 line(s), the text has 2",
		);
	});
});

describe("corrections", () => {
	it("are the remarks the owner changed, newest first", () => {
		const store = emptyStore();
		const ink = [[{ x: 0, y: 0 }]];
		rememberRemark(store, "read", ink, "as read", new Date("2026-10-01"));
		rememberRemark(store, "old", ink, "x", new Date("2026-10-02"));
		rememberRemark(store, "new", ink, "x", new Date("2026-10-03"));
		rememberRemark(store, "emptied", ink, "x", new Date("2026-10-04"));
		Object.assign(store.remarks.old, { corrected: true, transcript: "old fix" });
		Object.assign(store.remarks.new, { corrected: true, transcript: "new fix" });
		Object.assign(store.remarks.emptied, { corrected: true, transcript: "" });
		expect(corrections(store).map(([key]) => key)).toEqual(["new", "old"]);
	});
});
