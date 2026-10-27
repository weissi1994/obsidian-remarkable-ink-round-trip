import { describe, expect, it } from "vitest";
import { parseBlocks } from "../convert/mdblocks";
import type { InkSnapshot, MappingEntry } from "../id/mapping";
import { collectInkAnnotations } from "../incoming/inkpull";
import { parsePageOrder } from "../incoming/pagemap";
import type { PullDeps } from "../incoming/pull";
import { parseRmScene } from "../incoming/rmscene";
import { inkOptionsFor } from "../ink/inkfonts";
import { DEVICE_PROFILES, renderInk, toInkLines } from "../ink/inkrender";
import { buildTextPageRm, markdownToTypedText } from "../ink/roottext";
import { buildInkPageRm } from "../ink/rmwrite";
import { editTypedPage } from "../ink/textedit";
import { preprocess, splitNote } from "../preprocess/preprocess";
import { importedNote, pageTypedText } from "../sync/deviceimport";
import { mergeTabletChanges } from "../sync/twoway";
import { InPlaceRefusedError, sendNotebook, sendNotebookUpdate } from "../transport/notebook";
import { fakeCloud } from "./helpers/fakecloud";
import { decodeJson, encodeJson, filesOf, onTablet } from "./helpers/tablet";

const NOTE = ["Some intro words here.", "", "## Tasks", "", "- second item", "", "The quick brown fox jumps over the lazy dog."].join("\n");
const SNAPSHOT: InkSnapshot = {
	pageIds: ["page-1"],
	font: "readability",
	fallbackFont: "readability",
	pen: "medium",
	color: 0,
	jitter: 0.5,
	profile: DEVICE_PROFILES.rm2,
	shape: 1,
};
const ENTRY: MappingEntry = {
	docId: "doc-1",
	notePath: "Ink.md",
	deviceDocId: "dev-1",
	uploadedAt: "2026-10-18T00:00:00Z",
	contentHash: "x",
	format: "ink",
	ink: SNAPSHOT,
};
const PAPER = { paperSize: { width: 1404, height: 1872 } };
const NO_WAIT = { attempts: 3, backoffMs: () => 0, sleep: async () => undefined };
const options = inkOptionsFor(SNAPSHOT, "doc-1", () => null)!;
const render = renderInk(parseBlocks(preprocess(NOTE).markdown), "Ink", {}, options);
const lines = toInkLines(render.pages[0], options.pen);
const inkPage = buildInkPageRm(lines, PAPER);
const TYPED = "Typed on the tablet\n- with a **list**";

/** A page the tablet holds: `base` with typed text added under the tablet's own author. */
function typedOnto(base: Uint8Array, markdown: string): Uint8Array {
	const edit = editTypedPage(base, markdownToTypedText(markdown), 2);
	if (edit.kind !== "edited") throw new Error(JSON.stringify(edit));
	return edit.bytes;
}
/** Our handwritten page with the owner's typed text on it. */
const typedPage = typedOnto(buildTextPageRm(markdownToTypedText(""), lines, PAPER), TYPED);

async function importOf(files: Record<string, Uint8Array>, content = "{}") {
	const deps: PullDeps = {
		listDocumentHashes: async () => new Map([["dev-1", "h"]]),
		listDocumentFiles: async () => [...Object.keys(files).map((id) => ({ id, hash: id })), { id: "dev-1.content", hash: "c" }],
		readFile: async () => content,
		readBytes: async (file) => files[file.id],
		loadInk: async () => render,
		writeAnnotations: async () => undefined,
	};
	return collectInkAnnotations(ENTRY, "h", deps);
}

const common = { sourcePath: "Ink.md", sourceName: "Ink", importedAt: "2026-10-18 12:00", layout: render.layout };

describe("typed text in handwritten notebooks", () => {
	it("is taken into the note once, after the last block of its page", async () => {
		const { highlights, marks } = await importOf({ "dev-1/page-1.rm": typedPage });
		expect(marks).toEqual([{ kind: "note", page: 1, typed: TYPED }]);
		const first = mergeTabletChanges({ ...common, highlights, marks, base: NOTE, ours: NOTE });
		expect(first.body).toBe(`${NOTE}\n\n${TYPED}`);
		// Read again before the next send: already in the note.
		const again = mergeTabletChanges({ ...common, highlights, marks, base: NOTE, ours: first.body, mergedBase: first.projected! });
		expect(again.body).toBe(first.body);
		// Edited in the vault meanwhile: the owner's version stands.
		const touched = first.body.replace("with a **list**", "with a **long list**");
		expect(mergeTabletChanges({ ...common, highlights, marks, base: NOTE, ours: touched, mergedBase: first.projected! }).body).toBe(touched);
	});

	it("comes in from a page the owner added, and that page goes once the note has it", async () => {
		const added = typedOnto(buildTextPageRm(markdownToTypedText(""), [], PAPER), "Thoughts typed on a new page");
		const { highlights, marks } = await importOf({ "dev-1/page-1.rm": inkPage, "dev-1/owner.rm": added });
		expect(marks).toEqual([{ kind: "note", page: 1, typed: "Thoughts typed on a new page" }]);
		const { body } = mergeTabletChanges({ ...common, highlights, marks, base: NOTE, ours: NOTE });
		expect(body.endsWith("Thoughts typed on a new page")).toBe(true);

		const cloud = fakeCloud();
		const sent = await sendNotebook(cloud.api, "Ink", [inkPage], { retry: NO_WAIT });
		const docId = sent.docId;
		const withPage = await onTablet(cloud, docId, (files) => {
			const content = decodeJson(files.get(`${docId}.content`));
			const pages = [
				{ id: sent.pageIds[0], idx: { timestamp: "1:2", value: "ba" } },
				{ id: "owner", idx: { timestamp: "2:1", value: "bb" } },
			];
			files.set(`${docId}.content`, encodeJson({ ...content, cPages: { pages } }));
			files.set(`${docId}/owner.rm`, added);
		});
		const update = (hash: string, noteText: string) =>
			sendNotebookUpdate(cloud.api, docId, "Ink", [inkPage], { expectedHash: hash, pageIds: sent.pageIds, noteText, retry: NO_WAIT });
		const shown = async () => parsePageOrder(new TextDecoder().decode((await filesOf(cloud, docId)).get(`${docId}.content`)));
		const kept = await update(withPage, NOTE);
		expect(await shown()).toEqual([sent.pageIds[0], "owner"]);
		await update(kept.hash, body);
		expect(await shown()).toEqual([sent.pageIds[0]]);
		expect(decodeJson<{ cPages: { pages: { id: string; deleted?: unknown }[] } }>((await filesOf(cloud, docId)).get(`${docId}.content`)).cPages.pages.find((page) => page.id === "owner")?.deleted).toBeDefined();
	});

	it("lets the page be rewritten once its typed text is in the note, and refuses before", async () => {
		const cloud = fakeCloud();
		const sent = await sendNotebook(cloud.api, "Ink", [inkPage], { retry: NO_WAIT });
		const docId = sent.docId;
		const [pageId] = sent.pageIds;
		const typed = await onTablet(cloud, docId, (files) => files.set(`${docId}/${pageId}.rm`, typedPage));
		const rewritten = buildInkPageRm(lines.slice(0, -1), PAPER);
		const update = (noteText: string) =>
			sendNotebookUpdate(cloud.api, docId, "Ink", [rewritten], { expectedHash: typed, pageIds: sent.pageIds, noteText, retry: NO_WAIT });

		const writes = cloud.rootWrites();
		await expect(update(NOTE)).rejects.toMatchObject({ reason: "typed-text", page: 1 });
		await expect(update(NOTE)).rejects.toBeInstanceOf(InPlaceRefusedError);
		expect(cloud.rootWrites()).toBe(writes);

		const { highlights, marks } = await importOf({ "dev-1/page-1.rm": typedPage });
		const { body } = mergeTabletChanges({ ...common, highlights, marks, base: NOTE, ours: NOTE });
		await update(`---\nremarkable-id: doc-1\n---\n${body}`);
		expect((await filesOf(cloud, docId)).get(`${docId}/${pageId}.rm`)).toEqual(rewritten);
	});

	it("lists typed text whose page could not be read instead of dropping it", async () => {
		const broken = typedPage.slice();
		// Garble the text block only.
		const view = new DataView(broken.buffer);
		for (let offset = 43; offset + 8 <= broken.length; offset += 8 + view.getUint32(offset, true)) {
			if (broken[offset + 7] === 0x07) {
				broken.fill(0xff, offset + 12, offset + 40);
				break;
			}
		}
		const { marks } = await importOf({ "dev-1/page-1.rm": broken });
		expect(marks.some((mark) => mark.kind === "skipped" && mark.unapplied?.includes("text typed on page 1"))).toBe(true);
	});
});

describe("notebooks started on the tablet", () => {
	it("bring their typed text into the note verbatim, beside the ink and its reading", () => {
		const page = typedOnto(buildTextPageRm(markdownToTypedText(""), lines, PAPER), "# Meeting\n- agree on **dates**");
		const typed = pageTypedText(page);
		expect(typed).toBe("# Meeting\n- agree on **dates**");
		expect(pageTypedText(inkPage)).toBeUndefined();
		const note = importedNote("doc-9", [
			{ typed, image: "dev-p1.png", text: "read from the ink" },
			{ typed: "Only typed here" },
		]);
		const { body } = splitNote(note);
		expect(body).toBe(
			[
				"# Meeting",
				"- agree on **dates**",
				"",
				"> [!note] Page 1",
				"> read from the ink",
				"> ![[dev-p1.png]]",
				"",
				"Only typed here",
				"",
			].join("\n"),
		);
		expect(parseRmScene(page).text!.paragraphs.some((paragraph) => paragraph.charIds.some((id) => id.author === 2))).toBe(true);
	});
});
