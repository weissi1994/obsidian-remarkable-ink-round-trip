import { createHash } from "crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";
import { createRequire } from "module";
import type { AddressInfo } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nodeDownload, type DownloadProgress } from "../transport/nodedownload";

/** Node's own require, standing in for Obsidian desktop's `window.require`. */
const load = createRequire(import.meta.url);

let server: Server | null = null;
let dir = "";

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "nodedownload-"));
});

afterEach(async () => {
	const running = server;
	server = null;
	if (running !== null) {
		running.closeAllConnections();
		await new Promise<void>((done) => running.close(() => done()));
	}
	rmSync(dir, { recursive: true, force: true });
});

/** A throwaway local server; resolves with its base URL. */
async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
	const started = createServer(handler);
	server = started;
	await new Promise<void>((done) => started.listen(0, "127.0.0.1", () => done()));
	return `http://127.0.0.1:${(started.address() as AddressInfo).port}`;
}

/** 256 KiB of deterministic bytes: several chunks, enough to see progress. */
const PAYLOAD = Buffer.alloc(256 * 1024, 0).map((_, i) => (i * 31) % 251);
const SHA = createHash("sha256").update(PAYLOAD).digest("hex");
const EXPECT = { size: PAYLOAD.length, sha256: SHA };

const tick = () => new Promise((done) => setTimeout(done, 10));

/** `/start` 302 → `/file`, which sends the payload in 16 KiB pieces. */
function redirectThenFile(req: IncomingMessage, res: ServerResponse): void {
	if (req.url === "/start") {
		res.writeHead(302, { Location: "/file" });
		res.end();
		return;
	}
	if (req.url === "/file") {
		res.writeHead(200, { "Content-Length": String(PAYLOAD.length) });
		void (async () => {
			for (let at = 0; at < PAYLOAD.length; at += 16 * 1024) {
				res.write(PAYLOAD.subarray(at, at + 16 * 1024));
				await tick();
			}
			res.end();
		})();
		return;
	}
	res.writeHead(404);
	res.end();
}

describe("nodeDownload (the desktop installer download)", () => {
	it("follows a 302 to a 200, checks the checksum, and leaves only the finished file", async () => {
		const base = await serve(redirectThenFile);
		const dest = join(dir, "Ollama.dmg");
		await nodeDownload(load)(`${base}/start`, dest, EXPECT, () => {});
		expect(readFileSync(dest).equals(Buffer.from(PAYLOAD))).toBe(true);
		expect(readdirSync(dir)).toEqual(["Ollama.dmg"]);
	});

	it("reports monotonic progress that ends at the full size", async () => {
		const base = await serve(redirectThenFile);
		const progress: DownloadProgress[] = [];
		await nodeDownload(load)(`${base}/start`, join(dir, "x.exe"), EXPECT, (p) => progress.push({ ...p }));
		expect(progress.length).toBeGreaterThan(1);
		for (let i = 1; i < progress.length; i++) {
			expect(progress[i].received).toBeGreaterThanOrEqual(progress[i - 1].received);
		}
		expect(progress.every((p) => p.total === PAYLOAD.length)).toBe(true);
		expect(progress[progress.length - 1].received).toBe(PAYLOAD.length);
	});

	it("takes the total from the expected size when there is no Content-Length", async () => {
		const base = await serve((_req, res) => {
			res.writeHead(200);
			res.end(Buffer.from(PAYLOAD));
		});
		const totals = new Set<number>();
		await nodeDownload(load)(`${base}/file`, join(dir, "x"), EXPECT, (p) => totals.add(p.total));
		expect([...totals]).toEqual([PAYLOAD.length]);
	});

	it("rejects a checksum mismatch and leaves neither the file nor a .part", async () => {
		const base = await serve(redirectThenFile);
		const dest = join(dir, "Ollama.dmg");
		await expect(
			nodeDownload(load)(`${base}/start`, dest, { size: PAYLOAD.length, sha256: "0".repeat(64) }, () => {}),
		).rejects.toThrow(/checksum mismatch/i);
		expect(existsSync(dest)).toBe(false);
		expect(readdirSync(dir)).toEqual([]);
	});

	it("rejects a size mismatch and leaves nothing behind", async () => {
		const base = await serve(redirectThenFile);
		await expect(
			nodeDownload(load)(`${base}/start`, join(dir, "x"), { size: PAYLOAD.length + 1, sha256: SHA }, () => {}),
		).rejects.toThrow();
		expect(readdirSync(dir)).toEqual([]);
	});

	it("aborting mid-stream rejects and removes the .part", async () => {
		const base = await serve((_req, res) => {
			res.writeHead(200, { "Content-Length": String(PAYLOAD.length) });
			res.write(PAYLOAD.subarray(0, 16 * 1024));
			// …and never finishes, like a 1.6 GB installer.
		});
		const controller = new AbortController();
		const dest = join(dir, "OllamaSetup.exe");
		const download = nodeDownload(load)(
			`${base}/file`,
			dest,
			EXPECT,
			(p) => {
				if (p.received > 0) controller.abort();
			},
			controller.signal,
		);
		await expect(download).rejects.toThrow(/abort|cancel/i);
		expect(readdirSync(dir)).toEqual([]);
	});

	it("an already-aborted signal never starts", async () => {
		let hits = 0;
		const base = await serve((_req, res) => {
			hits++;
			res.end();
		});
		const controller = new AbortController();
		controller.abort();
		await expect(
			nodeDownload(load)(`${base}/file`, join(dir, "x"), EXPECT, () => {}, controller.signal),
		).rejects.toThrow();
		expect(hits).toBe(0);
		expect(readdirSync(dir)).toEqual([]);
	});

	it("gives up after five redirects", async () => {
		const base = await serve((req, res) => {
			const hop = Number((req.url ?? "/0").slice(1));
			res.writeHead(hop >= 6 ? 200 : 307, hop >= 6 ? {} : { Location: `/${hop + 1}` });
			res.end(hop >= 6 ? Buffer.from(PAYLOAD) : undefined);
		});
		await expect(nodeDownload(load)(`${base}/0`, join(dir, "x"), EXPECT, () => {})).rejects.toThrow(/redirect/i);
		expect(readdirSync(dir)).toEqual([]);
	});

	it("follows exactly five redirects", async () => {
		const base = await serve((req, res) => {
			const hop = Number((req.url ?? "/0").slice(1));
			if (hop < 5) {
				res.writeHead(301, { Location: `/${hop + 1}` });
				res.end();
			} else {
				res.writeHead(200);
				res.end(Buffer.from(PAYLOAD));
			}
		});
		await nodeDownload(load)(`${base}/0`, join(dir, "x"), EXPECT, () => {});
		expect(readdirSync(dir)).toEqual(["x"]);
	});

	it("rejects a non-200 answer and leaves nothing behind", async () => {
		const base = await serve((_req, res) => {
			res.writeHead(404);
			res.end("Not Found");
		});
		await expect(nodeDownload(load)(`${base}/file`, join(dir, "x"), EXPECT, () => {})).rejects.toThrow(/404/);
		expect(readdirSync(dir)).toEqual([]);
	});

	it("rejects a redirect from https down to http without following it", async () => {
		const requested: string[] = [];
		const fakeHttps = {
			request(url: string, _options: unknown, onResponse: (res: unknown) => void) {
				requested.push(url);
				const handlers: Record<string, (() => void)[]> = {};
				const response = {
					statusCode: 302,
					headers: { location: "http://insecure.example/Ollama.dmg" },
					on(event: string, fn: () => void) {
						(handlers[event] ??= []).push(fn);
						return response;
					},
					resume() {},
					pause() {},
					destroy() {},
				};
				const req = {
					on() {
						return req;
					},
					end() {
						setTimeout(() => onResponse(response), 0);
					},
					destroy() {},
				};
				return req;
			},
		};
		const loader = (name: string): unknown => {
			if (name === "https") return fakeHttps;
			if (name === "http") throw new Error("http must not be used");
			return load(name);
		};
		await expect(
			nodeDownload(loader)("https://github.com/x", join(dir, "x"), EXPECT, () => {}),
		).rejects.toThrow(/https|insecure|downgrade/i);
		expect(requested).toEqual(["https://github.com/x"]);
		expect(readdirSync(dir)).toEqual([]);
	});

	it("a refused connection rejects and leaves nothing behind", async () => {
		const base = await serve(() => {});
		const stopped = server!;
		server = null;
		await new Promise<void>((done) => stopped.close(() => done()));
		await expect(nodeDownload(load)(`${base}/file`, join(dir, "x"), EXPECT, () => {})).rejects.toThrow();
		expect(readdirSync(dir)).toEqual([]);
	});
});
