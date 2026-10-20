/**
 * "Set up local reading for me" (ink fork; #26, part of #8): the manual Ollama
 * steps of docs/ocr-endpoint-setup.md as one action, desktop only.
 *
 * Find Ollama on this computer, download the handwriting model if it is
 * missing — only after the owner confirms, with visible progress and a way to
 * cancel — point the OCR settings at it, then run the usual Test connection.
 * The transport lives in `transport/ollama.ts`; this is the dialogue around it.
 */

import { App, ButtonComponent, Modal, ProgressBarComponent } from "obsidian";
import { notify } from "./notify";
import { DEFAULT_SETTINGS, type RoundTripSettings } from "./settingsmodel";
import { HttpClient, TransportError } from "./transport/http";
import {
	NdjsonClient,
	OLLAMA_LOCAL,
	PullProgress,
	describePull,
	detectOllama,
	hasModel,
	listLocalModels,
	pullModel,
	pullModelBuffered,
} from "./transport/ollama";

const DOWNLOAD_URL = "https://ollama.com/download";
const LOCAL_ENDPOINT = `${OLLAMA_LOCAL}/v1`;
/** Download sizes worth telling the owner before they agree to one. */
const MODEL_SIZES: Record<string, string> = { "qwen2.5vl:7b": "about 6 GB" };
/** About two progress updates a second: Ollama reports far more often. */
const PROGRESS_INTERVAL_MS = 500;

export interface OllamaSetupHost {
	app: App;
	settings: RoundTripSettings;
	saveSettings(): Promise<void>;
	testOcrConnection(): Promise<unknown>;
	/** requestUrl, for the small calls. */
	http: HttpClient;
	/** A streaming client for the pull's progress; null where there is none. */
	stream: NdjsonClient | null;
}

export async function setUpLocalOllama(host: OllamaSetupHost, refresh: () => void): Promise<void> {
	// Always the local default: this sets up Ollama on *this* computer, not a
	// custom remote endpoint the owner may have typed in.
	const found = await detectOllama(host.http, OLLAMA_LOCAL);
	if (!found.running) {
		if (await new OllamaMissingModal(host.app, found.reason).choice()) {
			await setUpLocalOllama(host, refresh);
		}
		return;
	}

	const model = host.settings.ocrModel.trim() || DEFAULT_SETTINGS.ocrModel;
	try {
		const local = await listLocalModels(host.http, OLLAMA_LOCAL);
		if (!hasModel(local, model)) {
			const pulled = await new OllamaPullModal(host.app, model, host).result();
			if (!pulled) return;
		}
	} catch (error) {
		notify(error instanceof TransportError ? error.message : String(error), 15000);
		return;
	}

	host.settings.ocrEndpoint = LOCAL_ENDPOINT;
	host.settings.ocrModel = model;
	host.settings.ocrMode = "endpoint";
	await host.saveSettings();
	refresh();

	notify(`Testing ${model} at ${LOCAL_ENDPOINT}…`);
	try {
		await host.testOcrConnection();
		notify(`Local reading is set up — ${model} at ${LOCAL_ENDPOINT}.`);
	} catch (error) {
		notify(
			error instanceof TransportError
				? `${error.message} See the setup guide: docs/ocr-endpoint-setup.md → step 2.`
				: String(error),
			15000,
		);
	}
}

/** Ollama is not answering: link to the installer, or check again. */
class OllamaMissingModal extends Modal {
	private retry = false;
	private resolve: (retry: boolean) => void = () => {};

	constructor(
		app: App,
		private readonly reason: string,
	) {
		super(app);
	}

	/** True when the owner asks to check again. */
	choice(): Promise<boolean> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	onOpen(): void {
		this.setTitle("Ollama isn't running");
		const { contentEl } = this;
		contentEl.createEl("p", {
			text:
				"Ollama isn't running on this computer. Install it from ollama.com/download " +
				"(or start it), then press Set up local reading for me again.",
		});
		contentEl.createEl("p", { cls: "setting-item-description", text: this.reason });
		const buttons = contentEl.createDiv({ cls: "modal-button-container" });
		new ButtonComponent(buttons)
			.setButtonText("Open ollama.com/download")
			.setCta()
			.onClick(() => window.open(DOWNLOAD_URL));
		new ButtonComponent(buttons).setButtonText("Check again").onClick(() => {
			this.retry = true;
			this.close();
		});
		new ButtonComponent(buttons).setButtonText("Close").onClick(() => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
		this.resolve(this.retry);
	}
}

/** Never a silent download: confirm first, then show progress with a Cancel. */
class OllamaPullModal extends Modal {
	private pulled = false;
	private downloading = false;
	private controller: AbortController | null = null;
	private resolve: (pulled: boolean) => void = () => {};

	constructor(
		app: App,
		private readonly model: string,
		private readonly host: OllamaSetupHost,
	) {
		super(app);
	}

	/** True once the model is in Ollama. */
	result(): Promise<boolean> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	onOpen(): void {
		this.setTitle("Download the handwriting model");
		const size = MODEL_SIZES[this.model] ?? "several GB";
		const { contentEl } = this;
		const question = contentEl.createEl("p");
		question.appendText("Download ");
		question.createEl("em", { text: this.model });
		question.appendText(
			` (${size}) into Ollama on this computer? It can take a while; you can cancel and resume later.`,
		);
		const buttons = contentEl.createDiv({ cls: "modal-button-container" });
		new ButtonComponent(buttons)
			.setButtonText("Download")
			.setCta()
			.onClick(() => void this.download());
		new ButtonComponent(buttons).setButtonText("Cancel").onClick(() => this.close());
	}

	private async download(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		this.downloading = true;
		const status = contentEl.createEl("p");
		const bar = new ProgressBarComponent(contentEl.createDiv());
		const buttons = contentEl.createDiv({ cls: "modal-button-container" });
		try {
			if (this.host.stream !== null) {
				const controller = new AbortController();
				this.controller = controller;
				new ButtonComponent(buttons).setButtonText("Cancel").onClick(() => controller.abort());
				status.setText(`Downloading ${this.model} — starting…`);
				bar.setValue(0);
				let shownAt = 0;
				const show = (progress: PullProgress) => {
					status.setText(describePull(this.model, progress));
					if (progress.total > 0) bar.setValue((progress.completed / progress.total) * 100);
				};
				await pullModel(
					this.host.stream,
					OLLAMA_LOCAL,
					this.model,
					(progress) => {
						const now = Date.now();
						if (now - shownAt < PROGRESS_INTERVAL_MS) return;
						shownAt = now;
						show(progress);
					},
					controller.signal,
				);
			} else {
				// requestUrl cannot stream, and cannot be cancelled either.
				status.setText(`Downloading ${this.model}… (this can take a long time)`);
				bar.setValue(0);
				await pullModelBuffered(this.host.http, OLLAMA_LOCAL, this.model);
			}
			this.pulled = true;
			notify(`Downloaded ${this.model}.`);
		} catch (error) {
			if (this.controller?.signal.aborted === true) {
				notify(
					`Download of ${this.model} cancelled. Ollama keeps what it already has and resumes ` +
						"from there when you press Set up local reading for me again.",
					10000,
				);
			} else {
				notify(error instanceof TransportError ? error.message : String(error), 15000);
			}
		} finally {
			this.downloading = false;
			this.controller = null;
			this.close();
		}
	}

	onClose(): void {
		if (this.downloading) {
			if (this.controller !== null) {
				// Closing the dialogue is cancelling: no download carries on unseen.
				this.controller.abort();
			} else {
				notify(
					`Ollama is still downloading ${this.model} in the background. ` +
						"When it is done, press Set up local reading for me again.",
					15000,
				);
			}
		}
		this.contentEl.empty();
		this.resolve(this.pulled);
	}
}
