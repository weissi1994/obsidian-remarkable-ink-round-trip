/**
 * What changed on the tablet, merged into the note itself.
 *
 * The marks are projected onto the note body as it was sent — the text the
 * layout belongs to — and the result is merged three ways with the note as
 * it reads now, so edits made in the vault meanwhile survive. Without that
 * base (a send from before two-way sync, a lost record) or a layout to read
 * against, the changes are appended as a summary block instead.
 *
 * A handwritten remark the note already shows is not placed again: every
 * import reads the whole notebook, so without care each sync would offer it
 * once more — as a conflict next to the note's callout, or, in the summary
 * block, in place of it. What the callout says depends on who wrote it:
 * text the owner changed stands for good; a reading the plugin wrote and
 * nobody touched (the mark's `replaces`) gives way to a newer, different
 * reading that scores better (see withEarlierReadings), so remarks read
 * badly before improve as the reader learns. A reading the owner confirmed
 * (✓ in the title) is never replaced. A remark the owner wrote more on is
 * a new id with mostly the old ink: its callout is found by that ink and
 * takes the new id instead of a second callout appearing.
 *
 * With remarks inline (inlineremark.ts) a remark is the text or image in
 * the line it was written on, found again by its hidden `%%ink-<id>%%`
 * marker and settled on the same terms: an image takes a confident reading,
 * the plugin's untouched text a confident better one, text the owner
 * changed stands. The tablet's text kept for the next merge leaves the
 * inline remarks it placed out, so they are the note's from then on.
 *
 * Nothing the tablet changed is dropped silently: what the import could not
 * read, and what the projection could not apply, is listed in one “Pending
 * from reMarkable” callout at the end of the note, replaced by every import
 * and gone once nothing is pending.
 *
 * Once a merge is written, the tablet's text it merged (`projected`) is the
 * base of the next one (`mergedBase`), until the note is sent again: merged
 * against the text as sent, every later import would apply the same tablet
 * changes on top of themselves. Remark callouts placed since the send are
 * the note's from then on, kept out of that base and the tablet's text
 * alike — what the note does with them, rereading aside, stands. An import
 * that left a page unread merges against the text as sent: against the
 * last merge's, that page's changes would look undone.
 *
 * Text typed on a handwritten page comes in as a mark carrying it, placed
 * like a free remark on its page, with a block id after it (remarkid.ts
 * typedTextId): once the note has that id, the text is the note's, and an
 * edit in the vault does not make it come in a second time. A typed-text
 * notebook needs no projection: the page's text is the tablet's side as it is
 * (sync/typednote.ts projectTyped), its ink placed after the paragraph it
 * belongs to.
 *
 * Pure and synchronous: the write runs it again on the note as it is at
 * that moment.
 */

import type { PdfLayout } from "../convert/pdf";
import {
	AnnotationOutcome,
	PendingChange,
	pendingLine,
	renderAnnotationBlock,
	upsertAnnotationBlock,
	withoutPendingCallout,
	withPendingCallout,
} from "../incoming/annotationnote";
import type { Highlight } from "../incoming/highlights";
import { findInlineRemark, flatText, inlineRemarks, inlineRemarkText, retargetInlineRemark, setInlineRemark } from "../incoming/inlineremark";
import type { MarkStyles } from "../incoming/markstyles";
import type { ImportedMark } from "../incoming/pull";
import {
	findRemark,
	isRemarkIdLine,
	isRemarkTextLine as isTextLine,
	isSameRemark,
	REMARK_ID_PREFIX,
	remarkIdLine,
	typedIdLine,
} from "../incoming/remarkid";
import { projectOntoSource } from "../incoming/sourceprojection";
import { merge3 } from "./merge3";
import { projectTyped } from "./typednote";

/** A remark's ink as an earlier import kept it, and the plugin's reading of it while the owner never changed it. */
export type KeptRemark = { strokes: { x: number; y: number }[][]; text?: string };

export interface TabletChanges {
	/** The note body as it was sent, or null when unknown. */
	base: string | null;
	/** The note body as it reads now. */
	ours: string;
	layout: PdfLayout | null;
	highlights: Highlight[];
	marks: ImportedMark[];
	styles?: MarkStyles;
	erasedAs?: "delete" | "strikethrough";
	sourcePath: string;
	sourceName: string;
	importedAt: string;
	/** A remark the note shows, by id, as kept from an earlier import; null when nothing was kept. */
	remarkInk?: (id: string) => KeptRemark | null;
	/** The tablet's text the note was last merged with since it was sent: that merge's `projected`. */
	mergedBase?: string;
	/** How a new handwritten remark goes in: a callout below its line (default), or inline where it was written (inlineremark.ts). */
	remarksForm?: "inline" | "callout";
}

const remarkIdOf = new RegExp(`\\^${REMARK_ID_PREFIX}([0-9a-f]+)`);

/** Ids of the remark callouts in a text. */
function remarkIds(text: string): Set<string> {
	return new Set(text.split("\n").flatMap((line) => (isRemarkIdLine(line) ? [remarkIdOf.exec(line)![1]] : [])));
}

/**
 * The text without the callouts of these remarks, and the blank line one
 * left behind — the reverse of how the projection puts a remark in.
 */
function withoutRemarks(text: string, ids: Set<string>): string {
	let lines = text.split("\n");
	for (const id of ids) {
		const found = findRemark(lines.join("\n"), { id });
		if (found === null) continue;
		const after = found.end + 1;
		const blankAfter = after >= lines.length || lines[after].trim() === "";
		let from = found.start;
		let to = found.end;
		if (from > 0 && lines[from - 1].trim() === "" && blankAfter) from--;
		else if (from === 0 && after < lines.length && lines[after].trim() === "") to++;
		lines = [...lines.slice(0, from), ...lines.slice(to + 1)];
	}
	return lines.join("\n");
}

/** Remarks are found by id, or by image in notes from before ids. */
const refOf = (mark: ImportedMark) => ({ id: mark.id, image: mark.path });
const isRemark = (mark: ImportedMark) => mark.kind === "note" && (mark.id !== undefined || mark.path !== undefined);
/** Remark images are named `<doc>-p<page>-<id>.png`: the page, when the name says. */
const pageOfImage = (image: string) => {
	const page = Number(/-p(\d+)-[^/]*$/.exec(image)?.[1] ?? NaN);
	return Number.isFinite(page) ? page : undefined;
};

/** Whether the note's text for a remark is the plugin's own, untouched, and a new reading differs. */
function takesNewReading(mark: ImportedMark, text: string): boolean {
	return mark.replaces !== undefined && text === mark.replaces && mark.transcript !== undefined && mark.transcript !== text;
}

/**
 * The callout of a remark the owner has since written more on, or erased
 * part of: one whose remark is no longer on the tablet as it was, and whose
 * kept ink is mostly this mark's (isSameRemark). It is pointed at the new
 * remark — id line and image — so it is settled like any remark the note
 * shows. Returns the note's lines and the plugin's reading of the old ink,
 * when the owner never changed it; null when no callout matches.
 */
function rebindChangedRemark(
	lines: string[],
	mark: ImportedMark,
	current: Set<string>,
	remarkInk: (id: string) => KeptRemark | null,
): { lines: string[]; text?: string } | null {
	if (mark.id === undefined || mark.strokes === undefined) return null;
	const idOf = new RegExp(`\\^${REMARK_ID_PREFIX}([0-9a-f]+)`);
	for (let at = 0; at < lines.length; at++) {
		if (!isRemarkIdLine(lines[at])) continue;
		const id = idOf.exec(lines[at])![1];
		if (current.has(id)) continue;
		const kept = remarkInk(id);
		if (kept === null) continue;
		const found = findRemark(lines.join("\n"), { id });
		if (found === null) continue;
		const block = lines.slice(found.start, found.end + 1);
		const imageAt = block.findIndex((line) => line.includes("![["));
		const image = imageAt === -1 ? undefined : /!\[\[([^\]|]+)/.exec(block[imageAt])?.[1];
		const known = { page: image === undefined ? undefined : pageOfImage(image), strokes: kept.strokes };
		if (!isSameRemark(known, { page: mark.addedPage ?? mark.page, strokes: mark.strokes })) continue;
		const next = [...lines];
		next[at] = lines[at].replace(idOf, `^${REMARK_ID_PREFIX}${mark.id}`);
		const prefix = /^(\s*(?:>\s?)*)/.exec(lines[at])![1];
		if (imageAt !== -1 && image !== undefined) {
			if (mark.path === undefined) next.splice(found.start + imageAt, 1);
			else next[found.start + imageAt] = block[imageAt].replace(`![[${image}]]`, `![[${mark.path}]]`);
		} else if (mark.path !== undefined) {
			next.splice(at, 0, `${prefix}![[${mark.path}]]`);
		}
		return { lines: next, text: kept.text };
	}
	return null;
}

/**
 * A remark the note shows inline (inlineremark.ts), settled: found by its
 * marker — or, written more on since, by the kept ink of an item whose
 * remark is gone (isSameRemark), its marker then pointing at the new id.
 * An image takes a confident reading in its place; text the plugin wrote
 * and nobody touched takes a confident new reading on the terms a callout
 * does (`replaces`, or the rebound item's earlier reading). Text the owner
 * changed stands. Null when the note shows no such item.
 */
function settleInline(
	note: string,
	mark: ImportedMark,
	current: Set<string>,
	remarkInk?: (id: string) => KeptRemark | null,
): { note: string; refreshed: boolean } | null {
	const id = mark.id!;
	let item = findInlineRemark(note, id);
	let plugin = mark.replaces;
	if (item === null && remarkInk !== undefined && mark.strokes !== undefined) {
		for (const other of inlineRemarks(note)) {
			if (current.has(other.id)) continue;
			const kept = remarkInk(other.id);
			if (kept === null) continue;
			const known = { page: other.image === undefined ? undefined : pageOfImage(other.image), strokes: kept.strokes };
			if (!isSameRemark(known, { page: mark.addedPage ?? mark.page, strokes: mark.strokes })) continue;
			note = retargetInlineRemark(note, other.id, id);
			item = findInlineRemark(note, id);
			plugin = kept.text;
			break;
		}
	}
	if (item === null) return null;
	const reading = mark.transcript?.trim() ?? "";
	const confident = mark.confident === true && reading !== "";
	if (item.image !== undefined) {
		if (confident) return { note: setInlineRemark(note, id, { text: reading })!, refreshed: true };
		if (mark.path === undefined || mark.path === item.image) return { note, refreshed: false };
		const lines = note.split("\n");
		lines[item.line] = lines[item.line].replace(`![[${item.image}`, `![[${mark.path}`);
		return { note: lines.join("\n"), refreshed: false };
	}
	if (!confident || plugin === undefined || plugin.trim() === "") return { note, refreshed: false };
	const untouched = inlineRemarkText(note, id, plugin) === flatText(plugin);
	if (!untouched || flatText(plugin) === flatText(reading)) return { note, refreshed: false };
	return { note: setInlineRemark(note, id, { text: reading }, plugin)!, refreshed: true };
}

/**
 * The note with what it already shows of the tablet's remarks settled, and
 * the remarks still to place. A remark the note has is not placed again; its
 * callout takes the new reading only while it shows the plugin's untouched
 * earlier one (`replaces`), and a callout from before ids gets its id line.
 * A remark whose ink changed takes over its old callout (rebindChangedRemark),
 * whose text gives way to the new reading on the same terms.
 * `refreshed` lists the ids whose text was replaced.
 */
export function settleRemarks(
	ours: string,
	marks: ImportedMark[],
	remarkInk?: (id: string) => KeptRemark | null,
): { ours: string; marks: ImportedMark[]; refreshed: string[] } {
	let lines = ours.split("\n");
	const rest: ImportedMark[] = [];
	const refreshed: string[] = [];
	// A callout whose remark is still on the tablet as it was belongs to that remark.
	const current = new Set(marks.flatMap((mark) => (mark.id === undefined ? [] : [mark.id])));
	for (const mark of marks) {
		let found = isRemark(mark) ? findRemark(lines.join("\n"), refOf(mark)) : null;
		// Rebound to the callout of its earlier ink: that callout's text is the
		// plugin's while it is empty or the reading the plugin last wrote.
		let pluginText = false;
		if (found === null && isRemark(mark) && remarkInk !== undefined) {
			const rebound = rebindChangedRemark(lines, mark, current, remarkInk);
			if (rebound !== null) {
				lines = rebound.lines;
				found = findRemark(lines.join("\n"), refOf(mark));
				pluginText = found !== null && (found.text === "" || found.text === rebound.text);
			}
		}
		if (found === null) {
			const inline = isRemark(mark) && mark.id !== undefined ? settleInline(lines.join("\n"), mark, current, remarkInk) : null;
			if (inline === null) {
				rest.push(mark);
				continue;
			}
			lines = inline.note.split("\n");
			if (inline.refreshed) refreshed.push(mark.id!);
			continue;
		}
		const quoted = lines[found.end].startsWith(">");
		if (mark.id !== undefined && !found.hasId) lines.splice(found.end + 1, 0, remarkIdLine(mark.id, quoted));
		const untouched =
			takesNewReading(mark, found.text) ||
			(pluginText && mark.transcript !== undefined && mark.transcript !== found.text);
		if (found.titled && !found.confirmed && untouched) {
			// The text lines go; the new reading takes their place under the title.
			const block = lines.slice(found.start + 1, found.end + 1).filter((line) => !isTextLine(line));
			lines = [
				...lines.slice(0, found.start + 1),
				...mark.transcript!.split("\n").map((line) => `> ${line}`),
				...block,
				...lines.slice(found.end + 1),
			];
			if (mark.id !== undefined) refreshed.push(mark.id);
		}
	}
	return { ours: lines.join("\n"), marks: rest, refreshed };
}

/** In the summary block, a remark keeps the note's text unless it is the plugin's untouched reading. */
function withNoteTexts(ours: string, marks: ImportedMark[], refreshed: string[]): ImportedMark[] {
	// One the note shows inline is the note's text already.
	const shown = marks.filter((mark) => !isRemark(mark) || mark.id === undefined || findInlineRemark(ours, mark.id) === null);
	return shown.map((mark) => {
		const found = isRemark(mark) ? findRemark(ours, refOf(mark)) : null;
		if (found === null) return mark;
		if (!found.confirmed && takesNewReading(mark, found.text)) {
			if (mark.id !== undefined) refreshed.push(mark.id);
			return mark;
		}
		const kept = found.confirmed ? { ...mark, confirmed: true } : mark;
		return found.text === "" ? kept : { ...kept, transcript: found.text };
	});
}

export function mergeTabletChanges(input: TabletChanges): {
	body: string;
	outcome: AnnotationOutcome;
	/** Remarks whose untouched earlier reading was replaced by a new one. */
	refreshed: string[];
	/**
	 * The tablet's text this merge used, to keep as the next one's
	 * `mergedBase` once the body is written; null when there is none to keep
	 * (nothing applied, a summary, a page left unread).
	 */
	projected: string | null;
} {
	// The pending callout is the plugin's own list, rebuilt by every import.
	const ours = withoutPendingCallout(input.ours);
	const marks = input.marks.filter((mark) => mark.kind !== "skipped");
	const unread: PendingChange[] = input.marks
		.filter((mark) => mark.kind === "skipped")
		.map((mark) => ({ page: mark.page, text: mark.unapplied ?? "a change that could not be read" }));
	if (input.highlights.length === 0 && marks.length === 0) {
		return {
			body: withPendingCallout(ours, unread),
			outcome: { form: "copy", conflicts: 0, pending: unread.map(pendingLine) },
			refreshed: [],
			projected: null,
		};
	}
	const complete = !input.marks.some((mark) => mark.kind === "skipped" && mark.unreadPage === true);
	const settled = settleRemarks(ours, marks, input.remarkInk);
	// Typed text whose block id the merge base has is the tablet's side
	// already when the text projected onto has it too; one the base lacks
	// came in since and is the note's, however the owner changed it.
	const mergeBase = input.mergedBase !== undefined && complete ? input.mergedBase : input.base;
	const toPlace = settled.marks.filter((mark) => {
		if (mark.typedId === undefined) return true;
		const line = typedIdLine(mark.typedId);
		return mergeBase?.includes(line) === true ? input.base?.includes(line) !== true : !ours.includes(line);
	});
	const typedPage = marks.find((mark) => mark.tabletText !== undefined)?.tabletText;
	const projected =
		input.base === null
			? null
			: typedPage !== undefined
				? projectTyped(input.base, typedPage, toPlace)
				: input.layout === null
					? null
					: projectOntoSource({
							source: input.base,
							layout: input.layout,
							highlights: input.highlights,
							marks: toPlace,
							styles: input.styles,
							erasedAs: input.erasedAs,
							listUnplaced: false,
							remarksForm: input.remarksForm,
						});
	if (projected === null || input.base === null) {
		const refreshed: string[] = [];
		// Without what was sent, a typed page's text cannot be merged: it is listed whole.
		const listed = input.marks.map((mark) =>
			mark.tabletText === undefined ? mark : { kind: mark.kind, typed: mark.tabletText },
		);
		const summary = renderAnnotationBlock({
			sourcePath: input.sourcePath,
			sourceName: input.sourceName,
			highlights: input.highlights,
			// The summary lists what could not be read with everything else.
			marks: withNoteTexts(ours, listed, refreshed),
			inSourceNote: true,
			styles: input.styles,
			erasedAs: input.erasedAs,
			importedAt: input.importedAt,
		});
		return {
			body: upsertAnnotationBlock(ours, summary.text),
			outcome: { ...summary.outcome, pending: unread.map(pendingLine) },
			refreshed,
			projected: null,
		};
	}
	// The projection ends on its last line; the note keeps the base's
	// line breaks after it. A typed page's text ends trimmed: the base's
	// spaces ending its last line come back with them.
	const ended = typedPage === undefined ? input.base.replace(/(\n[ \t]*)+$/, "") : input.base.trimEnd();
	const tail = input.base.slice(ended.length);
	const theirs = withoutPendingCallout(projected.markdown + tail);
	let base = withoutPendingCallout(input.base);
	let tablet = theirs;
	if (input.mergedBase !== undefined && complete) {
		const sentIds = remarkIds(base);
		const placed = new Set([...remarkIds(input.mergedBase)].filter((id) => !sentIds.has(id)));
		base = withoutRemarks(withoutPendingCallout(input.mergedBase), placed);
		tablet = withoutRemarks(theirs, placed);
	}
	const merged = merge3(base, settled.ours, tablet);
	const pending = [
		...unread,
		...projected.unapplied,
		...projected.unplaced.map((highlight) => ({
			page: highlight.page,
			text: `“${highlight.text}” highlighted — not found in the note`,
		})),
	].sort((a, b) => (a.page ?? Infinity) - (b.page ?? Infinity));
	return {
		body: withPendingCallout(merged.text, pending),
		outcome: {
			form: "copy",
			unplaced: projected.unplaced.length,
			conflicts: merged.conflicts,
			pending: pending.map(pendingLine),
		},
		refreshed: settled.refreshed,
		// Without the inline remarks it placed: from now on those are the note's.
		projected: complete ? withoutPendingCallout(projected.withoutInline + tail) : null,
	};
}
