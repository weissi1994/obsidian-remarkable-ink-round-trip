/**
 * Minimal markdown block parser for the typesetter (PRD F3, K1).
 *
 * Consumes preprocessed markdown (see preprocess.ts) and produces a flat list
 * of typed blocks. Inline markers (bold/italic/highlight/strike/inline code)
 * are stripped to plain text, so the layout only ever sees words; which words
 * carried which style rides along separately (`inline`) for the ink renderer
 * to draw — styling never moves a word.
 */

/** A highlighted word and the colour it was marked in, when given. */
export interface HighlightWord {
	word: number;
	rgb?: string;
}

/**
 * Inline styling of a text block, as indices of its whitespace-separated
 * words. Present only when there is any, so plain blocks keep their shape.
 */
export interface InlineStyles {
	code?: number[];
	bold?: number[];
	italic?: number[];
	strike?: number[];
	underline?: number[];
	highlight?: HighlightWord[];
}

export type Block =
	| { type: "heading"; level: number; text: string; inline?: InlineStyles }
	| { type: "paragraph"; text: string; style?: "bold" | "italic"; inline?: InlineStyles }
	| { type: "list"; items: ListItem[] }
	| { type: "quote"; lines: string[]; inline?: InlineStyles }
	| { type: "code"; lines: string[]; lang?: string }
	/** `inline`: each cell's styling, row by row — only when any cell has some. */
	| { type: "table"; rows: string[][]; inline?: (InlineStyles | null)[][] }
	| { type: "hr" }
	| { type: "image"; w: number; h: number; png?: Uint8Array }
	/**
	 * A vault image on its own line, before the edge has loaded it (fork:
	 * image blocks). Kept as a placeholder for the same reason a mermaid
	 * fence is: reading bytes and measuring pixels needs the DOM, so the
	 * pure pipeline records *where* a picture goes and substitution fills it
	 * in — at send time from the vault, at import time from the recorded
	 * geometry.
	 */
	| { type: "imageref"; target: string; alt: string }
	| { type: "pagebreak" }
	/**
	 * Ink fork: a picture drawn as pen strokes. Never produced by parseBlocks —
	 * the ink renderer swaps an image placeholder line for one when it has the
	 * picture — so PDF and EPUB layout are untouched. Size in points.
	 */
	| { type: "inkimage"; name: string; width: number; height: number }
	/**
	 * Ink fork: a handwritten remark drawn back where it was written, over
	 * the page rather than in the flow. Never produced by parseBlocks — the
	 * ink renderer swaps a `[remark: name]` placeholder for one.
	 */
	| { type: "inkoverlay"; name: string };

export interface ListItem {
	depth: number;
	ordered: boolean;
	marker: string;
	text: string;
	inline?: InlineStyles;
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const HR_RE = /^(?:-{3,}|\*{3,}|_{3,})\s*$/;
// Pandoc's convention, adopted as ours (GP_E6_S1): a hard page break.
const PAGEBREAK_RE = /^\\pagebreak$/;
const FENCE_RE = /^(?:```|~~~)/;
const TABLE_DIVIDER_RE = /^\s*\|?[\s:|-]+\|[\s:|-]*$/;
/**
 * An image that is the whole line becomes a block; one sitting mid-sentence
 * stays inline text, because a paragraph cannot be broken around a picture
 * without reflowing the sentence (fork: image blocks).
 */
const STANDALONE_WIKI_IMAGE_RE = /^!\[\[([^\]|]+)(?:\|([^\]]*))?\]\]$/;
const STANDALONE_MD_IMAGE_RE = /^!\[([^\]]*)\]\(([^)]+)\)$/;

/** A standalone image line → its target and alt text, else null. */
function standaloneImage(line: string): { target: string; alt: string } | null {
	const wiki = line.match(STANDALONE_WIKI_IMAGE_RE);
	if (wiki !== null) {
		const target = wiki[1].trim();
		return { target, alt: (wiki[2] ?? "").trim() };
	}
	const md = line.match(STANDALONE_MD_IMAGE_RE);
	if (md !== null) return { target: md[2].trim(), alt: md[1].trim() };
	return null;
}

/**
 * A paragraph that is one single bold or italic span — "**Doel**" on its own
 * line — is a styled label (GP_E6_S7): the typesetter can honour it as a
 * whole line in one font. Mixed styling mid-sentence stays plain for now
 * (GP_E6_S8, parked).
 */
function paragraphStyle(raw: string): "bold" | "italic" | undefined {
	if (/^\*\*[^*]+\*\*$/.test(raw) || /^__[^_]+__$/.test(raw)) return "bold";
	if (/^\*[^*]+\*$/.test(raw) || /^_[^_]+_$/.test(raw)) return "italic";
	return undefined;
}

/** Strip inline markdown markers, keeping the readable text. */
export function stripInline(text: string): string {
	return stripMarkers(text.replace(/`([^`]*)`/g, "$1"));
}

function stripMarkers(text: string): string {
	return text
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/__([^_]+)__/g, "$1")
		.replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, "$1")
		.replace(/(?<![\w_])_([^_\n]+)_(?![\w_])/g, "$1")
		.replace(/==([^=]+)==/g, "$1")
		.replace(/~~([^~]+)~~/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
}

export interface ParseOptions {
	/**
	 * Read inline HTML formatting (`<u>`, `<mark style=…>`, `<b>`, `<i>`,
	 * `<s>`…) as styling and drop the tags from the text. Off for sends made
	 * before it existed: their text kept the tags, and must replay so.
	 */
	html?: boolean;
	/**
	 * A picture on its own line inside a quote or callout — a remark's ink —
	 * becomes a picture block, not the text of its placeholder. Off for sends
	 * made before it.
	 */
	quotePictures?: boolean;
}

/** A picture's placeholder line, as preprocessing leaves it (`*[image: name]*`). */
const PICTURE_LINE_RE = /^\*?\[image: [^\]]+\]\*?$/;

type StyleKind = "code" | "bold" | "italic" | "strike" | "underline" | "highlight";

// Private-use sentinels: one open/close pair per style, never in real text.
const OPEN: Record<StyleKind, string> = {
	code: "",
	bold: "",
	italic: "",
	strike: "",
	underline: "",
	highlight: "",
};
const CLOSE: Record<StyleKind, string> = {
	code: "",
	bold: "",
	italic: "",
	strike: "",
	underline: "",
	highlight: "",
};
/** Wraps the colour of a highlight, right after its open sentinel. */
const COLOR = "";
const KIND_OF = new Map<string, { kind: StyleKind; open: boolean }>();
for (const kind of Object.keys(OPEN) as StyleKind[]) {
	KIND_OF.set(OPEN[kind], { kind, open: true });
	KIND_OF.set(CLOSE[kind], { kind, open: false });
}
const SENTINELS_RE = /[-]|[^]*/g;

const wrap = (kind: StyleKind) => (_all: string, inner: string) => `${OPEN[kind]}${inner}${CLOSE[kind]}`;

const HTML_TAGS: { re: RegExp; kind: StyleKind | null }[] = [
	{ re: /<(u|ins)(?:\s[^<>]*)?>([\s\S]*?)<\/\1>/gi, kind: "underline" },
	{ re: /<(b|strong)(?:\s[^<>]*)?>([\s\S]*?)<\/\1>/gi, kind: "bold" },
	{ re: /<(i|em)(?:\s[^<>]*)?>([\s\S]*?)<\/\1>/gi, kind: "italic" },
	{ re: /<(s|del|strike)(?:\s[^<>]*)?>([\s\S]*?)<\/\1>/gi, kind: "strike" },
];
const LEFTOVER_TAG_RE = /<\/?(?:u|ins|b|strong|i|em|s|del|strike|mark|span|sub|sup|small|font)(?:\s[^<>]*)?>/gi;

/** Inline HTML formatting → style sentinels; other formatting tags dropped. */
function markHtml(text: string): string {
	let out = text.replace(/<mark(\s[^<>]*)?>([\s\S]*?)<\/mark>/gi, (_all, attrs: string | undefined, inner: string) => {
		const rgb = /background(?:-color)?\s*:\s*(#[0-9a-f]{6}|#[0-9a-f]{3})\b/i.exec(attrs ?? "")?.[1];
		return `${OPEN.highlight}${rgb === undefined ? "" : `${COLOR}${rgb}${COLOR}`}${inner}${CLOSE.highlight}`;
	});
	for (const { re, kind } of HTML_TAGS) {
		out = out.replace(re, (_all, _tag: string, inner: string) => (kind === null ? inner : `${OPEN[kind]}${inner}${CLOSE[kind]}`));
	}
	return out.replace(LEFTOVER_TAG_RE, "");
}

/** stripInline's chain, leaving a sentinel pair where each marker was. */
function markInline(raw: string, html: boolean): string {
	return (html ? markHtml(raw) : raw)
		.replace(/`([^`]*)`/g, wrap("code"))
		.replace(/\*\*([^*]+)\*\*/g, wrap("bold"))
		.replace(/__([^_]+)__/g, wrap("bold"))
		.replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, wrap("italic"))
		.replace(/(?<![\w_])_([^_\n]+)_(?![\w_])/g, wrap("italic"))
		.replace(/==([^=]+)==/g, wrap("highlight"))
		.replace(/~~([^~]+)~~/g, wrap("strike"))
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
}

const EMPTY: InlineStyles = {};

/**
 * stripInline, plus which of the resulting words carried which style. Without
 * `html` the text is always exactly stripInline's — the layout older sends
 * replay — and when marking would change it, no word is flagged.
 */
export function stripInlineStyles(raw: string, options: ParseOptions = {}): { text: string; inline: InlineStyles } {
	const html = options.html === true;
	const legacy = stripInline(raw);
	if (!html && !/[`*_=~]/.test(raw)) return { text: legacy, inline: EMPTY };
	const marked = markInline(raw, html);
	const text = marked.replace(SENTINELS_RE, "");
	if (!html && text !== legacy) return { text: legacy, inline: EMPTY };

	const active: Record<StyleKind, number> = { code: 0, bold: 0, italic: 0, strike: 0, underline: 0, highlight: 0 };
	const colors: (string | undefined)[] = [];
	const found: Record<StyleKind, Set<number>> = {
		code: new Set(),
		bold: new Set(),
		italic: new Set(),
		strike: new Set(),
		underline: new Set(),
		highlight: new Set(),
	};
	const wordColor = new Map<number, string>();
	let token = 0;
	let inToken = false;
	const chars = [...marked];
	for (let i = 0; i < chars.length; i++) {
		const ch = chars[i];
		if (ch === COLOR) {
			let rgb = "";
			for (i++; i < chars.length && chars[i] !== COLOR; i++) rgb += chars[i];
			colors[colors.length - 1] = rgb;
			continue;
		}
		const sentinel = KIND_OF.get(ch);
		if (sentinel !== undefined) {
			active[sentinel.kind] = Math.max(0, active[sentinel.kind] + (sentinel.open ? 1 : -1));
			if (sentinel.kind === "highlight") {
				if (sentinel.open) colors.push(undefined);
				else colors.pop();
			}
			continue;
		}
		if (/\s/.test(ch)) {
			if (inToken) token++;
			inToken = false;
			continue;
		}
		inToken = true;
		for (const kind of Object.keys(active) as StyleKind[]) {
			if (active[kind] > 0) found[kind].add(token);
		}
		const rgb = colors[colors.length - 1];
		if (active.highlight > 0 && rgb !== undefined) wordColor.set(token, rgb);
	}
	const inline: InlineStyles = {};
	for (const kind of ["code", "bold", "italic", "strike", "underline"] as const) {
		if (found[kind].size > 0) inline[kind] = [...found[kind]].sort((a, b) => a - b);
	}
	if (found.highlight.size > 0) {
		inline.highlight = [...found.highlight]
			.sort((a, b) => a - b)
			.map((word) => (wordColor.has(word) ? { word, rgb: wordColor.get(word) } : { word }));
	}
	return { text, inline };
}

/** Number of whitespace-separated words, as the typesetter counts them. */
export function wordCount(text: string): number {
	return text.split(/\s+/).filter((w) => w !== "").length;
}

/** Shift every word index of `inline` by `offset`, dropping those that fall below 0. */
export function shiftInline(inline: InlineStyles | undefined, offset: number): InlineStyles {
	const out: InlineStyles = {};
	if (inline === undefined) return out;
	for (const kind of ["code", "bold", "italic", "strike", "underline"] as const) {
		const words = inline[kind]?.map((i) => i + offset).filter((i) => i >= 0);
		if (words !== undefined && words.length > 0) out[kind] = words;
	}
	const highlight = inline.highlight
		?.map((h) => ({ ...h, word: h.word + offset }))
		.filter((h) => h.word >= 0);
	if (highlight !== undefined && highlight.length > 0) out.highlight = highlight;
	return out;
}

/** Append `next` (with its styled words) to `prev`, joined by a space. */
function joinInline(
	prev: { text: string; inline: InlineStyles },
	next: { text: string; inline: InlineStyles },
): { text: string; inline: InlineStyles } {
	const shifted = shiftInline(next.inline, wordCount(prev.text));
	const inline: InlineStyles = { ...prev.inline };
	for (const kind of ["code", "bold", "italic", "strike", "underline"] as const) {
		const words = [...(prev.inline[kind] ?? []), ...(shifted[kind] ?? [])];
		if (words.length > 0) inline[kind] = words;
	}
	const highlight = [...(prev.inline.highlight ?? []), ...(shifted.highlight ?? [])];
	if (highlight.length > 0) inline.highlight = highlight;
	return { text: `${prev.text} ${next.text}`, inline };
}

function withInline<T extends object>(block: T, inline: InlineStyles): T & { inline?: InlineStyles } {
	return Object.keys(inline).length > 0 ? { ...block, inline } : block;
}

function parseTableRow(line: string, options: ParseOptions): { text: string; inline: InlineStyles }[] {
	return line
		.replace(/^\s*\|/, "")
		.replace(/\|\s*$/, "")
		.split("|")
		.map((cell) => stripInlineStyles(cell.trim(), options));
}

export function parseBlocks(markdown: string, options: ParseOptions = {}): Block[] {
	const lines = markdown.split("\n");
	const blocks: Block[] = [];
	let paragraph: string[] = [];
	let list: ListItem[] = [];
	let quote: string[] = [];
	let quoteInline: { text: string; inline: InlineStyles } | null = null;

	const flushParagraph = () => {
		if (paragraph.length > 0) {
			const raw = paragraph.join(" ").trim();
			const style = paragraphStyle(raw);
			const { text, inline } = stripInlineStyles(raw, options);
			blocks.push(
				withInline(
					style === undefined ? { type: "paragraph", text } : { type: "paragraph", text, style },
					inline,
				),
			);
			paragraph = [];
		}
	};
	const flushList = () => {
		if (list.length > 0) {
			blocks.push({ type: "list", items: list });
			list = [];
		}
	};
	const flushQuote = () => {
		if (quote.length > 0) {
			blocks.push(withInline({ type: "quote", lines: quote }, quoteInline?.inline ?? EMPTY));
			quote = [];
			quoteInline = null;
		}
	};
	const flushAll = () => {
		flushParagraph();
		flushList();
		flushQuote();
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		if (FENCE_RE.test(line.trim())) {
			flushAll();
			// Info string of the opening fence ("```mermaid" → "mermaid"),
			// kept only when present so pre-fork block shapes stay
			// byte-identical for plain fences (fork: image blocks).
			const lang = line.trim().replace(/^(?:```|~~~)/, "").trim().toLowerCase();
			const code: string[] = [];
			i++;
			while (i < lines.length && !FENCE_RE.test(lines[i].trim())) {
				code.push(lines[i]);
				i++;
			}
			blocks.push(
				lang === "" ? { type: "code", lines: code } : { type: "code", lines: code, lang },
			);
			continue;
		}

		const picture = standaloneImage(line.trim());
		if (picture !== null) {
			flushAll();
			blocks.push({ type: "imageref", target: picture.target, alt: picture.alt });
			continue;
		}

		if (line.trim() === "") {
			flushAll();
			continue;
		}

		const heading = line.match(HEADING_RE);
		if (heading) {
			flushAll();
			const { text, inline } = stripInlineStyles(heading[2].trim(), options);
			blocks.push(withInline({ type: "heading", level: heading[1].length, text }, inline));
			continue;
		}

		if (PAGEBREAK_RE.test(line.trim())) {
			flushAll();
			blocks.push({ type: "pagebreak" });
			continue;
		}

		if (HR_RE.test(line.trim()) && paragraph.length === 0) {
			flushAll();
			blocks.push({ type: "hr" });
			continue;
		}

		if (line.trimStart().startsWith(">")) {
			flushParagraph();
			flushList();
			const inner = line.replace(/^\s*>\s?/, "").trim();
			if (options.quotePictures === true && PICTURE_LINE_RE.test(inner)) {
				flushQuote();
				blocks.push({ type: "paragraph", text: stripInline(inner) });
				continue;
			}
			const part = stripInlineStyles(line.replace(/^\s*>\s?/, ""), options);
			quote.push(part.text);
			// drawQuote joins the lines with a space; the word indices follow.
			quoteInline = quoteInline === null ? part : joinInline(quoteInline, part);
			continue;
		}
		flushQuote();

		// Table: a header row directly followed by a divider row.
		if (line.includes("|") && i + 1 < lines.length && TABLE_DIVIDER_RE.test(lines[i + 1])) {
			flushAll();
			const cells = [parseTableRow(line, options)];
			i += 2;
			while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
				cells.push(parseTableRow(lines[i], options));
				i++;
			}
			i--;
			const rows = cells.map((row) => row.map((cell) => cell.text));
			const inline = cells.map((row) => row.map((cell) => (Object.keys(cell.inline).length > 0 ? cell.inline : null)));
			blocks.push(
				inline.some((row) => row.some((cell) => cell !== null))
					? { type: "table", rows, inline }
					: { type: "table", rows },
			);
			continue;
		}

		const item = line.match(LIST_RE);
		if (item) {
			flushParagraph();
			const indent = item[1].replace(/\t/g, "  ").length;
			const marker = item[2];
			const { text, inline } = stripInlineStyles(item[3].trim(), options);
			list.push(
				withInline(
					{
						depth: Math.floor(indent / 2),
						ordered: /\d/.test(marker),
						marker: marker,
						text,
					},
					inline,
				),
			);
			continue;
		}

		if (list.length > 0) {
			// Continuation line of the previous list item.
			const { inline: lastInline = EMPTY, ...last } = list[list.length - 1];
			const joined = joinInline(
				{ text: last.text, inline: lastInline },
				stripInlineStyles(line.trim(), options),
			);
			list[list.length - 1] = withInline({ ...last, text: joined.text }, joined.inline);
			continue;
		}

		paragraph.push(line.trim());
	}

	flushAll();
	return blocks;
}

/**
 * Drop a leading `# heading` that merely repeats the document title
 * (GP_E6_S6): the typesetter draws the title itself, so a note whose first
 * line is an H1 identical to its file name showed the same words twice.
 * Case- and whitespace-insensitive; anything else stays untouched.
 */
export function dropLeadingTitleHeading(blocks: Block[], title: string): Block[] {
	const first = blocks[0];
	if (
		first !== undefined &&
		first.type === "heading" &&
		first.level === 1 &&
		first.text.trim().toLowerCase() === title.trim().toLowerCase()
	) {
		return blocks.slice(1);
	}
	return blocks;
}

/**
 * Replace mermaid code blocks with image blocks, pairing by occurrence
 * order (fork: image blocks). `images` comes either from a live render at
 * send time (with PNG bytes) or from the dimensions recorded per upload at
 * import time (geometry only — the layout replay never re-renders, see
 * mapping.ts `images` and the GP_E3_S15 lesson).
 *
 * A `null` slot — a diagram that failed to render — leaves its fence as
 * the code block it is today, so failure is byte-identical to pre-fork
 * behaviour. Slots past the end of `images` do the same.
 */
export function substituteDiagrams(
	blocks: Block[],
	images: ({ w: number; h: number; png?: Uint8Array } | null)[],
): Block[] {
	let next = 0;
	return blocks.map((block) => {
		if (block.type !== "code" || block.lang !== "mermaid") return block;
		const image = images[next];
		next++;
		if (image == null || !(image.w > 0) || !(image.h > 0)) return block;
		return image.png !== undefined
			? { type: "image", w: image.w, h: image.h, png: image.png }
			: { type: "image", w: image.w, h: image.h };
	});
}

/** What an unresolved picture reads as — the pre-fork placeholder text. */
export function imagePlaceholderText(block: Block & { type: "imageref" }): string {
	const name = block.alt !== "" ? block.alt : block.target.split("/").pop() ?? block.target;
	return `[image: ${name}]`;
}

/**
 * Fill `imageref` placeholders with loaded vault images, pairing by
 * occurrence order (fork: image blocks) — the mermaid counterpart of
 * substituteDiagrams, deliberately kept as its own pass over its own kind of
 * placeholder. Two independent arrays cannot mis-pair the way one shared
 * list would when a note holds both a diagram and a picture.
 *
 * A picture that could not be loaded (missing file, a format the edge could
 * not decode, an external URL) falls back to the italic placeholder line the
 * plugin has always produced, so a broken image never renders as nothing.
 */
export function substituteVaultImages(
	blocks: Block[],
	images: ({ w: number; h: number; png?: Uint8Array } | null)[],
): Block[] {
	let next = 0;
	return blocks.map((block) => {
		if (block.type !== "imageref") return block;
		const image = images[next];
		next++;
		if (image == null || !(image.w > 0) || !(image.h > 0)) {
			return { type: "paragraph", text: imagePlaceholderText(block), style: "italic" };
		}
		return image.png !== undefined
			? { type: "image", w: image.w, h: image.h, png: image.png }
			: { type: "image", w: image.w, h: image.h };
	});
}

/** Targets of the `imageref` blocks, in the order substitution expects them. */
export function imageRefTargets(blocks: Block[]): string[] {
	return blocks
		.filter((b): b is Block & { type: "imageref" } => b.type === "imageref")
		.map((b) => b.target);
}
