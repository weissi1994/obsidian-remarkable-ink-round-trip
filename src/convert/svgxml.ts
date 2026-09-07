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
