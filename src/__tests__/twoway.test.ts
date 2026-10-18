import { describe, expect, it } from "vitest";
import { parseBlocks } from "../convert/mdblocks";
import { inkOptionsFor } from "../ink/inkfonts";
import { DEVICE_PROFILES, renderInk, toInkLines } from "../ink/inkrender";
import { buildScenePageRm, INK_AUTHOR, SceneItemSpec } from "../ink/rmwrite";
import type { InkSnapshot, MappingEntry } from "../id/mapping";
import { collectInkAnnotations } from "../incoming/inkpull";
import type { PullDeps } from "../incoming/pull";
import { preprocess } from "../preprocess/preprocess";
import { mergeTabletChanges } from "../sync/twoway";

const NOTE = [
	"Some intro words here.",
	"",
	"## Tasks",
	"",
	"- second item",
	"",
	"The quick brown fox jumps over the lazy dog.",
].join("\n");

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

/** The notebook as sent, with every stroke of `erase` rubbed out on the tablet. */
async function tabletChanges(erase: string) {
	const options = inkOptionsFor(SNAPSHOT, "doc-1", () => null)!;
	const render = renderInk(parseBlocks(preprocess(NOTE).markdown), "Ink", {}, options);
	const target = render.layout.lines.flatMap((line) => line.words).find((word) => word.text === erase)!;
	const strokes = render.pages[0];
	const lines = toInkLines(strokes, options.pen);
	const items: SceneItemSpec[] = strokes.map((stroke, index) =>
		stroke.wordId === target.id
			? { author: INK_AUTHOR, counter: stroke.counter, deletedLength: 1 }
			: { author: INK_AUTHOR, counter: stroke.counter, line: lines[index] },
	);
	const page = buildScenePageRm(items, { paperSize: { width: 1404, height: 1872 } });
	const deps: PullDeps = {
		listDocumentHashes: async () => new Map([["dev-1", "h"]]),
		listDocumentFiles: async () => [{ id: "dev-1/page-1.rm", hash: "p" }],
		readFile: async () => "{}",
		readBytes: async () => page,
		loadInk: async () => render,
		writeAnnotations: async () => undefined,
	};
	const { highlights, marks } = await collectInkAnnotations(ENTRY, "h", deps);
	return { layout: render.layout, highlights, marks };
}

const common = { sourcePath: "Ink.md", sourceName: "Ink", importedAt: "2026-10-18 12:00" };

describe("two-way sync", () => {
	it("erases a word in the note itself", async () => {
		const changes = await tabletChanges("quick");
		const { body, outcome } = mergeTabletChanges({ ...common, ...changes, base: NOTE, ours: NOTE });
		expect(body).toContain("The brown fox jumps over the lazy dog.");
		expect(body).not.toContain("quick");
		expect(outcome).toMatchObject({ form: "copy", conflicts: 0 });
	});

	it("keeps a vault edit made while the notebook was out", async () => {
		const changes = await tabletChanges("quick");
		const ours = NOTE.replace("Some intro words here.", "Some new intro words here.").replace(
			"- second item",
			"- second item\n- third item",
		);
		const { body, outcome } = mergeTabletChanges({ ...common, ...changes, base: NOTE, ours });
		expect(body).toContain("Some new intro words here.");
		expect(body).toContain("- third item");
		expect(body).toContain("The brown fox jumps");
		expect(outcome.conflicts).toBe(0);
	});

	it("keeps the note's words where both sides changed them", async () => {
		const changes = await tabletChanges("quick");
		const ours = NOTE.replace("quick", "speedy");
		const { body, outcome } = mergeTabletChanges({ ...common, ...changes, base: NOTE, ours });
		expect(body).toContain("The speedy brown fox");
		expect(body).toContain("Also changed on the reMarkable");
		expect(outcome.conflicts).toBe(1);
	});

	it("falls back to a summary block without a merge base", async () => {
		const changes = await tabletChanges("quick");
		const { body, outcome } = mergeTabletChanges({ ...common, ...changes, base: null, ours: NOTE });
		expect(body.startsWith(NOTE)).toBe(true);
		expect(body).toContain("erased on the reMarkable");
		expect(outcome.form).toBe("summary");
	});
});
