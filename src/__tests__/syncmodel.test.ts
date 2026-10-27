/**
 * Model-based test of the sync engine: seeded random interleavings of what
 * the owner does in the vault and on the tablet — edit, write ink, tag,
 * rename, move, trash, restore, delete, rename folders, start notebooks on
 * the tablet — with runs cut short at random writes, the tablet writing in
 * the middle of a run, a sync against another account and a sync while most
 * of the vault has not arrived yet. After every quiet sync the invariants
 * must hold:
 *
 * I1 every active record's note is there and its notebook is there outside
 *    the trash, under the note's name, in the folder its note's folder
 *    mirrors (or where the owner moved it outside the synced tree), as read,
 *    with the note's tags;
 * I2 no notebook is ever deleted outright by the plugin, or trashed or
 *    written over while it holds ink the note lacks; every page written on
 *    the tablet ends up in a note, or is reported as not applied;
 * I3 a second sync writes nothing anywhere;
 * I5 a run cut short is finished by the next one (all of the above);
 * I6 one note ↔ one notebook: no shared ids, no stray copies.
 *
 * And with two installs of the vault sharing the account and the vault but
 * each its own copy of the sync state folder, delivered to the other late:
 * I6 and I2 still hold once everything arrived.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MappingEntry, MappingTable } from "../id/mapping";
import { noteFileName } from "../sync/deviceimport";
import { baseName, folderOf, inTrash, mirroredVaultFolder } from "../sync/reconcile";
import { normalTags, sameTags } from "../sync/tags";
import { createFolder, readTags } from "../transport/metadata";
import type { RawSyncApi } from "../transport/notebook";
import { fakeCloud } from "./helpers/fakecloud";
import { withField } from "./helpers/memoryvault";
import { syncRig, type SyncRig } from "./helpers/syncrig";

function random(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const NAMES = ["Alpha", "Beta", "Gamma", "Delta"];
const VAULT_FOLDERS = ["Notes", "Notes/Sub"];
const SUBFOLDERS = ["Sub", "Sub2", "Sub3"];
const DEVICE_FOLDERS = ["Obsidian/Notes", "Obsidian/Notes/Sub", "Elsewhere"];
const TAGS = ["work", "idea", "todo"];

class Crash extends Error {}

/** A random subset of `items`, in their order. */
const subset = <T>(rand: () => number, items: readonly T[]): T[] => items.filter(() => rand() < 0.5);

/**
 * Watch every root write the plugin makes (I2): nothing deleted outright,
 * nothing written over or trashed while holding ink its record has not
 * read. A write the cloud will refuse (an outdated generation) is not
 * judged. `writer`: whose records judge the write.
 */
function guardWrites(
	api: RawSyncApi,
	rootList: () => { id: string; hash: string }[],
	writer: () => { table: MappingTable } | null,
	violations: string[],
	hooks: { before?: () => Promise<void>; after?: () => void } = {},
): void {
	const metadataOf = async (id: string, hash: string): Promise<Record<string, unknown>> => {
		const { entries } = await api.getEntries(`${id}.docSchema`, hash);
		const meta = entries.find((entry) => entry.id === `${id}.metadata`);
		return meta === undefined ? {} : (JSON.parse(new TextDecoder().decode(await api.getHash(meta.id, meta.hash))) as Record<string, unknown>);
	};
	const putRootHash = api.putRootHash.bind(api);
	api.putRootHash = async (hash, generation) => {
		const rig = writer();
		if (rig !== null) {
			await hooks.before?.();
			const [, current] = await api.getRootHash();
			if (generation === current) {
				const before = rootList();
				const { entries: after } = await api.getEntries("root.docSchema", hash);
				for (const old of before) {
					const now = after.find((entry) => entry.id === old.id);
					if (now === undefined) {
						violations.push(`I2: deleted ${old.id} outright`);
						continue;
					}
					if (now.hash === old.hash) continue;
					const { entries: was } = await api.getEntries(`${old.id}.docSchema`, old.hash);
					const { entries: is } = await api.getEntries(`${old.id}.docSchema`, now.hash);
					const changed = is.filter((entry) => !was.some((w) => w.id === entry.id && w.hash === entry.hash));
					const removed = was.filter((entry) => !is.some((i) => i.id === entry.id));
					// Name, folder and tags only: nothing of the pages is touched.
					const pagesKept = removed.length === 0 && changed.every((entry) => entry.id.endsWith(".metadata") || entry.id.endsWith(".content"));
					if (pagesKept && (await metadataOf(old.id, now.hash)).parent !== "trash") continue;
					const record = Object.values(rig.table).find((entry) => entry.deviceDocId === old.id);
					if (record === undefined) violations.push(`I2: wrote over ${old.id}, which no record holds`);
					else if (record.accountedHash !== old.hash) violations.push(`I2: wrote over or trashed ${old.id} holding unread ink`);
				}
			}
		}
		const result = await putRootHash(hash, generation);
		if (rig !== null) hooks.after?.();
		return result;
	};
}

function world(seed: number) {
	const rand = random(seed);
	const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)];
	const rig = syncRig({ inPlace: seed % 3 !== 0 });
	const api = rig.cloud.api;
	const violations: string[] = [];
	/** Tablet pages written, by notebook. */
	const ink = new Map<string, Set<string>>();
	/** Notebooks started on the tablet. */
	const tabletBorn = new Set<string>();
	let tabletActing = false;
	let budget = -1;
	let crashed = false;
	/** The tablet may write once in the middle of this run. */
	let midRun = false;
	const tick = (): void => {
		if (crashed) throw new Crash("crashed");
		if (budget === 0) {
			crashed = true;
			throw new Crash("crashed");
		}
		if (budget > 0) budget--;
	};
	rig.failWrites(() => {
		if (!tabletActing) tick();
	});
	rig.vault.onWrite(() => tick());

	const recordFor = (deviceDocId: string): MappingEntry | undefined =>
		Object.values(rig.table).find((entry) => entry.deviceDocId === deviceDocId);
	const asTablet = async <T>(run: () => Promise<T> | T): Promise<T> => {
		tabletActing = true;
		try {
			return await run();
		} finally {
			tabletActing = false;
		}
	};
	const pluginNotebooks = async () => {
		const listing = await rig.tablet.listing();
		const byId = new Map(listing.map((item) => [item.id, item]));
		return {
			listing,
			byId,
			live: listing.filter((item) => item.type === "DocumentType" && !inTrash(item.parent, byId)),
			trashed: listing.filter((item) => item.type === "DocumentType" && inTrash(item.parent, byId)),
		};
	};
	/** New pages since `before` (entry ids), noted as written on the tablet. */
	const notePages = async (id: string, hash: string, before: Set<string>): Promise<void> => {
		const pages = ink.get(id) ?? new Set<string>();
		for (const entry of (await api.getEntries(`${id}.docSchema`, hash)).entries) {
			if (entry.id.endsWith(".rm") && !before.has(entry.id)) pages.add(entry.id.split("/").pop() ?? entry.id);
		}
		ink.set(id, pages);
	};
	const writeOnTablet = async (id: string): Promise<void> => {
		const hash = rig.cloud.hashOf(id) ?? "";
		const before = new Set((await api.getEntries(`${id}.docSchema`, hash)).entries.map((entry) => entry.id));
		const after = await asTablet(() => rig.tablet.write(id));
		await notePages(id, after, before);
	};
	guardWrites(api, () => rig.cloud.rootList(), () => (tabletActing ? null : { table: rig.table }), violations, {
		before: async () => {
			tick();
			if (!midRun || rand() >= 0.3) return;
			midRun = false;
			const { live } = await pluginNotebooks();
			if (live.length > 0) await writeOnTablet(pick(live).id);
		},
		after: () => tick(),
	});

	const notePaths = (folder?: string) =>
		[...rig.vault.files.keys()].filter((path) => path !== "Readme.md" && (folder === undefined || path.startsWith(`${folder}/`)));
	const freePath = (folder: string): string | null => {
		const free = NAMES.map((name) => `${folder}/${name}.md`).filter((path) => !rig.vault.files.has(path));
		return free.length === 0 ? null : pick(free);
	};
	/** What the plugin has done to records and notebooks so far: nothing of it may change in a sync that must not judge. */
	const snapshot = async () =>
		JSON.stringify([
			Object.values(rig.table).map((entry) => [entry.docId, entry.state, entry.deviceDocId]),
			(await pluginNotebooks()).listing.map((item) => [item.id, item.parent]),
			[...rig.vault.files.keys()].sort(),
		]);

	const ops: (() => Promise<string | null>)[] = [
		async () => {
			const path = freePath(pick(VAULT_FOLDERS));
			if (path === null) return null;
			rig.vault.create(path, `# ${baseName(path)}\n\nText ${rand().toFixed(4)}\n`);
			return `create ${path}`;
		},
		async () => {
			const paths = notePaths();
			if (paths.length === 0) return null;
			const path = pick(paths);
			rig.vault.modify(path, (text) => `${text}Edit ${rand().toFixed(4)}\n`);
			return `edit ${path}`;
		},
		async () => {
			const paths = notePaths("Notes");
			if (paths.length === 0) return null;
			const path = pick(paths);
			const tags = subset(rand, TAGS);
			rig.vault.modify(path, (text) => withField(text, "tags", tags.length === 0 ? null : `[${tags.join(", ")}]`));
			return `vault tags ${path}: ${tags.join(" ")}`;
		},
		async () => {
			const paths = notePaths("Notes");
			const to = freePath(pick(VAULT_FOLDERS));
			if (paths.length === 0 || to === null) return null;
			const from = pick(paths);
			rig.vault.rename(from, to);
			return `vault move ${from} → ${to}`;
		},
		async () => {
			// A vault folder renamed: every note in it moves.
			const from = `Notes/${pick(SUBFOLDERS)}`;
			const to = `Notes/${pick(SUBFOLDERS)}`;
			const paths = notePaths(from);
			if (from === to || paths.length === 0 || notePaths(to).length > 0) return null;
			for (const path of paths) rig.vault.rename(path, `${to}${path.slice(from.length)}`);
			return `vault folder ${from} → ${to}`;
		},
		async () => {
			const paths = notePaths();
			if (paths.length === 0) return null;
			const path = pick(paths);
			rig.vault.remove(path);
			return `vault delete ${path}`;
		},
		async () => {
			const paths = [...rig.vault.trash.keys()].filter((path) => !rig.vault.files.has(path));
			if (paths.length === 0) return null;
			const path = pick(paths);
			rig.vault.restore(path);
			return `vault restore ${path}`;
		},
		async () => {
			const archived = notePaths("reMarkable/Archive");
			const to = freePath(pick(VAULT_FOLDERS));
			if (archived.length === 0 || to === null) return null;
			const from = pick(archived);
			rig.vault.rename(from, to);
			return `out of the archive ${from} → ${to}`;
		},
		async () => {
			const { live } = await pluginNotebooks();
			if (live.length === 0) return null;
			const doc = pick(live);
			await writeOnTablet(doc.id);
			return `ink on ${doc.visibleName}`;
		},
		async () => {
			const { live } = await pluginNotebooks();
			if (live.length === 0) return null;
			const doc = pick(live);
			const tags = subset(rand, TAGS);
			await asTablet(() => rig.tablet.tags(doc.id, tags));
			return `tablet tags ${doc.visibleName}: ${tags.join(" ")}`;
		},
		async () => {
			const { live } = await pluginNotebooks();
			if (live.length === 0) return null;
			const doc = pick(live);
			const name = pick(NAMES);
			await asTablet(() => rig.tablet.rename(doc.id, name));
			return `tablet rename ${doc.visibleName} → ${name}`;
		},
		async () => {
			const { live } = await pluginNotebooks();
			if (live.length === 0) return null;
			const doc = pick(live);
			const folder = pick(DEVICE_FOLDERS);
			await asTablet(async () => rig.tablet.move(doc.id, await rig.tablet.folderAt(folder)));
			return `tablet move ${doc.visibleName} → ${folder}`;
		},
		async () => {
			// A device folder renamed on the tablet: its id stays, its path changes.
			const { listing, byId } = await pluginNotebooks();
			const notes = listing.find((item) => item.type === "CollectionType" && item.visibleName === "Notes" && byId.get(item.parent)?.visibleName === "Obsidian");
			const subs = listing.filter((item) => item.type === "CollectionType" && item.parent === notes?.id);
			if (subs.length === 0) return null;
			const folder = pick(subs);
			const name = pick(SUBFOLDERS);
			if (subs.some((item) => item.visibleName === name)) return null;
			await asTablet(() => rig.tablet.rename(folder.id, name));
			return `tablet folder ${folder.visibleName} → ${name}`;
		},
		async () => {
			// A notebook started on the tablet, in a synced folder: brought in as a note.
			const folder = pick(DEVICE_FOLDERS.slice(0, 2));
			const name = pick(NAMES);
			const id = await asTablet(async () => rig.tablet.create(name, await rig.tablet.folderAt(folder)));
			tabletBorn.add(id);
			await notePages(id, rig.cloud.hashOf(id) ?? "", new Set());
			return `tablet new notebook ${folder}/${name}`;
		},
		async () => {
			const { live } = await pluginNotebooks();
			if (live.length === 0) return null;
			const doc = pick(live);
			await asTablet(() => rig.tablet.trash(doc.id));
			return `tablet trash ${doc.visibleName}`;
		},
		async () => {
			// A superseded notebook the owner digs out of the trash is theirs, not the plugin's.
			const { trashed } = await pluginNotebooks();
			const recorded = trashed.filter((doc) => recordFor(doc.id) !== undefined);
			if (recorded.length === 0) return null;
			const doc = pick(recorded);
			const folder = pick(DEVICE_FOLDERS.slice(0, 2));
			await asTablet(async () => rig.tablet.move(doc.id, await rig.tablet.folderAt(folder)));
			return `tablet restore ${doc.visibleName} → ${folder}`;
		},
		async () => {
			const { live, trashed } = await pluginNotebooks();
			const all = [...live, ...trashed];
			if (all.length === 0) return null;
			const doc = pick(all);
			await asTablet(() => rig.tablet.erase(doc.id));
			return `tablet erase ${doc.visibleName}`;
		},
		async () => {
			// Paired with another account for one sync: with notes synced, nothing is judged and nothing sent.
			const synced = Object.values(rig.table).some((entry) => entry.state !== "archived" && (entry.format === "ink" || entry.format === "device"));
			if (!synced) return null;
			const other = fakeCloud();
			await createFolder(other.api, "Someone else's", "", { retry: { attempts: 1 } });
			const before = await snapshot();
			rig.useAccount(other);
			try {
				await rig.engine.sync();
			} finally {
				rig.useAccount(null);
			}
			if (other.live().length !== 1) violations.push("account switch: sent notebooks to another account");
			if ((await snapshot()) !== before) violations.push("account switch: archived, trashed or moved something");
			return "a sync against another account";
		},
		async () => {
			// Notes not arrived yet on this device (no delete seen): one sync never takes them as deleted.
			const paths = notePaths();
			const hidden = paths.filter(() => rand() < 0.7);
			if (hidden.length === 0) return null;
			const stash = hidden.map((path) => [path, rig.vault.files.get(path)] as const);
			const hiddenIds = new Set(stash.map(([, file]) => (file === undefined ? undefined : rig.vault.docIdOf(file.content))));
			// A note missing on the sync before as well counts as deleted: two syncs in a row saw it gone.
			const guarded = Object.values(rig.table).filter((entry) => hiddenIds.has(entry.docId) && entry.state !== "archived" && entry.noteMissing !== true);
			const { byId: was } = await pluginNotebooks();
			for (const path of hidden) rig.vault.files.delete(path);
			try {
				await rig.engine.sync();
			} finally {
				// A note made at its path meanwhile (one brought in from the tablet) is kept: the arriving one lands beside it, as sync tools keep both.
				for (const [path, file] of stash) {
					if (file === undefined) continue;
					let at = path;
					for (let n = 2; rig.vault.files.has(at); n++) at = path.replace(/\.md$/, ` (${n}).md`);
					rig.vault.files.set(at, file);
				}
			}
			const { byId: now } = await pluginNotebooks();
			for (const entry of guarded) {
				const before = was.get(entry.deviceDocId);
				const after = now.get(entry.deviceDocId);
				if (before !== undefined && !inTrash(before.parent, was) && after !== undefined && inTrash(after.parent, now)) {
					violations.push(`partial vault: trashed the notebook of ${entry.notePath}`);
				}
				if (rig.table[entry.docId]?.state === "archived") violations.push(`partial vault: archived ${entry.notePath}`);
			}
			return `a sync with ${hidden.length} note(s) not arrived yet`;
		},
	];

	async function sync(crashAt: number, tabletMidRun = false): Promise<void> {
		budget = crashAt;
		crashed = false;
		midRun = tabletMidRun;
		try {
			await rig.engine.sync();
		} catch (error) {
			if (!(error instanceof Crash)) throw error;
		}
		const wasCrashed = crashed;
		budget = -1;
		crashed = false;
		midRun = false;
		if (wasCrashed) await rig.restart();
	}

	async function check(): Promise<void> {
		const { byId, live } = await pluginNotebooks();
		const notes = await rig.vault.port.notes();
		const ids = notes.map((note) => note.docId).filter((id) => id !== undefined);
		if (new Set(ids).size !== ids.length) violations.push("I6: two notes share a document id");
		const active = Object.values(rig.table).filter((entry) => entry.state !== "archived");
		if (new Set(active.map((entry) => entry.deviceDocId)).size !== active.length) violations.push("I6: two records share a notebook");
		for (const doc of live) {
			if (recordFor(doc.id) !== undefined) continue;
			// One started on the tablet outside the synced folders is the owner's own.
			if (tabletBorn.has(doc.id) && mirroredVaultFolder(doc.parent, byId, "Obsidian") === null) continue;
			violations.push(`I6: notebook ${doc.visibleName} (${doc.id}) belongs to no note`);
		}
		for (const entry of active) {
			const note = notes.find((one) => one.docId === entry.docId);
			const doc = byId.get(entry.deviceDocId);
			if (note === undefined) {
				// Deleted in the vault but written on the tablet: kept and reported.
				if (doc === undefined || doc.hash !== entry.unappliedHash) violations.push(`I1: ${entry.notePath} is missing, unreported`);
				continue;
			}
			if (doc === undefined || inTrash(doc.parent, byId)) {
				violations.push(`I1: ${note.path} has no live notebook`);
				continue;
			}
			if (entry.notePath !== note.path) violations.push(`I1: record of ${note.path} says ${entry.notePath}`);
			if (entry.accountedHash !== doc.hash) violations.push(`I1: ${note.path} not read as it is`);
			// A name taken in the folder gets a number, on either side.
			const unnumbered = (name: string) => name.replace(/( \(\d+\))+$/, "");
			if (unnumbered(baseName(note.path)) !== unnumbered(noteFileName(doc.visibleName))) {
				violations.push(`I1: ${note.path} vs notebook “${doc.visibleName}”`);
			}
			const mirrored = mirroredVaultFolder(doc.parent, byId, "Obsidian");
			if (mirrored !== null && mirrored !== folderOf(note.path)) violations.push(`I1: ${note.path} vs folder ${mirrored}`);
			const tags = await readTags(api, doc.id, doc.hash);
			if (!sameTags(normalTags(note.tags ?? []), tags)) violations.push(`I1: ${note.path} tags [${note.tags?.join(" ") ?? ""}] vs notebook [${tags.join(" ")}]`);
		}
		for (const note of notes) {
			if (note.path === "Readme.md" || note.path.startsWith("reMarkable/Archive/")) continue;
			const entry = note.docId === undefined ? undefined : rig.table[note.docId];
			if (entry === undefined || entry.state === "archived") violations.push(`I1: ${note.path} is not synced`);
		}
		const texts = [...rig.vault.files.values(), ...rig.vault.trash.values()].map((file) => file.content).join("\n");
		for (const [id, pages] of ink) {
			const doc = byId.get(id);
			const entry = recordFor(id);
			const reported = entry !== undefined && doc !== undefined && entry.unappliedHash === doc.hash;
			for (const page of pages) {
				if (texts.includes(`ink ${page}`) || doc === undefined || inTrash(doc.parent, byId) || reported) continue;
				if (tabletBorn.has(id) && mirroredVaultFolder(doc.parent, byId, "Obsidian") === null && entry === undefined) continue;
				violations.push(`I2: tablet page ${page} of ${doc.visibleName} is in no note and not reported`);
			}
		}
	}

	return { rig, rand, pick, ops, sync, check, violations };
}

async function run(seed: number, steps: number): Promise<{ trail: string[]; violations: string[] }> {
	const w = world(seed);
	const trail: string[] = [];
	w.rig.vault.create("Readme.md", "Not synced.\n");
	for (let step = 0; step < steps && w.violations.length === 0; step++) {
		const done = await w.pick(w.ops)();
		if (done === null) continue;
		trail.push(done);
		if (w.rand() < 0.5) continue;
		// Cut a run short now and then, at a random write; or let the tablet write in the middle of it.
		const crashAt = w.rand() < 0.25 ? Math.floor(w.rand() * 12) : -1;
		const midRun = crashAt < 0 && w.rand() < 0.3;
		await w.sync(crashAt, midRun);
		if (crashAt >= 0) trail.push(`crash after ${crashAt} write(s)`);
		if (midRun) trail.push("(the tablet may write during that run)");
		await w.sync(-1);
		await w.check();
		const rig: SyncRig = w.rig;
		const before = [rig.cloud.rootWrites(), rig.vault.writes(), rig.fs.writes()];
		const files = new Map(rig.fs.files);
		await w.sync(-1);
		const after = [rig.cloud.rootWrites(), rig.vault.writes(), rig.fs.writes()];
		if (after.join() !== before.join()) {
			w.violations.push(`I3: a second sync wrote (${before.join()} → ${after.join()})`);
			for (const [path, text] of rig.fs.files) if (files.get(path) !== text) trail.push(`  wrote ${path}: ${files.get(path) ?? "(new)"} → ${text}`);
		}
		if (w.violations.length > 0) trail.push(...w.rig.log.slice(-30).map((line) => `  log: ${line}`));
	}
	return { trail, violations: w.violations };
}

// Every write to the account a millisecond of its own, as a tablet and a cloud a network apart have it: times stamped in one write tell it.
beforeEach(() => {
	let now = Date.now();
	vi.spyOn(Date, "now").mockImplementation(() => ++now);
});
afterEach(() => {
	vi.restoreAllMocks();
});

describe("the sync engine under random interleavings", () => {
	for (const seed of Array.from({ length: 60 }, (_, i) => i + 1)) {
		it(`keeps every invariant (seed ${seed})`, async () => {
			const { trail, violations } = await run(seed, 100);
			expect(violations, trail.join("\n")).toEqual([]);
		});
	}
});

/**
 * Hand files of each install's state folder to the other, as a vault sync
 * does — late, file by file: what changed there since the last delivery
 * this way overwrites (the newest wins), what went there goes. A file as it
 * arrived from the other install is not sent back: no sync tool returns a
 * version to where it came from, over what was written there since.
 */
function deliveries(a: Map<string, string>, b: Map<string, string>): { toB: () => void; toA: () => void } {
	const sentToB = new Map<string, string>();
	const sentToA = new Map<string, string>();
	const deliver = (from: Map<string, string>, to: Map<string, string>, sent: Map<string, string>, received: Map<string, string>) => () => {
		for (const [path, text] of from) {
			if (sent.get(path) === text || received.get(path) === text) continue;
			to.set(path, text);
			sent.set(path, text);
		}
		for (const [path, text] of [...sent]) {
			if (from.has(path)) continue;
			if (to.get(path) === text) to.delete(path);
			sent.delete(path);
		}
	};
	return { toB: deliver(a, b, sentToB, sentToA), toA: deliver(b, a, sentToA, sentToB) };
}

async function runTwoCopies(seed: number, steps: number): Promise<{ trail: string[]; violations: string[] }> {
	const rand = random(seed);
	const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)];
	const created = new Set<string>();
	const a = syncRig({ created, installId: "install-a", inPlace: seed % 2 === 0 });
	const b = syncRig({ created, cloud: a.cloud, vault: a.vault, installId: "install-b", inPlace: seed % 2 === 0 });
	const vault = a.vault;
	const api = a.cloud.api;
	const violations: string[] = [];
	const trail: string[] = [];
	const ink = new Map<string, Set<string>>();
	let writer: SyncRig | null = null;
	guardWrites(api, () => a.cloud.rootList(), () => writer, violations);
	const { toB, toA } = deliveries(a.fs.files, b.fs.files);
	const syncAs = async (rig: SyncRig): Promise<void> => {
		writer = rig;
		try {
			await rig.engine.sync();
		} finally {
			writer = null;
		}
	};
	const live = async () => {
		const listing = await a.tablet.listing();
		const byId = new Map(listing.map((item) => [item.id, item]));
		return { byId, live: listing.filter((item) => item.type === "DocumentType" && !inTrash(item.parent, byId)) };
	};
	const notePaths = () => [...vault.files.keys()].filter((path) => path !== "Readme.md");

	const ops: (() => Promise<string | null>)[] = [
		async () => {
			const free = VAULT_FOLDERS.flatMap((folder) => NAMES.map((name) => `${folder}/${name}.md`)).filter((path) => !vault.files.has(path));
			if (free.length === 0) return null;
			const path = pick(free);
			vault.create(path, `# ${baseName(path)}\n\nText ${rand().toFixed(4)}\n`);
			return `create ${path}`;
		},
		async () => {
			const paths = notePaths();
			if (paths.length === 0) return null;
			const path = pick(paths);
			vault.modify(path, (text) => `${text}Edit ${rand().toFixed(4)}\n`);
			return `edit ${path}`;
		},
		async () => {
			const paths = notePaths();
			if (paths.length === 0) return null;
			const path = pick(paths);
			vault.remove(path);
			return `delete ${path}`;
		},
		async () => {
			const { live: docs } = await live();
			if (docs.length === 0) return null;
			const doc = pick(docs);
			const hash = a.cloud.hashOf(doc.id) ?? "";
			const before = new Set((await api.getEntries(`${doc.id}.docSchema`, hash)).entries.map((entry) => entry.id));
			const after = a.tablet.write(doc.id);
			const pages = ink.get(doc.id) ?? new Set<string>();
			for (const entry of (await api.getEntries(`${doc.id}.docSchema`, after)).entries) {
				if (!before.has(entry.id)) pages.add(entry.id.split("/").pop() ?? entry.id);
			}
			ink.set(doc.id, pages);
			return `ink on ${doc.visibleName}`;
		},
		async () => {
			await syncAs(a);
			return "sync on A";
		},
		async () => {
			await syncAs(b);
			return "sync on B";
		},
		async () => {
			toB();
			return "state A → B";
		},
		async () => {
			toA();
			return "state B → A";
		},
	];

	vault.create("Readme.md", "Not synced.\n");
	for (let step = 0; step < steps && violations.length === 0; step++) {
		const done = await pick(ops)();
		if (done !== null) trail.push(done);
	}
	// Everything arrives everywhere, and both sync until quiet.
	for (let round = 0; round < 3; round++) {
		toB();
		toA();
		await syncAs(a);
		toB();
		await syncAs(b);
		toA();
	}
	await syncAs(a);

	const { byId, live: docs } = await live();
	const notes = await vault.port.notes();
	const ids = notes.map((note) => note.docId).filter((id) => id !== undefined);
	if (new Set(ids).size !== ids.length) violations.push("I6: two notes share a document id");
	for (const rig of [a, b]) {
		const name = rig === a ? "A" : "B";
		const active = Object.values(rig.table).filter((entry) => entry.state !== "archived");
		if (new Set(active.map((entry) => entry.deviceDocId)).size !== active.length) violations.push(`I6: two of ${name}'s records share a notebook`);
		for (const doc of docs) {
			if (!active.some((entry) => entry.deviceDocId === doc.id)) violations.push(`I6: notebook ${doc.visibleName} (${doc.id}) belongs to no note of ${name}`);
		}
		for (const note of notes) {
			if (note.path === "Readme.md" || note.path.startsWith("reMarkable/Archive/")) continue;
			const entry = note.docId === undefined ? undefined : rig.table[note.docId];
			if (entry === undefined || entry.state === "archived") violations.push(`I1: ${note.path} is not synced on ${name}`);
		}
	}
	const texts = [...vault.files.values(), ...vault.trash.values()].map((file) => file.content).join("\n");
	for (const [id, pages] of ink) {
		const doc = byId.get(id);
		const entry = Object.values(a.table).find((one) => one.deviceDocId === id);
		const reported = entry !== undefined && doc !== undefined && entry.unappliedHash === doc.hash;
		for (const page of pages) {
			if (texts.includes(`ink ${page}`) || doc === undefined || inTrash(doc.parent, byId) || reported) continue;
			violations.push(`I2: tablet page ${page} of ${doc.visibleName} is in no note and not reported`);
		}
	}
	if (violations.length > 0) trail.push(...a.log.slice(-8).map((line) => `  A: ${line}`), ...b.log.slice(-8).map((line) => `  B: ${line}`));
	return { trail, violations };
}

describe("two installs of one vault, their sync state delivered late", () => {
	for (const seed of Array.from({ length: 30 }, (_, i) => i + 1)) {
		it(`never puts two notebooks to one note, nor loses tablet ink (seed ${seed})`, async () => {
			const { trail, violations } = await runTwoCopies(seed, 60);
			expect(violations, trail.join("\n")).toEqual([]);
		});
	}
});
