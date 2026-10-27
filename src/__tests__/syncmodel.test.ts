/**
 * Model-based test of the sync engine: seeded random interleavings of what
 * the owner does in the vault and on the tablet — edit, write ink, rename,
 * move, trash, restore, delete — with runs cut short at random writes. After
 * every quiet sync the invariants must hold:
 *
 * I1 every active record's note is there and its notebook is there outside
 *    the trash, under the note's name, in the folder its note's folder
 *    mirrors (or where the owner moved it outside the synced tree), as read;
 * I2 no notebook is ever deleted outright by the plugin, or trashed or
 *    written over while it holds ink the note lacks; every page written on
 *    the tablet ends up in a note, or is reported as not applied;
 * I3 a second sync writes nothing anywhere;
 * I5 a run cut short is finished by the next one (all of the above);
 * I6 one note ↔ one notebook: no shared ids, no stray copies.
 */

import { describe, expect, it } from "vitest";
import type { MappingEntry } from "../id/mapping";
import { noteFileName } from "../sync/deviceimport";
import { baseName, folderOf, inTrash, mirroredVaultFolder } from "../sync/reconcile";
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
const DEVICE_FOLDERS = ["Obsidian/Notes", "Obsidian/Notes/Sub", "Elsewhere"];

class Crash extends Error {}

function world(seed: number) {
	const rand = random(seed);
	const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)];
	const rig = syncRig({ inPlace: seed % 3 !== 0 });
	const api = rig.cloud.api;
	const violations: string[] = [];
	/** Tablet pages written, by notebook. */
	const ink = new Map<string, Set<string>>();
	let tabletActing = false;
	let budget = -1;
	let crashed = false;
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
	const metadataOf = async (id: string, hash: string): Promise<Record<string, unknown>> => {
		const { entries } = await api.getEntries(`${id}.docSchema`, hash);
		const meta = entries.find((entry) => entry.id === `${id}.metadata`);
		return meta === undefined ? {} : (JSON.parse(new TextDecoder().decode(await api.getHash(meta.id, meta.hash))) as Record<string, unknown>);
	};
	// I2 at the moment of every write the plugin makes to the account.
	const putRootHash = api.putRootHash.bind(api);
	api.putRootHash = async (hash, generation) => {
		if (!tabletActing) {
			tick();
			const before = rig.cloud.rootList();
			const { entries: after } = await api.getEntries("root.docSchema", hash);
			for (const old of before) {
				const now = after.find((entry) => entry.id === old.id);
				if (now === undefined) {
					violations.push(`deleted ${old.id} outright`);
					continue;
				}
				if (now.hash === old.hash) continue;
				const { entries: was } = await api.getEntries(`${old.id}.docSchema`, old.hash);
				const { entries: is } = await api.getEntries(`${old.id}.docSchema`, now.hash);
				const changed = is.filter((entry) => !was.some((w) => w.id === entry.id && w.hash === entry.hash));
				const removed = was.filter((entry) => !is.some((i) => i.id === entry.id));
				const metadataOnly = removed.length === 0 && changed.every((entry) => entry.id.endsWith(".metadata"));
				if (metadataOnly && (await metadataOf(old.id, now.hash)).parent !== "trash") continue;
				const record = recordFor(old.id);
				if (record === undefined) violations.push(`wrote over ${old.id}, which no record holds`);
				else if (record.accountedHash !== old.hash) violations.push(`wrote over or trashed ${old.id} holding unread ink`);
			}
		}
		const result = await putRootHash(hash, generation);
		if (!tabletActing) tick();
		return result;
	};

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
	const notePaths = (folder?: string) =>
		[...rig.vault.files.keys()].filter((path) => path !== "Readme.md" && (folder === undefined || path.startsWith(`${folder}/`)));
	const freePath = (folder: string): string | null => {
		const free = NAMES.map((name) => `${folder}/${name}.md`).filter((path) => !rig.vault.files.has(path));
		return free.length === 0 ? null : pick(free);
	};

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
			const to = freePath(pick(VAULT_FOLDERS));
			if (paths.length === 0 || to === null) return null;
			const from = pick(paths);
			rig.vault.rename(from, to);
			return `vault move ${from} → ${to}`;
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
			const hash = rig.cloud.hashOf(doc.id) ?? "";
			const before = new Set((await api.getEntries(`${doc.id}.docSchema`, hash)).entries.map((entry) => entry.id));
			const after = await asTablet(() => rig.tablet.write(doc.id));
			const pages = ink.get(doc.id) ?? new Set<string>();
			for (const entry of (await api.getEntries(`${doc.id}.docSchema`, after)).entries) {
				if (!before.has(entry.id)) pages.add(entry.id.split("/").pop() ?? entry.id);
			}
			ink.set(doc.id, pages);
			return `ink on ${doc.visibleName}`;
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
	];

	async function sync(crashAt: number): Promise<void> {
		budget = crashAt;
		crashed = false;
		try {
			await rig.engine.sync();
		} catch (error) {
			if (!(error instanceof Crash)) throw error;
		}
		const wasCrashed = crashed;
		budget = -1;
		crashed = false;
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
			if (recordFor(doc.id) === undefined) violations.push(`I6: notebook ${doc.visibleName} (${doc.id}) belongs to no note`);
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
		// Cut a run short now and then, at a random write.
		const crashAt = w.rand() < 0.25 ? Math.floor(w.rand() * 12) : -1;
		await w.sync(crashAt);
		if (crashAt >= 0) trail.push(`crash after ${crashAt} write(s)`);
		await w.sync(-1);
		await w.check();
		const rig: SyncRig = w.rig;
		const before = [rig.cloud.rootWrites(), rig.vault.writes(), rig.fs.writes()];
		await w.sync(-1);
		const after = [rig.cloud.rootWrites(), rig.vault.writes(), rig.fs.writes()];
		if (after.join() !== before.join()) w.violations.push(`I3: a second sync wrote (${before.join()} → ${after.join()})`);
		if (w.violations.length > 0) trail.push(...w.rig.log.slice(-12).map((line) => `  log: ${line}`));
	}
	return { trail, violations: w.violations };
}

describe("the sync engine under random interleavings", () => {
	for (const seed of Array.from({ length: 60 }, (_, i) => i + 1)) {
		it(`keeps every invariant (seed ${seed})`, async () => {
			const { trail, violations } = await run(seed, 100);
			expect(violations, trail.join("\n")).toEqual([]);
		});
	}
});
