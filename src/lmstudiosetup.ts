/**
 * The LM Studio branch of "Set up local reading for me" (ink fork; part of #28).
 *
 * When Ollama is not running but LM Studio's server is, offer a vision model
 * LM Studio already has. Detect and guide only: downloading or loading a model
 * stays in LM Studio. The transport lives in `transport/lmstudio.ts`.
 */

import { App, ButtonComponent, DropdownComponent, Modal } from "obsidian";
import { LMSTUDIO_LOCAL, type LmStudioModel, pickVisionModel } from "./transport/lmstudio";

export type LmStudioChoice =
	| { kind: "use"; model: string }
	| { kind: "retry" }
	| { kind: "ollama" }
	| { kind: "close" };

/** Loaded models first, keeping LM Studio's order otherwise. */
function loadedFirst(models: LmStudioModel[]): LmStudioModel[] {
	return [...models.filter((model) => model.loaded === true), ...models.filter((model) => model.loaded !== true)];
}

/** LM Studio answered: pick one of its vision models, or say how to get one. */
export class LmStudioModal extends Modal {
	private chosen: LmStudioChoice = { kind: "close" };
	private resolve: (choice: LmStudioChoice) => void = () => {};

	constructor(
		app: App,
		private readonly models: LmStudioModel[],
		private readonly needsApiKey: boolean,
	) {
		super(app);
	}

	choice(): Promise<LmStudioChoice> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	onOpen(): void {
		this.setTitle("LM Studio is running");
		const { contentEl } = this;
		const vision = this.models.filter((model) => model.vision === true);
		const unknown = this.models.filter((model) => model.vision === null);
		let selected: string | null = null;

		if (this.needsApiKey) {
			contentEl.createEl("p", {
				text:
					"LM Studio's server is running here, but it requires an API token. Paste the token into " +
					`API key, set the endpoint to ${LMSTUDIO_LOCAL}/v1 and the model by hand, then press ` +
					"Test connection.",
			});
		} else if (vision.length > 0 || unknown.length > 0) {
			const listed = loadedFirst(vision.length > 0 ? vision : unknown);
			contentEl.createEl("p", {
				text: "LM Studio's server is running on this computer. Read handwriting with this model:",
			});
			const dropdown = new DropdownComponent(contentEl.createDiv());
			for (const model of listed) {
				dropdown.addOption(model.id, model.loaded === true ? `${model.id} (loaded)` : model.id);
			}
			selected = (vision.length > 0 ? pickVisionModel(vision) : listed[0])?.id ?? listed[0].id;
			dropdown.setValue(selected);
			dropdown.onChange((value) => (selected = value));
			if (vision.length === 0) {
				contentEl.createEl("p", {
					cls: "setting-item-description",
					text: "LM Studio does not say which of these can see images: pick a vision model (e.g. Qwen2.5-VL); text-only models cannot read handwriting.",
				});
			}
		} else {
			const guide = contentEl.createEl("p");
			guide.appendText("LM Studio's server is running, but it has no vision model yet. In LM Studio, open ");
			guide.createEl("em", { text: "Discover" });
			guide.appendText(", search for ");
			guide.createEl("strong", { text: "Qwen2.5-VL-7B-Instruct" });
			guide.appendText(" (a vision model), download and load it, and make sure the server is running in the ");
			guide.createEl("em", { text: "Developer" });
			guide.appendText(" tab. Then press Check again.");
		}

		const buttons = contentEl.createDiv({ cls: "modal-button-container" });
		if (selected !== null) {
			new ButtonComponent(buttons)
				.setButtonText("Use LM Studio")
				.setCta()
				.onClick(() => {
					if (selected !== null) this.choose({ kind: "use", model: selected });
				});
		}
		new ButtonComponent(buttons).setButtonText("Check again").onClick(() => this.choose({ kind: "retry" }));
		new ButtonComponent(buttons).setButtonText("Use Ollama instead").onClick(() => this.choose({ kind: "ollama" }));
		new ButtonComponent(buttons).setButtonText("Close").onClick(() => this.close());
	}

	private choose(choice: LmStudioChoice): void {
		this.chosen = choice;
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
		this.resolve(this.chosen);
	}
}
