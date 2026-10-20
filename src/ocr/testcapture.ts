/**
 * The handwriting test (#14): what a filled-in test sheet is saved as, so
 * the readers can be measured on the owner's real hand — here, and later by
 * anyone given the file.
 *
 * Held out by design: nothing in a capture is ever learned from. A sheet the
 * readers trained on could no longer tell how well they read.
 *
 * Private by design too: a capture holds the sheet's own prompts, the owner's
 * ink of them, the letters learned from the letter sheet (already shared in
 * the sync folder) and what each reader made of it — never the vault's
 * words, the word samples, note paths or remark texts.
 *
 * No Obsidian here: the tests build and replay captures headless.
 */

import type { Stroke } from "../incoming/rmlines";
import { builtinFont } from "../ink/glyphs";
import type { HandLibrary, SheetBox } from "../ink/handsheet";
import type { DeviceProfile } from "../ink/inkrender";
import { templatesFrom, type Point, type Template } from "./recognize";
import type { ReaderName } from "./samples";

export const CAPTURE_FORMAT = "remarkable-ink-handwriting-test";

export interface HandwritingCapture {
	format: typeof CAPTURE_FORMAT;
	version: 1;
	createdAt: string;
	pluginVersion: string;
	/** The TEST_SHEET_VERSION the sheet was sent with: which prompts, which layout. */
	sheet: { kind: "test"; version: number };
	/** The canvas, so the sheet's boxes can be rebuilt. */
	profile: DeviceProfile;
	/** Letters learned at capture time, so the built-in reader can be replayed. */
	hand: HandLibrary | null;
	items: CaptureItem[];
}

export interface CaptureStroke {
	tool: number;
	color: number;
	thicknessScale: number;
	/** Flat x, y, width, pressure per point, device units. */
	points: number[];
}

/**
 * What a reader made of an item, accepted or not: a reading below the
 * reader's trust is recorded too — the owner never saw it, but it shows how
 * far off it was. Absent: the reader was not run; null: it failed.
 */
export interface CaptureReading {
	text: string;
	confidence?: number;
	accepted: boolean;
}

export interface CaptureItem {
	/** Page and row on the sheet, "p1-03". */
	id: string;
	/** What was to be written: the ground truth. */
	prompt: string;
	box: SheetBox;
	strokes: CaptureStroke[];
	readings: Partial<Record<ReaderName, CaptureReading | null>>;
}

export const CAPTURE_READERS: ReaderName[] = ["builtin", "writepad", "endpoint"];

export const READER_LABELS: Record<ReaderName, string> = {
	builtin: "Built-in",
	writepad: "WritePad",
	endpoint: "Endpoint",
};

/** Character error rate: edit distance over the expected length. */
export function cer(got: string, want: string): number {
	const d = Array.from({ length: got.length + 1 }, (_, i) => [i, ...new Array<number>(want.length).fill(0)]);
	for (let j = 1; j <= want.length; j++) d[0][j] = j;
	for (let i = 1; i <= got.length; i++) {
		for (let j = 1; j <= want.length; j++) {
			d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (got[i - 1] === want[j - 1] ? 0 : 1));
		}
	}
	return d[got.length][want.length] / Math.max(1, want.length);
}

/**
 * CER of a reading against its prompt. Whitespace counts as one space: a
 * sentence that ran onto a second line is read with a line break, which is
 * not a misreading.
 */
export function itemCer(text: string, prompt: string): number {
	const flat = (s: string) => s.replace(/\s+/g, " ").trim();
	return cer(flat(text), flat(prompt));
}

/** Rows on the sheet's pages, numbered from 1 per page. */
export function itemIds(boxes: SheetBox[]): Map<SheetBox, string> {
	const ids = new Map<SheetBox, string>();
	const rows = new Map<number, number>();
	for (const box of boxes) {
		const row = (rows.get(box.page) ?? 0) + 1;
		rows.set(box.page, row);
		ids.set(box, `p${box.page}-${String(row).padStart(2, "0")}`);
	}
	return ids;
}

/** A tablet stroke as stored: its points flattened. */
export function flattenStroke(stroke: Stroke): CaptureStroke {
	return {
		tool: stroke.tool,
		color: stroke.color,
		thicknessScale: stroke.thicknessScale,
		points: stroke.points.flatMap((p) => [p.x, p.y, p.width, p.pressure]),
	};
}

/** A stored stroke back as the tablet's, for the painter. */
export function unflattenStroke(stroke: CaptureStroke): Stroke {
	const points: Stroke["points"] = [];
	for (let i = 0; i + 3 < stroke.points.length; i += 4) {
		points.push({ x: stroke.points[i], y: stroke.points[i + 1], width: stroke.points[i + 2], pressure: stroke.points[i + 3] });
	}
	return { tool: stroke.tool, color: stroke.color, thicknessScale: stroke.thicknessScale, points };
}

/** An item's ink as the readers take it: x, y only. */
export function itemPoints(item: CaptureItem): Point[][] {
	return item.strokes.map((stroke) => {
		const points: Point[] = [];
		for (let i = 0; i + 1 < stroke.points.length; i += 4) points.push({ x: stroke.points[i], y: stroke.points[i + 1] });
		return points;
	});
}

/**
 * The built-in reader's letters as the plugin builds them, minus those
 * learned from corrections (they are not in the capture): the owner's hand,
 * then the print letters.
 */
export function replayTemplates(hand: HandLibrary | null): Template[] {
	return templatesFrom([
		...(hand === null ? [] : [{ glyphs: hand.glyphs, weight: 0.9 }]),
		{ glyphs: builtinFont("readability").glyphs, weight: 1 },
		{ glyphs: builtinFont("hershey-sans").glyphs, weight: 1 },
	]);
}

export interface ReaderSummary {
	reader: ReaderName;
	/** Items this reader has a reading for. */
	items: number;
	/** Mean CER over those items; NaN when there are none. */
	meanCer: number;
	/** How many of them the plugin would have used. */
	accepted: number;
	/** Items it was asked about but failed on (an endpoint error). */
	failed: number;
}

/** Per reader that read anything, how well it did. */
export function summarize(capture: HandwritingCapture): ReaderSummary[] {
	const out: ReaderSummary[] = [];
	for (const reader of CAPTURE_READERS) {
		let items = 0;
		let total = 0;
		let accepted = 0;
		let failed = 0;
		for (const item of capture.items) {
			if (!(reader in item.readings)) continue;
			const reading = item.readings[reader];
			if (reading === null || reading === undefined) {
				failed++;
				continue;
			}
			items++;
			total += itemCer(reading.text, item.prompt);
			if (reading.accepted) accepted++;
		}
		if (items + failed === 0) continue;
		out.push({ reader, items, meanCer: items === 0 ? NaN : total / items, accepted, failed });
	}
	return out;
}

/** Escape text for a table cell: no Markdown, links, tags or line breaks. */
function cell(text: string): string {
	return text.replace(/\s+/g, " ").trim().replace(/([\\`*_[\]<>#|~=$^])/g, "\\$1");
}

function percent(value: number): string {
	return Number.isNaN(value) ? "—" : `${(value * 100).toFixed(1)}%`;
}

/**
 * The note shown after a save: every prompt with each reader's reading and
 * its CER, the mean per reader, and the ink. `imageNames` maps item id to
 * the vault path of its picture.
 */
export function captureMarkdown(capture: HandwritingCapture, imageNames: Map<string, string>, jsonName?: string): string {
	const summary = summarize(capture);
	const readers = summary.map((s) => s.reader);
	const lines: string[] = [];
	lines.push(`# Handwriting test ${capture.createdAt}`, "");
	lines.push(
		`${capture.items.length} line(s) written, read as the plugin reads today (with this vault's words), ` +
			"without learning from them. CER is the character error rate: 0% is a perfect reading. " +
			"*Not used* marks a reading below the reader's trust, which the plugin would have left as an image.",
		"",
	);
	if (jsonName !== undefined) lines.push(`Attach \`${jsonName}\` to the forge issue.`, "");
	lines.push("## Mean CER", "");
	if (summary.length === 0) {
		lines.push("No reader read anything.", "");
	} else {
		lines.push("| Reader | Lines read | Mean CER | Used | Failed |", "| --- | --- | --- | --- | --- |");
		for (const s of summary) {
			lines.push(`| ${READER_LABELS[s.reader]} | ${s.items} | ${percent(s.meanCer)} | ${s.accepted} | ${s.failed} |`);
		}
		lines.push("");
	}
	lines.push("## Readings", "");
	const header = ["#", "Prompt", ...readers.flatMap((r) => [READER_LABELS[r], "CER"])];
	lines.push(`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`);
	for (const item of capture.items) {
		const row = [item.id, cell(item.prompt)];
		for (const reader of readers) {
			const reading = item.readings[reader];
			if (reading === undefined) row.push("", "");
			else if (reading === null) row.push("*failed*", "");
			else {
				const text = reading.text === "" ? "*nothing*" : cell(reading.text);
				row.push(reading.accepted ? text : `${text} *(not used)*`, percent(itemCer(reading.text, item.prompt)));
			}
		}
		lines.push(`| ${row.join(" | ")} |`);
	}
	lines.push("", "## Ink", "");
	for (const item of capture.items) {
		lines.push(`**${item.id}** — ${cell(item.prompt)}`, "");
		const image = imageNames.get(item.id);
		if (image !== undefined) lines.push(`![[${image}]]`, "");
	}
	return lines.join("\n");
}

/** A local time as a file-name stamp: 2026-10-20-213045. */
export function captureStamp(date: Date): string {
	const two = (n: number) => String(n).padStart(2, "0");
	return (
		`${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}-` +
		`${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`
	);
}

/** Read a capture file, or say why it is not one. */
export function parseCapture(text: string): HandwritingCapture {
	const value = JSON.parse(text) as Partial<HandwritingCapture>;
	if (value.format !== CAPTURE_FORMAT) throw new Error(`Not a handwriting test capture (format ${String(value.format)}).`);
	if (value.version !== 1) throw new Error(`Unknown handwriting test capture version ${String(value.version)}.`);
	return value as HandwritingCapture;
}
