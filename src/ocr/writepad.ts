/**
 * The WritePad handwriting engine (PhatWare, GPL-3.0; vendor/writepad), built
 * to WebAssembly by scripts/build-writepad.sh with its English and German
 * dictionaries embedded. Unlike the letter reader in recognize.ts it was made
 * for joined-up writing, and reads the pen strokes as they come from the
 * tablet.
 *
 * Every remark is read in both languages, each recogniser knowing the
 * vault's words too; per word the alternative found in the vault wins over a
 * slightly better-scored one that is not, and the language whose reading
 * scores best overall is kept.
 */

import createWritePad, { type WritePadModule } from "./writepad/engine.js";
import { splitWords, type Lexicon, type Point, type Recognition } from "./recognize";

export const WRITEPAD_LANGUAGES = {
	english: { id: 1, dictionary: "/dict/English.dct" },
	german: { id: 3, dictionary: "/dict/German.dct" },
} as const;

/** Below this the image alone is the safer answer. */
export const WRITEPAD_TRUST = 0.7;

/**
 * Least fraction of a reading's own words that must be ones the vault knows for
 * the reading to be trusted. WritePad's confidence does not rank reads by
 * correctness — a partial-junk read can out-score a near-perfect one — so the
 * image alone is the safer answer when too few words are recognisable.
 */
export const WRITEPAD_MIN_KNOWN = 2 / 3;

/** How far below the top a vault word may score and still be preferred. */
const VAULT_MARGIN = 10;
/** What a word found in the vault is worth on top of its own weight. */
const VAULT_BONUS = 5;

export type Alternatives = [string, number][];

export class WritePad {
	private constructor(
		private readonly module: WritePadModule,
		private readonly readers: number[],
	) {}

	static async load(languages = Object.values(WRITEPAD_LANGUAGES)): Promise<WritePad> {
		const module = await createWritePad();
		const readers: number[] = [];
		for (const language of languages) {
			const path = cString(module, language.dictionary);
			const reader = module._wp_create(language.id, path);
			module._free(path);
			if (reader !== 0) readers.push(reader);
		}
		return new WritePad(module, readers);
	}

	/** Teach every recogniser these words (the engine knows Latin-1 only). */
	addWords(words: Iterable<string>): number {
		let added = 0;
		for (const word of words) {
			if (word.length < 2 || word.length > 40 || !/^[\p{L}\p{N}'-]+$/u.test(word) || /[^\0-\xff]/.test(word)) {
				continue;
			}
			const pointer = this.module._malloc((word.length + 1) * 2);
			const units = new Uint16Array(this.module.HEAPU8.buffer, pointer, word.length + 1);
			for (let i = 0; i < word.length; i++) units[i] = word.charCodeAt(i);
			units[word.length] = 0;
			for (const reader of this.readers) this.module._wp_add_word(reader, pointer);
			this.module._free(pointer);
			added++;
		}
		return added;
	}

	/** Read strokes (device units, y down); null when there is nothing to read. */
	read(strokes: Point[][], lexicon?: Lexicon): Recognition | null {
		const usable = strokes.filter((stroke) => stroke.length > 0);
		if (usable.length === 0 || this.readers.length === 0) return null;
		const lines = splitWords(usable).map((line) => line.flat());
		let best: Recognition | null = null;
		let quality = { known: 0, tokens: 0 };
		for (const reader of this.readers) {
			const read = lines.map((line) => choose(this.raw(reader, line), lexicon));
			const words = read.reduce((n, line) => n + line.words, 0);
			if (words === 0) continue;
			const confidence = read.reduce((sum, line) => sum + line.score, 0) / words / 100;
			if (best === null || confidence > best.confidence) {
				const text = read.map((line) => line.text).filter((line) => line !== "").join("\n");
				best = { text, confidence };
				quality = {
					known: read.reduce((n, line) => n + line.known, 0),
					tokens: read.reduce((n, line) => n + line.tokens, 0),
				};
			}
		}
		// Quality gate (needs the vault's words to judge against). Measured on the
		// bundled-font fixtures: a junk read like "the quick brown po,frjunql5"
		// scores 0.72 — above WRITEPAD_TRUST — yet is only 3/5 vault-known words
		// (0.60), while a clean "meeting is on Monday" is 4/4 (1.0). Confidence
		// alone cannot tell them apart; the known-word fraction does. Two-thirds
		// rejects the junk while still tolerating one unknown word in three.
		if (best !== null && lexicon !== undefined && quality.tokens > 0 && quality.known / quality.tokens < WRITEPAD_MIN_KNOWN) {
			return null;
		}
		return best;
	}

	/** Every word with its alternatives and weights (0–100), best first. */
	private raw(reader: number, strokes: Point[][]): Alternatives[] {
		const m = this.module;
		const total = strokes.reduce((n, stroke) => n + stroke.length, 0);
		const xy = m._malloc(total * 8);
		const lengths = m._malloc(strokes.length * 4);
		let at = xy / 4;
		for (const stroke of strokes) {
			for (const point of stroke) {
				m.HEAPF32[at++] = point.x;
				m.HEAPF32[at++] = point.y;
			}
		}
		strokes.forEach((stroke, i) => (m.HEAP32[lengths / 4 + i] = stroke.length));
		const json = m.UTF8ToString(m._wp_recognize(reader, xy, lengths, strokes.length, 0, 0));
		m._free(xy);
		m._free(lengths);
		return JSON.parse(json) as Alternatives[];
	}

	free(): void {
		for (const reader of this.readers) this.module._wp_free(reader);
		this.readers.length = 0;
	}
}

/**
 * Per word the vault's spelling when it scores close to the top. `tokens`/`known`
 * count the chosen reading's own words and how many of them the vault knows —
 * the signal the quality gate in read() weighs against WRITEPAD_MIN_KNOWN.
 */
export function choose(
	words: Alternatives[],
	lexicon: Lexicon | undefined,
): { text: string; words: number; score: number; tokens: number; known: number } {
	const chosen: string[] = [];
	let score = 0;
	let tokens = 0;
	let known = 0;
	for (const alternatives of words) {
		if (alternatives.length === 0) continue;
		const [top, topWeight] = alternatives[0];
		let pick: [string, number] = [top, topWeight];
		const vault = lexicon === undefined ? undefined : alternatives.find(([text, weight]) => weight >= topWeight - VAULT_MARGIN && wordsKnown(text, lexicon));
		if (vault !== undefined) pick = [vault[0], Math.min(100, vault[1] + VAULT_BONUS)];
		chosen.push(pick[0]);
		score += pick[1];
		// Count the parts the vault could actually hold (its index skips < 2),
		// so a single junk run like "po,frjunql5" weighs as its two dead tokens.
		for (const part of wordParts(pick[0])) {
			tokens++;
			if (lexicon?.has(part) === true) known++;
		}
	}
	return { text: chosen.join(" "), words: chosen.length, score, tokens, known };
}

/** The vault-indexable words of a reading: letters/digits, length ≥ 2. */
function wordParts(text: string): string[] {
	return (text.match(/[\p{L}\p{N}]+/gu) ?? []).filter((part) => part.length >= 2);
}

/** A reading may hold two words ("is a"), and punctuation around them. */
function wordsKnown(text: string, lexicon: Lexicon): boolean {
	const parts = text.match(/[\p{L}\p{N}]+/gu);
	return parts !== null && parts.every((part) => lexicon.has(part));
}

function cString(module: WritePadModule, text: string): number {
	const bytes = new TextEncoder().encode(`${text}\0`);
	const pointer = module._malloc(bytes.length);
	module.HEAPU8.set(bytes, pointer);
	return pointer;
}
