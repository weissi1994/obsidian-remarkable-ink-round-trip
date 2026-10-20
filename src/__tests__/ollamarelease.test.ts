import { describe, expect, it } from "vitest";
import { TransportError, type HttpClient, type HttpRequest } from "../transport/http";
import { OLLAMA_RELEASES_API, installerAsset, latestInstaller } from "../transport/ollamarelease";

const HEX = "a".repeat(64);
const OTHER_HEX = "b".repeat(64);
const PINNED = "https://github.com/ollama/ollama/releases/download/v0.40.6";

/** A fake HttpClient answering per URL; anything unlisted is a 404. */
function routes(table: Record<string, { status: number; text: string }>, seen: HttpRequest[] = []): HttpClient {
	return async (request) => {
		seen.push(request);
		const hit = table[request.url];
		return hit === undefined
			? { status: 404, headers: {}, text: "Not Found" }
			: { status: hit.status, headers: {}, text: hit.text };
	};
}

function release(assets: unknown[], tag = "v0.40.6"): string {
	return JSON.stringify({ tag_name: tag, assets });
}

function asset(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { name, size: 214_000_000, browser_download_url: `${PINNED}/${name}`, ...extra };
}

describe("installerAsset", () => {
	it("maps each OS to its official installer, and Linux/other to none", () => {
		expect(installerAsset("macos")).toBe("Ollama.dmg");
		expect(installerAsset("windows")).toBe("OllamaSetup.exe");
		expect(installerAsset("linux")).toBeNull();
		expect(installerAsset("other")).toBeNull();
	});
});

describe("latestInstaller", () => {
	it("reads version, pinned URL, size and the API digest", async () => {
		const seen: HttpRequest[] = [];
		const http = routes(
			{
				[OLLAMA_RELEASES_API]: {
					status: 200,
					text: release([
						asset("Ollama-darwin.zip", { digest: `sha256:${OTHER_HEX}` }),
						asset("Ollama.dmg", { digest: `sha256:${HEX.toUpperCase()}` }),
					]),
				},
			},
			seen,
		);
		await expect(latestInstaller(http, "Ollama.dmg")).resolves.toEqual({
			version: "v0.40.6",
			url: `${PINNED}/Ollama.dmg`,
			size: 214_000_000,
			sha256: HEX,
		});
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ method: "GET", url: OLLAMA_RELEASES_API });
		expect(seen[0].headers?.Accept).toBe("application/vnd.github+json");
	});

	it("falls back to the release's sha256sum.txt when the API has no digest", async () => {
		const http = routes({
			[OLLAMA_RELEASES_API]: {
				status: 200,
				text: release([asset("OllamaSetup.exe"), asset("sha256sum.txt", { size: 300 })]),
			},
			[`${PINNED}/sha256sum.txt`]: {
				status: 200,
				text: `${OTHER_HEX}  ./Ollama.dmg\n${HEX}  ./OllamaSetup.exe\n${OTHER_HEX}  ./OllamaSetup.exe.sig\n`,
			},
		});
		const found = await latestInstaller(http, "OllamaSetup.exe");
		expect(found.sha256).toBe(HEX);
		expect(found.url).toBe(`${PINNED}/OllamaSetup.exe`);
	});

	it("throws when neither the API nor sha256sum.txt has a checksum", async () => {
		const http = routes({
			[OLLAMA_RELEASES_API]: { status: 200, text: release([asset("Ollama.dmg", { digest: "sha256:short" })]) },
		});
		await expect(latestInstaller(http, "Ollama.dmg")).rejects.toThrow(/checksum/i);
	});

	it("throws a readable error when the release has no such asset", async () => {
		const http = routes({ [OLLAMA_RELEASES_API]: { status: 200, text: release([asset("Ollama.dmg")]) } });
		const error = await latestInstaller(http, "OllamaSetup.exe").catch((e: unknown) => e);
		expect(error).toBeInstanceOf(TransportError);
		expect((error as Error).message).toMatch(/OllamaSetup\.exe/);
	});

	it("refuses a download URL outside Ollama's GitHub releases", async () => {
		for (const url of [
			"https://evil.example/ollama/ollama/releases/download/v0.40.6/Ollama.dmg",
			"https://github.com/ollama/ollama/releases/latest/download/Ollama.dmg",
			"http://github.com/ollama/ollama/releases/download/v0.40.6/Ollama.dmg",
		]) {
			const http = routes({
				[OLLAMA_RELEASES_API]: {
					status: 200,
					text: release([asset("Ollama.dmg", { browser_download_url: url, digest: `sha256:${HEX}` })]),
				},
			});
			await expect(latestInstaller(http, "Ollama.dmg")).rejects.toThrow(TransportError);
		}
	});

	it("explains GitHub's rate limit on a 403 or 429", async () => {
		for (const status of [403, 429]) {
			const http = routes({ [OLLAMA_RELEASES_API]: { status, text: '{"message":"API rate limit exceeded"}' } });
			const error = await latestInstaller(http, "Ollama.dmg").catch((e: unknown) => e);
			expect(error).toBeInstanceOf(TransportError);
			expect((error as TransportError).status).toBe(status);
			expect((error as Error).message).toMatch(/rate limit/i);
			expect((error as Error).message).toMatch(/try again later|download .*by hand/i);
		}
	});

	it("reports any other non-200 with its status", async () => {
		const http = routes({ [OLLAMA_RELEASES_API]: { status: 502, text: "Bad Gateway" } });
		await expect(latestInstaller(http, "Ollama.dmg")).rejects.toThrow(/502/);
	});

	it("turns a failed connection into a TransportError", async () => {
		const http: HttpClient = async () => {
			throw new Error("getaddrinfo ENOTFOUND api.github.com");
		};
		await expect(latestInstaller(http, "Ollama.dmg")).rejects.toThrow(TransportError);
	});
});
