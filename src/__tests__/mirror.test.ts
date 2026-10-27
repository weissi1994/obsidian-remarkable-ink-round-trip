import { describe, expect, it } from "vitest";
import { GenerationError } from "rmapi-js";
import { isGenerationConflict, toTransportError, withGenerationRetry } from "../transport/mirror";
import { TransportError } from "../transport/http";

describe("generation conflicts", () => {
	const NO_WAIT = { backoffMs: () => 0, sleep: () => Promise.resolve() };

	it("recognises the conflict in its various guises", () => {
		const named = new Error("boem");
		named.name = "GenerationError";
		expect(isGenerationConflict(named)).toBe(true);
		expect(isGenerationConflict(new Error("precondition failed"))).toBe(true);
		expect(
			isGenerationConflict(new Error("Failed to upload root schema")),
		).toBe(true);
		expect(isGenerationConflict(new Error("gewoon kapot"))).toBe(false);
	});

	it("recognises rmapi-js' real GenerationError (GP_E5_S1)", () => {
		// The real class does not (currently) assign `this.name`, so at runtime
		// it can carry name === "Error" — the guise the field failure arrived
		// in. Guard the instanceof path and the message fallback for re-wrapped
		// errors; deliberately no assertion on `.name` itself, so an upstream
		// fix that starts setting it does not break this test.
		expect(isGenerationConflict(new GenerationError())).toBe(true);
		expect(
			isGenerationConflict(
				new Error("root generation was stale; try put again"),
			),
		).toBe(true);
	});

	it("retries the real GenerationError and reports it as busy-sync", async () => {
		let calls = 0;
		const result = await withGenerationRetry(() => {
			calls++;
			return calls < 2
				? Promise.reject(new GenerationError())
				: Promise.resolve("ok");
		}, NO_WAIT);
		expect(result).toBe("ok");
		expect(calls).toBe(2);
		const reported = toTransportError(new GenerationError());
		expect(reported.message).toContain("busy syncing");
		expect(reported.message).not.toContain("Folder mirroring failed");
	});

	it("retries with a refreshed view and succeeds", async () => {
		const seen: boolean[] = [];
		let calls = 0;
		const result = await withGenerationRetry((refresh) => {
			seen.push(refresh);
			calls++;
			return calls < 3
				? Promise.reject(new Error("Failed to upload root schema"))
				: Promise.resolve("ok");
		}, NO_WAIT);
		expect(result).toBe("ok");
		// First attempt without refresh, retries with.
		expect(seen).toEqual([false, true, true]);
	});

	it("does not retry unrelated failures", async () => {
		let calls = 0;
		await expect(
			withGenerationRetry(() => {
				calls++;
				return Promise.reject(new Error("gewoon kapot"));
			}, NO_WAIT),
		).rejects.toThrow(/gewoon kapot/);
		expect(calls).toBe(1);
	});

	it("explains a persistent conflict in plain language", () => {
		const message = toTransportError(
			new Error("Failed to upload root schema"),
		).message;
		expect(message).toContain("busy syncing");
		expect(message).toContain("Nothing was lost");
	});
});

describe("toTransportError", () => {
	it("wraps foreign errors with the fallback advice and keeps TransportErrors", () => {
		const wrapped = toTransportError(new Error("iets heel anders ging stuk"));
		expect(wrapped).toBeInstanceOf(TransportError);
		expect(wrapped.message).toContain("Mirror vault folders");
		const original = new TransportError("al netjes");
		expect(toTransportError(original)).toBe(original);
	});
});
