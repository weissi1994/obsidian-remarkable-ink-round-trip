/**
 * The import of a handwritten notebook (ink fork).
 *
 * Mirrors upstream's collectHighlights for review copies, with one extra
 * step at the front: every page is first diffed against the strokes the
 * plugin wrote (inkdiff.ts). What the tablet's owner wrote then goes through
 * the unchanged upstream mark reader; what happened to the plugin's own
 * words comes back as two new kinds, "erased" and "moved".
 *
 * Page numbers come from the page ids recorded at send time rather than from
 * `.content`: a notebook page has no PDF page behind it to redirect to, and
 * the ids are ours. A page id we never wrote is a page the owner added.
 */

import type { LaidOutLine, PdfLayout } from "../convert/pdf";
import type { GeneratedStroke, InkRender } from "../ink/inkrender";
import type { MappingEntry } from "../id/mapping";
import { deviceBoundsToPdf, strokeBounds } from "./anchor";
import type { Highlight } from "./highlights";
import { describeDiff, diffInkPage, InkPageDiff } from "./inkdiff";
import { readMarks } from "./marks";
import { pageIdOfFile, parsePageOrder } from "./pagemap";
import type { DocumentFile, DocumentScan, ImportedMark, InkHighlight, PullDeps, StrokeRenderRequest } from "./pull";
import { TEXT_ONLY_KINDS } from "./pull";
import type { Stroke } from "./rmlines";
import { parseRmScene, SceneLine } from "./rmscene";
import { remarkId } from "./remarkid";

/** Freehand highlighter pens (rmscene HIGHLIGHTER_1 / HIGHLIGHTER_2). */
const HIGHLIGHTER_TOOLS = new Set([5, 18]);

/** Device colour index → the colour a highlight should carry in the vault. */
const HIGHLIGHTER_RGB: Record<number, string> = {
	3: "#ffed75", // yellow
	4: "#b2f2bb", // green
	5: "#f29eff", // pink
	6: "#beeafe", // blue
	7: "#ffc9c9", // red
	1: "#dee2e6", // grey
};

interface Row {
	y: number;
	size: number;
	words: { id: number; text: string; x: number; width: number }[];
	text: string;
}

/** Text rows of one page, top to bottom (same grouping as marks.ts). */
function rowsOf(layout: PdfLayout, page: number): Row[] {
	const byBaseline = new Map<number, LaidOutLine[]>();
	for (const line of layout.lines) {
		if (line.page !== page) continue;
		const key = Math.round(line.y * 2) / 2;
		const list = byBaseline.get(key) ?? [];
		list.push(line);
		byBaseline.set(key, list);
	}
	return [...byBaseline.entries()]
		.map(([y, lines]) => {
			const sorted = [...lines].sort((a, b) => a.x - b.x);
			const words = sorted.flatMap((line) => line.words);
			return {
				y,
				size: sorted[0].size,
				words,
				text: words.map((word) => word.text).join(" "),
			};
		})
		.sort((a, b) => b.y - a.y);
}

/** Consecutive word ids as runs, so one erased phrase is one mark. */
function runsOf(ids: number[]): number[][] {
	const sorted = [...new Set(ids)].sort((a, b) => a - b);
	const runs: number[][] = [];
	for (const id of sorted) {
		const last = runs[runs.length - 1];
		if (last !== undefined && id === last[last.length - 1] + 1) last.push(id);
		else runs.push([id]);
	}
	return runs;
}

function wordText(layout: PdfLayout, ids: number[]): string {
	const wanted = new Set(ids);
	return layout.lines
		.flatMap((line) => line.words)
		.filter((word) => wanted.has(word.id))
		.sort((a, b) => a.id - b.id)
		.map((word) => word.text)
		.join(" ");
}

/**
 * Where a moved phrase landed, as "after word X" or "before word Y".
 * Undefined when it landed in empty space or in text-anchored ink, whose
 * vertical position this reader cannot trust.
 */
function landingOf(
	layout: PdfLayout,
	page: number,
	ids: number[],
	dx: number,
	dy: number,
): { after?: number; before?: number; quote?: string } | undefined {
	const moving = new Set(ids);
	const rows = rowsOf(layout, page);
	const grid = layout.grid ?? { width: 1404, height: 1872 };
	const sx = grid.width / layout.pageWidth;
	const sy = grid.height / layout.pageHeight;
	const words = rows.flatMap((row) => row.words.map((word) => ({ ...word, row })));
	const phrase = words.filter((word) => moving.has(word.id));
	if (phrase.length === 0) return undefined;
	// The phrase's new left edge and vertical centre, in PDF points.
	const left = Math.min(...phrase.map((word) => word.x)) + dx / sx;
	const centreY =
		phrase.reduce((sum, word) => sum + word.row.y + word.row.size * 0.3, 0) / phrase.length - dy / sy;
	const row = rows.find(
		(candidate) => centreY >= candidate.y - candidate.size * 0.45 && centreY <= candidate.y + candidate.size * 1.05,
	);
	if (row === undefined) return undefined;
	const others = row.words.filter((word) => !moving.has(word.id));
	if (others.length === 0) return undefined;
	const before = others.filter((word) => word.x + word.width / 2 <= left);
	if (before.length > 0) {
		const anchor = before.reduce((best, word) => (word.x > best.x ? word : best));
		return { after: anchor.id, quote: row.text };
	}
	return { before: others[0].id, quote: row.text };
}

/** Moved words grouped by a shared displacement: one lasso, one phrase. */
function movedGroups(diff: InkPageDiff): { ids: number[]; dx: number; dy: number; anchored: boolean }[] {
	const groups: { ids: number[]; dx: number; dy: number; anchored: boolean }[] = [];
	for (const word of diff.movedWords) {
		const group = groups.find(
			(candidate) => Math.abs(candidate.dx - word.dx) <= 8 && Math.abs(candidate.dy - word.dy) <= 8,
		);
		if (group !== undefined) {
			group.ids.push(word.wordId);
			group.anchored ||= word.anchored;
		} else {
			groups.push({ ids: [word.wordId], dx: word.dx, dy: word.dy, anchored: word.anchored });
		}
	}
	return groups;
}

/** Words a freehand highlighter stroke covers, as a Highlight. */
function highlightOf(line: SceneLine, layout: PdfLayout, page: number): Highlight | null {
	const device = strokeBounds([line.stroke]);
	if (device === null) return null;
	const pdf = deviceBoundsToPdf(device, layout);
	const covered: string[] = [];
	for (const row of rowsOf(layout, page)) {
		const low = row.y - row.size * 0.3;
		const high = row.y + row.size * 0.85;
		if (pdf.maxY < low || pdf.minY > high) continue;
		for (const word of row.words) {
			const overlap = Math.min(pdf.maxX, word.x + word.width) - Math.max(pdf.minX, word.x);
			if (overlap >= word.width * 0.5) covered.push(word.text);
		}
	}
	if (covered.length === 0) return null;
	return {
		text: covered.join(" "),
		page,
		rgb: line.rgb ?? HIGHLIGHTER_RGB[line.stroke.color] ?? "#ffed75",
	};
}

function emptyScan(allFiles: DocumentFile[], strokeFiles: DocumentFile[]): DocumentScan {
	return {
		totalFiles: allFiles.length,
		highlightFiles: 0,
		strokeFiles: strokeFiles.length,
		parsedHighlights: 0,
		unreadableFiles: 0,
		renderedPages: 0,
		renderedRemarks: 0,
		anchoredRemarks: 0,
		interpretedMarks: 0,
		highlightsInStrokes: 0,
		addedPages: 0,
		ink: { erasedWords: 0, movedWords: 0, partialWords: 0, ownStrokes: 0, transcribed: 0 },
	};
}

/**
 * The table column a remark sits in: the column whose cells start at or left
 * of the middle of the ink, among the table rows it overlaps. Undefined
 * when it overlaps no table row. Columns are told apart by where their cell
 * text starts (a table line's `level` is its row, not its column).
 */
export function tableColumnUnder(layout: PdfLayout, page: number, strokes: Stroke[]): number | undefined {
	const device = strokeBounds(strokes);
	if (device === null) return undefined;
	const pdf = deviceBoundsToPdf(device, layout);
	const tableLines = layout.lines.filter((line) => line.page === page && line.role === "table");
	const beside = tableLines.filter((line) => pdf.maxY >= line.y - line.size * 0.3 && pdf.minY <= line.y + line.size * 0.85);
	if (beside.length === 0) return undefined;
	// The whole table: the run of consecutive table blocks (one per row) around it.
	const tableBlocks = new Set(layout.lines.filter((line) => line.role === "table").map((line) => line.block));
	let first = Math.min(...beside.map((line) => line.block));
	let last = Math.max(...beside.map((line) => line.block));
	while (tableBlocks.has(first - 1)) first--;
	while (tableBlocks.has(last + 1)) last++;
	const table = layout.lines.filter((line) => line.role === "table" && line.block >= first && line.block <= last);
	const starts = [...new Set(table.map((line) => Math.round(line.x)))].sort((a, b) => a - b);
	const middle = (pdf.minX + pdf.maxX) / 2;
	let column = 0;
	starts.forEach((x, index) => {
		if (x <= middle + 2) column = index;
	});
	return column;
}

/** Highlighter strokes lying over a remark's ink, with their colour. */
function highlightsOver(lines: SceneLine[], strokes: Stroke[]): InkHighlight[] {
	const ink = strokeBounds(strokes);
	if (ink === null) return [];
	const out: InkHighlight[] = [];
	for (const line of lines) {
		const b = strokeBounds([line.stroke]);
		if (b === null || b.maxX < ink.minX || b.minX > ink.maxX || b.maxY < ink.minY || b.minY > ink.maxY) continue;
		out.push({
			strokes: [line.stroke.points.map((p) => ({ x: p.x, y: p.y }))],
			rgb: line.rgb ?? HIGHLIGHTER_RGB[line.stroke.color] ?? "#ffed75",
		});
	}
	return out;
}

/** Render (and optionally transcribe) one piece of the owner's handwriting. */
async function pictureOf(
	request: StrokeRenderRequest,
	quote: string | undefined,
	deps: PullDeps,
	scan: DocumentScan,
): Promise<{ id: string; path?: string; transcript?: string } | null> {
	const path = deps.renderStrokes ? await deps.renderStrokes(request) : null;
	let transcript: string | undefined;
	if (deps.transcribe !== undefined) {
		try {
			const read = await deps.transcribe({ ...request, quote });
			if (read !== null && read.text.trim() !== "") {
				transcript = read.text.trim();
				if (scan.ink) {
					scan.ink.transcribed++;
					// Who read it, and how sure: averaged per reader at render time,
					// so a tuner can tell builtin-junk from WritePad-junk.
					if (read.by !== undefined) {
						const readers = (scan.ink.readers ??= {});
						const agg = (readers[read.by] ??= { count: 0, scoreSum: 0 });
						agg.count++;
						agg.scoreSum += read.score ?? 0;
					}
				}
			}
		} catch (error) {
			deps.log?.(`    transcription failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (path === null && transcript === undefined) return null;
	const keepImage = deps.keepImageWithTranscript !== false || transcript === undefined;
	return { id: remarkId(request.strokes), path: keepImage && path !== null ? path : undefined, transcript };
}

/**
 * Collect everything a handwritten notebook came back with. Same contract
 * as collectHighlights: highlights, marks in document order, and a scan.
 */
export async function collectInkAnnotations(
	entry: MappingEntry,
	hash: string,
	deps: PullDeps,
): Promise<{ highlights: Highlight[]; scan: DocumentScan; marks: ImportedMark[] }> {
	const allFiles = await deps.listDocumentFiles(entry.deviceDocId, hash);
	const strokeFiles = allFiles.filter((file) => file.id.endsWith(".rm"));
	deps.log?.(`  files: ${allFiles.map((file) => file.id).join(", ")}`);
	const scan = emptyScan(allFiles, strokeFiles);

	if (deps.checkSource) {
		scan.sourceState = await deps.checkSource(entry).catch(() => undefined);
		if (scan.sourceState !== undefined && scan.sourceState !== "match") {
			deps.log?.(`  source note: ${scan.sourceState}`);
		}
	}

	let render: InkRender | null = null;
	try {
		render = deps.loadInk ? await deps.loadInk(entry) : null;
	} catch (error) {
		deps.log?.(`  could not regenerate the handwriting: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (render === null) {
		// Without the regenerated strokes the plugin cannot tell its own
		// letters from the owner's, and reading every letter as a remark
		// would bury the real ones. Say so instead of guessing (N3).
		scan.anchorSkipped = "no-layout";
		deps.log?.("  handwriting could not be regenerated — nothing was read from this notebook");
		return { highlights: [], scan, marks: [] };
	}
	const layout = render.layout;
	const pageIds = entry.ink?.pageIds ?? [];
	const pageOf = new Map(pageIds.map((id, index) => [id, index + 1]));

	// The device's own page order, for numbering pages the owner added.
	let deviceOrder: string[] = [];
	const contentFile = allFiles.find((file) => file.id === `${entry.deviceDocId}.content`);
	if (contentFile !== undefined) {
		try {
			deviceOrder = parsePageOrder(await deps.readFile(contentFile));
		} catch {
			deviceOrder = [];
		}
	}

	const collected: { page: number | undefined; order: number; mark: ImportedMark }[] = [];
	const highlights: Highlight[] = [];

	// Pages in our order first, added pages after the page they follow (by
	// the device's own order when .content has one, else at the end).
	for (const [index, file] of strokeFiles.entries()) {
		const pageId = pageIdOfFile(file.id);
		const page = pageId === null ? undefined : pageOf.get(pageId);
		try {
			if (!deps.readBytes) break;
			const bytes = await deps.readBytes(file);
			const scene = parseRmScene(bytes);
			if (page === undefined) {
				// A page the owner added to write on: no text of ours to diff,
				// so it comes back whole (GP_E3_S20 semantics).
				const strokes = scene.lines.map((line) => line.stroke);
				if (strokes.length === 0) continue;
				const position = deviceOrder.indexOf(pageId ?? "") + 1 || index + 1;
				const picture = await pictureOf(
					{ deviceDocId: entry.deviceDocId, strokes, page: position, remark: 1, wholePage: true },
					undefined,
					deps,
					scan,
				);
				if (picture === null) continue;
				collected.push({
					page: pageIds.length,
					order: 1000 + index,
					mark: { kind: "note", addedPage: position, ...picture },
				});
				scan.addedPages++;
				scan.renderedPages++;
				scan.renderedRemarks++;
				deps.log?.(`  ${file.id}: a page added on the device, ${strokes.length} stroke(s)`);
				continue;
			}

			const expected: GeneratedStroke[] = render.pages[page - 1] ?? [];
			const diff = diffInkPage(expected, scene);
			deps.log?.(`  ${file.id}: page ${page} — ${describeDiff(diff)}`);
			if (!diff.trustworthy) {
				// The page holds strokes under our ids that are not the strokes
				// we regenerated: the send cannot be reproduced exactly (a
				// renamed note, a changed font). Reading it anyway would turn our
				// own letters into remarks and invent erased words.
				scan.unreadableFiles++;
				deps.log?.(
					`    skipped: the regenerated handwriting does not match this page (${diff.stats.idConflicts} id conflicts)`,
				);
				continue;
			}
			if (scan.ink) {
				scan.ink.erasedWords += diff.erasedWords.length;
				scan.ink.movedWords += diff.movedWords.length;
				scan.ink.partialWords += diff.partialWords.length;
				scan.ink.ownStrokes += diff.userStrokes.length;
			}
			for (const partial of diff.partialWords) {
				deps.log?.(`    partly erased (${Math.round(partial.erased * 100)}%): “${wordText(layout, [partial.wordId])}”`);
			}

			// Erased words: one mark per consecutive run.
			for (const run of runsOf(diff.erasedWords)) {
				collected.push({
					page,
					order: run[0],
					mark: { kind: "erased", page, words: run, target: wordText(layout, run) },
				});
				scan.interpretedMarks++;
			}

			// Moved words: one mark per lasso move.
			for (const group of movedGroups(diff)) {
				const runIds = [...group.ids].sort((a, b) => a - b);
				const landing = group.anchored ? undefined : landingOf(layout, page, runIds, group.dx, group.dy);
				collected.push({
					page,
					order: runIds[0],
					mark: {
						kind: "moved",
						page,
						words: runIds,
						target: wordText(layout, runIds),
						moveAfter: landing?.after,
						moveBefore: landing?.before,
						quote: landing?.quote,
					},
				});
				scan.interpretedMarks++;
				deps.log?.(
					`    moved “${wordText(layout, runIds)}” by ${group.dx.toFixed(0)},${group.dy.toFixed(0)}` +
						(landing === undefined
							? " — landing spot unclear, reported only"
							: landing.after !== undefined
								? ` → after “${wordText(layout, [landing.after])}”`
								: ` → before “${wordText(layout, [landing.before!])}”`),
				);
			}

			// The owner's ink: highlighter strokes become highlights, the rest
			// goes through the upstream mark reader unchanged.
			const penLines = diff.userLines.filter((line) => !HIGHLIGHTER_TOOLS.has(line.stroke.tool));
			// Highlighter over no printed words may be over the owner's own
			// handwriting: kept for the remark it covers.
			const overInk: SceneLine[] = [];
			for (const line of diff.userLines.filter((line) => HIGHLIGHTER_TOOLS.has(line.stroke.tool))) {
				const highlight = highlightOf(line, layout, page);
				if (highlight !== null) {
					highlights.push(highlight);
					scan.highlightsInStrokes++;
				} else {
					overInk.push(line);
				}
			}
			const marks = readMarks(
				penLines.map((line) => line.stroke),
				page,
				layout,
			);
			let onThisPage = 0;
			for (const [position, mark] of marks.entries()) {
				let picture: { id: string; path?: string; transcript?: string } | null = null;
				if (!TEXT_ONLY_KINDS.has(mark.kind)) {
					if (deps.renderStrokes === undefined && deps.transcribe === undefined) continue;
					const column = mark.kind === "note" ? tableColumnUnder(layout, page, mark.strokes) : undefined;
					const inkHighlights = mark.kind === "note" ? highlightsOver(overInk, mark.strokes) : [];
					picture = await pictureOf(
						{
							deviceDocId: entry.deviceDocId,
							strokes: mark.strokes,
							page,
							remark: position + 1,
							...(column === undefined ? {} : { column }),
							...(inkHighlights.length === 0 ? {} : { inkHighlights }),
							...(mark.at === undefined ? {} : { at: mark.at }),
						},
						mark.quote,
						deps,
						scan,
					);
					if (picture === null) continue;
				} else {
					scan.interpretedMarks++;
				}
				if (mark.target !== undefined || mark.quote !== undefined) scan.anchoredRemarks++;
				collected.push({
					page,
					order: (mark.words?.[0] ?? 0) + position / 1000,
					mark: {
						kind: mark.kind,
						page,
						target: mark.target,
						words: mark.words,
						blocks: mark.blocks,
						quote: mark.quote,
						...(picture ?? {}),
					},
				});
				onThisPage++;
			}
			if (onThisPage > 0 || diff.erasedWords.length > 0 || diff.movedWords.length > 0) {
				scan.renderedPages++;
				scan.renderedRemarks += onThisPage;
			}
		} catch (error) {
			scan.unreadableFiles++;
			deps.log?.(`  could not read ${file.id}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	collected.sort((a, b) => (a.page ?? Infinity) - (b.page ?? Infinity) || a.order - b.order);
	highlights.sort((a, b) => (a.page ?? Infinity) - (b.page ?? Infinity));
	scan.parsedHighlights = highlights.length;
	deps.log?.(
		`  ink: ${scan.ink?.erasedWords ?? 0} erased, ${scan.ink?.movedWords ?? 0} moved word(s); ` +
			`${scan.renderedRemarks} remark(s), ${scan.highlightsInStrokes} highlight(s), ${scan.ink?.transcribed ?? 0} transcribed`,
	);
	return { highlights, scan, marks: collected.map((item) => item.mark) };
}
