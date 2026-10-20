import { describe, expect, it } from "vitest";
import type { HttpClient, HttpRequest } from "../transport/http";
import { checkConnection, listModels, transcribe } from "../transport/ocr";

/** A tiny fake HttpClient that answers every request with one canned response. */
function fixed(response: { status: number; text?: string }): HttpClient {
	return async () => ({ status: response.status, headers: {}, text: response.text ?? "" });
}

/** A fake that routes by URL, recording what it saw, for the multi-step flows. */
function router(routes: Record<string, { status: number; text?: string }>): {
	http: HttpClient;
	seen: HttpRequest[];
} {
	const seen: HttpRequest[] = [];
	const http: HttpClient = async (request) => {
		seen.push(request);
		const match = Object.entries(routes).find(([suffix]) => request.url.endsWith(suffix));
		if (match === undefined) throw new Error(`no fake route for ${request.url}`);
		return { status: match[1].status, headers: {}, text: match[1].text ?? "" };
	};
	return { http, seen };
}

const png = new ArrayBuffer(1);
const answer = (content: string) => JSON.stringify({ choices: [{ message: { content } }] });
const modelsBody = (...ids: string[]) => JSON.stringify({ data: ids.map((id) => ({ id })) });

describe("ocr error mapping", () => {
	it("403 without an API key points at OLLAMA_ORIGINS, not the key", async () => {
		await expect(
			transcribe(fixed({ status: 403, text: "forbidden origin" }), { endpoint: "http://localhost:11434/v1", model: "m" }, { png }),
		).rejects.toThrow(/OLLAMA_ORIGINS/);
	});

	it("403 with an API key keeps the API-key message", async () => {
		await expect(
			transcribe(fixed({ status: 403 }), { endpoint: "https://api.example/v1", model: "m", apiKey: "sk-x" }, { png }),
		).rejects.toThrow(/API key/);
	});

	it("surfaces the raw status and a body snippet", async () => {
		await expect(
			transcribe(fixed({ status: 500, text: "boom internal" }), { endpoint: "http://localhost:11434/v1", model: "m" }, { png }),
		).rejects.toThrow(/HTTP 500: boom internal/);
	});

	it("a rejecting http (stopped server) becomes a reachability error", async () => {
		const refusing: HttpClient = async () => {
			throw new Error("request to http://localhost:11434 failed, reason: connect ECONNREFUSED");
		};
		await expect(
			transcribe(refusing, { endpoint: "http://localhost:11434/v1", model: "m" }, { png }),
		).rejects.toThrow(/connection refused/);
	});

	it("a rejecting http with an opaque reason still reports it could not reach the endpoint", async () => {
		const opaque: HttpClient = async () => {
			throw new Error("something unexpected");
		};
		await expect(
			transcribe(opaque, { endpoint: "http://localhost:11434/v1", model: "m" }, { png }),
		).rejects.toThrow(/Could not reach the OCR endpoint/);
	});
});

describe("listModels", () => {
	it("parses the data[].id array", async () => {
		const { http, seen } = router({ "/models": { status: 200, text: modelsBody("qwen2.5vl:7b", "llava") } });
		const models = await listModels(http, { endpoint: "http://localhost:11434/v1/", model: "m" });
		expect(models).toEqual(["qwen2.5vl:7b", "llava"]);
		expect(seen[0].url).toBe("http://localhost:11434/v1/models");
		expect(seen[0].method).toBe("GET");
	});

	it("maps /models failures to an actionable error", async () => {
		await expect(
			listModels(fixed({ status: 403 }), { endpoint: "http://localhost:11434/v1", model: "m" }),
		).rejects.toThrow(/OLLAMA_ORIGINS/);
	});
});

describe("checkConnection", () => {
	it("throws when the configured model is not served, listing what is", async () => {
		const { http } = router({ "/models": { status: 200, text: modelsBody("llava", "bakllava") } });
		await expect(
			checkConnection(http, { endpoint: "http://localhost:11434/v1", model: "qwen2.5vl:7b" }),
		).rejects.toThrow(/not served by this endpoint.*ollama pull qwen2\.5vl:7b.*llava, bakllava/s);
	});

	it("lists, probes, and returns the probe result on the success path", async () => {
		const { http, seen } = router({
			"/models": { status: 200, text: modelsBody("qwen2.5vl:7b") },
			"/chat/completions": { status: 200, text: answer("hi") },
		});
		const result = await checkConnection(http, { endpoint: "http://localhost:11434/v1", model: "qwen2.5vl:7b" });
		expect(result).toEqual({ models: ["qwen2.5vl:7b"], probe: "hi" });
		// The probe exercises the real transcribe path: /models then /chat/completions.
		expect(seen.map((r) => r.url)).toEqual([
			"http://localhost:11434/v1/models",
			"http://localhost:11434/v1/chat/completions",
		]);
	});

	it("a NO_TEXT probe still counts as a successful connection (null probe)", async () => {
		const { http } = router({
			"/models": { status: 200, text: modelsBody("qwen2.5vl:7b") },
			"/chat/completions": { status: 200, text: answer("NO_TEXT") },
		});
		const result = await checkConnection(http, { endpoint: "http://localhost:11434/v1", model: "qwen2.5vl:7b" });
		expect(result.probe).toBeNull();
	});
});
