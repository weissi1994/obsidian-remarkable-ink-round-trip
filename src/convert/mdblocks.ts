/**
 * Minimal markdown block parser for the PDF typesetter (PRD F3, K1).
 *
 * Consumes preprocessed markdown (see preprocess.ts) and produces a flat list
 * of typed blocks. Inline markers (bold/italic/highlight/strike/inline code)
 * are stripped to plain text: the e-ink layout deliberately favors clean,
 * predictable typography over rich inline styling in this MVP.
 */

export type Block =
	| { type: "heading"; level: number; text: string }
	| { type: "paragraph"; text: string; style?: "bold" | "italic" }
	| { type: "list"; items: ListItem[] }
	| { type: "quote"; lines: string[] }
	| { type: "code"; lines: string[]; lang?: string }
	| { type: "table"; rows: string[][] }
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
	| { type: "pagebreak" };

export interface ListItem {
	depth: number;
	ordered: boolean;
	marker: string;
	text: string;
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
	return text
		.replace(/`([^`]*)`/g, "$1")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/__([^_]+)__/g, "$1")
		.replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, "$1")
		.replace(/(?<![\w_])_([^_\n]+)_(?![\w_])/g, "$1")
		.replace(/==([^=]+)==/g, "$1")
		.replace(/~~([^~]+)~~/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
}

function parseTableRow(line: string): string[] {
	return line
		.replace(/^\s*\|/, "")
		.replace(/\|\s*$/, "")
		.split("|")
		.map((cell) => stripInline(cell.trim()));
}

export function parseBlocks(markdown: string): Block[] {
	const lines = markdown.split("\n");
	const blocks: Block[] = [];
	let paragraph: string[] = [];
	let list: ListItem[] = [];
	let quote: string[] = [];

	const flushParagraph = () => {
		if (paragraph.length > 0) {
			const raw = paragraph.join(" ").trim();
			const style = paragraphStyle(raw);
			blocks.push(
				style === undefined
					? { type: "paragraph", text: stripInline(raw) }
					: { type: "paragraph", text: stripInline(raw), style },
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
			blocks.push({ type: "quote", lines: quote });
			quote = [];
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
			blocks.push({
				type: "heading",
				level: heading[1].length,
				text: stripInline(heading[2].trim()),
			});
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
			quote.push(stripInline(line.replace(/^\s*>\s?/, "")));
			continue;
		}
		flushQuote();

		// Table: a header row directly followed by a divider row.
		if (line.includes("|") && i + 1 < lines.length && TABLE_DIVIDER_RE.test(lines[i + 1])) {
			flushAll();
			const rows: string[][] = [parseTableRow(line)];
			i += 2;
			while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
				rows.push(parseTableRow(lines[i]));
				i++;
			}
			i--;
			blocks.push({ type: "table", rows });
			continue;
		}

		const item = line.match(LIST_RE);
		if (item) {
			flushParagraph();
			const indent = item[1].replace(/\t/g, "  ").length;
			const marker = item[2];
			list.push({
				depth: Math.floor(indent / 2),
				ordered: /\d/.test(marker),
				marker: marker,
				text: stripInline(item[3].trim()),
			});
			continue;
		}

		if (list.length > 0) {
			// Continuation line of the previous list item.
			list[list.length - 1].text += ` ${stripInline(line.trim())}`;
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
