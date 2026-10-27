/**
 * Upload a multi-page notebook of pen strokes through the raw sync API
 * (ink fork).
 *
 * The bundle: content, metadata, pagedata, the page files, one entries list,
 * root update. Page ids
 * are chosen here, before the first attempt, and come back to the caller:
 * the import maps device pages to layout pages by these ids, which is sturdier
 * than trusting any page ordering field across firmware versions.
 *
 * An existing notebook is updated in place (`updateNotebook`): same document,
 * same page ids by index, the owner's page tags, templates and added pages
 * kept, only changed files written. A page of typed text is edited in place
 * (ink/textedit.ts) rather than replaced, so the owner's ink keeps its
 * anchors; a page that goes is marked deleted, as the tablet does it, or
 * its files removed where `.content` has no per-page records to mark.
 *
 * rmapi-js speaks the same protocol to the official cloud and to rmfakecloud,
 * so this module serves both endpoints unchanged.
 */

import { parsePageOrder } from "../incoming/pagemap";
import { inlineMarker } from "../incoming/inlineremark";
import { REMARK_ID_PREFIX, remarkId, typedIdLine, typedTextId } from "../incoming/remarkid";
import { RM_V6_HEADER } from "../incoming/rmlines";
import { parseRmScene, type RmScene, type TextParagraph, type TypedParagraph } from "../incoming/rmscene";
import { pageTypedMarkdown, typedTextToMarkdown } from "../incoming/typedtext";
import { editTypedPage } from "../ink/textedit";
import { INK_AUTHOR } from "../ink/rmwrite";
import { isGenerationConflict, withGenerationRetry, type RetryOptions } from "./mirror";

/** The slice of rmapi-js' raw api this module consumes (structural, testable). */
export interface RawSyncApi {
	getRootHash(): Promise<[string, number, number]>;
	getEntries(id: string, hash: string): Promise<{ entries: RawEntry[] }>;
	getHash(id: string, hash: string): Promise<Uint8Array>;
	putFile(id: string, bytes: Uint8Array): Promise<[RawEntry, Promise<void>]>;
	putText(id: string, content: string): Promise<[RawEntry, Promise<void>]>;
	putEntries(
		id: string,
		entries: readonly RawEntry[],
		schemaVersion: number,
	): Promise<[RawEntry, Promise<void>]>;
	putRootHash(hash: string, generation: number): Promise<[string, number]>;
}

export interface RawEntry {
	id: string;
	hash: string;
}

export interface NotebookUploadResult {
	docId: string;
	pageIds: string[];
	/** The new document's entry hash in the account root, as the listing will show it. */
	hash: string;
	/** The replaced notebook was found and moved to the trash. */
	replaced?: boolean;
}

/**
 * The notebook to be replaced changed on the account since the plugin last
 * read it — ink the note does not have yet. Raised before anything is
 * written, so the caller can read that ink first and try again.
 */
export class NotebookChangedError extends Error {
	constructor(
		readonly deviceDocId: string,
		readonly expectedHash: string,
		readonly actualHash: string,
	) {
		super(`The notebook changed on the reMarkable since it was last read (${deviceDocId}), so it was not replaced.`);
		this.name = "NotebookChangedError";
	}
}

/**
 * The notebook to update is no longer on the account, or is in its trash:
 * the send makes a new one instead. Raised before anything is written.
 */
export class NotebookGoneError extends Error {
	constructor(readonly deviceDocId: string) {
		super(`The notebook is no longer on the reMarkable (${deviceDocId}).`);
		this.name = "NotebookGoneError";
	}
}

/** Why a notebook was not updated in place: what is on a page would be lost. */
export type InPlaceRefusal = "typed-text" | "unreadable-page" | "text-not-diffable";

/**
 * Rewriting a page of the notebook would destroy something the note does not
 * hold: text typed on the tablet, a page that cannot be read at all, or the
 * place of the owner's ink in typed text that cannot be edited exactly.
 * Raised before anything is written; the note is not sent.
 */
export class InPlaceRefusedError extends Error {
	constructor(
		readonly deviceDocId: string,
		readonly reason: InPlaceRefusal,
		/** 1-based page of the notebook as the plugin wrote it. */
		readonly page: number,
		/** What exactly could not be done, for "text-not-diffable". */
		readonly detail?: string,
	) {
		super(
			reason === "typed-text"
				? `Not sent: page ${page} of its notebook has text typed on the reMarkable that is not in the note yet, and sending would overwrite it.`
				: reason === "text-not-diffable"
					? `Not sent: the typed text on page ${page} of its notebook could not be updated exactly (${detail ?? "unknown reason"}), and rewriting it would detach your ink from it.`
					: `Not sent: page ${page} of its notebook could not be read, and sending would overwrite what is on it.`,
		);
		this.name = "InPlaceRefusedError";
	}
}

/**
 * Whether these paragraphs of typed text are all in the note: each one's
 * text, emphasis included, whitespace aside — as the import put it in, or
 * the owner moved it. Text edited in the vault since no longer counts.
 */
export function typedTextInNote(paragraphs: readonly TextParagraph[], noteText: string | undefined): boolean {
	const typed = paragraphs.filter((paragraph) => paragraph.text.trim() !== "");
	if (typed.length === 0) return true;
	if (noteText === undefined) return false;
	const squash = (text: string) => text.replace(/\s+/g, " ").trim();
	const note = squash(noteText);
	return typed.every((paragraph) => note.includes(squash(typedTextToMarkdown([{ style: "plain", spans: paragraph.spans }]))));
}

/**
 * Whether the note carries the block id the import gave this page's typed
 * text (remarkid.ts typedTextId): it came in, edited in the vault since or not.
 */
function typedIdInNote(pageId: string, scene: RmScene, noteText: string | undefined): boolean {
	const typed = pageTypedMarkdown(scene);
	if (typed === null || typed === "unreadable" || noteText === undefined) return false;
	return noteText.includes(typedIdLine(typedTextId(pageId, typed.markdown)));
}

/** RFC4122-v4-shaped id from crypto randomness (same approach as docid.ts). */
function uuid4(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface NotebookUploadOptions {
	parentId?: string;
	docId?: string;
	pageIds?: string[];
	now?: () => number;
	/** Device template per page; "Blank" is a stock template on every model. */
	template?: string;
	/**
	 * A notebook this one replaces: moved to the trash in the same root
	 * update, instead of a second write of the account's whole root index.
	 */
	replaces?: string;
	/**
	 * The root entry hash of `replaces` the caller last fully read (or wrote
	 * itself). Checked against the root this attempt writes over: a different
	 * hash means ink the note lacks, and nothing is written. Absent = no check
	 * (a document the plugin never reads, such as an old PDF copy).
	 */
	expectedHash?: string;
}

/** The content JSON for a notebook of `pageIds` (fields modern firmware writes). */
export function notebookContent(pageIds: string[], sizeInBytes: number): Record<string, unknown> {
	return {
		coverPageNumber: -1,
		documentMetadata: {},
		extraMetadata: {},
		fileType: "notebook",
		fontName: "",
		formatVersion: 1,
		lineHeight: -1,
		margins: 125,
		orientation: "portrait",
		originalPageCount: 0,
		pageCount: pageIds.length,
		pageTags: [],
		pages: pageIds,
		redirectionPageMap: pageIds.map(() => -1),
		sizeInBytes: sizeInBytes.toFixed(),
		tags: [],
		textAlignment: "justify",
		textScale: 1,
		zoomMode: "bestFit",
	};
}

/** One attempt, no retry — `sendNotebook` is the production entry point. */
export async function uploadNotebook(
	api: RawSyncApi,
	visibleName: string,
	pages: Uint8Array[],
	options: NotebookUploadOptions = {},
): Promise<NotebookUploadResult> {
	if (pages.length === 0) throw new Error("A notebook needs at least one page.");
	const docId = options.docId ?? uuid4();
	const pageIds = options.pageIds ?? pages.map(() => uuid4());
	if (pageIds.length !== pages.length) throw new Error("One page id per page is required.");
	const now = options.now ?? Date.now;
	const timestamp = now().toFixed();
	const size = pages.reduce((sum, page) => sum + page.length, 0);

	const metadata = {
		parent: options.parentId ?? "",
		pinned: false,
		lastModified: timestamp,
		createdTime: timestamp,
		type: "DocumentType",
		visibleName,
		lastOpened: timestamp,
		lastOpenedPage: 0,
	};
	const template = options.template ?? "Blank";

	// The root first: a notebook that changed since it was read must stop the
	// upload before anything of it lands.
	const [rootHash, generation, schemaVersion] = await api.getRootHash();
	const { entries: rootEntries } = await api.getEntries("root.docSchema", rootHash);
	if (options.replaces !== undefined && options.expectedHash !== undefined) {
		const current = rootEntries.find((entry) => entry.id === options.replaces);
		if (current !== undefined && current.hash !== options.expectedHash) {
			throw new NotebookChangedError(options.replaces, options.expectedHash, current.hash);
		}
	}

	const [content, meta, pagedata, ...files] = await Promise.all([
		api.putText(`${docId}.content`, JSON.stringify(notebookContent(pageIds, size))),
		api.putText(`${docId}.metadata`, JSON.stringify(metadata)),
		api.putText(`${docId}.pagedata`, pageIds.map(() => template).join("\n") + "\n"),
		...pages.map((bytes, index) => api.putFile(`${docId}/${pageIds[index]}.rm`, bytes)),
	]);
	const fileUploads = files as [{ id: string; hash: string }, Promise<void>][];

	const [collectionEntry, uploadCollection] = await api.putEntries(
		docId,
		[content[0], meta[0], pagedata[0], ...fileUploads.map(([entry]) => entry)],
		schemaVersion,
	);

	const trashed =
		options.replaces === undefined ? null : await trashedEntry(api, rootEntries, options.replaces, timestamp, schemaVersion);
	const [rootEntry, uploadRoot] = await api.putEntries(
		"root",
		[
			...rootEntries.filter((entry) => entry.id !== docId && entry.id !== trashed?.entry.id),
			...(trashed === null ? [] : [trashed.entry]),
			collectionEntry,
		],
		4,
	);
	await Promise.all([
		content[1],
		meta[1],
		pagedata[1],
		...fileUploads.map(([, upload]) => upload),
		uploadCollection,
		uploadRoot,
		...(trashed === null ? [] : trashed.uploads),
	]);
	await api.putRootHash(rootEntry.hash, generation);
	return { docId, pageIds, hash: collectionEntry.hash, replaced: trashed !== null };
}

/**
 * The root entry of `docId` with its metadata moved to the trash, or null when
 * the document is not on the account (already gone). A document that is there
 * but cannot be read fails the whole upload: replacing it blind could leave
 * two notebooks for one note.
 */
async function trashedEntry(
	api: RawSyncApi,
	rootEntries: RawEntry[],
	docId: string,
	timestamp: string,
	schemaVersion: number,
): Promise<{ entry: RawEntry; uploads: Promise<void>[] } | null> {
	const current = rootEntries.find((entry) => entry.id === docId);
	if (current === undefined) return null;
	const { entries } = await api.getEntries(`${docId}.docSchema`, current.hash);
	const metaEntry = entries.find((entry) => entry.id === `${docId}.metadata`);
	if (metaEntry === undefined) throw new Error(`The notebook to replace (${docId}) has no metadata; nothing was sent.`);
	const metadata = JSON.parse(new TextDecoder().decode(await api.getHash(metaEntry.id, metaEntry.hash))) as Record<
		string,
		unknown
	>;
	const [newMeta, uploadMeta] = await api.putText(
		`${docId}.metadata`,
		JSON.stringify({ ...metadata, parent: "trash", lastModified: timestamp }),
	);
	const [entry, uploadEntries] = await api.putEntries(
		docId,
		entries.map((e) => (e.id === metaEntry.id ? newMeta : e)),
		schemaVersion,
	);
	return { entry, uploads: [uploadMeta, uploadEntries] };
}

/**
 * Production upload: ids fixed before the first attempt so a retry after a
 * half-landed attempt updates the same document (idempotent re-send, N3).
 * A caller that records the send before uploading passes the ids it recorded.
 */
export async function sendNotebook(
	api: RawSyncApi,
	visibleName: string,
	pages: Uint8Array[],
	options: {
		parentId?: string;
		retry?: RetryOptions;
		now?: () => number;
		replaces?: string;
		expectedHash?: string;
		docId?: string;
		pageIds?: string[];
	} = {},
): Promise<NotebookUploadResult> {
	const docId = options.docId ?? uuid4();
	const pageIds = options.pageIds ?? pages.map(() => uuid4());
	return withGenerationRetry(
		() =>
			uploadNotebook(api, visibleName, pages, {
				parentId: options.parentId,
				docId,
				pageIds,
				now: options.now,
				replaces: options.replaces,
				expectedHash: options.expectedHash,
			}),
		options.retry,
	);
}

export interface NotebookUpdateOptions {
	/** Device folder; absent = the notebook stays where it is. */
	parentId?: string;
	/** The document's root entry hash as the plugin last accounted for it. */
	expectedHash: string;
	/**
	 * Page ids of the previous send, by page: page N is written under id N
	 * again, so what the owner attached to page N stays with it. Ids past
	 * the new page count are pages the note no longer fills; extra pages get
	 * new ids.
	 */
	pageIds: string[];
	/** The note being sent: a page the owner added goes only once its ink and typed text are in here. */
	noteText?: string;
	/**
	 * Pages of typed text, by index (typed-text notebooks): a page whose
	 * current version holds typed text is edited to read these paragraphs
	 * (ink/textedit.ts), keeping its characters' ids and everything else on
	 * it, instead of being replaced by `pages[index]`.
	 */
	typedPages?: readonly (readonly TypedParagraph[] | undefined)[];
	/** Template of pages new to the notebook. */
	template?: string;
	now?: () => number;
	/**
	 * Called with the new entry hash, the page ids and the entry hashes of
	 * the files this update wrote, once everything is uploaded, just before
	 * the root write makes it count — the moment to record the send as
	 * pending.
	 */
	beforeCommit?: (hash: string, pageIds: string[], written: string[]) => Promise<void>;
	/**
	 * Called (sendNotebookUpdate) with each hash `beforeCommit` was given
	 * whose root write provably never happened — the update gave up on a
	 * changed, gone or refused notebook, or on the account changing every
	 * time — so that pending record can go. Not called when the root write
	 * may have landed (a network error during it).
	 */
	abandoned?: (hash: string) => Promise<void>;
}

export interface NotebookUpdateResult {
	docId: string;
	/** The plugin's pages, in order (the snapshot's `pageIds`). */
	pageIds: string[];
	/** The document's entry hash in the account root after the update. */
	hash: string;
}

type Json = Record<string, unknown>;

/** A stamped value in `.content`'s per-page records. */
interface Stamped {
	timestamp?: unknown;
	value?: unknown;
}

/** A page's record in `.content` (`cPages.pages[]`); unknown fields are kept. */
interface CPage {
	id?: unknown;
	idx?: Stamped;
	deleted?: unknown;
	[field: string]: unknown;
}

/**
 * The parts of a device `.content` this module reads; unknown fields are
 * kept. Read with optional chaining only, so a field of another shape reads
 * as absent instead of throwing.
 */
interface DeviceContent {
	pages?: unknown;
	pageTags?: unknown;
	redirectionPageMap?: unknown;
	lastOpenedPage?: unknown;
	cPages?: { pages?: unknown; lastOpened?: Stamped; [field: string]: unknown };
	[field: string]: unknown;
}

const decoder = new TextDecoder();

/** The block type of a page's typed text (rmscene RootTextBlock). */
const ROOT_TEXT_BLOCK = 0x07;

/** A JSON object, or null for anything else (unparsable, an array, a scalar). */
function parseObject(text: string): Json | null {
	try {
		const value: unknown = JSON.parse(text);
		return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;
	} catch {
		return null;
	}
}

/** A file's hash the way rmapi-js and the cloud compute it. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/** The page a document file belongs to — strokes, page metadata, highlights, thumbnail — or null. */
function pageOfFile(docId: string, fileId: string): string | null {
	const slash = fileId.indexOf("/");
	if (slash === -1) return null;
	const folder = fileId.slice(0, slash);
	if (folder !== docId && !folder.startsWith(`${docId}.`)) return null;
	const name = fileId.slice(slash + 1);
	if (folder === docId && name.endsWith("-metadata.json")) return name.slice(0, -"-metadata.json".length);
	const dot = name.lastIndexOf(".");
	return dot <= 0 ? null : name.slice(0, dot);
}

/** A `.content` value stamp ("author:counter") one later, so the tablet's merge takes the new value. */
function laterStamp(stamp: unknown): string {
	const match = typeof stamp === "string" ? /^(\d+):(\d+)$/.exec(stamp) : null;
	return match === null ? "1:2" : `${match[1]}:${Number(match[2]) + 1}`;
}

/** Fixed-width page order keys that sort like their index ("ba", "bb", …). */
function orderKey(index: number, count: number): string {
	let width = 1;
	while (26 ** width < count) width++;
	let key = "";
	for (let i = 0, rest = index; i < width; i++, rest = Math.floor(rest / 26)) {
		key = String.fromCharCode(97 + (rest % 26)) + key;
	}
	return `b${key}`;
}

/** An order key sorting right after `key`. */
function keyAfter(key: string): string {
	const last = key.charCodeAt(key.length - 1);
	return last >= 97 && last < 122 ? key.slice(0, -1) + String.fromCharCode(last + 1) : `${key}b`;
}

function idxOf(page: CPage | undefined): string | null {
	return typeof page?.idx?.value === "string" ? page.idx.value : null;
}

/**
 * The device's per-page records for `finalIds`: a kept page keeps its record
 * (template, scroll, unknown fields); records of pages that go stay, marked
 * deleted with a stamp later than theirs, as the tablet marks a page it
 * deletes — a record left out or a field removed carries no stamp, and the
 * tablet's merge would bring the page back. Deleted owner pages stay as
 * they are. Order keys stay when the order still holds, else every page is
 * renumbered.
 */
function rebuildCPages(
	old: NonNullable<DeviceContent["cPages"]>,
	oldPages: CPage[],
	finalIds: string[],
	dropped: ReadonlySet<string>,
	template: string,
): Json {
	const byId = new Map<string, CPage>();
	const others: CPage[] = [];
	for (const page of oldPages) {
		if (typeof page?.id === "string") {
			if (dropped.has(page.id) && page.deleted === undefined) {
				const stamp = laterStamp(page.idx?.timestamp);
				others.push({ ...page, deleted: { timestamp: stamp, value: 1 } });
				continue;
			}
			if (finalIds.includes(page.id)) {
				byId.set(page.id, page);
				continue;
			}
		}
		others.push(page);
	}
	let last = "";
	let fresh = false;
	let inOrder = true;
	for (const id of finalIds) {
		const idx = idxOf(byId.get(id));
		if (idx === null) {
			fresh = true;
		} else if (fresh || idx <= last) {
			inOrder = false;
			break;
		} else {
			last = idx;
		}
	}
	let tail = oldPages.reduce<string>((max, page) => {
		const idx = idxOf(page);
		return idx !== null && idx > max ? idx : max;
	}, "");
	const pages = finalIds.map((id, index): CPage => {
		const page = byId.get(id);
		const base: CPage = page ?? { id, template: { timestamp: "1:1", value: template } };
		const current = idxOf(page);
		if (inOrder && current !== null) return base;
		const value = inOrder ? (tail = keyAfter(tail)) : orderKey(index, finalIds.length);
		if (value === current) return base;
		return { ...base, idx: { timestamp: laterStamp(base.idx?.timestamp), value } };
	});
	const all = [...pages, ...others];
	const next: Json = {
		...old,
		pages: inOrder
			? all
					.map((page, at) => ({ page, at, idx: idxOf(page) }))
					.sort((a, b) =>
						a.idx !== null && b.idx !== null && a.idx !== b.idx ? (a.idx < b.idx ? -1 : 1) : a.at - b.at,
					)
					.map(({ page }) => page)
			: all,
	};
	const lastOpened = old.lastOpened;
	if (typeof lastOpened?.value === "string" && lastOpened.value !== "" && !finalIds.includes(lastOpened.value)) {
		next.lastOpened = { ...lastOpened, timestamp: laterStamp(lastOpened.timestamp), value: finalIds[0] };
	}
	return next;
}

/**
 * The device's `.content` for the new page list, everything else as it was:
 * document tags, page tags of pages that stay, per-page records, unknown
 * fields. `shown`: the page order the device had.
 */
function rebuildContent(
	old: DeviceContent,
	shown: string[],
	finalIds: string[],
	dropped: ReadonlySet<string>,
	template: string,
): Json {
	const next: Json = { ...old, pageCount: finalIds.length };
	const legacy: unknown[] = Array.isArray(old.pages) ? old.pages : shown;
	if (Array.isArray(old.pages)) next.pages = [...finalIds];
	if (Array.isArray(old.redirectionPageMap)) {
		const map = old.redirectionPageMap as unknown[];
		next.redirectionPageMap = finalIds.map((id) => {
			const value = map[legacy.indexOf(id)];
			return typeof value === "number" ? value : -1;
		});
	}
	if (Array.isArray(old.pageTags)) {
		next.pageTags = (old.pageTags as ({ pageId?: unknown } | null)[]).filter((tag) => {
			const pageId = tag?.pageId;
			return !(typeof pageId === "string" && dropped.has(pageId));
		});
	}
	if (typeof old.lastOpenedPage === "number") {
		const at = finalIds.indexOf(shown[old.lastOpenedPage] ?? "");
		next.lastOpenedPage = at === -1 ? 0 : at;
	}
	const cPages = old.cPages;
	if (cPages !== undefined && Array.isArray(cPages?.pages)) {
		next.cPages = rebuildCPages(cPages, cPages.pages as CPage[], finalIds, dropped, template);
	}
	return next;
}

/**
 * One attempt at updating a notebook in place, no retry —
 * `sendNotebookUpdate` is the production entry point.
 *
 * The document keeps its id, the plugin's pages their ids by index, and the
 * owner's pages their place after the page of ours they followed. Nothing is
 * written when the document changed since `expectedHash`
 * (NotebookChangedError), is gone (NotebookGoneError), or a page to be
 * rewritten holds what the note does not (InPlaceRefusedError); nothing at
 * all when nothing changed.
 */
export async function updateNotebook(
	api: RawSyncApi,
	docId: string,
	visibleName: string,
	pages: Uint8Array[],
	options: NotebookUpdateOptions,
): Promise<NotebookUpdateResult> {
	if (pages.length === 0) throw new Error("A notebook needs at least one page.");
	const template = options.template ?? "Blank";
	const [rootHash, generation, schemaVersion] = await api.getRootHash();
	const { entries: rootEntries } = await api.getEntries("root.docSchema", rootHash);
	const docEntry = rootEntries.find((entry) => entry.id === docId);
	if (docEntry === undefined) throw new NotebookGoneError(docId);
	if (docEntry.hash !== options.expectedHash) throw new NotebookChangedError(docId, options.expectedHash, docEntry.hash);
	const { entries } = await api.getEntries(`${docId}.docSchema`, docEntry.hash);
	const fileOf = new Map(entries.map((entry) => [entry.id, entry]));
	const read = (entry: RawEntry) => api.getHash(entry.id, entry.hash);
	const strokesOf = (pageId: string) => fileOf.get(`${docId}/${pageId}.rm`);

	const metaEntry = fileOf.get(`${docId}.metadata`);
	const metadata = metaEntry === undefined ? null : parseObject(decoder.decode(await read(metaEntry)));
	if (metadata === null) throw new Error(`The notebook (${docId}) has no readable metadata; nothing was sent.`);
	if (metadata.parent === "trash" || metadata.deleted === true) throw new NotebookGoneError(docId);
	const contentEntry = fileOf.get(`${docId}.content`);
	const contentText = contentEntry === undefined ? "" : decoder.decode(await read(contentEntry));
	const content: DeviceContent | null = parseObject(contentText);

	// The pages as the tablet shows them; a page it deleted keeps its record.
	const deleted = new Set<string>();
	const recorded = new Set<string>();
	const records = content?.cPages?.pages;
	if (Array.isArray(records)) {
		for (const page of records as (CPage | null)[]) {
			if (typeof page?.id !== "string") continue;
			recorded.add(page.id);
			if (page.deleted !== undefined) deleted.add(page.id);
		}
	}
	// Files outside a known page order are left over, not pages.
	const shown = parsePageOrder(contentText);
	if (shown.length === 0) {
		for (const entry of entries) {
			const page = entry.id.startsWith(`${docId}/`) && entry.id.endsWith(".rm") ? pageOfFile(docId, entry.id) : null;
			if (page !== null && !deleted.has(page) && !shown.includes(page)) shown.push(page);
		}
	}

	// A page of ours the owner deleted comes back under a new id: the
	// tablet's stamped delete of the old one stands.
	const ids = options.pageIds.slice(0, pages.length).map((id) => (deleted.has(id) ? uuid4() : id));
	while (ids.length < pages.length) ids.push(uuid4());
	const dropped = new Set(options.pageIds.slice(pages.length).filter((id) => !deleted.has(id)));
	const ours = new Map(options.pageIds.map((id, index) => [id, index]));

	// A page the owner added goes only when what it holds — ink, typed
	// text — is in the note already.
	const typedImported = (pageId: string, scene: RmScene, paragraphs: readonly TextParagraph[]) =>
		typedTextInNote(paragraphs, options.noteText) || typedIdInNote(pageId, scene, options.noteText);
	const added: { id: string; after: number }[] = [];
	let after = -1;
	for (const id of shown) {
		const index = ours.get(id);
		if (index !== undefined) {
			after = Math.min(index, ids.length - 1);
			continue;
		}
		const file = strokesOf(id);
		if (file !== undefined && options.noteText !== undefined) {
			const scene = parseRmScene(await read(file));
			const textUnread = (scene.blockTypes[ROOT_TEXT_BLOCK] ?? 0) > 0 && scene.text === undefined;
			const typed = scene.text?.paragraphs ?? [];
			const strokes = scene.lines.map((line) => line.stroke);
			const holds = strokes.length > 0 || typed.some((paragraph) => paragraph.text.trim() !== "");
			if (
				!textUnread &&
				holds &&
				(strokes.length === 0 || [`^${REMARK_ID_PREFIX}${remarkId(strokes)}`, inlineMarker(remarkId(strokes))].some((marker) => options.noteText!.includes(marker))) &&
				typedImported(id, scene, typed)
			) {
				dropped.add(id);
				continue;
			}
		}
		added.push({ id, after });
	}
	const finalIds = [
		...added.filter((page) => page.after === -1).map((page) => page.id),
		...ids.flatMap((id, index) => [id, ...added.filter((page) => page.after === index).map((page) => page.id)]),
	];

	// What a rewritten page loses must be in the note already: text typed on
	// the tablet once the import brought it in, never an unreadable page.
	const assertRewritable = (bytes: Uint8Array, pageId: string, page: number): void => {
		const scene = parseRmScene(bytes);
		const v6 = decoder.decode(bytes.subarray(0, RM_V6_HEADER.length)) === RM_V6_HEADER;
		if (!v6 || ((scene.blockTypes[ROOT_TEXT_BLOCK] ?? 0) > 0 && scene.text === undefined)) {
			throw new InPlaceRefusedError(docId, "unreadable-page", page);
		}
		const theirs = (scene.text?.paragraphs ?? []).filter((paragraph) => paragraph.charIds.some((id) => id.author !== INK_AUTHOR));
		if (!typedImported(pageId, scene, theirs)) throw new InPlaceRefusedError(docId, "typed-text", page);
	};
	const writes: { id: string; bytes: Uint8Array }[] = [];
	let size = 0;
	for (const [index, id] of ids.entries()) {
		const file = strokesOf(id);
		let bytes = pages[index];
		if (file !== undefined) {
			if (file.hash === (await sha256Hex(bytes))) {
				size += bytes.length;
				continue;
			}
			const current = await read(file);
			size += current.length;
			if (sameBytes(current, bytes)) continue;
			const typed = options.typedPages?.[index];
			const edit = typed === undefined ? null : editTypedPage(current, typed);
			if (edit?.kind === "unchanged") continue;
			if (edit?.kind === "refused") throw new InPlaceRefusedError(docId, "text-not-diffable", index + 1, edit.reason);
			if (edit?.kind === "edited") bytes = edit.bytes;
			else assertRewritable(current, id, index + 1);
			size -= current.length;
		}
		size += bytes.length;
		writes.push({ id, bytes });
	}
	for (const [index, id] of options.pageIds.entries()) {
		const file = index < ids.length ? undefined : strokesOf(id);
		if (file !== undefined && !deleted.has(id)) assertRewritable(await read(file), id, index + 1);
	}

	let nextContent =
		content === null ? notebookContent(finalIds, size) : rebuildContent(content, shown, finalIds, dropped, template);
	let contentChanged = content === null || JSON.stringify(nextContent) !== JSON.stringify(content);
	const pagedataEntry = fileOf.get(`${docId}.pagedata`);
	let pagedata: string | null = null;
	if (pagedataEntry !== undefined) {
		const legacy: unknown[] = content !== null && Array.isArray(content.pages) ? content.pages : shown;
		const lines = decoder.decode(await read(pagedataEntry)).split("\n");
		if (lines[lines.length - 1] === "") lines.pop();
		const next = finalIds.map((id) => {
			const at = legacy.indexOf(id);
			return at >= 0 && at < lines.length ? lines[at] : template;
		});
		if (next.join("\n") !== lines.join("\n")) pagedata = next.join("\n") + "\n";
	}
	const parent = options.parentId ?? (typeof metadata.parent === "string" ? metadata.parent : "");
	if (
		writes.length === 0 &&
		!contentChanged &&
		pagedata === null &&
		metadata.visibleName === visibleName &&
		metadata.parent === parent
	) {
		return { docId, pageIds: ids, hash: docEntry.hash };
	}
	// Only alongside another change: the tablet keeps its own count.
	if (content !== null && "sizeInBytes" in content && content.sizeInBytes !== size.toFixed()) {
		nextContent = { ...nextContent, sizeInBytes: size.toFixed() };
		contentChanged = true;
	}

	const timestamp = (options.now ?? Date.now)().toFixed();
	const uploads = await Promise.all([
		contentChanged ? api.putText(`${docId}.content`, JSON.stringify(nextContent)) : null,
		api.putText(`${docId}.metadata`, JSON.stringify({ ...metadata, visibleName, parent, lastModified: timestamp })),
		pagedata === null ? null : api.putText(`${docId}.pagedata`, pagedata),
		...writes.map(({ id, bytes }) => api.putFile(`${docId}/${id}.rm`, bytes)),
	]);
	const replacements = new Map<string, RawEntry>();
	for (const upload of uploads) if (upload !== null) replacements.set(upload[0].id, upload[0]);
	const rewritten = new Set(writes.map((write) => write.id));
	// A page that goes keeps its files where its record can be marked deleted,
	// as a page the tablet deletes does: should that stamped delete lose the
	// tablet's merge, the page shows as it was. Without a record (a flat
	// `pages` list), a file left behind would read as a page again.
	const files = entries
		.filter((entry) => {
			const page = pageOfFile(docId, entry.id);
			if (page === null) return true;
			if (dropped.has(page) && !recorded.has(page)) return false;
			// The tablet draws a new thumbnail for a page without one.
			return !(rewritten.has(page) && entry.id.startsWith(`${docId}.thumbnails/`));
		})
		.map((entry) => replacements.get(entry.id) ?? entry);
	for (const [id, entry] of replacements) if (!fileOf.has(id)) files.push(entry);

	const [collection, uploadCollection] = await api.putEntries(docId, files, schemaVersion);
	const [root, uploadRoot] = await api.putEntries(
		"root",
		rootEntries.map((entry) => (entry.id === docId ? collection : entry)),
		4,
	);
	await Promise.all([...uploads.map((upload) => upload?.[1]), uploadCollection, uploadRoot]);
	await options.beforeCommit?.(collection.hash, ids, [...replacements.values()].map((entry) => entry.hash));
	await api.putRootHash(root.hash, generation);
	return { docId, pageIds: ids, hash: collection.hash };
}

/**
 * Production in-place update: new page ids and the timestamp fixed before
 * the first attempt, so every attempt writes the same notebook. When it
 * fails, the pending record the last `beforeCommit` asked for is handed to
 * `abandoned` if its root write provably did not happen: it lost to a
 * changed account, and no later attempt got as far.
 */
export async function sendNotebookUpdate(
	api: RawSyncApi,
	docId: string,
	visibleName: string,
	pages: Uint8Array[],
	options: NotebookUpdateOptions & { retry?: RetryOptions },
): Promise<NotebookUpdateResult> {
	const { retry, ...update } = options;
	const pageIds = [...update.pageIds];
	while (pageIds.length < pages.length) pageIds.push(uuid4());
	const stamp = (update.now ?? Date.now)();
	let latest: { hash: string; unwritten: boolean } | undefined;
	const attempt = async () => {
		let committing: string | undefined;
		const beforeCommit = async (hash: string, ids: string[], written: string[]) => {
			await update.beforeCommit?.(hash, ids, written);
			committing = hash;
		};
		try {
			return await updateNotebook(api, docId, visibleName, pages, { ...update, pageIds, now: () => stamp, beforeCommit });
		} catch (error) {
			if (committing !== undefined) latest = { hash: committing, unwritten: isGenerationConflict(error) };
			throw error;
		}
	};
	try {
		return await withGenerationRetry(attempt, retry);
	} catch (error) {
		if (latest?.unwritten === true) await update.abandoned?.(latest.hash);
		throw error;
	}
}

/** One page of a notebook as stored on the account. */
export interface NotebookPageFile {
	pageId: string;
	bytes: Uint8Array;
}

/**
 * Read every `.rm` page of a document plus its content JSON, and the root
 * entry hash they were read at. Used by the handwriting capture, the
 * page-size detection and the import of notebooks started on the tablet; the
 * annotation import has its own reader in the pull orchestration.
 */
export async function readNotebook(
	api: RawSyncApi & { getText?: (id: string, hash: string) => Promise<string> },
	docId: string,
): Promise<{ pages: NotebookPageFile[]; content: string | null; hash: string }> {
	const [rootHash] = await api.getRootHash();
	const { entries: rootEntries } = await api.getEntries("root.docSchema", rootHash);
	const docEntry = rootEntries.find((entry) => entry.id === docId);
	if (!docEntry) throw new Error(`Document ${docId} not found in the account root.`);
	const { entries } = await api.getEntries(`${docId}.docSchema`, docEntry.hash);
	const pages: NotebookPageFile[] = [];
	let content: string | null = null;
	for (const entry of entries) {
		if (entry.id.endsWith(".rm")) {
			const name = entry.id.split("/").pop() ?? entry.id;
			pages.push({ pageId: name.replace(/\.rm$/, ""), bytes: await api.getHash(entry.id, entry.hash) });
		} else if (entry.id === `${docId}.content`) {
			const bytes = await api.getHash(entry.id, entry.hash);
			content = new TextDecoder().decode(bytes);
		}
	}
	return { pages, content, hash: docEntry.hash };
}
