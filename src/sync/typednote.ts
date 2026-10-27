/**
 * Typed-text notebooks (ink fork): the note is sent as the page's typed
 * text, and the page's text comes back as the tablet's side of a three-way
 * merge — no layout, no OCR, the text itself.
 *
 * What goes to the tablet is the note body as it is, minus what is the
 * plugin's bookkeeping or already the tablet's: block-id lines and the
 * callouts carrying a plugin id (remarks — their ink is on the page already
 * — clashes, the pending list). That text is also the merge base, so the
 * base is in note space and the note's own callouts are simply the note's.
 */

import { markdownToTypedText } from "../ink/roottext";
import type { PendingChange } from "../incoming/annotationnote";
import type { ImportedMark } from "../incoming/pull";
import { isPluginIdLine, isTypedIdLine } from "../incoming/remarkid";
import { joinBlocks, markLines, placeAfterBlocks, type ProjectionResult } from "../incoming/sourceprojection";
import { typedTextToMarkdown } from "../incoming/typedtext";

const CALLOUT_HEAD = /^>\s*\[!/;
const FENCE = /^\s*(`{3,}|~{3,})/;

/** The note body as a typed-text notebook shows it (see the module note). */
export function typedBody(body: string): string {
	const lines = body.split("\n");
	const out: string[] = [];
	let fence: string | null = null;
	// Last line of what was just taken out, so a callout right after another is one placed block.
	let removedTo = -2;
	for (let at = 0; at < lines.length; at++) {
		const line = lines[at];
		const marker = FENCE.exec(line)?.[1];
		if (fence !== null) {
			out.push(line);
			if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
			continue;
		}
		if (marker !== undefined) {
			fence = marker;
			out.push(line);
			continue;
		}
		let end = at;
		if (CALLOUT_HEAD.test(line)) {
			while (end + 1 < lines.length && lines[end + 1].startsWith(">") && !CALLOUT_HEAD.test(lines[end + 1])) end++;
			if (!lines.slice(at, end + 1).some(isPluginIdLine)) end = -1;
		} else if (!isTypedIdLine(line)) {
			end = -1;
		}
		if (end !== -1) {
			// With the blank line placeAfterBlocks (sourceprojection.ts) set it
			// apart by: the one before it, else — at the top, after a fence — the one after.
			let blankAfter = false;
			if (at !== removedTo + 1) {
				if (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
				else blankAfter = end + 1 < lines.length && lines[end + 1].trim() === "";
			}
			removedTo = end;
			at = blankAfter ? end + 1 : end;
			continue;
		}
		if (isPluginIdLine(line)) continue;
		out.push(line);
	}
	return out.join("\n");
}

/**
 * The tablet's side of a typed-text notebook's merge: its page text, with
 * the owner's ink and typed pages placed after the paragraph each belongs
 * to. A line the page shows as the plugin wrote it reads back as the note
 * had it — markdown the page cannot style (`__bold__`) comes back in its
 * tablet form otherwise, and would look like a change.
 */
export function projectTyped(base: string, tabletText: string, marks: ImportedMark[]): ProjectionResult {
	const baseLines = base.split("\n");
	const known = new Set(baseLines);
	const asWritten = new Map<string, string>();
	for (const line of baseLines) {
		const read = typedTextToMarkdown(markdownToTypedText(line));
		if (read !== line && !asWritten.has(read)) asWritten.set(read, line);
	}
	const lines = tabletText
		.trimEnd()
		.split("\n")
		.map((line) => (known.has(line) ? line : (asWritten.get(line) ?? line)));
	const blocks = new Map<number, string[]>();
	const unapplied: PendingChange[] = [];
	let placed = 0;
	for (const mark of marks) {
		if (mark.tabletText !== undefined) continue;
		if (mark.kind !== "note" || mark.afterParagraph === undefined) {
			unapplied.push({ page: mark.page, text: `${mark.typed === undefined ? "a change" : "typed text"} on the reMarkable — could not be placed in the note` });
			continue;
		}
		const at = Math.min(mark.afterParagraph, lines.length - 1);
		blocks.set(at, joinBlocks(blocks.get(at) ?? [], markLines(mark)));
		placed++;
	}
	return { markdown: placeAfterBlocks(lines, blocks), placed, unplaced: [], unapplied };
}
