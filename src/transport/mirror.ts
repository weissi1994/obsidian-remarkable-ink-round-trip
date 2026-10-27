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
import { adviseFailure, classifyFailure } from "./failure";

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
