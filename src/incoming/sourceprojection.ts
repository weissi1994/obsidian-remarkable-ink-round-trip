/**
 * Projecting marks onto the source note (GP_E3_S13).
 *
 * The first annotated copy was *rebuilt* from the layout map, and inherited
 * everything the typesetter had thrown away: bold, italics, links, en dashes,
 * heading levels. Owner comparison 2026-07-27 showed exactly that.
 *
 * So do the opposite. Keep the note as it is and only *insert* markup at the
 * places the pen touched. The layout knows which words were marked and in
 * what order; those same words appear in the same order in the note, just
 * with markdown around them. Aligning the two gives a character range per
 * word — and inserting into the note keeps every last bit of its formatting.
 */

import { PdfLayout, toWinAnsi } from "../convert/pdf";
import type { PendingChange } from "./annotationnote";
import { Bounds, deviceBoundsToPdf, strokeBounds } from "./anchor";
import { Highlight, colorName, rgbName } from "./highlights";
import type { EmptyTask } from "./marks";
import { DEFAULT_MARK_STYLES, MarkStyle, MarkStyles } from "./markstyles";
import type { ImportedMark } from "./pull";
import { CONFIRM_MARK, remarkIdLine, typedIdLine } from "./remarkid";

/** Markdown punctuation that carries no text and may sit between words. */
const SYNTAX = new Set([
	"*",
	"_",
	"=",
	"~",
	"`",
	"#",
	">",
	"|",
	"[",
	"]",
	"(",
	")",
	"!",
	"\\",
	" ",
	"\t",
	"\n",
	"\r",
]);

/** Highlight colours as inline styling; `==` cannot carry a colour. */
const HIGHLIGHT_CSS: Record<string, string> = {
	yellow: "#ffe066",
	blue: "#a5d8ff",
	pink: "#ffc9de",
	orange: "#ffc078",
	green: "#b2f2bb",
	grey: "#dee2e6",
};

/**
 * The markup for one mark.
 *
 * Markdown by default — the copy should stay readable and editable as
 * markdown. But **markdown inside an inline HTML tag is not parsed**: an
 * underline is `<u>…</u>` because markdown has no underline at all, and a
 * `~~strike~~` within it comes out as literal tildes (beta, 2026-07-28, twice
 * in a row: first blamed on the quotes around the phrase, then measured
 * properly). So a mark that ends up inside an HTML wrapper switches to its
 * own HTML tag, which nests and renders in every Obsidian view.
 */
function wrapperFor(
	kind: string,
	color?: number,
	rgb?: string,
	insideHtml = false,
	styles: MarkStyles = DEFAULT_MARK_STYLES,
): [string, string] {
	// A text highlight is not a shape the user chose, and it carries a colour
	// of its own, so it is the one mark with no style setting.
	if (kind === "highlight") {
		// The device sends its own RGB, so use it verbatim rather than
		// rounding to a palette name (GP_E3_S16).
		const css = rgb ?? HIGHLIGHT_CSS[colorName(color) ?? ""];
		if (css !== undefined) return [`<mark style="background: ${css}">`, "</mark>"];
		return insideHtml ? ["<mark>", "</mark>"] : ["==", "=="];
	}
	const style = styles[kind as keyof MarkStyles];
	return style === undefined ? ["", ""] : wrapperForStyle(style, insideHtml);
}

/** The markup for one style, in markdown or in HTML when it has to nest. */
function wrapperForStyle(style: MarkStyle, insideHtml: boolean): [string, string] {
	switch (style) {
		case "strikethrough":
			return insideHtml ? ["<s>", "</s>"] : ["~~", "~~"];
		case "bold":
			return insideHtml ? ["<strong>", "</strong>"] : ["**", "**"];
		case "italic":
			return insideHtml ? ["<em>", "</em>"] : ["*", "*"];
		case "underline":
			return ["<u>", "</u>"];
		case "highlight":
			return insideHtml ? ["<mark>", "</mark>"] : ["==", "=="];
		default:
			return ["", ""];
	}
}

/** Nesting order, outermost first, so overlapping marks stay well-formed. */
const KIND_ORDER = ["highlight", "circle", "underline", "strikethrough"];

interface Range {
	start: number;
	end: number;
}

/** A letter or digit: what a word is made of, for its boundaries. */
const WORDISH = /[\p{L}\p{N}]/u;

/** Whether `at` falls inside a word of the source, between two of its letters. */
const insideWord = (source: string, at: number) =>
	at > 0 && at < source.length && WORDISH.test(source[at - 1]) && WORDISH.test(source[at]);

/**
 * Where one word ends when read from `from`, allowing markdown syntax to sit
 * anywhere inside or before it — `**Grote** financiële` still contains the
 * word "Grote". Null when this position is not it.
 */
function consume(source: string, from: number, word: string, typo: number): number | null {
	let at = from;
	let taken = 0;
	while (taken < word.length) {
		if (at >= source.length) return null;
		const ch = source[at];
		// Map exactly as the layout was typeset: a legacy layout carries
		// "--" where the source has an em dash (GP_E5_S7).
		const mapped = toWinAnsi(ch, typo);
		if (mapped !== "" && word.startsWith(mapped, taken)) {
			taken += mapped.length;
			at++;
			continue;
		}
		// Syntax may be skipped; anything else means this is a different word.
		if (SYNTAX.has(ch)) {
			at++;
			continue;
		}
		return null;
	}
	return at;
}

/**
 * Match one word against the source at `from`; the end offset, or null. A
 * match ending inside a longer word is not it — "the" is not in "theory" —
 * unless the typesetter broke that word at the end of its line (a long URL,
 * a compound in a narrow column): then `then`, the next laid-out word, is
 * its rest and carries on right there. A `cut` word ends a code line the
 * typesetter truncated at the page edge (pdf.ts): it is the start of its
 * source word, which runs on to the next space (the rest of the line is not
 * on the page at all: the caller moves on past it).
 */
function matchAt(source: string, from: number, word: string, typo: number, then?: string, cut = false): number | null {
	const end = consume(source, from, word, typo);
	if (end === null || !insideWord(source, end)) return end;
	if (cut) {
		let at = end;
		while (at < source.length && !/\s/.test(source[at])) at++;
		return at;
	}
	return then !== undefined && consume(source, end, then, typo) !== null ? end : null;
}

/**
 * How far past the cursor a word may be found. Consecutive words sit a few
 * characters apart; the slack is for skipped markup — a link URL, an embed.
 *
 * A *tight* bound is the whole point. Searching the rest of the document
 * (beta, 2026-07-27) let a word that is not in the note at all — the title
 * line the plugin adds — match somewhere far below and drag the cursor with
 * it, after which nothing lined up and the projection gave up entirely.
 */
const WINDOW = 200;

/**
 * Where a word sits in the source, searching forward from `from`, starting
 * at a word boundary. Text in `skip` is not on the page (remarks drawn back
 * in place): it is stepped over without counting against the window.
 */
function findWord(
	source: string,
	from: number,
	word: string,
	typo: number,
	window = WINDOW,
	skip: Range[] = [],
	then?: string,
	cut = false,
): Range | null {
	let limit = Math.min(source.length, from + window);
	for (let at = from; at < limit; at++) {
		const hidden = skip.find((range) => at >= range.start && at < range.end);
		if (hidden !== undefined) {
			limit = Math.min(source.length, limit + (hidden.end - at));
			at = hidden.end - 1;
			continue;
		}
		// Syntax is stepped over — unless the word itself starts with it (`#tag`, `(see`).
		if (SYNTAX.has(source[at]) && source[at] !== word[0]) continue;
		if (insideWord(source, at)) continue;
		const end = matchAt(source, at, word, typo, then, cut);
		if (end !== null) return { start: at, end };
	}
	return null;
}

/**
 * The callouts of remarks drawn back where they were written (named by their
 * image): in the note, but not on the page.
 */
export function hiddenRemarks(source: string, names: string[] | undefined): Range[] {
	if (names === undefined || names.length === 0) return [];
	const wanted = new Set(names);
	const lines = source.split("\n");
	const out: Range[] = [];
	let offset = 0;
	const starts = lines.map((line) => {
		const at = offset;
		offset += line.length + 1;
		return at;
	});
	for (let i = 0; i < lines.length; i++) {
		if (!/^>\s*\[!/.test(lines[i])) continue;
		let end = i;
		while (end + 1 < lines.length && lines[end + 1].startsWith(">") && !/^>\s*\[!/.test(lines[end + 1])) end++;
		const shown = lines
			.slice(i, end + 1)
			.flatMap((line) => [...line.matchAll(/!\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g)])
			.some((embed) => wanted.has(embed[2]?.trim() || (embed[1].trim().split("/").pop() ?? "")));
		if (shown) out.push({ start: starts[i], end: starts[end] + lines[end].length });
		i = end;
	}
	return out;
}

/**
 * The targets of markdown links outside code, `](…)`: the page shows a
 * link's text only (mdblocks.ts), so a run of links reads as words a whole
 * URL apart in the note but side by side on the page.
 */
function hiddenLinkTargets(source: string): Range[] {
	const out: Range[] = [];
	let offset = 0;
	let fence: string | null = null;
	for (const line of source.split("\n")) {
		const marker = /^\s*(?:>\s*)*(`{3,}|~{3,})/.exec(line)?.[1];
		if (marker !== undefined && fence === null) fence = marker;
		else if (marker !== undefined && fence !== null && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
		else if (fence === null) {
			for (const link of line.matchAll(/\[[^\]]+\](\([^)]*\))/g)) {
				const at = link.index + link[0].length - link[1].length - 1;
				// Inside inline code it is shown as typed.
				if ((line.slice(0, link.index).split("`").length - 1) % 2 === 0) out.push({ start: offset + at, end: offset + link.index + link[0].length });
			}
		}
		offset += line.length + 1;
	}
	return out;
}

/**
 * Where layout word `index` sits, from `from` on. `glued`: the word before
 * it ended inside a source word — broken at a line's end — so this one is
 * its rest, right at `from`.
 */
type Locate = (from: number, index: number, glued: boolean, window: number) => Range | null;

/**
 * Where the note's own text begins in the layout. The typeset document opens
 * with a title, and optionally with the frontmatter as a title block; neither
 * is part of the note body. Rather than special-casing them, look among the
 * words from `first` on for runs of three consecutive matches near the top
 * of the note, and take the one that starts earliest in the note — that is
 * where the two texts genuinely meet. A frontmatter value the note repeats
 * further down matches too, just later.
 */
function syncPoint(source: string, count: number, locate: Locate, first = 0): number {
	const head = Math.min(count, first + 60);
	let best: { index: number; at: number } | undefined;
	for (let index = first; index < head; index++) {
		let cursor = 0;
		let glued = false;
		let run = 0;
		let at = 0;
		for (let step = 0; step < 3 && index + step < count; step++) {
			const hit = locate(cursor, index + step, glued, cursor === 0 ? 400 : 40);
			if (hit === null) break;
			if (step === 0) at = hit.start;
			cursor = hit.end;
			glued = insideWord(source, hit.end);
			run++;
		}
		if (run === 3 && (best === undefined || at < best.at)) best = { index, at };
	}
	return best?.index ?? first;
}

export interface ProjectionInput {
	/** The note as it is on disk, frontmatter already removed. */
	source: string;
	layout: PdfLayout;
	highlights: Highlight[];
	marks: ImportedMark[];
	/** How each mark becomes markdown; defaults when not given. */
	styles?: MarkStyles;
	/**
	 * Ink fork: what an erased handwritten word becomes in the copy —
	 * removed (default) or kept as struck-through text.
	 */
	erasedAs?: "delete" | "strikethrough";
	/**
	 * Append the highlights that found no place in the text (the default).
	 * The two-way merge lists them with the other changes it could not apply.
	 */
	listUnplaced?: boolean;
}

export interface ProjectionResult {
	markdown: string;
	/** Marks and highlights that found their place in the text. */
	placed: number;
	/** Highlights whose text could not be located. */
	unplaced: Highlight[];
	/** Marks the text does not show, and why — highlights aside. */
	unapplied: PendingChange[];
}

/** A jump this far past the cursor needs the words after it to follow. */
const JUMP = 60;
/**
 * How far a missed word is looked for again — past a long link URL, say —
 * when the words after it confirm the place.
 */
const FAR = 2000;

/**
 * The note with every mark inserted. Returns null when the text and the
 * layout have nothing in common — then there is nothing to project onto.
 */
export function projectOntoSource(input: ProjectionInput): ProjectionResult | null {
	const words = input.layout.lines.flatMap((line) =>
		line.words.map((word) => ({ ...word, page: line.page, block: line.block, y: line.y })),
	);
	if (words.length === 0 || input.source.trim() === "") return null;

	// Walk both sides forward together. A word that cannot be found (a title
	// the note does not carry, an inlined embed) costs its own mark. A hit
	// after a miss, or far past the cursor, only counts when the next words
	// follow right behind it — a short common word must not drag the cursor
	// to its next occurrence. A word not found nearby is looked for further
	// on, where a longer run of the words after it has to confirm it: text
	// the layout skipped (a long link, an embed's target) must not lose the
	// rest of the note.
	const ranges = new Map<number, Range>();
	// Absent means version 1, the same convention as the mapping entry the
	// layout is rebuilt from (id/mapping.ts) — a legacy layout carries "--"
	// where the source has an em dash, and mapping modern against it fails
	// at the first typographic character.
	const typo = input.layout.typo ?? 1;
	const skip = [...hiddenRemarks(input.source, input.layout.remarksInPlace), ...hiddenLinkTargets(input.source)];
	const source = input.source;
	// The last word of a laid-out line may be the first part of a word the
	// typesetter broke; its next part starts the next line of the block.
	const lineEnds = new Set(input.layout.lines.flatMap((line) => line.words.slice(-1).map((word) => word.id)));
	const carried = (index: number) => {
		const next = words[index + 1];
		return next !== undefined && lineEnds.has(words[index].id) && next.block === words[index].block ? next.text : undefined;
	};
	// Code lines are truncated at the page edge, not broken: what follows
	// a line's last word on its source line is not on the page.
	const cutEnds = new Set(input.layout.lines.filter((line) => line.role === "code").flatMap((line) => line.words.slice(-1).map((word) => word.id)));
	const past = (index: number, end: number) => {
		if (!cutEnds.has(words[index].id)) return end;
		const newline = source.indexOf("\n", end);
		return newline === -1 ? source.length : newline;
	};
	const locate: Locate = (from, index, glued, window) => {
		const cut = cutEnds.has(words[index].id);
		const end = glued ? matchAt(source, from, words[index].text, typo, carried(index), cut) : null;
		return end !== null ? { start: from, end } : findWord(source, from, words[index].text, typo, window, skip, carried(index), cut);
	};
	// The title is not the note's text; it only stands for the note's first
	// heading when the page dropped that as the same text (pdf.ts) — not when
	// the page shows that heading as well, behind a frontmatter block.
	const titles = input.layout.lines.filter((line) => line.role === "title");
	const titleText = titles.map((line) => line.text.trim()).join(" ");
	const titleIds = new Set(titles.flatMap((line) => line.words.map((word) => word.id)));
	const opensWithHeading = /^#\s/.test(source.split("\n").find((line) => line.trim() !== "") ?? "");
	let first = 0;
	if (!opensWithHeading || input.layout.lines.some((line) => line.role === "heading" && line.text.trim() === titleText)) {
		while (first < words.length && titleIds.has(words[first].id)) first++;
	}
	const start = syncPoint(source, words.length, locate, first);
	const followed = (from: number, index: number, count: number) => {
		if (index + count >= words.length) return false;
		let at = from;
		for (let next = index + 1; next <= index + count; next++) {
			const hit = locate(at, next, insideWord(source, at), 40);
			if (hit === null) return false;
			at = past(next, hit.end);
		}
		return true;
	};
	let cursor = 0;
	let found = 0;
	let missed = 0;
	for (let index = start; index < words.length; index++) {
		const glued = insideWord(source, cursor) && ranges.has(words[index - 1]?.id);
		let hit = locate(cursor, index, glued, WINDOW);
		// Near the end of the layout there is nothing left to confirm with.
		const lastWords = index + 2 >= words.length;
		if (hit !== null && (missed > 0 || hit.start - cursor > JUMP) && !lastWords && !followed(past(index, hit.end), index, 2)) hit = null;
		for (let from = cursor; hit === null && !lastWords; ) {
			const far = findWord(source, from, words[index].text, typo, FAR - (from - cursor), skip, carried(index), cutEnds.has(words[index].id));
			if (far === null) break;
			if (followed(past(index, far.end), index, Math.min(4, words.length - 1 - index))) hit = far;
			from = far.start + 1;
		}
		if (hit === null) {
			missed++;
			continue;
		}
		ranges.set(words[index].id, hit);
		cursor = past(index, hit.end);
		found++;
		missed = 0;
	}
	if (found < (words.length - start) / 4) return null; // not the same document

	const spans: { kind: string; color?: number; rgb?: string; start: number; end: number }[] =
		[];
	let placed = 0;
	const unapplied: PendingChange[] = [];
	const wordText = new Map(words.map((word) => [word.id, word.text]));
	const named = (mark: ImportedMark, ids: number[] = mark.words ?? []) =>
		mark.target ?? ids.map((id) => wordText.get(id) ?? "").join(" ");

	// Task gestures (GP_E5_S12): a tick in a drawn checkbox marks the task
	// line done; a strike-through covering most of a task line cancels it
	// instead of striking its words. Both rewrite the marker, so they leave
	// the span machinery entirely. Strike coverage is aggregated per source
	// line first: a wrapped task is struck in one gesture per visual row,
	// and each gesture alone would stay under any threshold (reviewvondst).
	const lineOf = lineIndexer(input.source);
	const sourceLines = input.source.split("\n");
	const done = new Set<number>();
	const cancelled = new Set<number>();
	const struckPerLine = new Map<number, Set<number>>();

	for (const mark of input.marks) {
		if (mark.kind !== "strikethrough") continue;
		for (const id of mark.words ?? []) {
			const range = ranges.get(id);
			if (range === undefined) continue;
			const line = lineOf(range.start);
			if (!TASK_LINE_RE.test(sourceLines[line])) continue;
			const set = struckPerLine.get(line) ?? new Set<number>();
			set.add(id);
			struckPerLine.set(line, set);
		}
	}
	for (const [line, struck] of struckPerLine) {
		// Words proper: a bullet or bracket typeset as text is not half a task.
		const onLine = words.filter((word) => {
			const range = ranges.get(word.id);
			return range !== undefined && lineOf(range.start) === line && WORDISH.test(word.text);
		}).length;
		// Strictly more than half: striking one word of a two-word task is a
		// word-level strike, not a cancellation.
		if (onLine > 0 && struck.size > onLine / 2) cancelled.add(line);
	}

	// Ink fork: words erased or moved on the tablet. They are edits to the
	// text rather than markup around it. Removals are collected per WORD and
	// merged into runs afterwards (removalEdits): a word range never spans a
	// line, so no removal can eat a newline and every line index the passes
	// below rely on still holds.
	const erasedAs = input.erasedAs ?? "delete";
	const erased = new Set<number>();
	const removed: Range[] = [];
	const edits: TextEdit[] = [];
	for (const mark of input.marks) {
		if (mark.kind !== "erased") continue;
		const covered = (mark.words ?? []).map((id) => ranges.get(id)).filter(isRange);
		const lost = (mark.words ?? []).filter((id) => !ranges.has(id));
		if (lost.length > 0) {
			const target = covered.length === 0 ? named(mark) : lost.map((id) => wordText.get(id) ?? "").join(" ");
			unapplied.push({ page: mark.page, text: `“${target}” erased — not found in the note` });
		}
		if (covered.length === 0) continue;
		for (const id of mark.words ?? []) erased.add(id);
		if (erasedAs === "strikethrough") {
			// One span per source line, so a strike never wraps a line break.
			for (const group of groupByLine(covered, lineOf)) spans.push({ kind: "strikethrough", ...group });
		} else {
			removed.push(...covered);
		}
		placed++;
	}
	if (erasedAs === "strikethrough") erased.clear(); // struck words keep their marks
	for (const mark of input.marks) {
		if (mark.kind !== "moved") continue;
		const ids = [...(mark.words ?? [])].sort((a, b) => a - b);
		if (ids.length === 0) continue;
		const notMoved = (why: string) => unapplied.push({ page: mark.page, text: `“${named(mark, ids)}” moved — ${why}` });
		const anchorId = mark.moveAfter ?? mark.moveBefore;
		if (anchorId === undefined) {
			notMoved("not next to any word, so its new place in the text is unclear");
			continue;
		}
		const anchor = ranges.get(anchorId);
		if (anchor === undefined || ids.some((id) => !ranges.has(id))) {
			notMoved("not found in the note");
			continue;
		}
		if (erased.has(anchorId) || ids.some((id) => erased.has(id))) {
			notMoved("it was erased, or put next to a word that was");
			continue;
		}
		// Only a contiguous run of words moves: a lasso across a gap would
		// otherwise drag the words in between along.
		if (ids.some((id, i) => i > 0 && id !== ids[i - 1] + 1)) {
			notMoved("its words were not next to each other");
			continue;
		}
		const start = ranges.get(ids[0])!.start;
		const end = ranges.get(ids[ids.length - 1])!.end;
		if (anchor.start >= start && anchor.end <= end) continue; // into itself
		const text = input.source.slice(start, end);
		// A phrase spanning lines, or cutting through inline markup, is listed
		// but not applied: moving half a **bold** span would re-bold the wrong
		// words.
		if (text.includes("\n") || !balancedInline(text)) {
			notMoved("it runs across a line break or through formatting");
			continue;
		}
		for (const id of ids) removed.push(ranges.get(id)!);
		edits.push(
			mark.moveAfter !== undefined
				? { at: afterMarkup(input.source, anchor.end), remove: 0, text: ` ${text}`, rank: 100 }
				: { at: beforeMarkup(input.source, anchor.start), remove: 0, text: `${text} `, rank: -100 },
		);
		for (const id of ids) erased.add(id); // its old place keeps no markup
		placed++;
	}
	edits.push(...removalEdits(input.source, removed));

	const styles = input.styles ?? DEFAULT_MARK_STYLES;
	for (const mark of input.marks) {
		if (mark.kind === "erased" || mark.kind === "moved") continue;
		const covered = (mark.words ?? [])
			.filter((id) => !erased.has(id))
			.map((id) => ranges.get(id))
			.filter(isRange);
		if ((mark.kind === "checkbox" || mark.kind === "checkbox-cancel") && covered.length === 0 && mark.task !== undefined) {
			const line = emptyTaskLine(mark.task, ranges, lineOf, sourceLines);
			if (line === null) {
				unapplied.push({ page: mark.page, text: `a task with no text ${DONE[mark.kind]} — not found in the note` });
			} else {
				(mark.kind === "checkbox" ? done : cancelled).add(line);
				placed++;
			}
			continue;
		}
		if (covered.length === 0) {
			// Words that are gone need no mark; words never found do.
			const lost = (mark.words ?? []).some((id) => !ranges.has(id));
			if (lost && styles[mark.kind as keyof MarkStyles] !== "none") {
				unapplied.push({ page: mark.page, text: `“${named(mark)}” ${DONE[mark.kind] ?? mark.kind} — not found in the note` });
			}
			continue;
		}
		const line = lineOf(Math.min(...covered.map((range) => range.start)));
		if (mark.kind === "checkbox" || mark.kind === "checkbox-cancel") {
			if (TASK_LINE_RE.test(sourceLines[line])) {
				(mark.kind === "checkbox" ? done : cancelled).add(line);
				placed++;
			} else {
				unapplied.push({ page: mark.page, text: `“${named(mark)}” ${DONE[mark.kind]} — that line is not a task in the note` });
			}
			continue;
		}
		if (mark.kind === "strikethrough" && cancelled.has(line)) {
			placed++; // absorbed by the line's cancellation
			continue;
		}
		spans.push({
			kind: mark.kind,
			start: Math.min(...covered.map((range) => range.start)),
			end: Math.max(...covered.map((range) => range.end)),
		});
		placed++;
	}

	const unplaced: Highlight[] = [];
	for (const highlight of input.highlights) {
		const ids = wordIdsOf(words, highlight);
		// A highlight on erased or moved words must not put markup into text
		// that is about to be removed (ink fork).
		const covered = ids
			.filter((id) => !erased.has(id))
			.map((id) => ranges.get(id))
			.filter(isRange);
		if (covered.length === 0) {
			unplaced.push(highlight);
			continue;
		}
		spans.push({
			kind: "highlight",
			color: highlight.color,
			rgb: highlight.rgb,
			start: Math.min(...covered.map((range) => range.start)),
			end: Math.max(...covered.map((range) => range.end)),
		});
		placed++;
	}

	let markdown = applySpans(input.source, spans, input.styles, edits);
	// Before applyBlockMarks: that step inserts lines, and the task-state
	// rewrite addresses lines by their untouched-source index (applySpans
	// only inserts inline, so those indices still hold here).
	markdown = applyTaskStates(markdown, done, cancelled);
	markdown = applyBlockMarks(markdown, input, words, ranges, unapplied);

	if (unplaced.length > 0 && input.listUnplaced !== false) {
		markdown += "\n\n**Highlights that could not be placed in the text**\n\n";
		for (const highlight of unplaced) {
			const color = rgbName(highlight.rgb) ?? colorName(highlight.color);
			markdown += `- ==${highlight.text}==${color === undefined ? "" : ` ^[${color}]`}\n`;
		}
	}
	// Trailing line breaks go; spaces ending the last line are the note's own.
	return { markdown: markdown.replace(/(\n[ \t]*)+$/, ""), placed, unplaced, unapplied };
}

/** What a mark did to its words, for the list of what could not be applied. */
const DONE: Record<string, string> = {
	strikethrough: "struck through",
	underline: "underlined",
	circle: "circled",
	checkbox: "ticked",
	"checkbox-cancel": "struck off",
};

/**
 * A markdown task line: bullet, then a checkbox marker — also inside a quote
 * or callout (`> - [ ] task`, `> > - [ ] task`).
 */
const TASK_LINE_RE = /^((?:\s*>\s?)*\s*[-*+]\s+)\[( |x|X)\]/;
const EMPTY_TASK_RE = /^((?:\s*>\s?)*\s*[-*+]\s+)\[( |x|X)\]\s*$/;

/**
 * The source line of a task item with no text (marks.ts EmptyTask): the
 * `nth` empty task line after the line of the word before it — the nearest
 * earlier word the note still has — and before the word after it. Null
 * when the note has no such line there.
 */
function emptyTaskLine(task: EmptyTask, ranges: Map<number, Range>, lineOf: (offset: number) => number, sourceLines: string[]): number | null {
	let before = task.after;
	while (before >= 0 && !ranges.has(before)) before--;
	const from = before < 0 ? 0 : lineOf(ranges.get(before)!.start) + 1;
	const next = ranges.get(task.after + 1);
	const to = next === undefined ? sourceLines.length : lineOf(next.start);
	let nth = task.nth;
	for (let line = from; line < to; line++) {
		if (EMPTY_TASK_RE.test(sourceLines[line]) && nth-- === 0) return line;
	}
	return null;
}

/**
 * Rewrite task markers in the annotated copy (GP_E5_S12): `[ ]` becomes
 * `[x]` for a ticked box, `[-]` for a struck (cancelled) task — cancelled
 * wins when one line somehow carries both. Same-length replacements, so no
 * offset in the document shifts.
 */
function applyTaskStates(markdown: string, done: Set<number>, cancelled: Set<number>): string {
	if (done.size === 0 && cancelled.size === 0) return markdown;
	const lines = markdown.split("\n");
	const apply = (index: number, state: string) => {
		if (index >= lines.length) return;
		lines[index] = lines[index].replace(TASK_LINE_RE, `$1[${state}]`);
	};
	for (const index of done) if (!cancelled.has(index)) apply(index, "x");
	for (const index of cancelled) apply(index, "-");
	return lines.join("\n");
}

function isRange(range: Range | undefined): range is Range {
	return range !== undefined;
}

/**
 * The layout words a highlight covers: the words the highlighter went over
 * when it says so, else the first run of its text on its own page.
 */
function wordIdsOf(
	words: { id: number; text: string; page: number }[],
	highlight: Highlight,
): number[] {
	if (highlight.words !== undefined && highlight.words.length > 0) return highlight.words;
	const wanted = highlight.text.trim().split(/\s+/);
	if (wanted.length === 0) return [];
	for (let at = 0; at + wanted.length <= words.length; at++) {
		if (highlight.page !== undefined && words[at].page !== highlight.page) continue;
		const run = words.slice(at, at + wanted.length);
		if (run.every((word, index) => word.text === wanted[index])) return run.map((w) => w.id);
	}
	return [];
}

/**
 * Insert the markup. Ranges of one kind that overlap or touch are merged
 * first: two strike-throughs over the same phrase must not produce `~~~~`,
 * which markdown reads as nothing at all (beta, 2026-07-27).
 */
function applySpans(
	source: string,
	spans: { kind: string; color?: number; rgb?: string; start: number; end: number }[],
	styles: MarkStyles = DEFAULT_MARK_STYLES,
	textEdits: TextEdit[] = [],
): string {
	const merged: typeof spans = [];
	for (const kind of KIND_ORDER) {
		const ofKind = spans.filter((span) => span.kind === kind).sort((a, b) => a.start - b.start);
		for (const span of ofKind) {
			const last = merged[merged.length - 1];
			if (last !== undefined && last.kind === kind && span.start <= last.end) {
				last.end = Math.max(last.end, span.end);
				continue;
			}
			merged.push({ ...span });
		}
	}

	const edits: TextEdit[] = [...textEdits];
	// Spans arrive outermost-kind first, so a wrapper's own choice is settled
	// before the marks nested inside it have to make theirs.
	const html: Range[] = [];
	for (const span of splitAtOuterEdges(merged)) {
		const insideHtml = html.some((outer) => outer.start <= span.start && span.end <= outer.end);
		const [open, close] = wrapperFor(span.kind, span.color, span.rgb, insideHtml, styles);
		if (open === "") continue;
		// A markdown delimiter has to touch the text it marks; an HTML tag can
		// sit anywhere. Only the former needs the punctuation moved out.
		const range = open.startsWith("<") ? span : tightenToWord(source, span);
		if (range === null) continue;
		if (open.startsWith("<")) html.push(range);
		const depth = KIND_ORDER.indexOf(span.kind);
		edits.push({ at: range.start, remove: 0, text: open, rank: depth });
		edits.push({ at: range.end, remove: 0, text: close, rank: -depth });
	}
	// Apply back to front so earlier offsets stay valid; at one position the
	// outer wrapper opens first and closes last. A removal at a position goes
	// before any insertion there, so nothing just inserted is cut away.
	edits.sort((a, b) => b.at - a.at || b.remove - a.remove || b.rank - a.rank);
	let out = source;
	for (const edit of edits) {
		out = out.slice(0, edit.at) + edit.text + out.slice(edit.at + edit.remove);
	}
	return out;
}

/** One change to the source: remove `remove` characters at `at`, insert `text`. */
interface TextEdit {
	at: number;
	remove: number;
	text: string;
	rank: number;
}

/** Ranges grouped per source line, each as one start–end span. */
function groupByLine(covered: Range[], lineOf: (offset: number) => number): Range[] {
	const byLine = new Map<number, Range>();
	for (const range of covered) {
		const line = lineOf(range.start);
		const current = byLine.get(line);
		byLine.set(
			line,
			current === undefined
				? { ...range }
				: { start: Math.min(current.start, range.start), end: Math.max(current.end, range.end) },
		);
	}
	return [...byLine.values()];
}

const EMPHASIS = new Set(["*", "_", "~", "="]);

/**
 * Turn removed word ranges into non-overlapping removals: words on one line
 * separated only by spaces merge into one run; a run that empties an
 * emphasis takes its delimiters with it (`**gone**` leaves no `****`); and
 * each run takes exactly one neighbouring space — never a newline.
 */
function removalEdits(source: string, ranges: Range[]): TextEdit[] {
	const sorted = [...ranges].sort((a, b) => a.start - b.start);
	const runs: Range[] = [];
	for (const range of sorted) {
		const last = runs[runs.length - 1];
		if (last !== undefined && /^[ \t]*$/.test(source.slice(last.end, range.start)) && range.start >= last.end) {
			last.end = Math.max(last.end, range.end);
		} else if (last !== undefined && range.start < last.end) {
			last.end = Math.max(last.end, range.end);
		} else {
			runs.push({ ...range });
		}
	}
	const edits: TextEdit[] = [];
	let floor = 0;
	for (const run of runs) {
		let { start, end } = run;
		// Widen over delimiters the run leaves empty: matching emphasis on both sides.
		for (;;) {
			let width = 0;
			while (
				width < 3 &&
				start - width - 1 >= 0 &&
				EMPHASIS.has(source[start - width - 1]) &&
				source[end + width] === source[start - width - 1]
			) {
				width++;
			}
			if (width === 0) break;
			start -= width;
			end += width;
		}
		if (source[end] === " ") end++;
		else if (start > floor && source[start - 1] === " ") start--;
		start = Math.max(start, floor);
		if (end <= start) continue;
		edits.push({ at: start, remove: end - start, text: "", rank: 0 });
		floor = end;
	}
	return edits;
}

/** Inline markup in a phrase is self-contained: every delimiter closes inside it. */
function balancedInline(text: string): boolean {
	for (const delimiter of ["**", "__", "~~", "==", "`"]) {
		if (text.split(delimiter).length % 2 === 0) return false;
	}
	const single = text.replace(/\*\*|__/g, "");
	if ((single.match(/\*/g) ?? []).length % 2 !== 0) return false;
	if ((text.match(/\[/g) ?? []).length !== (text.match(/\]/g) ?? []).length) return false;
	return !/[<>]/.test(text);
}

/** Past any closing emphasis right after a word, so an insert lands outside it. */
function afterMarkup(source: string, at: number): number {
	let position = at;
	while (position < source.length && EMPHASIS.has(source[position])) position++;
	return position;
}

/** Before any opening emphasis right before a word. */
function beforeMarkup(source: string, at: number): number {
	let position = at;
	while (position > 0 && EMPHASIS.has(source[position - 1])) position--;
	return position;
}

/**
 * Pull a range in until it starts and ends on a letter or digit.
 *
 * Markdown delimiters are flanking-sensitive: `~~"Laten we …"~~` leaves the
 * tildes in the text as literal characters, because the delimiter opens
 * against a quote rather than a word (beta, 2026-07-28). Marking the phrase
 * *inside* its quotes — `"~~Laten we …~~"` — says the same thing and renders.
 *
 * Returns null when nothing but punctuation was covered; there is no sensible
 * markdown for striking a lone quote mark.
 */
function tightenToWord(source: string, span: Range): Range | null {
	let { start, end } = span;
	while (start < end && !WORDISH.test(source[start])) start++;
	while (end > start && !WORDISH.test(source[end - 1])) end--;
	return end > start ? { start, end } : null;
}

/**
 * Cut every span at the edges of the kinds that nest outside it.
 *
 * A strike-through that starts before a highlight and ends inside it would
 * otherwise produce `~~plannen <mark>maken en~~ investeren…</mark>` —
 * crossing tags, which markdown renders by leaving a stray `~~` in the text
 * (beta, 2026-07-28). Splitting the inner mark at the boundary gives
 * `~~plannen ~~<mark>~~maken en~~ investeren…</mark>`: same meaning, properly
 * nested.
 */
function splitAtOuterEdges<T extends { kind: string; start: number; end: number }>(
	spans: T[],
): T[] {
	const out: T[] = [];
	for (const span of spans) {
		const depth = KIND_ORDER.indexOf(span.kind);
		// Only spans that wrap *outside* this one can break its nesting.
		const cuts = spans
			.filter((other) => KIND_ORDER.indexOf(other.kind) < depth)
			.flatMap((other) => [other.start, other.end])
			.filter((at) => at > span.start && at < span.end)
			.sort((a, b) => a - b);
		let from = span.start;
		for (const at of [...new Set(cuts), span.end]) {
			out.push({ ...span, start: from, end: at });
			from = at;
		}
	}
	return out;
}

/**
 * Marks that act on whole lines: a bar in the margin quotes them, a remark
 * is appended below them. Line numbers come from the untouched source, and
 * inline insertions add no newlines, so they still hold.
 */
function applyBlockMarks(
	markdown: string,
	input: ProjectionInput,
	words: { id: number; text: string; block: number; page: number; y: number }[],
	ranges: Map<number, Range>,
	unapplied: PendingChange[],
): string {
	const lineOf = lineIndexer(input.source);
	const lines = markdown.split("\n");
	const quoted = new Set<number>();
	const remarks = new Map<number, string[]>();

	for (const mark of input.marks) {
		const blocks = new Set(mark.blocks ?? []);
		const own = words.filter((word) => blocks.has(word.block) && ranges.has(word.id));
		const touched = own.map((word) => lineOf(ranges.get(word.id)!.start));

		if (mark.kind === "margin") {
			if (touched.length === 0) {
				unapplied.push({ page: mark.page, text: `marked in the margin beside “${mark.quote ?? ""}” — not found in the note` });
				continue;
			}
			for (let line = Math.min(...touched); line <= Math.max(...touched); line++) {
				quoted.add(line);
			}
			continue;
		}
		if (mark.kind === "note") {
			// The ink's place on its page; an added page's ink is on a page of its own.
			const device = mark.addedPage === undefined && mark.strokes !== undefined ? strokeBounds(mark.strokes.map((points) => ({ points }))) : null;
			const ink = device === null ? null : deviceBoundsToPdf(device, input.layout);
			// Written on a task with no text: its line, which no word leads to.
			const onTask = mark.task === undefined ? null : emptyTaskLine(mark.task, ranges, lineOf, lines);
			const anchor = onTask ?? anchorLine(mark, words, ranges, lineOf, ink, lines.length - 1);
			remarks.set(anchor, joinBlocks(remarks.get(anchor) ?? [], markLines(mark)));
		}
	}

	return placeAfterBlocks(lines, remarks, quoted);
}

/**
 * The lines with each placed block after the line it belongs to (-1: before
 * them all) — after the whole markdown block that line is in: a callout in
 * the middle of a table, list, callout or code fence would split it, and the
 * lines after it would run on into the callout. `quoted` lines become quotes.
 *
 * A block is set apart by one blank line on each side unless the note has
 * one there already; right after a closing fence or a heading with a line
 * straight after it, by one after only. So the blank lines it added can be
 * told from the note's own (typednote.ts typedBody takes them out again) —
 * all but the one after a block placed inside a run of lines, after a
 * table a list follows straight on.
 */
export function placeAfterBlocks(lines: string[], blocks: Map<number, string[]>, quoted: ReadonlySet<number> = new Set()): string {
	const placed = new Map<number, string[]>();
	for (const [line, block] of blocks) {
		// A blank line belongs to no block: the block is the one above it.
		let at = Math.min(line, lines.length - 1);
		while (at >= 0 && lines[at].trim() === "") at--;
		const end = at < 0 ? -1 : blockEnd(lines, at);
		placed.set(end, joinBlocks(placed.get(end) ?? [], block));
	}
	const out: string[] = [];
	const top = placed.get(-1);
	if (top !== undefined) out.push(...top, "");
	lines.forEach((line, index) => {
		out.push(quoted.has(index) && !line.startsWith(">") ? `> ${line}` : line);
		const block = placed.get(index);
		if (block === undefined) return;
		const lineAfter = index + 1 < lines.length && lines[index + 1].trim() !== "";
		if (lineAfter && (FENCE.test(line) || HEADING.test(line))) {
			out.push(...block, "");
			return;
		}
		out.push("", ...block);
		// Text straight after would read as more of the callout.
		const next = lines[index + 1] ?? "";
		if (lineAfter && !FENCE.test(next) && !HEADING.test(next)) out.push("");
	});
	return out.join("\n");
}

/**
 * Two placed blocks one after the other, a blank line between: callouts
 * straight after each other are one callout, and plain text right after a
 * callout reads as more of it.
 */
export function joinBlocks(first: string[], second: string[]): string[] {
	return first.length === 0 ? second : [...first, "", ...second];
}

/**
 * The lines a note mark goes into the note as: typed text as it is, plain
 * lines, then its block id (remarkid.ts typedIdLine) on a line of its own;
 * a remark as its callout.
 */
export function markLines(mark: ImportedMark): string[] {
	if (mark.typed === undefined) return remarkCallout(mark);
	return [...mark.typed.split("\n"), ...(mark.typedId === undefined ? [] : ["", typedIdLine(mark.typedId)])];
}

/** A remark's callout: title, its reading, its image, its id (remarkid.ts). */
export function remarkCallout(mark: ImportedMark): string[] {
	// A whole page added on the device is not a remark in the margin; say
	// what it is, so a page of thinking is not mistaken for a scribble
	// (GP_E3_S20).
	const title =
		(mark.addedPage === undefined
			? "> [!note] Remark"
			: `> [!note] Page added on the reMarkable (page ${mark.addedPage})`) +
		(mark.confirmed === true ? ` ${CONFIRM_MARK}` : "");
	return [
		title,
		// Ink fork: the transcript is the remark's text; the image stays
		// beside it unless the owner switched images off.
		...(mark.transcript === undefined ? [] : mark.transcript.split("\n").map((line) => `> ${line}`)),
		...(mark.path === undefined ? [] : [`> ![[${mark.path}]]`]),
		// The remark's id, so the note's own text for it is found again on
		// the next import (remarkid.ts).
		...(mark.id === undefined ? [] : [remarkIdLine(mark.id)]),
	];
}

const FENCE = /^\s*(`{3,}|~{3,})/;
const HEADING = /^#{1,6}(\s|$)/;
const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s/;
const TABLE_DIVIDER = /^\s*\|?[\s:|-]+\|[\s:|-]*$/;

/**
 * The last line of the markdown block holding line `at`: the closing fence
 * of a code block; a heading, which is a line of its own; a table's last
 * row; else the end of its run of non-blank lines up to a heading — a
 * callout, a paragraph — carried across blank lines while a list goes on
 * (a further item, or an indented continuation).
 */
export function blockEnd(lines: string[], at: number): number {
	let open: { line: number; fence: string } | null = null;
	for (let i = 0; i <= at && i < lines.length; i++) {
		const fence = FENCE.exec(lines[i])?.[1];
		if (fence === undefined) continue;
		if (open === null) open = { line: i, fence };
		else if (fence[0] === open.fence[0] && fence.length >= open.fence.length) open = null;
	}
	if (open !== null) {
		for (let i = at + 1; i < lines.length; i++) {
			const fence = FENCE.exec(lines[i])?.[1];
			if (fence !== undefined && fence[0] === open.fence[0] && fence.length >= open.fence.length) return i;
		}
		return lines.length - 1;
	}
	if (HEADING.test(lines[at])) return at;
	// A table ends at its last row, whatever follows straight on: mdblocks.ts
	// reads a header with a divider under it, then rows while they have a pipe.
	for (let header = at; header >= 0 && header + 1 < lines.length && lines[header].includes("|"); header--) {
		if (!TABLE_DIVIDER.test(lines[header + 1])) continue;
		let end = Math.max(at, header + 1);
		while (end + 1 < lines.length && lines[end + 1].trim() !== "" && lines[end + 1].includes("|")) end++;
		return end;
	}
	let end = at;
	const list = () => lines.slice(start(lines, at), end + 1).some((line) => LIST_ITEM.test(line));
	for (;;) {
		while (end + 1 < lines.length && lines[end + 1].trim() !== "" && !FENCE.test(lines[end + 1]) && !HEADING.test(lines[end + 1])) end++;
		if (!list()) return end;
		let next = end + 1;
		while (next < lines.length && lines[next].trim() === "") next++;
		if (next >= lines.length || !(LIST_ITEM.test(lines[next]) || /^\s+\S/.test(lines[next]))) return end;
		end = next;
	}
}

/** First line of the run of non-blank lines holding `at`. */
function start(lines: string[], at: number): number {
	let first = at;
	while (first > 0 && lines[first - 1].trim() !== "") first--;
	return first;
}

/** Offset → line index, via the line starts of the untouched source. */
function lineIndexer(source: string): (offset: number) => number {
	const starts = [0];
	for (let at = 0; at < source.length; at++) {
		if (source[at] === "\n") starts.push(at + 1);
	}
	return (offset: number) => {
		let low = 0;
		let high = starts.length - 1;
		while (low < high) {
			const mid = Math.ceil((low + high) / 2);
			if (starts[mid] <= offset) low = mid;
			else high = mid - 1;
		}
		return low;
	};
}

/**
 * The line a remark belongs under. Written against a row: the last line of
 * that row's text — where the text repeats, the occurrence on the remark's
 * page nearest its ink. Free, with no row near it: after the nearest line
 * above it on its page, or before the text when nothing is (-1).
 */
function anchorLine(
	mark: ImportedMark,
	words: { id: number; text: string; page: number; y: number }[],
	ranges: Map<number, Range>,
	lineOf: (offset: number) => number,
	ink: Bounds | null,
	fallback: number,
): number {
	// PDF points, y upwards; another page counts as far away.
	const distance = (word: { page: number; y: number }) =>
		(mark.page === undefined || word.page === mark.page ? 0 : 1e6) +
		(ink === null ? 0 : Math.max(0, ink.minY - word.y, word.y - ink.maxY));
	const quote = mark.quote?.trim();
	if (quote !== undefined && quote !== "") {
		const wanted = quote.split(/\s+/).slice(0, 4);
		let best: { line: number; distance: number } | undefined;
		for (let at = 0; at + wanted.length <= words.length; at++) {
			const run = words.slice(at, at + wanted.length);
			if (!run.every((word, index) => word.text === wanted[index])) continue;
			const range = ranges.get(run[run.length - 1].id);
			if (range === undefined) continue;
			const away = distance(run[0]);
			if (best === undefined || away < best.distance) best = { line: lineOf(range.start), distance: away };
		}
		if (best !== undefined) return best.line;
	}
	const page = mark.page;
	if (page === undefined) return fallback;
	const centre = ink === null ? -Infinity : (ink.minY + ink.maxY) / 2;
	// Words run in document order, so the last one above is the nearest.
	const above = words.filter((word) => ranges.has(word.id) && (word.page < page || (word.page === page && word.y > centre)));
	const last = above[above.length - 1];
	return last === undefined ? -1 : lineOf(ranges.get(last.id)!.start);
}
