/**
 * Downloading Ollama's installer to disk on desktop (ink fork; #28, part of #8).
 *
 * requestUrl buffers the whole body — 1.6 GB for Windows' installer — and
 * reports no progress, so this streams over Node's http/https instead, hashing
 * as it writes. It writes to `<dest>.part` and only renames to `dest` once the
 * size and SHA-256 match what GitHub publishes; any failure or cancel removes
 * the `.part`, so nothing half-downloaded is ever left behind.
 *
 * Like `nodestream.ts`, nothing here imports Node: the caller hands in a
 * `require` (the plugin edge passes `window.require`, and only on desktop), so
 * the bundle carries no `require("fs")` that would break mobile (N7), and tests
 * can pass Node's own.
 */

export interface DownloadProgress {
	received: number;
	/** From Content-Length, else the size GitHub lists. */
	total: number;
}

/** What the finished file must be. */
export interface DownloadExpectation {
	size: number;
	/** Lower-case hex. */
	sha256: string;
}

export type Download = (
	url: string,
	dest: string,
	expect: DownloadExpectation,
	onProgress: (progress: DownloadProgress) => void,
	signal?: AbortSignal,
) => Promise<void>;

/** GitHub sends 302s to its asset CDN; ollama.com adds a 307 in front. */
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

/** The slices of Node's modules the download uses. */
interface NodeHttpModule {
	request(
		url: string,
		options: { method: string; headers?: Record<string, string> },
		onResponse: (response: NodeIncoming) => void,
	): NodeRequest;
}

interface NodeIncoming {
	statusCode?: number;
	headers: Record<string, string | string[] | undefined>;
	on(event: "data", listener: (chunk: Uint8Array) => void): void;
	on(event: "end" | "close", listener: () => void): void;
	on(event: "error", listener: (error: Error) => void): void;
	pause(): void;
	resume(): void;
}

interface NodeRequest {
	on(event: "error", listener: (error: Error) => void): void;
	end(): void;
	destroy(error?: Error): void;
}

interface NodeWriteStream {
	write(chunk: Uint8Array): boolean;
	end(): void;
	destroy(): void;
	on(event: "close", listener: () => void): void;
	on(event: "error", listener: (error: Error) => void): void;
	once(event: "drain", listener: () => void): void;
}

interface NodeFs {
	createWriteStream(path: string): NodeWriteStream;
	rename(from: string, to: string, done: (error: Error | null) => void): void;
	unlink(path: string, done: (error: Error | null) => void): void;
	promises: {
		mkdir(path: string, options: { recursive: true }): Promise<unknown>;
		readdir(path: string): Promise<string[]>;
		unlink(path: string): Promise<void>;
	};
}

interface NodeCrypto {
	createHash(algorithm: "sha256"): { update(chunk: Uint8Array): void; digest(encoding: "hex"): string };
}

interface NodePath {
	join(...parts: string[]): string;
}

/** Build the download from a `require`; http or https is picked per hop from the URL. */
export function nodeDownload(load: (module: string) => unknown): Download {
	return (url, dest, expect, onProgress, signal) =>
		new Promise((resolve, reject) => {
			if (signal?.aborted === true) {
				reject(new Error("The download was cancelled (aborted)."));
				return;
			}
			const fs = load("fs") as NodeFs;
			const crypto = load("crypto") as NodeCrypto;
			const part = `${dest}.part`;
			let settled = false;
			let req: NodeRequest | null = null;
			let file: NodeWriteStream | null = null;
			let fileClosed: Promise<void> = Promise.resolve();

			const done = () => signal?.removeEventListener("abort", onAbort);
			const fail = (error: Error) => {
				if (settled) return;
				settled = true;
				done();
				req?.destroy();
				// Close before unlinking: Windows will not delete an open file.
				file?.destroy();
				void fileClosed.then(() => fs.unlink(part, () => reject(error)));
			};
			const onAbort = () => fail(new Error("The download was cancelled (aborted)."));
			signal?.addEventListener("abort", onAbort, { once: true });

			const save = (response: NodeIncoming) => {
				const length = Number(response.headers["content-length"]);
				const total = Number.isFinite(length) && length > 0 ? length : expect.size;
				const hash = crypto.createHash("sha256");
				let received = 0;
				let ended = false;
				const out = fs.createWriteStream(part);
				file = out;
				fileClosed = new Promise((closed) => out.on("close", () => closed()));
				out.on("error", fail);
				response.on("data", (chunk) => {
					if (settled) return;
					received += chunk.length;
					hash.update(chunk);
					if (!out.write(chunk)) {
						response.pause();
						out.once("drain", () => response.resume());
					}
					onProgress({ received, total });
				});
				response.on("error", fail);
				response.on("close", () => {
					if (!ended) fail(new Error("The connection closed mid-download."));
				});
				response.on("end", () => {
					ended = true;
					out.end();
					void fileClosed.then(() => {
						if (settled) return;
						if (received !== expect.size) {
							fail(new Error(`The download is ${received} bytes, but GitHub lists ${expect.size}: size mismatch.`));
							return;
						}
						if (hash.digest("hex") !== expect.sha256) {
							fail(new Error("Checksum mismatch: the download is not the file GitHub published."));
							return;
						}
						fs.rename(part, dest, (error) => {
							if (error !== null) {
								fail(error);
								return;
							}
							settled = true;
							done();
							resolve();
						});
					});
				});
			};

			const get = (current: string, hops: number) => {
				const node = load(current.startsWith("https:") ? "https" : "http") as NodeHttpModule;
				req = node.request(
					current,
					{ method: "GET", headers: { "User-Agent": "obsidian-remarkable-round-trip" } },
					(response) => {
						if (settled) return;
						const status = response.statusCode ?? 0;
						if (REDIRECTS.has(status)) {
							response.resume();
							const location = response.headers.location;
							if (typeof location !== "string" || location === "") {
								fail(new Error(`The download answered ${status} without saying where to go.`));
								return;
							}
							if (hops >= MAX_REDIRECTS) {
								fail(new Error(`The download redirected more than ${MAX_REDIRECTS} times.`));
								return;
							}
							let next: string;
							try {
								next = new URL(location, current).toString();
							} catch {
								fail(new Error(`The download redirected to an invalid address (${location}).`));
								return;
							}
							if (current.startsWith("https:") && !next.startsWith("https:")) {
								fail(new Error(`Refusing a redirect from https to insecure ${next}.`));
								return;
							}
							get(next, hops + 1);
							return;
						}
						if (status !== 200) {
							response.resume();
							fail(new Error(`The download answered ${status}.`));
							return;
						}
						save(response);
					},
				);
				req.on("error", fail);
				req.end();
			};

			get(url, 0);
		});
}

/**
 * Create the download folder and clear `.part` files an earlier, interrupted
 * run left behind. Finished installers stay: a DMG may still be mounted.
 */
export function nodePrepareDir(load: (module: string) => unknown): (dir: string) => Promise<void> {
	return async (dir) => {
		const fs = load("fs") as NodeFs;
		const path = load("path") as NodePath;
		await fs.promises.mkdir(dir, { recursive: true });
		for (const name of await fs.promises.readdir(dir)) {
			if (name.endsWith(".part")) await fs.promises.unlink(path.join(dir, name)).catch(() => undefined);
		}
	};
}
