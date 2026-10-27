import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { InkSnapshot, MappingTable } from "../id/mapping";
import { collectInkAnnotations } from "../incoming/inkpull";
import type { PullDeps } from "../incoming/pull";
import { remarkId } from "../incoming/remarkid";
import { idKey, parseRmScene } from "../incoming/rmscene";
import { typedTextToMarkdown } from "../incoming/typedtext";
import { DEVICE_PROFILES } from "../ink/inkrender";
import { buildTextPageRm, markdownToTypedText } from "../ink/roottext";
import { buildInkPageRm } from "../ink/rmwrite";
import { editTypedPage } from "../ink/textedit";
import { splitNote } from "../preprocess/preprocess";
import { notesNeedingUpload, sendNote, type NoteInput, type SendDeps, type SentRecord } from "../sync/send";
import { mergeTabletChanges } from "../sync/twoway";
import { typedBody } from "../sync/typednote";
import { sendNotebook, sendNotebookUpdate } from "../transport/notebook";
import { fakeCloud } from "./helpers/fakecloud";
import { filesOf, onTablet } from "./helpers/tablet";

const DOC = "0f8fad5b-d9cb-469f-a165-70867728950e";
const PAPER = { paperSize: { width: 1404, height: 1872 } };
const NO_WAIT = { attempts: 3, backoffMs: () => 0, sleep: async () => undefined };
const HAND: Omit<InkSnapshot, "pageIds"> = {
	font: "readability",
	fallbackFont: "readability",
	pen: "medium",
	color: 0,
	jitter: 0,
	profile: DEVICE_PROFILES.rm2,
	shape: 1,
};
/** The tablet's own author on a page of ours. */
const TABLET = 2;
const fixture = (name: string) => new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))));

/**
 * One note synced with the fake cloud by the real send, transport and
 * import, the way the plugin runs them: read the notebook when it changed,
 * merge into the note, then send the note when it changed.
 */
function typedRig(body: string) {
	const cloud = fakeCloud();
	let table: MappingTable = {};
	let note = `---\nremarkable-id: ${DOC}\n---\n${body}`;
	let sent: SentRecord | null = null;
	let mergedBase: string | undefined;
	const rig = {
		cloud,
		mode: "typed" as "typed" | "handwriting",
		noteWrites: 0,
		get table() {
			return table;
		},
		get body() {
			return splitNote(note).body;
		},
		get deviceDocId() {
			return table[DOC].deviceDocId;
		},
		get pageId() {
			return table[DOC].ink!.pageIds[0];
		},
		editNote(edit: (body: string) => string) {
			const { head, body: current } = splitNote(note);
			note = head + edit(current);
		},
		async page(): Promise<Uint8Array> {
			return (await filesOf(cloud, rig.deviceDocId)).get(`${rig.deviceDocId}/${rig.pageId}.rm`)!;
		},
		async tabletText(): Promise<string> {
			return typedTextToMarkdown(parseRmScene(await rig.page()).text?.paragraphs ?? []);
		},
		/** The owner types on the tablet: the page's text edited in place under the tablet's author. */
		async typeOnTablet(markdown: string) {
			const edit = editTypedPage(await rig.page(), markdownToTypedText(markdown), TABLET);
			if (edit.kind !== "edited") throw new Error(`tablet edit: ${JSON.stringify(edit)}`);
			await onTablet(cloud, rig.deviceDocId, (files) => files.set(`${rig.deviceDocId}/${rig.pageId}.rm`, edit.bytes));
		},
		async replacePage(bytes: Uint8Array) {
			await onTablet(cloud, rig.deviceDocId, (files) => files.set(`${rig.deviceDocId}/${rig.pageId}.rm`, bytes));
		},
		async pull(): Promise<void> {
			const entry = table[DOC];
			const hash = cloud.hashOf(entry.deviceDocId)!;
			if (hash === entry.accountedHash) return;
			const { highlights, marks } = await collectInkAnnotations(entry, hash, pullDeps);
			const { head, body: ours } = splitNote(note);
			const result = mergeTabletChanges({
				base: sent!.body ?? null,
				mergedBase,
				ours,
				layout: null,
				highlights,
				marks,
				sourcePath: "T.md",
				sourceName: "T",
				importedAt: "2026-10-27 12:00",
			});
			if (result.body !== ours) {
				note = head + result.body;
				rig.noteWrites++;
			}
			if (result.projected !== null) mergedBase = result.projected;
			table = { ...table, [DOC]: { ...entry, accountedHash: hash } };
		},
		async send(): Promise<void> {
			const input: NoteInput = { path: "T.md", basename: "T", content: note, existingDocId: DOC };
			if (notesNeedingUpload([input], table, () => ({ kind: "missing" }), false, rig.mode).length === 0) return;
			const { result, table: next } = await sendNote(input, table, sendDeps());
			if (!result.ok) throw new Error(result.error);
			table = next;
		},
		async sync(): Promise<void> {
			if (table[DOC] !== undefined) await rig.pull();
			await rig.send();
		},
	};
	const pullDeps: PullDeps = {
		listDocumentHashes: async () => new Map(),
		listDocumentFiles: async (id, hash) => (await cloud.api.getEntries(`${id}.docSchema`, hash)).entries.map(({ id: file, hash: at }) => ({ id: file, hash: at })),
		readFile: async (file) => new TextDecoder().decode(await cloud.api.getHash(file.id, file.hash)),
		readBytes: (file) => cloud.api.getHash(file.id, file.hash),
		renderStrokes: async (request) => `T-p${request.page}-${remarkId(request.strokes)}.png`,
		writeAnnotations: async () => undefined,
	};
	const sendDeps = (): SendDeps => ({
		client: {
			uploadInk: (name, pages, options) =>
				sendNotebook(cloud.api, name, pages, { ...options, docId: options.deviceDocId, retry: NO_WAIT }).then((r) => ({
					deviceDocId: r.docId,
					pageIds: r.pageIds,
					hash: r.hash,
					replaced: r.replaced,
				})),
			updateInk: (deviceDocId, name, pages, options) =>
				sendNotebookUpdate(cloud.api, deviceDocId, name, pages, { ...options, retry: NO_WAIT }).then((r) => ({
					deviceDocId: r.docId,
					pageIds: r.pageIds,
					hash: r.hash,
				})),
		},
		ink: {
			render: (blocks) => ({
				pages: [buildInkPageRm([{ counter: 100, tool: 17, color: 0, thicknessScale: 2, points: [{ x: 10 + blocks.length, y: 10, width: 16, pressure: 200, speed: 5, direction: 0 }] }], PAPER)],
				snapshot: HAND,
			}),
			renderTyped: (paragraphs) => ({ page: buildTextPageRm(paragraphs, [], PAPER), snapshot: { ...HAND, mode: "typed" } }),
			commitSent: async (_docId, record) => {
				sent = record;
				mergedBase = undefined;
			},
		},
		resolveEmbed: () => ({ kind: "missing" }),
		persistDocId: async () => undefined,
		notebookMode: rig.mode,
	});
	return rig;
}

/** Root writes and note writes a sync made. */
async function writesOf(rig: ReturnType<typeof typedRig>, run: () => Promise<void>) {
	const roots = rig.cloud.rootWrites();
	const notes = rig.noteWrites;
	await run();
	return { roots: rig.cloud.rootWrites() - roots, notes: rig.noteWrites - notes };
}

const NOTE = [
	"# Plan",
	"",
	"Buy **milk** and *bread*.",
	"- eggs",
	"- [ ] call Bob",
	"See [[Other note]] and ![[pic.png]] as they are.",
	"",
	"Last line.",
].join("\n");

describe("typed-text notebooks", () => {
	it("sends the note body as typed text, exactly, and a quiet sync writes nothing", async () => {
		const rig = typedRig(`${NOTE}\n`);
		await rig.sync();
		expect(rig.table[DOC].ink?.mode).toBe("typed");
		expect(await rig.tabletText()).toBe(`${NOTE}\n`);
		expect(await writesOf(rig, () => rig.sync())).toEqual({ roots: 0, notes: 0 });
	});

	it("brings the owner's typed edits into the note exactly, and then writes nothing more", async () => {
		const rig = typedRig(`${NOTE}\n`);
		await rig.sync();
		const edited = NOTE.replace("call Bob", "call Bob and Alice").replace("Last line.", "Last line, typed on the tablet.");
		await rig.typeOnTablet(`${edited}\n`);
		await rig.sync();
		expect(rig.body).toBe(`${edited}\n`);
		// The note now matches the tablet: nothing to send, nothing to merge.
		expect(await writesOf(rig, () => rig.sync())).toEqual({ roots: 0, notes: 0 });
		expect(await rig.tabletText()).toBe(`${edited}\n`);
		// The tablet's characters are still the tablet's: nothing was rewritten.
		const ids = parseRmScene(await rig.page()).text!.paragraphs.flatMap((paragraph) => paragraph.charIds);
		expect(ids.some((id) => id.author === TABLET)).toBe(true);
	});

	it("merges a vault edit and a tablet edit made at the same time, and sends the result back in place", async () => {
		const rig = typedRig(`${NOTE}\n`);
		await rig.sync();
		const device = rig.deviceDocId;
		rig.editNote((body) => body.replace("# Plan", "# Plan for Saturday"));
		await rig.typeOnTablet(`${NOTE.replace("- eggs", "- eggs\n- butter")}\n`);
		await rig.sync();
		const both = NOTE.replace("# Plan", "# Plan for Saturday").replace("- eggs", "- eggs\n- butter");
		expect(rig.body).toBe(`${both}\n`);
		expect(rig.deviceDocId).toBe(device);
		expect(await rig.tabletText()).toBe(`${both}\n`);
		expect(await writesOf(rig, () => rig.sync())).toEqual({ roots: 0, notes: 0 });
	});

	it("brings the owner's ink in as remarks, keeps it on the tablet, and its anchors through a text update", async () => {
		// A page holding typed text with ink anchored to characters in three paragraphs.
		const tabletPage = fixture("text-inline-formats.rm");
		const text = typedTextToMarkdown(parseRmScene(tabletPage).text!.paragraphs);
		const rig = typedRig(text);
		await rig.sync();
		await rig.replacePage(tabletPage);
		await rig.sync();
		// One remark per paragraph the ink is anchored to, the text unchanged.
		const ids = rig.body.split("\n").filter((line) => line.startsWith("> ^ink-"));
		expect(ids).toHaveLength(3);
		expect(typedBody(rig.body)).toBe(text);
		const before = parseRmScene(await rig.page());
		const anchored = before.lines.filter((line) => line.anchorId !== undefined);

		const lines = text.split("\n");
		const last = lines.length - 1;
		rig.editNote((body) => body.replace(lines[last], `${lines[last]} and more`));
		await rig.sync();
		const after = parseRmScene(await rig.page());
		const live = new Set(after.text!.paragraphs.flatMap((paragraph) => paragraph.charIds.map(idKey)));
		for (const line of anchored) {
			const same = after.lines.find((one) => idKey(one.id) === idKey(line.id))!;
			expect(idKey(same.anchorId!)).toBe(idKey(line.anchorId!));
			expect(live.has(idKey(line.anchorId!))).toBe(true);
		}
		// The remarks are the note's, not the page's text.
		expect(await rig.tabletText()).toBe(typedBody(rig.body));
		expect(await rig.tabletText()).not.toContain("[!note]");
		// Read again, the same ink is not placed a second time.
		await rig.typeOnTablet(`${typedBody(rig.body)}\nOne more line.`);
		await rig.sync();
		expect(rig.body.split("\n").filter((line) => line.startsWith("> ^ink-"))).toHaveLength(3);
		expect(rig.body).toContain("One more line.");
		expect(await writesOf(rig, () => rig.sync())).toEqual({ roots: 0, notes: 0 });
	});

	it("switches a note between handwriting and typed text in place, reading the notebook first", async () => {
		const rig = typedRig(`${NOTE}\n`);
		rig.mode = "handwriting";
		await rig.sync();
		const device = rig.deviceDocId;
		const page = rig.pageId;
		expect(parseRmScene(await rig.page()).text).toBeUndefined();

		rig.mode = "typed";
		await rig.send();
		expect(rig.deviceDocId).toBe(device);
		expect(rig.pageId).toBe(page);
		expect(rig.table[DOC].ink?.mode).toBe("typed");
		expect(await rig.tabletText()).toBe(`${NOTE}\n`);
		expect(await writesOf(rig, () => rig.sync())).toEqual({ roots: 0, notes: 0 });

		// Typed on the tablet since: read into the note before the page becomes handwriting again.
		await rig.typeOnTablet(`${NOTE}\nAdded on the tablet.\n`);
		rig.mode = "handwriting";
		await rig.sync();
		expect(rig.body).toContain("Added on the tablet.");
		expect(rig.deviceDocId).toBe(device);
		expect(rig.table[DOC].ink?.mode).toBeUndefined();
		const scene = parseRmScene(await rig.page());
		expect(scene.text).toBeUndefined();
		expect(scene.lines.length).toBeGreaterThan(0);
	});
});
