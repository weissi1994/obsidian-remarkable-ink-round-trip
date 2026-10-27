/**
 * The tablet's typed text as markdown: the reverse of roottext.ts'
 * markdownToTypedText, one line per paragraph, so text the plugin wrote
 * comes back as the same markdown and the tablet's edits show up as edits.
 */

import type { TextSpan, TypedParagraph } from "./rmscene";
import { linePrefixStyle, parseInlineMarkdown, STYLE_PREFIX } from "../ink/roottext";

export function typedTextToMarkdown(paragraphs: readonly TypedParagraph[]): string {
	return paragraphs
		.map((paragraph) => {
			const inline = inlineMarkdown(paragraph.spans);
			const prefix = STYLE_PREFIX[paragraph.style];
			// A line that would read as another style keeps a backslash: a plain
			// "- not a list", a bullet whose text is "[x] milk".
			const escapes = /^\\*/.exec(inline)![0].length;
			const reads = linePrefixStyle(prefix + inline.slice(escapes)) ?? "plain";
			return reads === (prefix === "" ? "plain" : paragraph.style) ? prefix + inline : `${prefix}\\${inline}`;
		})
		.join("\n");
}

function append(segments: TextSpan[], text: string, bold: boolean, italic: boolean): void {
	if (text === "") return;
	const last = segments[segments.length - 1];
	if (last !== undefined && last.bold === bold && last.italic === italic) last.text += text;
	else segments.push({ text, bold, italic });
}

/**
 * Emphasis markers can only hug text — `** bold**` is not bold — so
 * whitespace at a run's edge loses the emphasis that starts or ends there
 * (and keeps what continues past it). Of two markers opening at once, the
 * longer-lasting goes outside. Literal asterisks are left alone when the
 * result still reads back the same, and escaped when not.
 *
 * Some emphasis markdown cannot express: `*` between punctuation and a
 * letter (`**b*[x***`) is no delimiter. Rather than let such markers leak
 * into the text, the emphasis nearest the first misreading is dropped until
 * the line reads back as the same text — with no emphasis left, it always
 * does.
 */
function inlineMarkdown(spans: readonly TextSpan[]): string {
	const runs: TextSpan[] = [];
	for (const span of spans) append(runs, span.text, span.bold, span.italic);
	let segments: TextSpan[] = [];
	runs.forEach((run, i) => {
		const before = runs[i - 1];
		const after = runs[i + 1];
		const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/u.exec(run.text)!;
		append(segments, lead, run.bold && before?.bold === true, run.italic && before?.italic === true);
		append(segments, core, run.bold, run.italic);
		append(segments, trail, run.bold && after?.bold === true, run.italic && after?.italic === true);
	});
	for (;;) {
		const written = visible(segments);
		const unescaped = emphasise(segments, false);
		if (firstDifference(visible(parseInlineMarkdown(unescaped)), written) < 0) return unescaped;
		const escaped = emphasise(segments, true);
		const differs = firstDifference(visible(parseInlineMarkdown(escaped)), written);
		if (differs < 0) return escaped;
		const fewer = dropEmphasisNear(segments, differs);
		if (fewer === undefined) return escaped;
		segments = fewer;
	}
}

/** Each code point with its emphasis; whitespace without, as emphasis on it does not show. */
function visible(spans: readonly TextSpan[]): string[] {
	return spans.flatMap((span) =>
		Array.from(span.text, (char) => (/\s/u.test(char) ? char : `${char}${Number(span.bold)}${Number(span.italic)}`)),
	);
}

/** Index of the first code point read differently from how it was written; −1 when none is. */
function firstDifference(read: readonly string[], written: readonly string[]): number {
	let i = 0;
	while (i < read.length && i < written.length && read[i] === written[i]) i++;
	return i === read.length && i === written.length ? -1 : i;
}

/**
 * The segments with the emphasised one at or before `position` (else the
 * next one) made plain; undefined when nothing is emphasised.
 */
function dropEmphasisNear(segments: readonly TextSpan[], position: number): TextSpan[] | undefined {
	let at = 0;
	for (let start = 0; at < segments.length - 1; at++) {
		start += Array.from(segments[at].text).length;
		if (start > position) break;
	}
	const emphasised = (i: number) => segments[i].bold || segments[i].italic;
	let target = at;
	while (target >= 0 && !emphasised(target)) target--;
	if (target < 0) target = segments.findIndex((_, i) => i > at && emphasised(i));
	if (target < 0) return undefined;
	const result: TextSpan[] = [];
	segments.forEach((segment, i) =>
		append(result, segment.text, i !== target && segment.bold, i !== target && segment.italic),
	);
	return result;
}

/**
 * Backslashes right before an asterisk would escape it, so there they are
 * doubled (parseInlineMarkdown reads a pair as one backslash).
 */
function emphasise(segments: TextSpan[], escape: boolean): string {
	let out = "";
	let backslashes = "";
	const put = (chars: string, literal: boolean): void => {
		for (const char of chars) {
			if (literal && char === "\\") {
				backslashes += char;
			} else if (char === "*") {
				out += backslashes + backslashes + (literal && escape ? "\\*" : "*");
				backslashes = "";
			} else {
				out += backslashes + char;
				backslashes = "";
			}
		}
	};
	const open: ("bold" | "italic")[] = [];
	const marker = (kind: "bold" | "italic"): string => (kind === "bold" ? "**" : "*");
	const lasting = (from: number, kind: "bold" | "italic"): number => {
		let end = from;
		while (end < segments.length && segments[end][kind]) end++;
		return end - from;
	};
	segments.forEach((segment, index) => {
		let keep = 0;
		while (keep < open.length && segment[open[keep]]) keep++;
		const reopens = open.slice(keep).some((kind) => segment[kind]);
		while (open.length > keep) put(marker(open.pop()!), false);
		// `***` then `**` would read as one run: let whitespace sit between.
		let text = segment.text;
		if (reopens) {
			const lead = /^\s*/u.exec(text)![0];
			put(lead, true);
			text = text.slice(lead.length);
		}
		const opening = (["bold", "italic"] as const)
			.filter((kind) => segment[kind] && !open.includes(kind))
			.sort((a, b) => lasting(index, b) - lasting(index, a));
		for (const kind of opening) {
			put(marker(kind), false);
			open.push(kind);
		}
		put(text, true);
	});
	while (open.length > 0) put(marker(open.pop()!), false);
	return out + backslashes;
}
