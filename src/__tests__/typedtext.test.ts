import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseRmScene, type TextSpan, type TypedParagraph } from "../incoming/rmscene";
import { typedTextToMarkdown } from "../incoming/typedtext";
import { markdownToTypedText, parseInlineMarkdown } from "../ink/roottext";

const fixtureText = (name: string) =>
	parseRmScene(new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))))).text!;

const span = (text: string, bold = false, italic = false): TextSpan => ({ text, bold, italic });

describe("typedTextToMarkdown", () => {
	it("maps the tablet's paragraph styles to markdown lines", () => {
		expect(typedTextToMarkdown(fixtureText("text-bold-heading-bullet.rm").paragraphs)).toBe(
			"## A\n# new line\n- B is a letter of the alphabet\nC",
		);
	});

	it("writes inline bold and italic the tablet recorded", () => {
		expect(typedTextToMarkdown(fixtureText("text-inline-formats.rm").paragraphs)).toBe(
			[
				"A",
				"v3.2.2",
				"Normal **bold** *italic*",
				"**Bold** *italic* normal",
				"## Bold line",
				"Normal line",
				"# Heading line",
			].join("\n"),
		);
	});

	it("maps bullets, second-level bullets and checkboxes", () => {
		const paragraphs: TypedParagraph[] = [
			{ style: "bullet", spans: [span("one")] },
			{ style: "bullet2", spans: [span("two")] },
			{ style: "checkbox", spans: [span("open")] },
			{ style: "checkbox-checked", spans: [span("done")] },
			{ style: "basic", spans: [span("basic")] },
		];
		expect(typedTextToMarkdown(paragraphs)).toBe("- one\n\t- two\n- [ ] open\n- [x] done\nbasic");
	});

	it("keeps emphasis markers against the text, so they still mean emphasis", () => {
		const paragraphs: TypedParagraph[] = [
			{ style: "plain", spans: [span("a "), span("bold ", true), span("word")] },
			{ style: "plain", spans: [span(" both ", true, true)] },
		];
		expect(typedTextToMarkdown(paragraphs)).toBe("a **bold** word\n ***both*** ");
	});

	it("nests overlapping bold and italic instead of closing and reopening", () => {
		const paragraphs: TypedParagraph[] = [
			{ style: "plain", spans: [span("bold ", true), span("both", true, true), span(" bold", true), span(" end")] },
			{ style: "plain", spans: [span("both", true, true), span(" italic", false, true)] },
		];
		expect(typedTextToMarkdown(paragraphs)).toBe("**bold *both* bold** end\n***both** italic*");
	});

	it("leaves typed asterisks alone unless they would read as emphasis", () => {
		const md = typedTextToMarkdown([
			{ style: "plain", spans: [span("2 * 3 = 6")] },
			{ style: "plain", spans: [span("*not italic*")] },
			{ style: "plain", spans: [span("**", true)] },
		]);
		expect(md).toBe("2 * 3 = 6\n\\*not italic\\*\n**\\*\\***");
		expect(markdownToTypedText(md)).toEqual([
			{ style: "plain", spans: [span("2 * 3 = 6")] },
			{ style: "plain", spans: [span("*not italic*")] },
			{ style: "plain", spans: [span("**", true)] },
		]);
	});

	it("escapes plain paragraphs that would read as a styled line", () => {
		const paragraphs: TypedParagraph[] = [
			{ style: "plain", spans: [span("- not a list")] },
			{ style: "plain", spans: [span("# not a heading")] },
			{ style: "plain", spans: [span("\\- typed backslash")] },
			{ style: "plain", spans: [span("#hashtag")] },
		];
		const md = typedTextToMarkdown(paragraphs);
		expect(md).toBe("\\- not a list\n\\# not a heading\n\\\\- typed backslash\n#hashtag");
		expect(markdownToTypedText(md)).toEqual(paragraphs);
	});

	it("never loses or invents text, whatever was typed", () => {
		const random = seeded(7);
		const alphabet = ["a", "b", " ", "*", "-", "#", "\\", "["];
		for (let round = 0; round < 2000; round++) {
			const spans: TextSpan[] = [];
			for (let i = 0, count = 1 + Math.floor(random() * 4); i < count; i++) {
				let text = "";
				for (let k = 0, length = 1 + Math.floor(random() * 5); k < length; k++) {
					text += alphabet[Math.floor(random() * alphabet.length)];
				}
				spans.push(span(text, random() < 0.4, random() < 0.4));
			}
			const style = random() < 0.5 ? "plain" : "bullet";
			const md = typedTextToMarkdown([{ style, spans }]);
			const back = markdownToTypedText(md);
			expect(back.map((p) => p.style)).toEqual([style]);
			expect(back[0].spans.map((s) => s.text).join("")).toBe(spans.map((s) => s.text).join(""));
			// Whatever emphasis markdown could not carry, the next sync sees no change.
			expect(typedTextToMarkdown(back)).toBe(md);
		}
	});

	it("keeps the emphasis of whole words, next to punctuation, emoji and asterisks", () => {
		const random = seeded(11);
		const words = ["milk", "x*y", "C:\\dir", "(note)", "end.", "a,", "#tag", "–", "café", "🙂"];
		for (let round = 0; round < 2000; round++) {
			const spans: TextSpan[] = [];
			for (let i = 0, count = 1 + Math.floor(random() * 6); i < count; i++) {
				const word = words[Math.floor(random() * words.length)];
				spans.push(span(`${i > 0 ? " " : ""}${word}`, random() < 0.3, random() < 0.3));
			}
			const [back] = markdownToTypedText(typedTextToMarkdown([{ style: "plain", spans }]));
			expect(visible(back.spans)).toEqual(visible(spans));
		}
	});
});

function seeded(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state * 1103515245 + 12345) % 2 ** 31;
		return state / 2 ** 31;
	};
}

/** Each character with its emphasis, whitespace counted as plain: emphasis on it does not show. */
function visible(spans: TextSpan[]): string[] {
	return spans.flatMap((s) =>
		Array.from(s.text, (char) => (/\s/.test(char) ? char : `${char}${s.bold ? "B" : ""}${s.italic ? "I" : ""}`)),
	);
}

describe("markdownToTypedText", () => {
	it("maps the subset the tablet can style, one paragraph per line", () => {
		expect(
			markdownToTypedText("# Title\n## Sub\n- item\n\t- sub item\n- [ ] todo\n- [x] done\n\nplain"),
		).toEqual([
			{ style: "heading", spans: [span("Title")] },
			{ style: "bold", spans: [span("Sub")] },
			{ style: "bullet", spans: [span("item")] },
			{ style: "bullet2", spans: [span("sub item")] },
			{ style: "checkbox", spans: [span("todo")] },
			{ style: "checkbox-checked", spans: [span("done")] },
			{ style: "plain", spans: [] },
			{ style: "plain", spans: [span("plain")] },
		]);
	});

	it("keeps what the tablet cannot style as literal text, so it comes back unchanged", () => {
		const md = "### Deep heading\n1. numbered\n* star bullet\n> quote\n`code` and _under_";
		const paragraphs = markdownToTypedText(md);
		expect(paragraphs.every((p) => p.style === "plain")).toBe(true);
		expect(typedTextToMarkdown(paragraphs)).toBe(md);
	});

	it("drops the carriage return of CRLF lines", () => {
		expect(markdownToTypedText("# a\r\nb\r")).toEqual([
			{ style: "heading", spans: [span("a")] },
			{ style: "plain", spans: [span("b")] },
		]);
	});

	it("comes back as the same markdown after a trip through typed text", () => {
		const md = [
			"# Shopping",
			"Buy **milk**, *eggs* and ***bread***.",
			"",
			"## Errands",
			"- post **office**",
			"\t- stamps (2 * 3)",
			"- [ ] call *Anna*",
			"- [x] book flights",
			"**bold *nested* bold** after",
			"*italic **nested** italic*",
			"café ✓ 🙂",
			"",
		].join("\n");
		expect(typedTextToMarkdown(markdownToTypedText(md))).toBe(md);
	});
});

describe("parseInlineMarkdown", () => {
	it.each([
		["**a*b*c**", [span("a", true), span("b", true, true), span("c", true)]],
		["*a **b** c*", [span("a ", false, true), span("b", true, true), span(" c", false, true)]],
		["***both***", [span("both", true, true)]],
		["a * b * c", [span("a * b * c")]],
		["** not bold**", [span("** not bold**")]],
		["2*3*4", [span("2"), span("3", false, true), span("4")]],
		["\\*x\\*", [span("*x*")]],
		["**unclosed", [span("**unclosed")]],
		["snake_case __x__", [span("snake_case __x__")]],
		["**a***b*", [span("a", true), span("b", false, true)]],
	])("reads %s as Obsidian does", (text, spans) => {
		expect(parseInlineMarkdown(text)).toEqual(spans);
	});
});
