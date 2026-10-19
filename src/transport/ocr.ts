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

import { HttpClient, TransportError } from "./http";

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

/** Transcribe one image. Throws a TransportError with an actionable message on failure. */
export async function transcribe(
	http: HttpClient,
	config: OcrConfig,
	request: OcrRequest,
): Promise<string | null> {
	const endpoint = config.endpoint.trim().replace(/\/+$/, "");
	if (!/^https?:\/\//i.test(endpoint)) {
		throw new TransportError("The OCR endpoint must start with http:// or https://.");
	}
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (config.apiKey !== undefined && config.apiKey.trim() !== "") {
		headers.Authorization = `Bearer ${config.apiKey.trim()}`;
	}
	const response = await http({
		url: `${endpoint}/chat/completions`,
		method: "POST",
		headers,
		body: ocrBody(config, request),
	});
	if (response.status === 401 || response.status === 403) {
		throw new TransportError("The OCR endpoint refused the API key.", response.status);
	}
	if (response.status === 404) {
		throw new TransportError(
			`The OCR endpoint has no /chat/completions route, or the model "${config.model}" is unknown.`,
			404,
		);
	}
	if (response.status < 200 || response.status >= 300) {
		throw new TransportError(`The OCR endpoint answered ${response.status}.`, response.status);
	}
	return parseOcrResponse(response.text);
}
