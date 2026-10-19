// @vitest-environment happy-dom
import { beforeAll, describe, expect, it, vi } from "vitest";
import { installDomHelpers } from "./helpers/obsidian";

/*
 * The confirm / correct buttons on a remark callout, against a stand-in for
 * the slice of the Obsidian API they use. The note edits themselves are
 * tested in remarkid.test.ts; this checks the glue: which callouts get
 * buttons, and that clicking them edits the right remark.
 */

beforeAll(() => installDomHelpers());

const NOTE = [
	"Text.",
	"",
	"> [!note] Remark",
	"> helo wrld",
	"> ![[img/a.png]]",
	"> ^ink-aaaaaaaaaaaa",
	"",
	"> [!tip] Not a remark",
	"> keep",
].join("\n");

function fakeApp(initial: string) {
	let note = initial;
	const file = { path: "N.md" };
	const app = {
		vault: {
			getFileByPath: () => file,
			cachedRead: async () => note,
			process: async (_f: unknown, fn: (text: string) => string) => {
				note = fn(note);
				return note;
			},
			getResourcePath: () => "app://img",
		},
		metadataCache: { getFirstLinkpathDest: () => ({ path: "img/a.png" }) },
	};
	return { app, file, note: () => note };
}

/** A callout as Obsidian renders it: title, content. */
function rendered(type: string): HTMLElement {
	const el = createDiv();
	const callout = el.createDiv({ cls: "callout", attr: { "data-callout": type } });
	callout.createDiv({ cls: "callout-title" }).createDiv({ text: "Remark" });
	callout.createDiv({ cls: "callout-content" });
	return el;
}

async function setUp(note = NOTE) {
	const { RemarkControls } = await import("../remarkui");
	const fake = fakeApp(note);
	const inserted: string[] = [];
	const controls = new RemarkControls(fake.app as never, async (_file, id) => {
		inserted.push(id);
	});
	const ctx = (line: number) => ({ sourcePath: "N.md", getSectionInfo: () => ({ lineStart: line, lineEnd: line + 3, text: note }) });
	return { controls, fake, ctx, inserted };
}

describe("remark callout buttons", () => {
	it("appear on a remark callout: confirm, correct, insert as text", async () => {
		const { controls, ctx } = await setUp();
		const el = rendered("note");
		await controls.process(el, ctx(2) as never);
		const icons = Array.from(el.querySelectorAll(".remarkable-ink-remark-action")).map((b) => b.getAttribute("data-icon"));
		expect(icons).toEqual(["check", "pencil", "arrow-down-to-line"]);
	});

	it("stay off other callouts", async () => {
		const { controls, ctx } = await setUp();
		const el = rendered("tip");
		await controls.process(el, ctx(7) as never);
		expect(el.querySelector(".remarkable-ink-remark-actions")).toBeNull();
	});

	it("confirm the remark when ✓ is clicked", async () => {
		const { controls, ctx, fake } = await setUp();
		const el = rendered("note");
		await controls.process(el, ctx(2) as never);
		(el.querySelector('[data-icon="check"]') as HTMLButtonElement).click();
		await vi.waitFor(() => expect(fake.note()).toContain("> [!note] Remark ✓"));
	});

	it("offer only correcting once confirmed, and not twice on a re-render", async () => {
		const { controls, ctx } = await setUp(NOTE.replace("> [!note] Remark", "> [!note] Remark ✓"));
		const el = rendered("note");
		await controls.process(el, ctx(2) as never);
		await controls.process(el, ctx(2) as never);
		const icons = Array.from(el.querySelectorAll(".remarkable-ink-remark-action")).map((b) => b.getAttribute("data-icon"));
		expect(icons).toEqual(["pencil", "arrow-down-to-line"]);
	});

	it("find the remark by its image when the source line is unknown", async () => {
		const { controls } = await setUp();
		const el = rendered("note");
		el.querySelector<HTMLElement>(".callout-content")!.createSpan({ cls: "internal-embed", attr: { src: "img/a.png" } });
		await controls.process(el, { sourcePath: "N.md", getSectionInfo: () => null } as never);
		expect(el.querySelectorAll(".remarkable-ink-remark-action")).toHaveLength(3);
	});

	it("insert the remark as text when ⤵ is clicked", async () => {
		const { controls, ctx, inserted } = await setUp();
		const el = rendered("note");
		await controls.process(el, ctx(2) as never);
		(el.querySelector('[data-icon="arrow-down-to-line"]') as HTMLButtonElement).click();
		await vi.waitFor(() => expect(inserted).toEqual(["aaaaaaaaaaaa"]));
	});

	it("offer no confirm or insert for a remark without text", async () => {
		const { controls, ctx } = await setUp(NOTE.replace("> helo wrld\n", ""));
		const el = rendered("note");
		await controls.process(el, ctx(2) as never);
		const icons = Array.from(el.querySelectorAll(".remarkable-ink-remark-action")).map((b) => b.getAttribute("data-icon"));
		expect(icons).toEqual(["pencil"]);
	});

	it("write a correction into the callout, confirming it if asked", async () => {
		const { controls, fake } = await setUp();
		await controls.correct(fake.file as never, "aaaaaaaaaaaa", "hello world", true);
		expect(fake.note()).toContain("> [!note] Remark ✓\n> hello world\n> ![[img/a.png]]\n> ^ink-aaaaaaaaaaaa");
	});
});
