/**
 * Confirm, correct or take in a handwritten remark's reading right in the
 * note (ink fork): buttons in the callout's title, and an editor showing the
 * ink beside its text. Taking it in (⤵, remarkinsert.ts) replaces the
 * callout with plain text where the ink was written.
 *
 * Both only edit the note — ✓ in the title, or the callout's text lines —
 * exactly as typing would (incoming/remarkid.ts). The next sync finds the
 * change there and learns from it (ocr/samples.ts learnFromNotes), so a
 * hand edit and a button click are the same thing to the plugin.
 *
 * Obsidian hides block ids when it renders, so a rendered callout is matched
 * to its remark through the source lines it was rendered from — or, where
 * those are unknown (some live-preview widgets), through its image.
 */

import { App, ButtonComponent, MarkdownPostProcessorContext, Modal, setIcon, TFile } from "obsidian";
import { CONFIRM_MARK, confirmRemarkAt, findRemark, remarkAt, setRemarkTextAt } from "./incoming/remarkid";

/** A remark as the note has it now, by id. */
interface RemarkInNote {
	file: TFile;
	id: string;
	text: string;
	confirmed: boolean;
	/** The image the callout embeds, if any. */
	image: TFile | null;
}

export class RemarkControls {
	constructor(
		private readonly app: App,
		/** Take the remark into the note as plain text (main.ts: store, highlights, learning). */
		private readonly insert: (file: TFile, id: string) => Promise<void>,
	) {}

	/** Markdown post-processor: buttons on every remark callout rendered from a note. */
	readonly process = async (el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> => {
		const callouts = el.matches(".callout") ? [el] : Array.from(el.querySelectorAll<HTMLElement>(".callout"));
		if (callouts.length === 0) return;
		const file = this.app.vault.getFileByPath(ctx.sourcePath);
		if (file === null) return;
		const note = await this.app.vault.cachedRead(file);
		const section = ctx.getSectionInfo(el);
		for (const callout of callouts) {
			const id = this.idOf(note, callout, section?.lineStart ?? null, file.path);
			if (id === null) continue;
			const remark = this.lookUp(note, file, id);
			if (remark !== null) this.decorate(callout, remark);
		}
	};

	/** The remark id of a rendered callout: by its source line, else by its image. */
	private idOf(note: string, callout: HTMLElement, line: number | null, sourcePath: string): string | null {
		if (line !== null) {
			const at = remarkAt(note, line);
			if (at !== null) return at.id;
		}
		const src = callout.querySelector(".internal-embed")?.getAttribute("src");
		if (src === null || src === undefined) return null;
		const image = this.app.metadataCache.getFirstLinkpathDest(src, sourcePath);
		if (image === null) return null;
		const lines = note.split("\n");
		const at = lines.findIndex((l) => l.includes("![[") && l.includes(image.path.split("/").pop() ?? image.path));
		return at === -1 ? null : (remarkAt(note, at)?.id ?? null);
	}

	private lookUp(note: string, file: TFile, id: string): RemarkInNote | null {
		const found = findRemark(note, { id });
		if (found === null) return null;
		const block = note.split("\n").slice(found.start, found.end + 1).join("\n");
		const link = /!\[\[([^\]|#]+)/.exec(block)?.[1];
		const image = link === undefined ? null : this.app.metadataCache.getFirstLinkpathDest(link, file.path);
		return { file, id, text: found.text, confirmed: found.confirmed, image };
	}

	private decorate(callout: HTMLElement, remark: RemarkInNote): void {
		const title = callout.querySelector<HTMLElement>(".callout-title");
		if (title === null || title.querySelector(".remarkable-ink-remark-actions") !== null) return;
		const actions = title.createDiv({ cls: "remarkable-ink-remark-actions" });
		// Clicks must not fall through to live preview, which would open the
		// callout's source for editing.
		actions.addEventListener("mousedown", (event) => event.stopPropagation());
		actions.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
		});
		if (!remark.confirmed && remark.text !== "") {
			this.button(actions, "check", "Confirm this reading — it is right", () => void this.confirm(remark.file, remark.id));
		}
		this.button(actions, "pencil", "Correct this reading", () => this.openEditor(remark.file, remark.id));
		if (remark.text !== "") {
			this.button(actions, "arrow-down-to-line", "Insert into the note as text, where it was written", () => void this.insert(remark.file, remark.id));
		}
	}

	private button(parent: HTMLElement, icon: string, label: string, onClick: () => void): void {
		const button = parent.createEl("button", { cls: "clickable-icon remarkable-ink-remark-action", attr: { "aria-label": label } });
		setIcon(button, icon);
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			onClick();
		});
	}

	/** Mark a remark's reading as checked (✓ in its title). */
	async confirm(file: TFile, id: string): Promise<void> {
		await this.app.vault.process(file, (note) => {
			const found = findRemark(note, { id });
			return found === null ? note : (confirmRemarkAt(note, found.start) ?? note);
		});
	}

	/** Open the editor for the remark with this id in this note. */
	openEditor(file: TFile, id: string): void {
		void this.app.vault.cachedRead(file).then((note) => {
			const remark = this.lookUp(note, file, id);
			if (remark !== null) new RemarkEditor(this.app, remark, this).open();
		});
	}

	/** Take the remark into the note as text (after saving any edit). */
	async insertAsText(file: TFile, id: string, text?: string): Promise<void> {
		if (text !== undefined) await this.correct(file, id, text, false);
		await this.insert(file, id);
	}

	/** Write corrected text into the remark's callout, optionally confirming it. */
	async correct(file: TFile, id: string, text: string, confirm: boolean): Promise<void> {
		await this.app.vault.process(file, (note) => {
			const found = findRemark(note, { id });
			if (found === null) return note;
			const fixed = setRemarkTextAt(note, found.start, text) ?? note;
			return confirm ? (confirmRemarkAt(fixed, found.start) ?? fixed) : fixed;
		});
	}
}

/** The ink above, its text below: fix it, or confirm it as it is. */
class RemarkEditor extends Modal {
	constructor(
		app: App,
		private readonly remark: RemarkInNote,
		private readonly controls: RemarkControls,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle("Handwritten remark");
		const { contentEl } = this;
		contentEl.addClass("remarkable-ink-remark-editor");
		if (this.remark.image !== null) {
			contentEl.createEl("img", {
				cls: "remarkable-ink-remark-ink",
				attr: { src: this.app.vault.getResourcePath(this.remark.image), alt: "The handwriting" },
			});
		}
		contentEl.createEl("p", {
			cls: "setting-item-description",
			text:
				this.remark.text === ""
					? "This remark could not be read. Type what it says — the next sync learns your handwriting from it."
					: "Fix what was misread. The next sync learns your handwriting from the correction.",
		});
		const input = contentEl.createEl("textarea", { cls: "remarkable-ink-remark-text" });
		input.value = this.remark.text;
		input.rows = Math.max(3, this.remark.text.split("\n").length + 1);
		const buttons = contentEl.createDiv({ cls: "modal-button-container" });
		new ButtonComponent(buttons)
			.setButtonText(this.remark.confirmed ? "Save" : `Save and confirm ${CONFIRM_MARK}`)
			.setCta()
			.onClick(() => void this.save(input.value, true));
		if (!this.remark.confirmed) {
			new ButtonComponent(buttons).setButtonText("Save").onClick(() => void this.save(input.value, false));
		}
		new ButtonComponent(buttons).setButtonText("Insert as text").onClick(() => {
			void this.controls.insertAsText(this.remark.file, this.remark.id, input.value).then(() => this.close());
		});
		new ButtonComponent(buttons).setButtonText("Cancel").onClick(() => this.close());
		window.setTimeout(() => input.focus(), 0);
	}

	private async save(text: string, confirm: boolean): Promise<void> {
		await this.controls.correct(this.remark.file, this.remark.id, text, confirm);
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
