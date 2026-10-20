/**
 * Unconfirmed handwritten remarks drawn faded over the note, roughly where
 * the ink sat on the page (ink fork, #29): in reading view, per rendered
 * section, and in the editor, as a CodeMirror layer.
 *
 * Only a picture — the remark's own image, placed by its InkStrokes record
 * (incoming/remarkoverlay.ts). The note is never touched; a remark that is
 * confirmed (✓) or taken in as text has no overlay, so what is still drawn
 * is what still wants a look.
 */

import { StateEffect, type Extension } from "@codemirror/state";
import { EditorView, layer, ViewPlugin, type LayerMarker, type ViewUpdate } from "@codemirror/view";
import { App, editorInfoField, MarkdownPostProcessorContext, MarkdownRenderChild, MarkdownView, TFile } from "obsidian";
import type { InkStrokes } from "./ink/inkimage";
import { overlayBox, pendingRemarks, pitchRatio, remarkAnchor, runsBefore, findWordRun, type OverlayBox, type OverlayPage } from "./incoming/remarkoverlay";

/** The tablet page a note was written on: its column and its body type. */
export type OverlayLayout = OverlayPage & { fontSize: number; lineHeight: number };

export interface RemarkOverlayHost {
	/** Whether overlays are wanted at all (inkRemarkOverlay). */
	enabled(): boolean;
	/** The strokes behind a remark image, by its file name. */
	readInk(imageName: string): Promise<InkStrokes | null>;
	/** The page geometry the note was sent with, or the defaults. */
	layoutFor(notePath: string): OverlayLayout;
}

/** An overlay to draw: the remark's image, its ink, and the printed row it goes by. */
interface Placed {
	image: TFile;
	ink: InkStrokes & { at: NonNullable<InkStrokes["at"]> };
	/** Source line of the anchor row, and where on it the row's words start. */
	line: number;
	offset: number;
}

const CLASS = "remarkable-ink-remark-overlay";

/** Where a text rect's baseline sits: about a fifth of its height above its bottom. */
const baselineOf = (rect: { top: number; bottom: number }) => rect.bottom - (rect.bottom - rect.top) * 0.2;

/** The overlay box as CSS custom properties (styles.css places the image by them). */
function boxProps(box: OverlayBox, left: number, top: number): Record<string, string> {
	return {
		"--remarkable-ink-overlay-left": `${(left + box.leftPx).toFixed(1)}px`,
		"--remarkable-ink-overlay-top": `${(top + box.topPx).toFixed(1)}px`,
		"--remarkable-ink-overlay-width": `${box.widthPx.toFixed(1)}px`,
		"--remarkable-ink-overlay-height": `${box.heightPx.toFixed(1)}px`,
	};
}

export class RemarkOverlays {
	/** Strokes records by image path, kept while the image is unchanged. */
	private readonly inks = new Map<string, { mtime: number; ink: Promise<InkStrokes | null> }>();
	/** The overlays last worked out per note, with the text they were worked out from. */
	private readonly notes = new Map<string, { note: string; placed: Promise<Placed[]> }>();
	/** Rendered reading-view sections that may carry overlays. */
	private readonly sections = new Set<OverlaySection>();
	/** The editor extension, filled while overlays are on (registerEditorExtension keeps the array). */
	readonly extension: Extension[] = [];

	constructor(
		readonly app: App,
		readonly host: RemarkOverlayHost,
	) {
		if (host.enabled()) this.extension.push(...editorExtension(this));
	}

	/** Follow the setting: the editor extension on or off, every rendered overlay redone. */
	sync(): void {
		this.notes.clear();
		const on = this.host.enabled();
		if (on !== this.extension.length > 0) {
			this.extension.length = 0;
			if (on) this.extension.push(...editorExtension(this));
			this.app.workspace.updateOptions();
			// Sections rendered while overlays were off never looked for any.
			if (on) {
				for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
					if (leaf.view instanceof MarkdownView) leaf.view.previewMode.rerender(true);
				}
			}
		}
		for (const section of this.sections) section.refresh();
	}

	/** A note changed on disk: redo its sections (a ✓ elsewhere in the note does not re-render them). */
	changed(file: TFile): void {
		if (file.extension !== "md") {
			// A remark's image drawn again: its ink (and where it sits) may be new.
			if (!this.inks.has(file.path)) return;
			this.notes.clear();
		}
		for (const section of this.sections) if (file.extension !== "md" || section.file.path === file.path) section.refresh();
	}

	/** The overlays of a note, as source lines and offsets; [] when off or when it has no remarks. */
	placed(file: TFile, note: string): Promise<Placed[]> {
		if (!this.host.enabled() || !note.includes("^ink-")) return Promise.resolve([]);
		// Every rendered section asks; the note is worked out once per version.
		const kept = this.notes.get(file.path);
		if (kept !== undefined && kept.note === note) return kept.placed;
		const placed = this.place(file, note);
		this.notes.set(file.path, { note, placed });
		return placed;
	}

	private async place(file: TFile, note: string): Promise<Placed[]> {
		const remarks = pendingRemarks(note);
		if (remarks.length === 0) return [];
		const lines = note.split("\n");
		const out: Placed[] = [];
		for (const remark of remarks) {
			const image = this.app.metadataCache.getFirstLinkpathDest(remark.image, file.path);
			if (image === null) continue;
			const ink = await this.inkOf(image);
			if (ink?.at === undefined) continue;
			const anchor = remarkAnchor(lines, remark.start, ink.at.text);
			if (anchor !== null) out.push({ image, ink: { ...ink, at: ink.at }, ...anchor });
		}
		return out;
	}

	private inkOf(image: TFile): Promise<InkStrokes | null> {
		const kept = this.inks.get(image.path);
		if (kept !== undefined && kept.mtime === image.stat.mtime) return kept.ink;
		const ink = this.host.readInk(image.name).catch(() => null);
		this.inks.set(image.path, { mtime: image.stat.mtime, ink });
		return ink;
	}

	/* --------------------------- reading view --------------------------- */

	/** Markdown post-processor: overlays for the remarks written against this section's rows. */
	readonly process = async (el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> => {
		if (!this.host.enabled()) return;
		const file = this.app.vault.getFileByPath(ctx.sourcePath);
		if (file === null) return;
		const note = await this.app.vault.cachedRead(file);
		if ((await this.placed(file, note)).length === 0) return;
		ctx.addChild(new OverlaySection(el, ctx, file, this));
	};

	register(section: OverlaySection, on: boolean): void {
		if (on) this.sections.add(section);
		else this.sections.delete(section);
	}
}

/* -------------------------------- editor -------------------------------- */

type EditorItem = { pos: number; image: TFile; ink: Placed["ink"] };

/** The editor's overlays: a plugin keeping where they go, and a layer drawing them. */
function editorExtension(overlays: RemarkOverlays): Extension[] {
	const loaded = StateEffect.define<null>();
	const plugin = ViewPlugin.fromClass(
		class {
			items: EditorItem[] = [];
			private timer: number | null = null;
			private alive = true;

			constructor(readonly view: EditorView) {
				this.load();
			}

			update(update: ViewUpdate): void {
				if (!update.docChanged) return;
				// Keep the drawn ones with their text until the note is read again.
				this.items = this.items.map((item) => ({ ...item, pos: update.changes.mapPos(item.pos) }));
				if (this.timer !== null) window.clearTimeout(this.timer);
				this.timer = window.setTimeout(() => this.load(), 300);
			}

			load(): void {
				this.timer = null;
				const file = this.view.state.field(editorInfoField, false)?.file ?? null;
				const doc = this.view.state.doc;
				const note = doc.toString();
				if (file === null || !note.includes("^ink-")) {
					this.show([]);
					return;
				}
				void overlays
					.placed(file, note)
					.then((placed) => {
						// The note moved on while the ink was read: the next load has it.
						if (this.view.state.doc !== doc) return;
						this.show(
							placed
								.filter((p) => p.line < doc.lines)
								.map((p) => ({ pos: Math.min(doc.line(p.line + 1).from + p.offset, doc.length), image: p.image, ink: p.ink })),
						);
					})
					.catch(() => this.show([]));
			}

			private show(items: EditorItem[]): void {
				if (!this.alive || (items.length === 0 && this.items.length === 0)) return;
				this.items = items;
				this.view.dispatch({ effects: loaded.of(null) });
			}

			destroy(): void {
				this.alive = false;
				if (this.timer !== null) window.clearTimeout(this.timer);
			}
		},
	);
	const drawn = layer({
		above: true,
		class: "remarkable-ink-remark-overlay-layer",
		update: (update) =>
			update.docChanged || update.viewportChanged || update.geometryChanged || update.transactions.some((tr) => tr.effects.some((e) => e.is(loaded))),
		markers: (view) => {
			const items = view.plugin(plugin)?.items ?? [];
			if (items.length === 0) return [];
			const file = view.state.field(editorInfoField, false)?.file ?? null;
			if (file === null) return [];
			const page = overlays.host.layoutFor(file.path);
			const scroller = view.scrollDOM.getBoundingClientRect();
			const base = { left: scroller.left - view.scrollDOM.scrollLeft, top: scroller.top - view.scrollDOM.scrollTop };
			const column = view.contentDOM.getBoundingClientRect();
			const markers: LayerMarker[] = [];
			for (const item of items) {
				const at = view.coordsAtPos(item.pos, 1);
				if (at === null) continue;
				const room = { left: column.left - scroller.left, right: scroller.left + view.scrollDOM.clientWidth - column.right };
				const lineRatio = pitchRatio(view.defaultLineHeight, page, column.width);
				const box = overlayBox(item.ink, page, column.width, { room, lineRatio });
				if (box === null) continue;
				const props = boxProps(box, column.left - base.left, baselineOf(at) - base.top);
				markers.push(new OverlayMarker(overlays.app.vault.getResourcePath(item.image), props));
			}
			return markers;
		},
	});
	return [plugin, drawn];
}

/** One remark's picture in the editor's overlay layer. */
class OverlayMarker implements LayerMarker {
	constructor(
		readonly src: string,
		readonly props: Record<string, string>,
	) {}

	eq(other: LayerMarker): boolean {
		return other instanceof OverlayMarker && other.src === this.src && Object.entries(this.props).every(([k, v]) => other.props[k] === v);
	}

	draw(): HTMLElement {
		const img = createEl("img", { cls: CLASS, attr: { src: this.src, alt: "", "aria-hidden": "true" } });
		img.setCssProps(this.props);
		return img;
	}

	update(dom: HTMLElement, previous: LayerMarker): boolean {
		if (!(previous instanceof OverlayMarker) || previous.src !== this.src) return false;
		dom.setCssProps(this.props);
		return true;
	}
}

/**
 * A rendered reading-view section: draws the overlays of remarks whose row
 * is in it, on top of the section, measured from where that row's words
 * are laid out — again whenever the section is resized or the note changes.
 */
class OverlaySection extends MarkdownRenderChild {
	private placed: Placed[] = [];
	private observer: ResizeObserver | null = null;
	private frame: number | null = null;
	private generation = 0;

	constructor(
		el: HTMLElement,
		private readonly ctx: MarkdownPostProcessorContext,
		readonly file: TFile,
		private readonly overlays: RemarkOverlays,
	) {
		super(el);
	}

	onload(): void {
		this.overlays.register(this, true);
		this.observer = new ResizeObserver(() => this.schedule());
		this.observer.observe(this.containerEl);
		this.refresh();
	}

	onunload(): void {
		this.overlays.register(this, false);
		this.observer?.disconnect();
		if (this.frame !== null) window.cancelAnimationFrame(this.frame);
		this.clear();
	}

	/** Read the note again: which remarks go over this section. */
	refresh(): void {
		const generation = ++this.generation;
		void this.overlays.app.vault
			.cachedRead(this.file)
			.then(async (note) => {
				const section = this.ctx.getSectionInfo(this.containerEl);
				const placed = section === null ? [] : await this.overlays.placed(this.file, note);
				if (generation !== this.generation) return;
				const lines = note.split("\n");
				this.placed = placed.filter((p) => section !== null && p.line >= section.lineStart && p.line <= section.lineEnd);
				this.occurrence = this.placed.map((p) =>
					section === null ? 0 : runsBefore(lines.slice(section.lineStart, p.line), p.ink.at.text),
				);
				this.schedule();
			})
			.catch(() => {
				this.placed = [];
				this.schedule();
			});
	}

	/** Which run of the row's words in the section is the anchor (earlier lines may hold the same words). */
	private occurrence: number[] = [];

	private schedule(): void {
		if (this.frame !== null) return;
		this.frame = window.requestAnimationFrame(() => {
			this.frame = null;
			this.layout();
		});
	}

	private clear(): void {
		for (const img of Array.from(this.containerEl.querySelectorAll(`:scope > .${CLASS}`))) img.remove();
		this.containerEl.removeClass("remarkable-ink-remark-overlay-host");
	}

	private layout(): void {
		this.clear();
		const el = this.containerEl;
		if (this.placed.length === 0 || !el.isConnected) return;
		// A widget in the editor (its layer draws there) or a PDF export: no overlay.
		if (el.closest(".markdown-source-view, .print") !== null) return;
		const column = el.getBoundingClientRect();
		if (column.width <= 0) return;
		const view = el.closest(".markdown-preview-view") ?? el.parentElement;
		const outer = view?.getBoundingClientRect() ?? column;
		const scrollbar = view instanceof HTMLElement ? view.offsetWidth - view.clientWidth : 0;
		const room = { left: column.left - outer.left, right: outer.right - scrollbar - column.right };
		const page = this.overlays.host.layoutFor(this.file.path);
		this.placed.forEach((placed, i) => {
			const rect = wordRect(el, placed.ink.at.text, this.occurrence[i] ?? 0);
			if (rect === null) return;
			const pitch = Number.parseFloat(getComputedStyle(rect.holder).lineHeight);
			const lineRatio = pitchRatio(Number.isFinite(pitch) ? pitch : (rect.bottom - rect.top) * 1.25, page, column.width);
			const box = overlayBox(placed.ink, page, column.width, { room, lineRatio });
			if (box === null) return;
			const img = el.createEl("img", {
				cls: CLASS,
				attr: { src: this.overlays.app.vault.getResourcePath(placed.image), alt: "", "aria-hidden": "true" },
			});
			img.setCssProps(boxProps(box, 0, baselineOf(rect) - column.top));
		});
		if (el.querySelector(`:scope > .${CLASS}`) !== null) el.addClass("remarkable-ink-remark-overlay-host");
	}
}

/** Where the printed row's first word is laid out in a rendered section, and the element holding it. */
function wordRect(el: HTMLElement, row: string, occurrence: number): { top: number; bottom: number; holder: Element } | null {
	const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
	const nodes: { node: Text; start: number }[] = [];
	let text = "";
	for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
		const t = node as Text;
		nodes.push({ node: t, start: text.length });
		text += t.data;
	}
	const runs = findWordRun(text, row);
	const run = runs[Math.min(occurrence, runs.length - 1)];
	if (run === undefined) return null;
	const at = (offset: number) => {
		const hit = nodes.filter((n) => n.start <= offset).pop() ?? nodes[0];
		return { node: hit.node, offset: Math.min(offset - hit.start, hit.node.data.length) };
	};
	const start = at(run.start);
	const end = at(run.end);
	const range = el.ownerDocument.createRange();
	range.setStart(start.node, start.offset);
	range.setEnd(end.node, end.offset);
	const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
	if (rect.height === 0 && rect.width === 0) return null;
	return { top: rect.top, bottom: rect.bottom, holder: start.node.parentElement ?? el };
}
