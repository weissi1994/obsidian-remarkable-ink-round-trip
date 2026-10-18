/**
 * The owner's own written words, learned two ways (ink fork):
 *
 * - from corrections: every remark that is read keeps its ink, by the name
 *   of its image in the note. When the owner fixes the text under the image —
 *   or types it under a remark that came back as an image only — the next
 *   sync pairs those words with the remark's ink words;
 * - from the word sheet, where each box is one word written joined-up.
 *
 * Each word keeps up to three samples, newest last. The whole-word reader
 * (words.ts) checks them before anything else, so a word the owner wrote
 * once is recognised in their own hand from then on.
 */

import { splitLineInto, splitWords, type Point } from "./recognize";

/** Samples kept per word; the oldest goes first. */
const PER_WORD = 3;
/** Remarks remembered for learning, newest kept. */
const REMARKS_KEPT = 500;

export interface RemarkRecord {
	/** The remark's strokes, device units. */
	strokes: Point[][];
	/** The text the note got for it ("" when it stayed image only). */
	transcript: string;
	at: string;
}

export interface SampleStore {
	format: 1;
	/** Word as written → its samples, each a list of strokes (device units). */
	words: Record<string, Point[][][]>;
	/** Remarks by the vault path of their image. */
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

/** Remember a remark's ink and the text it got, for learning from a later correction. */
export function rememberRemark(store: SampleStore, imagePath: string, strokes: Point[][], transcript: string, at: Date): void {
	store.remarks[imagePath] = { strokes: round(strokes), transcript, at: at.toISOString() };
	const paths = Object.keys(store.remarks);
	if (paths.length <= REMARKS_KEPT) return;
	paths.sort((a, b) => store.remarks[a].at.localeCompare(store.remarks[b].at));
	for (const path of paths.slice(0, paths.length - REMARKS_KEPT)) delete store.remarks[path];
}

/**
 * The text of the remark callout that embeds `imagePath`: its quoted lines
 * other than the title and the image. Null when the note no longer has it.
 */
export function remarkText(note: string, imagePath: string): string | null {
	const lines = note.split("\n");
	const at = lines.findIndex((line) => line.includes(`![[${imagePath}]]`));
	if (at === -1) return null;
	let start = at;
	while (start > 0 && lines[start - 1].startsWith(">") && !/^>\s*\[!/.test(lines[start])) start--;
	let end = at;
	while (end + 1 < lines.length && lines[end + 1].startsWith(">") && !/^>\s*\[!/.test(lines[end + 1])) end++;
	return lines
		.slice(start, end + 1)
		.filter((line) => !/^>\s*\[!/.test(line) && !line.includes("![["))
		.map((line) => line.replace(/^>\s?/, "").trim())
		.filter((line) => line !== "")
		.join("\n");
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
 * Remarks whose text in the note differs from what they were given: the
 * owner corrected or filled them in. `noteOf` returns the note embedding an
 * image, or null. Learns from each and remembers the new text, so the same
 * correction is learned once.
 */
export function learnFromNotes(store: SampleStore, noteOf: (imagePath: string) => string | null): { remarks: number; words: number } {
	let remarks = 0;
	let words = 0;
	for (const [path, record] of Object.entries(store.remarks)) {
		const note = noteOf(path);
		if (note === null) continue;
		const text = remarkText(note, path);
		if (text === null || text === "" || text === record.transcript) continue;
		const learned = learnCorrection(store, record, text);
		record.transcript = text;
		if (learned > 0) {
			remarks++;
			words += learned;
		}
	}
	return { remarks, words };
}
