/**
 * Three-way merge of a note: the body as it was sent (base), the note as it
 * reads now (ours) and the base with the tablet's changes applied (theirs).
 *
 * Line-based first; where both sides changed overlapping lines the region is
 * merged again word by word, since a markdown paragraph is one long line and
 * an erased word on the tablet must not clash with a typo fixed elsewhere in
 * the same paragraph. Every change that does not overlap one from the other
 * side goes in — also one that merely touches it, and two insertions at the
 * same place (a line added in the vault, a remark appended on the tablet):
 * both, the note's first. Only overlapping changes that differ clash. Then
 * the note keeps its words, and the region as the tablet would have it —
 * every clean change applied, the tablet's words where they clash — follows
 * in a callout.
 *
 * The callout carries an id made from what it shows (`^ink-conflict-…`).
 * Before merging, the note's untouched callouts are taken out: a clash that
 * persists brings its callout back in the same place, so merging the same
 * versions again changes nothing; one whose clash is gone stays where it
 * was, as it may be the only record of the tablet's words. A callout the
 * owner edited is their text, and its clash is not shown a second time.
 */

import { blockIdLine, CONFLICT_ID_PREFIX, textId } from "../incoming/remarkid";

export interface MergeResult {
	text: string;
	/** Regions both sides changed differently. */
	conflicts: number;
}

interface Hunk {
	/** Replaced range in the base. */
	oStart: number;
	oEnd: number;
	/** Replacement range in the other side. */
	xStart: number;
	xEnd: number;
	side: "ours" | "theirs";
}

/** Myers' O(ND) diff, as hunks replacing base ranges. */
export function diffHunks(base: string[], other: string[], side: Hunk["side"] = "ours"): Hunk[] {
	const ids = new Map<string, number>();
	const intern = (line: string) => {
		let value = ids.get(line);
		if (value === undefined) {
			value = ids.size;
			ids.set(line, value);
		}
		return value;
	};
	const a = base.map(intern);
	const b = other.map(intern);
	const n = a.length;
	const m = b.length;
	const max = n + m;
	const offset = max + 1;
	const v = new Int32Array(2 * max + 3);
	const trace: Int32Array[] = [];
	let found = false;
	for (let d = 0; d <= max && !found; d++) {
		trace.push(v.slice());
		for (let k = -d; k <= d; k += 2) {
			let x =
				k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
					? v[offset + k + 1]
					: v[offset + k - 1] + 1;
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) {
				x++;
				y++;
			}
			v[offset + k] = x;
			if (x >= n && y >= m) {
				found = true;
				break;
			}
		}
	}
	// Walk the trace back into matched pairs.
	const pairs: [number, number][] = [];
	let x = n;
	let y = m;
	for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
		const vd = trace[d];
		const k = x - y;
		const prevK =
			k === -d || (k !== d && vd[offset + k - 1] < vd[offset + k + 1]) ? k + 1 : k - 1;
		const prevX = vd[offset + prevK];
		const prevY = prevX - prevK;
		while (x > prevX && y > prevY) {
			x--;
			y--;
			pairs.push([x, y]);
		}
		if (d > 0) {
			x = prevX;
			y = prevY;
		}
	}
	pairs.reverse();
	const hunks: Hunk[] = [];
	let oi = 0;
	let xi = 0;
	for (const [po, px] of [...pairs, [n, m] as [number, number]]) {
		if (po > oi || px > xi) hunks.push({ oStart: oi, oEnd: po, xStart: xi, xEnd: px, side });
		oi = po + 1;
		xi = px + 1;
	}
	return hunks;
}

type Piece<T> = { kind: "clean"; items: T[] } | { kind: "conflict"; ours: T[]; theirs: T[]; base: T[] };

/**
 * Whether a hunk overlaps a group spanning base [start, end): both replace
 * some of the same items, or one inserts strictly inside the other's range.
 * Hunks that only touch, and insertions at the same place, do not.
 */
function overlaps(start: number, end: number, hunk: Hunk): boolean {
	if (hunk.oStart === hunk.oEnd) return start < hunk.oStart && hunk.oStart < end;
	if (start === end) return hunk.oStart < start && start < hunk.oEnd;
	return hunk.oStart < end && start < hunk.oEnd;
}

function merge<T extends string>(base: T[], ours: T[], theirs: T[]): Piece<T>[] {
	// At one base position insertions come first, the note's before the tablet's.
	const order = (hunk: Hunk) => (hunk.oStart === hunk.oEnd ? 0 : 2) + (hunk.side === "ours" ? 0 : 1);
	const hunks = [...diffHunks(base, ours, "ours"), ...diffHunks(base, theirs, "theirs")].sort(
		(p, q) => p.oStart - q.oStart || order(p) - order(q),
	);
	const out: Piece<T>[] = [];
	const sides = { ours, theirs };
	let cursor = 0;
	let i = 0;
	// The last single insertion emitted; widened by hand, the loop's narrowing loses it.
	let inserted = null as { at: number; items: T[] } | null;
	while (i < hunks.length) {
		const group = [hunks[i]];
		const start = hunks[i].oStart;
		let end = hunks[i].oEnd;
		i++;
		while (i < hunks.length && overlaps(start, end, hunks[i])) {
			end = Math.max(end, hunks[i].oEnd);
			group.push(hunks[i]);
			i++;
		}
		if (start > cursor) out.push({ kind: "clean", items: base.slice(cursor, start) });
		cursor = end;
		if (group.length === 1) {
			const items = sides[group[0].side].slice(group[0].xStart, group[0].xEnd);
			// The same insertion from both sides goes in once.
			const twice =
				start === end &&
				inserted?.at === start &&
				inserted.items.length === items.length &&
				inserted.items.every((item, k) => item === items[k]);
			if (!twice) out.push({ kind: "clean", items });
			inserted = start === end ? { at: start, items } : null;
			continue;
		}
		inserted = null;
		// Same-side hunks never overlap, so a group of several holds both sides.
		const textOf = (side: Hunk["side"]): T[] => {
			const mine = group.filter((h) => h.side === side);
			const first = mine[0];
			const last = mine[mine.length - 1];
			return sides[side].slice(first.xStart - (first.oStart - start), last.xEnd + (end - last.oEnd));
		};
		const o = textOf("ours");
		const t = textOf("theirs");
		if (o.length === t.length && o.every((item, k) => item === t[k])) out.push({ kind: "clean", items: o });
		else out.push({ kind: "conflict", ours: o, theirs: t, base: base.slice(start, end) });
	}
	if (cursor < base.length) out.push({ kind: "clean", items: base.slice(cursor) });
	return out;
}

const tokens = (text: string): string[] => text.match(/\s+|[^\s]+/g) ?? [];

export const CONFLICT_TITLE = "> [!warning] Also changed on the reMarkable";

/** The callout showing the tablet's side of a clash, its id made from what it shows. */
function conflictCallout(theirs: string[]): { id: string; lines: string[] } {
	const shown = theirs.length === 0 ? ["> *(removed there)*"] : theirs.map((line) => (line === "" ? ">" : `> ${line}`));
	const id = `${CONFLICT_ID_PREFIX}${textId(shown.join("\n"))}`;
	return { id, lines: [CONFLICT_TITLE, ...shown, blockIdLine(id)] };
}

interface Callout {
	start: number;
	end: number;
	id: string;
	/** It still shows exactly what its id was made from. */
	untouched: boolean;
}

/** The clash callouts in a text, title line to id line. */
function conflictCallouts(lines: string[]): Callout[] {
	const idLine = new RegExp(`^>\\s?\\^(${CONFLICT_ID_PREFIX}[0-9a-f]+)\\s*$`);
	const out: Callout[] = [];
	for (let end = 0; end < lines.length; end++) {
		const id = idLine.exec(lines[end])?.[1];
		if (id === undefined) continue;
		let start = end;
		while (start > 0 && !/^>\s*\[!/.test(lines[start]) && lines[start - 1].startsWith(">")) start--;
		const shown = lines.slice(start + 1, end).join("\n");
		out.push({ start, end, id, untouched: lines[start] === CONFLICT_TITLE && id === `${CONFLICT_ID_PREFIX}${textId(shown)}` });
	}
	return out;
}

/** The lines without the callouts, each with the blank line before and after it that it came with. */
function withoutCallouts(lines: string[], callouts: Callout[]): string[] {
	const drop = new Set<number>();
	for (const { start, end } of callouts) {
		for (let i = start; i <= end; i++) drop.add(i);
		if (start > 0 && lines[start - 1].trim() === "") drop.add(start - 1);
		if (end + 1 < lines.length && lines[end + 1].trim() === "") drop.add(end + 1);
	}
	return lines.filter((_, i) => !drop.has(i));
}

/**
 * The merge proper, on versions without untouched clash callouts. Clashes
 * whose id is in `shown` already have a callout in the note. Returns every
 * clash's id, shown or not.
 */
function mergeBodies(
	base: string,
	ours: string,
	theirs: string,
	shown: Set<string>,
): MergeResult & { ids: Set<string> } {
	const ids = new Set<string>();
	if (ours === base) return { text: theirs, conflicts: 0, ids };
	if (theirs === base || theirs === ours) return { text: ours, conflicts: 0, ids };
	const lines: string[] = [];
	let conflicts = 0;
	for (const piece of merge(base.split("\n"), ours.split("\n"), theirs.split("\n"))) {
		if (piece.kind === "clean") {
			lines.push(...piece.items);
			continue;
		}
		const words = merge(
			tokens(piece.base.join("\n")),
			tokens(piece.ours.join("\n")),
			tokens(piece.theirs.join("\n")),
		);
		// The region as one side wins every clash; an empty region has no lines, not one blank line.
		const winning = (side: "ours" | "theirs") => {
			const text = words.flatMap((w) => (w.kind === "clean" ? w.items : w[side])).join("");
			return text === "" ? [] : text.split("\n");
		};
		lines.push(...winning("ours"));
		if (words.every((w) => w.kind === "clean")) continue;
		conflicts++;
		const callout = conflictCallout(winning("theirs"));
		ids.add(callout.id);
		if (!shown.has(callout.id)) lines.push("", ...callout.lines, "");
	}
	return { text: lines.join("\n"), conflicts, ids };
}

/** Merge three versions of a note body. */
export function merge3(base: string, ours: string, theirs: string): MergeResult {
	const strip = (text: string) => {
		const lines = text.split("\n");
		return withoutCallouts(lines, conflictCallouts(lines).filter((callout) => callout.untouched)).join("\n");
	};
	const oursLines = ours.split("\n");
	const callouts = conflictCallouts(oursLines);
	const untouched = callouts.filter((callout) => callout.untouched);
	const edited = callouts.filter((callout) => !callout.untouched).map((callout) => callout.id);
	const bare = { base: strip(base), theirs: strip(theirs) };
	let merged = mergeBodies(bare.base, withoutCallouts(oursLines, untouched).join("\n"), bare.theirs, new Set(edited));
	const kept = untouched.filter((callout) => !merged.ids.has(callout.id));
	if (kept.length > 0) {
		const keptIds = new Set(kept.map((callout) => callout.id));
		const back = untouched.filter((callout) => !keptIds.has(callout.id));
		merged = mergeBodies(bare.base, withoutCallouts(oursLines, back).join("\n"), bare.theirs, new Set([...edited, ...keptIds]));
	}
	return { text: merged.text, conflicts: merged.conflicts };
}
