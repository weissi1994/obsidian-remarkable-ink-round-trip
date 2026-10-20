/**
 * Finding Ollama's official installer for this OS (ink fork; #28, part of #8).
 *
 * GitHub's "latest release" API names each asset with its size, its
 * version-pinned download URL and a published SHA-256 (`digest`); older
 * releases without `digest` still ship a `sha256sum.txt`. The download itself
 * streams through `nodedownload.ts`; this only says what to fetch and what it
 * must hash to.
 *
 * Pure over an injected HttpClient (requestUrl at the plugin edge, which
 * follows redirects), like `ollama.ts`.
 */

import { HttpClient, TransportError } from "./http";

export const OLLAMA_RELEASES_API = "https://api.github.com/repos/ollama/ollama/releases/latest";
/**
 * Every URL handed to the download must start here: Ollama's own releases,
 * pinned to a version. Never `…/releases/latest/download/…`, which a release
 * landing mid-download could swap under a checksum read a moment earlier.
 */
export const OLLAMA_RELEASE_DOWNLOADS = "https://github.com/ollama/ollama/releases/download/";
const BY_HAND = "https://ollama.com/download";

export type InstallerOs = "macos" | "windows" | "linux" | "other";

export interface InstallerRelease {
	/** The release tag, e.g. `v0.40.6`. */
	version: string;
	url: string;
	/** Bytes. */
	size: number;
	/** Lower-case hex. */
	sha256: string;
}

/** The official installer asset per OS. Linux's is a sudo shell script: guide-only. */
export function installerAsset(os: InstallerOs): string | null {
	if (os === "macos") return "Ollama.dmg";
	if (os === "windows") return "OllamaSetup.exe";
	return null;
}

interface ReleaseAsset {
	name: string;
	size: number;
	url: string;
	digest: string | null;
}

/** The latest release's installer `asset`, with the checksum it must match. */
export async function latestInstaller(http: HttpClient, asset: string): Promise<InstallerRelease> {
	const text = await get(http, OLLAMA_RELEASES_API, { Accept: "application/vnd.github+json" }, "Ollama's release list");
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new TransportError("GitHub did not answer with Ollama's release list.");
	}
	const release = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
	const version = typeof release.tag_name === "string" ? release.tag_name : "";
	const assets = Array.isArray(release.assets) ? release.assets.map(readAsset) : [];
	const found = assets.find((entry) => entry?.name === asset);
	if (found === undefined || found === null) {
		throw new TransportError(
			`Ollama's latest release${version === "" ? "" : ` (${version})`} has no ${asset}. ` +
				`Download Ollama by hand from ${BY_HAND}.`,
		);
	}
	pinned(found.url);

	let sha256 = sha256Of(found.digest?.replace(/^sha256:/i, ""));
	if (sha256 === null) {
		const sums = assets.find((entry) => entry?.name === "sha256sum.txt");
		if (sums !== undefined && sums !== null) {
			pinned(sums.url);
			sha256 = checksumFor(await get(http, sums.url, {}, "Ollama's sha256sum.txt"), asset);
		}
	}
	if (sha256 === null) {
		throw new TransportError(
			`Ollama's latest release publishes no checksum for ${asset}, so it cannot be verified. ` +
				`Download Ollama by hand from ${BY_HAND}.`,
		);
	}
	return { version, url: found.url, size: found.size, sha256 };
}

async function get(http: HttpClient, url: string, headers: Record<string, string>, what: string): Promise<string> {
	let response;
	try {
		response = await http({ url, method: "GET", headers });
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new TransportError(`Could not reach GitHub for ${what} (${detail}).`);
	}
	if (response.status === 403 || response.status === 429) {
		throw new TransportError(
			`GitHub refused to list ${what} (${response.status}): that is GitHub's rate limit. ` +
				`Try again later, or download Ollama by hand from ${BY_HAND}.`,
			response.status,
		);
	}
	if (response.status !== 200) {
		throw new TransportError(`GitHub answered ${response.status} for ${what}.`, response.status);
	}
	return response.text;
}

function readAsset(entry: unknown): ReleaseAsset | null {
	if (typeof entry !== "object" || entry === null) return null;
	const { name, size, browser_download_url: url, digest } = entry as Record<string, unknown>;
	if (typeof name !== "string" || typeof url !== "string") return null;
	return {
		name,
		url,
		size: typeof size === "number" && Number.isFinite(size) ? size : 0,
		digest: typeof digest === "string" ? digest : null,
	};
}

function pinned(url: string): void {
	if (!url.startsWith(OLLAMA_RELEASE_DOWNLOADS)) {
		throw new TransportError(`Refusing to download from ${url}: it is not one of Ollama's GitHub releases.`);
	}
}

function sha256Of(hex: string | undefined): string | null {
	const lower = (hex ?? "").trim().toLowerCase();
	return /^[0-9a-f]{64}$/.test(lower) ? lower : null;
}

/** `sha256sum` output: `<hex>  ./<name>` (or `<hex> *<name>`) per line. */
function checksumFor(text: string, asset: string): string | null {
	for (const line of text.split(/\r?\n/)) {
		const match = /^([0-9a-fA-F]{64})\s+\*?(?:\.\/)?(.+?)\s*$/.exec(line);
		if (match !== null && match[2] === asset) return match[1].toLowerCase();
	}
	return null;
}
