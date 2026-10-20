/**
 * "Download and install Ollama" (ink fork; #28, part of #8), desktop only.
 *
 * When "Set up local reading for me" finds no Ollama: fetch the official,
 * signed installer from Ollama's GitHub release — only after the owner
 * confirms, with progress and a Cancel — check it against the published
 * SHA-256, hand it to the OS (the owner runs the installer), then wait for
 * Ollama to answer. The plugin itself installs nothing.
 *
 * Any failure notifies the reason and returns "failed": the caller goes back
 * to the "Ollama isn't running" dialogue and its ollama.com/download link.
 */

import { App, ButtonComponent, Modal, ProgressBarComponent } from "obsidian";
import { notify } from "./notify";
import { HttpClient, TransportError } from "./transport/http";
import type { Download } from "./transport/nodedownload";
import { OLLAMA_LOCAL, detectOllama } from "./transport/ollama";
import {
	InstallerOs,
	InstallerRelease,
	describeInstallerDownload,
	formatSize,
	installerAsset,
	latestInstaller,
} from "./transport/ollamarelease";

/** Same pace as the model pull's progress: about two updates a second. */
const PROGRESS_INTERVAL_MS = 500;
const POLL_INTERVAL_MS = 3000;
const POLL_LIMIT_MS = 10 * 60 * 1000;

/** The desktop pieces the installer download needs; built at the plugin edge. */
export interface DesktopInstaller {
	os: InstallerOs;
	/** Where installers are saved: the system temp folder, outside the vault. */
	dir: string;
	/** Create `dir` and clear `.part` files an interrupted download left. */
	prepare(): Promise<void>;
	/** The path of `name` inside `dir`. */
	fileFor(name: string): string;
	download: Download;
	/** Electron's `shell.openPath`: "" on success, else the error. */
	open(file: string): Promise<string>;
}

export type InstallOutcome = "installed" | "failed" | "cancelled";

/** Look up the latest installer, then confirm, download, open and wait. */
export async function installOllama(app: App, http: HttpClient, installer: DesktopInstaller): Promise<InstallOutcome> {
	const asset = installerAsset(installer.os);
	if (asset === null) return "failed";
	let release: InstallerRelease;
	try {
		release = await latestInstaller(http, asset);
	} catch (error) {
		notify(error instanceof TransportError ? error.message : String(error), 15000);
		return "failed";
	}
	return new OllamaInstallModal(app, http, installer, asset, release).result();
}

/** Confirm → progress with Cancel → "finish in the installer" while polling. */
export class OllamaInstallModal extends Modal {
	private outcome: InstallOutcome = "cancelled";
	private downloading = false;
	private closed = false;
	private controller: AbortController | null = null;
	private poll: number | null = null;
	private resolve: (outcome: InstallOutcome) => void = () => {};

	constructor(
		app: App,
		private readonly http: HttpClient,
		private readonly installer: DesktopInstaller,
		private readonly asset: string,
		private readonly release: InstallerRelease,
	) {
		super(app);
	}

	result(): Promise<InstallOutcome> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	onOpen(): void {
		this.setTitle("Download Ollama");
		const { contentEl } = this;
		const question = contentEl.createEl("p");
		question.appendText("Download the official Ollama installer (");
		question.createEl("em", { text: `${this.release.version}, ${formatSize(this.release.size)}` });
		question.appendText(") from GitHub and open it? It is saved to ");
		question.createEl("code", { text: this.installer.dir });
		question.appendText(". You finish the installation in the installer.");
		const buttons = contentEl.createDiv({ cls: "modal-button-container" });
		new ButtonComponent(buttons)
			.setButtonText("Download and open")
			.setCta()
			.onClick(() => void this.download());
		new ButtonComponent(buttons).setButtonText("Cancel").onClick(() => this.close());
	}

	private async download(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		this.downloading = true;
		const controller = new AbortController();
		this.controller = controller;
		const status = contentEl.createEl("p", { text: describeInstallerDownload(0, this.release.size) });
		const bar = new ProgressBarComponent(contentEl.createDiv());
		bar.setValue(0);
		const buttons = contentEl.createDiv({ cls: "modal-button-container" });
		new ButtonComponent(buttons).setButtonText("Cancel").onClick(() => controller.abort());
		const file = this.installer.fileFor(this.asset);
		try {
			await this.installer.prepare();
			let shownAt = 0;
			await this.installer.download(
				this.release.url,
				file,
				{ size: this.release.size, sha256: this.release.sha256 },
				({ received, total }) => {
					const now = Date.now();
					if (now - shownAt < PROGRESS_INTERVAL_MS && received < total) return;
					shownAt = now;
					status.setText(describeInstallerDownload(received, total));
					if (total > 0) bar.setValue((received / total) * 100);
				},
				controller.signal,
			);
		} catch (error) {
			if (controller.signal.aborted) {
				notify("Download of the Ollama installer cancelled.");
			} else {
				this.fail(`Could not download the Ollama installer: ${messageOf(error)}`);
			}
			this.close();
			return;
		} finally {
			this.downloading = false;
			this.controller = null;
		}
		if (this.closed) return;

		let opened: string;
		try {
			opened = await this.installer.open(file);
		} catch (error) {
			opened = messageOf(error) || "unknown error";
		}
		if (opened !== "") {
			this.fail(`Could not open the Ollama installer (${opened}). It is saved at ${file}.`);
			this.close();
			return;
		}
		this.waitForOllama();
	}

	private waitForOllama(): void {
		if (this.closed) return;
		this.setTitle("Finish installing Ollama");
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("p", { text: "Finish installing Ollama in the installer that just opened." });
		if (this.installer.os === "macos") {
			contentEl.createEl("p", { text: "In the window that opened, drag Ollama to Applications, then open it." });
		}
		const status = contentEl.createEl("p", {
			cls: "setting-item-description",
			text: "Waiting for Ollama to start…",
		});
		const buttons = contentEl.createDiv({ cls: "modal-button-container" });
		new ButtonComponent(buttons)
			.setButtonText("Check again")
			.setCta()
			.onClick(() => void this.check(status, true));
		new ButtonComponent(buttons).setButtonText("Close").onClick(() => this.close());

		const until = Date.now() + POLL_LIMIT_MS;
		const tick = async () => {
			this.poll = null;
			if (this.closed) return;
			if (await this.check(status, false)) return;
			if (this.closed) return;
			if (Date.now() >= until) {
				status.setText("Ollama hasn't started yet. Finish the installer and open Ollama, then press Check again.");
				return;
			}
			this.poll = window.setTimeout(() => void tick(), POLL_INTERVAL_MS);
		};
		this.poll = window.setTimeout(() => void tick(), POLL_INTERVAL_MS);
	}

	/** True once Ollama answers; the dialogue then closes as "installed". */
	private async check(status: HTMLElement, asked: boolean): Promise<boolean> {
		const found = await detectOllama(this.http, OLLAMA_LOCAL);
		if (this.closed) return false;
		if (found.running) {
			this.outcome = "installed";
			this.close();
			return true;
		}
		if (asked) status.setText(`Ollama isn't running yet (${found.reason}).`);
		return false;
	}

	private fail(message: string): void {
		this.outcome = "failed";
		notify(message, 15000);
	}

	onClose(): void {
		if (this.closed) return;
		this.closed = true;
		// Closing the dialogue is cancelling: no download carries on unseen.
		if (this.downloading) this.controller?.abort();
		if (this.poll !== null) window.clearTimeout(this.poll);
		this.poll = null;
		this.contentEl.empty();
		this.resolve(this.outcome);
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
