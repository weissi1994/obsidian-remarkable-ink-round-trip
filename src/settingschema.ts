/**
 * What the settings screen contains, as data (GP_E4_S3).
 *
 * Obsidian 1.13's declarative settings API renders this and indexes it for
 * the settings search. The screen-as-data survived the deletion of the
 * pre-1.13 imperative renderer (GP_E5_S8, minAppVersion 1.13.0): one
 * description remains the single source for rendering, search and the
 * schema tests.
 *
 * Deliberately free of any Obsidian import, so the description stays testable
 * and cannot pick up a dependency on the renderer it feeds.
 */

import { MARK_STYLE_LABELS } from "./incoming/markstyles";
import type { DeviceModel, HeadingBreak, InkDevice, LayoutPreset } from "./settingsmodel";
import { BUILTIN_FONTS } from "./ink/glyphs";

/** GP_E6_S2: which screen the PDF page is sized for. Typed against the
 * model union so a new DeviceModel without a label is a compile error. */
export const DEVICE_MODEL_LABELS: Record<DeviceModel, string> = {
	rm2: "reMarkable 1 / 2 / Paper Pure",
	paperpro: "reMarkable Paper Pro",
};

/** Ink fork: canvases a handwritten notebook can be written for. */
export const INK_DEVICE_LABELS: Record<InkDevice, string> = {
	auto: "Same as the reMarkable model above",
	rm2: "reMarkable 1 / 2 / Paper Pure (1404×1872)",
	paperpro: "reMarkable Paper Pro (1620×2160)",
	move: "reMarkable Paper Pro Move (954×1696)",
	custom: "Detected / custom (see “Detect page size”)",
};

/** Ink fork: what the generated handwriting is written in. */
export const INK_FONT_LABELS: Record<string, string> = {
	...Object.fromEntries(BUILTIN_FONTS.map((font) => [font.id, font.label])),
	hand: "My handwriting (learned from the sheet)",
};

export const INK_FALLBACK_LABELS: Record<string, string> = Object.fromEntries(
	BUILTIN_FONTS.map((font) => [font.id, font.label]),
);

/** GP_E6_S4: automatic page breaks before headings; GP_E6_S9 adds smart. */
export const HEADING_BREAK_LABELS: Record<HeadingBreak, string> = {
	smart: "Smart — new page only when a section won't fit (recommended)",
	off: "Off — only at \\pagebreak markers",
	h1: "Before # headings",
	h2: "Before # and ## headings",
};

/** GP_E6_S3: named typography bundles; custom exposes the sliders. */
export const LAYOUT_PRESET_LABELS: Record<LayoutPreset, string> = {
	readable: "Easy reading — larger type, roomy lines",
	form: "Fill-in form — balanced, with writing space",
	compact: "Compact — as much on a page as fits",
	custom: "Custom — use the sliders below",
};

export type ControlSpec =
	| { type: "toggle" }
	| { type: "dropdown"; options: Record<string, string> }
	| { type: "text"; placeholder?: string; sanitise?: "path" | "url" }
	| { type: "slider"; min: number; max: number; step: number };

/** Show this setting only when another one has a given value (or one of several). */
export interface VisibleWhen {
	key: string;
	equals?: unknown;
	/** Ink fork: any of these values. */
	in?: unknown[];
}

export interface SettingSpec {
	/** Dotted path into the settings object, e.g. `markStyles.circle`. */
	key: string;
	name: string;
	desc: string;
	control: ControlSpec;
	/** One condition, or several that must ALL hold (GP_E6_S3). */
	visibleWhen?: VisibleWhen | VisibleWhen[];
	/**
	 * Changing this reveals or hides other settings, so the tab has to be
	 * drawn again.
	 */
	refresh?: boolean;
}

export interface SectionSpec {
	heading: string;
	/** A line under the heading, before the first setting. */
	note?: string;
	items: SettingSpec[];
}

/** Read a dotted key out of a settings object. */
export function readSetting(settings: unknown, key: string): unknown {
	return key.split(".").reduce<unknown>((value, part) => {
		if (typeof value !== "object" || value === null) return undefined;
		return (value as Record<string, unknown>)[part];
	}, settings);
}

/** Write a dotted key, copying the objects along the path rather than mutating. */
export function writeSetting<T>(settings: T, key: string, value: unknown): T {
	const [head, ...rest] = key.split(".");
	if (rest.length === 0) return { ...settings, [head]: value };
	const nested = (settings as Record<string, unknown>)[head];
	return {
		...settings,
		[head]: writeSetting(nested as Record<string, unknown>, rest.join("."), value),
	};
}

/** The visibility conditions of a setting, normalised to a list. */
export function conditionsOf(spec: SettingSpec): VisibleWhen[] {
	if (spec.visibleWhen === undefined) return [];
	return Array.isArray(spec.visibleWhen) ? spec.visibleWhen : [spec.visibleWhen];
}

/**
 * The slider bounds of a schema entry; the layout modal (GP_E6_S10) reuses
 * them so bounds are never redeclared. Throws on a non-slider key — covered
 * by a test so a schema rename cannot silently strand the modal.
 */
export function sliderSpec(key: string): { min: number; max: number; step: number } {
	for (const section of SETTING_SECTIONS) {
		for (const item of section.items) {
			if (item.key === key && item.control.type === "slider") return item.control;
		}
	}
	throw new Error(`No slider spec for "${key}" in the settings schema.`);
}

/** Is this setting shown, given the current values? */
export function isVisible(spec: SettingSpec, settings: unknown): boolean {
	return conditionsOf(spec).every((c) => {
		const value = readSetting(settings, c.key);
		return c.in !== undefined ? c.in.includes(value) : value === c.equals;
	});
}

/** Trim a vault or device folder path to the form the plugin stores. */
export function cleanPath(value: string): string {
	return value.trim().replace(/^\/+|\/+$/g, "");
}

/**
 * A typo in the endpoint would otherwise surface as a vague network error at
 * send time. http is allowed (a LAN rmfakecloud) but https is the default.
 */
export function checkEndpoint(value: string): string | undefined {
	const url = value.trim();
	if (url !== "" && !/^https?:\/\//i.test(url)) {
		return "Endpoint URL must start with https:// (or http:// for LAN).";
	}
	return undefined;
}

export const SETTING_SECTIONS: SectionSpec[] = [
	{
		heading: "Connection",
		items: [
			{
				key: "useCustomEndpoint",
				name: "Self-hosted endpoint (rmfakecloud)",
				desc:
					"Send documents to a self-hosted rmfakecloud server instead of the " +
					"official reMarkable cloud.",
				control: { type: "toggle" },
				refresh: true,
			},
			{
				key: "customEndpointUrl",
				name: "rmfakecloud URL",
				desc: "Base URL of the self-hosted server, e.g. https://rm.example.org",
				control: { type: "text", placeholder: "https://rm.example.org", sanitise: "url" },
				visibleWhen: { key: "useCustomEndpoint", equals: true },
			},
		],
	},
	{
		heading: "Document format",
		items: [
			{
				key: "outputFormat",
				name: "Send notes as",
				desc:
					"PDF keeps a fixed page layout, which is what annotations anchor to — " +
					"the right choice if you plan to write on the document. EPUB reflows, " +
					"so the device picks the font size and it handles non-Latin scripts " +
					"better; best for reading only.",
				control: {
					type: "dropdown",
					options: {
						pdf: "PDF — fixed layout, best for annotating",
						epub: "EPUB — reflowable, best for reading",
						ink: "Handwriting — real pen strokes you can erase, move and annotate",
					},
				},
				refresh: true,
			},
		],
	},
	{
		// Typography only shapes the PDF; an EPUB is laid out by the reader, so
		// showing these there would promise control the plugin does not have.
		heading: "Page layout",
		items: [
			{
				key: "deviceModel",
				name: "reMarkable model",
				desc:
					"Pages are sized to this screen, so what you send fills the " +
					"device exactly. The reMarkable 1, 2 and Paper Pure share a screen.",
				control: { type: "dropdown", options: DEVICE_MODEL_LABELS },
				visibleWhen: { key: "outputFormat", equals: "pdf" },
			},
			{
				key: "pageBreakAtHeading",
				name: "Start a new page at headings",
				desc:
					"Smart measures each # or ## section and turns the page only " +
					"when it would be split; the level options always break " +
					"there — a weekly log with a heading per day gets each day " +
					"on its own page. A \\pagebreak line works everywhere, " +
					"whatever this says.",
				control: { type: "dropdown", options: HEADING_BREAK_LABELS },
				visibleWhen: { key: "outputFormat", in: ["pdf", "ink"] },
			},
			{
				key: "layoutPreset",
				name: "Layout",
				desc:
					"What the page is for. Each choice sets type size, line spacing " +
					"and margins; pick Custom to use the sliders yourself.",
				control: { type: "dropdown", options: LAYOUT_PRESET_LABELS },
				visibleWhen: { key: "outputFormat", in: ["pdf", "ink"] },
				refresh: true,
			},
			{
				key: "fontSize",
				name: "Font size",
				desc: "Body text size in points (headings scale along).",
				control: { type: "slider", min: 9, max: 14, step: 0.5 },
				visibleWhen: [
					{ key: "outputFormat", in: ["pdf", "ink"] },
					{ key: "layoutPreset", equals: "custom" },
				],
			},
			{
				key: "lineHeight",
				name: "Line spacing",
				desc: "Line height as a multiple of the font size; roomier reads better on e-ink.",
				control: { type: "slider", min: 1.2, max: 1.9, step: 0.1 },
				visibleWhen: [
					{ key: "outputFormat", in: ["pdf", "ink"] },
					{ key: "layoutPreset", equals: "custom" },
				],
			},
			{
				key: "margin",
				name: "Page margin",
				desc: "Margin in points around the text — also your annotation space.",
				control: { type: "slider", min: 24, max: 64, step: 4 },
				visibleWhen: [
					{ key: "outputFormat", in: ["pdf", "ink"] },
					{ key: "layoutPreset", equals: "custom" },
				],
			},
		],
	},
	{
		heading: "Handwriting",
		note:
			"Notes sent as handwriting arrive as real pen strokes in a notebook: erase " +
			"a word or move it with the lasso, write between the lines, and the import " +
			"brings it all back into the note. Applies to “Send … as handwriting” and " +
			"to every send when Send notes as is Handwriting.",
		items: [
			{
				key: "inkDevice",
				name: "Notebook page size",
				desc:
					"The canvas the notebook is written for. Not sure? Run “Detect " +
					"reMarkable page size from my notebooks” — it reads the size from a " +
					"notebook you made on the tablet.",
				control: { type: "dropdown", options: INK_DEVICE_LABELS },
			},
			{
				key: "inkFont",
				name: "Write in",
				desc:
					"A built-in single-line font, or your own handwriting once you have " +
					"filled in the handwriting sheet (see the buttons further down).",
				control: { type: "dropdown", options: INK_FONT_LABELS },
				refresh: true,
			},
			{
				key: "inkFallbackFont",
				name: "Fallback for missing characters",
				desc: "Characters you did not write on the sheet are written in this font.",
				control: { type: "dropdown", options: INK_FALLBACK_LABELS },
				visibleWhen: { key: "inkFont", equals: "hand" },
			},
			{
				key: "inkPen",
				name: "Pen width",
				desc: "Fineliner strokes, at the device's own thin, medium or thick setting.",
				control: {
					type: "dropdown",
					options: { fine: "Fine", medium: "Medium", bold: "Bold" },
				},
			},
			{
				key: "inkColor",
				name: "Ink colour",
				desc: "Colour shows on the Paper Pro and Move; other models render it as black.",
				control: {
					type: "dropdown",
					options: { "0": "Black", "6": "Blue", "7": "Red", "4": "Green" },
				},
			},
			{
				key: "inkJitter",
				name: "Hand-made look",
				desc:
					"0 writes every letter identically; higher values let baseline and " +
					"size wander a little, like real writing. Never enough to confuse " +
					"the mark reading.",
				control: { type: "slider", min: 0, max: 1, step: 0.1 },
			},
			{
				key: "inkImages",
				name: "Pictures",
				desc:
					"Embedded images, redrawn as hatching with the tablet's own inks. " +
					"Coloured hatch uses blue, red, green, yellow and pink on the Paper " +
					"Pro and Move (other models show it in grey); grey hatch draws " +
					"tone only. Placeholder keeps the upstream “[image: …]” line.",
				control: {
					type: "dropdown",
					options: {
						"colour-hatch": "Coloured hatch",
						"mono-hatch": "Grey hatch",
						placeholder: "Placeholder text",
					},
				},
			},
			{
				key: "inkDiagrams",
				name: "Mermaid diagrams",
				desc:
					"Drawn by hand: each ```mermaid block is rendered, then traced into " +
					"pen strokes — wobbly lines, labels in your handwriting, coloured " +
					"areas hatched like pictures. As code: the source is written out.",
				control: {
					type: "dropdown",
					options: { handwritten: "Drawn by hand", code: "As code" },
				},
			},
			{
				key: "erasedAs",
				name: "A word you erase on the tablet becomes",
				desc:
					"Removed from the annotated copy, or kept there struck through so " +
					"you can still see what went.",
				control: {
					type: "dropdown",
					options: { delete: "Removed (default)", strikethrough: "Struck through" },
				},
			},
		],
	},
	{
		heading: "Reading handwriting (OCR)",
		note:
			"Off by default: handwritten remarks come back as images. Turn this on to " +
			"also get them as text from an OpenAI-compatible vision endpoint you choose " +
			"— a local Ollama or LM Studio keeps your ink on your own machine. Only the " +
			"cropped remark images are sent there, never the note.",
		items: [
			{
				key: "ocrEnabled",
				name: "Transcribe handwritten remarks",
				desc: "Send each remark image to the endpoint below and add the text it reads.",
				control: { type: "toggle" },
				refresh: true,
			},
			{
				key: "ocrEndpoint",
				name: "Endpoint",
				desc: "Base URL up to /v1, e.g. http://localhost:11434/v1 for Ollama.",
				control: { type: "text", placeholder: "http://localhost:11434/v1", sanitise: "url" },
				visibleWhen: { key: "ocrEnabled", equals: true },
			},
			{
				key: "ocrModel",
				name: "Model",
				desc: "A vision-capable model the endpoint serves, e.g. qwen2.5vl:7b.",
				control: { type: "text", placeholder: "qwen2.5vl:7b" },
				visibleWhen: { key: "ocrEnabled", equals: true },
			},
			{
				key: "ocrApiKey",
				name: "API key",
				desc: "Only for hosted endpoints; leave empty for a local server.",
				control: { type: "text", placeholder: "" },
				visibleWhen: { key: "ocrEnabled", equals: true },
			},
			{
				key: "ocrKeepImage",
				name: "Keep the image next to the text",
				desc: "Recommended: a misread word is easy to check against the ink.",
				control: { type: "toggle" },
				visibleWhen: { key: "ocrEnabled", equals: true },
			},
		],
	},
	{
		heading: "Device organization",
		items: [
			{
				key: "mirrorFolders",
				name: "Mirror vault folders",
				desc:
					"Recreate the vault folder structure on the device and replace the " +
					"previous copy when re-sending. Off: everything lands flat in the root.",
				control: { type: "toggle" },
				refresh: true,
			},
			{
				key: "deviceBaseFolder",
				name: "Device base folder",
				desc: "Folder on the reMarkable that holds the mirrored vault tree; empty for the root.",
				control: { type: "text", placeholder: "Obsidian", sanitise: "path" },
				visibleWhen: { key: "mirrorFolders", equals: true },
			},
		],
	},
	{
		heading: "Annotations back into the vault",
		items: [
			{
				key: "annotationTarget",
				name: "Where imported annotations land",
				desc:
					"A companion note keeps your source note untouched and links back to it. " +
					"Writing into the source note itself is possible, but the plugin then " +
					"edits a note you wrote — it only ever replaces its own marked block.",
				control: {
					type: "dropdown",
					options: {
						companion: "Companion note (recommended)",
						source: "Section inside the source note",
					},
				},
				refresh: true,
			},
			{
				key: "annotationFolder",
				name: "Folder for companion notes",
				desc: "Vault path, e.g. reMarkable-in; empty puts them in the vault root.",
				control: { type: "text", placeholder: "reMarkable-in", sanitise: "path" },
				visibleWhen: { key: "annotationTarget", equals: "companion" },
			},
			{
				key: "linkSourceToAnnotations",
				name: "Link the source note to its annotations",
				desc:
					"After an import, the source note gets an “annotations” property " +
					"linking to its companion note, so the two are one click apart. " +
					"The companion note always links back to the source. This is the " +
					"only thing the plugin ever writes into your note besides its id.",
				control: { type: "toggle" },
				visibleWhen: { key: "annotationTarget", equals: "companion" },
			},
			{
				key: "importHandwriting",
				name: "Import handwriting as images",
				desc:
					"Handwritten notes and freehand marks are pen strokes, not text. " +
					"With this on, each written page is rendered to a PNG and embedded " +
					"with the annotations so you can read it back.",
				control: { type: "toggle" },
				refresh: true,
			},
			{
				key: "handwritingFolder",
				name: "Folder for handwriting images",
				desc: "Vault path where the rendered pages are stored.",
				control: { type: "text", placeholder: "reMarkable-in/handwriting", sanitise: "path" },
				visibleWhen: { key: "importHandwriting", equals: true },
			},
		],
	},
	{
		heading: "What a pen mark becomes",
		note:
			"The shapes are fixed — they are what a pen can draw — but what they mean " +
			"is your own convention. A bar in the margin always quotes the lines it " +
			"ran alongside, and handwriting always comes back as an image.",
		items: [
			{
				key: "markStyles.strikethrough",
				name: "Line through words",
				desc: "A flat stroke crossing the letters, in one pass or several.",
				control: { type: "dropdown", options: MARK_STYLE_LABELS },
			},
			{
				key: "markStyles.circle",
				name: "Loop around words",
				desc: "A closed shape drawn around a word or phrase.",
				control: { type: "dropdown", options: MARK_STYLE_LABELS },
			},
			{
				key: "markStyles.underline",
				name: "Line under words",
				desc: "A flat stroke below the letters, clear of the baseline.",
				control: { type: "dropdown", options: MARK_STYLE_LABELS },
			},
		],
	},
	{
		heading: "Watch folder",
		items: [
			{
				key: "watchFolderEnabled",
				name: "Auto-send from a vault folder",
				desc:
					"Notes created or changed in the folder below are converted and " +
					"uploaded automatically (after a short quiet period). Unchanged " +
					"notes are skipped.",
				control: { type: "toggle" },
			},
			{
				key: "watchFolderPath",
				name: "Folder to watch",
				desc: "Vault path, e.g. reMarkable-out",
				control: { type: "text", placeholder: "reMarkable-out", sanitise: "path" },
			},
		],
	},
	{
		heading: "Content",
		items: [
			{
				key: "frontmatterAsTitleBlock",
				name: "Frontmatter as title block",
				desc:
					"Off (default): frontmatter is left out of the PDF. On: your fields " +
					"(tags, author, dates…) are listed under the title; the plugin's own " +
					"remarkable-id stays hidden.",
				control: { type: "toggle" },
			},
		],
	},
	{
		heading: "Updates",
		items: [
			{
				key: "showUpdateNotice",
				name: "Notify about new versions",
				desc:
					"After an update to a new major or minor version, show a brief " +
					"notice linking to what changed. Patch releases stay silent.",
				control: { type: "toggle" },
			},
		],
	},
];
