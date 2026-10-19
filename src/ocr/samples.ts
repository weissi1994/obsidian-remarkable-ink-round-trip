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
 * Each word keeps up to three samples, newest last. The whole-word reader
 * (words.ts) checks them before anything else, so a word the owner wrote
 * once is recognised in their own hand from then on.
 *
 * The text the note has for a remark is the owner's from the moment they
 * change it: a later reading of the same ink never replaces it, here or in
 * the note (sync/twoway.ts).
 */

import { remarkText, type RemarkRef } from "../incoming/remarkid";
import { splitLineInto, splitWords, type Point } from "./recognize";

export { remarkText };

/** Samples kept per word; the oldest goes first. */
const PER_WORD = 3;
/** Remarks remembered for learning that were never corrected, newest kept. */
const REMARKS_KEPT = 500;
/** Corrected remarks kept (worked examples, training export), newest kept. */
const CORRECTIONS_KEPT = 2000;

export interface RemarkRecord {
	/** The remark's strokes, device units. */
	strokes: Point[][];
	/** The text the note has for it ("" when it stayed image only); the owner's once corrected. */
	transcript: string;
	/** What the reader last made of it ("" for nothing); absent in stores from before. */
	read?: string;
	/** The owner changed or typed in the text in the note. */
	corrected?: boolean;
	at: string;
	/** Vault path of its image, when it has one. */
	image?: string;
	/** Vault path of the note it was imported into, when known. */
	note?: string;
	/** The printed line it was written against (the reader's hint). */
	quote?: string;
	/** A whole page added on the tablet rather than a margin remark. */
	wholePage?: boolean;
}

export interface SampleStore {
	format: 1;
	/** Word as written → its samples, each a list of strokes (device units). */
	words: Record<string, Point[][][]>;
	/** Remarks by id — or by the vault path of their image, in stores from before ids. */
	remarks: Record<string, RemarkRecord>;
}

export function emptyStore(): SampleStore {
	return { format: 1, words: {}, remarks: {} };
}

const round = (strokes: Point[][]) =>
	strokes.map((stroke) => stroke.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })));

export function addSample(store: SampleStore, word: string, strokes: Point[][]): void {
	if (word === "" || strokes.length === 0) return;
	store.words[word] = [...(store.words[word] ?? []), round(strokes)].slice(-PER_WORD);
}

/** Where a remark is found in its note: keys from before ids are image paths. */
export function refOf(key: string, record: RemarkRecord): RemarkRef {
	return /\.png$/i.test(key) ? { image: key } : { id: key, image: record.image };
}

export type RemarkContext = Pick<RemarkRecord, "image" | "note" | "quote" | "wholePage">;

/**
 * Remember a remark's ink and what the reader made of it, for learning from
 * a later correction. A remark already known keeps its text — the note's,
 * possibly corrected — unless it had none, in which case the new reading
 * fills it in, as it does in the note.
 */
export function rememberRemark(
	store: SampleStore,
	key: string,
	strokes: Point[][],
	read: string,
	at: Date,
	context: RemarkContext = {},
): void {
	const known = store.remarks[key];
	if (known !== undefined) {
		known.read = read;
		known.at = at.toISOString();
		if (known.transcript === "" && known.corrected !== true) known.transcript = read;
		Object.assign(known, context);
	} else {
		store.remarks[key] = { strokes: round(strokes), transcript: read, read, at: at.toISOString(), ...context };
	}
	prune(store);
}

/** Drop the oldest remarks past the limits, the never-corrected ones under their own. */
function prune(store: SampleStore): void {
	for (const [corrected, limit] of [
		[false, REMARKS_KEPT],
		[true, CORRECTIONS_KEPT],
	] as const) {
		const keys = Object.keys(store.remarks).filter((key) => (store.remarks[key].corrected === true) === corrected);
		if (keys.length <= limit) continue;
		keys.sort((a, b) => store.remarks[a].at.localeCompare(store.remarks[b].at));
		for (const key of keys.slice(0, keys.length - limit)) delete store.remarks[key];
	}
}

/**
 * The text a remark already has, when it has any: a remark read before is
 * not read again — the note's text, the owner's once corrected, stands.
 */
export function knownText(store: SampleStore, key: string): string | null {
	const known = store.remarks[key];
	return known === undefined || known.transcript === "" ? null : known.transcript;
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
): { remarks: number; words: number; unlearned: UnlearnedCorrection[] } {
	let remarks = 0;
	let words = 0;
	const unlearned: UnlearnedCorrection[] = [];
	for (const [key, record] of Object.entries(store.remarks)) {
		const note = noteOf(key, record);
		if (note === null) continue;
		const text = remarkText(note, refOf(key, record));
		if (text === null || text === "" || text === record.transcript) continue;
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
	return { remarks, words, unlearned };
}
