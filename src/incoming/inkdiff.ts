/**
 * What happened to a handwritten page on the tablet (ink fork).
 *
 * The plugin knows every stroke it wrote — it regenerates them from the note
 * (ink/inkrender.ts), ids and geometry included. Comparing that with the page
 * that came back sorts every stroke on it into one of four piles:
 *
 * - **ours, untouched** — same id (or, defensively, same geometry);
 * - **ours, moved** — a new line whose `move_id` points at one of ours, which
 *   is how the tablet records a lasso move;
 * - **ours, partly erased** — a new line lying exactly along one of our
 *   strokes that disappeared: what the eraser leaves of a stroke it cut;
 * - **the owner's own ink** — everything else. Only this pile goes on to the
 *   upstream mark reader, so a strike-through is never confused with the
 *   letters it strikes.
 *
 * Missing strokes are then summed per word: a word whose ink is mostly gone
 * was erased; a word whose ink mostly reappears elsewhere was moved.
 */

import type { GeneratedStroke } from "../ink/inkrender";
import { INK_AUTHOR } from "../ink/rmwrite";
import type { Stroke } from "./rmlines";
import { RmScene, SceneLine, idKey, isDeleted } from "./rmscene";

export interface MovedWord {
	wordId: number;
	/** Displacement in device units. */
	dx: number;
	dy: number;
	/** The moved ink sits in a text-anchored group: its y is not absolute. */
	anchored: boolean;
}

export interface InkPageDiff {
	/** Ink the tablet's owner wrote — what the mark reader should see. */
	userStrokes: Stroke[];
	/** The same ink with its scene data (colour, ids), for highlighter reading. */
	userLines: SceneLine[];
	/** Words whose ink is (mostly) gone. */
	erasedWords: number[];
	/** Words with some ink gone but most of it still there, for the log. */
	partialWords: { wordId: number; erased: number }[];
	movedWords: MovedWord[];
	stats: {
		expected: number;
		intact: number;
		recoveredByGeometry: number;
		moved: number;
		remnants: number;
		missing: number;
		user: number;
		idConflicts: number;
	};
	/**
	 * False when the page does not look like what we regenerated — many of our
	 * ids carrying other shapes. Then diffing would invent erased words and
	 * hand our own letters to the mark reader, so the caller should skip it.
	 */
	trustworthy: boolean;
}

/** Share of a word's ink that must be gone before it counts as erased. */
const ERASED_THRESHOLD = 0.5;
/** Below this, missing ink is noise (a nicked letter), not even "partial". */
const PARTIAL_THRESHOLD = 0.15;
/** Share of a word's ink that must reappear elsewhere to count as moved. */
const MOVED_THRESHOLD = 0.6;
/** Geometry tolerance in device units for "the same point". */
const SAME_POINT = 1.5;

function strokeLength(points: { x: number; y: number }[]): number {
	let total = 0;
	for (let i = 1; i < points.length; i++) {
		total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
	}
	// A dot still has ink; count it as a short stroke.
	return Math.max(total, 1);
}

interface Box {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

function boxOf(points: { x: number; y: number }[]): Box {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const point of points) {
		minX = Math.min(minX, point.x);
		minY = Math.min(minY, point.y);
		maxX = Math.max(maxX, point.x);
		maxY = Math.max(maxY, point.y);
	}
	return { minX, minY, maxX, maxY };
}

function sameGeometry(
	a: { x: number; y: number }[],
	b: { x: number; y: number }[],
	dx = 0,
	dy = 0,
	tolerance = SAME_POINT,
): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (Math.abs(a[i].x - dx - b[i].x) > tolerance || Math.abs(a[i].y - dy - b[i].y) > tolerance) {
			return false;
		}
	}
	return true;
}

/** Distance from a point to a polyline. */
function distanceToPolyline(
	point: { x: number; y: number },
	line: { x: number; y: number }[],
): number {
	if (line.length === 1) return Math.hypot(point.x - line[0].x, point.y - line[0].y);
	let best = Infinity;
	for (let i = 1; i < line.length; i++) {
		const a = line[i - 1];
		const b = line[i];
		const vx = b.x - a.x;
		const vy = b.y - a.y;
		const len2 = vx * vx + vy * vy;
		const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - a.x) * vx + (point.y - a.y) * vy) / len2));
		best = Math.min(best, Math.hypot(point.x - (a.x + t * vx), point.y - (a.y + t * vy)));
	}
	return best;
}

/** Median of a non-empty list. */
function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Compare the strokes we wrote on one page with what the page holds now.
 * `expected` must be the regenerated strokes of exactly this page.
 */
export function diffInkPage(expected: GeneratedStroke[], scene: RmScene): InkPageDiff {
	const byCounter = new Map<number, GeneratedStroke>();
	for (const stroke of expected) byCounter.set(stroke.counter, stroke);

	const intact = new Set<number>();
	const movedCopies = new Map<number, { dx: number; dy: number; anchored: boolean; length: number }>();
	const unexplained: SceneLine[] = [];
	let recoveredByGeometry = 0;
	let idConflicts = 0;

	// Geometry index for the defensive fallback: first point, rounded.
	const byFirstPoint = new Map<string, GeneratedStroke[]>();
	const cell = (x: number, y: number) => `${Math.round(x / 4)}|${Math.round(y / 4)}`;
	for (const stroke of expected) {
		const key = cell(stroke.points[0].x, stroke.points[0].y);
		const list = byFirstPoint.get(key) ?? [];
		list.push(stroke);
		byFirstPoint.set(key, list);
	}

	for (const line of scene.lines) {
		const points = line.stroke.points;
		// 1. One of ours, by id — confirmed by geometry, because an id is only
		//    ours if the tablet did not happen to reuse author 1 itself.
		if (line.id.author === INK_AUTHOR && byCounter.has(line.id.counter)) {
			const own = byCounter.get(line.id.counter)!;
			if (sameGeometry(points, own.points)) {
				intact.add(own.counter);
				continue;
			}
			idConflicts++;
		}
		// 2. A move of one of ours: the tablet points back at the original.
		if (line.moveFrom !== undefined && line.moveFrom.author === INK_AUTHOR) {
			const own = byCounter.get(line.moveFrom.counter);
			if (own !== undefined) {
				const dx =
					points.length === own.points.length
						? median(points.map((point, i) => point.x - own.points[i].x))
						: (boxOf(points).minX + boxOf(points).maxX - boxOf(own.points).minX - boxOf(own.points).maxX) / 2;
				const dy =
					points.length === own.points.length
						? median(points.map((point, i) => point.y - own.points[i].y))
						: (boxOf(points).minY + boxOf(points).maxY - boxOf(own.points).minY - boxOf(own.points).maxY) / 2;
				const previous = movedCopies.get(own.counter);
				movedCopies.set(own.counter, {
					dx,
					dy,
					anchored: line.anchored,
					length: (previous?.length ?? 0) + strokeLength(points),
				});
				continue;
			}
		}
		// 3. Same geometry as one of ours under a different id: a firmware
		//    that rewrote ids must not turn the whole page into "erased".
		const candidates = byFirstPoint.get(cell(points[0].x, points[0].y)) ?? [];
		const twin = candidates.find((own) => !intact.has(own.counter) && sameGeometry(points, own.points));
		if (twin !== undefined) {
			intact.add(twin.counter);
			recoveredByGeometry++;
			continue;
		}
		unexplained.push(line);
	}

	// Strokes of ours that are neither intact nor moved: erased, wholly or
	// in part. An explicit tombstone is not required — absence is enough.
	const missing = expected.filter(
		(stroke) => !intact.has(stroke.counter) && !movedCopies.has(stroke.counter),
	);
	const missingBoxes = missing.map((stroke) => ({ stroke, box: boxOf(stroke.points) }));

	// 4. A copy of one of ours somewhere else, without a move_id pointing at
	//    it: a word lassoed twice (the second move points at the first,
	//    tablet-authored copy), a copy and paste, a firmware that leaves the
	//    field out. Same shape, shifted — still our letters, moved.
	const stillMissing = (stroke: GeneratedStroke) => !intact.has(stroke.counter) && !movedCopies.has(stroke.counter);
	const bySize = new Map<number, GeneratedStroke[]>();
	for (const stroke of expected) {
		const list = bySize.get(stroke.points.length) ?? [];
		list.push(stroke);
		bySize.set(stroke.points.length, list);
	}
	const leftover: SceneLine[] = [];
	for (const line of unexplained) {
		const points = line.stroke.points;
		const twin =
			points.length >= 3
				? (bySize.get(points.length) ?? []).find((own) => {
						if (!stillMissing(own)) return false;
						const dx = points[0].x - own.points[0].x;
						const dy = points[0].y - own.points[0].y;
						return (dx !== 0 || dy !== 0) && sameGeometry(points, own.points, dx, dy);
					})
				: undefined;
		if (twin === undefined) {
			leftover.push(line);
			continue;
		}
		movedCopies.set(twin.counter, {
			dx: points[0].x - twin.points[0].x,
			dy: points[0].y - twin.points[0].y,
			anchored: line.anchored,
			length: strokeLength(points),
		});
	}
	unexplained.length = 0;
	unexplained.push(...leftover);
	missing.splice(0, missing.length, ...missing.filter(stillMissing));
	missingBoxes.splice(0, missingBoxes.length, ...missingBoxes.filter(({ stroke }) => stillMissing(stroke)));

	// 5. Remnants: a new line lying along a stroke of ours that went missing
	//    is what the eraser left of it — still our ink, not a mark.
	const remnantLength = new Map<number, number>();
	const userStrokes: Stroke[] = [];
	const userLines: SceneLine[] = [];
	let remnants = 0;
	for (const line of unexplained) {
		const points = line.stroke.points;
		const box = boxOf(points);
		const width = Math.max(...points.map((point) => point.width), 0) / 4;
		const tolerance = 3 + width;
		const host = missingBoxes.find(
			({ stroke, box: own }) =>
				box.minX >= own.minX - tolerance &&
				box.maxX <= own.maxX + tolerance &&
				box.minY >= own.minY - tolerance &&
				box.maxY <= own.maxY + tolerance &&
				points.every((point) => distanceToPolyline(point, stroke.points) <= tolerance),
		);
		if (host !== undefined) {
			remnants++;
			remnantLength.set(
				host.stroke.counter,
				(remnantLength.get(host.stroke.counter) ?? 0) + strokeLength(points),
			);
			continue;
		}
		userStrokes.push(line.stroke);
		userLines.push(line);
	}

	// Per word: how much of its ink is still where we put it, moved, or gone.
	const words = new Map<number, { total: number; present: number; moved: number; offsets: MovedWord[] }>();
	for (const stroke of expected) {
		if (stroke.wordId === null) continue;
		const length = strokeLength(stroke.points);
		const entry = words.get(stroke.wordId) ?? { total: 0, present: 0, moved: 0, offsets: [] };
		entry.total += length;
		if (intact.has(stroke.counter)) {
			entry.present += length;
		} else if (movedCopies.has(stroke.counter)) {
			const copy = movedCopies.get(stroke.counter)!;
			entry.moved += length;
			entry.offsets.push({ wordId: stroke.wordId, dx: copy.dx, dy: copy.dy, anchored: copy.anchored });
		} else {
			entry.present += Math.min(length, remnantLength.get(stroke.counter) ?? 0);
		}
		words.set(stroke.wordId, entry);
	}

	const erasedWords: number[] = [];
	const partialWords: { wordId: number; erased: number }[] = [];
	const movedWords: MovedWord[] = [];
	for (const [wordId, entry] of [...words.entries()].sort((a, b) => a[0] - b[0])) {
		if (entry.total <= 0) continue;
		if (entry.moved / entry.total >= MOVED_THRESHOLD && entry.offsets.length > 0) {
			movedWords.push({
				wordId,
				dx: median(entry.offsets.map((offset) => offset.dx)),
				dy: median(entry.offsets.map((offset) => offset.dy)),
				anchored: entry.offsets.some((offset) => offset.anchored),
			});
			continue;
		}
		const gone = 1 - (entry.present + entry.moved) / entry.total;
		if (gone >= ERASED_THRESHOLD) erasedWords.push(wordId);
		else if (gone >= PARTIAL_THRESHOLD) partialWords.push({ wordId, erased: Math.round(gone * 100) / 100 });
	}

	const conflictLimit = Math.max(3, expected.length * 0.05);
	return {
		trustworthy: idConflicts <= conflictLimit,
		userStrokes,
		userLines,
		erasedWords,
		partialWords,
		movedWords,
		stats: {
			expected: expected.length,
			intact: intact.size,
			recoveredByGeometry,
			moved: movedCopies.size,
			remnants,
			missing: missing.length,
			user: userStrokes.length,
			idConflicts,
		},
	};
}

/** Explicitly deleted strokes of ours, for the log (absence already counts). */
export function tombstonedCounters(expected: GeneratedStroke[], scene: RmScene): number {
	return expected.filter((stroke) =>
		isDeleted({ author: INK_AUTHOR, counter: stroke.counter }, scene.deleted),
	).length;
}

/** Diagnostic one-liner for the import log. */
export function describeDiff(diff: InkPageDiff): string {
	const s = diff.stats;
	return (
		`${s.expected} generated stroke(s): ${s.intact} intact` +
		(s.recoveredByGeometry > 0 ? ` (${s.recoveredByGeometry} matched by shape)` : "") +
		`, ${s.moved} moved, ${s.missing} missing (${s.remnants} eraser remnant(s)); ` +
		`${s.user} stroke(s) of your own` +
		(s.idConflicts > 0 ? `; ${s.idConflicts} id conflict(s)` : "") +
		` — words: ${diff.erasedWords.length} erased, ${diff.movedWords.length} moved, ${diff.partialWords.length} partly erased`
	);
}

export { idKey };
