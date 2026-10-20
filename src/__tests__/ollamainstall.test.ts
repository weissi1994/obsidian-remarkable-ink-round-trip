// @vitest-environment happy-dom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installDomHelpers, openedModals } from "./helpers/obsidian";
import type { DesktopInstaller } from "../ollamainstall";
import type { OllamaSetupHost } from "../ollamasetup";
import type { HttpClient } from "../transport/http";
import type { DownloadProgress } from "../transport/nodedownload";
import { OLLAMA_RELEASES_API } from "../transport/ollamarelease";

/*
 * The "Download and install Ollama" dialogue, from "Ollama isn't running"
 * through confirm, download, open and wait, back into v1's flow — against a
 * stand-in for the Obsidian API and fakes for GitHub, the download and the
 * OS. The real download is tested in nodedownload.test.ts; the real
 * `shell.openPath` and installers can only be tried by hand.
 */

const notices: string[] = [];
vi.mock("../notify", () => ({ notify: (message: string) => notices.push(message) }));

beforeAll(() => installDomHelpers());
beforeEach(() => {
	notices.length = 0;
	openedModals.length = 0;
});

const HEX = "c".repeat(64);
const URL_DMG = "https://github.com/ollama/ollama/releases/download/v0.40.6/Ollama.dmg";
const MODEL = "qwen2.5vl:7b";

/** GitHub's release list, and an Ollama that is up once `up()` says so. */
function fakeHttp(up: () => boolean): HttpClient {
	return async ({ url }) => {
		if (url === OLLAMA_RELEASES_API) {
			const assets = [{ name: "Ollama.dmg", size: 214_000_000, browser_download_url: URL_DMG, digest: `sha256:${HEX}` }];
			return { status: 200, headers: {}, text: JSON.stringify({ tag_name: "v0.40.6", assets }) };
		}
		if (!up()) throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
		if (url.endsWith("/api/version")) return { status: 200, headers: {}, text: '{"version":"0.40.6"}' };
		if (url.endsWith("/api/tags")) return { status: 200, headers: {}, text: JSON.stringify({ models: [{ name: MODEL }] }) };
		return { status: 404, headers: {}, text: "" };
	};
}

function fakeInstaller(os: DesktopInstaller["os"], overrides: Partial<DesktopInstaller> = {}) {
	const calls: { url: string; dest: string; expect: unknown; signal?: AbortSignal }[] = [];
	const opened: string[] = [];
	const installer: DesktopInstaller = {
		os,
		dir: "/tmp/remarkable-ink-ollama",
		prepare: async () => {},
		fileFor: (name) => `/tmp/remarkable-ink-ollama/${name}`,
		download: async (url, dest, expect, onProgress: (p: DownloadProgress) => void, signal) => {
			calls.push({ url, dest, expect, signal });
			onProgress({ received: 107_000_000, total: 214_000_000 });
			onProgress({ received: 214_000_000, total: 214_000_000 });
		},
		open: async (file) => {
			opened.push(file);
			return "";
		},
		...overrides,
	};
	return { installer, calls, opened };
}

async function settle(): Promise<void> {
	for (let i = 0; i < 20; i++) await new Promise((done) => setTimeout(done, 0));
}

function top() {
	return openedModals[openedModals.length - 1] as unknown as { contentEl: HTMLElement; title: string; close(): void };
}

function button(text: string): HTMLButtonElement {
	const found = Array.from(top().contentEl.querySelectorAll("button")).find((b) => b.textContent === text);
	if (found === undefined) throw new Error(`no "${text}" button in: ${top().contentEl.textContent}`);
	return found;
}

function buttons(): string[] {
	return Array.from(top().contentEl.querySelectorAll("button")).map((b) => b.textContent ?? "");
}

async function start(installer: DesktopInstaller | null, http: HttpClient) {
	const { setUpLocalOllama } = await import("../ollamasetup");
	const settings = { ocrEndpoint: "", ocrModel: MODEL, ocrMode: "off" } as Record<string, string>;
	const tested: string[] = [];
	const host = {
		app: {},
		settings: () => settings,
		saveSettings: async () => {},
		testOcrConnection: async () => tested.push(settings.ocrEndpoint),
		http,
		stream: null,
		installer,
	} as unknown as OllamaSetupHost;
	const done = setUpLocalOllama(host, () => {});
	await settle();
	return { done, settings, tested };
}

describe("Ollama isn't running", () => {
	it("offers the installer download on macOS, with the link as a secondary button", async () => {
		const { done } = await start(fakeInstaller("macos").installer, fakeHttp(() => false));
		expect(buttons()).toEqual(["Download and install Ollama", "Open ollama.com/download", "Check again", "Close"]);
		button("Close").click();
		await done;
	});

	it("keeps v1's link alone where there is no installer (mobile, or no Electron)", async () => {
		const { done } = await start(null, fakeHttp(() => false));
		expect(buttons()).toEqual(["Open ollama.com/download", "Check again", "Close"]);
		button("Close").click();
		await done;
	});

	it("shows Linux the install command with a Copy button, and no download", async () => {
		const writeText = vi.fn(async () => {});
		Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
		const { done } = await start(fakeInstaller("linux").installer, fakeHttp(() => false));
		expect(top().contentEl.querySelector("pre code")?.textContent).toBe("curl -fsSL https://ollama.com/install.sh | sh");
		expect(top().contentEl.textContent).toMatch(/sudo/);
		expect(buttons()).not.toContain("Download and install Ollama");
		button("Copy command").click();
		await settle();
		expect(writeText).toHaveBeenCalledWith("curl -fsSL https://ollama.com/install.sh | sh");
		expect(notices).toContain("Copied");
		button("Close").click();
		await done;
	});
});

describe("Download and install Ollama", () => {
	it("confirms, downloads the pinned URL against its checksum, opens it, waits, then carries on into v1", async () => {
		let up = false;
		const { installer, calls, opened } = fakeInstaller("macos");
		const { done, settings, tested } = await start(installer, fakeHttp(() => up));
		button("Download and install Ollama").click();
		await settle();

		// Never a silent download: version, size and folder first.
		expect(calls).toHaveLength(0);
		expect(top().contentEl.textContent).toContain("v0.40.6, 214 MB");
		expect(top().contentEl.textContent).toContain("/tmp/remarkable-ink-ollama");
		button("Download and open").click();
		await settle();

		expect(calls).toEqual([
			expect.objectContaining({
				url: URL_DMG,
				dest: "/tmp/remarkable-ink-ollama/Ollama.dmg",
				expect: { size: 214_000_000, sha256: HEX },
			}),
		]);
		expect(opened).toEqual(["/tmp/remarkable-ink-ollama/Ollama.dmg"]);
		expect(top().title).toBe("Finish installing Ollama");
		expect(top().contentEl.textContent).toMatch(/drag Ollama to Applications/);

		button("Check again").click();
		await settle();
		expect(top().contentEl.textContent).toMatch(/isn't running yet/);

		up = true;
		button("Check again").click();
		await done;
		expect(settings.ocrEndpoint).toBe("http://localhost:11434/v1");
		expect(tested).toEqual(["http://localhost:11434/v1"]);
	});

	it("goes back to the link when the installer cannot be opened", async () => {
		const { installer } = fakeInstaller("windows", { open: async () => "No application is associated" });
		const http = fakeHttp(() => false);
		const asked: HttpClient = async (request) =>
			request.url === OLLAMA_RELEASES_API
				? {
						status: 200,
						headers: {},
						text: JSON.stringify({
							tag_name: "v0.40.6",
							assets: [
								{
									name: "OllamaSetup.exe",
									size: 1_580_000_000,
									browser_download_url: URL_DMG.replace("Ollama.dmg", "OllamaSetup.exe"),
									digest: `sha256:${HEX}`,
								},
							],
						}),
					}
				: http(request);
		const { done } = await start(installer, asked);
		button("Download and install Ollama").click();
		await settle();
		expect(top().contentEl.textContent).toContain("v0.40.6, 1.58 GB");
		button("Download and open").click();
		await settle();
		expect(notices.some((n) => /No application is associated/.test(n))).toBe(true);
		expect(top().title).toBe("Ollama isn't running");
		expect(buttons()).toContain("Open ollama.com/download");
		button("Close").click();
		await done;
	});

	it("goes back to the link when the download fails its checksum", async () => {
		const { installer } = fakeInstaller("macos", {
			download: async () => {
				throw new Error("Checksum mismatch: the download is not the file GitHub published.");
			},
		});
		const { done } = await start(installer, fakeHttp(() => false));
		button("Download and install Ollama").click();
		await settle();
		button("Download and open").click();
		await settle();
		expect(notices.some((n) => /checksum mismatch/i.test(n))).toBe(true);
		expect(top().title).toBe("Ollama isn't running");
		button("Close").click();
		await done;
	});

	it("goes back to the link when GitHub rate-limits the lookup", async () => {
		const http = fakeHttp(() => false);
		const limited: HttpClient = async (request) =>
			request.url === OLLAMA_RELEASES_API ? { status: 403, headers: {}, text: "" } : http(request);
		const { done } = await start(fakeInstaller("macos").installer, limited);
		button("Download and install Ollama").click();
		await settle();
		expect(notices.some((n) => /rate limit/i.test(n))).toBe(true);
		expect(top().title).toBe("Ollama isn't running");
		button("Close").click();
		await done;
	});

	it("closing the dialogue mid-download aborts it and stops", async () => {
		let signal: AbortSignal | undefined;
		const { installer, opened } = fakeInstaller("macos", {
			download: (_url, _dest, _expect, _progress, given) =>
				new Promise((_resolve, reject) => {
					signal = given;
					given?.addEventListener("abort", () => reject(new Error("The download was cancelled (aborted).")));
				}),
		});
		const { done } = await start(installer, fakeHttp(() => false));
		button("Download and install Ollama").click();
		await settle();
		button("Download and open").click();
		await settle();
		expect(signal?.aborted).toBe(false);
		top().close();
		await done;
		expect(signal?.aborted).toBe(true);
		expect(opened).toEqual([]);
		expect(notices.some((n) => /cancelled/i.test(n))).toBe(true);
	});
});
