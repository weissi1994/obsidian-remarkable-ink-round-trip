import { describe, expect, it } from "vitest";
import type { HttpClient, HttpRequest } from "../transport/http";
import { LMSTUDIO_LOCAL, detectLmStudio, pickVisionModel, type LmStudioModel } from "../transport/lmstudio";

type Canned = { status: number; text?: string } | Error;

/** A fake HttpClient answering per URL path; unknown paths get a 404. */
function routes(table: Record<string, Canned>, seen: HttpRequest[] = []): HttpClient {
	return async (request) => {
		seen.push(request);
		const path = request.url.slice(LMSTUDIO_LOCAL.length);
		const canned = table[path] ?? { status: 404, text: "Not Found" };
		if (canned instanceof Error) throw canned;
		return { status: canned.status, headers: {}, text: canned.text ?? "" };
	};
}

const json = (value: unknown) => ({ status: 200, text: JSON.stringify(value) });

describe("detectLmStudio", () => {
	it("reads the v1 REST API: llm only, vision and loaded flags from capabilities and instances", async () => {
		const http = routes({
			"/api/v1/models": json({
				models: [
					{
						type: "llm",
						key: "qwen2.5-vl-7b-instruct",
						display_name: "Qwen2.5 VL 7B",
						capabilities: { vision: true, trained_for_tool_use: true },
						loaded_instances: [{ id: "qwen2.5-vl-7b-instruct" }],
					},
					{
						type: "llm",
						key: "gemma-3-4b",
						capabilities: { vision: true },
						loaded_instances: [],
					},
					{ type: "llm", key: "llama-3.2-3b", capabilities: { vision: false }, loaded_instances: [] },
					{ type: "embedding", key: "nomic-embed-text", loaded_instances: [] },
				],
			}),
		});
		expect(await detectLmStudio(http, LMSTUDIO_LOCAL)).toEqual({
			running: true,
			needsApiKey: false,
			models: [
				{ id: "qwen2.5-vl-7b-instruct", vision: true, loaded: true },
				{ id: "gemma-3-4b", vision: true, loaded: false },
				{ id: "llama-3.2-3b", vision: false, loaded: false },
			],
		});
	});

	it("treats a missing capabilities object as not vision", async () => {
		const http = routes({
			"/api/v1/models": json({ models: [{ type: "llm", key: "phi-4", loaded_instances: [] }] }),
		});
		expect(await detectLmStudio(http, LMSTUDIO_LOCAL)).toEqual({
			running: true,
			needsApiKey: false,
			models: [{ id: "phi-4", vision: false, loaded: false }],
		});
	});

	it("falls back to the v0 REST API on a 404: vlm is vision, embeddings dropped", async () => {
		const seen: HttpRequest[] = [];
		const http = routes(
			{
				"/api/v0/models": json({
					data: [
						{ id: "qwen2.5-vl-7b-instruct", type: "vlm", state: "loaded" },
						{ id: "llama-3.2-3b", type: "llm", state: "not-loaded" },
						{ id: "nomic-embed-text", type: "embeddings", state: "not-loaded" },
					],
				}),
			},
			seen,
		);
		expect(await detectLmStudio(http, LMSTUDIO_LOCAL)).toEqual({
			running: true,
			needsApiKey: false,
			models: [
				{ id: "qwen2.5-vl-7b-instruct", vision: true, loaded: true },
				{ id: "llama-3.2-3b", vision: false, loaded: false },
			],
		});
		expect(seen.map((request) => request.url)).toEqual([
			`${LMSTUDIO_LOCAL}/api/v1/models`,
			`${LMSTUDIO_LOCAL}/api/v0/models`,
		]);
	});

	it("falls back to the OpenAI-compatible list when both REST APIs 404: vision and loaded unknown", async () => {
		const http = routes({
			"/v1/models": json({ object: "list", data: [{ id: "qwen2.5-vl-7b-instruct" }, { id: "llama-3.2-3b" }] }),
		});
		expect(await detectLmStudio(http, LMSTUDIO_LOCAL)).toEqual({
			running: true,
			needsApiKey: false,
			models: [
				{ id: "qwen2.5-vl-7b-instruct", vision: null, loaded: null },
				{ id: "llama-3.2-3b", vision: null, loaded: null },
			],
		});
	});

	it("falls through an unparseable body as well as a 404", async () => {
		const http = routes({
			"/api/v1/models": { status: 200, text: "<html>not json</html>" },
			"/api/v0/models": json({ unexpected: true }),
			"/v1/models": json({ data: [{ id: "some-model" }] }),
		});
		expect(await detectLmStudio(http, LMSTUDIO_LOCAL)).toEqual({
			running: true,
			needsApiKey: false,
			models: [{ id: "some-model", vision: null, loaded: null }],
		});
	});

	it("a refused connection is not running, worded like Ollama's", async () => {
		const http = routes({ "/api/v1/models": new Error("net::ERR_CONNECTION_REFUSED") });
		expect(await detectLmStudio(http, LMSTUDIO_LOCAL)).toEqual({
			running: false,
			reason: `LM Studio is not answering at ${LMSTUDIO_LOCAL} (connection refused).`,
		});
	});

	it("a 401 is running but needs an API key", async () => {
		const http = routes({
			"/api/v1/models": { status: 401, text: '{"error":"Unauthorized"}' },
			"/api/v0/models": { status: 401 },
			"/v1/models": { status: 401 },
		});
		expect(await detectLmStudio(http, LMSTUDIO_LOCAL)).toEqual({
			running: true,
			models: [],
			needsApiKey: true,
		});
	});

	it("a 401 on a later fallback still means a key is needed", async () => {
		const http = routes({ "/v1/models": { status: 401 } });
		expect(await detectLmStudio(http, LMSTUDIO_LOCAL)).toEqual({
			running: true,
			models: [],
			needsApiKey: true,
		});
	});

	it("something answering 404 everywhere is not LM Studio", async () => {
		const result = await detectLmStudio(routes({}), LMSTUDIO_LOCAL);
		expect(result.running).toBe(false);
	});
});

describe("pickVisionModel", () => {
	const model = (id: string, vision: boolean | null, loaded: boolean | null): LmStudioModel => ({ id, vision, loaded });

	it("prefers a loaded vision model", () => {
		const models = [model("a", true, false), model("b", false, true), model("c", true, true)];
		expect(pickVisionModel(models)?.id).toBe("c");
	});

	it("then any vision model", () => {
		const models = [model("a", false, true), model("b", true, false), model("c", true, false)];
		expect(pickVisionModel(models)?.id).toBe("b");
	});

	it("is null when only text models exist", () => {
		expect(pickVisionModel([model("a", false, true), model("b", false, false)])).toBeNull();
		expect(pickVisionModel([])).toBeNull();
	});

	it("never picks an unknown-vision model on its own", () => {
		expect(pickVisionModel([model("a", null, null)])).toBeNull();
	});
});
