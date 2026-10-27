import { describe, expect, it } from "vitest";
import { MappingTable } from "../id/mapping";
import { Highlight } from "../incoming/highlights";
import {
	DocumentFile,
	PullDeps,
	mergePullMappings,
	pullAnnotations,
} from "../incoming/pull";

const TABLE: MappingTable = {
	"doc-a": {
		docId: "doc-a",
		notePath: "map/Nota.md",
		deviceDocId: "device-a",
		uploadedAt: "2026-07-25T10:00:00Z",
		contentHash: "aaaa",
		format: "ink",
	},
};

const page = (text: string) =>
	JSON.stringify({ highlights: [[{ text, color: 3 }]] });

const CONTENT = JSON.stringify({
	cPages: { pages: [{ id: "p1" }, { id: "p2" }] },
});

function makeDeps(overrides: Partial<PullDeps> = {}) {
	const written: { notePath: string; highlights: Highlight[] }[] = [];
	const files: DocumentFile[] = [
		{ id: "device-a.content", hash: "h-content" },
		{ id: "device-a.highlights/p2.json", hash: "h-p2" },
		{ id: "device-a.highlights/p1.json", hash: "h-p1" },
		{ id: "device-a/p1.rm", hash: "h-rm" },
	];
	const deps: PullDeps = {
		listDocumentHashes: () =>
			Promise.resolve(new Map([["device-a", "hash-1"]])),
		listDocumentFiles: () => Promise.resolve(files),
		readFile: (file) =>
			Promise.resolve(
				file.id.endsWith(".content")
					? CONTENT
					: file.id.endsWith("p1.json")
						? page("van pagina 1")
						: page("van pagina 2"),
			),
		writeAnnotations: (entry, highlights) => {
			written.push({ notePath: entry.notePath, highlights });
			return Promise.resolve();
		},
		...overrides,
	};
	return { deps, written };
}

describe("pullAnnotations", () => {
	it("imports a changed document and records the device hash", async () => {
		const { deps, written } = makeDeps();
		const { results, table } = await pullAnnotations(TABLE, deps);

		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({ ok: true });
		expect(written[0].notePath).toBe("map/Nota.md");
		expect(table["doc-a"].accountedHash).toBe("hash-1");
	});

	it("keeps the hash when the note is not in the vault, so the ink is read once it is back", async () => {
		const { deps } = makeDeps({
			writeAnnotations: () => Promise.resolve({ form: "summary", reason: "no-source" }),
		});
		const seen: MappingTable = { "doc-a": { ...TABLE["doc-a"], accountedHash: "hash-0" } };
		const { results, table } = await pullAnnotations(seen, deps);
		expect(results[0].ok).toBe(false);
		expect(results[0].ok ? "" : results[0].error).toContain("not in the vault");
		expect(table["doc-a"].accountedHash).toBe("hash-0");
		// Once the note is back, the same notebook is read and recorded.
		const { deps: back, written } = makeDeps();
		const again = await pullAnnotations(table, back);
		expect(written).toHaveLength(1);
		expect(again.table["doc-a"].accountedHash).toBe("hash-1");
	});

	it("offers the coordinator a safe yield before each document", async () => {
		let yields = 0;
		const { deps } = makeDeps({
			yieldToPush: async () => {
				yields++;
			},
		});

		await pullAnnotations(TABLE, deps);
		expect(yields).toBe(1);
	});

	it("skips a mapping superseded by a push while the pull yielded", async () => {
		const { deps, written } = makeDeps({ isCurrent: () => false });
		const { results } = await pullAnnotations(TABLE, deps);

		expect(results[0]).toMatchObject({
			ok: true,
			skipped: true,
			skipReason: "superseded",
		});
		expect(written).toHaveLength(0);
	});

	it("skips a document sent as PDF by an earlier version", async () => {
		const { deps, written } = makeDeps();
		const table: MappingTable = {
			"doc-a": { ...TABLE["doc-a"], format: "pdf" },
		};
		const { results, table: after } = await pullAnnotations(table, deps);
		expect(results[0]).toMatchObject({
			ok: true,
			skipped: true,
			skipReason: "legacy",
		});
		expect(written).toHaveLength(0);
		expect(after["doc-a"].accountedHash).toBeUndefined();
	});

	it("skips a document whose device hash is unchanged", async () => {
		const { deps, written } = makeDeps();
		const seen: MappingTable = {
			"doc-a": { ...TABLE["doc-a"], accountedHash: "hash-1" },
		};
		const { results } = await pullAnnotations(seen, deps);
		expect(results[0]).toMatchObject({ ok: true, skipped: true });
		expect(written).toHaveLength(0);
	});

	it("re-imports an unchanged document when forced", async () => {
		const { deps, written } = makeDeps({ force: true });
		const seen: MappingTable = {
			"doc-a": { ...TABLE["doc-a"], accountedHash: "hash-1" },
		};
		await pullAnnotations(seen, deps);
		expect(written).toHaveLength(1);
	});

	it("keeps every mapping when the account listing is empty — pairing switch, not 300 deletions", async () => {
		const { deps, written } = makeDeps({
			listDocumentHashes: () => Promise.resolve(new Map()),
		});
		const { results, table } = await pullAnnotations(TABLE, deps);
		expect(results[0]).toMatchObject({
			ok: true,
			skipped: true,
			skipReason: "not-on-device",
		});
		expect(table["doc-a"]).toBeDefined();
		expect(written).toHaveLength(0);
	});

	it("keeps the mapping of a document gone from the account: the lifecycle archives its note", async () => {
		const table: MappingTable = {
			...TABLE,
			"doc-b": {
				...TABLE["doc-a"],
				docId: "doc-b",
				deviceDocId: "device-b",
				notePath: "b.md",
			},
		};
		const { deps, written } = makeDeps({
			// device-a is gone; device-b still lives, so the listing is real.
			listDocumentHashes: () =>
				Promise.resolve(new Map([["device-b", "hash-2"]])),
			listDocumentFiles: () =>
				Promise.resolve([{ id: "device-b.highlights/p1.json", hash: "h" }]),
		});
		const { results, table: updated } = await pullAnnotations(table, deps);
		expect(results[0]).toMatchObject({ ok: true, skipped: true, skipReason: "not-on-device" });
		expect(updated["doc-a"]).toEqual(table["doc-a"]);
		expect(written.map((entry) => entry.notePath)).toEqual(["b.md"]);
	});

	it("reports a per-document failure without aborting the run", async () => {
		const table: MappingTable = {
			...TABLE,
			"doc-b": {
				...TABLE["doc-a"],
				docId: "doc-b",
				deviceDocId: "device-b",
				notePath: "b.md",
			},
		};
		const { deps } = makeDeps({
			listDocumentHashes: () =>
				Promise.resolve(
					new Map([
						["device-a", "hash-1"],
						["device-b", "hash-2"],
					]),
				),
			listDocumentFiles: (deviceDocId) =>
				deviceDocId === "device-b"
					? Promise.reject(new Error("cloud weigert"))
					: Promise.resolve([{ id: "device-a.highlights/p1.json", hash: "h" }]),
		});
		const { results, table: updated } = await pullAnnotations(table, deps);
		expect(results.map((r) => r.ok)).toEqual([true, false]);
		expect(updated["doc-a"].accountedHash).toBe("hash-1");
		expect(updated["doc-b"].accountedHash).toBeUndefined();
	});

	it("imports both documents of a mixed tree when one has foreign content JSON (GP_E5_S13)", async () => {
		// A document written by another tool can carry a `.content` this
		// plugin cannot parse. The listing reads ids and hashes only, and the
		// page map is tolerant, so neither document costs the other its import.
		const table: MappingTable = {
			...TABLE,
			"doc-b": {
				...TABLE["doc-a"],
				docId: "doc-b",
				deviceDocId: "device-b",
				notePath: "b.md",
			},
		};
		const { deps, written } = makeDeps({
			listDocumentHashes: () =>
				Promise.resolve(
					new Map([
						["device-a", "hash-1"],
						["device-b", "hash-2"],
					]),
				),
			listDocumentFiles: (deviceDocId) =>
				Promise.resolve(
					deviceDocId === "device-b"
						? [
								{ id: "device-b.content", hash: "h-foreign" },
								{ id: "device-b.highlights/p1.json", hash: "h-b1" },
							]
						: [
								{ id: "device-a.content", hash: "h-content" },
								{ id: "device-a.highlights/p1.json", hash: "h-p1" },
							],
				),
			readFile: (file) =>
				Promise.resolve(
					file.id === "device-b.content"
						? "{\"not\": \"what we expect\", \"cPages\": 7"
						: file.id.endsWith(".content")
							? CONTENT
							: page(file.id.startsWith("device-b") ? "vreemd" : "van pagina 1"),
				),
		});
		const { results, table: updated } = await pullAnnotations(table, deps);
		expect(results.map((r) => r.ok)).toEqual([true, true]);
		expect(written).toHaveLength(2);
		expect(updated["doc-b"].accountedHash).toBe("hash-2");
	});

	it("records how the source note relates to what was sent (F14)", async () => {
		const { deps } = makeDeps({
			checkSource: () => Promise.resolve("changed" as const),
		});
		const { results } = await pullAnnotations(TABLE, deps);
		expect(results[0]).toMatchObject({
			ok: true,
			scan: { sourceState: "changed" },
		});
	});

	it("still imports when the source check itself fails — it is a diagnosis, not a gate", async () => {
		const table: MappingTable = {
			...TABLE,
			"doc-b": {
				...TABLE["doc-a"],
				docId: "doc-b",
				deviceDocId: "device-b",
				notePath: "b.md",
			},
		};
		const { deps, written } = makeDeps({
			listDocumentHashes: () =>
				Promise.resolve(
					new Map([
						["device-a", "hash-1"],
						["device-b", "hash-2"],
					]),
				),
			checkSource: (entry) =>
				entry.docId === "doc-b"
					? Promise.reject(new Error("vault weigert"))
					: Promise.resolve("match" as const),
		});
		const { results } = await pullAnnotations(table, deps);
		expect(results.map((r) => r.ok)).toEqual([true, true]);
		expect(results[1]).toMatchObject({ scan: { sourceState: undefined } });
		expect(written).toHaveLength(2);
	});

	it("reports every mapping as failed when the device is unreachable", async () => {
		const { deps } = makeDeps({
			listDocumentHashes: () => Promise.reject(new Error("geen verbinding")),
		});
		const { results, table } = await pullAnnotations(TABLE, deps);
		expect(results[0]).toMatchObject({ ok: false, error: "geen verbinding" });
		expect(table).toEqual(TABLE);
	});
});

describe("mergePullMappings", () => {
	it("does not overwrite a mapping replaced by a yielded push", () => {
		const current: MappingTable = {
			"doc-a": {
				...TABLE["doc-a"],
				deviceDocId: "device-new",
				contentHash: "new",
			},
		};
		const pulled: MappingTable = {
			"doc-a": { ...TABLE["doc-a"], accountedHash: "old-device-hash" },
		};

		expect(mergePullMappings(current, TABLE, pulled)).toEqual(current);
	});

	it("merges only pull state when the device mapping is still current", () => {
		const current: MappingTable = {
			"doc-a": { ...TABLE["doc-a"], notePath: "moved/Nota.md" },
		};
		const pulled: MappingTable = {
			"doc-a": { ...TABLE["doc-a"], accountedHash: "device-hash" },
		};

		expect(mergePullMappings(current, TABLE, pulled)["doc-a"]).toMatchObject({
			notePath: "moved/Nota.md",
			accountedHash: "device-hash",
		});
	});

	it("keeps the hash of an update in place that landed while the pull ran: same notebook, newer hash", () => {
		const scope: MappingTable = { "doc-a": { ...TABLE["doc-a"], accountedHash: "read-at-start" } };
		// The send updated the notebook in place (same id) and recorded its new hash.
		const current: MappingTable = { "doc-a": { ...scope["doc-a"], accountedHash: "after-send", contentHash: "new" } };
		// The pull had read the notebook as it was before the send.
		const pulled: MappingTable = { "doc-a": { ...scope["doc-a"], accountedHash: "before-send" } };
		expect(mergePullMappings(current, scope, pulled)["doc-a"].accountedHash).toBe("after-send");
	});
});
