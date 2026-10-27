import { describe, expect, it } from "vitest";
import type { MappingEntry } from "../id/mapping";
import type { DeviceItem } from "../sync/deviceimport";
import { FailureStreak, NOTICE_AFTER, RunQueue, runFailure } from "../sync/failures";
import { leaseDecision, leaseDuration, leaseStanding, parseLease, renewedLease } from "../sync/lease";
import { foreignListing, plan, VANISH_SETTLE_MS, type ReconcilePolicy } from "../sync/reconcile";
import { classifyNotes, heldAfterRun } from "../sync/statussummary";
import { PENDING_STALE_MS, SyncState } from "../sync/syncstate";
import { frontmatterTags, mergeTags } from "../sync/tags";
import { createFolder, editTags, readTags } from "../transport/metadata";
import { NotebookChangedError } from "../transport/notebook";
import { fakeCloud } from "./helpers/fakecloud";
import { memoryFs } from "./helpers/memoryfs";
import { withDocId, withField } from "./helpers/memoryvault";
import { NO_RETRY, syncRig, type SyncRig } from "./helpers/syncrig";

const note = (title: string) => `# ${title}\n\nSome text.\n`;
const ME = { installId: "me", device: "Laptop" };

async function synced(name = "Plan") {
	const rig = syncRig();
	rig.vault.create("Readme.md", "Not synced.\n");
	rig.vault.create(`Notes/${name}.md`, note(name));
	await rig.engine.sync();
	const record = rig.recordOf(`Notes/${name}.md`);
	if (record === undefined) throw new Error(`not sent: ${rig.log.join("\n")}`);
	return { rig, docId: record.docId, id: record.deviceDocId };
}

async function expectQuiet(rig: SyncRig): Promise<void> {
	const before = [rig.cloud.rootWrites(), rig.vault.writes(), rig.fs.writes()];
	await rig.engine.sync();
	expect([rig.cloud.rootWrites(), rig.vault.writes(), rig.fs.writes()]).toEqual(before);
}

const tabletTags = async (rig: SyncRig, id: string) => readTags(rig.cloud.api, id, rig.cloud.hashOf(id) ?? "");

describe("the sync lease", () => {
	const now = 1_000_000;
	it("is free, ours, expired or another copy's", () => {
		expect(leaseStanding(null, "me", now)).toBe("free");
		expect(leaseStanding({ installId: "me", device: "Laptop", expiresAt: now - 1 }, "me", now)).toBe("ours");
		expect(leaseStanding({ installId: "other", device: "Desktop", expiresAt: now }, "me", now)).toBe("expired");
		expect(leaseStanding({ installId: "other", device: "Desktop", expiresAt: now + 1 }, "me", now)).toBe("foreign");
	});

	it("lets automatic syncs run only while no other copy holds it; a manual one asks first", () => {
		for (const standing of ["free", "ours", "expired"] as const) {
			expect(leaseDecision(standing, "auto")).toBe("run");
			expect(leaseDecision(standing, "manual")).toBe("run");
		}
		expect(leaseDecision("foreign", "auto")).toBe("skip");
		expect(leaseDecision("foreign", "manual")).toBe("confirm");
	});

	it("is taken when free or another copy's, renewed only past half its time", () => {
		const duration = leaseDuration(5);
		const self = { ...ME, autoSync: true };
		expect(duration).toBe(15 * 60_000);
		expect(leaseDuration(20)).toBe(60 * 60_000);
		expect(renewedLease(null, self, now, duration)).toEqual({ ...ME, expiresAt: now + duration });
		expect(renewedLease({ installId: "other", device: "Desktop", expiresAt: now + duration }, self, now, duration)?.installId).toBe("me");
		expect(renewedLease({ ...ME, expiresAt: now + duration * 0.6 }, self, now, duration)).toBeNull();
		expect(renewedLease({ ...ME, expiresAt: now + duration * 0.4 }, self, now, duration)).toEqual({ ...ME, expiresAt: now + duration });
	});

	it("is never taken by a copy that does not sync on its own, even on a manual run", () => {
		const duration = leaseDuration(5);
		const self = { ...ME, autoSync: false };
		expect(renewedLease(null, self, now, duration)).toBeNull();
		expect(renewedLease({ installId: "other", device: "Desktop", expiresAt: now - 1 }, self, now, duration)).toBeNull();
		expect(renewedLease({ installId: "other", device: "Desktop", expiresAt: now + duration }, self, now, duration)).toBeNull();
	});

	it("reads a damaged or conflicted lease file as no lease", async () => {
		expect(parseLease("<<<<<<< HEAD")).toBeNull();
		expect(parseLease(JSON.stringify({ installId: "x", device: "y" }))).toBeNull();
		const { fs } = memoryFs();
		const state = new SyncState(fs, "state", "me");
		expect(await state.readLease()).toBeNull();
		await state.writeLease({ ...ME, expiresAt: 5 });
		expect(await new SyncState(fs, "state", "other").readLease()).toEqual({ ...ME, expiresAt: 5 });
		await fs.write("state/lease.json", "{ broken");
		expect(await state.readLease()).toBeNull();
	});
});

describe("cleaning up the shared state folder", () => {
	const DAY = 24 * 60 * 60 * 1000;
	async function setUp() {
		const { fs, files } = memoryFs();
		let clock = 0;
		const state = new SyncState(fs, "state", "me", () => clock);
		const id = "0f8fad5b-d9cb-469f-a165-70867728950e";
		await state.commitSent(id, { title: "A", markdown: "", images: { "a.png": { w: 1 } as never } }, { docId: id, notePath: "A.md", deviceDocId: "d", uploadedAt: "", contentHash: "" });
		await fs.write("state/pictures/unused.json", "{}");
		await fs.write("state/ink/gone.png.json", "{}");
		await fs.write("state/ink/kept.png.json", "{}");
		await fs.write("state/hands/old.json", "{}");
		await fs.write("state/hands/now.json", "{}");
		await fs.write("state/handwriting.json", JSON.stringify({ handVersion: "now" }));
		return { fs, files, state, id, tick: (ms: number) => (clock += ms) };
	}
	const inkInUse = new Set(["kept.png"]);

	it("moves only unreferenced files, and only after the grace period, into its trash", async () => {
		const { files, state, tick } = await setUp();
		expect(await state.collectGarbage({ inkInUse })).toEqual({ moved: [], waiting: 3 });
		tick(6 * DAY);
		expect((await state.collectGarbage({ inkInUse })).moved).toEqual([]);
		tick(2 * DAY);
		const result = await state.collectGarbage({ inkInUse });
		expect(result.moved.sort()).toEqual(["hands/old.json", "ink/gone.png.json", "pictures/unused.json"]);
		expect(files.has("state/trash/pictures/unused.json")).toBe(true);
		const kept = [...files.keys()].filter((path) => /^state\/(pictures|hands|ink)\//.test(path)).sort();
		expect(kept).toHaveLength(3);
		expect(kept[0]).toBe("state/hands/now.json");
		expect(kept[1]).toBe("state/ink/kept.png.json");
		expect(kept[2]).toMatch(/^state\/pictures\/[0-9a-f]+\.json$/);
		expect(files.has("state/gc.json")).toBe(false);
	});

	it("never moves a picture a send in flight refers to, and starts the grace again for one used again", async () => {
		const { fs, files, state, id, tick } = await setUp();
		await state.collectGarbage({ inkInUse });
		await state.writePending(id, { title: "A", markdown: "", images: { "b.png": { w: 2 } as never } }, { docId: id, notePath: "A.md", deviceDocId: "d", uploadedAt: "", contentHash: "" });
		const pending = [...files.keys()].filter((path) => path.startsWith("state/pictures/") && path !== "state/pictures/unused.json");
		expect(pending).toHaveLength(2);
		await fs.write("state/ink/gone.png.json", "{}");
		tick(30 * DAY);
		const result = await state.collectGarbage({ inkInUse: new Set(["kept.png", "gone.png"]) });
		expect(result.moved).not.toContain("ink/gone.png.json");
		for (const path of pending) expect(files.has(path)).toBe(true);
	});

	it("collects nothing while a note's file cannot be read", async () => {
		const { fs, state, tick } = await setUp();
		await fs.write("state/notes/0f8fad5b-d9cb-469f-a165-70867728950f.json", "<<<<<<< conflict");
		tick(30 * DAY);
		expect(await state.collectGarbage({ inkInUse })).toMatchObject({ moved: [], skipped: "state/notes/0f8fad5b-d9cb-469f-a165-70867728950f.json" });
	});
});

describe("a note opted out", () => {
	it("stays out of the sync folder's sync after Stop syncing, until Sync with reMarkable on it", async () => {
		const { rig, docId, id } = await synced();
		expect(await rig.engine.unlink(docId, "Notes/Plan.md", false)).toBe("kept");
		expect(rig.vault.read("Notes/Plan.md")).toMatch(/^remarkable: false$/m);
		rig.vault.modify("Notes/Plan.md", (text) => `${text}More.\n`);
		await rig.engine.sync();
		await rig.engine.sync();
		expect(rig.recordOf("Notes/Plan.md")).toBeUndefined();
		expect((await rig.tablet.listing()).filter((item) => item.type === "DocumentType").map((item) => item.id)).toEqual([id]);
		await rig.engine.send(["Notes/Plan.md"], { auto: true });
		expect(rig.recordOf("Notes/Plan.md")).toBeUndefined();

		await rig.engine.send(["Notes/Plan.md"], { optIn: true });
		expect(rig.vault.read("Notes/Plan.md")).not.toMatch(/^remarkable:/m);
		expect(rig.recordOf("Notes/Plan.md")).toBeDefined();
		await expectQuiet(rig);
	});
});

describe("tags", () => {
	it("merges as sets against the tags last agreed on", () => {
		expect(mergeTags(undefined, ["a"], ["b"])).toEqual(["a", "b"]);
		expect(mergeTags([], ["a", "x"], ["x", "b"])).toEqual(["a", "x", "b"]);
		expect(mergeTags(["a", "b"], ["b"], ["a", "b"])).toEqual(["b"]);
		expect(mergeTags(["a", "b"], ["a", "c"], ["b", "d"])).toEqual(["c", "d"]);
		expect(mergeTags(["a"], ["a"], ["a"])).toEqual(["a"]);
		expect(frontmatterTags(["#work", "idea", "work"])).toEqual(["work", "idea"]);
		expect(frontmatterTags("work, #idea todo")).toEqual(["work", "idea", "todo"]);
	});

	it("go from the note to its notebook, in the same sync as its first send", async () => {
		const rig = syncRig();
		rig.vault.create("Readme.md", "Not synced.\n");
		rig.vault.create("Notes/Plan.md", withField(note("Plan"), "tags", "[work, idea]"));
		await rig.engine.sync();
		const record = rig.recordOf("Notes/Plan.md");
		expect(await tabletTags(rig, record?.deviceDocId ?? "")).toEqual(["work", "idea"]);
		expect(rig.recordOf("Notes/Plan.md")).toMatchObject({ tags: ["work", "idea"], accountedHash: rig.cloud.hashOf(record?.deviceDocId ?? "") });
		await expectQuiet(rig);
	});

	it("come back from the tablet, and both sides' changes are kept", async () => {
		const { rig, id } = await synced();
		rig.vault.modify("Notes/Plan.md", (text) => withField(text, "tags", "[work, old]"));
		await rig.engine.sync();
		await rig.tablet.tags(id, ["old", "work", "tablet"]);
		rig.vault.modify("Notes/Plan.md", (text) => withField(text, "tags", "[work, vault]"));
		await rig.engine.sync();
		expect(await tabletTags(rig, id)).toEqual(["work", "vault", "tablet"]);
		const tags = (await rig.vault.port.notes()).find((one) => one.path === "Notes/Plan.md")?.tags;
		expect(tags).toEqual(["work", "vault", "tablet"]);
		await expectQuiet(rig);
	});

	it("are written to the tablet only while the notebook is as read", async () => {
		const { rig, id } = await synced();
		const hash = rig.cloud.hashOf(id) ?? "";
		rig.tablet.write(id);
		await expect(editTags(rig.cloud.api, id, hash, ["x"], { retry: NO_RETRY })).rejects.toBeInstanceOf(NotebookChangedError);
		expect(await tabletTags(rig, id)).toEqual([]);
	});

	it("written alongside unread ink leave that ink to be read", async () => {
		const { rig, id, docId } = await synced();
		rig.tablet.write(id);
		rig.vault.modify("Notes/Plan.md", (text) => withField(text, "tags", "[work]"));
		await rig.engine.sync();
		expect(rig.vault.read("Notes/Plan.md")).toMatch(/^ink tablet-/m);
		expect(await tabletTags(rig, id)).toEqual(["work"]);
		expect(rig.table[docId].accountedHash).toBe(rig.cloud.hashOf(id));
	});
});

describe("another copy of the vault", () => {
	it("holds back a note whose send another copy has in flight", async () => {
		const { rig, docId } = await synced();
		const other = new SyncState(rig.fs.fs, "state", "install-b");
		await other.writePending(docId, { title: "Plan", markdown: "" }, { ...rig.table[docId], accountedHash: "elsewhere" }, rig.table[docId].accountedHash);
		rig.vault.modify("Notes/Plan.md", (text) => `${text}Changed.\n`);
		const writes = rig.cloud.rootWrites();
		await rig.engine.sync();
		expect(rig.cloud.rootWrites()).toBe(writes);
		expect(rig.engine.held.get("Notes/Plan.md")).toMatch(/another copy/);
	});

	it("holds back a note it has no record of while a notebook of its name nobody knows is on the account", async () => {
		const { rig, docId } = await synced();
		await rig.ports.records.set({});
		await rig.engine.sync();
		expect((await rig.tablet.listing()).filter((item) => item.type === "DocumentType")).toHaveLength(1);
		expect(rig.engine.held.get("Notes/Plan.md")).toMatch(/sync state has not arrived/);
		expect(docId).toBeDefined();
	});

	it("sends such a note once the notebook of its name is older than a send in flight can be", async () => {
		// As after Stop syncing with the notebook kept and a first send cut short, or a fresh sync state on the account.
		const { rig, id } = await synced();
		await rig.ports.records.set({});
		rig.later(PENDING_STALE_MS);
		await rig.engine.sync();
		expect(rig.engine.held.size).toBe(0);
		const record = rig.recordOf("Notes/Plan.md");
		expect(record?.deviceDocId).not.toBe(id);
		expect((await rig.tablet.describe(id))?.parent).not.toBe("trash");
	});

	it("sends such a note at once when the owner asks for it by hand", async () => {
		const { rig, id } = await synced();
		await rig.ports.records.set({});
		await rig.engine.send(["Notes/Plan.md"], { optIn: true });
		expect(rig.engine.held.size).toBe(0);
		expect(rig.recordOf("Notes/Plan.md")?.deviceDocId).not.toBe(id);
	});

	it("sends a note it has no record of when the notebook of its name nobody knows lies outside the folder its note mirrors", async () => {
		const rig = syncRig();
		rig.vault.create("Readme.md", "Not synced.\n");
		// The owner's own, started on the tablet elsewhere; the note got its id from a run cut short before its send.
		await rig.tablet.create("Plan", await rig.tablet.folderAt("Elsewhere"));
		rig.vault.create("Notes/Plan.md", withDocId(note("Plan"), "0f8fad5b-d9cb-469f-a165-70867728950e"));
		await rig.engine.sync();
		expect(rig.engine.held.size).toBe(0);
		expect(rig.recordOf("Notes/Plan.md")).toMatchObject({ devicePath: "Obsidian/Notes" });
	});

	it("does not take the notebook another copy replaced by a send for trashed on the tablet, nor send the note meanwhile", async () => {
		const created = new Set<string>();
		const a = syncRig({ created, installId: "install-a", inPlace: false });
		const b = syncRig({ created, cloud: a.cloud, vault: a.vault, installId: "install-b", inPlace: false });
		a.vault.create("Readme.md", "Not synced.\n");
		a.vault.create("Notes/Plan.md", note("Plan"));
		await a.engine.sync();
		const first = a.recordOf("Notes/Plan.md")?.deviceDocId;
		for (const [path, text] of a.fs.files) b.fs.files.set(path, text);
		a.vault.modify("Notes/Plan.md", (text) => `${text}More.\n`);
		await b.engine.sync();
		const second = b.recordOf("Notes/Plan.md")?.deviceDocId;
		expect(second).toBeDefined();
		expect(second).not.toBe(first);
		// A's state of the note is from before B's send: its notebook is the one B moved to the trash.
		const writes = [a.cloud.rootWrites(), a.vault.writes()];
		await a.engine.sync();
		expect([a.cloud.rootWrites(), a.vault.writes()]).toEqual(writes);
		expect(a.vault.files.has("Notes/Plan.md")).toBe(true);
		expect(a.engine.held.get("Notes/Plan.md")).toMatch(/replaced on the reMarkable by a send from another copy/);
		for (const [path, text] of b.fs.files) a.fs.files.set(path, text);
		await a.engine.sync();
		expect(a.recordOf("Notes/Plan.md")).toMatchObject({ deviceDocId: second, notePath: "Notes/Plan.md" });
		expect(a.recordOf("Notes/Plan.md")?.state).toBeUndefined();
		await expectQuiet(a);
	});
});

describe("the status of each note", () => {
	const record = (docId: string, patch: Partial<MappingEntry> = {}): MappingEntry => ({ docId, notePath: "", deviceDocId: `nb-${docId}`, uploadedAt: "", contentHash: "", format: "ink", ...patch });
	it("sorts notes by what they need, worst first", () => {
		const statuses = classifyNotes({
			notes: [
				{ path: "a.md", docId: "a", inSyncFolder: true, text: "x" },
				{ path: "b.md", docId: "b", inSyncFolder: true, text: "> [!warning]\n> ^ink-conflict-0123456789ab\n" },
				{ path: "c.md", docId: "c", inSyncFolder: false, text: "> ^ink-pending\n" },
				{ path: "d.md", inSyncFolder: true },
				{ path: "e.md", docId: "e", inSyncFolder: true, text: "x" },
				{ path: "f.md", docId: "f", inSyncFolder: false, text: "x" },
				{ path: "g.md", inSyncFolder: true, optOut: true },
				{ path: "h.md", inSyncFolder: false },
				{ path: "i.md", docId: "i", inSyncFolder: true, text: "```\n^ink-pending\n```\n" },
			],
			mappings: { a: record("a"), b: record("b"), c: record("c"), e: record("e"), f: record("f", { state: "archived" }), i: record("i") },
			errors: new Map([["e.md", "offline"]]),
			waiting: new Map([["d.md", undefined]]),
		});
		expect(statuses).toEqual([
			{ path: "a.md", state: "in-sync" },
			{ path: "b.md", state: "clash" },
			{ path: "c.md", state: "tablet-pending" },
			{ path: "d.md", state: "waiting" },
			{ path: "e.md", state: "error", detail: "offline" },
			{ path: "f.md", state: "archived" },
			{ path: "g.md", state: "opted-out" },
			{ path: "i.md", state: "in-sync" },
		]);
	});
});

describe("background sync failures", () => {
	const offline = runFailure("could not list the reMarkable account", new Error("net::ERR_INTERNET_DISCONNECTED"));
	const limited = runFailure("sending failed", new Error("429 Too Many Requests"));

	it("tell the owner after three in a row, once per streak, until a sync succeeds", () => {
		const streak = new FailureStreak();
		const notices = Array.from({ length: 5 }, () => streak.ended([offline], true));
		expect(notices).toEqual([false, false, true, false, false]);
		expect(NOTICE_AFTER).toBe(3);
		expect(streak.failing).toBe(true);
		expect(streak.ended([], true)).toBe(false);
		expect(streak.failing).toBe(false);
		expect(streak.consecutive).toBe(0);
	});

	it("do not count a rate limit, nor end a streak with one", () => {
		const streak = new FailureStreak();
		streak.ended([offline], true);
		streak.ended([offline], true);
		expect(streak.ended([limited], true)).toBe(false);
		expect(streak.consecutive).toBe(2);
		expect(streak.ended([offline], true)).toBe(true);
	});

	it("leave counting to background syncs, though a manual failure shows until a success", () => {
		const streak = new FailureStreak();
		expect(streak.ended([offline], false)).toBe(false);
		expect(streak.consecutive).toBe(0);
		expect(streak.failing).toBe(true);
	});
});

describe("reconciler regressions", () => {
	const POLICY: ReconcilePolicy = { baseFolder: "Obsidian", archiveFolder: "Archive" };
	const folder = (id: string, name: string, parent = ""): DeviceItem => ({ id, hash: `h-${id}`, type: "CollectionType", parent, visibleName: name, lastModified: "0" });
	const TREE = [folder("base", "Obsidian"), folder("notes", "Notes", "base")];
	const doc = (id: string, parent = "notes"): DeviceItem => ({ id, hash: "h1", type: "DocumentType", parent, visibleName: id, lastModified: "0" });
	const rec = (id: string, patch: Partial<MappingEntry> = {}): MappingEntry => ({
		docId: id,
		notePath: `Notes/${id}.md`,
		deviceDocId: id,
		uploadedAt: "",
		contentHash: "",
		format: "ink",
		accountedHash: "h1",
		deviceName: id,
		deviceParent: "notes",
		devicePath: "Obsidian/Notes",
		...patch,
	});

	it("takes another account's listing for nothing deleted", () => {
		const records = { a: rec("a"), b: rec("b") };
		const other = [folder("x", "Theirs"), doc("theirs", "x")];
		expect(foreignListing(records, other)).toBe(true);
		expect(plan(records, [{ path: "Notes/a.md", docId: "a" }, { path: "Notes/b.md", docId: "b" }], other, POLICY)).toEqual([]);
		// Notebooks erased on the tablet leave their folder: that is this account.
		expect(foreignListing(records, TREE)).toBe(false);
	});

	it("trashes the notebook of a note missing without a delete seen only when it is still missing next time", () => {
		const records = { a: rec("a"), b: rec("b") };
		const vault = [{ path: "Notes/b.md", docId: "b" }];
		const first = plan(records, vault, [...TREE, doc("a"), doc("b")], POLICY);
		expect(first).toEqual([{ kind: "record", docId: "a", patch: { noteMissing: true } }]);
		const second = plan({ ...records, a: rec("a", { noteMissing: true }) }, vault, [...TREE, doc("a"), doc("b")], POLICY);
		expect(second).toMatchObject([{ kind: "trash-notebook", docId: "a" }]);
		expect(plan(records, vault, [...TREE, doc("a"), doc("b")], POLICY, (docId) => docId === "a")).toMatchObject([{ kind: "trash-notebook" }]);
	});

	it("takes nothing as deleted when most synced notes vanished at once", () => {
		const records = { a: rec("a"), b: rec("b"), c: rec("c"), d: rec("d") };
		expect(plan(records, [{ path: "Notes/d.md", docId: "d" }], [...TREE, doc("a"), doc("b"), doc("c"), doc("d")], POLICY)).toEqual([]);
	});

	it("follows a folder renamed on the tablet", () => {
		const renamed = [folder("base", "Obsidian"), { ...folder("notes", "Projects", "base") }, doc("a")];
		expect(plan({ a: rec("a") }, [{ path: "Notes/a.md", docId: "a" }], renamed, POLICY)).toMatchObject([
			{ kind: "move-note", from: "Notes/a.md", to: "Projects/a.md", patch: { devicePath: "Obsidian/Projects" } },
		]);
	});
});

describe("engine regressions", () => {
	it("does not move the note after a failed notebook edit: the vault's rename survives the next sync", async () => {
		const { rig, id } = await synced();
		await rig.tablet.move(id, await rig.tablet.folderAt("Obsidian/Notes/Sub"));
		rig.vault.rename("Notes/Plan.md", "Notes/Roadmap.md");
		let refuse = true;
		rig.cloud.onRootWrite(() => {
			if (!refuse) return undefined;
			refuse = false;
			return new Error("busy");
		});
		await rig.engine.sync();
		expect(rig.vault.files.has("Notes/Roadmap.md")).toBe(true);
		rig.cloud.onRootWrite(null);
		await rig.engine.sync();
		expect(rig.vault.files.has("Notes/Sub/Roadmap.md")).toBe(true);
		expect(await rig.tablet.describe(id)).toMatchObject({ name: "Roadmap" });
	});

	it("reads a notebook brought in from the tablet before archiving its note when it is trashed with new ink", async () => {
		const rig = syncRig();
		rig.vault.create("Readme.md", "Not synced.\n");
		const parent = await rig.tablet.folderAt("Obsidian/Notes");
		const original = await rig.tablet.create("Ideas", parent);
		const hash = rig.cloud.hashOf(original) ?? "";
		const docId = "0f8fad5b-d9cb-469f-a165-70867728950e";
		rig.vault.create("Notes/Ideas.md", withField("Written on the reMarkable\n", "remarkable-id", docId));
		await rig.ports.records.set({
			[docId]: { docId, notePath: "Notes/Ideas.md", deviceDocId: original, uploadedAt: "", contentHash: "", format: "device", accountedHash: hash, deviceName: "Ideas", deviceParent: parent },
		});
		rig.tablet.write(original);
		await rig.tablet.trash(original);
		await rig.engine.sync();
		const archived = [...rig.vault.files.entries()].find(([path]) => path.startsWith("reMarkable/Archive/"));
		expect(archived?.[1].content).toMatch(/^ink tablet-/m);
	});

	it("keeps a note's old path while its notebook is not listed, and brings the rename and move along once it is found again", async () => {
		const { rig, docId, id } = await synced();
		rig.vault.rename("Notes/Plan.md", "Notes/Sub/Roadmap.md");
		const other = fakeCloud();
		await createFolder(other.api, "Someone else's", "", { retry: NO_RETRY });
		rig.useAccount(other);
		await rig.engine.sync();
		rig.useAccount(null);
		expect(rig.table[docId].notePath).toBe("Notes/Plan.md");
		await rig.engine.sync();
		expect(rig.table[docId]).toMatchObject({ notePath: "Notes/Sub/Roadmap.md", devicePath: "Obsidian/Notes/Sub" });
		expect(await rig.tablet.describe(id)).toMatchObject({ name: "Roadmap" });
		await expectQuiet(rig);
	});
});

describe("synced notes deleted while Obsidian was closed", () => {
	async function fourSynced() {
		const rig = syncRig();
		for (const name of ["A", "B", "C", "D"]) rig.vault.create(`Notes/${name}.md`, note(name));
		await rig.engine.sync();
		const ids = ["A", "B", "C"].map((name) => rig.recordOf(`Notes/${name}.md`)?.deviceDocId ?? "");
		const kept = ["A", "B", "C"].map((name) => [`Notes/${name}.md`, rig.vault.read(`Notes/${name}.md`) ?? ""] as const);
		for (const [path] of kept) rig.vault.removeUnseen(path);
		return { rig, ids, kept };
	}
	const parents = async (rig: SyncRig, ids: string[]) => Promise.all(ids.map(async (id) => (await rig.tablet.describe(id))?.parent));
	const vanishLines = (rig: SyncRig) => rig.log.filter((line) => /synced notes (are not in|stayed away from) the vault/.test(line));

	it("are held as still arriving at first, then taken as deleted once the same notes stayed away; each said once", async () => {
		const { rig, ids } = await fourSynced();
		for (let run = 0; run < 4; run++) await rig.engine.sync();
		expect(await parents(rig, ids)).not.toContain("trash");
		expect(vanishLines(rig)).toHaveLength(1);
		rig.later(VANISH_SETTLE_MS);
		await rig.engine.sync();
		await rig.engine.sync();
		expect(await parents(rig, ids)).toEqual(["trash", "trash", "trash"]);
		expect(vanishLines(rig)).toHaveLength(2);
		expect(rig.recordOf("Notes/D.md")?.state).toBeUndefined();
		await expectQuiet(rig);
	});

	it("are not taken as deleted when they arrive after all", async () => {
		const { rig, ids, kept } = await fourSynced();
		await rig.engine.sync();
		await rig.engine.sync();
		for (const [path, content] of kept) rig.vault.create(path, content);
		rig.later(VANISH_SETTLE_MS);
		await rig.engine.sync();
		await rig.engine.sync();
		expect(await parents(rig, ids)).not.toContain("trash");
		expect(rig.ports.vanished?.get()).toBeNull();
	});
});

describe("engine runs one after another", () => {
	it("go on after a run, or its wrap-up, throws; no run rejects", async () => {
		const errors: unknown[] = [];
		const queue = new RunQueue((error) => errors.push(error));
		const ran: string[] = [];
		const first = queue.enqueue(() => Promise.reject(new Error("ENOENT: note deleted mid-run")));
		const second = queue.enqueue(async () => {
			ran.push("second");
		});
		await expect(first).resolves.toBeUndefined();
		await second;
		expect(ran).toEqual(["second"]);
		expect(errors).toHaveLength(1);
		const failingReport = new RunQueue(() => {
			throw new Error("console gone");
		});
		await failingReport.enqueue(() => Promise.reject(new Error("x")));
		await failingReport.enqueue(async () => {
			ran.push("third");
		});
		expect(ran).toEqual(["second", "third"]);
	});
});

describe("why notes are held back", () => {
	it("keeps other notes' reasons through a run over some notes, and starts over after a full sync", () => {
		const before = new Map([
			["Notes/A.md", "another copy of the vault is sending it right now"],
			["Notes/B.md", "its notebook's name or folder could not be brought along yet"],
		]);
		const partial = heldAfterRun(before, { held: new Map(), covered: new Set(["Notes/B.md"]), full: false });
		expect([...partial]).toEqual([["Notes/A.md", "another copy of the vault is sending it right now"]]);
		const full = heldAfterRun(before, { held: new Map([["Notes/C.md", "c"]]), covered: new Set(), full: true });
		expect([...full]).toEqual([["Notes/C.md", "c"]]);
	});

	it("are told by the engine: which notes a run looked at, and whether it was a full sync", async () => {
		const { rig } = await synced();
		await rig.restart();
		await rig.engine.send(["Notes/Plan.md"], { auto: true });
		expect([...rig.engine.covered]).toEqual(["Notes/Plan.md"]);
		expect(rig.engine.fullRun).toBe(false);
		await rig.engine.sync();
		expect(rig.engine.fullRun).toBe(true);
	});
});

describe("the shared state folder emptied by another copy", () => {
	const entry = (docId: string): MappingEntry => ({ docId, notePath: `Notes/${docId}.md`, deviceDocId: `nb-${docId}`, uploadedAt: "", contentHash: "", format: "ink" });
	const X = "0f8fad5b-d9cb-469f-a165-70867728950e";

	it("drops the last record once its file is gone with the emptied notes folder", async () => {
		const { fs, files } = memoryFs();
		const here = new SyncState(fs, "state", "a");
		await here.saveMappings({ [X]: entry(X) });
		const table = await here.loadMappings();
		// The other copy removed the note's file (Stop syncing there); git drops the emptied folder with it.
		files.delete(`state/notes/${X}.json`);
		expect(await fs.exists("state/notes")).toBe(false);
		expect(await here.refresh(table)).toEqual({});
	});

	it("keeps the records when the whole state folder is gone (moved or renamed)", async () => {
		const { fs, files } = memoryFs();
		const here = new SyncState(fs, "state", "a");
		await here.saveMappings({ [X]: entry(X) });
		const table = await here.loadMappings();
		for (const path of [...files.keys()]) files.delete(path);
		expect(await here.refresh(table)).toEqual(table);
	});
});
