// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installDomHelpers } from "./helpers/obsidian";
import type { InkStrokes } from "../ink/inkimage";

/*
 * The reading-view glue of the remark overlay: which sections get the faded
 * ink, and that it goes once the remark is confirmed or the setting is off.
 * Placement itself is tested in remarkoverlay.test.ts; the DOM here has no
 * layout, so the measurements are stubbed.
 */

beforeAll(() => installDomHelpers());

const ROW = "The quick brown fox jumps over the lazy dog.";
const note = (title: string) =>
	[ROW, "", `> [!note] ${title}`, "> lazy dog", "> ![[img/doc-p01-aaaa.png]]", "> ^ink-aaaa"].join("\n");

const INK: InkStrokes = {
	kind: "strokes",
	sourceWidth: 40,
	sourceHeight: 20,
	width: 94,
	height: 47,
	strokes: [],
	// Written in the right margin, a little above the row's baseline.
	at: { text: "The quick brown fox jumps over", x: 410, below: -6 },
};

const LAYOUT = { pageWidth: 447, margin: 40, fontSize: 11, lineHeight: 1.5 };

function rect(left: number, top: number, width: number, height: number): DOMRect {
	return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) };
}

async function setUp(initial: string, enabled = true) {
	const { RemarkOverlays } = await import("../remarkoverlayui");
	let text = initial;
	let on = enabled;
	const file = { path: "N.md", name: "N.md", extension: "md" };
	const image = { path: "img/doc-p01-aaaa.png", name: "doc-p01-aaaa.png", stat: { mtime: 1 } };
	const app = {
		vault: {
			getFileByPath: () => file,
			cachedRead: async () => text,
			getResourcePath: () => "app://ink.png",
		},
		metadataCache: { getFirstLinkpathDest: () => image },
		workspace: { updateOptions: () => {}, getLeavesOfType: () => [] },
	};
	const readInk = vi.fn(async () => INK);
	const overlays = new RemarkOverlays(app as never, { enabled: () => on, readInk, layoutFor: () => LAYOUT });
	const view = document.body.createDiv({ cls: "markdown-preview-view" });
	const section = view.createDiv();
	section.createEl("p", { text: ROW });
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
		return this === section ? rect(100, 200, 734, 40) : rect(0, 0, 1000, 800);
	});
	vi.spyOn(Range.prototype, "getClientRects").mockImplementation(() => [rect(100, 210, 30, 20)] as unknown as DOMRectList);
	const children: { unload(): void }[] = [];
	const ctx = {
		sourcePath: "N.md",
		getSectionInfo: () => ({ lineStart: 0, lineEnd: 0, text }),
		addChild: (child: { load(): void; unload(): void }) => {
			children.push(child);
			child.load();
		},
	};
	await overlays.process(section, ctx as never);
	return {
		overlays,
		section,
		children,
		readInk,
		file,
		setNote: (next: string) => (text = next),
		setEnabled: (next: boolean) => (on = next),
	};
}

const drawn = (el: HTMLElement) => el.querySelectorAll<HTMLImageElement>(".remarkable-ink-remark-overlay");

afterEach(() => {
	vi.restoreAllMocks();
	document.body.replaceChildren();
});

describe("remark overlay in reading view", () => {
	it("draws an unconfirmed remark's ink over the row it was written against", async () => {
		const { section } = await setUp(note("Remark"));
		await vi.waitFor(() => expect(drawn(section)).toHaveLength(1));
		const img = drawn(section)[0];
		expect(img.getAttribute("src")).toBe("app://ink.png");
		expect(section.classList.contains("remarkable-ink-remark-overlay-host")).toBe(true);
		// Written in the right margin: on the right half of the column.
		const left = Number.parseFloat(img.style.getPropertyValue("--remarkable-ink-overlay-left"));
		expect(left).toBeGreaterThan(734 / 2);
		// Near the row: its baseline is 26 px into the section.
		const top = Number.parseFloat(img.style.getPropertyValue("--remarkable-ink-overlay-top"));
		expect(Math.abs(top - 26)).toBeLessThan(40);
	});

	it("draws nothing for a confirmed remark", async () => {
		const { section, children } = await setUp(note("Remark ✓"));
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(children).toHaveLength(0);
		expect(drawn(section)).toHaveLength(0);
	});

	it("takes the ink away once the remark is confirmed", async () => {
		const { section, overlays, file, setNote } = await setUp(note("Remark"));
		await vi.waitFor(() => expect(drawn(section)).toHaveLength(1));
		setNote(note("Remark ✓"));
		overlays.changed(file as never);
		await vi.waitFor(() => expect(drawn(section)).toHaveLength(0));
		expect(section.classList.contains("remarkable-ink-remark-overlay-host")).toBe(false);
	});

	it("takes the ink away when the setting is turned off, and draws nothing while it is", async () => {
		const first = await setUp(note("Remark"));
		await vi.waitFor(() => expect(drawn(first.section)).toHaveLength(1));
		first.setEnabled(false);
		first.overlays.sync();
		await vi.waitFor(() => expect(drawn(first.section)).toHaveLength(0));

		const off = await setUp(note("Remark"), false);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(off.children).toHaveLength(0);
		expect(off.readInk).not.toHaveBeenCalled();
	});

	it("leaves notes without remarks alone", async () => {
		const { section, children, readInk } = await setUp(`${ROW}\n\nJust a note.`);
		expect(children).toHaveLength(0);
		expect(readInk).not.toHaveBeenCalled();
		expect(drawn(section)).toHaveLength(0);
	});

	it("draws nothing when the row is no longer in the note", async () => {
		const { section } = await setUp(note("Remark").replace(ROW, "Something else entirely."));
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(drawn(section)).toHaveLength(0);
	});
});
