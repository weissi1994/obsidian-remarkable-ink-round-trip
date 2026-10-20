/**
 * Reading handwriting as text, through an OpenAI-compatible vision endpoint
 * (ink fork; opt-in, off by default).
 *
 * Upstream deliberately returns handwriting as an image: guessing at it can
 * be worse than showing it. This keeps that default and adds the guess only
 * when the owner asks for it, through an endpoint they choose — a local
 * Ollama or LM Studio keeps the ink on their own machine; any hosted
 * OpenAI-compatible API works too. The image stays next to the transcript
 * unless they turn that off, so a bad reading never replaces the ink.
 *
 * Pure over an injected HttpClient (Obsidian's requestUrl at the edge, which
 * sidesteps CORS on desktop and mobile alike).
 */

import { HttpClient, HttpRequest, HttpResponse, TransportError } from "./http";

export interface OcrConfig {
	/** Base URL up to and including /v1. */
	endpoint: string;
	model: string;
	apiKey?: string;
}

/**
 * A remark in the owner's hand with the text they corrected it to. Sent
 * ahead of the image to read, as earlier turns of the conversation, so the
 * model sees this hand — its letter shapes, its words — before reading it:
 * learning from corrections without training anything.
 */
export interface OcrExample {
	png: ArrayBuffer;
	text: string;
}

export interface OcrRequest {
	png: ArrayBuffer;
	/** Corrected remarks in the same hand, oldest first (worked examples). */
	examples?: OcrExample[];
	/** The line the ink was written against, as a hint for the reader. */
	quote?: string;
	/** A whole page added on the tablet rather than a margin remark. */
	wholePage?: boolean;
}

const NO_TEXT = "NO_TEXT";

export function ocrPrompt(request: OcrRequest): string {
	return [
		request.wholePage
			? "This image is a page of handwritten notes from an e-ink tablet."
			: "This image is a handwritten remark from the margin of a document on an e-ink tablet.",
		"Transcribe the handwriting exactly as written, keeping its language and line breaks.",
		"Do not translate, correct, summarise or add anything.",
		(request.examples?.length ?? 0) > 0
			? "The earlier images are in the same handwriting, each answered with its correct transcription; use them to read this hand."
			: "",
		request.quote === undefined
			? ""
			: `For context only (do not transcribe it), the remark sits next to this printed line: "${request.quote}"`,
		`If the image holds no words — an arrow, a scribble, a drawing — answer exactly ${NO_TEXT}.`,
		"Answer with the transcription only.",
	]
		.filter((line) => line !== "")
		.join("\n");
}

function base64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

/** The chat-completions body for one image. */
export function ocrBody(config: OcrConfig, request: OcrRequest): string {
	return JSON.stringify({
		model: config.model,
		temperature: 0,
		max_tokens: request.wholePage ? 1500 : 300,
		messages: [
			...(request.examples ?? []).flatMap((example) => [
				{
					role: "user",
					content: [
						{ type: "text", text: "Transcribe this handwriting." },
						{ type: "image_url", image_url: { url: `data:image/png;base64,${base64(example.png)}` } },
					],
				},
				{ role: "assistant", content: example.text },
			]),
			{
				role: "user",
				content: [
					{ type: "text", text: ocrPrompt(request) },
					{
						type: "image_url",
						image_url: { url: `data:image/png;base64,${base64(request.png)}` },
					},
				],
			},
		],
	});
}

/** Pull the transcript out of a chat-completions response; null for "no words". */
export function parseOcrResponse(text: string): string | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new TransportError("The OCR endpoint did not answer with JSON.");
	}
	const content = (parsed as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message
		?.content;
	const value =
		typeof content === "string"
			? content
			: Array.isArray(content)
				? content
						.map((part: unknown) =>
							typeof part === "object" && part !== null && "text" in part
								? String(part.text)
								: "",
						)
						.join("")
				: "";
	const cleaned = value
		.replace(/^```[a-z]*\n?|```$/g, "")
		.trim()
		.replace(/^"(.*)"$/s, "$1");
	if (cleaned === "" || cleaned.toUpperCase().includes(NO_TEXT)) return null;
	return cleaned;
}

/** Base URL, trimmed and without a trailing slash; throws if it is not http(s). */
function normaliseEndpoint(raw: string): string {
	const endpoint = raw.trim().replace(/\/+$/, "");
	if (!/^https?:\/\//i.test(endpoint)) {
		throw new TransportError("The OCR endpoint must start with http:// or https://.");
	}
	return endpoint;
}

function authHeaders(config: OcrConfig): Record<string, string> {
	return config.apiKey !== undefined && config.apiKey.trim() !== ""
		? { Authorization: `Bearer ${config.apiKey.trim()}` }
		: {};
}

function hasApiKey(config: OcrConfig): boolean {
	return config.apiKey !== undefined && config.apiKey.trim() !== "";
}

/** The first 200 chars of a response body, whitespace-collapsed, for the raw passthrough. */
function bodySnippet(text: string): string {
	const trimmed = (text ?? "").replace(/\s+/g, " ").trim();
	return trimmed.length > 200 ? trimmed.slice(0, 200) : trimmed;
}

/**
 * Call the endpoint, turning a rejected request (connection refused, DNS,
 * timeout) into an actionable reachability error — `requestUrl({throw:false})`
 * suppresses non-2xx *status* throws but still rejects when it cannot connect,
 * so this is the only place a stopped server is caught.
 */
async function send(http: HttpClient, endpoint: string, request: HttpRequest): Promise<HttpResponse> {
	try {
		return await http(request);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		const refused = /refus|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|timed? ?out|network|socket/i.test(
			detail,
		);
		throw new TransportError(
			refused
				? `Could not reach the OCR endpoint at ${endpoint} — is the server running? (connection refused)`
				: `Could not reach the OCR endpoint at ${endpoint} — is the server running? (${detail})`,
		);
	}
}

/**
 * Map a non-2xx status to a TransportError, or null for a 2xx. The raw status
 * and a body snippet are always appended, so the action stays useful even for
 * a failure signature we did not anticipate; the specific hints layer on top.
 */
function mapStatus(response: HttpResponse, config: OcrConfig, route: string): TransportError | null {
	const { status } = response;
	if (status >= 200 && status < 300) return null;
	const snippet = bodySnippet(response.text);
	const raw = `(HTTP ${status}${snippet === "" ? "" : `: ${snippet}`})`;
	// A local server (no API key) answering 403 is almost always the Ollama
	// origin/CORS allowlist, not a bad key.
	if (status === 403 && !hasApiKey(config)) {
		return new TransportError(
			`The endpoint refused the request's origin (app://obsidian.md). For Ollama, set ` +
				`OLLAMA_ORIGINS=app://obsidian.md (or *) and restart it. See docs/ocr-endpoint-setup.md. ${raw}`,
			status,
		);
	}
	if (status === 401 || status === 403) {
		return new TransportError(`The OCR endpoint refused the API key. ${raw}`, status);
	}
	if (status === 404) {
		return new TransportError(
			`The OCR endpoint has no ${route} route, or the model "${config.model}" is unknown. ${raw}`,
			status,
		);
	}
	return new TransportError(`The OCR endpoint answered ${status}. ${raw}`, status);
}

/** Transcribe one image. Throws a TransportError with an actionable message on failure. */
export async function transcribe(
	http: HttpClient,
	config: OcrConfig,
	request: OcrRequest,
): Promise<string | null> {
	const endpoint = normaliseEndpoint(config.endpoint);
	const response = await send(http, endpoint, {
		url: `${endpoint}/chat/completions`,
		method: "POST",
		headers: { "Content-Type": "application/json", ...authHeaders(config) },
		body: ocrBody(config, request),
	});
	const error = mapStatus(response, config, "/chat/completions");
	if (error !== null) throw error;
	return parseOcrResponse(response.text);
}

/**
 * The models the endpoint serves. `GET {endpoint}/models` is the OpenAI route;
 * Ollama and LM Studio both answer it at `/v1/models`. Parses `data[].id`.
 */
export async function listModels(http: HttpClient, config: OcrConfig): Promise<string[]> {
	const endpoint = normaliseEndpoint(config.endpoint);
	const response = await send(http, endpoint, {
		url: `${endpoint}/models`,
		method: "GET",
		headers: authHeaders(config),
	});
	const error = mapStatus(response, config, "/models");
	if (error !== null) throw error;
	let parsed: unknown;
	try {
		parsed = JSON.parse(response.text);
	} catch {
		throw new TransportError("The OCR endpoint did not answer /models with JSON.");
	}
	const data = (parsed as { data?: unknown }).data;
	if (!Array.isArray(data)) return [];
	return data
		.map((entry) =>
			typeof entry === "object" && entry !== null && "id" in entry
				? String((entry as { id: unknown }).id)
				: "",
		)
		.filter((id) => id !== "");
}

/**
 * A 1×1 PNG, sent through the real transcribe path so Test connection exercises
 * the same request the import does — auth, route, body shape and all.
 */
const PROBE_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function pngFromBase64(b64: string): ArrayBuffer {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes.buffer;
}

const PROBE_PNG = pngFromBase64(PROBE_PNG_BASE64);

export interface OcrConnection {
	models: string[];
	probe: string | null;
}

/**
 * The Test-connection flow: list the served models, assert the configured one
 * is among them, then send a tiny probe image through `transcribe()`. Each step
 * throws a TransportError with an actionable message on failure.
 */
export async function checkConnection(http: HttpClient, config: OcrConfig): Promise<OcrConnection> {
	const models = await listModels(http, config);
	if (!models.includes(config.model)) {
		throw new TransportError(
			`Model "${config.model}" is not served by this endpoint — pull it (ollama pull ${config.model})` +
				(models.length === 0
					? ", or check the endpoint serves it."
					: ` or pick one of: ${models.join(", ")}.`),
		);
	}
	const probe = await transcribe(http, config, { png: PROBE_PNG });
	return { models, probe };
}
