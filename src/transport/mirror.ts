/**
 * Cloud-write helpers on top of rmapi-js (GP_E2_S7, F4-rest): retrying a
 * write the account refused because its tree changed meanwhile, and turning
 * rmapi-js failures into actionable errors. The folder mirroring itself
 * lives in transport/metadata.ts. The GenerationError class import below is
 * deliberate: recognising the library's own error type by identity is the
 * reliable signal (GP_E5_S1) and is worth the direct coupling.
 */

import { GenerationError } from "rmapi-js";

import { TransportError } from "./http";
import { adviseFailure, classifyFailure, statusOf } from "./failure";
import type { RawSyncApi } from "./notebook";

/** The root an account without one yet (a fresh account) reads as: nothing on it. */
export const EMPTY_ROOT_HASH = "0".repeat(64);

/** Statuses a refused root write comes back with: 412 from reMarkable, 409 or a bare 500 from rmfakecloud. */
const REFUSED_ROOT_WRITE = [409, 412, 500];

/**
 * A root write the server refused with a bare status rather than rmapi-js'
 * "precondition failed": taken as a generation conflict, so the write is
 * tried again on a freshly read root — safe, as every retry re-reads the
 * root and checks what it expects there again.
 */
export class RootWriteRefusedError extends GenerationError {
	constructor(readonly status: number) {
		super();
		this.message = `the reMarkable cloud refused the root write (HTTP ${status}); root generation was stale?`;
	}
}

/**
 * Teach rmapi-js' raw API (in place, so its high-level calls get it too) two
 * things the servers do: an account with no root yet answers without a hash
 * — read as an empty account at generation 0, whose first write makes the
 * root, as a tablet's would; and a refused root write may come back as a
 * bare 409/412/500 (RootWriteRefusedError). Any other unexpected root answer
 * becomes a readable error instead of the validator's.
 */
export function handleRootQuirks<T extends Pick<RawSyncApi, "getRootHash" | "getEntries" | "putRootHash">>(api: T): T {
	const getRootHash = api.getRootHash.bind(api);
	const getEntries = api.getEntries.bind(api);
	const putRootHash = api.putRootHash.bind(api);
	const patch: Pick<RawSyncApi, "getRootHash" | "getEntries" | "putRootHash"> = {
		getRootHash: async () => {
			try {
				return await getRootHash();
			} catch (error) {
				if (!(error instanceof Error) || error.name !== "ZodError") throw error;
				const fields = ((error as Error & { issues?: { path?: unknown[] }[] }).issues ?? []).map((issue) => (issue.path ?? []).join("."));
				if (fields.length > 0 && fields.every((field) => field === "hash")) return [EMPTY_ROOT_HASH, 0, 3];
				throw new Error(
					`The reMarkable cloud answered with an account root this plugin cannot read (${fields.join(", ") || "unexpected form"}). ` +
						"Is the address of a self-hosted cloud right?",
				);
			}
		},
		getEntries: (id, hash) => (hash === EMPTY_ROOT_HASH ? Promise.resolve({ entries: [] }) : getEntries(id, hash)),
		putRootHash: async (hash, generation) => {
			try {
				return await putRootHash(hash, generation);
			} catch (error) {
				const status = statusOf(error);
				if (status !== undefined && REFUSED_ROOT_WRITE.includes(status)) throw new RootWriteRefusedError(status);
				throw error;
			}
		},
	};
	return Object.assign(api, patch);
}

/**
 * Writing to the cloud means updating the account's shared root listing. If
 * anything else touched it in the meantime — the tablet syncing your fresh
 * annotations, a second client, another send — the server rejects the write
 * ("precondition failed" / "failed to upload root schema") and rmapi-js
 * raises a generation error. The library documents this as *expected*: you
 * refresh your view of the tree and try again (GP_E3_S4).
 */
export function isGenerationConflict(error: unknown): boolean {
	// The class check is the reliable signal. `error.name` is NOT: rmapi-js
	// never assigns `this.name`, so at runtime its GenerationError carries
	// name === "Error" (GP_E5_S1 — the name check below only catches wrappers
	// that set it deliberately).
	if (error instanceof GenerationError) return true;
	const name = error instanceof Error ? error.name : "";
	const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
	return (
		name === "GenerationError" ||
		// The strings cover the same condition reaching us as a plain server
		// message or re-wrapped error; "generation was stale" is the message
		// of rmapi-js' GenerationError itself.
		message.includes("generation was stale") ||
		message.includes("precondition failed") ||
		message.includes("root schema") ||
		message.includes("generation mismatch") ||
		message.includes("generation conflict")
	);
}

export interface RetryOptions {
	attempts?: number;
	backoffMs?: (attempt: number) => number;
	sleep?: (ms: number) => Promise<void>;
}

/**
 * Run a cloud write, retrying on a generation conflict with a refreshed
 * view of the tree. `run(refresh)` is called with refresh=true from the
 * second attempt onwards.
 */
export async function withGenerationRetry<T>(
	run: (refresh: boolean) => Promise<T>,
	options: RetryOptions = {},
): Promise<T> {
	const attempts = options.attempts ?? 4;
	const backoffMs = options.backoffMs ?? ((attempt: number) => 300 * 2 ** (attempt - 1));
	const sleep =
		options.sleep ?? ((ms: number) => new Promise<void>((r) => window.setTimeout(r, ms)));

	let lastError: unknown;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			return await run(attempt > 1);
		} catch (error) {
			lastError = error;
			if (attempt === attempts || !isGenerationConflict(error)) throw error;
			// Field diagnosability (GP_E5_S1): a console trail shows whether the
			// retry machinery engaged at all when a user reports a failure.
			console.warn(
				`reMarkable Round-Trip: cloud tree changed underneath us (generation conflict); retrying ${attempt + 1}/${attempts}`,
			);
			await sleep(backoffMs(attempt));
		}
	}
	throw lastError;
}

/** Map rmapi-js failures onto our actionable error type (N3). */
export function toTransportError(error: unknown): TransportError {
	if (error instanceof TransportError) return error;
	const message = error instanceof Error ? error.message : String(error);
	if (isGenerationConflict(error)) {
		return new TransportError(
			"The reMarkable cloud was busy syncing (your tablet or another app was " +
				"writing at the same time), so the upload was refused. Nothing was lost — " +
				"wait until the tablet finishes syncing and send again.",
		);
	}
	// A network or credential failure is not a mirroring problem, and telling
	// someone to switch mirroring off would not help them (GP_E3_S10).
	const kind = classifyFailure(error);
	if (kind !== "unknown") {
		return new TransportError(`${message}. ${adviseFailure(kind)}`);
	}
	return new TransportError(
		`Folder mirroring failed (${message}). ` +
			"You can disable 'Mirror vault folders' in the settings to fall back to root uploads.",
	);
}
