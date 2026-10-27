/**
 * Typed text — the keyboard text of a reMarkable page — written into a v6
 * `.rm` page, and the markdown subset it can show.
 *
 * The block follows rmscene's RootTextBlock writer (MIT, Rick Lupton) and
 * the layout firmware 3.x pages carry: the text as a CRDT sequence of runs
 * whose characters take consecutive ids, inline bold/italic as format-code
 * items between them, paragraph styles keyed by the newline that opens each
 * paragraph ((0, 0) for the first), then the text box. Everything is ours:
 * author 1, counters after the page's strokes, so the tablet's own edits —
 * under its own author — stay recognisable, as with ink.
 *
 * The markdown mapping is one line per paragraph, which makes it reversible
 * (typedtext.ts reads it back): `# ` heading, `## ` the tablet's bold
 * paragraph, `- ` bullet, tab + `- ` second-level bullet, `- [ ] ` / `- [x] `
 * checkboxes, `*`/`**` emphasis. Anything else — deeper headings, numbered
 * lists, quotes, links — stays literal text, as the tablet cannot style it.
 */

import { ByteWriter, type CrdtId } from "./rmbytes";
import {
	buildScenePageRm,
	FIRST_STROKE_COUNTER,
	INK_AUTHOR,
	type InkLine,
	type InkPageOptions,
	type PageTextBlock,
} from "./rmwrite";
import {
	PARAGRAPH_STYLES,
	type ParagraphStyle,
	type TextSpan,
	type TypedParagraph,
} from "../incoming/rmscene";

const BLOCK_ROOT_TEXT = 0x07;
const TAG_BYTE1 = 0x1;
const FORMAT_BOLD_ON = 1;
const FORMAT_BOLD_OFF = 2;
const FORMAT_ITALIC_ON = 3;
const FORMAT_ITALIC_OFF = 4;

const END: CrdtId = { part1: 0, part2: 0 };

/** The text box in page units; x is measured from the page's centre line. */
export interface TextBox {
	x: number;
	y: number;
	width: number;
}

/** The box a fresh page gives typed text (rmscene simple_text_document, every sample page). */
export const DEFAULT_TEXT_BOX: TextBox = { x: -468, y: 234, width: 936 };

export interface TextPageOptions extends InkPageOptions {
	textBox?: TextBox;
}

/**
 * Build a page holding typed text, optionally with pen strokes on its layer
 * as buildInkPageRm writes them. The text's ids start after the strokes'
 * counters so the two never collide.
 */
export function buildTextPageRm(
	paragraphs: readonly TypedParagraph[],
	lines: InkLine[],
	options: TextPageOptions,
): Uint8Array {
	const firstCounter = lines.reduce((next, line) => Math.max(next, line.counter + 1), FIRST_STROKE_COUNTER);
	return buildScenePageRm(
		lines.map((line) => ({ author: INK_AUTHOR, counter: line.counter, line })),
		options,
		encodeRootText(paragraphs, firstCounter, options.textBox ?? DEFAULT_TEXT_BOX),
	);
}

interface TextItem {
	counter: number;
	/** A run of code points, or one format code. */
	value: string | number;
}

function encodeRootText(paragraphs: readonly TypedParagraph[], firstCounter: number, box: TextBox): PageTextBlock {
	const items: TextItem[] = [];
	const styles: { key: CrdtId; style: ParagraphStyle }[] = [];
	let counter = firstCounter;
	let run: TextItem | undefined;
	let chars = 0;
	const pushChar = (char: string): void => {
		if (run === undefined) {
			run = { counter, value: "" };
			items.push(run);
		}
		run.value += char;
		counter++;
		chars++;
	};
	const pushCode = (code: number): void => {
		run = undefined;
		items.push({ counter: counter++, value: code });
	};
	let bold = false;
	let italic = false;
	const format = (span: { bold: boolean; italic: boolean }): void => {
		if (span.bold !== bold) pushCode(span.bold ? FORMAT_BOLD_ON : FORMAT_BOLD_OFF);
		if (span.italic !== italic) pushCode(span.italic ? FORMAT_ITALIC_ON : FORMAT_ITALIC_OFF);
		bold = span.bold;
		italic = span.italic;
	};

	paragraphs.forEach((paragraph, index) => {
		if (index === 0) {
			styles.push({ key: END, style: paragraph.style });
		} else {
			styles.push({ key: { part1: INK_AUTHOR, part2: counter }, style: paragraph.style });
			pushChar("\n");
		}
		for (const span of paragraph.spans) {
			if (span.text === "") continue;
			format(span);
			for (const char of span.text) pushChar(char);
		}
		// Emphasis ends with its line, as in markdown.
		format({ bold: false, italic: false });
	});
	const timestamps = styles.map(() => counter++);

	return {
		chars: chars + 1,
		lines: paragraphs.length,
		write: (w: ByteWriter) =>
			w.block(BLOCK_ROOT_TEXT, 1, 1, (b) => {
				b.taggedId(1, END);
				b.subblock(2, (body) => {
					body.subblock(1, (outer) =>
						outer.subblock(1, (list) => {
							list.varuint(items.length);
							items.forEach((item, i) => {
								list.subblock(0, (s) => {
									s.taggedId(2, { part1: INK_AUTHOR, part2: item.counter });
									s.taggedId(3, i === 0 ? END : { part1: INK_AUTHOR, part2: item.counter - 1 });
									s.taggedId(4, END);
									s.taggedInt(5, 0);
									const value = item.value;
									if (typeof value === "string") {
										s.taggedString(6, value);
									} else {
										s.subblock(6, (v) => {
											v.varuint(0);
											v.u8(1);
											v.taggedInt(2, value);
										});
									}
								});
							});
						}),
					);
					body.subblock(2, (outer) =>
						outer.subblock(1, (list) => {
							list.varuint(styles.length);
							styles.forEach(({ key, style }, i) => {
								list.crdtId(key);
								list.taggedId(1, { part1: INK_AUTHOR, part2: timestamps[i] });
								list.subblock(2, (v) => {
									v.tag(1, TAG_BYTE1);
									v.u8(PARAGRAPH_STYLES.indexOf(style));
								});
							});
						}),
					);
				});
				b.subblock(3, (s) => {
					s.f64(box.x);
					s.f64(box.y);
				});
				b.taggedFloat(4, box.width);
			}),
	};
}

/** The line prefix of each paragraph style; plain and basic paragraphs have none. */
export const STYLE_PREFIX: Record<ParagraphStyle, string> = {
	basic: "",
	plain: "",
	heading: "# ",
	bold: "## ",
	bullet: "- ",
	bullet2: "\t- ",
	checkbox: "- [ ] ",
	"checkbox-checked": "- [x] ",
};

const PREFIXED_STYLES = PARAGRAPH_STYLES.filter((style) => STYLE_PREFIX[style] !== "").sort(
	(a, b) => STYLE_PREFIX[b].length - STYLE_PREFIX[a].length,
);

/** The styled paragraph a markdown line's prefix asks for, if any. */
export function linePrefixStyle(line: string): ParagraphStyle | undefined {
	return PREFIXED_STYLES.find((style) => line.startsWith(STYLE_PREFIX[style]));
}

/**
 * Markdown as typed-text paragraphs, one per line (an empty line is an empty
 * paragraph, as pressing Enter twice on the tablet). A backslash after the
 * line prefix (or before it) keeps the line from reading as another style,
 * the way markdown escapes it: `- \[x] milk` is a bullet saying "[x] milk".
 */
export function markdownToTypedText(markdown: string): TypedParagraph[] {
	return markdown.split("\n").map((raw) => {
		const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		const style = linePrefixStyle(line);
		const prefix = style === undefined ? "" : STYLE_PREFIX[style];
		const rest = line.slice(prefix.length);
		const escapes = /^\\*/.exec(rest)![0].length;
		const reads = linePrefixStyle(prefix + rest.slice(escapes)) ?? "plain";
		const text = escapes > 0 && reads !== (style ?? "plain") ? rest.slice(1) : rest;
		return { style: style ?? "plain", spans: parseInlineMarkdown(text) };
	});
}

interface Delimiter {
	count: number;
	original: number;
	canOpen: boolean;
	canClose: boolean;
	/** Matches this run closed, innermost first, then the ones it opened, innermost first. */
	closes: boolean[];
	opens: boolean[];
}

type InlineNode = string | Delimiter;

const isSpace = (char: string): boolean => char === "" || /\s/u.test(char);
const isPunctuation = (char: string): boolean => /[\p{P}\p{S}]/u.test(char);

/**
 * `*` emphasis of one line as spans, by CommonMark's delimiter-run rules —
 * flanking, the rule of three, nesting — so text reads as Obsidian shows
 * it. `\*` is a literal asterisk (`\\*` a backslash before one); underscores,
 * code and links stay literal text.
 */
export function parseInlineMarkdown(text: string): TextSpan[] {
	const nodes: InlineNode[] = [];
	let literal = "";
	for (let i = 0; i < text.length; ) {
		if (text[i] === "\\") {
			let end = i;
			while (text[end] === "\\") end++;
			if (text[end] !== "*") {
				literal += text.slice(i, end);
				i = end;
				continue;
			}
			// Before an asterisk a pair is one backslash, an odd one escapes it.
			const count = end - i;
			literal += "\\".repeat(count >> 1);
			i = end;
			if (count % 2 === 1) {
				literal += "*";
				i++;
			}
			continue;
		}
		if (text[i] !== "*") {
			literal += text[i++];
			continue;
		}
		let end = i;
		while (text[end] === "*") end++;
		const before = i > 0 ? text[i - 1] : "";
		const after = end < text.length ? text[end] : "";
		const leftFlanking = !isSpace(after) && (!isPunctuation(after) || isSpace(before) || isPunctuation(before));
		const rightFlanking = !isSpace(before) && (!isPunctuation(before) || isSpace(after) || isPunctuation(after));
		if (literal !== "") nodes.push(literal);
		literal = "";
		nodes.push({
			count: end - i,
			original: end - i,
			canOpen: leftFlanking,
			canClose: rightFlanking,
			closes: [],
			opens: [],
		});
		i = end;
	}
	if (literal !== "") nodes.push(literal);

	const delimiters = nodes.filter((node): node is Delimiter => typeof node !== "string");
	for (let c = 0; c < delimiters.length; c++) {
		const closer = delimiters[c];
		if (!closer.canClose) continue;
		while (closer.count > 0) {
			let o = c - 1;
			for (; o >= 0; o--) {
				const opener = delimiters[o];
				if (opener.count === 0 || !opener.canOpen) continue;
				const ruleOfThree =
					(opener.canClose || closer.canOpen) &&
					(opener.original + closer.original) % 3 === 0 &&
					!(opener.original % 3 === 0 && closer.original % 3 === 0);
				if (!ruleOfThree) break;
			}
			if (o < 0) break;
			const opener = delimiters[o];
			const strong = opener.count >= 2 && closer.count >= 2;
			const used = strong ? 2 : 1;
			opener.count -= used;
			closer.count -= used;
			opener.opens.push(strong);
			closer.closes.push(strong);
			// Runs between the pair can no longer pair up: they are literal.
			for (let k = o + 1; k < c; k++) {
				delimiters[k].canOpen = false;
				delimiters[k].canClose = false;
			}
		}
	}

	const spans: TextSpan[] = [];
	let strongDepth = 0;
	let emphasisDepth = 0;
	const emit = (chars: string): void => {
		if (chars === "") return;
		const bold = strongDepth > 0;
		const italic = emphasisDepth > 0;
		const last = spans[spans.length - 1];
		if (last !== undefined && last.bold === bold && last.italic === italic) last.text += chars;
		else spans.push({ text: chars, bold, italic });
	};
	for (const node of nodes) {
		if (typeof node === "string") {
			emit(node);
			continue;
		}
		for (const strong of node.closes) {
			if (strong) strongDepth--;
			else emphasisDepth--;
		}
		emit("*".repeat(node.count));
		for (const strong of [...node.opens].reverse()) {
			if (strong) strongDepth++;
			else emphasisDepth++;
		}
	}
	return spans;
}
