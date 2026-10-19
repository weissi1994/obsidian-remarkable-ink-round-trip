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

import type { Stroke } from "./rmlines";

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
export function remarkId(strokes: Pick<Stroke, "points">[]): string {
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
