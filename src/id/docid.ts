/**
 * Stable document IDs (PRD F5, K3).
 *
 * A UUID in the source note's frontmatter (`remarkable-id`) plus the same ID
 * on the device is the only reliable link between a note and its
 * notebook: file names and paths are unstable, the ID is not.
 */

/** Frontmatter key that carries the stable document ID. */
export const DOCID_FRONTMATTER_KEY = "remarkable-id";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidDocId(value: unknown): value is string {
	return typeof value === "string" && UUID_RE.test(value);
}

/** Generate a new document ID (crypto.randomUUID with a small fallback). */
export function generateDocId(): string {
	const cryptoObj = crypto;
	if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
	// Fallback: RFC 4122 v4 via getRandomValues (available in all Obsidian
	// runtimes; the arithmetic path exists for exotic test environments).
	const bytes = new Uint8Array(16);
	if (cryptoObj?.getRandomValues) {
		cryptoObj.getRandomValues(bytes);
	} else {
		for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Return the note's document ID, generating one when absent or invalid.
 * `existing` is the current frontmatter value; the caller persists the
 * returned ID back into the frontmatter (Obsidian edge: processFrontMatter).
 */
export function ensureDocId(existing: unknown): { docId: string; isNew: boolean } {
	if (isValidDocId(existing)) return { docId: existing, isNew: false };
	return { docId: generateDocId(), isNew: true };
}

/**
 * Notes that share a document id with another and must get a fresh one.
 * Obsidian's "Make a copy" copies the frontmatter, id included; two notes on
 * one id would each replace the other's notebook. The note at the mapping's
 * path (`ownerPath`) keeps the id, else the oldest; the rest are returned.
 */
export function duplicateIdLosers(
	notes: { path: string; docId: unknown; ctime: number }[],
	ownerPath: (docId: string) => string | undefined,
): string[] {
	const byId = new Map<string, { path: string; ctime: number }[]>();
	for (const note of notes) {
		if (!isValidDocId(note.docId)) continue;
		const group = byId.get(note.docId) ?? [];
		group.push(note);
		byId.set(note.docId, group);
	}
	const losers: string[] = [];
	for (const [docId, group] of byId) {
		if (group.length < 2) continue;
		const owner = ownerPath(docId);
		const keeper =
			group.find((note) => note.path === owner) ??
			group.reduce((oldest, note) => (note.ctime < oldest.ctime ? note : oldest));
		for (const note of group) if (note !== keeper) losers.push(note.path);
	}
	return losers;
}
