import { describe, expect, it } from "vitest";
import { GenerationError, ResponseError } from "rmapi-js";
import { EMPTY_ROOT_HASH, handleRootQuirks, isGenerationConflict, toTransportError, withGenerationRetry } from "../transport/mirror";
import { TransportError } from "../transport/http";
import { classifyFailure } from "../transport/failure";
import { createFolder, editMetadata, readListing } from "../transport/metadata";
import { fakeCloud } from "./helpers/fakecloud";

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

describe("the account root, as the servers answer", () => {
	const NO_WAIT = { attempts: 3, backoffMs: () => 0, sleep: () => Promise.resolve() };
	// What rmapi-js' validator throws for rmfakecloud's {generation: 0, schemaVersion: 3} on a fresh account.
	const zodError = (...fields: string[]) =>
		Object.assign(new Error(JSON.stringify(fields.map((field) => ({ path: [field], message: "Required" })))), {
			name: "ZodError",
			issues: fields.map((field) => ({ path: [field], message: "Required" })),
		});

	it("reads an account with no root yet as empty at generation 0, and makes the root on the first write", async () => {
		const cloud = fakeCloud();
		let fresh = true;
		const api = handleRootQuirks({
			...cloud.api,
			getRootHash: () => (fresh ? Promise.reject(zodError("hash")) : cloud.api.getRootHash()),
			putRootHash: async (hash: string, generation: number) => {
				if (!fresh) return cloud.api.putRootHash(hash, generation);
				if (generation !== 0) throw new Error("precondition failed");
				fresh = false;
				return cloud.api.putRootHash(hash, 1);
			},
		});
		expect(await api.getRootHash()).toEqual([EMPTY_ROOT_HASH, 0, 3]);
		expect(await readListing(api, {})).toEqual([]);
		await createFolder(api, "Obsidian", "", { retry: NO_WAIT });
		expect((await readListing(api, {})).map((item) => item.visibleName)).toEqual(["Obsidian"]);
	});

	it("turns any other unreadable root answer into a readable error", async () => {
		const api = handleRootQuirks({ ...fakeCloud().api, getRootHash: () => Promise.reject(zodError("generation")) });
		const error = (await api.getRootHash().catch((e: unknown) => e)) as Error;
		expect(error.message).toMatch(/cannot read \(generation\)/);
		expect(error.message).not.toContain("Required");
	});

	it("retries a root write refused with a bare HTTP 500, as rmfakecloud refuses a stale generation", async () => {
		const cloud = fakeCloud();
		const folder = await createFolder(cloud.api, "Obsidian", "", { retry: NO_WAIT });
		let refusals = 1;
		cloud.onRootWrite(() => (refusals-- > 0 ? new ResponseError(500, "Internal Server Error", "failed reMarkable request: ") : undefined));
		const api = handleRootQuirks({ ...cloud.api });
		await editMetadata(api, folder.id, folder.hash, { visibleName: "Vault" }, { retry: NO_WAIT });
		expect((await readListing(api, {})).map((item) => item.visibleName)).toEqual(["Vault"]);

		refusals = 1;
		const current = (await readListing(cloud.api, {}))[0];
		await expect(editMetadata(cloud.api, folder.id, current.hash, { visibleName: "Raw" }, { retry: NO_WAIT })).rejects.toBeInstanceOf(ResponseError);
	});

	it("classifies rmapi-js' ResponseError by its status, whatever its message", () => {
		const bare = (status: number) => new ResponseError(status, "", "failed reMarkable request: ");
		expect(classifyFailure(bare(500))).toBe("server");
		expect(classifyFailure(bare(503))).toBe("server");
		expect(classifyFailure(bare(401))).toBe("auth");
		expect(classifyFailure(bare(429))).toBe("rate-limit");
		expect(isGenerationConflict(bare(500))).toBe(false);
	});
});
