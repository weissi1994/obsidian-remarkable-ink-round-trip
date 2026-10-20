/**
 * The owner's own written words, learned two ways (ink fork):
 *
 * - from corrections: every remark that is read keeps its ink, by its id
 *   (incoming/remarkid.ts — a hash of the ink, written into its callout).
 *   When the owner fixes the text in the callout — or types it under a
 *   remark that came back as an image only — the next sync pairs those
 *   words with the remark's ink words;
 * - from the word sheet, where each box is one word written joined-up.
 *
 * Each word keeps up to PER_WORD samples, newest last. When a word is over
 * that cap the most *redundant* sample is dropped — the one closest in shape
 * to another kept sample — rather than the oldest, so the kept set spans the
 * owner's variation (slant, join, a differently-formed letter) instead of
 * collapsing onto whichever way they happened to write it most recently. The
 * whole-word reader (words.ts) checks these samples before anything else, so a
 * word the owner wrote once is recognised in their own hand from then on, and
 * the more of their *range* the store keeps, the more remarks it recalls.
 *
 * The text the note has for a remark is the owner's from the moment they
 * change it: a later reading of the same ink never replaces it, here or in
 * the note (sync/twoway.ts) — as does a reading they confirmed (✓). A
 * reading nobody touched is the plugin's: the remark is read again, and a
 * reading that scores clearly better replaces it in the note.
 */

import type { ImportedMark } from "../incoming/pull";
import { findRemark, remarkText, type RemarkRef } from "../incoming/remarkid";
import { cloudOf, matchDistance, splitLineInto, splitWords, type Point } from "./recognize";

export { remarkText };

/**
 * Samples kept per word; over this the most redundant goes first (see
 * `addSample`). Raised from 3: the #5 spike showed accumulated samples help
 * recall, and read-time work stays in budget because the scaling MR (!15)
 * bounds how many samples the reader actually scores per word — the two are
 * complementary (!15 caps the read, this grows the store without keeping
 * junk). 10 sits mid-range of the 8–12 the budget allows. The format is
 * unchanged (`words: Record<string, Point[][][]>`), so a store written with
 * the old cap of 3 stays valid and needs no migration.
 */
export const PER_WORD = 10;
/** Remarks remembered for learning that were never corrected, newest kept. */
const REMARKS_KEPT = 500;
/** Corrected or confirmed remarks kept (worked examples, training export), newest kept. */
const CORRECTIONS_KEPT = 2000;

/** Which reader produced a reading. */
export type ReaderName = "builtin" | "writepad" | "endpoint";

/**
 * How sure a reader was, made comparable across readers: how far its
 * confidence sits above that reader's own cut-off, 0 (just passed) to 1
 * (certain). Readers without a confidence (a vision endpoint) have none.
 */
export function scoreAbove(confidence: number, cutOff: number): number {
	return Math.max(0, Math.min(1, (confidence - cutOff) / (1 - cutOff)));
}

/** A new reading must beat the old score by this much to replace it. */
const BETTER_BY = 0.1;
/** …or, against an old reading with no score, reach this. */
const SURE_ENOUGH = 0.5;

/**
 * Whether a new reading is clearly better than the one the note shows. A
 * reading without a score can never be shown to be better; one with a score
 * must beat the old score by a margin, or — when the old one has none —
 * be well above its reader's cut-off. Different texts with similar scores
 * stay as they are, so a correct reading is not swapped for a fluke.
 */
export function isBetterReading(old: { score?: number }, next: { score?: number }): boolean {
	if (next.score === undefined) return false;
	if (old.score === undefined) return next.score >= SURE_ENOUGH;
	return next.score > old.score + BETTER_BY;
}

export interface RemarkRecord {
	/** The remark's strokes, device units. */
	strokes: Point[][];
	/** The text the note has for it ("" when it stayed image only); the owner's once corrected. */
	transcript: string;
	/** What the reader last made of it ("" for nothing); absent in stores from before. */
	read?: string;
	/** The owner changed or typed in the text in the note. */
	corrected?: boolean;
	/** The owner checked the reading and marked it ✓. */
	confirmed?: boolean;
	/** Score and reader of the text the note shows (scoreAbove), when it is a reading. */
	score?: number;
	by?: ReaderName;
	/** Score and reader of the latest reading. */
	readScore?: number;
	readBy?: ReaderName;
	at: string;
	/** Vault path of its image, when it has one. */
	image?: string;
	/** Vault path of the note it was imported into, when known. */
	note?: string;
	/** The printed line it was written against (the reader's hint). */
	quote?: string;
	/** A whole page added on the tablet rather than a margin remark. */
	wholePage?: boolean;
	/** The table column under it, when written on a table row (0-based). */
	column?: number;
	/** Highlighter drawn over its handwriting (device units), with colour. */
	inkHighlights?: { strokes: Point[][]; rgb: string }[];
	/** Taken into the note as plain text: no callout any more, never placed again. */
	inserted?: boolean;
}

export interface SampleStore {
	format: 1;
	/** Word as written → its samples, each a list of strokes (device units). */
	words: Record<string, Point[][][]>;
	/** Remarks by id — or by the vault path of their image, in stores from before ids. */
	remarks: Record<string, RemarkRecord>;
}

/** Corrected or confirmed: the note's text for it is the owner's word, final. */
export function isVerified(record: RemarkRecord): boolean {
	return record.corrected === true || record.confirmed === true;
}

export function emptyStore(): SampleStore {
	return { format: 1, words: {}, remarks: {} };
}

const round = (strokes: Point[][]) =>
	strokes.map((stroke) => stroke.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })));

export function addSample(store: SampleStore, word: string, strokes: Point[][]): void {
	if (word === "" || strokes.length === 0) return;
	const kept = [...(store.words[word] ?? []), round(strokes)];
	store.words[word] = kept.length <= PER_WORD ? kept : keepDiverse(kept);
}

/**
 * Cut a word's samples down to PER_WORD by dropping the most redundant one at
 * a time — the sample whose closest neighbour (by the cheap $P cloud distance)
 * is nearest, i.e. the one another kept sample already covers. The kept set
 * then spans the owner's variation rather than collapsing onto the newest way
 * of writing the word. Survivors stay in their original (newest-last) order,
 * and a tie — a pair of near-duplicates equally close to each other — drops
 * the *older* one, so recency still breaks even cases.
 */
function keepDiverse(samples: Point[][][]): Point[][][] {
	const clouds = samples.map((strokes) => cloudOf(strokes));
	const between = clouds.map((a) => clouds.map((b) => matchDistance(a, b)));
	const live = samples.map((_, i) => i); // indices still kept, oldest-first
	while (live.length > PER_WORD) {
		let dropAt = 0;
		let mostRedundant = Infinity;
		for (let a = 0; a < live.length; a++) {
			let nearest = Infinity;
			for (let b = 0; b < live.length; b++) {
				if (a !== b) nearest = Math.min(nearest, between[live[a]][live[b]]);
			}
			// Strictly-less keeps the first (oldest) of a tie as the one to drop.
			if (nearest < mostRedundant) {
				mostRedundant = nearest;
				dropAt = a;
			}
		}
		live.splice(dropAt, 1);
	}
	return live.map((i) => samples[i]);
}

/** Where a remark is found in its note: keys from before ids are image paths. */
export function refOf(key: string, record: RemarkRecord): RemarkRef {
	return /\.png$/i.test(key) ? { image: key } : { id: key, image: record.image };
}

export type RemarkContext = Pick<RemarkRecord, "image" | "note" | "quote" | "wholePage" | "column" | "inkHighlights">;

/**
 * Remember a remark's ink and what the reader made of it, for learning from
 * a later correction. A remark already known keeps its text — what the note
 * shows — until the note is written (notedReadings).
 */
export function rememberRemark(
	store: SampleStore,
	key: string,
	strokes: Point[][],
	read: string,
	at: Date,
	context: RemarkContext = {},
	scored: { score?: number; by?: ReaderName } = {},
): void {
	const known = store.remarks[key];
	if (known !== undefined) {
		known.read = read;
		known.readScore = scored.score;
		known.readBy = scored.by;
		known.at = at.toISOString();
		Object.assign(known, roundContext(context));
	} else {
		store.remarks[key] = {
			strokes: round(strokes),
			transcript: read,
			read,
			at: at.toISOString(),
			...roundContext(context),
			...(scored.score === undefined ? {} : { score: scored.score, readScore: scored.score }),
			...(scored.by === undefined ? {} : { by: scored.by, readBy: scored.by }),
		};
	}
	prune(store);
}

function roundContext(context: RemarkContext): RemarkContext {
	return context.inkHighlights === undefined
		? context
		: { ...context, inkHighlights: context.inkHighlights.map((h) => ({ rgb: h.rgb, strokes: round(h.strokes) })) };
}

/**
 * The owner took a remark into the note as plain text (⤵): it is verified —
 * confirmed, and corrected when the text differs from what the note had,
 * learning from it as a correction — and, having no callout any more, it is
 * never placed again (withEarlierReadings leaves it out). Returns the words
 * learned.
 */
export function acceptRemark(store: SampleStore, key: string, text: string, at = new Date()): number {
	const record = store.remarks[key];
	if (record === undefined) {
		// Never read (OCR off, or from before): no ink to learn from, but it
		// must still not be placed again.
		store.remarks[key] = { strokes: [], transcript: text, at: at.toISOString(), confirmed: true, inserted: true };
		return 0;
	}
	let learned = 0;
	if (text !== record.transcript || record.confirmed !== true) {
		learned = learnCorrection(store, record, text);
		if (text !== record.transcript) record.corrected = true;
	}
	record.transcript = text;
	record.confirmed = true;
	record.inserted = true;
	return learned;
}

/** Drop the oldest remarks past the limits, the never-corrected ones under their own. */
function prune(store: SampleStore): void {
	for (const [corrected, limit] of [
		[false, REMARKS_KEPT],
		[true, CORRECTIONS_KEPT],
	] as const) {
		const keys = Object.keys(store.remarks).filter((key) => isVerified(store.remarks[key]) === corrected);
		if (keys.length <= limit) continue;
		keys.sort((a, b) => store.remarks[a].at.localeCompare(store.remarks[b].at));
		for (const key of keys.slice(0, keys.length - limit)) delete store.remarks[key];
	}
}

/**
 * The text of a remark the owner corrected or confirmed: such a remark is
 * not read again — their text stands. Every other remark is read anew.
 */
export function knownText(store: SampleStore, key: string): string | null {
	const known = store.remarks[key];
	return known !== undefined && isVerified(known) && known.transcript !== "" ? known.transcript : null;
}

/**
 * The tablet's remarks with the plugin's own earlier reading attached
 * (`replaces`), for remarks the owner never corrected: the note may swap
 * exactly that text for a new reading (sync/twoway.ts).
 */
export function withEarlierReadings(store: SampleStore, marks: ImportedMark[]): ImportedMark[] {
	// A remark taken into the note as text is not placed again.
	const shown = marks.filter((mark) => mark.id === undefined || store.remarks[mark.id]?.inserted !== true);
	return shown.map((mark) => {
		const known = mark.id === undefined ? undefined : store.remarks[mark.id];
		if (known === undefined) return mark;
		if (isVerified(known)) return known.confirmed === true ? { ...mark, confirmed: true } : mark;
		// Only a clearly better reading may replace text; an empty callout takes any.
		const better = known.transcript === "" || isBetterReading(known, { score: known.readScore });
		return better ? { ...mark, replaces: known.transcript } : mark;
	});
}

/**
 * After the note is written: remember, as each uncorrected remark's text,
 * the reading the note now shows. Only where the note shows the plugin's
 * reading — text the owner typed meanwhile is left to be found as a
 * correction on the next sync.
 */
export function notedReadings(store: SampleStore, marks: ImportedMark[], note: string): void {
	for (const mark of marks) {
		const known = mark.id === undefined ? undefined : store.remarks[mark.id];
		if (known === undefined || isVerified(known)) continue;
		const text = remarkText(note, { id: mark.id, image: mark.path });
		if (text !== null && text === (mark.transcript ?? "") && text !== known.transcript) {
			known.transcript = text;
			known.score = known.readScore;
			known.by = known.readBy;
		}
	}
}

/** A word as a sample's name: letters and digits, punctuation at the ends dropped. */
function bare(word: string): string {
	return word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

/**
 * Pair a corrected text with the remark's ink, word by word, and keep each
 * pair as a sample. Lines must agree; within a line the text says how many
 * words there are, so the ink is cut at that many widest gaps. Otherwise
 * nothing is learned — a guess at which ink is which word would teach the
 * wrong shapes. Returns how many words were learned.
 */
export function learnCorrection(store: SampleStore, record: RemarkRecord, corrected: string): number {
	const inkLines = splitWords(record.strokes);
	const textLines = corrected
		.split("\n")
		.map((line) => line.split(/\s+/).map(bare).filter((word) => word !== ""))
		.filter((line) => line.length > 0);
	let pairs: [string, Point[][]][] = [];
	if (inkLines.length === textLines.length) {
		// Same lines: each cut into as many words as its text has.
		const cut = inkLines.map((line, i) =>
			line.length === textLines[i].length
				? line
				: // A narrow gap merges two words, a wide letter gap splits one; never more.
					Math.abs(line.length - textLines[i].length) === 1
					? splitLineInto(line.flat(), textLines[i].length)
					: null,
		);
		if (cut.every((line) => line !== null)) {
			pairs = cut.flatMap((line, i) => line.map((strokes, j): [string, Point[][]] => [textLines[i][j], strokes]));
		}
	}
	if (pairs.length === 0) {
		const ink = inkLines.flat();
		const text = textLines.flat();
		if (ink.length === text.length) pairs = ink.map((strokes, i) => [text[i], strokes]);
	}
	for (const [word, strokes] of pairs) addSample(store, word, strokes);
	return pairs.length;
}

/**
 * A correction no words could be learned from: the text and the ink did not
 * line up word for word. Kept as a correction all the same (worked examples,
 * training export); only the word reader goes without.
 */
export interface UnlearnedCorrection {
	key: string;
	note?: string;
	image?: string;
	/** Words per line in the ink as it was cut, and in the corrected text. */
	inkLines: number[];
	textLines: number[];
}

/** Why a correction taught no words, in the owner's terms. */
export function describeUnlearned(item: UnlearnedCorrection): string {
	const where = item.note ?? item.image ?? item.key;
	const words = (lines: number[]) => lines.reduce((sum, n) => sum + n, 0);
	const reason =
		item.inkLines.length !== item.textLines.length
			? `the ink reads as ${item.inkLines.length} line(s), the text has ${item.textLines.length}`
			: `the ink splits into ${words(item.inkLines)} word(s), the text has ${words(item.textLines)}`;
	return `${where}: ${reason}`;
}

/**
 * Remarks whose text in the note differs from what they were given: the
 * owner corrected or filled them in. `noteOf` returns the note a remark was
 * imported into (or embeds its image), or null. Learns from each and
 * remembers the new text as the owner's, so the same correction is learned
 * once and never overwritten by a later reading. Corrections whose words
 * could not be paired with the ink are reported, not silently dropped.
 */
export function learnFromNotes(
	store: SampleStore,
	noteOf: (key: string, record: RemarkRecord) => string | null,
): { remarks: number; words: number; unlearned: UnlearnedCorrection[]; confirmed: number } {
	let remarks = 0;
	let words = 0;
	let confirmed = 0;
	const unlearned: UnlearnedCorrection[] = [];
	for (const [key, record] of Object.entries(store.remarks)) {
		const note = noteOf(key, record);
		if (note === null) continue;
		const found = findRemark(note, refOf(key, record));
		if (found === null) continue;
		const text = found.text;
		// A ✓ taken away again makes the reading the plugin's once more.
		const newlyConfirmed = found.confirmed && record.confirmed !== true && text !== "";
		record.confirmed = found.confirmed ? true : undefined;
		if (text === "" || text === record.transcript) {
			// Confirmed as read: the words are known-correct, so the built-in
			// reader learns them as it would from a correction.
			if (newlyConfirmed) {
				confirmed++;
				words += learnCorrection(store, record, text);
			}
			continue;
		}
		if (newlyConfirmed) confirmed++;
		const learned = learnCorrection(store, record, text);
		record.transcript = text;
		record.corrected = true;
		if (learned > 0) {
			remarks++;
			words += learned;
		} else {
			unlearned.push({
				key,
				note: record.note,
				image: record.image ?? (refOf(key, record).image === key ? key : undefined),
				inkLines: splitWords(record.strokes).map((line) => line.length),
				textLines: text
					.split("\n")
					.map((line) => line.split(/\s+/).map(bare).filter((word) => word !== "").length)
					.filter((n) => n > 0),
			});
		}
	}
	return { remarks, words, unlearned, confirmed };
}

/**
 * The owner's verified remarks, newest first: those whose text they changed,
 * typed in or confirmed. Worked examples for a vision model, and the
 * training export — readings they confirmed are its known-correct samples.
 */
export function corrections(store: SampleStore): [string, RemarkRecord][] {
	return Object.entries(store.remarks)
		.filter(([, record]) => isVerified(record) && record.transcript !== "")
		.sort(([, a], [, b]) => b.at.localeCompare(a.at));
}
