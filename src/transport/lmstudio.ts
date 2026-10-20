/**
 * Finding a local LM Studio server (ink fork; part of #28).
 *
 * When Ollama is not running, "Set up local reading for me" looks for LM
 * Studio's server too, and offers a vision model it already has. Detect and
 * guide only: nothing here downloads or loads a model.
 *
 * LM Studio lists its models three ways, newest first; each is tried in turn,
 * falling through on a 404 or a body that is not the expected shape:
 * `GET /api/v1/models` (0.4+: `models[]` with `type`, `key`,
 * `capabilities.vision`, `loaded_instances`), `GET /api/v0/models` (0.3.6+:
 * `data[]` with `type` llm/vlm/embeddings and `state`), and the
 * OpenAI-compatible `GET /v1/models` (`data[].id`, nothing about vision). With
 * *Require API token* on, the server answers 401 instead.
 *
 * Pure over an injected HttpClient, like `ollama.ts`.
 */

import { HttpClient } from "./http";

/** LM Studio's default server address on this computer. */
export const LMSTUDIO_LOCAL = "http://localhost:1234";

export interface LmStudioModel {
	/** The model key, which `/v1/chat/completions` accepts as `model`. */
	id: string;
	/** Can it read images? null when the server does not say. */
	vision: boolean | null;
	/** Is it loaded right now? null when the server does not say. */
	loaded: boolean | null;
}

export type LmStudioStatus =
	| { running: true; models: LmStudioModel[]; needsApiKey: boolean }
	| { running: false; reason: string };

/** The same connection-failure signatures as `ollama.ts`. */
const REFUSED = /refus|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|timed? ?out|network|socket/i;

function unreachable(base: string, error: unknown): string {
	const detail = error instanceof Error ? error.message : String(error);
	return REFUSED.test(detail)
		? `LM Studio is not answering at ${base} (connection refused).`
		: `LM Studio is not answering at ${base} (${detail}).`;
}

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/** The array under `field` of a JSON body, or null when it has none. */
function listIn(text: string, field: string): unknown[] | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	const list = record(parsed)?.[field];
	return Array.isArray(list) ? list : null;
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** `/api/v1/models`: llm entries only. */
function fromV1(entries: unknown[]): LmStudioModel[] {
	return entries.flatMap((entry) => {
		const model = record(entry);
		const id = text(model?.key);
		if (model === null || model.type !== "llm" || id === "") return [];
		const instances = model.loaded_instances;
		return [
			{
				id,
				vision: record(model.capabilities)?.vision === true,
				loaded: Array.isArray(instances) && instances.length > 0,
			},
		];
	});
}

/** `/api/v0/models`: llm and vlm, embeddings dropped. */
function fromV0(entries: unknown[]): LmStudioModel[] {
	return entries.flatMap((entry) => {
		const model = record(entry);
		const id = text(model?.id);
		if (model === null || (model.type !== "llm" && model.type !== "vlm") || id === "") return [];
		return [{ id, vision: model.type === "vlm", loaded: model.state === "loaded" }];
	});
}

/** `/v1/models`: ids only. */
function fromOpenAi(entries: unknown[]): LmStudioModel[] {
	return entries.flatMap((entry) => {
		const id = text(record(entry)?.id);
		return id === "" ? [] : [{ id, vision: null, loaded: null }];
	});
}

const LISTS: { path: string; field: string; read: (entries: unknown[]) => LmStudioModel[] }[] = [
	{ path: "/api/v1/models", field: "models", read: fromV1 },
	{ path: "/api/v0/models", field: "data", read: fromV0 },
	{ path: "/v1/models", field: "data", read: fromOpenAi },
];

/** Is LM Studio's server running at `base`, and which models does it have? Never throws. */
export async function detectLmStudio(http: HttpClient, base: string): Promise<LmStudioStatus> {
	let lastStatus: number | null = null;
	for (const [index, list] of LISTS.entries()) {
		let response;
		try {
			response = await http({ url: `${base}${list.path}`, method: "GET" });
		} catch (error) {
			// Refused on the first call: nothing is listening. Later on, something
			// answered already, so try the next list.
			if (index === 0) return { running: false, reason: unreachable(base, error) };
			continue;
		}
		if (response.status === 401) return { running: true, models: [], needsApiKey: true };
		lastStatus = response.status;
		if (response.status !== 200) continue;
		const entries = listIn(response.text, list.field);
		if (entries !== null) return { running: true, models: list.read(entries), needsApiKey: false };
	}
	return {
		running: false,
		reason:
			lastStatus === null
				? `LM Studio is not answering at ${base}.`
				: `Something at ${base} answered ${lastStatus}, but it does not look like LM Studio.`,
	};
}

/** A loaded vision model, else any vision model, else null — never a text-only one. */
export function pickVisionModel(models: LmStudioModel[]): LmStudioModel | null {
	return (
		models.find((model) => model.vision === true && model.loaded === true) ??
		models.find((model) => model.vision === true) ??
		null
	);
}
