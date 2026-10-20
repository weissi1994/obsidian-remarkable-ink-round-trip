/**
 * An NdjsonClient over Node's http/https modules (#26), for the Ollama pull's
 * progress on desktop: requestUrl buffers the whole response and so cannot
 * stream.
 *
 * Nothing here imports Node. The caller hands in a `require` — the plugin
 * edge passes `window.require`, and only on desktop — so the bundle carries
 * no `require("http")` that would break mobile (N7), and tests can pass
 * Node's own.
 */

import { createLineSplitter, type NdjsonClient } from "./ollama";

/** The slice of Node's http/https module the streaming client uses. */
interface NodeHttpModule {
	request(
		url: string,
		options: { method: string; headers?: Record<string, string> },
		onResponse: (response: NodeIncoming) => void,
	): NodeRequest;
}

interface NodeIncoming {
	statusCode?: number;
	setEncoding(encoding: "utf8"): void;
	on(event: "data", listener: (chunk: string) => void): void;
	on(event: "end" | "close", listener: () => void): void;
	on(event: "error", listener: (error: Error) => void): void;
}

interface NodeRequest {
	on(event: "error", listener: (error: Error) => void): void;
	on(event: "close", listener: () => void): void;
	write(body: string): void;
	end(): void;
	destroy(error?: Error): void;
}

/** Build the client from a `require`; http or https is picked per request from the URL. */
export function nodeNdjson(load: (module: string) => unknown): NdjsonClient {
	return (request, onLine, signal) =>
		new Promise((resolve, reject) => {
			if (signal?.aborted === true) {
				reject(new Error("aborted"));
				return;
			}
			const node = load(request.url.startsWith("https:") ? "https" : "http") as NodeHttpModule;
			const body = typeof request.body === "string" ? request.body : undefined;
			const headers = { ...request.headers };
			if (body !== undefined) headers["Content-Length"] = String(new TextEncoder().encode(body).length);
			const req = node.request(request.url, { method: request.method, headers }, (response) => {
				const status = response.statusCode ?? 0;
				const lines = createLineSplitter(onLine);
				let text = "";
				response.setEncoding("utf8");
				// A non-200 is one error body, not progress: keep it for the caller.
				response.on("data", (chunk) => {
					if (status === 200) lines.push(chunk);
					else text += chunk;
				});
				response.on("end", () => {
					if (status === 200) lines.flush();
					resolve({ status, text });
				});
				response.on("error", reject);
				response.on("close", () => reject(new Error("the connection closed mid-response")));
			});
			const abort = () => req.destroy(new Error("aborted"));
			signal?.addEventListener("abort", abort, { once: true });
			req.on("close", () => signal?.removeEventListener("abort", abort));
			req.on("error", reject);
			if (body !== undefined) req.write(body);
			req.end();
		});
}
