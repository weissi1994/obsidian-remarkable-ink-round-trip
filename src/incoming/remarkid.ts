/**
 * A remark's identity: a hash of its ink (ink fork).
 *
 * Numbering remarks by their position on the page breaks as soon as a new
 * remark is written above an old one — every later remark is renumbered,
 * its image overwritten with someone else's ink and a correction typed
 * under it pinned to the wrong strokes. The ink itself does not move: the
 * same strokes read from the same notebook hash to the same id on every
 * import. A remark that was added to gets a new id, but its callout is
 * found again by the ink it shares with the old one (isSameRemark) and
 * updated in place rather than shown twice.
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

/** 12 hex digits from two FNV passes over the values. */
function idOf(values: number[]): string {
	const a = fnv(values, 0x811c9dc5).toString(16).padStart(8, "0");
	const b = fnv(values, 0x050c5d1f).toString(16).padStart(8, "0");
	return `${a}${b.slice(0, 4)}`;
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
	return idOf(values);
}

/** 12 hex digits for a piece of text, the same way: the id of a block the plugin wrote. */
export function textId(text: string): string {
	return idOf(Array.from(text, (ch) => ch.codePointAt(0) ?? 0));
}

/** The block-id line that marks a remark in a callout (`> ^ink-…`). */
export function remarkIdLine(id: string, quoted = true): string {
	return `${quoted ? "> " : ""}^${REMARK_ID_PREFIX}${id}`;
}

/** Whether a note line is a remark's block-id line. */
export function isRemarkIdLine(line: string): boolean {
	return new RegExp(`^(>\\s*)*\\^${REMARK_ID_PREFIX}[0-9a-f]+\\s*$`).test(line.trim());
}

/**
 * Block-id prefix of a callout showing the tablet's side of a clash
 * (sync/merge3.ts); the rest is the textId of what it shows, so the same
 * clash always carries the same id.
 */
export const CONFLICT_ID_PREFIX = `${REMARK_ID_PREFIX}conflict-`;

/** Block id of the note's one callout of tablet changes not applied (sync/twoway.ts). */
export const PENDING_ID = `${REMARK_ID_PREFIX}pending`;

/**
 * Block-id prefix of text typed on the tablet and imported (sync/twoway.ts):
 * the rest is typedTextId, so the note knows the text came in even after
 * the owner edited it.
 */
export const TYPED_ID_PREFIX = `${REMARK_ID_PREFIX}typed-`;

/** 12 hex digits naming the typed text of one page as imported: its page id and its markdown. */
export function typedTextId(pageId: string, markdown: string): string {
	return textId(`${pageId}\n${markdown}`);
}

/** The block-id line placed after imported typed text (`^ink-typed-…`). */
export function typedIdLine(id: string): string {
	return `^${TYPED_ID_PREFIX}${id}`;
}

/** Whether a note line is imported typed text's block-id line. */
export function isTypedIdLine(line: string): boolean {
	return new RegExp(`^\\^${TYPED_ID_PREFIX}[0-9a-f]+\\s*$`).test(line.trim());
}

/** A block-id line of another kind the plugin writes (`> ^ink-conflict-…`, `> ^ink-pending`). */
export function blockIdLine(id: string, quoted = true): string {
	return `${quoted ? "> " : ""}^${id}`;
}

/**
 * Whether a line is any block-id line the plugin writes — a remark's, a
 * clash's, the pending callout's or imported typed text's. They are for
 * Obsidian; on paper they would be stray "^ink-…" lines.
 */
export function isPluginIdLine(line: string): boolean {
	return new RegExp(`^(>\\s*)*\\^${REMARK_ID_PREFIX}(conflict-[0-9a-f]+(-\\d+)?|pending|typed-[0-9a-f]+|[0-9a-f]+)\\s*$`).test(
		line.trim(),
	);
}

/** A remark's ink as an earlier import kept it: device units, absolute or from its own corner. */
export interface RemarkInk {
	page?: number;
	strokes: { x: number; y: number }[][];
}

const inkLength = (points: { x: number; y: number }[]): number => {
	let total = 0;
	for (let i = 1; i < points.length; i++) {
		const dx = points[i].x - points[i - 1].x;
		const dy = points[i].y - points[i - 1].y;
		total += Math.sqrt(dx * dx + dy * dy);
	}
	return Math.max(total, 1);
};

/** Tolerance in device units for "the same point" of a stroke read again (a stored copy is rounded). */
const SAME_POINT = 1.5;

/**
 * Whether `next` is the remark `known` with strokes added or erased — the
 * same remark, though its ink (and so its id) changed. Same page when both
 * are known, and at least half of the larger one's ink, by length, is shared
 * stroke for stroke at one common shift: the strokes that were there stay
 * where they were. The shift allows ink kept from its own corner, and a
 * remark lassoed elsewhere as a whole is still that remark.
 */
export function isSameRemark(known: RemarkInk, next: RemarkInk): boolean {
	if (known.page !== undefined && next.page !== undefined && known.page !== next.page) return false;
	const old = known.strokes.filter((s) => s.length > 0);
	const now = next.strokes.filter((s) => s.length > 0);
	if (old.length === 0 || now.length === 0) return false;
	const same = (a: { x: number; y: number }[], b: { x: number; y: number }[], dx: number, dy: number) =>
		a.length === b.length && a.every((p, i) => Math.abs(b[i].x - p.x - dx) <= SAME_POINT && Math.abs(b[i].y - p.y - dy) <= SAME_POINT);
	// Candidate shifts: one per pair of strokes with the same shape.
	const shifts: { dx: number; dy: number }[] = [];
	for (const a of old) {
		for (const b of now) {
			const dx = b[0].x - a[0].x;
			const dy = b[0].y - a[0].y;
			if (same(a, b, dx, dy) && !shifts.some((s) => Math.abs(s.dx - dx) <= SAME_POINT && Math.abs(s.dy - dy) <= SAME_POINT)) {
				shifts.push({ dx, dy });
			}
		}
	}
	const total = Math.max(
		old.reduce((sum, s) => sum + inkLength(s), 0),
		now.reduce((sum, s) => sum + inkLength(s), 0),
	);
	for (const { dx, dy } of shifts) {
		const used = new Set<number>();
		let shared = 0;
		for (const a of old) {
			const match = now.findIndex((b, i) => !used.has(i) && same(a, b, dx, dy));
			if (match === -1) continue;
			used.add(match);
			shared += inkLength(a);
		}
		if (shared >= total * 0.5) return true;
	}
	return false;
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
 * to the block around it — up to a blank line or the next callout title; a
 * callout no further than its quoted lines, which a code fence or text can
 * follow straight on.
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
	const quoted = lines[at].startsWith(">");
	const inBlock = (line: string) => line.trim() !== "" && (!quoted || line.startsWith(">"));
	let start = at;
	while (start > 0 && inBlock(lines[start - 1]) && !isTitle(lines[start])) start--;
	let end = at;
	while (end + 1 < lines.length && inBlock(lines[end + 1]) && !isTitle(lines[end + 1])) end++;
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
