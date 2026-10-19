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
	/** The owner checked the reading: its title (or first line) ends in ✓. */
	confirmed: boolean;
}

/**
 * Marks a remark whose reading the owner checked: at the end of its callout
 * title (`> [!note] Remark ✓`), or of the first line of a summary entry.
 * Typed by hand or added by the confirm commands; a confirmed reading is
 * never read again or replaced, and counts as known-correct for training.
 */
export const CONFIRM_MARK = "✓";

const isConfirmLine = (line: string) => !isRemarkTextLine(line) && line.trimEnd().endsWith(CONFIRM_MARK);

const isTitle = (line: string) => /^>\s*\[!/.test(line);

/** A line of a remark's text: quoted, and not its title, image or id. */
export function isRemarkTextLine(line: string): boolean {
	return line.startsWith(">") && !isTitle(line) && !line.includes("![[") && !isRemarkIdLine(line);
}

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
			.filter(isRemarkTextLine)
			.map((line) => line.replace(/^>\s?/, "").trim())
			.filter((line) => line !== "")
			.join("\n"),
		confirmed: isConfirmLine(lines[start]),
	};
}

/** The block of the remark callout around a line: its title line and its id, or null. */
function calloutAt(lines: string[], at: number): { title: number; id: string | null } | null {
	if (at < 0 || at >= lines.length || !lines[at].startsWith(">")) return null;
	let title = at;
	while (!isTitle(lines[title])) {
		if (title === 0 || !lines[title - 1].startsWith(">")) return null;
		title--;
	}
	let id: string | null = null;
	for (let i = title; i < lines.length && lines[i].startsWith(">") && (i === title || !isTitle(lines[i])); i++) {
		const match = isRemarkIdLine(lines[i]) ? new RegExp(`\\^${REMARK_ID_PREFIX}([0-9a-f]+)`).exec(lines[i]) : null;
		if (match !== null) id = match[1];
	}
	return { title, id };
}

/** Title lines of remark callouts — callouts carrying an `^ink-` id. */
function remarkTitles(lines: string[]): number[] {
	const titles: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (!isTitle(lines[i])) continue;
		if (calloutAt(lines, i)?.id !== null) titles.push(i);
	}
	return titles;
}

const confirmTitle = (line: string) => (line.trimEnd().endsWith(CONFIRM_MARK) ? line : `${line.trimEnd()} ${CONFIRM_MARK}`);

/**
 * Confirm the remark whose callout holds `line`: its title gets the ✓.
 * Null when that line is not in a remark callout (one with an `^ink-` id).
 */
export function confirmRemarkAt(note: string, line: number): string | null {
	const lines = note.split("\n");
	const callout = calloutAt(lines, line);
	if (callout === null || callout.id === null) return null;
	lines[callout.title] = confirmTitle(lines[callout.title]);
	return lines.join("\n");
}

/** Confirm every remark callout in a note. Returns the note and how many were newly confirmed. */
export function confirmAllRemarks(note: string): { note: string; confirmed: number } {
	const lines = note.split("\n");
	let confirmed = 0;
	for (const title of remarkTitles(lines)) {
		const next = confirmTitle(lines[title]);
		if (next !== lines[title]) confirmed++;
		lines[title] = next;
	}
	return { note: lines.join("\n"), confirmed };
}

/** The remark's text in the note ("" when it has none), or null when the note no longer has it. */
export function remarkText(note: string, ref: RemarkRef | string): string | null {
	return findRemark(note, typeof ref === "string" ? { image: ref } : ref)?.text ?? null;
}

/**
 * Set the text of the remark callout holding `line` (the owner's correction,
 * from the in-note editor): its text lines are replaced, title, image and id
 * stay. Null when that line is not in a remark callout.
 */
export function setRemarkTextAt(note: string, line: number, text: string): string | null {
	const lines = note.split("\n");
	const callout = calloutAt(lines, line);
	if (callout === null || callout.id === null) return null;
	let end = callout.title;
	while (end + 1 < lines.length && lines[end + 1].startsWith(">") && !isTitle(lines[end + 1])) end++;
	const rest = lines.slice(callout.title + 1, end + 1).filter((l) => !isRemarkTextLine(l));
	const typed = text
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l !== "")
		.map((l) => `> ${l}`);
	return [...lines.slice(0, callout.title + 1), ...typed, ...rest, ...lines.slice(end + 1)].join("\n");
}

/** The remark callout holding `line`: its id, text and whether it is confirmed; null outside one. */
export function remarkAt(note: string, line: number): { id: string; text: string; confirmed: boolean; title: number } | null {
	const lines = note.split("\n");
	const callout = calloutAt(lines, line);
	if (callout === null || callout.id === null) return null;
	const found = findRemark(note, { id: callout.id });
	return found === null ? null : { id: callout.id, text: found.text, confirmed: found.confirmed, title: callout.title };
}
