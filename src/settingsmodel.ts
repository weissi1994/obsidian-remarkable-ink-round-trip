/**
 * What the plugin stores (PRD F1, F7, F9-basis).
 *
 * Kept apart from the settings *tab*: that module reaches into the Obsidian
 * API, and both the mark projection and the settings schema need the shape of
 * the settings without dragging a UI dependency into them (GP_E4_S3).
 */

import type { MappingTable } from "./id/mapping";
import type { PendingSheet } from "./ink/handsheet";
import {
	DEFAULT_MARK_STYLES,
	MARK_STYLE_LABELS,
	type MarkStyle,
	type MarkStyles,
} from "./incoming/markstyles";

export type { MarkStyle, MarkStyles };
export { DEFAULT_MARK_STYLES, MARK_STYLE_LABELS };

export interface RoundTripSettings {
	/** Long-lived device token (empty = not paired). */
	deviceToken: string;
	/** Use a self-hosted rmfakecloud endpoint instead of the official cloud. */
	useCustomEndpoint: boolean;
	customEndpointUrl: string;
	/** Render frontmatter as a small title block instead of dropping it. */
	frontmatterAsTitleBlock: boolean;
	fontSize: number;
	lineHeight: number;
	margin: number;
	/** Sync folders (F6): notes in these comma-separated vault folders are kept in two-way sync. */
	watchFolderEnabled: boolean;
	watchFolderPath: string;
	/** Minutes between background syncs; 0 = only on startup and on demand. */
	syncIntervalMinutes: number;
	/** Vault folder for the copy of a note taken before tablet changes go in. */
	backupFolder: string;
	/**
	 * Vault folder for the sync state every copy of the vault shares — what
	 * ties notes to notebooks. Synced with the notes (git, Obsidian Sync…).
	 */
	syncStateFolder: string;
	/**
	 * This device syncs on its own: at startup, on the interval and when a
	 * note changes. Off on all but one device when several copies of the
	 * vault share a tablet, so two never send the same note at once.
	 */
	autoSync: boolean;
	/** Import handwritten annotations as PNG images (F12). */
	importHandwriting: boolean;
	/** Vault folder for the rendered handwriting images. */
	handwritingFolder: string;
	/** Mirror vault folders on the device (GP_E2_S7); off = flat root uploads. */
	mirrorFolders: boolean;
	/** Device folder under which the vault tree is mirrored ("" = root). */
	deviceBaseFolder: string;
	/** How each recognised pen mark is written into the copy (GP_E3_S19). */
	markStyles: MarkStyles;
	/** Named typography bundle; "custom" uses the three sliders (GP_E6_S3). */
	layoutPreset: LayoutPreset;
	/** Automatic page breaks before headings (GP_E6_S4). */
	pageBreakAtHeading: HeadingBreak;
	/** Announce minor/major updates with a brief what's-new notice (GP_E5_S3). */
	showUpdateNotice: boolean;
	/** Last plugin version this install has run; "" = fresh install. */
	lastSeenVersion: string;
	/* ---------------- ink fork: handwritten notebooks ---------------- */
	/** Built-in single-line font id, or "hand" for the captured handwriting. */
	inkFont: string;
	/** Font for characters the handwriting library lacks. */
	inkFallbackFont: string;
	inkPen: "fine" | "medium" | "bold";
	/** reMarkable colour id of the generated ink (0 black, 6 blue, …). */
	inkColor: number;
	/** 0–1: how hand-made the generated writing looks. */
	inkJitter: number;
	/** Which canvas notebooks are written for. */
	inkDevice: InkDevice;
	/** Canvas for "custom", filled in by "Detect page size". */
	inkCustomProfile: { width: number; height: number; dpi: number };
	/** Version of the active handwriting library ("" = none learned yet). */
	handVersion: string;
	/** A handwriting sheet on the tablet waiting to be read back. */
	pendingSheet: PendingSheet | null;
	/** A word sheet (joined-up writing) on the tablet waiting to be read back. */
	pendingWordSheet: PendingSheet | null;
	/** A handwriting test sheet on the tablet, read back without learning (#14). */
	pendingTestSheet: PendingSheet | null;
	/** How embedded pictures are drawn in a handwritten notebook. */
	inkImages: "colour-hatch" | "mono-hatch" | "placeholder";
	/**
	 * Handwritten remarks sent back to the tablet: as the ink alone, where it
	 * was written, or as the callout the note shows (title, text and ink).
	 */
	inkRemarks: "in-place" | "callout";
	/** Unconfirmed remarks shown faded over the note's text, where they were written. */
	inkRemarkOverlay: boolean;
	/** Mermaid diagrams in a handwritten notebook: drawn by hand, or as code. */
	inkDiagrams: "handwritten" | "code";
	/** Highlighter colour behind code and quotes, and for diagram fills. */
	inkAccents: boolean;
	/** What a word erased on the tablet becomes in the note. */
	erasedAs: "delete" | "strikethrough";
	/** Opt-in OCR of handwritten remarks via an OpenAI-compatible endpoint. */
	ocrMode: OcrMode;
	/** Base URL ending in /v1, e.g. a local Ollama: http://localhost:11434/v1 */
	ocrEndpoint: string;
	ocrModel: string;
	ocrApiKey: string;
	/** Keep the ink image next to its transcript. */
	ocrKeepImage: boolean;
	/** Built-in OCR: also try the WritePad cursive reader when the letter reader is unsure. */
	ocrUseWritePad: boolean;
	/** Vision endpoint: how many of the owner's corrections go along as worked examples. */
	ocrExamples: number;
	/** Show which reader produced each remark and how confident it was, in the import report. */
	ocrDiagnostics: boolean;
	/** docId ↔ device document mapping (round-trip foundation, F5). */
	mappings: MappingTable;
}

/** Canvases a handwritten notebook can be written for (ink fork). */
export type InkDevice = "rm2" | "paperpro" | "move" | "custom";

/** How handwritten remarks are read as text: on the device's strokes, by a vision endpoint, or not. */
export type OcrMode = "builtin" | "endpoint" | "off";

export const DEFAULT_SETTINGS: RoundTripSettings = {
	deviceToken: "",
	useCustomEndpoint: false,
	customEndpointUrl: "",
	frontmatterAsTitleBlock: false,
	fontSize: 11,
	lineHeight: 1.5,
	margin: 40,
	watchFolderEnabled: false,
	watchFolderPath: "reMarkable-out",
	syncIntervalMinutes: 5,
	backupFolder: "reMarkable-in/previous",
	syncStateFolder: "reMarkable/.sync",
	autoSync: true,
	importHandwriting: true,
	markStyles: { ...DEFAULT_MARK_STYLES },
	handwritingFolder: "reMarkable-in/handwriting",
	mirrorFolders: true,
	deviceBaseFolder: "Obsidian",
	layoutPreset: "custom",
	pageBreakAtHeading: "smart",
	showUpdateNotice: true,
	lastSeenVersion: "",
	inkFont: "readability",
	inkFallbackFont: "readability",
	inkPen: "medium",
	inkColor: 0,
	inkJitter: 0.4,
	inkDevice: "rm2",
	inkCustomProfile: { width: 954, height: 1696, dpi: 264 },
	handVersion: "",
	pendingSheet: null,
	pendingWordSheet: null,
	pendingTestSheet: null,
	inkImages: "colour-hatch",
	inkRemarks: "in-place",
	inkRemarkOverlay: true,
	inkDiagrams: "handwritten",
	inkAccents: true,
	erasedAs: "delete",
	ocrMode: "builtin",
	ocrEndpoint: "http://localhost:11434/v1",
	ocrModel: "qwen2.5vl:7b",
	ocrApiKey: "",
	ocrKeepImage: true,
	ocrUseWritePad: true,
	ocrExamples: 3,
	ocrDiagnostics: false,
	mappings: {},
};

/**
 * Merge stored settings over the defaults. The smart page-break default is
 * for fresh installs only (GP_E6_S9): stored data that predates the setting
 * (any keys, but not this one) keeps the old manual default, so an upgrade
 * never silently repaginates notes on re-send.
 */
export function settingsFrom(stored: Partial<RoundTripSettings>): RoundTripSettings {
	const settings = { ...DEFAULT_SETTINGS, ...stored };
	// Count KNOWN keys only: a data.json holding nothing but a hand-added
	// extra (the spike flag) is still a fresh install, not an upgrade
	// (reviewvondst 0.35.1).
	const knownStored = Object.keys(stored).filter((key) => key in DEFAULT_SETTINGS);
	if (knownStored.length > 0 && stored.pageBreakAtHeading === undefined) {
		settings.pageBreakAtHeading = "off";
	}
	// The notebook canvas used to follow a separate "reMarkable model".
	const legacy = stored as { inkDevice?: string; deviceModel?: string; ocrEnabled?: boolean };
	// The vision endpoint used to be the only OCR, behind an on/off switch.
	if (stored.ocrMode === undefined && legacy.ocrEnabled === true) settings.ocrMode = "endpoint";
	if (legacy.inkDevice === "auto" || legacy.inkDevice === undefined) {
		settings.inkDevice = legacy.deviceModel === "paperpro" ? "paperpro" : "rm2";
	}
	return settings;
}

/**
 * Keys in stored data the settings model does not know — a hand-added spike
 * flag, or a newer version's settings after a downgrade. The save path
 * spreads these back in FIRST, so saving settings never destroys them
 * (GP_E7_S1 bevinding: elke save wiste de handmatige spike-vlag).
 */
export function extrasFrom(stored: Record<string, unknown>): Record<string, unknown> {
	const known = new Set(Object.keys(DEFAULT_SETTINGS));
	return Object.fromEntries(Object.entries(stored).filter(([key]) => !known.has(key)));
}

/**
 * What a save writes to data.json: the settings, with unknown keys riding
 * along. Extras FIRST so a key the model later learns wins over a stale
 * extra — this spread order is the invariant the 0.35.1 fix is about, so
 * it lives here, under test, not inline at the save call.
 */
export function storedFrom(
	settings: RoundTripSettings,
	extras: Record<string, unknown>,
): Record<string, unknown> {
	return { ...extras, ...settings };
}

/** Named typography bundles (GP_E6_S3); "custom" falls back to the sliders. */
export type LayoutPreset = "readable" | "form" | "compact" | "custom";

export const LAYOUT_PRESETS: Record<
	Exclude<LayoutPreset, "custom">,
	{ fontSize: number; lineHeight: number; margin: number }
> = {
	readable: { fontSize: 13, lineHeight: 1.6, margin: 44 },
	form: { fontSize: 11, lineHeight: 1.5, margin: 40 },
	compact: { fontSize: 9, lineHeight: 1.3, margin: 30 },
};

/** The typography a send should actually use: preset bundle or the sliders. */
export function layoutFor(settings: RoundTripSettings): {
	fontSize: number;
	lineHeight: number;
	margin: number;
} {
	if (settings.layoutPreset !== "custom") return { ...LAYOUT_PRESETS[settings.layoutPreset] };
	return {
		fontSize: settings.fontSize,
		lineHeight: settings.lineHeight,
		margin: settings.margin,
	};
}

/**
 * Automatic page breaks before headings (GP_E6_S4); "smart" packs instead of
 * breaking unconditionally (GP_E6_S9): a #/## section starts on a fresh page
 * only when it does not fit whole in the space left on the current one.
 */
export type HeadingBreak = "off" | "h1" | "h2" | "smart";

/** The heading level up to which sends break the page; 0 = manual only. */
export function breakLevelFor(settings: RoundTripSettings): number {
	return { off: 0, h1: 1, h2: 2, smart: 0 }[settings.pageBreakAtHeading];
}

/** Whether sends should measure #/## sections and pack them (GP_E6_S9). */
export function packFor(settings: RoundTripSettings): boolean {
	return settings.pageBreakAtHeading === "smart";
}

/**
 * The complete layout a send should use — preset bundle (or sliders),
 * heading-break level and section packing. The page size comes from the
 * notebook canvas (inkDevice) at render time.
 */
export function sendLayout(settings: RoundTripSettings): {
	fontSize: number;
	lineHeight: number;
	margin: number;
	breakAtHeading: number;
	packSections: boolean;
} {
	return {
		...layoutFor(settings),
		breakAtHeading: breakLevelFor(settings),
		packSections: packFor(settings),
	};
}
