import { App, Modal, Setting } from "obsidian";
import { NOTE_STATE_LABELS, type NoteStatus, type NoteSyncState, type SyncStatusSummary } from "./sync/statussummary";

export interface SyncStatusView {
	mode: string;
	watchFolder: string;
	summary: SyncStatusSummary;
	/** Every synced note (and every note of a sync folder) by state. */
	notes: NoteStatus[];
	/** Which copy of the vault syncs on its own, in words; absent = none says so. */
	lease?: string;
	/** The failures of the last sync that failed, until one succeeds. */
	failures: string[];
	openNote: (path: string) => void;
}

/** States listed note by note; the rest only counted, as there are usually many. */
const LISTED: NoteSyncState[] = ["error", "clash", "tablet-pending", "waiting", "archived", "opted-out"];

export class SyncStatusModal extends Modal {
	constructor(
		app: App,
		private readonly view: SyncStatusView,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle("reMarkable sync status");
		const { summary } = this.view;
		if (this.view.failures.length > 0) {
			const box = this.contentEl.createDiv({ cls: "callout", attr: { "data-callout": "error" } });
			box.createDiv({ cls: "callout-title", text: "The last sync failed" });
			const list = box.createEl("ul");
			for (const failure of this.view.failures) list.createEl("li", { text: failure });
		}
		this.row("Queue", summary.queue);
		this.row("Queued work", String(summary.queuedWork));
		this.row("Pending local changes", String(summary.pendingChanges));
		if (this.view.lease !== undefined) this.row("Syncing on its own", this.view.lease);
		this.row("Folder mirroring", this.view.mode);
		this.row("Sync folders", this.view.watchFolder);
		this.row("Notes in watch folder", String(summary.watchNotes));
		this.row("Watch notes not yet synced", String(summary.untrackedWatchNotes));
		this.row("Tracked notes", String(summary.trackedNotes));
		this.row("Tracked notes present locally", String(summary.localTrackedNotes));
		this.row("Tracked notes missing locally", String(summary.missingLocalNotes));
		this.row("Archived notes (notebook deleted on one side)", String(summary.archivedNotes));
		this.row("Last upload", summary.lastUploadedAt === null ? "Never" : new Date(summary.lastUploadedAt).toLocaleString());
		this.row("Notes in sync", String(this.view.notes.filter((note) => note.state === "in-sync").length));

		for (const state of LISTED) {
			const notes = this.view.notes.filter((note) => note.state === state);
			if (notes.length === 0) continue;
			this.contentEl.createEl("h4", { text: `${NOTE_STATE_LABELS[state]} (${notes.length})` });
			const list = this.contentEl.createEl("ul");
			for (const note of notes) {
				const item = list.createEl("li");
				const link = item.createEl("a", { text: note.path, href: "#" });
				link.addEventListener("click", (event) => {
					event.preventDefault();
					this.close();
					this.view.openNote(note.path);
				});
				if (note.detail !== undefined) item.createSpan({ text: ` — ${note.detail}` });
			}
		}
	}

	private row(name: string, value: string): void {
		const setting = new Setting(this.contentEl).setName(name);
		setting.controlEl.setText(value);
	}
}

/** A sync started by hand while another copy of the vault holds the sync lease: go ahead anyway? */
export class LeaseConfirmModal extends Modal {
	constructor(
		app: App,
		private readonly holder: { device: string; until: Date },
		private readonly decide: (proceed: boolean) => void,
	) {
		super(app);
	}

	private decided = false;

	onOpen(): void {
		this.setTitle("Another copy of this vault is syncing");
		this.contentEl.createEl("p", {
			text:
				`“${this.holder.device}” syncs this vault with the reMarkable on its own (until ${this.holder.until.toLocaleTimeString()} unless it syncs again). ` +
				"Syncing from here too at the same time can make both send the same note. Sync from here anyway?",
		});
		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((button) =>
				button
					.setButtonText("Sync anyway")
					.setCta()
					.onClick(() => {
						this.decided = true;
						this.close();
						this.decide(true);
					}),
			);
	}

	onClose(): void {
		if (!this.decided) this.decide(false);
	}
}

export interface StopSyncingView {
	name: string;
	/** The note sits in a sync folder: it is sent again as a new notebook unless moved out. */
	inSyncFolder: boolean;
	onConfirm: (trashNotebook: boolean) => void;
}

/** "Stop syncing": confirm, and choose whether the notebook goes to the tablet's trash (default: it stays). */
export class StopSyncingModal extends Modal {
	private trashNotebook = false;

	constructor(
		app: App,
		private readonly view: StopSyncingView,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(`Stop syncing “${this.view.name}”`);
		this.contentEl.createEl("p", {
			text:
				"The note keeps its text and is no longer tied to its notebook on the reMarkable." +
				(this.view.inSyncFolder ? " It stays out of the sync folder's sync too, until you choose “Sync with reMarkable” on it." : ""),
		});
		new Setting(this.contentEl)
			.setName("Move the notebook to the reMarkable's trash")
			.setDesc("Only while it holds nothing the note lacks; otherwise it is kept.")
			.addToggle((toggle) => toggle.setValue(false).onChange((value) => (this.trashNotebook = value)));
		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((button) =>
				button
					.setButtonText("Stop syncing")
					.setDestructive()
					.onClick(() => {
						this.close();
						this.view.onConfirm(this.trashNotebook);
					}),
			);
	}
}
