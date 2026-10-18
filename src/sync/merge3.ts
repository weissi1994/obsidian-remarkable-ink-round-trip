/**
 * Three-way merge of a note: the body as it was sent (base), the note as it
 * reads now (ours) and the base with the tablet's changes applied (theirs).
 *
 * Line-based first; a region both sides touched is merged again word by word,
 * since a markdown paragraph is one long line and an erased word on the
 * tablet must not clash with a typo fixed elsewhere in the same paragraph.
 * Only when both sides changed the same words does it conflict: then the
 * note keeps its own text and the tablet's version follows in a callout.
 */

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

function merge<T extends string>(base: T[], ours: T[], theirs: T[]): Piece<T>[] {
	const hunks = [...diffHunks(base, ours, "ours"), ...diffHunks(base, theirs, "theirs")].sort(
		(p, q) => p.oStart - q.oStart || p.oEnd - q.oEnd,
	);
	const out: Piece<T>[] = [];
	const sides = { ours, theirs };
	let cursor = 0;
	let i = 0;
	while (i < hunks.length) {
		const group = [hunks[i]];
		let end = hunks[i].oEnd;
		i++;
		// Touching hunks group too: the word-level pass sorts those out.
		while (i < hunks.length && hunks[i].oStart <= end) {
			end = Math.max(end, hunks[i].oEnd);
			group.push(hunks[i]);
			i++;
		}
		const start = group[0].oStart;
		if (start > cursor) out.push({ kind: "clean", items: base.slice(cursor, start) });
		const textOf = (side: Hunk["side"]): T[] => {
			const mine = group.filter((h) => h.side === side);
			if (mine.length === 0) return base.slice(start, end);
			const first = mine[0];
			const last = mine[mine.length - 1];
			return sides[side].slice(first.xStart - (first.oStart - start), last.xEnd + (end - last.oEnd));
		};
		const o = textOf("ours");
		const t = textOf("theirs");
		const oursChanged = group.some((h) => h.side === "ours");
		const theirsChanged = group.some((h) => h.side === "theirs");
		if (!theirsChanged) out.push({ kind: "clean", items: o });
		else if (!oursChanged) out.push({ kind: "clean", items: t });
		else if (o.length === t.length && o.every((item, k) => item === t[k])) out.push({ kind: "clean", items: o });
		else out.push({ kind: "conflict", ours: o, theirs: t, base: base.slice(start, end) });
		cursor = end;
	}
	if (cursor < base.length) out.push({ kind: "clean", items: base.slice(cursor) });
	return out;
}

const tokens = (text: string): string[] => text.match(/\s+|[^\s]+/g) ?? [];

/** Merge three versions of a note body. */
export function merge3(base: string, ours: string, theirs: string): MergeResult {
	if (ours === base) return { text: theirs, conflicts: 0 };
	if (theirs === base || theirs === ours) return { text: ours, conflicts: 0 };
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
		if (words.every((w) => w.kind === "clean")) {
			lines.push(...words.flatMap((w) => (w.kind === "clean" ? w.items : [])).join("").split("\n"));
			continue;
		}
		conflicts++;
		lines.push(...piece.ours);
		lines.push(
			"",
			"> [!warning] Also changed on the reMarkable",
			...(piece.theirs.length === 0 ? ["> *(removed there)*"] : piece.theirs.map((line) => `> ${line}`)),
			"",
		);
	}
	return { text: lines.join("\n"), conflicts };
}
