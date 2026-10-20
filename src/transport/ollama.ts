/**
 * Setting up a local Ollama from inside the plugin (ink fork; #26, part of #8).
 *
 * Everything the `ollama` CLI would do for first-time setup goes through
 * Ollama's own HTTP API instead — no shelling out, nothing Node-only here:
 * `GET /api/version` says it is installed and running, `GET /api/tags` lists
 * the models it has, and `POST /api/pull` downloads one, streaming NDJSON
 * progress lines `{status, digest?, total?, completed?}` that end in
 * `{"status":"success"}` or an `{"error": …}` line.
 *
 * Pure over an injected HttpClient and NdjsonClient, like `ocr.ts`: the plugin
 * edge supplies requestUrl for the small calls and a streaming client for the
 * pull, because requestUrl buffers the whole response and so cannot report
 * progress.
 */

import { HttpClient, HttpRequest, TransportError } from "./http";

/** Ollama's default address on this computer. */
export const OLLAMA_LOCAL = "http://localhost:11434";

/**
 * A POST whose response arrives as newline-delimited JSON, handed over one
 * complete line at a time as it streams in. Resolves when the response ends;
 * like HttpClient it never throws on a non-2xx status (the body is in `text`),
 * but rejects when it cannot connect or the signal aborts it.
 */
export type NdjsonClient = (
	request: HttpRequest,
	onLine: (line: string) => void,
	signal?: AbortSignal,
) => Promise<{ status: number; text: string }>;

/** The server root for an OCR endpoint: `http://localhost:11434/v1` → `http://localhost:11434`. */
export function ollamaBase(endpoint: string): string {
	return endpoint
		.trim()
		.replace(/\/+$/, "")
		.replace(/\/v1$/i, "")
		.replace(/\/+$/, "");
}

/** The same connection-failure signatures `send()` in `ocr.ts` recognises. */
const REFUSED = /refus|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|timed? ?out|network|socket/i;

function unreachable(base: string, error: unknown): string {
	const detail = error instanceof Error ? error.message : String(error);
	return REFUSED.test(detail)
		? `Ollama is not answering at ${base} (connection refused).`
		: `Ollama is not answering at ${base} (${detail}).`;
}

/** The `error` field of an Ollama JSON body, if it has one. */
function errorOf(text: string): string | null {
	try {
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
			return String((parsed as { error: unknown }).error);
		}
	} catch {
		// Not JSON: fall through to the raw text.
	}
	return null;
}

function statusError(what: string, status: number, text: string): TransportError {
	const detail = errorOf(text) ?? text.replace(/\s+/g, " ").trim().slice(0, 200);
	return new TransportError(`Ollama ${what} answered ${status}${detail === "" ? "" : `: ${detail}`}`, status);
}

export type OllamaStatus = { running: true; version: string } | { running: false; reason: string };

/** Is Ollama installed and running at `base`? Never throws. */
export async function detectOllama(http: HttpClient, base: string): Promise<OllamaStatus> {
	let response;
	try {
		response = await http({ url: `${base}/api/version`, method: "GET" });
	} catch (error) {
		return { running: false, reason: unreachable(base, error) };
	}
	if (response.status !== 200) {
		return {
			running: false,
			reason: `Something at ${base} answered ${response.status}, but it does not look like Ollama.`,
		};
	}
	let version = "";
	try {
		const parsed: unknown = JSON.parse(response.text);
		if (typeof parsed === "object" && parsed !== null && "version" in parsed) {
			version = String((parsed as { version: unknown }).version);
		}
	} catch {
		// Answered 200 at /api/version: running, version unknown.
	}
	return { running: true, version };
}

/** The models Ollama has locally (`GET /api/tags` → `models[].name`). */
export async function listLocalModels(http: HttpClient, base: string): Promise<string[]> {
	let response;
	try {
		response = await http({ url: `${base}/api/tags`, method: "GET" });
	} catch (error) {
		throw new TransportError(unreachable(base, error));
	}
	if (response.status !== 200) throw statusError("/api/tags", response.status, response.text);
	let parsed: unknown;
	try {
		parsed = JSON.parse(response.text);
	} catch {
		throw new TransportError("Ollama did not answer /api/tags with JSON.");
	}
	const models = typeof parsed === "object" && parsed !== null ? (parsed as { models?: unknown }).models : undefined;
	if (!Array.isArray(models)) throw new TransportError("Ollama's /api/tags answer has no model list.");
	return models
		.map((entry: unknown) =>
			typeof entry === "object" && entry !== null && "name" in entry
				? String((entry as { name: unknown }).name)
				: "",
		)
		.filter((name) => name !== "");
}

/** Ollama names an untagged model `x:latest`; treat the two spellings as one. */
export function hasModel(names: string[], model: string): boolean {
	const canonical = (name: string) => (name.includes(":") ? name : `${name}:latest`);
	const wanted = canonical(model.trim());
	return names.some((name) => canonical(name.trim()) === wanted);
}

export interface LineSplitter {
	/** Feed an arbitrary chunk; each complete, non-empty line is emitted. */
	push(chunk: string): void;
	/** The stream ended: emit what is left, if anything. */
	flush(): void;
}

/** Turn arbitrary text chunks into whole lines, holding a partial line across chunks. */
export function createLineSplitter(onLine: (line: string) => void): LineSplitter {
	let pending = "";
	const emit = (line: string) => {
		const trimmed = line.trim();
		if (trimmed !== "") onLine(trimmed);
	};
	return {
		push(chunk) {
			pending += chunk;
			const lines = pending.split("\n");
			pending = lines.pop() ?? "";
			for (const line of lines) emit(line);
		},
		flush() {
			emit(pending);
			pending = "";
		},
	};
}

export interface PullProgress {
	status: string;
	/** Bytes downloaded so far, summed over every layer seen. */
	completed: number;
	/** Bytes to download, summed over every layer seen; 0 before the first layer. */
	total: number;
}

/**
 * Download `model` into Ollama, reporting one overall byte count: the pull
 * streams progress per layer (`digest`), so the layers are summed. Resolves on
 * `success`; throws a TransportError on an `error` line, a non-200 status, or
 * a stream that ends without `success`. Ollama keeps a cancelled pull's
 * layers and resumes from them on the next attempt.
 */
export async function pullModel(
	stream: NdjsonClient,
	base: string,
	model: string,
	onProgress: (progress: PullProgress) => void,
	signal?: AbortSignal,
): Promise<void> {
	const layers = new Map<string, { completed: number; total: number }>();
	let succeeded = false;
	let failure: string | null = null;
	const onLine = (line: string) => {
		if (succeeded || failure !== null) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			return;
		}
		if (typeof parsed !== "object" || parsed === null) return;
		const event = parsed as { status?: unknown; digest?: unknown; total?: unknown; completed?: unknown; error?: unknown };
		if (event.error !== undefined) {
			failure = String(event.error);
			return;
		}
		const status = typeof event.status === "string" ? event.status : "";
		if (typeof event.digest === "string" && event.digest !== "") {
			const before = layers.get(event.digest) ?? { completed: 0, total: 0 };
			layers.set(event.digest, {
				completed: typeof event.completed === "number" ? event.completed : before.completed,
				total: typeof event.total === "number" ? event.total : before.total,
			});
		}
		let completed = 0;
		let total = 0;
		for (const layer of layers.values()) {
			completed += layer.completed;
			total += layer.total;
		}
		onProgress({ status, completed, total });
		if (status === "success") succeeded = true;
	};

	let response;
	try {
		response = await stream(
			{
				url: `${base}/api/pull`,
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model, stream: true }),
			},
			onLine,
			signal,
		);
	} catch (error) {
		if (signal?.aborted === true) throw new TransportError(`Downloading ${model} was cancelled.`);
		throw new TransportError(unreachable(base, error));
	}
	if (response.status !== 200) throw statusError("/api/pull", response.status, response.text);
	if (failure !== null) throw new TransportError(`Ollama could not download ${model}: ${failure}`);
	if (!succeeded) {
		throw new TransportError(
			`The download of ${model} ended before Ollama reported success — try again; it resumes where it stopped.`,
		);
	}
}

/**
 * The same pull without progress, for when no streaming client is available:
 * `stream: false` makes Ollama answer once, after the whole download.
 */
export async function pullModelBuffered(http: HttpClient, base: string, model: string): Promise<void> {
	let response;
	try {
		response = await http({
			url: `${base}/api/pull`,
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model, stream: false }),
		});
	} catch (error) {
		throw new TransportError(unreachable(base, error));
	}
	if (response.status !== 200) throw statusError("/api/pull", response.status, response.text);
	const failure = errorOf(response.text);
	if (failure !== null) throw new TransportError(`Ollama could not download ${model}: ${failure}`);
}
