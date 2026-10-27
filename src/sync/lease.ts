/**
 * Which copy of the vault syncs on its own (several devices).
 *
 * Two copies of one vault (git, Syncthing, Obsidian Sync) that both sync
 * automatically race each other: both may send the same new note. The copy
 * that syncs writes a lease into the shared state folder — who it is and
 * until when — and renews it while it keeps syncing; the others leave the
 * automatic syncs to it until the lease runs out. A manual sync is the
 * owner's call: it goes ahead after a confirmation.
 *
 * The lease travels with the vault, so it can arrive late: it is a
 * best-effort guard against two copies sending at once. The hard guard stays
 * the per-install stamps on sends in flight (SyncState.settlePending).
 */

export interface SyncLease {
	/** The holding copy's install id (settings.installId). */
	installId: string;
	/** A name for the owner to recognise it by. */
	device: string;
	/** Epoch ms after which the lease is free for any copy to take. */
	expiresAt: number;
}

/**
 * Where this copy stands: nobody holds the lease, it is ours, it ran out,
 * or another copy holds it (fresh).
 */
export type LeaseStanding = "free" | "ours" | "expired" | "foreign";

export function leaseStanding(lease: SyncLease | null, installId: string, now: number): LeaseStanding {
	if (lease === null) return "free";
	if (lease.installId === installId) return "ours";
	return lease.expiresAt <= now ? "expired" : "foreign";
}

/**
 * Whether a sync may run: an automatic one (startup, interval, a watched
 * note) only while the lease is not another copy's; a manual one always,
 * after the owner confirmed when another copy holds it.
 */
export function leaseDecision(standing: LeaseStanding, trigger: "auto" | "manual"): "run" | "skip" | "confirm" {
	if (standing !== "foreign") return "run";
	return trigger === "auto" ? "skip" : "confirm";
}

/** Shortest lease: long enough that a copy syncing every few minutes keeps it between runs. */
const MIN_LEASE_MS = 15 * 60_000;

/** How long a lease lasts: three sync intervals, at least a quarter of an hour. */
export function leaseDuration(intervalMinutes: number): number {
	return Math.max(MIN_LEASE_MS, intervalMinutes > 0 ? 3 * intervalMinutes * 60_000 : 0);
}

/**
 * The lease this copy writes after a run, or null when it writes none: a
 * copy that does not sync on its own (`autoSync` off) never takes it — a
 * manual run there would keep the copy that does from syncing — and one
 * that is ours with more than half its time left is not renewed: renewing
 * on every run would make every sync a change for the vault's own sync to
 * carry.
 */
export function renewedLease(
	lease: SyncLease | null,
	self: { installId: string; device: string; autoSync: boolean },
	now: number,
	durationMs: number,
): SyncLease | null {
	if (!self.autoSync) return null;
	if (lease !== null && lease.installId === self.installId && lease.device === self.device && lease.expiresAt - now > durationMs / 2) {
		return null;
	}
	return { installId: self.installId, device: self.device, expiresAt: now + durationMs };
}

/** Reads a lease file's content; anything else (a merge conflict, a hand edit) reads as no lease. */
export function parseLease(text: string): SyncLease | null {
	try {
		const value = JSON.parse(text) as Partial<SyncLease> | null;
		if (
			value === null ||
			typeof value.installId !== "string" ||
			typeof value.device !== "string" ||
			typeof value.expiresAt !== "number" ||
			!Number.isFinite(value.expiresAt)
		) {
			return null;
		}
		return { installId: value.installId, device: value.device, expiresAt: value.expiresAt };
	} catch {
		return null;
	}
}
