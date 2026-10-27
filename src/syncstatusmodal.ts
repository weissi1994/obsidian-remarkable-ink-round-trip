import { App, Modal, Setting } from "obsidian";
import type { SyncStatusSummary } from "./sync/statussummary";

export interface SyncStatusView {
	mode: string;
	watchFolder: string;
	summary: SyncStatusSummary;
}

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
		this.row("Queue", summary.queue);
		this.row("Queued work", String(summary.queuedWork));
		this.row("Pending local changes", String(summary.pendingChanges));
		this.row("Folder mirroring", this.view.mode);
		this.row("Sync folders", this.view.watchFolder);
		this.row("Notes in watch folder", String(summary.watchNotes));
		this.row("Watch notes not yet synced", String(summary.untrackedWatchNotes));
		this.row("Tracked notes", String(summary.trackedNotes));
		this.row(
			"Tracked notes present locally",
			String(summary.localTrackedNotes),
		);
		this.row(
			"Tracked notes missing locally",
			String(summary.missingLocalNotes),
		);
		this.row("Archived notes (notebook deleted on one side)", String(summary.archivedNotes));
		this.row(
			"Last upload",
			summary.lastUploadedAt === null
				? "Never"
				: new Date(summary.lastUploadedAt).toLocaleString(),
		);
	}

	private row(name: string, value: string): void {
		const setting = new Setting(this.contentEl).setName(name);
		setting.controlEl.setText(value);
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
				(this.view.inSyncFolder ? " It is in a sync folder, so it is sent again as a new notebook unless you move it out." : ""),
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
