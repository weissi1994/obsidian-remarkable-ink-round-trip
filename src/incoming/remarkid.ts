/**
 * A remark's identity: a hash of its ink (ink fork).
 *
 * Numbering remarks by their position on the page breaks as soon as a new
 * remark is written above an old one — every later remark is renumbered,
 * its image overwritten with someone else's ink and a correction typed
 * under it pinned to the wrong strokes. The ink itself does not move: the
 * same strokes read from the same notebook hash to the same id on every
 * import, and a remark that was added to becomes a new one.
 *
 * The id names the remark's image and is written into its callout as a
 * block id (`^ink-<id>`), so it can be linked to and found again even when
 * the image is switched off.
 */

/** Block-id prefix of a remark's id in the note. */
export const REMARK_ID_PREFIX = "ink-";

/** FNV-1a over 32-bit words, from a given offset basis. */
function fnv(values: number[], basis: number): number {
	let hash = basis >>> 0;
	for (const value of values) {
		hash ^= value & 0xffff;
		hash = Math.imul(hash, 0x01000193) >>> 0;
		hash ^= (value >>> 16) & 0xffff;
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash >>> 0;
}

/**
 * 12 hex digits identifying a remark by its strokes: whole device units,
 * stroke by stroke, so float noise in a re-read file cannot change it.
 */
export function remarkId(strokes: { points: { x: number; y: number }[] }[]): string {
	const values: number[] = [];
	for (const stroke of strokes) {
		values.push(0x7fffffff, stroke.points.length);
		for (const p of stroke.points) values.push(Math.round(p.x) | 0, Math.round(p.y) | 0);
	}
	const a = fnv(values, 0x811c9dc5).toString(16).padStart(8, "0");
	const b = fnv(values, 0x050c5d1f).toString(16).padStart(8, "0");
	return `${a}${b.slice(0, 4)}`;
}

/** The block-id line that marks a remark in a callout (`> ^ink-…`). */
export function remarkIdLine(id: string, quoted = true): string {
	return `${quoted ? "> " : ""}^${REMARK_ID_PREFIX}${id}`;
}

/** Whether a note line is a remark's block-id line. */
export function isRemarkIdLine(line: string): boolean {
	return new RegExp(`^(>\\s*)*\\^${REMARK_ID_PREFIX}[0-9a-f]+\\s*$`).test(line.trim());
}

/** A remark as the note refers to it: by id, or by its image (notes from before ids). */
export interface RemarkRef {
	id?: string;
	image?: string;
}

export interface FoundRemark {
	/** First and last line of the remark's block (a callout, or a summary paragraph). */
	start: number;
	end: number;
	/** The block opens with a callout title (`> [!note] …`). */
	titled: boolean;
	/** The block carries the remark's id line. */
	hasId: boolean;
	/** The remark's text as the note has it: quoted lines other than title, image and id. */
	text: string;
}

const isTitle = (line: string) => /^>\s*\[!/.test(line);

/**
 * Find a remark in a note: the line with its id (or else its image), widened
 * to the block around it — up to a blank line or the next callout title.
 * Null when the note no longer has it.
 */
export function findRemark(note: string, ref: RemarkRef): FoundRemark | null {
	const lines = note.split("\n");
	const markers = [
		...(ref.id === undefined ? [] : [(line: string) => isRemarkIdLine(line) && line.includes(`^${REMARK_ID_PREFIX}${ref.id}`)]),
		...(ref.image === undefined ? [] : [(line: string) => line.includes(`![[${ref.image}]]`)]),
	];
	let at = -1;
	for (const marker of markers) {
		at = lines.findIndex(marker);
		if (at !== -1) break;
	}
	if (at === -1) return null;
	let start = at;
	while (start > 0 && lines[start - 1].trim() !== "" && !isTitle(lines[start])) start--;
	let end = at;
	while (end + 1 < lines.length && lines[end + 1].trim() !== "" && !isTitle(lines[end + 1])) end++;
	const block = lines.slice(start, end + 1);
	return {
		start,
		end,
		titled: isTitle(lines[start]),
		hasId: block.some(isRemarkIdLine),
		text: block
			.filter((line) => line.startsWith(">") && !isTitle(line) && !line.includes("![[") && !isRemarkIdLine(line))
			.map((line) => line.replace(/^>\s?/, "").trim())
			.filter((line) => line !== "")
			.join("\n"),
	};
}

/** The remark's text in the note ("" when it has none), or null when the note no longer has it. */
export function remarkText(note: string, ref: RemarkRef | string): string | null {
	return findRemark(note, typeof ref === "string" ? { image: ref } : ref)?.text ?? null;
}
