/**
 * The settings tab (PRD F1, F7, F9-basis).
 *
 * One declarative description: `getSettingDefinitions()` walks
 * `settingschema.ts`, which is also what puts these settings in the settings
 * search (GP_E4_S3). The imperative `display()` fallback for pre-1.13
 * versions was deleted when minAppVersion moved to 1.13.0 (GP_E5_S8) — its
 * deprecation warnings were kept standing as exactly this deletion list.
 */

import {
	App,
	ButtonComponent,
	Platform,
	PluginSettingTab,
	type SettingDefinition,
	type SettingDefinitionItem,
} from "obsidian";
import { notify } from "./notify";
import type RoundTripPlugin from "./main";
// One address for "the settings": the model lives in its own module so the
// schema and the projection can use it without the Obsidian API, but
// importers need not care (GP_E4_S3).
export * from "./settingsmodel";
import { TransportError } from "./transport/http";
import {
	SETTING_SECTIONS,
	type SettingSpec,
	checkEndpoint,
	cleanPath,
	checkArchiveFolder,
	isVisible,
	readSetting,
	writeSetting,
} from "./settingschema";
import { parseFolderList } from "./sync/watcher";

/** Not a stored setting: the one-time code lives only until pairing. */
const PAIRING_CODE_KEY = "__pairingCode";

/** Folder paths are stored trimmed and without leading or trailing slashes. */
function sanitise(key: string, value: unknown): unknown {
	// Ink fork: the colour dropdown hands back strings; the pen wants an id.
	if (key === "inkColor") return Number(value);
	if (typeof value !== "string") return value;
	if (key === "watchFolderPath") return parseFolderList(value).join(", ");
	return key.toLowerCase().includes("folder") || key === "customEndpointUrl"
		? cleanPath(value)
		: value;
}

export class RoundTripSettingTab extends PluginSettingTab {
	private pairingCode = "";

	constructor(
		app: App,
		private readonly plugin: RoundTripPlugin,
	) {
		super(app, plugin);
	}

	/**
	 * The declarative description; implementing this is also what makes these
	 * settings findable in the settings search (GP_E4_S3). See
	 * `settingschema.ts` for the screen-as-data it walks.
	 */
	getSettingDefinitions(): SettingDefinitionItem[] {
		const groups: SettingDefinitionItem[] = [
			{
				type: "group",
				heading: "Connection",
				items: [
					{
						name: "Status",
						desc: this.pairingStatus(),
					},
					{
						name: "Pair with one-time code",
						desc: "Enter the 8-letter code, then select Pair.",
						visible: () => !this.paired,
						control: { type: "text", key: PAIRING_CODE_KEY, placeholder: "abcdefgh" },
					},
					{
						name: "Pair",
						desc: "Exchange the code for a device token.",
						visible: () => !this.paired,
						action: (el) => {
							new ButtonComponent(el)
								.setButtonText("Pair")
								.setCta()
								.onClick(() => void this.pair());
						},
					},
					{
						name: "Unpair",
						desc: "Forget the stored device token.",
						visible: () => this.paired,
						action: (el) => {
							new ButtonComponent(el)
								.setButtonText("Unpair")
								.setDestructive()
								.onClick(() => void this.unpair());
						},
					},
					...SETTING_SECTIONS[0].items.map((spec) => this.defineSetting(spec)),
				],
			},
		];

		for (const section of SETTING_SECTIONS.slice(1)) {
			groups.push({
				type: "group",
				heading: section.heading,
				items: [
					...(section.note === undefined
						? []
						: [{ name: section.heading, desc: section.note, searchable: false }]),
					...section.items.map((spec) => this.defineSetting(spec)),
					...(section.heading === "Handwriting" ? this.handwritingActions() : []),
					...(section.heading === "Reading handwriting (OCR)" ? this.ocrActions() : []),
				],
			});
		}
		return groups;
	}

	/** Ink fork: the handwriting sheet and page-size buttons. */
	private handwritingActions(): SettingDefinition[] {
		const button = (text: string, run: () => Promise<void>, cta = false) => (el: HTMLElement) => {
			const component = new ButtonComponent(el).setButtonText(text).onClick(() => {
				void run().then(() => this.update());
			});
			if (cta) component.setCta();
		};
		const s = this.plugin.settings;
		return [
			{
				name: "My handwriting",
				desc:
					s.handVersion === ""
						? "Not learned yet. Send the sheet, fill it in on the reMarkable, sync, then learn."
						: `Learned (${s.handVersion}).` +
							(s.pendingSheet === null ? "" : " A sheet is waiting on the tablet."),
			},
			{
				name: "Send handwriting sheet",
				desc: "A notebook of labelled boxes: write each character once, on the line.",
				action: button("Send sheet", () => this.plugin.sendHandwritingSheet(), s.handVersion === ""),
			},
			{
				name: "Learn from the sheet",
				desc: "Read the filled-in sheet. Replaces the handwriting learned before.",
				visible: () => this.plugin.settings.pendingSheet !== null,
				action: button("Learn", () => this.plugin.learnHandwriting(false), true),
			},
			{
				name: "Add variations",
				desc:
					"Fill in a fresh sheet and add it: up to three samples per character, " +
					"used in turn, so repeated letters look less identical.",
				visible: () =>
					this.plugin.settings.pendingSheet !== null && this.plugin.settings.handVersion !== "",
				action: button("Add", () => this.plugin.learnHandwriting(true)),
			},
			{
				name: "Joined-up words",
				desc:
					"For reading joined-up handwriting: write common words once on a word sheet " +
					"(it also learns from every remark text you correct)." +
					(s.pendingWordSheet === null ? "" : " A word sheet is waiting on the tablet."),
				action: button("Send word sheet", () => this.plugin.sendWordSheet()),
			},
			{
				name: "Learn from the word sheet",
				desc: "Read the filled-in word sheet and add its words to the ones learned.",
				visible: () => this.plugin.settings.pendingWordSheet !== null,
				action: button("Learn", () => this.plugin.learnWordSheet(), true),
			},
			{
				name: "Handwriting test",
				desc:
					"See how well your handwriting is read: copy prepared lines on a test sheet, then save " +
					"each reader's result with your ink to the vault, to attach to an issue. Learns nothing." +
					(s.pendingTestSheet === null ? "" : " A test sheet is waiting on the tablet."),
				action: (el: HTMLElement) => {
					button("Send", () => this.plugin.sendTestSheet())(el);
					if (this.plugin.settings.pendingTestSheet !== null) button("Save", () => this.plugin.saveTestSheet(), true)(el);
				},
			},
			{
				name: "Detect page size",
				desc: "Read the canvas size from a notebook made on your reMarkable.",
				action: button("Detect", () => this.plugin.detectPageSize()),
			},
		];
	}

	/** Ink fork: the vision-endpoint "Test connection" and one-click Ollama setup buttons. */
	private ocrActions(): SettingDefinition[] {
		return [
			{
				name: "Set up local reading for me",
				desc:
					"Desktop only: finds Ollama on this computer, downloads the handwriting model if " +
					"needed (you confirm first), and points the plugin at it. Without Ollama, it also " +
					"finds LM Studio's server and offers a vision model already downloaded there.",
				visible: () => Platform.isDesktopApp,
				action: (el: HTMLElement) => {
					new ButtonComponent(el).setButtonText("Set up").onClick(async () => {
						try {
							await this.plugin.setUpLocalOllama(() => this.update());
						} catch (error) {
							notify(
								error instanceof TransportError ? error.message : String(error),
								15000,
							);
						}
					});
				},
			},
			{
				name: "Test connection",
				desc:
					"Pings the endpoint, checks it serves the model, and sends a tiny probe image — " +
					"so a misconfigured server tells you exactly what is wrong.",
				visible: () => this.plugin.settings.ocrMode === "endpoint",
				action: (el: HTMLElement) => {
					new ButtonComponent(el).setButtonText("Test connection").onClick(async () => {
						const s = this.plugin.settings;
						notify(`Testing ${s.ocrModel} at ${s.ocrEndpoint}…`);
						try {
							await this.plugin.testOcrConnection();
							notify(`Connected to ${s.ocrModel} at ${s.ocrEndpoint} — probe read OK.`);
						} catch (error) {
							notify(
								error instanceof TransportError ? error.message : String(error),
								15000,
							);
						}
					});
				},
			},
		];
	}

	/** One schema entry as a declarative definition. */
	private defineSetting(spec: SettingSpec): SettingDefinition {
		const base = {
			name: spec.name,
			desc: spec.desc,
			visible: () => isVisible(spec, this.plugin.settings),
		};
		switch (spec.control.type) {
			case "toggle":
				return { ...base, control: { type: "toggle", key: spec.key } };
			case "dropdown":
				return {
					...base,
					control: { type: "dropdown", key: spec.key, options: spec.control.options },
				};
			case "slider":
				return {
					...base,
					control: {
						type: "slider",
						key: spec.key,
						min: spec.control.min,
						max: spec.control.max,
						step: spec.control.step,
					},
				};
			default:
				return {
					...base,
					control: {
						type: "text",
						key: spec.key,
						placeholder: spec.control.placeholder,
						validate:
							spec.control.sanitise === "url"
								? (value: string) => checkEndpoint(value)
								: spec.key === "archiveFolder"
									? (value: string) => checkArchiveFolder(value, this.plugin.settings.watchFolderPath)
									: spec.key === "watchFolderPath"
										? (value: string) => checkArchiveFolder(this.plugin.settings.archiveFolder, value)
										: undefined,
					},
				};
		}
	}

	/** Obsidian 1.13+ reads values through here; dotted keys reach nested ones. */
	getControlValue(key: string): unknown {
		if (key === PAIRING_CODE_KEY) return this.pairingCode;
		return readSetting(this.plugin.settings, key);
	}

	/** …and writes them through here, applying the same cleanup as `display()`. */
	async setControlValue(key: string, value: unknown): Promise<void> {
		if (key === PAIRING_CODE_KEY) {
			this.pairingCode = String(value);
			return;
		}
		const next = writeSetting(this.plugin.settings, key, sanitise(key, value));
		// A sync folder holding the archive (or the reverse) is never stored.
		const clash = key === "archiveFolder" || key === "watchFolderPath" ? checkArchiveFolder(next.archiveFolder, next.watchFolderPath) : undefined;
		if (clash !== undefined) {
			notify(clash);
			return;
		}
		this.plugin.settings = next;
		await this.plugin.saveSettings();
	}

	private get paired(): boolean {
		return this.plugin.settings.deviceToken !== "";
	}

	private pairingStatus(): string {
		return this.paired
			? "Paired with a reMarkable account."
			: "Not paired. Get a one-time code at my.remarkable.com/device/browser/connect.";
	}

	private async pair(): Promise<void> {
		try {
			const client = this.plugin.createClient();
			const registration = await client.register(this.pairingCode);
			this.plugin.settings.deviceToken = registration.deviceToken;
			await this.plugin.saveSettings();
			notify("Paired with your reMarkable account.");
			// The pairing state changes both the Status text and which
			// controls exist — structural, so rebuild the definitions.
			this.update();
		} catch (error) {
			notify(
				error instanceof TransportError
					? error.message
					: "Pairing failed — check your connection and try again.",
			);
		}
	}

	private async unpair(): Promise<void> {
		this.plugin.settings.deviceToken = "";
		await this.plugin.saveSettings();
		notify("Device token removed.");
		this.update();
	}
}
