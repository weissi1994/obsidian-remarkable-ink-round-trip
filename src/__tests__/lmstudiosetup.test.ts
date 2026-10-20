// @vitest-environment happy-dom
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Modal, Notice, installDomHelpers } from "./helpers/obsidian";
import { LmStudioModal, type LmStudioChoice } from "../lmstudiosetup";
import { setUpLocalOllama, type OllamaSetupHost } from "../ollamasetup";
import type { App } from "obsidian";
import type { HttpClient } from "../transport/http";
import type { LmStudioModel } from "../transport/lmstudio";
import { DEFAULT_SETTINGS, type RoundTripSettings } from "../settingsmodel";

/*
 * The LM Studio branch of "Set up local reading for me", against the
 * stand-in Obsidian API: what the dialogue offers for each answer LM Studio
 * gives, and where each button leads. Detection itself is in lmstudio.test.ts.
 */

beforeAll(() => installDomHelpers());
beforeEach(() => {
	Modal.opened = [];
	Notice.shown = [];
});

const app = {} as App;
const model = (id: string, vision: boolean | null, loaded: boolean | null): LmStudioModel => ({ id, vision, loaded });

function buttons(modal: Modal): string[] {
	return [...modal.contentEl.querySelectorAll("button")].map((button) => button.textContent ?? "");
}

function click(modal: Modal, text: string): void {
	const button = [...modal.contentEl.querySelectorAll("button")].find((b) => b.textContent === text);
	if (button === undefined) throw new Error(`no ${text} button in ${buttons(modal).join(", ")}`);
	button.click();
}

function options(modal: Modal): string[] {
	return [...modal.contentEl.querySelectorAll("option")].map((option) => option.textContent ?? "");
}

function open(models: LmStudioModel[], needsApiKey = false): { modal: Modal; choice: Promise<LmStudioChoice> } {
	const dialogue = new LmStudioModal(app, models, needsApiKey);
	const choice = dialogue.choice();
	return { modal: dialogue as unknown as Modal, choice };
}

describe("LmStudioModal", () => {
	it("lists vision models only, loaded first and marked, defaulting to the loaded one", async () => {
		const { modal, choice } = open([
			model("gemma-3-4b", true, false),
			model("llama-3.2-3b", false, true),
			model("qwen2.5-vl-7b-instruct", true, true),
		]);
		expect(modal.title).toBe("LM Studio is running");
		expect(options(modal)).toEqual(["qwen2.5-vl-7b-instruct (loaded)", "gemma-3-4b"]);
		expect(modal.contentEl.querySelector("select")?.value).toBe("qwen2.5-vl-7b-instruct");
		expect(buttons(modal)).toEqual(["Use LM Studio", "Check again", "Use Ollama instead", "Close"]);
		click(modal, "Use LM Studio");
		expect(await choice).toEqual({ kind: "use", model: "qwen2.5-vl-7b-instruct" });
	});

	it("uses the model picked in the dropdown", async () => {
		const { modal, choice } = open([model("a", true, true), model("b", true, false)]);
		const select = modal.contentEl.querySelector("select");
		if (select === null) throw new Error("no dropdown");
		select.value = "b";
		select.dispatchEvent(new Event("change"));
		click(modal, "Use LM Studio");
		expect(await choice).toEqual({ kind: "use", model: "b" });
	});

	it("lists every model when LM Studio does not say which can see, with a warning", () => {
		const { modal } = open([model("qwen2.5-vl-7b-instruct", null, null), model("llama-3.2-3b", null, null)]);
		expect(options(modal)).toEqual(["qwen2.5-vl-7b-instruct", "llama-3.2-3b"]);
		expect(modal.contentEl.textContent).toContain("text-only models cannot read handwriting");
		expect(buttons(modal)).toContain("Use LM Studio");
	});

	it("guides to a vision model when there is none, without a dropdown", async () => {
		const { modal, choice } = open([model("llama-3.2-3b", false, true)]);
		expect(modal.contentEl.querySelector("select")).toBeNull();
		expect(modal.contentEl.textContent).toContain("Qwen2.5-VL-7B-Instruct");
		expect(buttons(modal)).toEqual(["Check again", "Use Ollama instead", "Close"]);
		click(modal, "Check again");
		expect(await choice).toEqual({ kind: "retry" });
	});

	it("explains the API token when the server wants one", async () => {
		const { modal, choice } = open([], true);
		expect(modal.contentEl.textContent).toContain("API token");
		expect(modal.contentEl.textContent).toContain("http://localhost:1234/v1");
		expect(modal.contentEl.querySelector("select")).toBeNull();
		click(modal, "Use Ollama instead");
		expect(await choice).toEqual({ kind: "ollama" });
	});

	it("Close resolves close", async () => {
		const { modal, choice } = open([]);
		click(modal, "Close");
		expect(await choice).toEqual({ kind: "close" });
	});
});

describe("setUpLocalOllama with LM Studio", () => {
	const V1_MODELS = JSON.stringify({
		models: [{ type: "llm", key: "qwen2.5-vl-7b-instruct", capabilities: { vision: true }, loaded_instances: [{}] }],
	});

	function host(lmStudio: boolean, ollama = false) {
		const settings: RoundTripSettings = { ...DEFAULT_SETTINGS, ocrMode: "off" };
		const calls: string[] = [];
		const http: HttpClient = async (request) => {
			calls.push(request.url);
			if (request.url.startsWith("http://localhost:11434")) {
				if (!ollama) throw new Error("net::ERR_CONNECTION_REFUSED");
				if (request.url.endsWith("/api/version")) return { status: 200, headers: {}, text: '{"version":"0.9"}' };
				return { status: 200, headers: {}, text: JSON.stringify({ models: [{ name: "qwen2.5vl:7b" }] }) };
			}
			if (!lmStudio) throw new Error("net::ERR_CONNECTION_REFUSED");
			if (request.url.endsWith("/api/v1/models")) return { status: 200, headers: {}, text: V1_MODELS };
			return { status: 404, headers: {}, text: "" };
		};
		let tested = 0;
		const setup: OllamaSetupHost = {
			app,
			settings: () => settings,
			saveSettings: async () => {},
			testOcrConnection: async () => {
				tested++;
			},
			http,
			stream: null,
		};
		return { setup, settings, calls, tested: () => tested };
	}

	/** Let the awaits before the next modal opens run. */
	const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

	it("Use LM Studio points the settings at it and tests the connection", async () => {
		const { setup, settings, tested } = host(true);
		const done = setUpLocalOllama(setup, () => {});
		await settle();
		expect(Modal.opened.map((modal) => modal.title)).toEqual(["LM Studio is running"]);
		click(Modal.opened[0], "Use LM Studio");
		await done;
		expect(settings.ocrEndpoint).toBe("http://localhost:1234/v1");
		expect(settings.ocrModel).toBe("qwen2.5-vl-7b-instruct");
		expect(settings.ocrMode).toBe("endpoint");
		expect(tested()).toBe(1);
		expect(Notice.shown[Notice.shown.length - 1]).toContain("Local reading is set up — qwen2.5-vl-7b-instruct at http://localhost:1234/v1.");
	});

	it("Use Ollama instead falls through to the Ollama dialogue", async () => {
		const { setup, settings } = host(true);
		const done = setUpLocalOllama(setup, () => {});
		await settle();
		click(Modal.opened[0], "Use Ollama instead");
		await settle();
		expect(Modal.opened.map((modal) => modal.title)).toEqual(["LM Studio is running", "Ollama isn't running"]);
		click(Modal.opened[1], "Close");
		await done;
		expect(settings.ocrMode).toBe("off");
	});

	it("Check again starts over", async () => {
		const { setup } = host(true);
		const done = setUpLocalOllama(setup, () => {});
		await settle();
		click(Modal.opened[0], "Check again");
		await settle();
		expect(Modal.opened.map((modal) => modal.title)).toEqual(["LM Studio is running", "LM Studio is running"]);
		click(Modal.opened[1], "Close");
		await done;
	});

	it("without LM Studio it goes straight to the Ollama dialogue, as before", async () => {
		const { setup } = host(false);
		const done = setUpLocalOllama(setup, () => {});
		await settle();
		expect(Modal.opened.map((modal) => modal.title)).toEqual(["Ollama isn't running"]);
		click(Modal.opened[0], "Close");
		await done;
	});

	it("a running Ollama is preferred and LM Studio is not asked", async () => {
		const { setup, settings, calls } = host(true, true);
		await setUpLocalOllama(setup, () => {});
		expect(Modal.opened).toEqual([]);
		expect(calls.some((url) => url.includes(":1234"))).toBe(false);
		expect(settings.ocrEndpoint).toBe("http://localhost:11434/v1");
	});
});
