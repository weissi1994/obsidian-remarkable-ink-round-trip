/**
 * A regenerated notebook page turned into the page the tablet sends back
 * after the owner worked on it: words erased whole or in part, lassoed
 * elsewhere, struck through, underlined, circled, a bar in the margin, a
 * task ticked, handwriting written between the lines, text typed — and pages
 * the owner added. Everything is written the way the tablet records it
 * (rmwrite.ts SceneItemSpec): our strokes tombstoned under their own ids,
 * moves as new lines pointing back at ours, the owner's ink under author 2.
 */

import type { LaidOutLine, PdfLayout, PlacedWord } from "../../convert/pdf";
import { rowsOf, type Row } from "../../incoming/marks";
import { deviceGridFor } from "../../incoming/strokerender";
import type { InkStrokes } from "../../ink/inkimage";
import { hasColour, toInkLines, type GeneratedStroke, type InkRender, type InkRenderOptions } from "../../ink/inkrender";
import { buildScenePageRm, INK_AUTHOR, PEN, PEN_COLOR, type InkLine, type SceneItemSpec } from "../../ink/rmwrite";
import { buildTextPageRm, markdownToTypedText } from "../../ink/roottext";
import { editTypedPage } from "../../ink/textedit";

/** The tablet's own author on our pages. */
export const OWNER = 2;

type Pt = { x: number; y: number };
type OwnerLine = Omit<InkLine, "counter">;

/** A regenerated notebook with its strokes as the page files hold them. */
export interface Notebook {
	render: InkRender;
	/** Per page, the lines inkPagesToRm writes. */
	lines: InkLine[][];
	paper: { width: number; height: number };
}

export function notebookOf(render: InkRender, options: InkRenderOptions): Notebook {
	return {
		render,
		lines: render.pages.map((strokes) => toInkLines(strokes, options.pen, hasColour(options.profile))),
		paper: { width: options.profile.width, height: options.profile.height },
	};
}

/** A laid-out word with the line it sits on. */
export interface WordAt {
	word: PlacedWord;
	line: LaidOutLine;
}

export function wordsOn(layout: PdfLayout, page: number): WordAt[] {
	return layout.lines.filter((line) => line.page === page).flatMap((line) => line.words.map((word) => ({ word, line })));
}

/** The body line pitch marks.ts measures thresholds in (its lineStepOf). */
export function stepOf(rows: Row[]): number {
	if (rows.length === 0) return 16.5;
	const sizes = rows.map((row) => row.size).sort((a, b) => a - b);
	return sizes[Math.floor(sizes.length / 2)] * 1.5;
}

/** PDF points (y up) → device units (x centred, y down). */
export function toDevice(layout: PdfLayout, point: Pt): Pt {
	const grid = layout.grid ?? deviceGridFor(layout);
	return {
		x: (point.x * grid.width) / layout.pageWidth - grid.width / 2,
		y: ((layout.pageHeight - point.y) * grid.height) / layout.pageHeight,
	};
}

/** Device units → PDF points. */
export function toPdf(layout: PdfLayout, point: Pt): Pt {
	const grid = layout.grid ?? deviceGridFor(layout);
	return {
		x: ((point.x + grid.width / 2) * layout.pageWidth) / grid.width,
		y: layout.pageHeight - (point.y * layout.pageHeight) / grid.height,
	};
}

/** Device box of some of our strokes. */
export function boxOf(strokes: { points: Pt[] }[]): { minX: number; minY: number; maxX: number; maxY: number } {
	const points = strokes.flatMap((stroke) => stroke.points);
	return {
		minX: Math.min(...points.map((p) => p.x)),
		minY: Math.min(...points.map((p) => p.y)),
		maxX: Math.max(...points.map((p) => p.x)),
		maxY: Math.max(...points.map((p) => p.y)),
	};
}

function lengthOf(points: Pt[]): number {
	let total = 0;
	for (let i = 1; i < points.length; i++) total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
	return Math.max(total, 1);
}

/** A polyline through `points`, a point every `every` units, the way a pen samples. */
function dense(points: Pt[], every: number): Pt[] {
	const out: Pt[] = [];
	for (let i = 1; i < points.length; i++) {
		const from = points[i - 1];
		const to = points[i];
		const steps = Math.max(2, Math.round(Math.hypot(to.x - from.x, to.y - from.y) / every));
		for (let k = 0; k < steps; k++) out.push({ x: from.x + ((to.x - from.x) * k) / steps, y: from.y + ((to.y - from.y) * k) / steps });
	}
	out.push(points[points.length - 1]);
	return out;
}

/** A ballpoint line through device points. */
export function penLine(points: Pt[]): OwnerLine {
	return {
		tool: PEN.ballpoint,
		color: PEN_COLOR.black,
		thicknessScale: 2,
		points: points.map((p) => ({ x: p.x, y: p.y, width: 16, pressure: 200, speed: 5, direction: 0 })),
	};
}

/** Real ink (an InkStrokes record, from its own corner) with its corner at `at`, device units. */
export function inkAt(ink: InkStrokes, at: Pt): OwnerLine[] {
	return ink.strokes.map((stroke) => {
		const points = [];
		for (let i = 0; i + 2 < stroke.points.length; i += 3) {
			points.push({ x: at.x + stroke.points[i], y: at.y + stroke.points[i + 1], width: stroke.points[i + 2], pressure: 200, speed: 5, direction: 0 });
		}
		return { tool: stroke.tool, color: stroke.color, thicknessScale: stroke.thicknessScale, points };
	});
}

/** Strokes kept as absolute device points (a sample's remark) as fineliner lines. */
export function absoluteInk(strokes: Pt[][]): OwnerLine[] {
	return strokes.map((points) => ({ ...penLine(points), tool: PEN.fineliner }));
}

/** One page of the notebook as the owner left it. */
export class TabletPage {
	private readonly ours = new Map<number, SceneItemSpec[]>();
	private readonly extra: SceneItemSpec[] = [];
	private typed: string | undefined;
	private next = 1_000_000;

	constructor(
		readonly book: Notebook,
		readonly page: number,
	) {}

	get layout(): PdfLayout {
		return this.book.render.layout;
	}

	get strokes(): GeneratedStroke[] {
		return this.book.render.pages[this.page - 1];
	}

	private lineOf(stroke: GeneratedStroke): InkLine {
		return this.book.lines[this.page - 1][this.strokes.indexOf(stroke)];
	}

	strokesOf(wordId: number): GeneratedStroke[] {
		return this.strokes.filter((stroke) => stroke.wordId === wordId);
	}

	private at(wordId: number): WordAt {
		const found = wordsOn(this.layout, this.page).find((entry) => entry.word.id === wordId);
		if (found === undefined) throw new Error(`word ${wordId} is not on page ${this.page}`);
		return found;
	}

	/** Every stroke of these words rubbed out. */
	erase(...wordIds: number[]): this {
		for (const id of wordIds) {
			for (const stroke of this.strokesOf(id)) this.ours.set(stroke.counter, [{ author: INK_AUTHOR, counter: stroke.counter, deletedLength: 1 }]);
		}
		return this;
	}

	/**
	 * About `share` of a word's ink rubbed out: whole strokes while they fit,
	 * then one stroke cut, what the eraser leaves of it lying exactly along it.
	 */
	partlyErase(wordId: number, share = 0.3): this {
		const strokes = this.strokesOf(wordId);
		const total = strokes.reduce((sum, stroke) => sum + lengthOf(stroke.points), 0);
		let gone = 0;
		for (const stroke of strokes) {
			const length = lengthOf(stroke.points);
			if (gone + length <= total * share) {
				this.ours.set(stroke.counter, [{ author: INK_AUTHOR, counter: stroke.counter, deletedLength: 1 }]);
				gone += length;
				continue;
			}
			// Cut this one: keep its start, so the gone part brings the total to `share`.
			const want = total * share - gone;
			let kept = stroke.points.length;
			for (let n = 2; n <= stroke.points.length; n++) {
				if (length - lengthOf(stroke.points.slice(0, n)) <= want) {
					kept = n;
					break;
				}
			}
			const line = this.lineOf(stroke);
			this.ours.set(stroke.counter, [
				{ author: INK_AUTHOR, counter: stroke.counter, deletedLength: 1 },
				{ author: OWNER, counter: this.next++, line: { ...line, points: line.points.slice(0, Math.max(2, kept)) } },
			]);
			break;
		}
		return this;
	}

	/** A lasso move: these strokes of ours picked up and put down `dx`, `dy` device units away. */
	moveStrokes(strokes: GeneratedStroke[], dx: number, dy: number): this {
		for (const stroke of strokes) {
			const line = this.lineOf(stroke);
			this.ours.set(stroke.counter, [
				{ author: INK_AUTHOR, counter: stroke.counter, deletedLength: 1 },
				{
					author: OWNER,
					counter: this.next++,
					moveFrom: { author: INK_AUTHOR, counter: stroke.counter },
					line: { ...line, points: line.points.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy })) },
				},
			]);
		}
		return this;
	}

	/** These words lassoed and moved. */
	move(wordIds: number[], dx: number, dy: number): this {
		return this.moveStrokes(wordIds.flatMap((id) => this.strokesOf(id)), dx, dy);
	}

	/** A whole row lassoed — its words and whatever else of ours sits in its band (bullet, box). */
	rowStrokes(row: Row): GeneratedStroke[] {
		const ids = new Set(row.lines.flatMap((line) => line.words.map((word) => word.id)));
		const top = toDevice(this.layout, { x: 0, y: row.y + row.size * 0.85 }).y;
		const bottom = toDevice(this.layout, { x: 0, y: row.y - row.size * 0.3 }).y;
		return this.strokes.filter((stroke) => {
			if (stroke.wordId !== null) return ids.has(stroke.wordId);
			const box = boxOf([stroke]);
			return box.minY >= top && box.maxY <= bottom;
		});
	}

	/** The owner's own ink on the page. */
	write(...lines: OwnerLine[]): this {
		for (const line of lines) this.extra.push({ author: OWNER, counter: this.next++, line });
		return this;
	}

	/** A flat pen line across a word: through its letters, or under them. */
	private flat(wordId: number, through: boolean): this {
		const { word, line } = this.at(wordId);
		const y = through ? line.y + line.size * 0.3 : line.y - line.size * 0.12;
		const wobble = line.size * 0.04;
		const from = word.x + word.width * 0.02;
		const to = word.x + word.width * 0.98;
		const points: Pt[] = [];
		const steps = Math.max(8, Math.round((to - from) / 2));
		for (let k = 0; k <= steps; k++) points.push({ x: from + ((to - from) * k) / steps, y: y + (k % 2 === 0 ? wobble : -wobble) });
		return this.write(penLine(points.map((p) => toDevice(this.layout, p))));
	}

	strike(wordId: number): this {
		return this.flat(wordId, true);
	}

	underline(wordId: number): this {
		return this.flat(wordId, false);
	}

	/** A loop around a word. */
	circle(wordId: number): this {
		const { word, line } = this.at(wordId);
		const cx = word.x + word.width / 2;
		const cy = line.y + line.size * 0.3;
		const rx = word.width / 2 + line.size * 0.15;
		const ry = line.size * 0.75;
		const points: Pt[] = [];
		for (let k = 0; k <= 48; k++) {
			const a = (k / 48) * Math.PI * 2 * 0.97;
			points.push(toDevice(this.layout, { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) }));
		}
		return this.write(penLine(points));
	}

	/** A straight bar in the margin beside a row, left of the text column (right of it when there is no room). */
	marginBar(row: Row): this {
		const rows = rowsOf(this.layout, this.page).filter((candidate) => Number.isFinite(candidate.left));
		const left = Math.min(...rows.map((candidate) => candidate.left));
		const right = Math.max(...rows.map((candidate) => candidate.right));
		const x = left >= 14 ? left - 8 : right + 8;
		const top = { x, y: row.y + row.size };
		const bottom = { x, y: row.y - row.size * 0.3 };
		return this.write(penLine(dense([top, bottom], 2).map((p) => toDevice(this.layout, p))));
	}

	/** A tick in the drawn box of a task line. */
	tick(line: LaidOutLine): this {
		const box = line.checkbox;
		if (box === undefined) throw new Error("no checkbox on that line");
		const points = dense(
			[
				{ x: box.x + box.size * 0.2, y: box.y + box.size * 0.5 },
				{ x: box.x + box.size * 0.45, y: box.y + box.size * 0.2 },
				{ x: box.x + box.size * 0.9, y: box.y + box.size * 0.9 },
			],
			0.8,
		);
		return this.write(penLine(points.map((p) => toDevice(this.layout, p))));
	}

	/** Text typed on the page (a RootText of ours, the owner's characters under author 2). */
	type(markdown: string): this {
		this.typed = markdown;
		return this;
	}

	bytes(): Uint8Array {
		const lines = this.book.lines[this.page - 1];
		if (this.typed !== undefined) {
			if (this.ours.size > 0 || this.extra.length > 0) throw new Error("typing goes on an otherwise untouched page");
			const edit = editTypedPage(buildTextPageRm(markdownToTypedText(""), lines, { paperSize: this.book.paper }), markdownToTypedText(this.typed), OWNER);
			if (edit.kind !== "edited") throw new Error(`typing: ${edit.kind}${edit.kind === "refused" ? ` (${edit.reason})` : ""}`);
			return edit.bytes;
		}
		const items = this.strokes.flatMap(
			(stroke, index) => this.ours.get(stroke.counter) ?? [{ author: INK_AUTHOR, counter: stroke.counter, line: lines[index] }],
		);
		return buildScenePageRm([...items, ...this.extra], { paperSize: this.book.paper });
	}
}

/** A page the owner added and wrote on. */
export function ownerPage(paper: { width: number; height: number }, lines: OwnerLine[]): Uint8Array {
	return buildScenePageRm(
		lines.map((line, index) => ({ author: OWNER, counter: 1_000_000 + index, line })),
		{ paperSize: paper },
	);
}
