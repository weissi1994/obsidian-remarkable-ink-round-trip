import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";
import { createRequire } from "module";
import type { AddressInfo } from "net";
import { afterEach, describe, expect, it } from "vitest";
import { nodeNdjson } from "../transport/nodestream";
import { pullModel, type PullProgress } from "../transport/ollama";

/** Node's own require, standing in for Obsidian desktop's `window.require`. */
const load = createRequire(import.meta.url);

let server: Server | null = null;

afterEach(async () => {
	const running = server;
	server = null;
	if (running !== null) await new Promise<void>((done) => running.close(() => done()));
});

/** A throwaway local server; resolves with its base URL. */
async function serve(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void): Promise<string> {
	const started = createServer((req, res) => {
		let body = "";
		req.setEncoding("utf8");
		req.on("data", (chunk: string) => (body += chunk));
		req.on("end", () => handler(req, res, body));
	});
	server = started;
	await new Promise<void>((done) => started.listen(0, "127.0.0.1", () => done()));
	return `http://127.0.0.1:${(started.address() as AddressInfo).port}`;
}

const tick = () => new Promise((done) => setTimeout(done, 10));

describe("nodeNdjson (the desktop streaming client)", () => {
	it("streams a real pull: lines split mid-JSON arrive whole, before the response ends", async () => {
		let seen: { method?: string; body: string; origin?: string; length?: string } | null = null;
		const base = await serve((req, res, body) => {
			seen = { method: req.method, body, origin: req.headers.origin, length: req.headers["content-length"] };
			res.writeHead(200, { "Content-Type": "application/x-ndjson" });
			void (async () => {
				res.write('{"status":"pulling manifest"}\n{"status":"pulling a","digest":"sha256:a",');
				await tick();
				res.write('"total":2000,"completed":500}\n{"status":"pulling b","digest":"sha256:b","total":1000,"completed":1000}\n');
				await tick();
				res.write('{"status":"success"}');
				res.end();
			})();
		});
		const progress: PullProgress[] = [];
		await pullModel(nodeNdjson(load), base, "qwen2.5vl:7b", (p) => progress.push(p));
		expect(seen).toEqual({
			method: "POST",
			body: '{"model":"qwen2.5vl:7b","stream":true}',
			origin: undefined,
			length: "38",
		});
		expect(progress).toEqual([
			{ status: "pulling manifest", completed: 0, total: 0 },
			{ status: "pulling a", completed: 500, total: 2000 },
			{ status: "pulling b", completed: 1500, total: 3000 },
			{ status: "success", completed: 1500, total: 3000 },
		]);
	});

	it("hands back a non-200 body as text instead of lines", async () => {
		const base = await serve((_req, res) => {
			res.writeHead(400);
			res.end('{"error":"model name is required"}');
		});
		const lines: string[] = [];
		const result = await nodeNdjson(load)({ url: `${base}/api/pull`, method: "POST", body: "{}" }, (l) => lines.push(l));
		expect(result).toEqual({ status: 400, text: '{"error":"model name is required"}' });
		expect(lines).toEqual([]);
	});

	it("aborting mid-download destroys the request, and the pull reports it cancelled", async () => {
		let serverSawClose = false;
		const base = await serve((req, res) => {
			res.writeHead(200);
			res.write('{"status":"pulling a","digest":"sha256:a","total":100,"completed":1}\n');
			req.socket.on("close", () => (serverSawClose = true));
			// …and never finishes, like a 6 GB download.
		});
		const controller = new AbortController();
		const pull = pullModel(nodeNdjson(load), base, "m", () => controller.abort(), controller.signal);
		await expect(pull).rejects.toThrow(/cancelled/);
		await tick();
		expect(serverSawClose).toBe(true);
	});

	it("a stopped server rejects, which the pull reports as connection refused", async () => {
		const base = await serve(() => {});
		const stopped = server!;
		server = null;
		await new Promise<void>((done) => stopped.close(() => done()));
		await expect(pullModel(nodeNdjson(load), base, "m", () => {})).rejects.toThrow(/connection refused/);
	});
});
