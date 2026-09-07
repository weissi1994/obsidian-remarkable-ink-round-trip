/**
 * Making a serialised SVG safe to load through <img> (fork: image blocks).
 *
 * Pure string work, deliberately kept out of mermaid.ts: that module imports
 * "obsidian" (a types-only package at test time) and touches the DOM, so
 * nothing there is unit-testable. This is the part worth testing.
 *
 * Mermaid renders flowchart labels as HTML inside <foreignObject>, so a
 * `<br/>` in a node label reaches the serialised SVG as a bare `<br>`. An
 * SVG loaded through <img> is parsed as XML, where one unclosed void tag is
 * fatal: the parse fails, `onerror` fires, and the diagram silently degrades
 * to a code block. Measured on a real 40-line flowchart: 24 bare tags and a
 * failed parse; with them self-closed it parses.
 *
 * Setting flowchart.htmlLabels=false does NOT fix this — it halves the
 * foreignObjects and leaves every `<br>` in place — so the repair belongs
 * at this boundary, where it holds for whatever mermaid version Obsidian
 * happens to bundle.
 */

/** HTML void elements: legal unclosed in HTML, fatal in XML. */
const VOID_TAGS = "area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr";

/**
 * A void tag that is not already self-closed. The lookbehind keeps `<br/>`
 * untouched so the transform is idempotent.
 */
const VOID_TAG_RE = new RegExp(`<(${VOID_TAGS})((?:\\s[^>]*?)?)\\s*(?<!/)>`, "gi");

/** Self-close bare HTML void tags so the SVG parses as XML. */
export function selfCloseVoidTags(svg: string): string {
	return svg.replace(VOID_TAG_RE, (_all, tag: string, attrs: string) => `<${tag}${attrs}/>`);
}

/** Intrinsic pixel size of a rendered SVG. */
export interface SvgSize {
	widthPx: number;
	heightPx: number;
}

const VIEWBOX_RE = /\bviewBox\s*=\s*"([^"]+)"/;
const WIDTH_RE = /\bwidth\s*=\s*"([^"]+)"/;
const HEIGHT_RE = /\bheight\s*=\s*"([^"]+)"/;
const MAX_WIDTH_RE = /\bmax-width\s*:\s*([0-9.]+)px/;

/** A length in px, ignoring percentages and other relative units. */
function absoluteLength(raw: string | undefined): number | null {
	if (raw === undefined) return null;
	const value = raw.trim();
	if (value.endsWith("%")) return null;
	const match = value.match(/^([0-9.]+)\s*(px|pt)?$/);
	if (match === null) return null;
	const n = Number(match[1]);
	if (!(n > 0)) return null;
	return match[2] === "pt" ? n * (96 / 72) : n;
}

/**
 * Read an SVG's intrinsic size straight out of the markup, or null when it
 * carries none.
 *
 * Deliberately string-based rather than DOMParser-based. The old reader
 * parsed the SVG as XML and read attributes off `documentElement` — but on a
 * parse failure that element IS the `<parsererror>`, which has no viewBox, so
 * every malformed SVG reported "carries no usable size" and hid the real
 * cause. Reading the text avoids the parser, so a broken diagram fails at
 * decode time with a decode error, where it belongs.
 *
 * `width="100%"` is what mermaid emits alongside a viewBox, so a relative
 * length is ignored rather than treated as a size.
 */
export function parseSvgSize(svg: string): SvgSize | null {
	const head = svg.slice(0, 2000);

	const viewBox = head.match(VIEWBOX_RE);
	if (viewBox !== null) {
		const parts = viewBox[1].trim().split(/[\s,]+/).map(Number);
		if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
			return { widthPx: parts[2], heightPx: parts[3] };
		}
	}

	const width = absoluteLength(head.match(WIDTH_RE)?.[1]);
	const height = absoluteLength(head.match(HEIGHT_RE)?.[1]);
	if (width !== null && height !== null) return { widthPx: width, heightPx: height };

	// Mermaid's own "max-width: Xpx" plus the height attribute is enough.
	const maxWidth = head.match(MAX_WIDTH_RE);
	if (maxWidth !== null && height !== null) {
		const n = Number(maxWidth[1]);
		if (n > 0) return { widthPx: n, heightPx: height };
	}

	return null;
}

/** The root <svg …> tag, for saying what a sizeless SVG actually carried. */
export function describeSvgRoot(svg: string): string {
	const root = svg.slice(0, 2000).match(/<svg\b[^>]*>/);
	return root === null ? "<no <svg> tag found>" : root[0].slice(0, 300);
}
