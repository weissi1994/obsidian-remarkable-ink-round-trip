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
 * both, the note's first. Overlapping changes that differ clash, and so does
 * something added at the edge of what the other side removed. Then the note
 * keeps its words, and the region as the tablet would have it — every clean
 * change applied, the tablet's words where they clash — follows in a
 * callout. Where the note already holds the tablet's text for a place, it
 * is not applied again.
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

/**
 * Myers' O(ND) diff, as hunks replacing base ranges — compacted the way
 * git's xdiff does (compact): where equal items repeat, an insertion and a
 * deletion that one edit made are slid together into one replacement, and
 * a lone one slid as far down as it goes, so editing the second of two
 * identical lines is that line replaced, not an insertion before the first
 * and the second deleted.
 */
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
	// Changed items per side; matched pairs are what is left unchanged.
	const changedA = new Uint8Array(n).fill(1);
	const changedB = new Uint8Array(m).fill(1);
	for (const [po, px] of pairs) {
		changedA[po] = 0;
		changedB[px] = 0;
	}
	compact(a, changedA, changedB);
	compact(b, changedB, changedA);
	const hunks: Hunk[] = [];
	let oi = 0;
	let xi = 0;
	while (oi < n || xi < m) {
		if (oi < n && xi < m && changedA[oi] === 0 && changedB[xi] === 0) {
			oi++;
			xi++;
			continue;
		}
		const oStart = oi;
		const xStart = xi;
		while (oi < n && changedA[oi] === 1) oi++;
		while (xi < m && changedB[xi] === 1) xi++;
		if (oi === oStart && xi === xStart) throw new Error("diff out of step");
		hunks.push({ oStart, oEnd: oi, xStart, xEnd: xi, side });
	}
	return hunks;
}

/** A run of changed items between two unchanged ones, possibly empty: the k-th of one side faces the k-th of the other. */
interface Group {
	start: number;
	end: number;
}

/**
 * xdiff's xdl_change_compact for one side (`items`, `changed`) against the
 * other's change flags: each run of changes slides up and down over equal
 * items, merging with the runs it meets, and comes to rest where it faces a
 * change on the other side — one replacement — or else as low as it goes.
 */
function compact(items: number[], changed: Uint8Array, other: Uint8Array): void {
	const n = items.length;
	const isChanged = (flags: Uint8Array, at: number) => at >= 0 && at < flags.length && flags[at] === 1;
	const first = (flags: Uint8Array): Group => {
		let end = 0;
		while (isChanged(flags, end)) end++;
		return { start: 0, end };
	};
	const next = (flags: Uint8Array, group: Group): boolean => {
		if (group.end === flags.length) return false;
		group.start = group.end + 1;
		group.end = group.start;
		while (isChanged(flags, group.end)) group.end++;
		return true;
	};
	const previous = (flags: Uint8Array, group: Group): void => {
		group.end = group.start - 1;
		group.start = group.end;
		while (isChanged(flags, group.start - 1)) group.start--;
	};
	const slideUp = (group: Group): boolean => {
		if (group.start === 0 || items[group.start - 1] !== items[group.end - 1]) return false;
		changed[--group.start] = 1;
		changed[--group.end] = 0;
		while (isChanged(changed, group.start - 1)) group.start--;
		return true;
	};
	const slideDown = (group: Group): boolean => {
		if (group.end >= n || items[group.start] !== items[group.end]) return false;
		changed[group.start++] = 0;
		changed[group.end++] = 1;
		while (isChanged(changed, group.end)) group.end++;
		return true;
	};
	const group = first(changed);
	const facing = first(other);
	for (;;) {
		if (group.end > group.start) {
			let size: number;
			let lowest: number;
			let facingEnd: number;
			do {
				size = group.end - group.start;
				facingEnd = -1;
				while (slideUp(group)) previous(other, facing);
				lowest = group.end;
				if (facing.end > facing.start) facingEnd = group.end;
				while (slideDown(group)) {
					next(other, facing);
					if (facing.end > facing.start) facingEnd = group.end;
				}
			} while (size !== group.end - group.start);
			if (group.end !== lowest && facingEnd !== -1) {
				while (facing.end === facing.start) {
					slideUp(group);
					previous(other, facing);
				}
			}
		}
		if (!next(changed, group)) break;
		next(other, facing);
	}
}

/**
 * A stretch of the merge. A clean one says how many of the note's items it
 * stands for (`span`) and whether its items are exactly those (`aligned`), so
 * text kept out of the merge can be put back in the note's place for it.
 */
type Piece<T> =
	| { kind: "clean"; items: T[]; span: number; aligned: boolean }
	| { kind: "conflict"; ours: T[]; theirs: T[]; base: T[] };

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

/** Whether `inner` runs, item for item, somewhere in `outer`. */
function contains<T>(outer: readonly T[], inner: readonly T[]): boolean {
	for (let at = 0; at + inner.length <= outer.length; at++) {
		if (inner.every((item, k) => outer[at + k] === item)) return true;
	}
	return false;
}

/**
 * The merge proper over items (lines or words). `blank` says when what a
 * hunk leaves of its range is nothing: something inserted at the edge of
 * that, by the other side, would be stranded — "foo bar" erased on one
 * side, " baz" added to it on the other, is not " baz" — so it clashes.
 */
function merge<T extends string>(base: T[], ours: T[], theirs: T[], blank: (items: T[]) => boolean): Piece<T>[] {
	// At one base position insertions come first, the note's before the tablet's.
	const order = (hunk: Hunk) => (hunk.oStart === hunk.oEnd ? 0 : 2) + (hunk.side === "ours" ? 0 : 1);
	const hunks = [...diffHunks(base, ours, "ours"), ...diffHunks(base, theirs, "theirs")].sort(
		(p, q) => p.oStart - q.oStart || order(p) - order(q),
	);
	const out: Piece<T>[] = [];
	const sides = { ours, theirs };
	const itemsOf = (hunk: Hunk) => sides[hunk.side].slice(hunk.xStart, hunk.xEnd);
	const strands = (insertion: Hunk, emptied: Hunk) =>
		insertion.oStart === insertion.oEnd &&
		emptied.oStart < emptied.oEnd &&
		insertion.side !== emptied.side &&
		emptied.oStart <= insertion.oStart &&
		insertion.oStart <= emptied.oEnd &&
		blank(itemsOf(emptied)) &&
		!blank(itemsOf(insertion));
	let cursor = 0;
	let i = 0;
	// The last single insertion emitted; widened by hand, the loop's narrowing loses it.
	let inserted = null as { at: number; items: T[] } | null;
	while (i < hunks.length) {
		const group = [hunks[i]];
		const start = hunks[i].oStart;
		let end = hunks[i].oEnd;
		i++;
		while (
			i < hunks.length &&
			(overlaps(start, end, hunks[i]) || group.some((member) => strands(member, hunks[i]) || strands(hunks[i], member)))
		) {
			end = Math.max(end, hunks[i].oEnd);
			group.push(hunks[i]);
			i++;
		}
		if (start > cursor) out.push({ kind: "clean", items: base.slice(cursor, start), span: start - cursor, aligned: true });
		cursor = end;
		if (group.length === 1) {
			const hunk = group[0];
			const items = itemsOf(hunk);
			// What the note already inserted here is not inserted again: the
			// same insertion from both sides, or a merge run a second time.
			const already = start === end && inserted?.at === start && contains(inserted.items, items);
			if (!already) {
				const mine = hunk.side === "ours";
				out.push({ kind: "clean", items, span: mine ? items.length : end - start, aligned: mine });
			}
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
		// The tablet's text for the place is in the note's already — it was
		// merged before, and written around since. Not when the tablet
		// removed something: its absence cannot be seen in the note's text.
		const included = group.every((h) => h.side === "ours" || !blank(itemsOf(h))) && contains(o, t);
		if (included) out.push({ kind: "clean", items: o, span: o.length, aligned: true });
		else out.push({ kind: "conflict", ours: o, theirs: t, base: base.slice(start, end) });
	}
	if (cursor < base.length) {
		out.push({ kind: "clean", items: base.slice(cursor), span: base.length - cursor, aligned: true });
	}
	return out;
}

const tokens = (text: string): string[] => text.match(/\s+|[^\s]+/g) ?? [];

export const CONFLICT_TITLE = "> [!warning] Also changed on the reMarkable";

/**
 * The callout showing the tablet's side of a clash. Its id is made from
 * what it shows; the same clash a second time in one note gets `-2`, `-3`…,
 * so no two callouts share a block id.
 */
function conflictCallout(theirs: string[], ordinal: Map<string, number>): { id: string; lines: string[] } {
	const shown = theirs.length === 0 ? ["> *(removed there)*"] : theirs.map((line) => (line === "" ? ">" : `> ${line}`));
	const hash = textId(shown.join("\n"));
	const seen = ordinal.get(hash) ?? 0;
	ordinal.set(hash, seen + 1);
	const id = `${CONFLICT_ID_PREFIX}${hash}${seen === 0 ? "" : `-${seen + 1}`}`;
	return { id, lines: [CONFLICT_TITLE, ...shown, blockIdLine(id)] };
}

interface Callout {
	id: string;
	/** It still shows exactly what its id was made from. */
	untouched: boolean;
	/** How many of the remaining lines come before it. */
	anchor: number;
	/** Its lines, with the blank line before and after it that it came with. */
	block: string[];
}

/**
 * The text without its clash callouts, and the callouts. They are the
 * plugin's, or the owner's once edited, and never part of the merge: inside
 * a merged region they would read as text the tablet changed too.
 */
function withoutCallouts(text: string): { lines: string[]; callouts: Callout[] } {
	const lines = text.split("\n");
	const idLine = new RegExp(`^>\\s?\\^(${CONFLICT_ID_PREFIX}([0-9a-f]+)(?:-\\d+)?)\\s*$`);
	const kept: string[] = [];
	const callouts: Callout[] = [];
	let at = 0;
	for (let end = 0; end < lines.length; end++) {
		const match = idLine.exec(lines[end]);
		if (match === null) continue;
		let start = end;
		while (start > at && !/^>\s*\[!/.test(lines[start]) && lines[start - 1].startsWith(">")) start--;
		const shown = lines.slice(start + 1, end).join("\n");
		const from = start > at && lines[start - 1].trim() === "" ? start - 1 : start;
		const to = end + 1 < lines.length && lines[end + 1].trim() === "" ? end + 1 : end;
		kept.push(...lines.slice(at, from));
		callouts.push({
			id: match[1],
			untouched: lines[start] === CONFLICT_TITLE && match[2] === textId(shown),
			anchor: kept.length,
			block: lines.slice(from, to + 1),
		});
		at = to + 1;
		end = to;
	}
	kept.push(...lines.slice(at));
	return { lines: kept, callouts };
}

/**
 * Merge three versions of a note body.
 *
 * Clash callouts are taken out of all three first. Of the note's, those the
 * owner edited go back where they were, and their clash is not shown again;
 * an untouched one whose clash is still there is written anew with it, in
 * its place; one whose clash is gone goes back where it was.
 */
export function merge3(base: string, ours: string, theirs: string): MergeResult {
	const mine = withoutCallouts(ours);
	const edited = new Set(mine.callouts.filter((callout) => !callout.untouched).map((callout) => callout.id));
	const ordinal = new Map<string, number>();
	const clashes = new Set<string>();
	let conflicts = 0;
	const noLines = (items: string[]) => items.length === 0;
	const noWords = (items: string[]) => items.every((item) => item.trim() === "");
	const pieces = merge(withoutCallouts(base).lines, mine.lines, withoutCallouts(theirs).lines, noLines).map((piece) => {
		if (piece.kind === "clean") return { lines: piece.items, span: piece.span, aligned: piece.aligned, callout: [] as string[] };
		const span = piece.ours.length;
		const words = merge(tokens(piece.base.join("\n")), tokens(piece.ours.join("\n")), tokens(piece.theirs.join("\n")), noWords);
		// The region as one side wins every clash; an empty region has no lines, not one blank line.
		const winning = (side: "ours" | "theirs") => {
			const text = words.flatMap((w) => (w.kind === "clean" ? w.items : w[side])).join("");
			return text === "" ? [] : text.split("\n");
		};
		if (words.every((w) => w.kind === "clean")) return { lines: winning("ours"), span, aligned: false, callout: [] };
		conflicts++;
		const callout = conflictCallout(winning("theirs"), ordinal);
		clashes.add(callout.id);
		return { lines: winning("ours"), span, aligned: false, callout: edited.has(callout.id) ? [] : ["", ...callout.lines, ""] };
	});
	const back = mine.callouts.filter((callout) => !callout.untouched || !clashes.has(callout.id));
	const lines: string[] = [];
	let next = 0;
	// Callouts placed before the note's line `upTo` (and before everything at it) go in.
	const putBack = (upTo: number) => {
		while (next < back.length && back[next].anchor <= upTo) lines.push(...back[next++].block);
	};
	let at = 0;
	for (const piece of pieces) {
		if (piece.aligned) {
			piece.lines.forEach((line, k) => {
				putBack(at + k);
				lines.push(line);
			});
		} else {
			// A region rewritten as a whole: what stood inside it goes after it.
			putBack(at);
			lines.push(...piece.lines, ...piece.callout);
			putBack(at + piece.span - 1);
		}
		at += piece.span;
	}
	putBack(Infinity);
	return { text: lines.join("\n"), conflicts };
}
