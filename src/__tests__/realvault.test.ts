/**
 * Two-way sync on the owner's real sync state: real sent notes, their real
 * handwriting libraries, real remark ink. Opt-in, never part of `vitest run`:
 *
 *   RM_SYNC_STATE=<vault>/reMarkable/.sync npm run test:vault
 *
 * RM_SYNC_STATE  the sync state folder (notes/, hands/, ink/, samples.json …)
 * RM_VAULT_SAMPLE how many sent notes to sample, spread over every hand (default 40)
 * RM_VAULT_SEED  the sampling and target seed (default 1)
 * RM_VAULT_ONLY  comma-separated note ids to run instead of a sample (targets stay the same per note)
 *
 * The folder is read through the real SyncState on a file seam that refuses
 * every write. Nothing of it is printed: failures and the summary name note
 * ids, hands, edit kinds and counts — never note text, readings or ink.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import type { PlacedWord } from "../convert/pdf";
import type { InkSnapshot, MappingEntry } from "../id/mapping";
import { type AnnotationOutcome, type PendingChange, PENDING_TITLE, withPendingCallout } from "../incoming/annotationnote";
import { collectInkAnnotations } from "../incoming/inkpull";
import { DEFAULT_MARK_STYLES } from "../incoming/markstyles";
import { readMarks, rowsOf, type Row } from "../incoming/marks";
import type { DocumentFile, ImportedMark, PullDeps, StrokeRenderRequest } from "../incoming/pull";
import { isPluginIdLine, remarkId, typedIdLine, typedTextId } from "../incoming/remarkid";
import type { Highlight } from "../incoming/highlights";
import { InkEdge, type InkHost } from "../inkedge";
import { handSource, type HandLibrary } from "../ink/handsheet";
import { inkStrokesOf, type InkStrokes, type Picture } from "../ink/inkimage";
import { inkOptionsFor } from "../ink/inkfonts";
import { inkPagesToRm, type InkRender } from "../ink/inkrender";
import { PEN } from "../ink/rmwrite";
import { knownText, withEarlierReadings, type SampleStore } from "../ocr/samples";
import { displayTextForLink } from "../preprocess/preprocess";
import { DEFAULT_SETTINGS, type RoundTripSettings } from "../settingsmodel";
import { CONFLICT_TITLE } from "../sync/merge3";
import { sendNote, type SendDeps, type SentRecord } from "../sync/send";
import { SyncState, type StateFs } from "../sync/syncstate";
import { mergeTabletChanges, type TabletChanges } from "../sync/twoway";
import { sendNotebook, sendNotebookUpdate } from "../transport/notebook";
import { fakeCloud } from "./helpers/fakecloud";
import { decodeJson, encodeJson, filesOf, onTablet } from "./helpers/tablet";
import {
	absoluteInk,
	boxOf,
	inkAt,
	notebookOf,
	type Notebook,
	ownerPage,
	penLine,
	stepOf,
	TabletPage,
	toDevice,
} from "./helpers/tabletedits";

const ROOT = process.env.RM_SYNC_STATE;
const SAMPLE = Number(process.env.RM_VAULT_SAMPLE ?? 40);
const SEED = Number(process.env.RM_VAULT_SEED ?? 1);
const ONLY = process.env.RM_VAULT_ONLY?.split(",").map((id) => id.trim()).filter((id) => id !== "");
const LONG = 2 * 60 * 60 * 1000;
const NO_WAIT = { attempts: 3, backoffMs: () => 0, sleep: async () => undefined };

/** What the plugin reads every remark as here: synthetic, so nothing read from real ink is ever compared or shown. */
const READING = "remark read on import";
const TYPED = "Typed on the tablet for the vault check\n- with a **list** item";
const VAULT_WORD = "vaulteditword";
const APPENDED = "A line appended in the vault.";
const HIGHLIGHTERS = new Set([PEN.highlighter, 5, 18]);

/* ------------------------------ the state ----------------------------- */

/** The state folder as it is on disk; every write refused. */
function readOnlyFs(): StateFs {
	const refuse = async (path: string) => {
		throw new Error(`read-only state: refused to change ${path}`);
	};
	return {
		exists: (path) => stat(path).then(() => true, () => false),
		read: (path) => readFile(path, "utf8"),
		list: async (dir) => (await readdir(dir)).map((name) => `${dir}/${name}`),
		write: refuse,
		mkdir: refuse,
		remove: refuse,
	};
}

/** Writes kept in memory over the read-only folder: a send's record lands here, never on disk. */
function overlayFs(base: StateFs): StateFs {
	const files = new Map<string, string>();
	return {
		exists: async (path) => files.has(path) || [...files.keys()].some((file) => file.startsWith(`${path}/`)) || base.exists(path),
		read: async (path) => files.get(path) ?? base.read(path),
		list: async (dir) => [...new Set([...(await base.list(dir).catch(() => [])), ...[...files.keys()].filter((file) => file.startsWith(`${dir}/`))])],
		write: async (path, data) => {
			files.set(path, data);
		},
		mkdir: async () => undefined,
		remove: async (path) => {
			files.delete(path);
		},
	};
}

interface Real {
	docId: string;
	entry: MappingEntry;
	sent: SentRecord & { body: string };
	/** Font and hand, the way failures are counted. */
	group: string;
}

interface Vault {
	fs: StateFs;
	state: SyncState;
	notes: Real[];
	total: number;
	samples: SampleStore | null;
	/** The owner's remark ink without highlighter on it, by file name. */
	inks: { name: string; ink: InkStrokes }[];
	hands: string[];
}

function fnv(text: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
	return hash;
}

/** A deterministic stream of numbers in [0, 1) for one purpose (mulberry32). */
function random(key: string): () => number {
	let a = (SEED ^ fnv(key)) >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function shuffled<T>(items: readonly T[], next: () => number): T[] {
	const out = [...items];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(next() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

const groupOf = (ink: InkSnapshot) => (ink.font === "hand" ? `hand:${ink.hand ?? "?"}` : `font:${ink.font}`);

async function loadVault(root: string): Promise<Vault> {
	const fs = readOnlyFs();
	const state = new SyncState(fs, root);
	const table = await state.loadMappings();
	const all: Real[] = [];
	for (const entry of Object.values(table)) {
		if (entry.format !== "ink" || entry.ink === undefined || entry.ink.mode === "typed" || entry.pdfLayout === undefined) continue;
		const sent = await state.readSent(entry.docId);
		if (sent?.body === undefined) continue;
		all.push({ docId: entry.docId, entry, sent: { ...sent, body: sent.body }, group: groupOf(entry.ink) });
	}
	// Every hand in turn, until the sample is full.
	const groups = new Map<string, Real[]>();
	for (const real of [...all].sort((a, b) => (a.docId < b.docId ? -1 : 1))) groups.set(real.group, [...(groups.get(real.group) ?? []), real]);
	const queues = [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([group, notes]) => shuffled(notes, random(`sample:${group}`)));
	const notes: Real[] = ONLY === undefined ? [] : all.filter((real) => ONLY.includes(real.docId));
	while (ONLY === undefined && notes.length < Math.min(SAMPLE, all.length)) {
		for (const queue of queues) {
			const next = queue.shift();
			if (next !== undefined && notes.length < SAMPLE) notes.push(next);
		}
	}
	const inks: { name: string; ink: InkStrokes }[] = [];
	for (const file of (await fs.list(`${root}/ink`).catch(() => [])).sort()) {
		const name = (file.split("/").pop() ?? "").replace(/\.json$/, "");
		const ink = await state.readInk(name);
		if (ink === null || ink.strokes.length === 0 || ink.strokes.some((stroke) => HIGHLIGHTERS.has(stroke.tool))) continue;
		inks.push({ name, ink });
	}
	const hands = (await fs.list(`${root}/hands`).catch(() => [])).map((file) => (file.split("/").pop() ?? "").replace(/\.json$/, ""));
	return { fs, state, notes, total: all.length, samples: await state.readSamples(), inks, hands };
}

/* --------------------------- regenerating --------------------------- */

/** The plugin's edge on a state folder, with the settings a snapshot was sent with. */
function edgeFor(state: SyncState, snapshot?: InkSnapshot): InkEdge {
	const settings: RoundTripSettings = {
		...DEFAULT_SETTINGS,
		...(snapshot === undefined
			? {}
			: {
					inkFont: snapshot.font,
					handVersion: snapshot.hand ?? "",
					inkFallbackFont: snapshot.fallbackFont,
					inkPen: snapshot.pen,
					inkColor: snapshot.color,
					inkJitter: snapshot.jitter,
					inkDevice: "custom" as const,
					inkCustomProfile: snapshot.profile,
					inkImages: snapshot.imageStyle ?? "placeholder",
					inkAccents: snapshot.accents === true,
				}),
	};
	const host = {
		app: { vault: { configDir: "config", adapter: { exists: async () => false } } },
		manifest: { dir: "/nonexistent/plugin" },
		settings,
		state,
		persist: async () => undefined,
	};
	return new InkEdge(host as unknown as InkHost);
}

interface Prepared {
	real: Real;
	render: InkRender;
	book: Notebook;
	/** The notebook's page files as the plugin wrote them, by file id. */
	files: Map<string, Uint8Array>;
	fileOf(page: number): string;
}

async function prepare(vault: Vault, real: Real): Promise<Prepared | string> {
	const { entry } = real;
	let render: InkRender | null;
	try {
		render = await edgeFor(vault.state).loadInk(entry);
	} catch (error) {
		return `regeneration threw: ${error instanceof Error ? error.name : "error"}`;
	}
	if (render === null) return "not regenerated (hand or font versions)";
	const library: HandLibrary | null = entry.ink!.hand === undefined ? null : await vault.state.readHand(entry.ink!.hand);
	const options = inkOptionsFor(entry.ink!, entry.docId, () => (library === null ? null : handSource(library)))!;
	const pages = inkPagesToRm(render, options);
	const pageIds = entry.ink!.pageIds;
	if (pages.length !== pageIds.length) return `page count ${pages.length}, sent ${pageIds.length}`;
	const fileOf = (page: number) => `${entry.deviceDocId}/${pageIds[page - 1]}.rm`;
	const files = new Map(pages.map((bytes, index) => [fileOf(index + 1), bytes]));
	return { real, render, book: notebookOf(render, options), files, fileOf };
}

/* ------------------------------ importing ------------------------------ */

const imagePath = (deviceDocId: string, request: StrokeRenderRequest) =>
	`reMarkable-in/handwriting/${deviceDocId}-p${String(request.page).padStart(2, "0")}-${remarkId(request.strokes)}.png`;

/** Handwriting import on: every remark gets an image and the same synthetic reading. */
function reading(deviceDocId: string, text: (request: StrokeRenderRequest) => string = () => READING): Partial<PullDeps> {
	return {
		renderStrokes: async (request) => imagePath(deviceDocId, request),
		transcribe: async (request) => ({ text: text(request) }),
	};
}

function pullDeps(files: Map<string, Uint8Array>, render: InkRender, extra: Partial<PullDeps> = {}): PullDeps {
	return {
		listDocumentHashes: async () => new Map(),
		listDocumentFiles: async () => [...files.keys()].map((id) => ({ id, hash: id })),
		readFile: async (file: DocumentFile) => new TextDecoder().decode(files.get(file.id)),
		readBytes: async (file: DocumentFile) => files.get(file.id)!,
		loadInk: async () => render,
		writeAnnotations: async () => undefined,
		...extra,
	};
}

interface Changes {
	highlights: Highlight[];
	marks: ImportedMark[];
}

async function importPages(p: Prepared, changed: Map<string, Uint8Array>, extra: Partial<PullDeps> = {}): Promise<Changes> {
	const files = new Map([...p.files, ...changed]);
	const { highlights, marks } = await collectInkAnnotations(p.real.entry, "h", pullDeps(files, p.render, extra));
	return { highlights, marks };
}

/** What mergeTabletChanges returns. */
interface Merged {
	body: string;
	outcome: AnnotationOutcome;
	refreshed: string[];
	projected: string | null;
}

function merge(p: Prepared, changes: Changes, ours: string, extra: Partial<TabletChanges> = {}): Merged {
	return mergeTabletChanges({
		base: p.real.sent.body,
		ours,
		layout: p.render.layout,
		highlights: changes.highlights,
		marks: changes.marks,
		styles: DEFAULT_MARK_STYLES,
		erasedAs: DEFAULT_SETTINGS.erasedAs,
		sourcePath: `${p.real.docId}.md`,
		sourceName: p.real.docId,
		importedAt: "2026-10-27 12:00",
		...extra,
	});
}

/* ------------------------------ reporting ------------------------------ */

interface Failure {
	docId: string;
	group: string;
	kind: string;
	reason: string;
}

/** What kind of line this is, without its text: plugin lines by name, the suite's own synthetic lines by role. */
function shape(line: string): string {
	const typed = TYPED.split("\n").indexOf(line);
	if (typed !== -1) return `typed${typed + 1}`;
	if (line === APPENDED) return "appended";
	if (line === `> ${READING}`) return "reading";
	if (line.trim() === "") return "_";
	if (/^\^ink-typed-/.test(line)) return "^typed";
	if (/^(>\s*)*\^ink-pending\s*$/.test(line)) return "^pending";
	if (/^(>\s*)*\^ink-conflict-/.test(line)) return "^conflict";
	if (isPluginIdLine(line)) return "^remark";
	if (line.startsWith(CONFLICT_TITLE)) return "[clash]";
	if (line.startsWith(PENDING_TITLE)) return "[pending]";
	if (/^> \[!note\] Remark/.test(line)) return "[remark]";
	if (/^> \[!note\] Page added on the reMarkable/.test(line)) return "[page]";
	const marks = [line.includes(VAULT_WORD) ? "+vault" : "", line.includes("~~") ? "+strike" : "", line.includes("<u>") ? "+u" : "", line.includes("![[") ? "+image" : ""].join("");
	const kind = /^#{1,6} /.test(line) ? "H" : line.startsWith(">") ? ">" : /^\s*([-*+]|\d+[.)]) /.test(line) ? "-" : line.startsWith("|") ? "|" : /^\s*(```|~~~)/.test(line) ? "```" : "T";
	return kind + marks;
}

/** Where two texts part, without either text: the line, and the shape of the lines around it. */
function where(got: string, want: string, span = 5): string {
	const a = got.split("\n");
	const b = want.split("\n");
	let line = 0;
	while (line < a.length && line < b.length && a[line] === b[line]) line++;
	const around = (lines: string[]) => lines.slice(Math.max(0, line - 2), line + span).map(shape).join(" ");
	return `differs from line ${line + 1} (got ${a.length} lines, want ${b.length}; got ${around(a)} | want ${around(b)})`;
}

const count = (text: string, part: string) => text.split(part).length - 1;

function tally(failures: Failure[], key: (failure: Failure) => string): Record<string, number> {
	const out: Record<string, number> = {};
	for (const failure of failures) out[key(failure)] = (out[key(failure)] ?? 0) + 1;
	return out;
}

function report(section: string, ran: Record<string, number>, failures: Failure[]): void {
	process.stdout.write(
		`[realvault] ${section}\n` +
			`  ran: ${JSON.stringify(ran)}\n` +
			`  failed by kind: ${JSON.stringify(tally(failures, (f) => f.kind))}\n` +
			`  failed by hand: ${JSON.stringify(tally(failures, (f) => f.group))}\n` +
			failures.map((f) => `  - ${f.docId} [${f.group}] ${f.kind}: ${f.reason}\n`).join(""),
	);
}

/* ------------------------------- targets ------------------------------- */

const WORDISH = /^\p{L}{4,}$/u;
const BOUNDARY = "[\\p{L}\\p{N}_]";

/** Offsets of `word` standing alone in `text`, between spaces or line ends. */
function occurrences(text: string, word: string): number[] {
	const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return [...text.matchAll(new RegExp(`(?<!${BOUNDARY})${escaped}(?!${BOUNDARY})`, "gu"))].map((match) => match.index);
}

/** `text` with the single standalone `word` replaced; null when it is not there exactly once. */
function replaceWord(text: string, word: string, by: string): string | null {
	const found = occurrences(text, word);
	return found.length === 1 ? text.slice(0, found[0]) + by + text.slice(found[0] + word.length) : null;
}

const lineIndexAt = (text: string, offset: number) => count(text.slice(0, offset), "\n");

/** A word the projection can be checked on: plain, unique on the page and in the note, on a one-line row. */
interface Spot {
	page: number;
	word: PlacedWord;
	row: Row;
	/** Its offset in the note body, and the body line. */
	at: number;
	bodyLine: number;
}

function spotsOf(p: Prepared): Spot[] {
	const { layout } = p.render;
	const body = p.real.sent.body;
	const lines = body.split("\n");
	const byText = new Map<string, number>();
	for (const word of layout.lines.flatMap((line) => line.words)) byText.set(word.text, (byText.get(word.text) ?? 0) + 1);
	const spots: Spot[] = [];
	for (let page = 1; page <= p.render.pages.length; page++) {
		const inked = new Set(p.render.pages[page - 1].map((stroke) => stroke.wordId));
		for (const row of rowsOf(layout, page)) {
			if (row.lines.length !== 1) continue;
			const [line] = row.lines;
			if ((line.role !== "paragraph" && line.role !== "list") || line.checkbox !== undefined || row.lines.some((l) => l.checkbox !== undefined)) continue;
			for (const word of line.words.slice(0, -1)) {
				if (!WORDISH.test(word.text) || word.style !== undefined || byText.get(word.text) !== 1 || !inked.has(word.id)) continue;
				const found = occurrences(body, word.text);
				if (found.length !== 1) continue;
				const at = found[0];
				const before = at === 0 ? "\n" : body[at - 1];
				const after = body[at + word.text.length] ?? "\n";
				if (!/[ \n]/.test(before) || !/[ \n]/.test(after)) continue;
				const bodyLine = lineIndexAt(body, at);
				if (/^\s*([#|>]|```|~~~)/.test(lines[bodyLine])) continue;
				spots.push({ page, word, row, at, bodyLine });
			}
		}
	}
	return spots;
}

/** Room between rows (or under the last) on a page, in PDF points, with the row above it. */
interface Gap {
	page: number;
	above: Row;
	/** Top and bottom of the free band, PDF points (y up). */
	top: number;
	bottom: number;
}

/** `underNoteText`: only under rows of the note's own text — not the title, nor a frontmatter block typeset above it. */
function gapsOf(p: Prepared, underNoteText = false): Gap[] {
	const { layout } = p.render;
	const gaps: Gap[] = [];
	for (let page = 1; page <= p.render.pages.length; page++) {
		const rows = rowsOf(layout, page).filter((row) => Number.isFinite(row.left));
		rows.forEach((row, index) => {
			const below = rows[index + 1];
			if (row.lines.some((line) => line.checkbox !== undefined) || below?.lines.some((line) => line.checkbox !== undefined)) return;
			const own = !row.lines.some((line) => line.role === "title") && row.lines.flatMap((line) => line.words).every((word) => p.real.sent.body.includes(word.text));
			if (underNoteText && !own) return;
			const top = row.y - row.size * 0.3;
			const bottom = below === undefined ? layout.pageHeight * 0.04 : below.y + below.size * 0.85;
			if (top - bottom > row.size) gaps.push({ page, above: row, top, bottom });
		});
	}
	return gaps;
}

/** Real ink placed in a gap, under the row above it, clear of everything of ours on the page. */
function placeIn(p: Prepared, gap: Gap, ink: InkStrokes): { x: number; y: number } | null {
	const { layout } = p.render;
	const grid = layout.grid ?? p.book.paper;
	const sy = grid.height / layout.pageHeight;
	const clear = gap.above.size * 0.2;
	const topPdf = gap.top - clear;
	if ((topPdf - gap.bottom - clear) * sy < ink.height) return null;
	const at = toDevice(layout, { x: gap.above.left, y: topPdf });
	if (at.x + ink.width > grid.width / 2 - 10) return null;
	const placed = { minX: at.x, minY: at.y, maxX: at.x + ink.width, maxY: at.y + ink.height };
	const hits = p.render.pages[gap.page - 1].some((stroke) => {
		const box = boxOf([stroke]);
		return box.maxX >= placed.minX && box.minX <= placed.maxX && box.maxY >= placed.minY && box.minY <= placed.maxY;
	});
	return hits ? null : at;
}

/** The body lines a remark callout makes, as the projection writes it. */
function calloutLines(title: string, reading: string, path: string, id: string): string[] {
	return [title, ...reading.split("\n").map((line) => `> ${line}`), `> ![[${path}]]`, `> ^ink-${id}`];
}

/**
 * The lines `body` has that `base` lacks, when they are one run inserted
 * whole (blank lines at its edges left out); null when the rest differs.
 */
function inserted(base: string, body: string): { at: number; lines: string[] } | null {
	const a = base.split("\n");
	const b = body.split("\n");
	let head = 0;
	while (head < a.length && head < b.length && a[head] === b[head]) head++;
	let tail = 0;
	while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
	if (head + tail !== a.length) return null;
	const run = b.slice(head, b.length - tail);
	let start = 0;
	let end = run.length;
	while (start < end && run[start].trim() === "") start++;
	while (end > start && run[end - 1].trim() === "") end--;
	return { at: head + start, lines: run.slice(start, end) };
}

/**
 * Where `body` is `base` with exactly `block` inserted (and the blank line
 * that sets it apart); -1 when no such place makes the two equal. Unlike
 * `inserted`, a block that repeats a neighbour's lines (a second remark
 * callout) is still found where it really went.
 */
function insertedBlock(base: string, body: string, block: string[]): number {
	const lines = body.split("\n");
	for (let at = 0; at + block.length <= lines.length; at++) {
		if (block.some((line, k) => lines[at + k] !== line)) continue;
		const rest = [...lines.slice(0, at), ...lines.slice(at + block.length)];
		const blankBefore = at > 0 && rest[at - 1].trim() === "" ? [...rest.slice(0, at - 1), ...rest.slice(at)] : null;
		const blankAfter = at < rest.length && rest[at].trim() === "" ? [...rest.slice(0, at), ...rest.slice(at + 1)] : null;
		if ([rest, blankBefore, blankAfter].some((candidate) => candidate?.join("\n") === base)) return at;
	}
	return -1;
}

/* ------------------------------ the suite ------------------------------ */

/** One tablet edit on one real note, and what the note must become. */
interface Case {
	p: Prepared;
	kind: string;
	pages: Map<string, Uint8Array>;
	extra?: Partial<PullDeps>;
	/** Checks the merged body; returns a failure reason, or null. */
	expect(body: string, changes: Changes): string | null;
	/** Where the tablet changed the note: a body line, for vault edits next to and away from it. */
	line?: number;
	/** The word the tablet changed, for a vault edit of the same word. */
	word?: string;
	/** What the tablet's side shows of that word, in a clash callout. */
	tabletShows?: string;
	/** The tablet's expected body, for disjoint vault edits. */
	want?: string;
}

describe.skipIf(ROOT === undefined)("the owner's real sync state", () => {
	let vault: Vault;
	const prepared: Prepared[] = [];
	/** The single-edit cases of section 2 with their first merge, for idempotence. */
	const merged: { c: Case; changes: Changes; first: Merged }[] = [];
	/** Pages (docId#page) the typing seam (editTypedPage, author 2) refused to write. */
	const typingRefused: string[] = [];

	beforeAll(async () => {
		vault = await loadVault(ROOT!);
		process.stdout.write(
			`[realvault] ${vault.total} handwritten sends, sampled ${vault.notes.length}: ` +
				JSON.stringify(tally(vault.notes.map((n) => ({ docId: n.docId, group: n.group, kind: "", reason: "" })), (f) => f.group)) +
				`; ${vault.hands.length} hand libraries, ${vault.inks.length} remark inks without highlighter, ` +
				`${Object.keys(vault.samples?.remarks ?? {}).length} remark samples\n`,
		);
	}, LONG);

	it("1. regenerates every sampled notebook exactly: untouched pages read back as no change (I3)", async () => {
		const failures: Failure[] = [];
		const ran: Record<string, number> = {};
		for (const real of vault.notes) {
			ran[real.group] = (ran[real.group] ?? 0) + 1;
			const fail = (reason: string) => failures.push({ docId: real.docId, group: real.group, kind: `shape ${real.entry.ink!.shape}`, reason });
			const p = await prepare(vault, real);
			if (typeof p === "string") {
				fail(p);
				continue;
			}
			// A second, independent regeneration writes the very same bytes.
			const again = await prepare(vault, real);
			if (typeof again === "string" || [...p.files].some(([id, bytes]) => !Buffer.from(bytes).equals(Buffer.from(again.files.get(id)!)))) {
				fail("regeneration not deterministic");
				continue;
			}
			const changes = await importPages(p, new Map(), reading(real.entry.deviceDocId));
			if (changes.marks.length > 0 || changes.highlights.length > 0) {
				fail(`untouched pages read as ${changes.marks.length} mark(s) [${[...new Set(changes.marks.map((m) => m.kind))].join(",")}], ${changes.highlights.length} highlight(s)`);
				continue;
			}
			const result = merge(p, changes, real.sent.body);
			if (result.body !== real.sent.body) fail(`note changed by an import of nothing: ${where(result.body, real.sent.body)}`);
			else if ((result.outcome.pending ?? []).length > 0) fail(`${result.outcome.pending!.length} pending`);
			else prepared.push(p);
		}
		report("1. regeneration fidelity", ran, failures);
		expect(failures).toEqual([]);
	}, LONG);

	/** The single-edit cases on one prepared note; kinds without a fitting target are left out. */
	function casesOf(p: Prepared): Case[] {
		const { real, render, book } = p;
		const { layout } = render;
		const body = real.sent.body;
		const next = random(`targets:${real.docId}`);
		const spots = shuffled(spotsOf(p), next);
		const used = new Set<number>();
		const take = (ok: (spot: Spot) => boolean = () => true) => {
			const spot = spots.find((candidate) => !used.has(candidate.word.id) && ok(candidate));
			if (spot !== undefined) used.add(spot.word.id);
			return spot;
		};
		const page = (n: number) => new TabletPage(book, n);
		const one = (n: number, tablet: TabletPage) => new Map([[p.fileOf(n), tablet.bytes()]]);
		const exact = (want: string | null) => (got: string) => (want === null ? "no expectation" : got === want ? null : where(got, want));
		const step = (n: number) => stepOf(rowsOf(layout, n));
		const cases: Case[] = [];
		const wordCase = (kind: string, spot: Spot | undefined, edit: (tablet: TabletPage, id: number) => TabletPage, markup: (word: string) => string) => {
			if (spot === undefined) return;
			const want = replaceWord(body, spot.word.text, markup(spot.word.text));
			cases.push({
				p,
				kind,
				pages: one(spot.page, edit(page(spot.page), spot.word.id)),
				expect: exact(want),
				line: spot.bodyLine,
				word: spot.word.text,
				tabletShows: markup(spot.word.text),
				want: want ?? undefined,
			});
		};

		wordCase("erase", take(), (t, id) => t.erase(id), (w) => `~~${w}~~`);
		const wide = (spot: Spot) => spot.word.width >= step(spot.page) * 2.1;
		wordCase("strike", take(wide), (t, id) => t.strike(id), (w) => `~~${w}~~`);
		wordCase("underline", take(wide), (t, id) => t.underline(id), (w) => `<u>${w}</u>`);
		wordCase("circle", take((s) => s.word.width >= s.row.size * 1.3), (t, id) => t.circle(id), (w) => `**${w}**`);

		const partial = take();
		if (partial !== undefined) {
			const pending: PendingChange[] = [{ page: partial.page, text: `“${partial.word.text}” partly erased — erase the whole word to remove it` }];
			cases.push({ p, kind: "partial erase", pages: one(partial.page, page(partial.page).partlyErase(partial.word.id)), expect: exact(withPendingCallout(body, pending)) });
		}

		// A word lassoed next to another word on another row of its page.
		const mover = take();
		const anchor = mover === undefined ? undefined : take((s) => s.page === mover.page && s.row !== mover.row && Math.abs(s.bodyLine - mover.bodyLine) > 0);
		if (mover !== undefined && anchor !== undefined) {
			const grid = layout.grid ?? book.paper;
			const sx = grid.width / layout.pageWidth;
			const sy = grid.height / layout.pageHeight;
			const dx = (anchor.word.x + anchor.word.width * 0.75 - mover.word.x) * sx;
			const dy = (mover.row.y + mover.row.size * 0.3 - (anchor.row.y + anchor.row.size * 0.3)) * sy;
			const w = mover.word.text;
			const gone = body[mover.at - 1] === " " ? { from: mover.at - 1, to: mover.at + w.length } : { from: mover.at, to: mover.at + w.length + (body[mover.at + w.length] === " " ? 1 : 0) };
			const insertAt = anchor.at + anchor.word.text.length;
			const edits = [
				{ at: gone.from, remove: gone.to - gone.from, text: "" },
				{ at: insertAt, remove: 0, text: ` ${w}` },
			].sort((a, b) => b.at - a.at);
			let want = body;
			for (const edit of edits) want = want.slice(0, edit.at) + edit.text + want.slice(edit.at + edit.remove);
			// The tablet's side of a clash over the word: the word gone from its line; it stands at its landing spot.
			cases.push({ p, kind: "move word", pages: one(mover.page, page(mover.page).move([mover.word.id], dx, dy)), expect: exact(want), line: mover.bodyLine, word: w, tabletShows: `${anchor.word.text} ${w}`, want });
		}

		// A whole row lassoed into empty space: listed, not dropped.
		const gaps = gapsOf(p, true);
		const lineMove = spots.find((s) => !used.has(s.word.id) && gaps.some((g) => g.page === s.page && g.above !== s.row && g.top - g.bottom > s.row.size * 3));
		if (lineMove !== undefined) {
			const gap = gaps.find((g) => g.page === lineMove.page && g.above !== lineMove.row && g.top - g.bottom > lineMove.row.size * 3)!;
			const grid = layout.grid ?? book.paper;
			const sy = grid.height / layout.pageHeight;
			const landing = (gap.top + gap.bottom) / 2;
			const dy = (lineMove.row.y + lineMove.row.size * 0.3 - landing) * sy;
			const tablet = page(lineMove.page);
			tablet.moveStrokes(tablet.rowStrokes(lineMove.row), 0, dy);
			const words = lineMove.row.lines.flatMap((line) => line.words).sort((a, b) => a.id - b.id).map((word) => word.text).join(" ");
			const pending: PendingChange[] = [{ page: lineMove.page, text: `“${words}” moved — not next to any word, so its new place in the text is unclear` }];
			cases.push({ p, kind: "move line into space", pages: one(lineMove.page, tablet), expect: exact(withPendingCallout(body, pending)) });
		}

		// A bar in the margin beside a one-line paragraph: quoted.
		const lines = body.split("\n");
		const barred = take((s) => s.row.lines[0].role === "paragraph" && (lines[s.bodyLine - 1] ?? "").trim() === "" && (lines[s.bodyLine + 1] ?? "").trim() === "");
		if (barred !== undefined) {
			const want = lines.map((line, index) => (index === barred.bodyLine ? `> ${line}` : line)).join("\n");
			cases.push({
				p,
				kind: "margin bar",
				pages: one(barred.page, page(barred.page).marginBar(barred.row)),
				expect: (got, changes) => {
					const bars = changes.marks.filter((mark) => mark.kind === "margin");
					return got === want ? null : `${where(got, want)}; read as [${changes.marks.map((m) => m.kind).join(",")}], ${bars.filter((m) => (m.blocks ?? []).length === 0).length} margin mark(s) without blocks`;
				},
			});
		}

		// A tick in the box of an open task.
		const tasks = lines.flatMap((line, index) => (/^\s*[-*+] \[ \] /.test(line) ? [index] : []));
		const task = layout.lines.find(
			(line) =>
				line.checkbox !== undefined &&
				!line.checkbox.checked &&
				line.text.trim().length > 3 &&
				layout.lines.filter((other) => other.checkbox !== undefined && other.text === line.text).length === 1 &&
				tasks.filter((index) => lines[index].includes(line.text.trim())).length === 1,
		);
		if (task !== undefined) {
			const index = tasks.find((at) => lines[at].includes(task.text.trim()))!;
			const want = lines.map((line, at) => (at === index ? line.replace("[ ]", "[x]") : line)).join("\n");
			cases.push({ p, kind: "tick", pages: one(task.page, page(task.page).tick(task)), expect: exact(want) });
		}

		// The owner's real ink written under a row: one remark, placed after that row's block.
		const inks = shuffled(vault.inks, next);
		let remark: { gap: Gap; ink: InkStrokes; at: { x: number; y: number } } | undefined;
		for (const gap of shuffled(gaps, next)) {
			for (const { ink } of inks.slice(0, 40)) {
				const at = placeIn(p, gap, ink);
				if (at !== null) {
					remark = { gap, ink, at };
					break;
				}
			}
			if (remark !== undefined) break;
		}
		if (remark !== undefined) {
			const { gap, ink, at } = remark;
			const aboveWord = gap.above.lines.flatMap((line) => line.words).find((word) => occurrences(body, word.text).length === 1 && WORDISH.test(word.text));
			const anchorLine = aboveWord === undefined ? undefined : lineIndexAt(body, occurrences(body, aboveWord.text)[0]);
			cases.push({
				p,
				kind: "remark",
				pages: one(gap.page, page(gap.page).write(...inkAt(ink, at))),
				extra: reading(real.entry.deviceDocId),
				line: anchorLine,
				expect: (got, changes) => {
					const notes = changes.marks.filter((mark) => mark.kind === "note");
					if (notes.length !== 1 || notes[0].id === undefined) return `${notes.length} remark mark(s), kinds ${changes.marks.map((m) => m.kind).join(",")}`;
					const want = calloutLines("> [!note] Remark", READING, notes[0].path!, notes[0].id);
					const at = insertedBlock(body, got, want);
					if (at === -1) {
						const added = inserted(body, got);
						return added === null ? `not one inserted block: ${where(got, body)}` : `inserted block is not the remark callout: ${added.lines.map(shape).join(" ")}`;
					}
					if (anchorLine !== undefined) {
						const wanted = (notes[0].quote ?? "").trim().split(/\s+/).slice(0, 4);
						const flat = layout.lines.flatMap((line) => line.words.map((word) => ({ word, page: line.page })));
						const runs = flat.flatMap((entry, k) => (wanted.every((text, n) => flat[k + n]?.word.text === text) ? [`p${entry.page}`] : []));
						const why = `quote is the row above: ${notes[0].quote === gap.above.text}, its first ${wanted.length} words laid out at ${runs.join(",") || "nowhere"}, ink on p${gap.page}`;
						if (at <= anchorLine) return `placed at line ${at + 1}, before its row's line ${anchorLine + 1} (${why})`;
						const between = got.split("\n").slice(Math.max(0, anchorLine - 1), at + 1);
						if (between.slice(2).some((line) => /^#{1,6} /.test(line))) return `placed past the next heading (${why}): ${between.slice(0, 30).map(shape).join(" ")}`;
					}
					return null;
				},
			});
		}

		// A page added on the tablet, with real ink on it.
		const pageInk = inks.find(({ ink }) => ink.width < book.paper.width - 200 && ink.height < book.paper.height - 400);
		if (pageInk !== undefined) {
			const added = ownerPage(book.paper, inkAt(pageInk.ink, { x: -pageInk.ink.width / 2, y: 200 }));
			const n = render.pages.length + 1;
			cases.push({
				p,
				kind: "owner page",
				pages: new Map([[`${real.entry.deviceDocId}/owner-page.rm`, added]]),
				extra: reading(real.entry.deviceDocId),
				expect: (got, changes) => {
					const notes = changes.marks.filter((mark) => mark.kind === "note");
					if (notes.length !== 1 || notes[0].addedPage !== n) return `${notes.length} added-page mark(s)`;
					const want = calloutLines(`> [!note] Page added on the reMarkable (page ${n})`, READING, notes[0].path!, notes[0].id!);
					const block = inserted(body, got);
					if (block === null) return `not one inserted block: ${where(got, body)}`;
					return block.lines.join("\n") === want.join("\n") ? null : `inserted block is not the page's callout (${block.lines.length} lines)`;
				},
			});
		}

		// Text typed on a page: the last one, or the latest one the typing seam can write (editTypedPage refusals are counted).
		let typedOn: { n: number; bytes: Uint8Array } | undefined;
		for (let n = render.pages.length; n >= 1 && typedOn === undefined; n--) {
			try {
				typedOn = { n, bytes: page(n).type(TYPED).bytes() };
			} catch {
				typingRefused.push(`${real.docId}#${n}`);
			}
		}
		if (typedOn !== undefined) {
			const { n } = typedOn;
			cases.push({
				p,
				kind: "typed text",
				pages: new Map([[p.fileOf(n), typedOn.bytes]]),
				expect: (got) => {
					const block = inserted(body, got);
					if (block === null) return `not one inserted block: ${where(got, body)}`;
					// Verbatim; the block id naming the page's text may follow, on its own line.
					const id = typedIdLine(typedTextId(real.entry.ink!.pageIds[n - 1], TYPED));
					const shown = block.lines.join("\n");
					if (![TYPED, `${TYPED}\n${id}`, `${TYPED}\n\n${id}`].includes(shown)) return `inserted block is not the typed text: ${block.lines.map(shape).join(" ")}`;
					// After the page's text: past the last word of the page that can be found in the note.
					const last = layout.lines
						.filter((line) => line.page === n)
						.flatMap((line) => line.words)
						.sort((a, b) => b.id - a.id)
						.find((word) => WORDISH.test(word.text) && occurrences(body, word.text).length === 1);
					const lastLine = last === undefined ? -1 : lineIndexAt(body, occurrences(body, last.text)[0]);
					return block.at > lastLine ? null : `placed at line ${block.at + 1}, before the page's last word on line ${lastLine + 1}`;
				},
			});
		}
		return cases;
	}

	it("2. merges each single tablet edit on real notes into exactly the expected note change", async () => {
		const failures: Failure[] = [];
		const ran: Record<string, number> = {};
		for (const p of prepared) {
			for (const c of casesOf(p)) {
				ran[c.kind] = (ran[c.kind] ?? 0) + 1;
				const fail = (reason: string) => failures.push({ docId: p.real.docId, group: p.real.group, kind: c.kind, reason });
				try {
					const changes = await importPages(p, c.pages, c.extra);
					const first = merge(p, changes, p.real.sent.body);
					const problem = c.expect(first.body, changes);
					if (problem !== null) fail(problem);
					else if (first.outcome.conflicts !== 0) fail(`${first.outcome.conflicts} conflict(s)`);
					else if (first.projected === null && changes.marks.some((mark) => mark.kind !== "skipped")) fail("no merge base kept for the next import");
					merged.push({ c, changes, first });
				} catch (error) {
					fail(`threw ${error instanceof Error ? error.name : "error"}`);
				}
			}
		}
		const notes = prepared.length;
		report(`2. single edits on ${notes} notes (typing seam refused ${typingRefused.length} page(s): ${typingRefused.join(", ")})`, ran, failures);
		expect(failures).toEqual([]);
	}, LONG);

	it("3. merges tablet edits with concurrent vault edits: disjoint ones both stay, a clash is one callout", async () => {
		const failures: Failure[] = [];
		const ran: Record<string, number> = {};
		for (const { c, changes, first } of merged) {
			const { p } = c;
			const body = p.real.sent.body;
			const lines = body.split("\n");
			const run = (vaultEdit: string, ours: string | null, check: (result: Merged) => string | null) => {
				if (ours === null) return;
				const kind = `${c.kind} + ${vaultEdit}`;
				ran[kind] = (ran[kind] ?? 0) + 1;
				const result = merge(p, changes, ours);
				const problem = check(result);
				if (problem !== null) failures.push({ docId: p.real.docId, group: p.real.group, kind, reason: problem });
			};
			const clean = (want: string | null) => (result: Merged) =>
				result.outcome.conflicts !== 0 ? `${result.outcome.conflicts} conflict(s)` : want === null ? null : result.body === want ? null : where(result.body, want);

			// A word changed in another paragraph.
			if (c.line !== undefined) {
				const far = spotsOf(p).find((s) => Math.abs(s.bodyLine - c.line!) > 2 && s.word.text !== c.word && (c.want === undefined || occurrences(c.want, s.word.text).length === 1));
				if (far !== undefined) {
					const ours = replaceWord(body, far.word.text, VAULT_WORD);
					const want = c.want === undefined ? null : replaceWord(c.want, far.word.text, VAULT_WORD);
					run("word changed elsewhere", ours, (result) => {
						const problem = clean(want)(result);
						if (problem !== null) return problem;
						return result.body.includes(VAULT_WORD) && result.body !== ours ? null : "one side's change is missing";
					});
				}
			}

			// A line appended at the end of the note.
			const tail = body.slice(body.trimEnd().length);
			const appended = `${body.trimEnd()}\n\n${APPENDED}${tail}`;
			run("line appended", appended, (result) => {
				if (result.outcome.conflicts !== 0) return `${result.outcome.conflicts} conflict(s)`;
				if (count(result.body, APPENDED) !== 1) return "the appended line is missing";
				return result.body.replace(`\n\n${APPENDED}`, "") === first.body ? null : `the tablet's change is not as without the vault edit: ${where(result.body.replace(`\n\n${APPENDED}`, ""), first.body)}`;
			});

			// The same word edited in the vault.
			if (c.word !== undefined && c.tabletShows !== undefined) {
				run("same word edited", replaceWord(body, c.word, VAULT_WORD), (result) => {
					if (result.outcome.conflicts !== 1) return `${result.outcome.conflicts} conflict(s), want 1`;
					if (count(result.body, CONFLICT_TITLE) !== 1) return `${count(result.body, CONFLICT_TITLE)} clash callouts`;
					const callout = result.body.slice(result.body.indexOf(CONFLICT_TITLE));
					if (!result.body.slice(0, result.body.indexOf(CONFLICT_TITLE)).includes(VAULT_WORD)) return "the vault's word is lost";
					const shows = c.kind === "move word" ? result.body : callout;
					return shows.includes(c.tabletShows!) ? null : "the tablet's side is lost";
				});
			}

			// The line a remark was placed after, edited in the vault.
			if (c.kind === "remark" && c.line !== undefined) {
				const spot = spotsOf(p).find((s) => s.bodyLine === c.line);
				if (spot !== undefined) {
					const ours = replaceWord(body, spot.word.text, VAULT_WORD);
					run("remark's line edited", ours, (result) => {
						const want = replaceWord(first.body, spot.word.text, VAULT_WORD);
						return clean(want)(result);
					});
				}
			}

			// The tablet's line duplicated in the vault.
			if (c.line !== undefined && c.want !== undefined && c.kind !== "remark") {
				const ours = [...lines.slice(0, c.line + 1), lines[c.line], ...lines.slice(c.line + 1)].join("\n");
				const wantLines = c.want.split("\n");
				const want = [...wantLines.slice(0, c.line + 1), lines[c.line], ...wantLines.slice(c.line + 1)].join("\n");
				run("line duplicated", ours, clean(want));
			}
		}
		report(`3. tablet + vault edits`, ran, failures);
		expect(failures).toEqual([]);
	}, LONG);

	it("4a. imports the same pages again with the last merge as base: the note stays byte-identical", async () => {
		const failures: Failure[] = [];
		const ran: Record<string, number> = {};
		for (const { c, changes, first } of merged) {
			ran[c.kind] = (ran[c.kind] ?? 0) + 1;
			const again = merge(c.p, changes, first.body, first.projected === null ? {} : { mergedBase: first.projected });
			const plain = merge(c.p, changes, first.body);
			const fail = (reason: string) => failures.push({ docId: c.p.real.docId, group: c.p.real.group, kind: c.kind, reason });
			if (again.body !== first.body) fail(`with the merged base: ${where(again.body, first.body)}`);
			else if (plain.body !== first.body) fail(`against the text as sent: ${where(plain.body, first.body)}`);
		}
		report("4a. idempotence", ran, failures);
		expect(failures).toEqual([]);
	}, LONG);

	it("4b. sends the merged note in place on the fake cloud; the new notebook reads back as no change", async () => {
		const failures: Failure[] = [];
		const ran: Record<string, number> = {};
		for (const p of prepared) {
			const { real, book, render } = p;
			const kinds: string[] = [];
			const fail = (reason: string) => failures.push({ docId: real.docId, group: real.group, kind: `round trip (${kinds.join("+")})`, reason });
			try {
				// The edits: an erased word, a remark in real ink, typed text on another page, a page added.
				const next = random(`roundtrip:${real.docId}`);
				const spots = shuffled(spotsOf(p), next);
				const tablets = new Map<number, TabletPage>();
				const tabletOn = (n: number) => tablets.get(n) ?? tablets.set(n, new TabletPage(book, n)).get(n)!;
				if (spots[0] !== undefined) {
					tabletOn(spots[0].page).erase(spots[0].word.id);
					kinds.push("erase");
				}
				for (const gap of shuffled(gapsOf(p), next)) {
					const found = vault.inks.map(({ ink }) => ({ ink, at: placeIn(p, gap, ink) })).find((candidate) => candidate.at !== null);
					if (found !== undefined) {
						tabletOn(gap.page).write(...inkAt(found.ink, found.at!));
						kinds.push(`remark(${[...new Set(gap.above.lines.map((line) => line.role))].join("/")})`);
						break;
					}
				}
				let typed: { n: number; bytes: Uint8Array } | undefined;
				for (let n = render.pages.length; n >= 1 && typed === undefined; n--) {
					if (tablets.has(n)) continue;
					try {
						typed = { n, bytes: new TabletPage(book, n).type(TYPED).bytes() };
					} catch {
						// counted in section 2
					}
				}
				const pageInk = vault.inks.find(({ ink }) => ink.width < book.paper.width - 200 && ink.height < book.paper.height - 400);
				const planned = kinds.concat(typed === undefined ? [] : ["typed"], pageInk === undefined ? [] : ["page"]).join("+");
				ran[planned] = (ran[planned] ?? 0) + 1;

				const cloud = fakeCloud();
				const pageIds = real.entry.ink!.pageIds;
				const deviceDocId = real.entry.deviceDocId;
				const sent = await sendNotebook(cloud.api, real.sent.title, [...p.files.values()], { docId: deviceDocId, pageIds, retry: NO_WAIT });
				const tabletHash = await onTablet(cloud, deviceDocId, (files) => {
					for (const [n, tablet] of tablets) files.set(p.fileOf(n), tablet.bytes());
					if (typed !== undefined) {
						files.set(p.fileOf(typed.n), typed.bytes);
						kinds.push("typed");
					}
					if (pageInk !== undefined) {
						// The tablet keeps its page list as cPages once it synced; the owner's page goes last.
						const content = decodeJson(files.get(`${deviceDocId}.content`));
						const pages = [
							...pageIds.map((id, index) => ({ id, idx: { timestamp: "1:2", value: `p${String(index).padStart(5, "0")}` } })),
							{ id: "owner-page", idx: { timestamp: "2:1", value: "zz" } },
						];
						files.set(`${deviceDocId}.content`, encodeJson({ ...content, cPages: { pages } }));
						files.set(`${deviceDocId}/owner-page.rm`, ownerPage(book.paper, inkAt(pageInk.ink, { x: -pageInk.ink.width / 2, y: 200 })));
						kinds.push("page");
					}
				});
				expect(sent.docId).toBe(deviceDocId);

				// What the import paints, kept as the plugin keeps it: the ink by image name.
				const painted = new Map<string, InkStrokes>();
				const paint: Partial<PullDeps> = {
					renderStrokes: async (request) => {
						const path = imagePath(deviceDocId, request);
						const strokes = inkStrokesOf(request.strokes, real.entry.ink!.profile.dpi);
						if (strokes !== null) painted.set(path, request.at === undefined ? strokes : { ...strokes, at: request.at });
						return path;
					},
					transcribe: async () => ({ text: READING }),
				};
				const cloudDeps = (render: InkRender): PullDeps => ({
					listDocumentHashes: async () => new Map(),
					listDocumentFiles: async (id, hash) => (await cloud.api.getEntries(`${id}.docSchema`, hash)).entries.map(({ id: file, hash: at }) => ({ id: file, hash: at })),
					readFile: async (file) => new TextDecoder().decode(await cloud.api.getHash(file.id, file.hash)),
					readBytes: (file) => cloud.api.getHash(file.id, file.hash),
					loadInk: async () => render,
					writeAnnotations: async () => undefined,
					...paint,
				});
				const read = await collectInkAnnotations(real.entry, tabletHash, cloudDeps(render));
				const first = merge(p, read, real.sent.body);
				if (first.outcome.conflicts !== 0 || (first.outcome.pending ?? []).length !== 0) {
					fail(`first import: ${first.outcome.conflicts} conflict(s), ${(first.outcome.pending ?? []).length} pending`);
					continue;
				}
				const again = merge(p, await collectInkAnnotations(real.entry, tabletHash, cloudDeps(render)), first.body, { mergedBase: first.projected ?? undefined });
				if (again.body !== first.body) {
					const tally2 = (text: string) => ["[remark]", "[page]", "[clash]", "^typed"].map((kind) => `${kind}×${text.split("\n").map(shape).filter((s) => s === kind).length}`).join(" ");
					fail(`read again: ${where(again.body, first.body, 16)}; ${again.outcome.conflicts} conflict(s); again ${tally2(again.body)} vs first ${tally2(first.body)}`);
				}

				// The note as merged, sent into the same notebook.
				const state = new SyncState(overlayFs(vault.fs), ROOT!);
				const edge = edgeFor(state, real.entry.ink);
				await edge.prepareSend();
				const images: Record<string, Picture> = { ...(real.sent.images ?? {}) };
				for (const [path, ink] of painted) images[displayTextForLink(path, undefined)] = ink;
				const deps: SendDeps = {
					client: {
						uploadInk: () => Promise.reject(new Error("the round trip must update in place")),
						updateInk: (id, name, pages, options) =>
							sendNotebookUpdate(cloud.api, id, name, pages, { ...options, retry: NO_WAIT }).then((r) => ({ deviceDocId: r.docId, pageIds: r.pageIds, hash: r.hash })),
					},
					ink: {
						render: (blocks, title, docId, layout, pictures, drawings) => edge.renderForSend(blocks, title, docId, layout, pictures, drawings),
						loadImages: async () => images,
						loadDrawings: async () => real.sent.drawings ?? {},
						persistPending: (docId, record, mapping, previousHash, written) => state.writePending(docId, record, mapping, previousHash, written),
						commitSent: (docId, record, mapping) => state.commitSent(docId, record, mapping),
					},
					resolveEmbed: (linkpath) => {
						const name = displayTextForLink(linkpath, undefined);
						return images[name] !== undefined ? { kind: "image", name } : { kind: "missing" };
					},
					persistDocId: async () => undefined,
					layout: real.entry.pdfLayout,
				};
				const note = { path: `${real.docId}.md`, basename: real.sent.title, content: `---\nremarkable-id: ${real.docId}\n---\n${first.body}`, existingDocId: real.docId };
				const { result, table } = await sendNote(note, { [real.docId]: { ...real.entry, accountedHash: tabletHash } }, deps);
				if (!result.ok) {
					fail(`send: ${result.error.slice(0, 80)}`);
					continue;
				}
				const entry = table[real.docId];
				if (entry.deviceDocId !== deviceDocId) {
					fail("not updated in place");
					continue;
				}
				const resent = await state.readSent(real.docId);
				const regenerated = await edgeFor(state).loadInk(entry);
				if (resent?.body === undefined || regenerated === null) {
					fail("the new send cannot be regenerated");
					continue;
				}
				const back = await collectInkAnnotations(entry, cloud.hashOf(deviceDocId)!, cloudDeps(regenerated));
				const settled = mergeTabletChanges({
					base: resent.body,
					ours: first.body,
					layout: regenerated.layout,
					highlights: back.highlights,
					marks: back.marks,
					sourcePath: note.path,
					sourceName: real.docId,
					importedAt: "2026-10-27 12:30",
				});
				if (back.marks.length > 0 || back.highlights.length > 0) fail(`the new notebook reads as ${back.marks.length} mark(s) [${[...new Set(back.marks.map((m) => m.kind))].join(",")}]`);
				else if (settled.body !== first.body) fail(`the note changed on the read-back: ${where(settled.body, first.body)}`);
				else if (pageInk !== undefined) {
					const content = decodeJson<{ cPages: { pages: { id: string; deleted?: unknown }[] } }>((await filesOf(cloud, deviceDocId)).get(`${deviceDocId}.content`));
					if (content.cPages.pages.find((page) => page.id === "owner-page")?.deleted === undefined) fail("the added page stays though the note has it");
				}
			} catch (error) {
				fail(`threw ${error instanceof Error ? `${error.name}: ${error.message.slice(0, 80)}` : "error"}`);
			}
		}
		report("4b. round trip through the fake cloud", ran, failures);
		expect(failures).toEqual([]);
	}, LONG);

	it("5. reads the owner's real remark ink: one callout per remark, and confirmed readings stay", async () => {
		const failures: Failure[] = [];
		const ran: Record<string, number> = {};
		const bump = (kind: string) => (ran[kind] = (ran[kind] ?? 0) + 1);
		// Real notes already hold remarks from earlier imports: only the ones this import adds count.
		const remarks = (text: string, base: string) =>
			[text, base].map((t) => t.split("\n").filter((line) => /^> \[!note\] (Remark|Page added)/.test(line)).length).reduce((a, b) => a - b);

		// Every ink file without highlighter, written under a row of a sampled note, then written on once more.
		let at = 0;
		for (const { name, ink } of vault.inks) {
			let placed: { p: Prepared; gap: Gap; at: { x: number; y: number } } | undefined;
			for (let tries = 0; tries < prepared.length && placed === undefined; tries++) {
				const p = prepared[(at + tries) % prepared.length];
				for (const gap of gapsOf(p)) {
					const spot = placeIn(p, gap, ink);
					if (spot !== null) {
						placed = { p, gap, at: spot };
						break;
					}
				}
			}
			at++;
			const fail = (kind: string, reason: string) => failures.push({ docId: placed?.p.real.docId ?? "-", group: placed?.p.real.group ?? "-", kind, reason: `${reason} (ink ${fnv(name).toString(16)})` });
			if (placed === undefined) {
				bump("ink without room on any sampled page");
				continue;
			}
			bump("ink written as a remark");
			const { p, gap } = placed;
			const deviceDocId = p.real.entry.deviceDocId;
			const strokes = inkAt(ink, placed.at);
			// The added stroke: a short dash beside the ink, at its middle — a small part of the remark's ink however small it is.
			const box = boxOf(strokes.map((line) => ({ points: line.points })));
			const mid = (box.minY + box.maxY) / 2;
			const inkLength = strokes.reduce((sum, line) => sum + line.points.slice(1).reduce((s, pt, i) => s + Math.hypot(pt.x - line.points[i].x, pt.y - line.points[i].y), 0), 0);
			const dashLength = Math.min(16, Math.max(2, inkLength * 0.2));
			const dash = penLine([{ x: box.maxX + 12, y: mid }, { x: box.maxX + 12 + dashLength / 2, y: mid + 1 }, { x: box.maxX + 12 + dashLength, y: mid }]);
			const texts = (request: StrokeRenderRequest) => (request.strokes.length > strokes.length ? "second reading" : "first reading");
			try {
				const first = await importPages(p, new Map([[p.fileOf(gap.page), new TabletPage(p.book, gap.page).write(...strokes).bytes()]]), reading(deviceDocId, texts));
				const notes = first.marks.filter((mark) => mark.kind === "note");
				if (notes.length !== 1) {
					fail("one remark", `read as ${notes.length} remark(s) and ${first.marks.length - notes.length} other mark(s) [${[...new Set(first.marks.map((m) => m.kind))].join(",")}]`);
					continue;
				}
				const old = notes[0];
				const one = merge(p, first, p.real.sent.body);
				const base = p.real.sent.body;
				if (remarks(one.body, base) !== 1 || !one.body.includes(`^ink-${old.id}`)) {
					fail("one remark", `${remarks(one.body, base)} callout(s)`);
					continue;
				}
				// A dot has no ink to share: any stroke added outweighs it, so it is a new remark by design (isSameRemark).
				if (inkLength < 10) {
					bump("dot-sized ink, not written on");
					continue;
				}
				const second = await importPages(p, new Map([[p.fileOf(gap.page), new TabletPage(p.book, gap.page).write(...strokes, dash).bytes()]]), reading(deviceDocId, texts));
				const now = second.marks.filter((mark) => mark.kind === "note");
				if (now.length !== 1 || now[0].id === old.id) {
					fail("written on", `read as ${now.length} remark(s)${now[0]?.id === old.id ? " with the old id" : ""}`);
					continue;
				}
				const remarkInk = (id: string) => (id === old.id ? { strokes: old.strokes!, text: "first reading" } : null);
				for (const [variant, ours, text] of [
					["written on", one.body, "second reading"],
					["written on, callout edited", one.body.replace("> first reading", "> first reading, kept in the vault"), "first reading, kept in the vault"],
				] as const) {
					const after = merge(p, second, ours, { remarkInk, mergedBase: one.projected ?? undefined });
					const callout = after.body.split("\n");
					const idAt = callout.indexOf(`> ^ink-${now[0].id}`);
					let title = idAt;
					while (title > 0 && !callout[title].startsWith("> [!note]")) title--;
					if (remarks(after.body, base) !== 1) fail(variant, `${remarks(after.body, base)} callout(s): ${where(after.body, one.body)}; ${second.marks.map((m) => m.kind).join(",")}; ink length ${Math.round(inkLength)}`);
					else if (idAt === -1 || after.body.includes(`^ink-${old.id}`)) fail(variant, "the callout does not carry the new id alone");
					else if (callout[title] !== "> [!note] Remark" || callout[title + 1] !== `> ${text}`) fail(variant, "the callout's text is not the expected reading");
				}
			} catch (error) {
				fail("one remark", `threw ${error instanceof Error ? error.name : "error"}`);
			}
		}

		// Remarks whose reading the owner corrected or confirmed, at the very place they were written.
		const store = vault.samples;
		const verified = Object.entries(store?.remarks ?? {}).filter(([, record]) => record.corrected === true || record.confirmed === true);
		for (const [key, record] of verified) {
			const kind = `verified (${record.inserted === true ? "taken in as text" : record.confirmed === true ? "confirmed" : "corrected"})`;
			bump(kind);
			const lines = absoluteInk(record.strokes);
			// A page where this ink, alone, reads as one remark; else a page of its own.
			let target: { p: Prepared; page: number } | undefined;
			for (const p of prepared) {
				for (let n = 1; n <= p.render.pages.length && target === undefined; n++) {
					const marks = readMarks(lines.map((line) => ({ ...line, points: line.points.map((pt) => ({ ...pt })) })), n, p.render.layout);
					if (marks.length === 1 && marks[0].kind === "note" && marks[0].strokes.length === lines.length) target = { p, page: n };
				}
				if (target !== undefined) break;
			}
			const p = target?.p ?? prepared[0];
			const fail = (reason: string) => failures.push({ docId: p.real.docId, group: p.real.group, kind, reason: `${reason} (sample ${key.slice(0, 4)}…)` });
			const pages =
				target === undefined
					? new Map([[`${p.real.entry.deviceDocId}/owner-page.rm`, ownerPage(p.book.paper, lines)]])
					: new Map([[p.fileOf(target.page), new TabletPage(p.book, target.page).write(...lines).bytes()]]);
			const asMain: Partial<PullDeps> = {
				renderStrokes: async (request) => imagePath(p.real.entry.deviceDocId, request),
				transcribe: async (request) => ({ text: knownText(store!, remarkId(request.strokes)) ?? "machine reading" }),
			};
			try {
				const read = await importPages(p, pages, asMain);
				const notes = read.marks.filter((mark) => mark.kind === "note");
				if (notes.length !== 1) {
					fail(`read as ${notes.length} remark(s)`);
					continue;
				}
				if (notes[0].id !== key) {
					fail("its ink no longer has its id");
					continue;
				}
				const marks = withEarlierReadings(store!, read.marks);
				const result = merge(p, { highlights: read.highlights, marks }, p.real.sent.body);
				if (record.inserted === true) {
					if (result.body !== p.real.sent.body) fail(`a remark taken in as text is placed again: ${where(result.body, p.real.sent.body)}`);
					continue;
				}
				const block = inserted(p.real.sent.body, result.body);
				const shown = block?.lines.filter((line) => line.startsWith("> ") && !line.startsWith("> [!") && !line.includes("![[") && !isPluginIdLine(line)).map((line) => line.slice(2));
				if (block === null || shown === undefined) fail("not one inserted callout");
				else if (shown.join("\n") !== record.transcript) fail("the callout does not show the owner's text");
				else if (record.confirmed === true && !block.lines[0].trimEnd().endsWith("✓")) fail("the confirmation is lost");
			} catch (error) {
				fail(`threw ${error instanceof Error ? error.name : "error"}`);
			}
		}
		report(`5. real remark ink (${vault.inks.length} inks, ${verified.length} verified samples)`, ran, failures);
		expect(failures).toEqual([]);
	}, LONG);
});
