/**
 * The Obsidian-facing half of the ink fork: plugin storage, the device
 * profile, the handwriting library, the sheet commands and OCR wiring.
 *
 * Kept out of main.ts so the upstream edge stays recognisable; everything
 * here is a thin adapter over the pure modules in src/ink and src/incoming.
 */

import type { App } from "obsidian";
import { parseBlocks } from "./convert/mdblocks";
import type { PdfLayoutOptions } from "./convert/pdf";
import type { InkSnapshot, MappingEntry } from "./id/mapping";
import { builtinFont, GlyphSource } from "./ink/glyphs";
import {
	boxInk,
	buildSheet,
	learnWords,
	handSource,
	HandLibrary,
	learnHand,
	LearnResult,
	PendingSheet,
	SHEET_VERSION,
	sheetPagesToRm,
	TEST_SHEET_VERSION,
} from "./ink/handsheet";
import { fontVersionsOf, INK_SHAPE_VERSION, inkOptionsFor, makeInkFonts } from "./ink/inkfonts";
import {
	DEVICE_PROFILES,
	DeviceProfile,
	INK_PENS,
	inkPagesToRm,
	InkRender,
	renderInk,
} from "./ink/inkrender";
import { parseRmScene } from "./incoming/rmscene";
import type { Picture } from "./ink/inkimage";
import type { InkDrawing } from "./ink/inkdrawing";
import type { RoundTripSettings } from "./settingsmodel";
import type { SentRecord } from "./sync/send";
import { addSample, emptyStore, mergeStores, migrate, type SampleStore } from "./ocr/samples";
import { captureItems, type CaptureItem } from "./ocr/testcapture";
import type { DeviceItem } from "./sync/deviceimport";
import type { SyncState } from "./sync/syncstate";
import type { HttpClient } from "./transport/http";
import { readNotebook, sendNotebook, type RawSyncApi } from "./transport/notebook";
import { transcribe, type OcrExample } from "./transport/ocr";

/** What the edge needs from the plugin; structural, so main.ts stays the owner. */
export interface InkHost {
	app: App;
	manifest: { dir?: string };
	settings: RoundTripSettings;
	persist(): Promise<void>;
	/** The state every copy of the vault shares: sends, hands, word samples. */
	state: SyncState;
}

/** Known canvas sizes → their pixel density, for a detected paper size. */
const KNOWN_DPI: { width: number; height: number; dpi: number }[] = [
	DEVICE_PROFILES.rm2,
	DEVICE_PROFILES.paperpro,
	DEVICE_PROFILES.move,
];

export class InkEdge {
	private readonly hands = new Map<string, HandLibrary | null>();

	constructor(private readonly host: InkHost) {}

	/* ---------------------------- storage ---------------------------- */

	private get dir(): string {
		return (
			this.host.manifest.dir ??
			`${this.host.app.vault.configDir}/plugins/remarkable-ink-round-trip`
		);
	}

	private async readJson<T>(path: string): Promise<T | null> {
		const adapter = this.host.app.vault.adapter;
		try {
			if (!(await adapter.exists(path))) return null;
			return JSON.parse(await adapter.read(path)) as T;
		} catch {
			return null;
		}
	}

	private async writeJson(path: string, value: unknown): Promise<void> {
		const adapter = this.host.app.vault.adapter;
		const folder = path.split("/").slice(0, -1).join("/");
		if (folder !== "" && !(await adapter.exists(folder))) await adapter.mkdir(folder);
		await adapter.write(path, JSON.stringify(value));
	}

	/* ------------------------- device profile ------------------------- */

	profile(): DeviceProfile {
		const s = this.host.settings;
		if (s.inkDevice === "custom") return { ...s.inkCustomProfile };
		return { ...DEVICE_PROFILES[s.inkDevice] };
	}

	/* --------------------------- handwriting -------------------------- */

	/** Load a handwriting library version into the cache. */
	async ensureHand(version: string | undefined): Promise<HandLibrary | null> {
		if (version === undefined || version === "") return null;
		if (this.hands.has(version)) return this.hands.get(version) ?? null;
		const library =
			(await this.host.state.readHand(version)) ??
			(await this.readJson<HandLibrary>(`${this.dir}/hands/${version}.json`));
		this.hands.set(version, library);
		return library;
	}

	private handFromCache(version: string): GlyphSource | null {
		const library = this.hands.get(version);
		return library ? handSource(library) : null;
	}

	/** Characters in the active hand, for the settings status line. */
	async handSummary(): Promise<string> {
		const library = await this.ensureHand(this.host.settings.handVersion);
		if (library === null) return "No handwriting learned yet.";
		const chars = Object.keys(library.glyphs).length;
		const variants = Object.values(library.glyphs).reduce((sum, list) => sum + list.length, 0);
		return `${chars} characters learned (${variants} samples), ${library.createdAt.slice(0, 10)}.`;
	}

	/* ------------------------------ send ------------------------------ */

	/**
	 * Called before a batch of ink sends: makes sure the selected hand is
	 * loaded, since rendering itself is synchronous. Throws with a clear
	 * message when "My handwriting" is selected but none was learned.
	 */
	async prepareSend(): Promise<void> {
		const s = this.host.settings;
		if (s.inkFont !== "hand") return;
		const library = await this.ensureHand(s.handVersion);
		if (library === null) {
			throw new Error(
				'"My handwriting" is selected but none was learned yet — send the handwriting sheet first, or pick a built-in font.',
			);
		}
	}

	/** Snapshot of the current settings for one send (page ids added later). */
	private snapshotBase(): Omit<InkSnapshot, "pageIds"> {
		const s = this.host.settings;
		return {
			font: s.inkFont,
			hand: s.inkFont === "hand" ? s.handVersion : undefined,
			fallbackFont: s.inkFallbackFont,
			pen: s.inkPen,
			color: s.inkColor,
			jitter: s.inkJitter,
			profile: this.profile(),
			shape: INK_SHAPE_VERSION,
			imageStyle: s.inkImages === "placeholder" ? undefined : s.inkImages,
			...(s.inkAccents ? { accents: true as const } : {}),
			inline: true,
			quotePictures: true,
			nestedQuotes: true,
		};
	}

	renderForSend(
		blocks: ReturnType<typeof parseBlocks>,
		title: string,
		docId: string,
		layout: PdfLayoutOptions | undefined,
		images: Record<string, Picture> = {},
		drawings: Record<string, InkDrawing> = {},
	): { pages: Uint8Array[]; snapshot: Omit<InkSnapshot, "pageIds"> } {
		const base = this.snapshotBase();
		const found = inkOptionsFor({ ...base, pageIds: [] }, docId, (version) =>
			this.handFromCache(version),
		);
		if (found === null) throw new Error("The selected handwriting could not be loaded.");
		const options = {
			...found,
			images,
			drawings,
		};
		const snapshot = {
			...base,
			title,
			fontVersions: fontVersionsOf(options.fonts.body.primary, options.fonts.body.fallback),
		};
		const render = renderInk(blocks, title, layout ?? {}, options);
		return { pages: inkPagesToRm(render, options), snapshot };
	}

	/** Keep what was sent, so the import can regenerate it after edits. */
	async persistSent(docId: string, sent: SentRecord): Promise<void> {
		await this.host.state.writeSent(docId, sent);
	}

	/** What a send kept, or null when it is gone. */
	readSent(docId: string): Promise<SentRecord | null> {
		return this.host.state
			.readSent(docId)
			.then((sent) => sent ?? this.readJson<SentRecord>(`${this.dir}/sent/${docId}.json`));
	}

	upload(api: RawSyncApi, name: string, pages: Uint8Array[], parentId?: string, replaces?: string) {
		return sendNotebook(api, name, pages, { parentId, replaces }).then((result) => ({
			deviceDocId: result.docId,
			pageIds: result.pageIds,
			replaced: result.replaced === true,
		}));
	}

	/* ----------------------------- import ----------------------------- */

	/**
	 * Regenerate a handwritten send exactly: the sent text (kept at send
	 * time), the recorded typography and the recorded ink settings.
	 */
	async loadInk(
		entry: MappingEntry,
		fallback?: () => Promise<{ title: string; markdown: string } | null>,
	): Promise<InkRender | null> {
		if (entry.ink === undefined || entry.pdfLayout === undefined) return null;
		const sent: Omit<SentRecord, "body"> | null =
			(await this.readSent(entry.docId)) ?? (fallback === undefined ? null : await fallback());
		if (sent === null) return null;
		await this.ensureHand(entry.ink.hand);
		const found = inkOptionsFor(entry.ink, entry.docId, (version) => this.handFromCache(version));
		if (found === null) return null;
		// The pictures exactly as quantised at send time, never re-read from disk.
		const options = { ...found, images: sent.images, drawings: sent.drawings };
		return renderInk(
			parseBlocks(sent.markdown, {
				html: entry.ink.inline === true,
				quotePictures: entry.ink.quotePictures === true,
				nestedQuotes: entry.ink.nestedQuotes === true,
			}),
			sent.title,
			{ ...entry.pdfLayout, typo: entry.pdfLayout.typo ?? 1 },
			options,
		);
	}

	/** OCR one image, or null when OCR is off. */
	ocr(http: HttpClient, png: ArrayBuffer, quote: string | undefined, wholePage: boolean, examples: OcrExample[] = []) {
		const s = this.host.settings;
		return transcribe(
			http,
			{ endpoint: s.ocrEndpoint, model: s.ocrModel, apiKey: s.ocrApiKey },
			{ png, quote, wholePage, examples },
		);
	}

	/* ------------------------------ sheet ----------------------------- */

	/** Send a fresh handwriting sheet and remember it as pending. */
	async sendSheet(api: RawSyncApi, parentId?: string): Promise<void> {
		const profile = this.profile();
		const sheet = buildSheet(profile);
		const result = await sendNotebook(api, "Handwriting sheet", sheetPagesToRm(sheet, profile), {
			parentId,
		});
		const pending: PendingSheet = {
			deviceDocId: result.docId,
			pageIds: result.pageIds,
			profile,
			version: SHEET_VERSION,
		};
		this.host.settings.pendingSheet = pending;
		await this.host.persist();
	}

	/**
	 * Copy what older versions kept in the plugin folder — sends, hands, word
	 * samples — into the shared state, once. Returns how many sends moved.
	 */
	async migrateToState(): Promise<number> {
		const adapter = this.host.app.vault.adapter;
		const state = this.host.state;
		let moved = 0;
		const sentDir = `${this.dir}/sent`;
		if (await adapter.exists(sentDir)) {
			for (const file of (await adapter.list(sentDir)).files) {
				const docId = (file.split("/").pop() ?? "").replace(/\.json$/, "");
				const sent = await this.readJson<SentRecord>(file);
				if (sent === null || (await state.readSent(docId)) !== null) continue;
				await state.writeSent(docId, sent);
				moved++;
			}
		}
		const handsDir = `${this.dir}/hands`;
		if (await adapter.exists(handsDir)) {
			for (const file of (await adapter.list(handsDir)).files) {
				const library = await this.readJson<HandLibrary>(file);
				if (library !== null && (await state.readHand(library.version)) === null) await state.writeHand(library);
			}
		}
		const samples = await this.readJson<SampleStore>(`${this.dir}/ocr/samples.json`);
		if (samples !== null && (await state.readSamples()) === null) await state.writeSamples(samples);
		return moved;
	}

	/* ------------------------ device item cache ----------------------- */

	/** What the account's documents and folders were at their last seen hash. */
	loadDeviceItems(): Promise<Record<string, DeviceItem>> {
		return this.readJson<Record<string, DeviceItem>>(`${this.dir}/device-items.json`).then((items) => items ?? {});
	}

	saveDeviceItems(items: Record<string, DeviceItem>): Promise<void> {
		return this.writeJson(`${this.dir}/device-items.json`, items);
	}

	/* --------------------------- word samples ------------------------ */

	private samples: SampleStore | null = null;

	/** The owner's written words and remembered remarks (ocr/samples.ts). */
	async loadSamples(): Promise<SampleStore> {
		this.samples ??= migrate(
			(await this.host.state.readSamples()) ??
				(await this.readJson<unknown>(`${this.dir}/ocr/samples.json`)) ??
				emptyStore(),
		);
		return this.samples;
	}

	/** Take in what other copies of the vault learned since (they share the file). */
	async refreshSamples(): Promise<void> {
		if (this.samples === null) return;
		const disk = await this.host.state.readSamples();
		// In place: callers hold on to the store they loaded.
		if (disk !== null) Object.assign(this.samples, mergeStores(migrate(disk), this.samples));
	}

	async saveSamples(): Promise<void> {
		if (this.samples === null) return;
		await this.refreshSamples();
		await this.host.state.writeSamples(this.samples);
	}

	/** Send a fresh word sheet and remember it as pending. */
	async sendWordSheet(api: RawSyncApi, parentId?: string): Promise<void> {
		const profile = this.profile();
		const sheet = buildSheet(profile, "words");
		const result = await sendNotebook(api, "Word sheet", sheetPagesToRm(sheet, profile), { parentId });
		this.host.settings.pendingWordSheet = {
			deviceDocId: result.docId,
			pageIds: result.pageIds,
			profile,
			version: SHEET_VERSION,
			kind: "words",
		};
		await this.host.persist();
	}

	/** Read the pending word sheet into the word samples; returns the words learned. */
	async learnFromWordSheet(api: RawSyncApi): Promise<string[]> {
		const pending = this.host.settings.pendingWordSheet;
		if (pending === null) throw new Error("No word sheet has been sent yet.");
		const { pages } = await readNotebook(api, pending.deviceDocId);
		const found = learnWords(pending, new Map(pages.map((page) => [page.pageId, page.bytes])));
		const words = Object.keys(found);
		if (words.length === 0) {
			throw new Error("Nothing written on the word sheet yet — write some words on the reMarkable and let it sync.");
		}
		const store = await this.loadSamples();
		for (const word of words) addSample(store, word, found[word]);
		await this.saveSamples();
		return words;
	}

	/** Send a fresh handwriting test sheet and remember it as pending. */
	async sendTestSheet(api: RawSyncApi, parentId?: string): Promise<void> {
		const profile = this.profile();
		const sheet = buildSheet(profile, "test");
		const result = await sendNotebook(api, "Handwriting test", sheetPagesToRm(sheet, profile), { parentId });
		this.host.settings.pendingTestSheet = {
			deviceDocId: result.docId,
			pageIds: result.pageIds,
			profile,
			version: TEST_SHEET_VERSION,
			kind: "test",
		};
		await this.host.persist();
	}

	/**
	 * The ink on the pending test sheet, by prompt, not yet read. Learns
	 * nothing: the test sheet stays held out (ocr/testcapture.ts).
	 */
	async readTestSheet(api: RawSyncApi): Promise<{ pending: PendingSheet; items: CaptureItem[] }> {
		const pending = this.host.settings.pendingTestSheet;
		if (pending === null) throw new Error("No handwriting test sheet has been sent yet.");
		const { pages } = await readNotebook(api, pending.deviceDocId);
		const ink = boxInk(pending, new Map(pages.map((page) => [page.pageId, page.bytes])), "test");
		const items = captureItems(buildSheet(pending.profile, "test", pending.version).boxes, ink);
		if (items.length === 0) {
			throw new Error("Nothing written on the test sheet yet — copy some lines on the reMarkable and let it sync.");
		}
		return { pending, items };
	}

	/** Read the pending sheet back into a (new or extended) library. */
	async learnFromSheet(api: RawSyncApi, addVariants: boolean): Promise<LearnResult> {
		const pending = this.host.settings.pendingSheet;
		if (pending === null) throw new Error("No handwriting sheet has been sent yet.");
		const { pages } = await readNotebook(api, pending.deviceDocId);
		const byId = new Map(pages.map((page) => [page.pageId, page.bytes]));
		const previous = addVariants ? await this.ensureHand(this.host.settings.handVersion) : null;
		const result = learnHand(pending, byId, previous);
		if (result.learned.length === 0) {
			throw new Error(
				"Nothing written on the sheet yet — fill in some boxes on the reMarkable and let it sync.",
			);
		}
		await this.host.state.writeHand(result.library);
		this.hands.set(result.library.version, result.library);
		this.host.settings.handVersion = result.library.version;
		await this.host.persist();
		return result;
	}

	/**
	 * Read the paper size from notebooks on the account (newest first) and
	 * switch to it. A notebook made on the tablet carries its canvas in the
	 * page's scene info; ours carry the size we wrote, so they are skipped.
	 */
	async detectPageSize(
		api: RawSyncApi,
		candidates: { id: string; name: string }[],
	): Promise<{ profile: DeviceProfile; from: string } | null> {
		const ours = new Set(Object.values(this.host.settings.mappings).map((entry) => entry.deviceDocId));
		if (this.host.settings.pendingSheet !== null) ours.add(this.host.settings.pendingSheet.deviceDocId);
		if (this.host.settings.pendingWordSheet !== null) ours.add(this.host.settings.pendingWordSheet.deviceDocId);
		if (this.host.settings.pendingTestSheet !== null) ours.add(this.host.settings.pendingTestSheet.deviceDocId);
		for (const candidate of candidates) {
			if (ours.has(candidate.id)) continue;
			try {
				const { pages } = await readNotebook(api, candidate.id);
				for (const page of pages) {
					const size = parseRmScene(page.bytes).paperSize;
					if (size === undefined) continue;
					const known = KNOWN_DPI.find((p) => p.width === size.width && p.height === size.height);
					const profile: DeviceProfile = {
						width: size.width,
						height: size.height,
						dpi: known?.dpi ?? Math.round((size.width / 1404) * 226),
					};
					this.host.settings.inkCustomProfile = profile;
					this.host.settings.inkDevice = known
						? known === DEVICE_PROFILES.rm2
							? "rm2"
							: known === DEVICE_PROFILES.paperpro
								? "paperpro"
								: "move"
						: "custom";
					await this.host.persist();
					return { profile, from: candidate.name };
				}
			} catch {
				// Not readable as a notebook (a PDF, an EPUB): try the next one.
			}
		}
		return null;
	}
}

/** Default pen for display, so settings can describe what "medium" means. */
export const PEN_LABELS: Record<keyof typeof INK_PENS, string> = {
	fine: "Fine",
	medium: "Medium",
	bold: "Bold",
};

/** Fonts for an ad-hoc preview (settings sample, tests). */
export function previewFonts(fontId: string) {
	return makeInkFonts(builtinFont(fontId), builtinFont("readability"));
}
