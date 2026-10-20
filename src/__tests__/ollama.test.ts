import { describe, expect, it } from "vitest";
import { TransportError, type HttpClient, type HttpRequest } from "../transport/http";
import {
	createLineSplitter,
	describePull,
	detectOllama,
	hasModel,
	listLocalModels,
	ollamaBase,
	pullModel,
	pullModelBuffered,
	type NdjsonClient,
	type PullProgress,
} from "../transport/ollama";

/** A tiny fake HttpClient that answers every request with one canned response. */
function fixed(response: { status: number; text?: string }, seen: HttpRequest[] = []): HttpClient {
	return async (request) => {
		seen.push(request);
		return { status: response.status, headers: {}, text: response.text ?? "" };
	};
}

/** A fake NdjsonClient that emits a scripted line sequence, then ends with `status`. */
function scripted(
	lines: unknown[],
	status = 200,
	seen: HttpRequest[] = [],
): NdjsonClient {
	return async (request, onLine) => {
		seen.push(request);
		const text: string[] = [];
		for (const line of lines) {
			const raw = typeof line === "string" ? line : JSON.stringify(line);
			text.push(raw);
			if (status === 200) onLine(raw);
		}
		return { status, text: text.join("\n") };
	};
}

const BASE = "http://localhost:11434";

describe("ollamaBase", () => {
	it("strips a trailing /v1", () => {
		expect(ollamaBase("http://localhost:11434/v1")).toBe(BASE);
	});

	it("strips trailing slashes, before and after /v1", () => {
		expect(ollamaBase("http://localhost:11434/")).toBe(BASE);
		expect(ollamaBase("http://localhost:11434/v1/")).toBe(BASE);
	});

	it("leaves a bare server root alone", () => {
		expect(ollamaBase(" http://gpu-box:11434 ")).toBe("http://gpu-box:11434");
	});
});

describe("detectOllama", () => {
	it("a 200 with a version is running", async () => {
		const seen: HttpRequest[] = [];
		const result = await detectOllama(fixed({ status: 200, text: '{"version":"0.6.0"}' }, seen), BASE);
		expect(result).toEqual({ running: true, version: "0.6.0" });
		expect(seen[0]).toMatchObject({ url: `${BASE}/api/version`, method: "GET" });
	});

	it("a refused connection is not running", async () => {
		const refusing: HttpClient = async () => {
			throw new Error("request to http://localhost:11434 failed, reason: connect ECONNREFUSED");
		};
		const result = await detectOllama(refusing, BASE);
		expect(result.running).toBe(false);
		if (!result.running) expect(result.reason).toMatch(/connection refused/);
	});

	it("a 404 is not running (something else answers on that port)", async () => {
		const result = await detectOllama(fixed({ status: 404, text: "not found" }), BASE);
		expect(result.running).toBe(false);
		if (!result.running) expect(result.reason).toMatch(/404/);
	});
});

describe("listLocalModels / hasModel", () => {
	it("lists models[].name from /api/tags", async () => {
		const seen: HttpRequest[] = [];
		const body = JSON.stringify({ models: [{ name: "qwen2.5vl:7b" }, { name: "llama3:latest" }] });
		await expect(listLocalModels(fixed({ status: 200, text: body }, seen), BASE)).resolves.toEqual([
			"qwen2.5vl:7b",
			"llama3:latest",
		]);
		expect(seen[0]).toMatchObject({ url: `${BASE}/api/tags`, method: "GET" });
	});

	it("an empty model list is fine", async () => {
		await expect(listLocalModels(fixed({ status: 200, text: '{"models":[]}' }), BASE)).resolves.toEqual([]);
	});

	it("a malformed body throws a TransportError", async () => {
		await expect(listLocalModels(fixed({ status: 200, text: "<html>" }), BASE)).rejects.toBeInstanceOf(
			TransportError,
		);
		await expect(listLocalModels(fixed({ status: 200, text: '{"tags":[]}' }), BASE)).rejects.toBeInstanceOf(
			TransportError,
		);
	});

	it("a non-200 throws a TransportError", async () => {
		await expect(listLocalModels(fixed({ status: 500, text: "boom" }), BASE)).rejects.toThrow(/500/);
	});

	it("treats x and x:latest as the same model", () => {
		expect(hasModel(["llama3:latest"], "llama3")).toBe(true);
		expect(hasModel(["llama3"], "llama3:latest")).toBe(true);
		expect(hasModel(["qwen2.5vl:7b"], "qwen2.5vl:7b")).toBe(true);
		expect(hasModel(["qwen2.5vl:3b"], "qwen2.5vl:7b")).toBe(false);
		expect(hasModel([], "qwen2.5vl:7b")).toBe(false);
	});
});

describe("createLineSplitter", () => {
	it("holds a JSON line split across three chunks", () => {
		const lines: string[] = [];
		const split = createLineSplitter((line) => lines.push(line));
		split.push('{"status":"pu');
		split.push("lling mani");
		expect(lines).toEqual([]);
		split.push('fest"}\n');
		expect(lines).toEqual(['{"status":"pulling manifest"}']);
	});

	it("emits several lines from one chunk and skips blank ones", () => {
		const lines: string[] = [];
		const split = createLineSplitter((line) => lines.push(line));
		split.push('{"a":1}\n\n{"b":2}\r\n{"c":');
		expect(lines).toEqual(['{"a":1}', '{"b":2}']);
		split.push("3}\n");
		expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
	});

	it("emits a trailing line without a newline on flush()", () => {
		const lines: string[] = [];
		const split = createLineSplitter((line) => lines.push(line));
		split.push('{"status":"success"}');
		expect(lines).toEqual([]);
		split.flush();
		expect(lines).toEqual(['{"status":"success"}']);
		split.flush();
		expect(lines).toEqual(['{"status":"success"}']);
	});
});

describe("pullModel", () => {
	it("POSTs a streaming pull and sums progress across digests", async () => {
		const seen: HttpRequest[] = [];
		const progress: PullProgress[] = [];
		const stream = scripted(
			[
				{ status: "pulling manifest" },
				{ status: "pulling aaa", digest: "sha256:aaa", total: 1000, completed: 100 },
				{ status: "pulling bbb", digest: "sha256:bbb", total: 500, completed: 0 },
				{ status: "pulling aaa", digest: "sha256:aaa", total: 1000, completed: 1000 },
				{ status: "pulling bbb", digest: "sha256:bbb", total: 500, completed: 250 },
				{ status: "verifying sha256 digest" },
				{ status: "success" },
			],
			200,
			seen,
		);
		await pullModel(stream, BASE, "qwen2.5vl:7b", (p) => progress.push(p));
		expect(seen[0]).toMatchObject({ url: `${BASE}/api/pull`, method: "POST" });
		expect(JSON.parse(seen[0].body as string)).toEqual({ model: "qwen2.5vl:7b", stream: true });
		expect(progress[0]).toEqual({ status: "pulling manifest", completed: 0, total: 0 });
		expect(progress[1]).toEqual({ status: "pulling aaa", completed: 100, total: 1000 });
		expect(progress[2]).toEqual({ status: "pulling bbb", completed: 100, total: 1500 });
		expect(progress[3]).toEqual({ status: "pulling aaa", completed: 1000, total: 1500 });
		expect(progress[4]).toEqual({ status: "pulling bbb", completed: 1250, total: 1500 });
		expect(progress[progress.length - 1]).toEqual({ status: "success", completed: 1250, total: 1500 });
	});

	it("resolves on success", async () => {
		await expect(
			pullModel(scripted([{ status: "pulling manifest" }, { status: "success" }]), BASE, "m", () => {}),
		).resolves.toBeUndefined();
	});

	it("rejects with the server's message on an error line", async () => {
		const stream = scripted([
			{ status: "pulling manifest" },
			{ error: "pull model manifest: file does not exist" },
		]);
		const pull = pullModel(stream, BASE, "nope:1b", () => {});
		await expect(pull).rejects.toBeInstanceOf(TransportError);
		await expect(pull).rejects.toThrow(/pull model manifest: file does not exist/);
	});

	it("rejects when the stream ends without success", async () => {
		const stream = scripted([
			{ status: "pulling aaa", digest: "sha256:aaa", total: 1000, completed: 10 },
		]);
		await expect(pullModel(stream, BASE, "m", () => {})).rejects.toThrow(/ended before/);
	});

	it("rejects on a non-200 status, with the body's error", async () => {
		const stream = scripted([{ error: "model name is required" }], 400);
		const pull = pullModel(stream, BASE, "m", () => {});
		await expect(pull).rejects.toBeInstanceOf(TransportError);
		await expect(pull).rejects.toThrow(/400.*model name is required/);
	});

	it("passes the abort signal through to the stream", async () => {
		let got: AbortSignal | undefined;
		const stream: NdjsonClient = async (_request, onLine, signal) => {
			got = signal;
			onLine('{"status":"success"}');
			return { status: 200, text: "" };
		};
		const controller = new AbortController();
		await pullModel(stream, BASE, "m", () => {}, controller.signal);
		expect(got).toBe(controller.signal);
	});

	it("a refused connection is reported as Ollama not reachable", async () => {
		const stream: NdjsonClient = async () => {
			throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
		};
		await expect(pullModel(stream, BASE, "m", () => {})).rejects.toThrow(/connection refused/);
	});
});

describe("pullModelBuffered", () => {
	it("POSTs stream:false and resolves on success", async () => {
		const seen: HttpRequest[] = [];
		await pullModelBuffered(fixed({ status: 200, text: '{"status":"success"}' }, seen), BASE, "m");
		expect(seen[0]).toMatchObject({ url: `${BASE}/api/pull`, method: "POST" });
		expect(JSON.parse(seen[0].body as string)).toEqual({ model: "m", stream: false });
	});

	it("rejects with the server's error", async () => {
		await expect(
			pullModelBuffered(fixed({ status: 200, text: '{"error":"file does not exist"}' }), BASE, "m"),
		).rejects.toThrow(/file does not exist/);
		await expect(pullModelBuffered(fixed({ status: 500, text: "boom" }), BASE, "m")).rejects.toThrow(/500: boom/);
	});
});

describe("describePull", () => {
	it("shows overall gigabytes and a percentage", () => {
		expect(describePull("qwen2.5vl:7b", { status: "pulling a", completed: 1.2e9, total: 5.9e9 })).toBe(
			"Downloading qwen2.5vl:7b — 1.2 / 5.9 GB (20%)",
		);
	});

	it("shows the status text while the total is unknown", () => {
		expect(describePull("m", { status: "pulling manifest", completed: 0, total: 0 })).toBe(
			"Downloading m — pulling manifest",
		);
	});
});
