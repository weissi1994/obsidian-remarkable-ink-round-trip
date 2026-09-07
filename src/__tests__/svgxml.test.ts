import { describe, expect, it } from "vitest";
import { describeSvgRoot, parseSvgSize, selfCloseVoidTags } from "../convert/svgxml";

describe("selfCloseVoidTags", () => {
	it("self-closes a bare br so the svg parses as XML", () => {
		expect(selfCloseVoidTags("<div>a<br>b</div>")).toBe("<div>a<br/>b</div>");
	});

	it("leaves an already self-closed tag alone (idempotent)", () => {
		const once = selfCloseVoidTags("<div>a<br>b</div>");
		expect(selfCloseVoidTags(once)).toBe(once);
		expect(selfCloseVoidTags("<br/>")).toBe("<br/>");
		expect(selfCloseVoidTags("<br />")).toBe("<br />");
	});

	it("keeps attributes, including ones ending in a slash", () => {
		expect(selfCloseVoidTags('<img src="a.png" alt="x">')).toBe(
			'<img src="a.png" alt="x"/>',
		);
		expect(selfCloseVoidTags('<img src="http://x/">')).toBe('<img src="http://x/"/>');
	});

	it("handles every void tag, in either case", () => {
		expect(selfCloseVoidTags("<HR><wbr><col>")).toBe("<HR/><wbr/><col/>");
	});

	it("never touches non-void elements", () => {
		const svg = "<text>a</text><tspan>b</tspan><foreignObject><div>c</div></foreignObject>";
		expect(selfCloseVoidTags(svg)).toBe(svg);
	});

	it("does not mangle a tag whose name merely starts with a void name", () => {
		// "<break>" and "<inputs>" are not void tags; a sloppy pattern eats them.
		const svg = "<break>x</break><inputs>y</inputs>";
		expect(selfCloseVoidTags(svg)).toBe(svg);
	});

	it("fixes the shape mermaid actually emits for a multi-line label", () => {
		const label =
			'<foreignObject width="120" height="40">' +
			'<div xmlns="http://www.w3.org/1999/xhtml"><span class="nodeLabel">' +
			"flake inputs<br>38 direct / 90 locked</span></div></foreignObject>";
		expect(selfCloseVoidTags(label)).toContain("<br/>");
		expect(selfCloseVoidTags(label)).not.toMatch(/<br(?![^>]*\/>)[^>]*>/);
	});
});

describe("parseSvgSize", () => {
	it("prefers the viewBox", () => {
		expect(parseSvgSize('<svg viewBox="0 0 1153.8 1480" width="100%">')).toEqual({
			widthPx: 1153.8,
			heightPx: 1480,
		});
	});

	it("accepts a comma-separated viewBox", () => {
		expect(parseSvgSize('<svg viewBox="0,0,300,200">')).toEqual({
			widthPx: 300,
			heightPx: 200,
		});
	});

	it("ignores a percentage width — mermaid's default — rather than sizing from it", () => {
		// The old reader treated width="100%" as parseFloat 100, silently
		// rasterising a whole flowchart into a 100px box.
		expect(parseSvgSize('<svg width="100%" height="100%">')).toBeNull();
	});

	it("falls back to absolute width and height", () => {
		expect(parseSvgSize('<svg width="420" height="260">')).toEqual({
			widthPx: 420,
			heightPx: 260,
		});
		expect(parseSvgSize('<svg width="420px" height="260px">')).toEqual({
			widthPx: 420,
			heightPx: 260,
		});
	});

	it("converts points to pixels", () => {
		expect(parseSvgSize('<svg width="72pt" height="144pt">')).toEqual({
			widthPx: 96,
			heightPx: 192,
		});
	});

	it("uses mermaid's style max-width when only the height is absolute", () => {
		expect(
			parseSvgSize('<svg width="100%" height="480" style="max-width: 640px;">'),
		).toEqual({ widthPx: 640, heightPx: 480 });
	});

	it("returns null when there is nothing usable, so the caller can fall back", () => {
		expect(parseSvgSize("<svg>")).toBeNull();
		expect(parseSvgSize('<svg viewBox="0 0 0 0">')).toBeNull();
		expect(parseSvgSize('<svg viewBox="bad">')).toBeNull();
	});

	it("is not fooled by a viewBox further inside the document", () => {
		const svg = '<svg width="200" height="100"><symbol viewBox="0 0 9 9"/></svg>';
		expect(parseSvgSize(svg)).toEqual({ widthPx: 200, heightPx: 100 });
	});
});

describe("describeSvgRoot", () => {
	it("quotes the root tag so a sizeless SVG can be diagnosed", () => {
		expect(describeSvgRoot('<svg id="x" width="100%">body</svg>')).toBe(
			'<svg id="x" width="100%">',
		);
	});

	it("says so when there is no svg tag at all", () => {
		expect(describeSvgRoot("<parsererror>boom</parsererror>")).toContain("no <svg>");
	});
});
