/**
 * reMarkable Round-Trip — Obsidian plugin edge (PRD F1, F4, F5).
 *
 * Everything Obsidian-specific lives here: commands, context menus, vault
 * access and the requestUrl-based HTTP adapter (mobile-safe, N7). The actual
 * pipeline (preprocess → PDF → upload → mapping) is pure and lives in src/.
 */

import {
	App,
	Menu,
	Notice,
	Platform,
	Plugin,
	TAbstractFile,
	TFile,
	TFolder,
	loadMermaid,
	requestUrl,
} from "obsidian";
import {
	ProgressHandle,
	ProgressStatus,
	notify,
	progressNotice,
	updateProgress,
} from "./notify";
import type { ProgressCount } from "./status";
import { SyncStatusModal } from "./syncstatusmodal";
import { buildSyncStatusSummary } from "./sync/statussummary";
import {
	DEFAULT_SETTINGS,
	RoundTripSettings,
	RoundTripSettingTab,
	extrasFrom,
	sendLayout,
	settingsFrom,
	storedFrom,
} from "./settings";
import { remarkable } from "rmapi-js";
import { HttpClient } from "./transport/http";
import {
	OFFICIAL_ENDPOINTS,
	RemarkableCloudClient,
	rmfakecloudEndpoints,
} from "./transport/cloud";
import { installFetchShim, ShimTransport } from "./transport/fetchshim";
import { MirrorTransport, toTransportError } from "./transport/mirror";
import {
	describeByteCompat,
	describeDiagnosis,
	diagnoseCloud,
} from "./transport/diagnose";
import { ByteCompatReport, installByteCompat } from "./transport/bytescompat";
import { EmbedContent } from "./preprocess/preprocess";
import { DOCID_FRONTMATTER_KEY, generateDocId } from "./id/docid";
import { NoteInput, SendResult, notesNeedingUpload, sendBatch } from "./sync/send";
import { mergeTabletChanges } from "./sync/twoway";
import { SyncState, type StateFs } from "./sync/syncstate";
import { findNewNotebooks, importedNote, noteFileName, writtenByPlugin } from "./sync/deviceimport";
import { parseRmScene } from "./incoming/rmscene";
import { readNotebook } from "./transport/notebook";
import { parsePageOrder } from "./incoming/pagemap";
import { parseRmPage } from "./incoming/rmlines";
import { confirmAllRemarks, confirmRemarkAt, findRemark, remarkAt, remarkId } from "./incoming/remarkid";
import { highlightedText, insertRemarkText } from "./incoming/remarkinsert";
import { RemarkControls } from "./remarkui";
import { RemarkOverlays } from "./remarkoverlayui";
import { resolveLayoutOptions } from "./convert/pdf";
import { Lexicon, lettersTemplates, OCR_TRUST, recognize, Template, templatesFrom } from "./ocr/recognize";
import { WordReader } from "./ocr/words";
import { WRITEPAD_TRUST, WritePad } from "./ocr/writepad";
import {
	acceptRemark,
	corrections,
	describeUnlearned,
	knownText,
	learnFromNotes,
	notedReadings,
	refOf,
	type ReaderName,
	rememberRemark,
	remarkText,
	type RemarkRecord,
	scoreAbove,
	withEarlierReadings,
} from "./ocr/samples";
import { datasetInfo, datasetJsonl, trainingSamples } from "./ocr/trainingset";
import type { OcrExample, OcrConnection } from "./transport/ocr";
import { checkConnection } from "./transport/ocr";
import type { NdjsonClient } from "./transport/ollama";
import { nodeNdjson } from "./transport/nodestream";
import { setUpLocalOllama } from "./ollamasetup";
import { builtinFont } from "./ink/glyphs";
import {
	DocumentFile,
	ImportedMark,
	PullResult,
	SourceState,
	StrokeRenderRequest,
	mergePullMappings,
	pullAnnotations,
} from "./incoming/pull";
import { renderImportReport } from "./incoming/report";
import { paintPlan, planRender } from "./incoming/strokerender";
import { MappingEntry, MappingTable, contentHash } from "./id/mapping";
import { displayTextForLink, parseFrontmatter, preprocess, splitNote } from "./preprocess/preprocess";
import type { AnnotationOutcome } from "./incoming/annotationnote";
import { WatchQueue, parseFolderList } from "./sync/watcher";
import { PullQueue, PushQueue, SyncQueueCoordinator } from "./sync/queues";
import type { RawSyncApi } from "./transport/notebook";
import type { Highlight } from "./incoming/highlights";
import { flattenSelection, relativeFolderPath } from "./sync/selection";
import { shouldAnnounceUpdate } from "./updatenotice";
import { InkEdge } from "./inkedge";
import { gridSizeFor, InkImage, InkStrokes, inkStrokesOf, Picture, quantizeImage } from "./ink/inkimage";
import { PEN, PEN_COLOR } from "./ink/rmwrite";
import { diagramKey, InkDrawing } from "./ink/inkdrawing";
import { extractDrawing } from "./ink/svgextract";
import { mermaidBlocks, withInkTheme } from "./ink/mermaidtheme";

const IMAGE_EXTENSIONS = new Set([
	"png",
	"jpg",
	"jpeg",
	"gif",
	"bmp",
	"svg",
	"webp",
	"avif",
]);
const MAX_EMBED_DEPTH = 3;
const EMBED_SCAN_RE = /!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
// Quiet period before a watch-folder note is sent: long enough to survive a
// typing session, short enough to feel automatic (F6).
const WATCH_DEBOUNCE_MS = 15000;
// rmapi-js' default low-level host; part of the fetch-shim allowlist.
const RAW_HOST = "https://eu.tectonic.remarkable.com";

export default class RoundTripPlugin extends Plugin {
	settings: RoundTripSettings = { ...DEFAULT_SETTINGS };
	private watchQueue: WatchQueue | null = null;
	private readonly syncCoordinator = new SyncQueueCoordinator();
	private readonly pushQueue = new PushQueue(this.syncCoordinator);
	private readonly pullQueue = new PullQueue(this.syncCoordinator);
	private progressStatus: ProgressStatus | null = null;
	private fetchShim: { restore: () => void } | null = null;
	/** Unknown data.json keys, preserved across saves (see extrasFrom). */
	private extraData: Record<string, unknown> = {};
	private syncRunning: Promise<void> | null = null;
	/** Progress of the upload batch running now, for the status panel. */
	private uploading: { done: number; total: number } | null = null;
	/** Built-in OCR: templates per handwriting version, the vault's words per run. */
	private templates: { key: string; templates: Template[] } | null = null;
	private lexicon: Promise<Lexicon> | null = null;
	private words: WordReader | null = null;
	/** The WritePad engine for joined-up writing, knowing the vault's words; per run. */
	private writepad: Promise<WritePad | null> | null = null;
	private samplesDirty = false;
	private syncTimer: number | null = null;
	private remarkOverlays: RemarkOverlays | null = null;
	/** What every copy of the vault shares (sync/syncstate.ts); set up on load. */
	state: SyncState = new SyncState(vaultFs(this.app), DEFAULT_SETTINGS.syncStateFolder);
	/** Ink fork: handwritten notebooks, the handwriting library, OCR. */
	readonly ink = ((plugin: RoundTripPlugin) =>
		new InkEdge({
			get app() {
				return plugin.app;
			},
			get manifest() {
				return plugin.manifest;
			},
			get settings() {
				return plugin.settings;
			},
			get state() {
				return plugin.state;
			},
			persist: () => plugin.persistSettings(),
		}))(this);
	/** Regenerated handwritten sends during one import run (ink fork). */
	private readonly inkCache = new Map<string, Promise<import("./ink/inkrender").InkRender | null>>();
	/** Which bytes-conversion methods came from the polyfill (GP_E5_S19). */
	private byteCompat: ByteCompatReport = {
		toHex: true,
		toBase64: true,
		fromHex: true,
		fromBase64: true,
	};

	async onload(): Promise<void> {
		await this.loadSettings();
		// Before anything can call rmapi-js: it uses the ES2025 bytes methods
		// directly, which an older Obsidian installer's Electron may lack
		// (GP_E5_S19). Installing here, once, covers every remarkable() call
		// for the plugin's lifetime.
		this.byteCompat = installByteCompat();
		if (!Platform.isMobile) {
			this.progressStatus = new ProgressStatus(this.addStatusBarItem());
		}
		this.addSettingTab(new RoundTripSettingTab(this.app, this));
		this.setupWatcher();
		this.setupFetchShim();

		// Subtle "what's changed" notice (GP_E5_S3) — deferred to layout-ready
		// so it never adds to startup noise.
		this.app.workspace.onLayoutReady(() => {
			void this.checkForUpdateNotice();
		});

		this.registerEvent(
			this.app.vault.on("modify", (file) =>
				this.watchQueue?.noteChanged(file.path),
			),
		);
		this.registerEvent(
			this.app.vault.on("create", (file) =>
				this.watchQueue?.noteChanged(file.path),
			),
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				this.watchQueue?.noteRemoved(oldPath);
				this.watchQueue?.noteChanged(file.path);
			}),
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) =>
				this.watchQueue?.noteRemoved(file.path),
			),
		);

		this.addRibbonIcon("tablet", "reMarkable sync", (event) => {
			const menu = new Menu();
			menu.addItem((item) =>
				item
					.setTitle("Sync now")
					.setIcon("refresh-cw")
					.onClick(() => void this.syncNow()),
			);
			menu.addItem((item) =>
				item
					.setTitle("Sync status")
					.setIcon("activity")
					.onClick(() => this.openSyncStatus()),
			);
			menu.showAtMouseEvent(event);
		});
		this.addCommand({
			id: "sync-now",
			name: "Sync with reMarkable now",
			callback: () => void this.syncNow(),
		});
		// After a change that alters how notebooks look but not what notes say
		// (fonts, colours, an update): unchanged notes are otherwise left as sent.
		this.addCommand({
			id: "resend-all",
			name: "Re-send every synced note to reMarkable",
			callback: () => void this.resendAll(),
		});
		this.addCommand({
			id: "show-sync-status",
			name: "Show sync status",
			callback: () => this.openSyncStatus(),
		});
		this.addCommand({
			id: "check-cloud-status",
			name: "Check reMarkable cloud status (read-only)",
			callback: () => void this.checkCloudStatus(),
		});
		this.addCommand({
			id: "send-current-note",
			name: "Sync current note with reMarkable",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (!checking) void this.sendFiles([file]);
				return true;
			},
		});
		// Reads the notebook again even when the tablet reports no change.
		this.addCommand({
			id: "import-annotations-current-note-force",
			name: "Re-read current note from reMarkable",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || this.syncedEntry(file) === undefined) return false;
				if (!checking) void this.pullAnnotations({ only: [file], force: true });
				return true;
			},
		});
		this.addCommand({
			id: "send-handwriting-sheet",
			name: "Send handwriting sheet to reMarkable",
			callback: () => void this.sendHandwritingSheet(),
		});
		this.addCommand({
			id: "learn-handwriting",
			name: "Learn my handwriting from the sheet",
			callback: () => void this.learnHandwriting(false),
		});
		this.addCommand({
			id: "learn-handwriting-variants",
			name: "Add handwriting variations from the sheet",
			callback: () => void this.learnHandwriting(true),
		});
		this.addCommand({
			id: "send-word-sheet",
			name: "Send joined-up word sheet to reMarkable",
			callback: () => void this.sendWordSheet(),
		});
		this.addCommand({
			id: "learn-word-sheet",
			name: "Learn my joined-up words from the sheet",
			callback: () => void this.learnWordSheet(),
		});
		// Ink fork: confirm or correct a handwritten remark's reading in the note.
		const remarkControls = new RemarkControls(this.app, (file, id) => this.insertRemark(file, id));
		this.registerMarkdownPostProcessor(remarkControls.process);
		// Ink fork: unconfirmed remarks drawn faded over the text, where they were written (#29).
		this.remarkOverlays = new RemarkOverlays(this.app, {
			enabled: () => this.settings.inkRemarkOverlay,
			readInk: (imageName) => this.state.readInk(imageName),
			layoutFor: (notePath) =>
				resolveLayoutOptions(Object.values(this.settings.mappings).find((entry) => entry.notePath === notePath)?.pdfLayout),
		});
		this.registerMarkdownPostProcessor(this.remarkOverlays.process);
		this.registerEditorExtension(this.remarkOverlays.extension);
		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (file instanceof TFile) this.remarkOverlays?.changed(file);
			}),
		);
		this.addCommand({
			id: "confirm-remark-reading",
			name: "Confirm handwriting reading at cursor",
			editorCheckCallback: (checking, editor) => {
				const note = editor.getValue();
				const line = editor.getCursor().line;
				const remark = remarkAt(note, line);
				if (remark === null || remark.confirmed || remark.text === "") return false;
				if (!checking) {
					const confirmed = confirmRemarkAt(note, line);
					if (confirmed !== null) editor.setLine(remark.title, confirmed.split("\n")[remark.title]);
				}
				return true;
			},
		});
		this.addCommand({
			id: "correct-remark-reading",
			name: "Correct handwriting reading at cursor",
			editorCheckCallback: (checking, editor, view) => {
				const remark = remarkAt(editor.getValue(), editor.getCursor().line);
				if (remark === null || view.file === null) return false;
				if (!checking) remarkControls.openEditor(view.file, remark.id);
				return true;
			},
		});
		this.addCommand({
			id: "insert-remark-as-text",
			name: "Insert handwriting reading as text at cursor",
			editorCheckCallback: (checking, editor, view) => {
				const remark = remarkAt(editor.getValue(), editor.getCursor().line);
				if (remark === null || remark.text === "" || view.file === null) return false;
				if (!checking) void this.insertRemark(view.file, remark.id);
				return true;
			},
		});
		this.addCommand({
			id: "confirm-all-remark-readings",
			name: "Confirm all handwriting readings in this note",
			editorCallback: (editor) => {
				const before = editor.getValue().split("\n");
				const { note, confirmed } = confirmAllRemarks(editor.getValue());
				// Line by line, so the cursor and undo history stay as they are.
				note.split("\n").forEach((line, i) => {
					if (line !== before[i]) editor.setLine(i, line);
				});
				notify(confirmed === 0 ? "No unconfirmed handwriting readings in this note." : `Confirmed ${confirmed} handwriting reading(s).`);
			},
		});
		this.addCommand({
			id: "export-handwriting-training-set",
			name: "Export handwriting corrections as training data",
			callback: () => void this.exportTrainingSet(),
		});
		this.addCommand({
			id: "detect-page-size",
			name: "Detect reMarkable page size from my notebooks",
			callback: () => void this.detectPageSize(),
		});

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
				if (file instanceof TFile && file.extension === "md") {
					menu.addItem((item) =>
						item
							.setTitle("Sync with reMarkable")
							.setIcon("refresh-cw")
							.onClick(() => void this.sendFiles([file])),
					);
				}
				if (file instanceof TFolder) {
					menu.addItem((item) =>
						item
							.setTitle("Sync folder with reMarkable")
							.setIcon("refresh-cw")
							// The folder keeps its internal structure on the device
							// even when vault mirroring is off (GP_E5_S2).
							.onClick(
								() =>
									void this.sendFiles(collectMarkdownFiles(file), {
										structureRoot: folderParentPath(file),
									}),
							),
					);
				}
			}),
		);

		// Multi-selection in the file explorer: Obsidian fires `files-menu`
		// instead of `file-menu`. The selection can mix notes and folders.
		this.registerEvent(
			this.app.workspace.on(
				"files-menu",
				(menu: Menu, selection: TAbstractFile[]) => {
					const notes = collectFromSelection(selection);
					if (notes.length === 0) return;
					menu.addItem((item) =>
						item
							.setTitle(
								notes.length === 1
									? "Sync 1 note with reMarkable"
									: `Sync ${notes.length} notes with reMarkable`,
							)
							.setIcon("refresh-cw")
							.onClick(() => void this.sendFiles(notes)),
					);
				},
			),
		);

		this.app.workspace.onLayoutReady(() => {
			if (this.settings.autoSync) void this.syncNow({ background: true });
		});
		this.setupSyncTimer();
	}

	private openSyncStatus(): void {
		const localPaths = new Set(
			this.app.vault.getMarkdownFiles().map((file) => file.path),
		);
		const watchPaths = new Set<string>();
		const watchFolders = this.settings.watchFolderEnabled
			? parseFolderList(this.settings.watchFolderPath)
			: [];
		for (const path of watchFolders) {
			const folder = this.app.vault.getFolderByPath(path);
			if (folder) {
				for (const file of collectMarkdownFiles(folder))
					watchPaths.add(file.path);
			}
		}
		new SyncStatusModal(this.app, {
			mode: this.settings.mirrorFolders ? "On" : "Off (flat uploads)",
			watchFolder: watchFolders.length > 0 ? watchFolders.join(", ") : "Disabled",
			summary: buildSyncStatusSummary({
				mappings: this.settings.mappings,
				localPaths,
				watchPaths,
				live: {
					...this.syncCoordinator.status(),
					pendingChanges: this.watchQueue?.status().pendingChanges ?? 0,
					uploading: this.uploading ?? undefined,
				},
			}),
		}).open();
	}

	private progress(message: string, count?: ProgressCount): ProgressHandle {
		return (
			this.progressStatus?.begin(message, count) ?? progressNotice(message)
		);
	}

	async loadSettings(): Promise<void> {
		const stored = ((await this.loadData()) ??
			{}) as Partial<RoundTripSettings>;
		this.settings = settingsFrom(stored);
		// Unknown data.json keys — a newer version's settings, hand-added
		// flags — ride along in extraData so a save does not destroy them
		// (bevinding eigenaar 2026-08-13; the spike flag that surfaced it is
		// gone since GP_E7_S2, the preservation stays).
		this.extraData = extrasFrom(stored);
		await this.openState(stored.mappings ?? {});
	}

	/**
	 * Read the mappings from the shared state folder. Mappings an older
	 * version kept in data.json — the first time, or a device that synced on
	 * its own until now — join them; where both know a note, the shared state
	 * wins. Sends, hands and word samples follow once.
	 */
	private async openState(legacy: MappingTable): Promise<void> {
		this.state = new SyncState(vaultFs(this.app), this.settings.syncStateFolder);
		const shared = await this.state.loadMappings();
		this.settings.mappings = { ...legacy, ...shared };
		if (Object.keys(legacy).some((docId) => shared[docId] === undefined)) {
			const moved = await this.ink.migrateToState();
			await this.state.saveMappings(this.settings.mappings);
			await this.saveData(storedFrom({ ...this.settings, mappings: {} }, this.extraData));
			notify(
				`reMarkable sync state now lives in “${this.settings.syncStateFolder}” (${moved} send record(s) moved), ` +
					"so every copy of the vault shares it.",
				10000,
			);
		}
		if (this.state.unreadable.length > 0) {
			notify(
				`reMarkable sync state: ${this.state.unreadable.length} file(s) could not be read (a merge conflict?): ` +
					this.state.unreadable.slice(0, 3).join(", "),
				15000,
			);
		}
	}

	/** Take in what other copies of the vault synced since (a git pull). */
	private async refreshState(): Promise<void> {
		this.settings.mappings = await this.state.refresh(this.settings.mappings);
	}

	/**
	 * Obsidian calls this when data.json changed outside this running plugin
	 * — Obsidian Sync, or a hand edit while the app runs. Without it, the
	 * next save would write the stale in-memory snapshot back and erase that
	 * edit (reviewvondst 0.35.1).
	 */
	async onExternalSettingsChange(): Promise<void> {
		await this.syncCoordinator.enqueue("pull", async () => {
			await this.loadSettings();
			this.remarkOverlays?.sync();
			this.setupWatcher();
			this.setupFetchShim();
			this.setupSyncTimer();
		});
	}

	async saveSettings(): Promise<void> {
		await this.syncCoordinator.enqueue("pull", async () => {
			await this.persistSettings();
			this.remarkOverlays?.sync();
			this.setupWatcher();
			this.setupFetchShim();
			this.setupSyncTimer();
		});
	}

	/** Persist runtime state without disrupting active or queued sync work. */
	async persistSettings(): Promise<void> {
		// The mappings live in the shared state folder, not with this device's settings.
		await this.saveData(storedFrom({ ...this.settings, mappings: {} }, this.extraData));
		if (this.state.root !== this.settings.syncStateFolder) {
			this.state = new SyncState(vaultFs(this.app), this.settings.syncStateFolder);
		}
		await this.state.saveMappings(this.settings.mappings);
	}

	onunload(): void {
		this.watchQueue?.dispose();
		this.watchQueue = null;
		this.syncCoordinator.dispose();
		this.fetchShim?.restore();
		this.fetchShim = null;
		this.dropWritePad();
	}

	/**
	 * rmapi-js uses the global fetch, which is CORS-bound in Obsidian; route
	 * only the reMarkable hosts through requestUrl (see fetchshim.ts, N7).
	 */
	private setupFetchShim(): void {
		// Reinstalling swaps in a fresh concurrency gate; requests already
		// holding a slot in the old one finish there (briefly allowing up to
		// 2× the cap in flight), while its queued tail is rejected by
		// restore() — accepted: a settings change mid-send may abort that
		// send's remaining mirror calls, which resurface as a clear error.
		this.fetchShim?.restore();
		const hosts = [
			OFFICIAL_ENDPOINTS.authHost,
			OFFICIAL_ENDPOINTS.docHost,
			RAW_HOST,
		];
		if (
			this.settings.useCustomEndpoint &&
			this.settings.customEndpointUrl !== ""
		) {
			hosts.push(this.settings.customEndpointUrl.replace(/\/+$/, ""));
		}
		const transport: ShimTransport = async (request) => {
			const response = await requestUrl({
				url: request.url,
				method: request.method,
				headers: request.headers,
				body: request.body,
				throw: false,
			});
			return {
				status: response.status,
				headers: response.headers,
				arrayBuffer: response.arrayBuffer,
			};
		};
		// The default scope: the window this bundle (and rmapi-js inside it)
		// was loaded in — the only realm whose `fetch` rmapi-js ever calls.
		// Passing activeWindow here would patch a popped-out window instead
		// whenever one had focus during a settings save, leaving the real
		// fetch CORS-bound on desktop (GP_E5_S9).
		this.fetchShim = installFetchShim(hosts, transport);
	}

	/** rmapi-js host options; rmfakecloud serves all three from one base (F7). */
	private rmapiOptions(): {
		authHost?: string;
		uploadHost?: string;
		rawHost?: string;
	} {
		if (
			this.settings.useCustomEndpoint &&
			this.settings.customEndpointUrl !== ""
		) {
			const base = this.settings.customEndpointUrl.replace(/\/+$/, "");
			return { authHost: base, uploadHost: base, rawHost: base };
		}
		return {};
	}

	/** (Re)build the watch queue from the current settings (F6). */
	private setupWatcher(): void {
		this.watchQueue?.dispose();
		this.watchQueue = null;
		const folders = parseFolderList(this.settings.watchFolderPath);
		if (!this.settings.autoSync || !this.settings.watchFolderEnabled || folders.length === 0) return;
		this.watchQueue = new WatchQueue({
			folders,
			debounceMs: WATCH_DEBOUNCE_MS,
			setTimer: (fn, ms) => window.setTimeout(fn, ms),
			clearTimer: (id) => window.clearTimeout(id),
			onReady: (paths) => {
				const files = paths
					.map((path) => this.app.vault.getFileByPath(path))
					.filter((file): file is TFile => file instanceof TFile);
				if (files.length > 0) void this.sendFiles(files, { auto: true });
			},
		});
	}

	createClient(): RemarkableCloudClient {
		const endpoints =
			this.settings.useCustomEndpoint && this.settings.customEndpointUrl !== ""
				? rmfakecloudEndpoints(this.settings.customEndpointUrl)
				: OFFICIAL_ENDPOINTS;
		return new RemarkableCloudClient({
			http: obsidianHttp,
			endpoints,
			deviceToken: this.settings.deviceToken,
		});
	}

	/**
	 * Send notes. In `auto` mode (watch folder) unchanged notes are skipped
	 * and an all-skipped run stays silent — errors always surface.
	 */
	/**
	 * GP_E5_S3: show a one-time notice when the installed version stepped up a
	 * minor or major version since last seen — never for a patch bump, and
	 * never when the toggle is off. The stored version always advances when it
	 * differs (patch bump or toggle-off included), so a later minor/major jump
	 * is judged from the right baseline.
	 */
	private async checkForUpdateNotice(): Promise<void> {
		const current = this.manifest.version;
		const prev = this.settings.lastSeenVersion;

		if (shouldAnnounceUpdate(prev, current) && this.settings.showUpdateNotice) {
			const [major, minor] = current.split(".");
			// Ink fork: no release page of its own; the changelog ships with it.
			new Notice(`reMarkable Ink Round-Trip updated to ${major}.${minor} — see CHANGELOG-INK.md.`, 8000);
		}

		if (current !== prev) {
			this.settings.lastSeenVersion = current;
			await this.persistSettings();
		}
	}

	/**
	 * Two-way sync (the whole round trip in one go): read every synced
	 * notebook and merge what changed on the tablet into its note, then send
	 * every note in the sync folders or with a notebook already that is new
	 * or out of date — the merged ones included. In the background it stays silent unless
	 * something actually happened.
	 */
	syncNow(options: { background?: boolean } = {}): Promise<void> {
		if (this.settings.deviceToken === "") {
			if (options.background !== true) {
				notify("Not paired with a reMarkable account yet — open the plugin settings first.");
			}
			return Promise.resolve();
		}
		if (this.syncRunning !== null) return this.syncRunning;
		this.syncRunning = (async () => {
			try {
				const changed = await this.pullAnnotations({ background: options.background });
				// Notebooks started on the tablet: in as notes, then out below as ink.
				const imported = await this.importNewNotebooks(options.background === true);
				for (const path of imported) changed.add(path);
				const files = new Map<string, TFile>();
				for (const file of this.syncFolderFiles()) files.set(file.path, file);
				// A note synced once from outside the folders stays in sync too.
				for (const entry of Object.values(this.settings.mappings)) {
					if (entry.format !== "ink") continue;
					const file = this.resolveNote(entry);
					if (file !== null) files.set(file.path, file);
				}
				for (const path of changed) {
					const file = this.app.vault.getFileByPath(path);
					if (file !== null) files.set(file.path, file);
				}
				if (files.size === 0) return;
				await this.sendFiles([...files.values()], {
					auto: true,
					pullFirst: false,
					background: options.background,
				});
			} finally {
				this.syncRunning = null;
			}
		})();
		return this.syncRunning;
	}

	/**
	 * Bring notebooks started on the tablet into the vault (sync/deviceimport.ts):
	 * those in the device folder of a synced vault folder that the plugin did
	 * not write. Each becomes a note — page images and their text — mapped to
	 * the original, so the send that follows replaces it with a handwritten
	 * notebook of the note. Returns the new notes' paths.
	 */
	private importNewNotebooks(background: boolean): Promise<string[]> {
		const created: string[] = [];
		if (!this.settings.watchFolderEnabled || !this.settings.mirrorFolders) return Promise.resolve(created);
		return this.pullQueue
			.enqueue("import-new-notebooks", () => this.runImportNewNotebooks(created))
			.then(() => created)
			.catch((error: unknown) => {
				const message = toTransportError(error).message;
				if (background) console.warn(`reMarkable Ink Round-Trip: importing new notebooks failed — ${message}`);
				else notify(`Importing new notebooks failed: ${message}`, 10000);
				return created;
			});
	}

	private async runImportNewNotebooks(created: string[]): Promise<void> {
		this.examples = null;
		const api = await remarkable(this.settings.deviceToken, this.rmapiOptions());
		const cache = await this.ink.loadDeviceItems();
		const live = await api.listIds(true);
		const present = new Set<string>();
		for (const { id, hash } of live) {
			present.add(id);
			if (cache[id]?.hash === hash) continue;
			try {
				const meta = await api.getMetadata(id, hash);
				cache[id] = {
					id,
					hash,
					type: meta.type,
					parent: meta.parent,
					visibleName: meta.visibleName,
					lastModified: meta.lastModified,
				};
			} catch {
				// One unreadable item must not stop the rest; it is tried again next time.
			}
		}
		for (const id of Object.keys(cache)) if (!present.has(id)) delete cache[id];
		const known = new Set(Object.values(this.settings.mappings).map((entry) => entry.deviceDocId));
		for (const sheet of [this.settings.pendingSheet, this.settings.pendingWordSheet]) {
			if (sheet !== null) known.add(sheet.deviceDocId);
		}
		const found = findNewNotebooks(Object.values(cache), {
			baseFolder: this.settings.deviceBaseFolder,
			vaultFolders: parseFolderList(this.settings.watchFolderPath),
			known,
			now: Date.now(),
			quietMs: 10 * 60_000,
		});
		for (const notebook of found) {
			const { pages, content } = await readNotebook(api.raw, notebook.id);
			if (content === null || (JSON.parse(content) as { fileType?: string }).fileType !== "notebook") {
				cache[notebook.id] = { ...cache[notebook.id], notNotebook: true };
				continue;
			}
			if (pages.some((page) => writtenByPlugin(parseRmScene(page.bytes).authors))) {
				cache[notebook.id] = { ...cache[notebook.id], ours: true };
				continue;
			}
			const order = parsePageOrder(content);
			pages.sort((a, b) => order.indexOf(a.pageId) - order.indexOf(b.pageId));
			const written: { image?: string; text?: string }[] = [];
			for (const [index, page] of pages.entries()) {
				const strokes = parseRmPage(page.bytes).strokes;
				if (strokes.length === 0) continue;
				const request: StrokeRenderRequest = {
					deviceDocId: notebook.id,
					strokes,
					page: index + 1,
					remark: 1,
					wholePage: true,
				};
				const image = this.settings.importHandwriting ? await this.renderHandwriting(request) : null;
				const read =
					this.settings.ocrMode === "builtin"
						? await this.recognizeLocally(request)
						: this.settings.ocrMode === "endpoint"
							? await this.transcribeStrokes(request).catch(() => null)
							: null;
				const text = read?.text ?? null;
				written.push({ ...(image === null ? {} : { image }), ...(text === null ? {} : { text }) });
			}
			const docId = generateDocId();
			const base = [notebook.folder, noteFileName(notebook.name)].filter((part) => part !== "").join("/");
			let path = `${base}.md`;
			for (let n = 2; this.app.vault.getFileByPath(path) !== null; n++) path = `${base} (${n}).md`;
			await this.writeVaultFile(path, importedNote(docId, written));
			this.settings.mappings = {
				...this.settings.mappings,
				[docId]: {
					docId,
					notePath: path,
					deviceDocId: notebook.id,
					uploadedAt: new Date().toISOString(),
					contentHash: "",
					format: "device",
				},
			};
			await this.persistSettings();
			created.push(path);
		}
		if (this.samplesDirty) {
			await this.ink.saveSamples();
			this.samplesDirty = false;
		}
		await this.ink.saveDeviceItems(cache);
		if (created.length > 0) notify(`Brought ${created.length} notebook(s) from the reMarkable into the vault.`);
	}

	/** Write every note that has a notebook into a fresh one, read back first as always. */
	private async resendAll(): Promise<void> {
		await this.refreshState();
		const files = new Map<string, TFile>();
		for (const entry of Object.values(this.settings.mappings)) {
			const file = this.resolveNote(entry);
			if (file !== null) files.set(file.path, file);
		}
		if (files.size === 0) {
			notify("No synced notes yet.");
			return;
		}
		notify(`Re-sending ${files.size} note(s) — the reMarkable cloud paces this, so it takes a while.`, 8000);
		await this.sendFiles([...files.values()]);
	}

	/** Every note in the sync folders, when they are on. */
	private syncFolderFiles(): TFile[] {
		if (!this.settings.watchFolderEnabled) return [];
		const out: TFile[] = [];
		for (const path of parseFolderList(this.settings.watchFolderPath)) {
			const folder = this.app.vault.getFolderByPath(path);
			if (folder !== null) out.push(...collectMarkdownFiles(folder));
		}
		return out;
	}

	/** (Re)start the background sync interval from the current settings. */
	private setupSyncTimer(): void {
		if (this.syncTimer !== null) window.clearInterval(this.syncTimer);
		this.syncTimer = null;
		const minutes = this.settings.syncIntervalMinutes;
		if (!this.settings.autoSync || !(minutes > 0)) return;
		this.syncTimer = window.setInterval(
			() => void this.syncNow({ background: true }),
			minutes * 60_000,
		);
		this.registerInterval(this.syncTimer);
	}

	/**
	 * Send notes as handwritten notebooks. A note that already has a notebook
	 * gets that notebook read first, so ink not yet in the note is merged
	 * before the notebook is replaced. In `auto` mode unchanged notes are
	 * skipped and an all-skipped run stays silent — errors always surface.
	 */
	async sendFiles(
		files: TFile[],
		options: {
			auto?: boolean;
			structureRoot?: string;
			/** Read the existing notebooks first (default); a sync already did. */
			pullFirst?: boolean;
			background?: boolean;
		} = {},
	): Promise<void> {
		if (files.length === 0) {
			if (options.background !== true) notify("No markdown notes to send.");
			return;
		}
		const client = this.createClient();
		if (!client.isRegistered) {
			if (options.background !== true) {
				notify("Not paired with a reMarkable account yet — open the plugin settings first.");
			}
			return;
		}
		if (options.pullFirst !== false) {
			const synced = files.filter((file) => this.syncedEntry(file) !== undefined);
			if (synced.length > 0) {
				await this.pullAnnotations({ only: synced, background: true });
			}
		}
		await this.refreshState();
		const notes: NoteInput[] = [];
		const embedMaps = new Map<string, Map<string, EmbedContent>>();
		try {
			for (const file of files) {
				const content = await this.app.vault.read(file);
				notes.push({
					path: file.path,
					basename: file.basename,
					content,
					// A note just written (one brought in from the tablet) may not be
					// in the metadata cache yet: its own frontmatter has the id too.
					existingDocId:
						getFrontmatterValue(this.app.metadataCache.getFileCache(file)?.frontmatter, DOCID_FRONTMATTER_KEY) ??
						parseFrontmatter(content).fields[DOCID_FRONTMATTER_KEY],
				});
				embedMaps.set(file.path, await this.buildEmbedMap(file));
			}
		} catch (error) {
			notify(error instanceof Error ? error.message : String(error), 10000);
			return;
		}
		let queuedNotes = notes;
		if (options.auto) {
			try {
				queuedNotes = notesNeedingUpload(
					notes,
					this.settings.mappings,
					(linkpath, notePath) =>
						embedMaps.get(notePath)?.get(linkpath) ?? { kind: "missing" },
					this.settings.frontmatterAsTitleBlock,
				);
			} catch (error) {
				notify(error instanceof Error ? error.message : String(error), 10000);
				return;
			}
		}
		const queuedPaths = new Set(queuedNotes.map((note) => note.path));
		const queuedFiles = files.filter((file) => queuedPaths.has(file.path));
		const structureOnly =
			!this.settings.mirrorFolders && options.structureRoot !== undefined;
		const mirrorFoldersActive = this.settings.mirrorFolders || structureOnly;
		let mirror: MirrorTransport | null = null;
		let rawApi: RawSyncApi | null = null;
		const parentIds = new Map<string, string>();
		const targetFolder = (notePath: string): string => {
			const dir = notePath.split("/").slice(0, -1).join("/");
			return structureOnly
				? relativeFolderPath(dir, options.structureRoot ?? "")
				: dir;
		};

		await this.pushQueue
			.enqueue({
				ensureFolders: async () => {
					if (queuedFiles.length === 0) return;
					await this.ink.prepareSend();
					try {
						const api = await remarkable(
							this.settings.deviceToken,
							this.rmapiOptions(),
						);
						rawApi = api.raw;
						mirror = new MirrorTransport(
							api,
							mirrorFoldersActive && !structureOnly
								? this.settings.deviceBaseFolder
								: "",
						);
						if (!mirrorFoldersActive) return;

						const targets = [
							...new Set(queuedFiles.map((file) => targetFolder(file.path))),
						].sort(
							(a, b) =>
								a.split("/").filter(Boolean).length -
									b.split("/").filter(Boolean).length || a.localeCompare(b),
						);
						for (const target of targets) {
							parentIds.set(target, await mirror.ensureFolderPath(target));
						}
					} catch (error) {
						console.error(
							"reMarkable Round-Trip: folder preparation failed",
							error,
						);
						throw toTransportError(error);
					}
				},
				uploadFiles: async () => {
					if (queuedNotes.length === 0) return;
					const notice = this.progress(
						`Sending 0/${queuedNotes.length} to reMarkable…`,
						{ done: 0, total: queuedNotes.length },
					);
					this.uploading = { done: 0, total: queuedNotes.length };
					try {
						const activeMirror = mirror;
						const activeRaw = rawApi;
						const { results, table } = await sendBatch(
							queuedNotes,
							this.settings.mappings,
							{
								client: {
									uploadInk: (visibleName, pages, uploadOptions) => {
										if (activeRaw === null) {
											return Promise.reject(new Error("The reMarkable sync API is not available right now."));
										}
										return this.ink
											.upload(activeRaw, visibleName, pages, uploadOptions.parentId, uploadOptions.replaces)
											.catch((error: unknown) => {
												throw toTransportError(error);
											});
									},
								},
								ink: {
									render: (blocks, title, docId, layout, images, drawings) =>
										this.ink.renderForSend(blocks, title, docId, layout, images, drawings),
									loadImages: (note) => this.noteImages(note),
									loadDrawings: (markdown) => this.noteDrawings(markdown),
									persistSent: (docId, sent) => this.ink.persistSent(docId, sent),
								},
								resolveParent:
									activeMirror && mirrorFoldersActive
										? (notePath) => {
												const target = targetFolder(notePath);
												if (!parentIds.has(target)) {
													return Promise.reject(
														new Error(
															`Device folder was not prepared for "${notePath}".`,
														),
													);
												}
												return Promise.resolve(parentIds.get(target) ?? "");
											}
										: undefined,
								// The old notebook's ink was pulled into the note just
								// before this send, so it can go.
								replacePrevious: activeMirror
									? (previousId) => activeMirror.trashPrevious(previousId)
									: undefined,
								resolveEmbed: (linkpath, notePath) =>
									embedMaps.get(notePath)?.get(linkpath) ?? { kind: "missing" },
								persistDocId: async (note, docId) => {
									const file = this.app.vault.getFileByPath(note.path);
									if (!file) return;
									await this.app.fileManager.processFrontMatter(file, (fm) => {
										(fm as Record<string, unknown>)[DOCID_FRONTMATTER_KEY] =
											docId;
									});
								},
								layout: sendLayout(this.settings),
								frontmatterAsTitleBlock: this.settings.frontmatterAsTitleBlock,
								skipUnchanged: options.auto === true,
							},
							(done, total) => {
								this.uploading = { done, total };
								updateProgress(notice, `Sending ${done}/${total} to reMarkable…`, { done, total });
							},
							async (checkpoint) => {
								this.settings.mappings = checkpoint;
								await this.persistSettings();
							},
						);

						this.settings.mappings = table;
						await this.persistSettings();
						reportResults(results, {
							quietWhenAllSkipped: options.auto === true,
							quiet: options.background === true,
						});
					} finally {
						this.uploading = null;
						notice.hide();
					}
				},
			})
			.catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				if (options.background === true) console.warn(`reMarkable Ink Round-Trip: ${message}`);
				else notify(`${message} No notes were uploaded.`, 10000);
			});
	}

	/** The mapping entry of a note that has a handwritten notebook, if any. */
	private syncedEntry(file: TFile): MappingEntry | undefined {
		const docId = getFrontmatterValue(
			this.app.metadataCache.getFileCache(file)?.frontmatter,
			DOCID_FRONTMATTER_KEY,
		);
		if (typeof docId !== "string") return undefined;
		const entry = this.settings.mappings[docId];
		return entry?.format === "ink" ? entry : undefined;
	}

	/**
	 * The safety-net copy (N5): the full previous note, in a `previous`
	 * folder under the import folder, named deterministically so a second
	 * import overwrites its own backup instead of piling up copies. The
	 * docId key is renamed in the copy — resolveNote finds notes by that id,
	 * and a backup carrying the live id could hijack a lookup after the
	 * original moved.
	 */
	private async writePreviousVersion(
		file: TFile,
		entry: MappingEntry,
		content: string,
	): Promise<string> {
		const folder = this.settings.backupFolder.replace(/^\/+|\/+$/g, "") || "previous";
		const { head, body } = splitNote(content);
		const safeHead = head.replace(
			new RegExp(`^${DOCID_FRONTMATTER_KEY}(?=\\s*:)`, "m"),
			`${DOCID_FRONTMATTER_KEY}-previous`,
		);
		const path = `${folder}/${file.basename} (${entry.docId.slice(0, 8)}).md`;
		await this.writeVaultFile(path, safeHead + body);
		return path;
	}

	/** Create or overwrite a vault file, creating missing folders on the way. */
	private async writeVaultFile(path: string, content: string): Promise<void> {
		await this.ensureParentFolders(path);
		const existing = this.app.vault.getFileByPath(path);
		if (existing !== null) await this.app.vault.modify(existing, content);
		else await this.app.vault.create(path, content);
	}

	private async writeVaultBinary(path: string, content: ArrayBuffer): Promise<void> {
		await this.ensureParentFolders(path);
		const existing = this.app.vault.getFileByPath(path);
		if (existing !== null) await this.app.vault.modifyBinary(existing, content);
		else await this.app.vault.createBinary(path, content);
	}

	private async ensureParentFolders(path: string): Promise<void> {
		const segments = path.split("/").slice(0, -1).filter((segment) => segment !== "");
		let prefix = "";
		for (const segment of segments) {
			prefix = prefix === "" ? segment : `${prefix}/${segment}`;
			if (this.app.vault.getFolderByPath(prefix) === null) {
				await this.app.vault.createFolder(prefix);
			}
		}
	}

	/**
	 * Pre-read all (nested) markdown embeds of a note so the pure preprocess
	 * step can resolve them synchronously.
	 */
	async buildEmbedMap(root: TFile): Promise<Map<string, EmbedContent>> {
		const map = new Map<string, EmbedContent>();
		let frontier: { linkpath: string; fromPath: string }[] = scanEmbeds(
			await this.app.vault.cachedRead(root),
			root.path,
		);
		for (
			let depth = 0;
			depth < MAX_EMBED_DEPTH && frontier.length > 0;
			depth++
		) {
			const next: { linkpath: string; fromPath: string }[] = [];
			for (const { linkpath, fromPath } of frontier) {
				if (map.has(linkpath)) continue;
				const target = this.app.metadataCache.getFirstLinkpathDest(
					linkpath.split("#")[0],
					fromPath,
				);
				if (!target) {
					map.set(linkpath, { kind: "missing" });
				} else if (IMAGE_EXTENSIONS.has(target.extension.toLowerCase())) {
					// A remark whose position was recorded goes back as ink in place.
					const inPlace =
						this.settings.inkRemarks === "in-place" &&
						(await this.state.readInk(target.name).catch(() => null))?.at !== undefined;
					map.set(linkpath, { kind: "image", name: target.basename, ...(inPlace ? { inPlace } : {}) });
				} else if (target.extension === "md") {
					const content = await this.app.vault.cachedRead(target);
					map.set(linkpath, { kind: "markdown", content });
					next.push(...scanEmbeds(content, target.path));
				} else {
					map.set(linkpath, { kind: "image", name: target.name });
				}
			}
			frontier = next;
		}
		return map;
	}

	/**
	 * Read-only account check (GP_E3_S5): tells a user whether a sync problem
	 * lives in the cloud or on the tablet, without touching anything.
	 */
	checkCloudStatus(): Promise<void> {
		return this.pullQueue.enqueue("cloud-status", () =>
			this.runCheckCloudStatus(),
		);
	}

	private async runCheckCloudStatus(): Promise<void> {
		if (this.settings.deviceToken === "") {
			notify(
				"Not paired with a reMarkable account yet — open the plugin settings first.",
			);
			return;
		}
		const notice = this.progress("Reading your reMarkable cloud account…");
		try {
			const api = await remarkable(
				this.settings.deviceToken,
				this.rmapiOptions(),
			);
			const diagnosis = await diagnoseCloud(
				{
					getRootHash: () => api.raw.getRootHash(),
					listItems: () => api.listItems(true),
				},
				this.settings.mappings,
			);
			const report = `${describeDiagnosis(diagnosis)}\n${describeByteCompat(this.byteCompat)}`;
			// On mobile a Notice scrolls away and there is no console to open,
			// so put the report on the clipboard: it can be pasted into a note
			// or a bug report.
			let copied = false;
			try {
				await navigator.clipboard.writeText(report);
				copied = true;
			} catch {
				// Clipboard access can be denied; the notice below still shows it.
			}
			notify(copied ? `${report}\n\n(Copied to clipboard.)` : report, 30000);
		} catch (error) {
			notify(toTransportError(error).message, 15000);
		} finally {
			notice.hide();
		}
	}

	/** The mapping entry of a note whose last send was a REVIEW copy, if any. */
	/**
	 * Read the notebooks of every synced note — or, with `only`, of those
	 * notes — and merge what changed on the tablet into the notes. Resolves
	 * to the paths of the notes it changed.
	 */
	async pullAnnotations(
		options: { force?: boolean; only?: TFile[]; background?: boolean } = {},
	): Promise<Set<string>> {
		const scopeKey = options.only?.map((file) => file.path).join("|") ?? "all";
		const key = `annotations:${options.force === true ? "force" : "changed"}:${scopeKey}`;
		// A run deduplicated onto an identical one already queued leaves this
		// set empty: that run's caller sends what it changed.
		const changed = new Set<string>();
		await this.pullQueue.enqueue(key, () => this.runPullAnnotations(options, changed));
		return changed;
	}

	private async runPullAnnotations(
		options: { force?: boolean; only?: TFile[]; background?: boolean },
		changed: Set<string>,
	): Promise<void> {
		const quiet = options.background === true;
		let scope = this.settings.mappings;
		if (options.only !== undefined) {
			scope = {};
			for (const file of options.only) {
				const entry = this.syncedEntry(file);
				if (entry !== undefined) scope[entry.docId] = entry;
			}
		}
		const mappings = Object.keys(scope).length;
		if (mappings === 0) {
			if (!quiet && options.only !== undefined) notify("This note has no notebook on the reMarkable yet.");
			return;
		}
		if (this.settings.deviceToken === "") {
			if (!quiet) notify("Not paired with a reMarkable account yet — open the plugin settings first.");
			return;
		}

		await this.refreshState();
		const log: string[] = [];
		this.inkCache.clear();
		this.remarkImages.clear();
		this.examples = null;
		this.lexicon = null;
		this.words = null;
		this.dropWritePad();
		await this.reconcileNotePaths((line) => log.push(line));
		await this.learnFromCorrections((line) => log.push(line)).catch((error: unknown) =>
			log.push(`learning from corrections failed: ${String(error)}`),
		);
		const startedAt = new Date().toISOString().slice(0, 16).replace("T", " ");
		const notice = quiet ? null : this.progress(`Checking ${mappings} notebook(s) on the reMarkable…`);
		try {
			const api = await remarkable(this.settings.deviceToken, this.rmapiOptions());
			const { results, table } = await pullAnnotations(
				scope,
				{
					force: options.force,
					yieldToPush: () => this.syncCoordinator.yieldToPush(),
					isCurrent: (entry) =>
						this.settings.mappings[entry.docId]?.deviceDocId === entry.deviceDocId,
					log: (line) => log.push(line),
					listDocumentHashes: async () => {
						const items = await api.listIds(true);
						return new Map(items.map((item) => [item.id, item.hash]));
					},
					listDocumentFiles: async (deviceDocId, hash) => {
						// The document's file index is addressed as `<id>.docSchema`
						// — the same name rmapi-js uses internally (GP_E3_S6).
						const { entries } = await api.raw.getEntries(`${deviceDocId}.docSchema`, hash);
						return entries.map((entry): DocumentFile => ({ id: entry.id, hash: entry.hash }));
					},
					readFile: (file) => api.raw.getText(file.id, file.hash),
					readBytes: (file) => api.raw.getHash(file.id, file.hash),
					renderStrokes: this.settings.importHandwriting
						? (request) => this.renderHandwriting(request)
						: undefined,
					checkSource: (entry) => this.checkSource(entry),
					loadInk: (entry) => this.loadInkRender(entry),
					transcribe:
						this.settings.ocrMode === "builtin"
							? (request) => this.recognizeLocally(request)
							: this.settings.ocrMode === "endpoint"
								? (request) => this.transcribeStrokes(request)
								: undefined,
					keepImageWithTranscript: this.settings.ocrKeepImage,
					writeAnnotations: (entry, highlights, marks, sourceState) =>
						this.applyTabletChanges(entry, highlights, marks, changed, sourceState),
				},
				(done, total) => {
					if (notice !== null) {
						updateProgress(notice, `Checking ${done}/${total} on the reMarkable…`, { done, total });
					}
				},
			);
			// A scoped run returns only its slice; merging keeps the rest, and
			// drops what the run found gone from the account (GP_E5_S17).
			this.settings.mappings = mergePullMappings(this.settings.mappings, scope, table);
			await this.persistSettings();
			if (this.samplesDirty) {
				await this.ink.saveSamples();
				this.samplesDirty = false;
			}

			const eventful = results.some(
				(r) => !r.ok || r.removed === true || r.scan?.written !== undefined,
			);
			if (eventful || !quiet) {
				const report = `${renderImportReport({
					results,
					forced: options.force === true,
					startedAt,
					pluginVersion: this.manifest.version,
					handwritingEnabled: this.settings.importHandwriting,
					ocrDiagnostics: this.settings.ocrDiagnostics,
				})}\n\n--- details ---\n${log.join("\n")}`;
				await this.deliverReport(report, !quiet);
			}
			reportPullResults(results, quiet);
		} catch (error) {
			const failure = toTransportError(error).message;
			if (quiet) {
				console.warn(`reMarkable Ink Round-Trip: sync failed — ${failure}`);
				return;
			}
			await this.deliverReport(
				`reMarkable Ink Round-Trip — sync report (${startedAt})\nplugin ${this.manifest.version}\n\n` +
					`Run failed: ${failure}\n\n--- details ---\n${log.join("\n")}`,
				true,
			);
			notify(failure, 10000);
		} finally {
			notice?.hide();
		}
	}

	/**
	 * Make a diagnostic report reachable on mobile: written to a note in the
	 * vault (so it survives and can be shared) and copied to the clipboard.
	 */
	private async deliverReport(report: string, clipboard = true): Promise<void> {
		if (clipboard) {
			try {
				await navigator.clipboard.writeText(report);
			} catch {
				// Clipboard may be denied; the note below is the durable copy.
			}
		}
		try {
			const path = "reMarkable Ink Round-Trip log.md";
			const existing = this.app.vault.getFileByPath(path);
			const body = `\`\`\`\n${report}\n\`\`\`\n`;
			if (existing) {
				await this.app.vault.modify(existing, body);
			} else {
				await this.app.vault.create(path, body);
			}
		} catch {
			// Writing the log must never break the import itself.
		}
	}

	/**
	 * The note a mapping points at. Obsidian lets you move and rename freely,
	 * so the path recorded at send time is a hint, not an identity — the
	 * `remarkable-id` in the frontmatter is (K3). Looking it up that way keeps
	 * a moved note working instead of quietly losing its annotations
	 * (GP_E3_S3).
	 */
	private resolveNote(entry: MappingEntry): TFile | null {
		const atPath = this.app.vault.getFileByPath(entry.notePath);
		if (atPath !== null) return atPath;
		for (const file of this.app.vault.getMarkdownFiles()) {
			const frontmatter =
				this.app.metadataCache.getFileCache(file)?.frontmatter;
			if (frontmatter?.[DOCID_FRONTMATTER_KEY] === entry.docId) return file;
		}
		return null;
	}

	/**
	 * Bring the recorded paths back in line with the vault before a run, so a
	 * moved or renamed note keeps its notebook.
	 */
	private async reconcileNotePaths(log: (line: string) => void): Promise<void> {
		let changed = false;
		for (const entry of Object.values(this.settings.mappings)) {
			if (this.app.vault.getFileByPath(entry.notePath) !== null) continue;
			const found = this.resolveNote(entry);
			if (found === null || found.path === entry.notePath) continue;
			log(`note moved: ${entry.notePath} → ${found.path}`);
			this.settings.mappings = {
				...this.settings.mappings,
				[entry.docId]: { ...entry, notePath: found.path },
			};
			changed = true;
		}
		if (changed) await this.persistSettings();
	}

	/** Does the note still match the document that was sent? (F14) */
	private async checkSource(entry: MappingEntry): Promise<SourceState> {
		if (entry.pdfLayout === undefined) return "no-snapshot";
		const file = this.resolveNote(entry);
		if (file === null) return "missing";
		const moved = file.path !== entry.notePath;
		// Preprocess exactly as a send does, or the two would disagree about
		// whether the note changed.
		const embeds = await this.buildEmbedMap(file);
		const pre = preprocess(await this.app.vault.read(file), {
			resolveEmbed: (linkpath) => embeds.get(linkpath) ?? { kind: "missing" },
			frontmatterAsTitleBlock: this.settings.frontmatterAsTitleBlock,
		});
		if (contentHash(pre.markdown) !== entry.contentHash) return "changed";
		return moved ? "moved" : "match";
	}

	/* ------------------------- ink fork methods ------------------------- */

	/** Regenerate a handwritten send, once per import run. */
	private loadInkRender(entry: MappingEntry): Promise<import("./ink/inkrender").InkRender | null> {
		let pending = this.inkCache.get(entry.docId);
		if (pending === undefined) {
			// Errors propagate: the import logs the reason (“could not
			// regenerate: …”) instead of a bare null.
			pending = this.ink.loadInk(entry, () => this.unchangedSentText(entry));
			this.inkCache.set(entry.docId, pending);
		}
		return pending;
	}

	/**
	 * The note as it was sent, rebuilt from the vault — only while it still
	 * matches the recorded hash. The fallback for a send whose stored text
	 * went missing (a reinstall, a cleaned plugin folder).
	 */
	private async unchangedSentText(
		entry: MappingEntry,
	): Promise<{ title: string; markdown: string } | null> {
		const file = this.resolveNote(entry);
		if (file === null) return null;
		const embeds = await this.buildEmbedMap(file);
		const pre = preprocess(await this.app.vault.cachedRead(file), {
			resolveEmbed: (linkpath) => embeds.get(linkpath) ?? { kind: "missing" },
			frontmatterAsTitleBlock: this.settings.frontmatterAsTitleBlock,
		});
		if (contentHash(pre.markdown) !== entry.contentHash) return null;
		// The title as sent: a renamed note must not regenerate a different
		// first line (it would no longer match the page on the tablet).
		return { title: entry.ink?.title ?? file.basename, markdown: pre.markdown };
	}

	/**
	 * The pictures a note embeds, decoded and quantised for hatching, keyed by
	 * the name their placeholder line carries — the same display text the
	 * preprocessing writes into `*[image: …]*`. Embedded notes are followed
	 * as deep as the preprocessing follows them.
	 */
	private async noteImages(note: NoteInput): Promise<Record<string, Picture>> {
		const out: Record<string, Picture> = {};
		const placeholders = this.settings.inkImages === "placeholder";
		const seen = new Set<string>();
		const visit = async (content: string, sourcePath: string, depth: number): Promise<void> => {
			for (const match of content.matchAll(/!\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g)) {
				const target = match[1].trim();
				const alias = match[2];
				const file = this.app.metadataCache.getFirstLinkpathDest(target.split("#")[0], sourcePath);
				if (file === null) continue;
				if (IMAGE_EXTENSIONS.has(file.extension.toLowerCase())) {
					const names = [displayTextForLink(target, alias), file.basename].filter(
						(name) => out[name] === undefined,
					);
					if (names.length === 0) continue;
					// Ink from the tablet goes back as its own strokes.
					const image =
						(await this.remarkInk(file)) ?? (placeholders ? null : await this.decodeImage(file, alias));
					if (image !== null) for (const name of names) out[name] = image;
				} else if (file.extension === "md" && depth < MAX_EMBED_DEPTH && !seen.has(file.path)) {
					seen.add(file.path);
					await visit(await this.app.vault.cachedRead(file), file.path, depth + 1);
				}
			}
			for (const match of content.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)) {
				const alt = match[1].trim();
				const path = match[2].trim().split(/\s+/)[0];
				if (alt === "" || /^[a-z]+:/i.test(path) || out[alt] !== undefined) continue;
				let decoded = path;
				try {
					decoded = decodeURI(path);
				} catch {
					// keep the raw path
				}
				const file = this.app.metadataCache.getFirstLinkpathDest(decoded, sourcePath);
				if (file === null || !IMAGE_EXTENSIONS.has(file.extension.toLowerCase())) continue;
				const image = (await this.remarkInk(file)) ?? (placeholders ? null : await this.decodeImage(file));
				if (image !== null) out[alt] = image;
			}
		};
		await visit(note.content, note.path, 0);
		return out;
	}

	/**
	 * The tablet ink a vault image was drawn from, if it was: its stroke record,
	 * or — for remarks read before records were kept — the shapes the built-in
	 * reader remembered, in a plain black pen.
	 */
	private async remarkInk(file: TFile): Promise<InkStrokes | null> {
		const recorded = await this.state.readInk(file.name);
		if (recorded !== null) return recorded;
		const remembered = (await this.ink.loadSamples()).remarks[file.path];
		if (remembered === undefined) return null;
		return inkStrokesOf(
			remembered.strokes.map((points) => ({
				tool: PEN.fineliner,
				color: PEN_COLOR.black,
				thicknessScale: 2,
				points: points.map((p) => ({ ...p, width: 16 })),
			})),
			this.ink.profile().dpi,
		);
	}

	/**
	 * Decode a picture with the platform's own decoders, scale it to the
	 * hatching grid on a canvas (over white, so transparency is paper) and
	 * quantise it. An Obsidian size alias (`|300`, `|300x200`) sets its size.
	 */
	private async decodeImage(file: TFile, alias?: string): Promise<InkImage | null> {
		try {
			const bytes = await this.app.vault.readBinary(file);
			const ext = file.extension.toLowerCase();
			const type = ext === "svg" ? "image/svg+xml" : ext === "jpg" ? "image/jpeg" : `image/${ext}`;
			const blob = new Blob([bytes], { type });
			let source: CanvasImageSource;
			let width: number;
			let height: number;
			try {
				const bitmap = await createImageBitmap(blob);
				source = bitmap;
				width = bitmap.width;
				height = bitmap.height;
			} catch {
				// SVG and some formats only decode through an <img>.
				const url = URL.createObjectURL(blob);
				try {
					const img = createEl("img");
					img.src = url;
					await img.decode();
					source = img;
					width = img.naturalWidth || 300;
					height = img.naturalHeight || 300;
				} finally {
					window.setTimeout(() => URL.revokeObjectURL(url), 1000);
				}
			}
			if (width <= 0 || height <= 0) return null;
			const grid = gridSizeFor(width, height);
			const canvas = createEl("canvas");
			canvas.width = grid.width;
			canvas.height = grid.height;
			const context = canvas.getContext("2d");
			if (context === null) return null;
			context.fillStyle = "#ffffff";
			context.fillRect(0, 0, grid.width, grid.height);
			context.drawImage(source, 0, 0, grid.width, grid.height);
			const pixels = context.getImageData(0, 0, grid.width, grid.height);
			const size = /^\s*(\d+)(?:\s*x\s*(\d+))?\s*$/.exec(alias ?? "");
			const shownWidth = size === null ? width : Number(size[1]);
			const shownHeight =
				size === null ? height : size[2] !== undefined ? Number(size[2]) : (height * shownWidth) / width;
			return quantizeImage(pixels.data, grid.width, grid.height, shownWidth, shownHeight);
		} catch (error) {
			console.warn(`reMarkable Ink Round-Trip: could not decode ${file.path}`, error);
			return null;
		}
	}

	/**
	 * The note's Mermaid diagrams, rendered with Obsidian's own Mermaid in a
	 * pen-friendly theme and traced into drawings, keyed by their source. A
	 * diagram that fails to render stays a code block — the send goes on.
	 */
	private async noteDrawings(markdown: string): Promise<Record<string, InkDrawing>> {
		const out: Record<string, InkDrawing> = {};
		if (this.settings.inkDiagrams !== "handwritten") return out;
		const sources = mermaidBlocks(markdown);
		if (sources.length === 0) return out;
		const mermaid = (await loadMermaid()) as {
			render(id: string, text: string): Promise<{ svg: string }>;
		};
		for (const [index, source] of sources.entries()) {
			const key = diagramKey(source);
			if (out[key] !== undefined) continue;
			const id = `ink-mermaid-${Date.now().toString(36)}-${index}`;
			// Off-screen but laid out: the tracer needs real text metrics and
			// computed styles, so neither display:none nor visibility:hidden.
			const host = activeDocument.body.createDiv({ cls: "remarkable-ink-mermaid-host" });
			try {
				const { svg } = await mermaid.render(id, withInkTheme(source));
				// Parsed the way Obsidian itself inserts it (HTML parser, which
				// tolerates entities strict XML would reject), then adopted.
				const parsed = new DOMParser().parseFromString(svg, "text/html").body.querySelector("svg");
				if (parsed === null) throw new Error("Mermaid returned no SVG");
				const element = activeDocument.importNode(parsed, true);
				host.appendChild(element);
				const box = element.viewBox.baseVal;
				if (box.width > 0 && box.height > 0) {
					element.setAttribute("width", String(box.width));
					element.setAttribute("height", String(box.height));
				}
				out[key] = extractDrawing(element);
			} catch (error) {
				console.warn("reMarkable Ink Round-Trip: a Mermaid diagram could not be rendered", error);
			} finally {
				host.remove();
				activeDocument.getElementById(`d${id}`)?.remove();
			}
		}
		return out;
	}

	/** Strokes → PNG bytes (the same painter the remark images use). */
	private async strokesToPng(strokes: StrokeRenderRequest["strokes"]): Promise<ArrayBuffer | null> {
		const plan = planRender(strokes);
		if (plan === null) return null;
		const canvas = createEl("canvas");
		canvas.width = plan.width;
		canvas.height = plan.height;
		const context = canvas.getContext("2d");
		if (context === null) return null;
		paintPlan(context, plan);
		const blob = await new Promise<Blob | null>((resolve) =>
			canvas.toBlob((result) => resolve(result), "image/png"),
		);
		return blob === null ? null : blob.arrayBuffer();
	}

	/**
	 * Read one remark on this device, from its strokes (ocr/recognize.ts).
	 * Unsure readings come back null: the image is the better answer then.
	 */
	private async recognizeLocally(
		request: StrokeRenderRequest & { quote?: string },
	): Promise<{ text: string; by?: ReaderName; score?: number } | null> {
		const strokes = request.strokes.map((stroke) => stroke.points.map((p) => ({ x: p.x, y: p.y })));
		// Read before: the note's text for it — the owner's, once corrected — stands.
		const known = knownText(await this.ink.loadSamples(), remarkId(request.strokes));
		if (known !== null) {
			await this.rememberReading(request, known, {});
			return { text: known };
		}
		const lexicon = await this.vaultLexicon();
		const result = recognize(strokes, await this.ocrTemplates(), lexicon, await this.wordReader());
		let text: string | null = null;
		// How sure each reader was, above its own cut-off: decides whether this
		// reading may later replace one the note already shows.
		let scored: { score?: number; by?: ReaderName } = {};
		if (result !== null && result.confidence >= OCR_TRUST) {
			text = result.text;
			scored = { score: scoreAbove(result.confidence, OCR_TRUST), by: "builtin" };
		} else if (this.settings.ocrUseWritePad) {
			// Joined-up writing, most likely: WritePad was made for it.
			const cursive = (await this.writePad())?.read(strokes, lexicon) ?? null;
			if (cursive !== null && cursive.confidence >= WRITEPAD_TRUST) {
				text = cursive.text;
				scored = { score: scoreAbove(cursive.confidence, WRITEPAD_TRUST), by: "writepad" };
			}
		}
		await this.rememberReading(request, text, scored);
		return text === null ? null : { text, ...scored };
	}

	/**
	 * Keep a remark's ink and its reading by the remark's id, so a correction
	 * in the note — or text typed under an image-only remark — can teach the
	 * reader this hand (ocr/samples.ts).
	 */
	private async rememberReading(
		request: StrokeRenderRequest & { quote?: string },
		text: string | null,
		scored: { score?: number; by?: ReaderName },
	): Promise<void> {
		const id = remarkId(request.strokes);
		const strokes = request.strokes.map((stroke) => stroke.points.map((p) => ({ x: p.x, y: p.y })));
		const entry = Object.values(this.settings.mappings).find((m) => m.deviceDocId === request.deviceDocId);
		const note = entry === undefined ? undefined : (this.resolveNote(entry)?.path ?? entry.notePath);
		rememberRemark(await this.ink.loadSamples(), id, strokes, text ?? "", new Date(), {
			image: this.remarkImages.get(id),
			note,
			quote: request.quote,
			wholePage: request.wholePage === true ? true : undefined,
			column: request.column,
			inkHighlights: request.inkHighlights,
		}, text === null ? {} : scored);
		this.samplesDirty = true;
	}

	private writePad(): Promise<WritePad | null> {
		this.writepad ??= (async () => {
			try {
				const engine = await WritePad.load();
				const lexicon = await this.vaultLexicon();
				engine.addWords((function* () {
					for (const [, word] of lexicon.words()) yield word;
				})());
				return engine;
			} catch (error) {
				console.warn(`reMarkable Ink Round-Trip: WritePad could not start — ${String(error)}`);
				return null;
			}
		})();
		return this.writepad;
	}

	private dropWritePad(): void {
		void this.writepad?.then((engine) => engine?.free());
		this.writepad = null;
	}

	/** Joined-up words: the owner's own samples, then the bundled script fonts. */
	private async wordReader(): Promise<WordReader> {
		if (this.words === null) {
			const store = await this.ink.loadSamples();
			this.words = new WordReader(
				[builtinFont("allure"), builtinFont("hershey-script")],
				builtinFont("readability"),
				store.words,
			);
		}
		return this.words;
	}

	/**
	 * Learn from remark texts the owner corrected or typed in since the last
	 * sync (ocr/samples.ts). Runs before new remarks are read, so they
	 * benefit at once.
	 */
	private async learnFromCorrections(log: (line: string) => void): Promise<void> {
		if (this.settings.ocrMode === "off") return;
		const store = await this.ink.loadSamples();
		const records = Object.entries(store.remarks);
		if (records.length === 0) return;
		const read = async (path: string) => {
			const file = this.app.vault.getFileByPath(path);
			return file === null ? null : this.app.vault.cachedRead(file);
		};
		// A remark is looked for in the note it was imported into; one from
		// before that was recorded, or whose note moved, in the notes
		// embedding its image.
		const texts = new Map<string, string | null>();
		for (const [, record] of records) {
			if (record.note !== undefined && !texts.has(record.note)) texts.set(record.note, await read(record.note));
		}
		const images = new Set(records.map(([key, record]) => record.image ?? (key.endsWith(".png") ? key : "")));
		const embedders = new Map<string, string>();
		for (const [source, links] of Object.entries(this.app.metadataCache.resolvedLinks)) {
			const embedded = Object.keys(links).filter((path) => images.has(path));
			if (embedded.length === 0) continue;
			if (!texts.has(source)) texts.set(source, await read(source));
			for (const path of embedded) embedders.set(path, source);
		}
		const learned = learnFromNotes(store, (key, record) => {
			const own = record.note === undefined ? null : (texts.get(record.note) ?? null);
			if (own !== null && remarkText(own, refOf(key, record)) !== null) return own;
			const source = embedders.get(record.image ?? key);
			return source === undefined ? null : (texts.get(source) ?? null);
		});
		if (learned.remarks > 0) {
			log(`learned ${learned.words} word(s) of your handwriting from ${learned.remarks} corrected remark(s)`);
		}
		if (learned.confirmed > 0) log(`${learned.confirmed} reading(s) confirmed by you (✓) — kept as they are`);
		if (learned.unlearned.length > 0) {
			// Said once: the correction is remembered as made and not looked at again.
			log(`${learned.unlearned.length} correction(s) taught no words — text and ink did not line up word for word:`);
			for (const item of learned.unlearned) log(`  ${describeUnlearned(item)}`);
			const shown = learned.unlearned.slice(0, 3).map(describeUnlearned);
			const more = learned.unlearned.length - shown.length;
			notify(
				`${learned.unlearned.length} handwriting correction(s) could not be matched to the ink word for word, ` +
					"so no words were learned from them (they are kept as corrections):\n" +
					shown.join("\n") +
					(more > 0 ? `\n…and ${more} more` : ""),
				15000,
			);
		}
		await this.ink.saveSamples();
		this.words = null;
	}

	/**
	 * Take a remark into its note as plain text (remarkinsert.ts): its text,
	 * with the handwriting's highlighter marks, goes where the ink was
	 * written and the callout is removed. Recorded as confirmed at once —
	 * with no callout left, the next sync could not find it — and never
	 * placed again.
	 */
	async insertRemark(file: TFile, id: string): Promise<void> {
		const found = findRemark(await this.app.vault.read(file), { id });
		if (found === null || found.text === "") {
			notify("This remark has no text to insert yet — correct it first.");
			return;
		}
		const store = await this.ink.loadSamples();
		const record = store.remarks[id];
		const marked =
			record === undefined ? { text: found.text, placed: true } : highlightedText(found.text, record.strokes, record.inkHighlights);
		let done = false;
		await this.app.vault.process(file, (note) => {
			// The note as it is now: the owner may have edited it meanwhile.
			const current = findRemark(note, { id });
			if (current === null || current.text !== found.text) return note;
			const next = insertRemarkText(note, id, marked.text, { quote: record?.quote, column: record?.column });
			done = next !== null;
			return next ?? note;
		});
		if (!done) {
			notify("The remark changed while inserting — nothing was changed; try again.");
			return;
		}
		acceptRemark(store, id, found.text);
		await this.ink.saveSamples();
		this.words = null;
		if (!marked.placed) notify("Inserted as text. The highlighting could not be matched to words, so it was left out.");
	}

	/**
	 * Write the owner's corrections out as a training set (ocr/trainingset.ts)
	 * into `<handwriting folder>/training`, for fine-tuning a vision model
	 * with an outside tool. Rewritten whole on every export.
	 */
	async exportTrainingSet(): Promise<void> {
		const samples = trainingSamples(await this.ink.loadSamples());
		if (samples.length === 0) {
			notify("No handwriting corrections yet — fix the text of a remark in a note, sync, then export.");
			return;
		}
		const base = this.settings.handwritingFolder.replace(/^\/+|\/+$/g, "");
		const folder = base === "" ? "training" : `${base}/training`;
		let written = 0;
		for (const sample of samples) {
			const png = await this.remarkPng(sample.record);
			if (png === null) continue;
			await this.writeVaultBinary(`${folder}/${sample.image}`, png);
			written++;
		}
		await this.writeVaultFile(`${folder}/dataset.jsonl`, datasetJsonl(samples));
		await this.writeVaultFile(`${folder}/dataset_info.json`, datasetInfo());
		notify(`Exported ${written} handwriting correction(s) to ${folder} (dataset.jsonl, LLaMA-Factory format).`);
	}

	/**
	 * Letter templates: the owner's hand first — the handwriting sheet, then the
	 * letters learned from corrections (ocr/samples.ts) — print letters for the
	 * rest. Keyed on the hand version and the number of learned letter samples,
	 * so a correction that adds letters takes effect without a reload.
	 */
	private async ocrTemplates(): Promise<Template[]> {
		const store = await this.ink.loadSamples();
		const learned = Object.values(store.letters ?? {}).reduce((n, samples) => n + samples.length, 0);
		const key = `${this.settings.handVersion}#${learned}`;
		if (this.templates?.key === key) return this.templates.templates;
		const hand = this.settings.handVersion === "" ? null : await this.ink.ensureHand(this.settings.handVersion);
		const templates = [
			...templatesFrom([
				...(hand === null ? [] : [{ glyphs: hand.glyphs, weight: 0.9 }]),
				{ glyphs: builtinFont("readability").glyphs, weight: 1 },
				{ glyphs: builtinFont("hershey-sans").glyphs, weight: 1 },
			]),
			...lettersTemplates(store),
		];
		this.templates = { key, templates };
		return templates;
	}

	/** Every word in the vault, once per sync run: the dictionary, in any language. */
	private vaultLexicon(): Promise<Lexicon> {
		this.lexicon ??= (async () => {
			const texts: string[] = [];
			for (const file of this.app.vault.getMarkdownFiles()) {
				texts.push(await this.app.vault.cachedRead(file));
			}
			return Lexicon.fromText(texts);
		})();
		return this.lexicon;
	}

	/**
	 * OCR one remark through the configured endpoint (opt-in), with the
	 * owner's latest corrections as worked examples. A remark read before
	 * keeps the note's text, the owner's once corrected.
	 */
	/**
	 * Test connection: ping the chosen vision endpoint, confirm it serves the
	 * configured model, and send a tiny probe image — surfacing the exact
	 * misconfiguration that the silent import-time fallback would hide. Throws a
	 * TransportError with an actionable message; the settings action reports it.
	 */
	testOcrConnection(): Promise<OcrConnection> {
		const s = this.settings;
		return checkConnection(obsidianHttp, {
			endpoint: s.ocrEndpoint,
			model: s.ocrModel,
			apiKey: s.ocrApiKey,
		});
	}

	/**
	 * "Set up local reading for me" (#26): find a local Ollama, pull the model
	 * with the owner's consent, point the OCR settings at it, test. Desktop
	 * only — the settings tab hides the action elsewhere.
	 */
	setUpLocalOllama(refresh: () => void): Promise<void> {
		return setUpLocalOllama(
			{
				app: this.app,
				settings: () => this.settings,
				saveSettings: () => this.saveSettings(),
				testOcrConnection: () => this.testOcrConnection(),
				http: obsidianHttp,
				stream: desktopNdjson(),
			},
			refresh,
		);
	}

	private async transcribeStrokes(
		request: StrokeRenderRequest & { quote?: string },
	): Promise<{ text: string; by?: ReaderName; score?: number } | null> {
		const known = knownText(await this.ink.loadSamples(), remarkId(request.strokes));
		if (known !== null) {
			await this.rememberReading(request, known, {});
			return { text: known };
		}
		const png = await this.strokesToPng(request.strokes);
		if (png === null) return null;
		const text = await this.ink.ocr(obsidianHttp, png, request.quote, request.wholePage === true, await this.ocrExamples());
		// No confidence from a chat endpoint: its readings fill empty callouts
		// but never replace text the note already shows.
		await this.rememberReading(request, text, { by: "endpoint" });
		return text === null ? null : { text, by: "endpoint" };
	}

	/** Worked examples, rendered once per run: the latest corrections, oldest first. */
	private examples: Promise<OcrExample[]> | null = null;

	private ocrExamples(): Promise<OcrExample[]> {
		this.examples ??= (async () => {
			const picked = corrections(await this.ink.loadSamples()).slice(0, Math.max(0, this.settings.ocrExamples));
			const out: OcrExample[] = [];
			for (const [, record] of picked.reverse()) {
				const png = await this.remarkPng(record);
				if (png !== null) out.push({ png, text: record.transcript });
			}
			return out;
		})();
		return this.examples;
	}

	/** A remembered remark as PNG: its image in the vault, or drawn again from its strokes. */
	private async remarkPng(record: RemarkRecord): Promise<ArrayBuffer | null> {
		const file = record.image === undefined ? null : this.app.vault.getFileByPath(record.image);
		if (file !== null) return this.app.vault.readBinary(file);
		// Stored strokes keep only their path; a fineliner's width draws them plainly.
		return this.strokesToPng(
			record.strokes.map((points) => ({
				tool: 0,
				color: 0,
				thicknessScale: 1,
				points: points.map((p) => ({ ...p, width: 20, pressure: 100 })),
			})),
		);
	}

	/** Open the rmapi-js session the raw sync API lives on. */
	private async rawApi(): Promise<RawSyncApi> {
		const api = await remarkable(this.settings.deviceToken, this.rmapiOptions());
		return api.raw;
	}

	private requirePaired(): boolean {
		if (this.settings.deviceToken !== "") return true;
		notify("Not paired with a reMarkable account yet — open the plugin settings first.");
		return false;
	}

	async sendHandwritingSheet(): Promise<void> {
		if (!this.requirePaired()) return;
		const notice = this.progress("Sending the handwriting sheet…");
		try {
			const api = await remarkable(this.settings.deviceToken, this.rmapiOptions());
			let parentId: string | undefined;
			if (this.settings.mirrorFolders && this.settings.deviceBaseFolder !== "") {
				parentId = await new MirrorTransport(api, this.settings.deviceBaseFolder).ensureFolderPath("");
			}
			await this.ink.sendSheet(api.raw, parentId);
			notify(
				"Handwriting sheet sent. Write each character in its box on the reMarkable, let it sync, then run “Learn my handwriting from the sheet”.",
				10000,
			);
		} catch (error) {
			notify(toTransportError(error).message, 10000);
		} finally {
			notice.hide();
		}
	}

	async sendWordSheet(): Promise<void> {
		if (!this.requirePaired()) return;
		const notice = this.progress("Sending the word sheet…");
		try {
			const api = await remarkable(this.settings.deviceToken, this.rmapiOptions());
			let parentId: string | undefined;
			if (this.settings.mirrorFolders && this.settings.deviceBaseFolder !== "") {
				parentId = await new MirrorTransport(api, this.settings.deviceBaseFolder).ensureFolderPath("");
			}
			await this.ink.sendWordSheet(api.raw, parentId);
			notify(
				"Word sheet sent. Write each word in its box the way you usually write, let it sync, then run “Learn my joined-up words from the sheet”.",
				10000,
			);
		} catch (error) {
			notify(toTransportError(error).message, 10000);
		} finally {
			notice.hide();
		}
	}

	async learnWordSheet(): Promise<void> {
		if (!this.requirePaired()) return;
		const notice = this.progress("Reading your word sheet…");
		try {
			const words = await this.ink.learnFromWordSheet(await this.rawApi());
			this.words = null;
			notify(`Learned ${words.length} word(s) of your joined-up writing.`, 8000);
		} catch (error) {
			notify(error instanceof Error ? error.message : String(error), 10000);
		} finally {
			notice.hide();
		}
	}

	async learnHandwriting(addVariants: boolean): Promise<void> {
		if (!this.requirePaired()) return;
		const notice = this.progress("Reading your handwriting sheet…");
		try {
			const result = await this.ink.learnFromSheet(await this.rawApi(), addVariants);
			if (this.settings.inkFont !== "hand") {
				this.settings.inkFont = "hand";
				await this.persistSettings();
			}
			const skipped =
				result.skipped.length === 0
					? ""
					: ` Not on the sheet, so written in the fallback font: ${result.skipped.join(" ")}`;
			notify(
				`Learned ${result.learned.length} character(s)${addVariants ? " as extra variations" : ""}. Handwritten sends now use your hand.${skipped}`,
				12000,
			);
		} catch (error) {
			notify(error instanceof Error ? error.message : String(error), 10000);
		} finally {
			notice.hide();
		}
	}

	async detectPageSize(): Promise<void> {
		if (!this.requirePaired()) return;
		const notice = this.progress("Looking for a notebook made on your reMarkable…");
		try {
			const api = await remarkable(this.settings.deviceToken, this.rmapiOptions());
			const items = await api.listItems(true);
			// Notebooks only, newest first: a PDF page's scene info may describe
			// the PDF rather than the tablet.
			const notebooks = items
				.filter((item) => item.type === "DocumentType" && item.fileType === "notebook")
				.sort((a, b) => Number(b.lastModified) - Number(a.lastModified))
				.slice(0, 15)
				.map((item) => ({ id: item.id, name: item.visibleName }));
			const found = await this.ink.detectPageSize(api.raw, notebooks);
			notify(
				found === null
					? "No notebook with a recorded page size found. Draw a stroke in any notebook on the tablet, sync, and try again."
					: `Page size ${found.profile.width}×${found.profile.height} (${found.profile.dpi} dpi), read from “${found.from}”. Handwritten sends now use it.`,
				10000,
			);
		} catch (error) {
			notify(toTransportError(error).message, 10000);
		} finally {
			notice.hide();
		}
	}

	/**
	 * Rasterise one handwritten remark to PNG and store it in the vault (F12).
	 * Canvas lives only here, at the edge; the geometry is planned by the
	 * pure renderer. Returns the vault path to embed, or null for ink that
	 * turned out to be empty.
	 */
	/**
	 * Where a remark's image goes: named by the remark's id (a hash of its
	 * ink, incoming/remarkid.ts), so a re-import overwrites the same remark
	 * instead of piling up copies, and a remark written above it later cannot
	 * take its name. An image from before ids, under its old numbered name,
	 * keeps that name while it holds exactly this ink — notes embedding it
	 * stay as they are.
	 */
	private async remarkImagePath(request: StrokeRenderRequest, ink: InkStrokes | null): Promise<string> {
		const folder = this.settings.handwritingFolder.replace(/^\/+|\/+$/g, "");
		const inFolder = (name: string) => (folder === "" ? name : `${folder}/${name}`);
		const page = String(request.page).padStart(2, "0");
		const legacy = `${request.deviceDocId}-p${page}-${request.remark}.png`;
		if (ink !== null && this.app.vault.getFileByPath(inFolder(legacy)) !== null) {
			const kept = await this.state.readInk(legacy).catch(() => null);
			// The same strokes; where they sit may have been recorded since.
			if (kept !== null && JSON.stringify(kept.strokes) === JSON.stringify(ink.strokes)) return inFolder(legacy);
		}
		return inFolder(`${request.deviceDocId}-p${page}-${remarkId(request.strokes)}.png`);
	}

	/** Image paths of the remarks rendered this run, by remark id (for the sample store). */
	private remarkImages = new Map<string, string>();

	private async renderHandwriting(
		request: StrokeRenderRequest,
	): Promise<string | null> {
		const plan = planRender(request.strokes);
		if (plan === null) return null;

		// createEl rather than document.createElement: Obsidian's helper attaches
		// to the right document, which matters in a popped-out window.
		const canvas = createEl("canvas");
		canvas.width = plan.width;
		canvas.height = plan.height;
		const context = canvas.getContext("2d");
		if (context === null)
			throw new Error("no 2D canvas available for rendering");
		paintPlan(context, plan);

		const blob = await new Promise<Blob | null>((resolve) =>
			canvas.toBlob((result) => resolve(result), "image/png"),
		);
		if (blob === null) throw new Error("could not encode the page as PNG");
		const buffer = await blob.arrayBuffer();

		const folder = this.settings.handwritingFolder.replace(/^\/+|\/+$/g, "");
		if (folder !== "" && !this.app.vault.getFolderByPath(folder)) {
			await this.app.vault.createFolder(folder);
		}
		// The strokes behind the picture, so a send writes this ink back as
		// itself rather than as a hatched copy of the image.
		const strokes = inkStrokesOf(request.strokes, this.ink.profile().dpi);
		// Where it was written, so a send can draw it back there (inkRemarks).
		const ink = strokes === null || request.at === undefined ? strokes : { ...strokes, at: request.at };
		const path = await this.remarkImagePath(request, ink);
		this.remarkImages.set(remarkId(request.strokes), path);
		if (ink !== null) await this.state.writeInk(path.split("/").pop() ?? path, ink);
		const existing = this.app.vault.getFileByPath(path);
		if (existing) {
			await this.app.vault.modifyBinary(existing, buffer);
		} else {
			await this.app.vault.createBinary(path, buffer);
		}
		return path;
	}

	/**
	 * Merge what changed on the tablet into the note itself (sync/twoway.ts),
	 * keeping a copy of the note before it is touched.
	 */
	private async applyTabletChanges(
		entry: MappingEntry,
		highlights: Highlight[],
		marks: ImportedMark[],
		changed: Set<string>,
		sourceState?: SourceState,
	): Promise<AnnotationOutcome | void> {
		if (highlights.length === 0 && marks.length === 0) return;
		const file = this.resolveNote(entry);
		if (file === null) return { form: "summary", reason: "no-source" };
		const raw = await this.app.vault.read(file);
		const { head, body: ours } = splitNote(raw);
		const sent = await this.ink.readSent(entry.docId).catch(() => null);
		const base = sent?.body ?? (sourceState === "match" ? ours : null);
		const layout = (await this.loadInkRender(entry).catch(() => null))?.layout ?? null;
		// Readings the owner never touched may be replaced by better ones.
		const store = await this.ink.loadSamples();
		const remarks = withEarlierReadings(store, marks);
		const { body, outcome, refreshed } = mergeTabletChanges({
			base,
			ours,
			layout,
			highlights,
			marks: remarks,
			styles: this.settings.markStyles,
			erasedAs: this.settings.erasedAs,
			sourcePath: file.path,
			sourceName: file.basename,
			importedAt: new Date().toISOString().slice(0, 16).replace("T", " "),
		});
		if (body === ours) return outcome;
		await this.writePreviousVersion(file, entry, raw);
		await this.app.vault.modify(file, head + body);
		changed.add(file.path);
		notedReadings(store, remarks, body);
		this.samplesDirty = true;
		return refreshed.length === 0 ? outcome : { ...outcome, rereadRemarks: refreshed.length };
	}
}

function reportPullResults(results: PullResult[], quiet: boolean): void {
	const failures = results.filter(
		(r): r is Extract<PullResult, { ok: false }> => !r.ok,
	);
	if (failures.length > 0) {
		const detail = failures
			.slice(0, 3)
			.map((f) => `${f.notePath.split("/").pop()}: ${f.error}`)
			.join("\n");
		const message = `${failures.length} notebook(s) could not be read.\n${detail}`;
		if (quiet) console.warn(`reMarkable Ink Round-Trip: ${message}`);
		else notify(message, 10000);
		return;
	}
	const read = results.filter((r) => r.ok && r.skipped !== true);
	const merged = read.filter((r) => r.ok && r.scan?.written !== undefined);
	const conflicts = merged.reduce(
		(sum, r) => sum + (r.ok ? (r.scan?.written?.conflicts ?? 0) : 0),
		0,
	);
	if (merged.length === 0) {
		if (!quiet) notify("Nothing new on the reMarkable — everything is up to date.");
		return;
	}
	notify(
		`Brought tablet changes into ${merged.length} note(s).` +
			(conflicts > 0
				? ` ${conflicts} place(s) were edited on both sides: look for “Also changed on the reMarkable”.`
				: ""),
		conflicts > 0 ? 15000 : undefined,
	);
}

function getFrontmatterValue(
	frontmatter: Record<string, unknown> | undefined,
	key: string,
): unknown {
	return frontmatter?.[key];
}

function scanEmbeds(
	content: string,
	fromPath: string,
): { linkpath: string; fromPath: string }[] {
	const found: { linkpath: string; fromPath: string }[] = [];
	for (const match of content.matchAll(EMBED_SCAN_RE)) {
		found.push({ linkpath: match[1].trim(), fromPath });
	}
	return found;
}

/** Adapt Obsidian's TFile/TFolder tree to the pure selection flattener. */
function collectFromSelection(selection: TAbstractFile[]): TFile[] {
	return flattenSelection(selection, (item) => {
		if (item instanceof TFile) {
			return item.extension === "md" ? { kind: "note" } : { kind: "other" };
		}
		if (item instanceof TFolder) {
			return { kind: "folder", children: item.children };
		}
		return { kind: "other" };
	}) as TFile[];
}

/** Vault path of the folder's parent, normalised: Obsidian's vault root is "/". */
function folderParentPath(folder: TFolder): string {
	const parent = folder.parent?.path ?? "";
	return parent === "/" ? "" : parent;
}

function collectMarkdownFiles(folder: TFolder): TFile[] {
	const files: TFile[] = [];
	for (const child of folder.children) {
		if (child instanceof TFile && child.extension === "md") files.push(child);
		else if (child instanceof TFolder)
			files.push(...collectMarkdownFiles(child));
	}
	return files;
}

function reportResults(
	results: SendResult[],
	options: { quietWhenAllSkipped?: boolean; quiet?: boolean } = {},
): void {
	const failures = results.filter(
		(r): r is Extract<SendResult, { ok: false }> => !r.ok,
	);
	const missing = results.flatMap((r) => (r.ok ? r.missingEmbeds : []));
	if (failures.length === 0) {
		const sent = results.filter((r) => r.ok && r.skipped !== true);
		if (sent.length === 0 && options.quietWhenAllSkipped) return;
		if (options.quiet) return;
		const base =
			sent.length === 1
				? `Sent "${sent[0].path.split("/").pop()}" to reMarkable.`
				: `Sent ${sent.length} notes to reMarkable.`;
		notify(
			missing.length > 0
				? `${base} (${missing.length} embeds not found)`
				: base,
		);
	} else {
		const detail = failures
			.slice(0, 3)
			.map((f) => `${f.path.split("/").pop()}: ${f.error}`)
			.join("\n");
		const message = `${results.length - failures.length}/${results.length} sent; ${failures.length} failed.\n${detail}`;
		if (options.quiet) console.warn(`reMarkable Ink Round-Trip: ${message}`);
		else notify(message, 10000);
	}
}

/** The vault adapter as the sync state's file seam: dot-folders included, unlike the vault API. */
function vaultFs(app: App): StateFs {
	const adapter = app.vault.adapter;
	return {
		exists: (path) => adapter.exists(path),
		read: (path) => adapter.read(path),
		write: (path, data) => adapter.write(path, data),
		mkdir: (path) => adapter.mkdir(path),
		list: async (dir) => (await adapter.list(dir)).files,
		remove: (path) => adapter.remove(path),
	};
}

/** Obsidian requestUrl adapter — CORS-free and mobile-safe (N7). */
const obsidianHttp: HttpClient = async (request) => {
	const response = await requestUrl({
		url: request.url,
		method: request.method,
		headers: request.headers,
		body: request.body,
		throw: false,
	});
	return {
		status: response.status,
		headers: response.headers,
		text: response.text ?? "",
		arrayBuffer: response.arrayBuffer,
	};
};

/**
 * Streaming NDJSON over Node http(s), for the Ollama pull's progress (#26):
 * requestUrl buffers the whole response, so it cannot report any. Desktop
 * only, and Node is reached lazily through `window.require` — never a bundled
 * `require("http")` that would break mobile (N7). No `Origin` header goes out
 * this way, as with requestUrl. Null where there
 * is no Node (mobile, or a desktop that hides it): the pull then falls back
 * to requestUrl without progress.
 */
function desktopNdjson(): NdjsonClient | null {
	if (!Platform.isDesktopApp) return null;
	const load = (window as unknown as { require?: (module: string) => unknown }).require;
	return typeof load === "function" ? nodeNdjson(load) : null;
}
