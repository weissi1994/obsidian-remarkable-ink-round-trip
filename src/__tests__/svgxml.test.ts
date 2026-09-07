import { describe, expect, it } from "vitest";
import { selfCloseVoidTags } from "../convert/svgxml";

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
