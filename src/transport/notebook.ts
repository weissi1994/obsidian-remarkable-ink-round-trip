/**
 * Upload a multi-page notebook of pen strokes through the raw sync API
 * (ink fork).
 *
 * The bundle is the one the typed-text notebook already proved on real
 * devices (transport/textnotebook.ts): content, metadata, pagedata, the page
 * files, one entries list, root update. Only the page list grows. Page ids
 * are chosen here, before the first attempt, and come back to the caller:
 * the import maps device pages to layout pages by these ids, which is sturdier
 * than trusting any page ordering field across firmware versions.
 *
 * rmapi-js speaks the same protocol to the official cloud and to rmfakecloud,
 * so this module serves both endpoints unchanged.
 */

import { withGenerationRetry, type RetryOptions } from "./mirror";
import type { RawSyncApi } from "./textnotebook";

export interface NotebookUploadResult {
	docId: string;
	pageIds: string[];
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

	const [content, meta, pagedata, rootInfo, ...files] = await Promise.all([
		api.putText(`${docId}.content`, JSON.stringify(notebookContent(pageIds, size))),
		api.putText(`${docId}.metadata`, JSON.stringify(metadata)),
		api.putText(`${docId}.pagedata`, pageIds.map(() => template).join("\n") + "\n"),
		api.getRootHash(),
		...pages.map((bytes, index) => api.putFile(`${docId}/${pageIds[index]}.rm`, bytes)),
	]);
	const [rootHash, generation, schemaVersion] = rootInfo;
	const fileUploads = files as [{ id: string; hash: string }, Promise<void>][];

	const [[collectionEntry, uploadCollection], { entries: rootEntries }] = await Promise.all([
		api.putEntries(
			docId,
			[content[0], meta[0], pagedata[0], ...fileUploads.map(([entry]) => entry)],
			schemaVersion,
		),
		api.getEntries("root.docSchema", rootHash),
	]);

	const [rootEntry, uploadRoot] = await api.putEntries(
		"root",
		[...rootEntries.filter((entry) => entry.id !== docId), collectionEntry],
		4,
	);
	await Promise.all([
		content[1],
		meta[1],
		pagedata[1],
		...fileUploads.map(([, upload]) => upload),
		uploadCollection,
		uploadRoot,
	]);
	await api.putRootHash(rootEntry.hash, generation);
	return { docId, pageIds };
}

/**
 * Production upload: ids fixed before the first attempt so a retry after a
 * half-landed attempt updates the same document (idempotent re-send, N3).
 */
export async function sendNotebook(
	api: RawSyncApi,
	visibleName: string,
	pages: Uint8Array[],
	options: { parentId?: string; retry?: RetryOptions; now?: () => number } = {},
): Promise<NotebookUploadResult> {
	const docId = uuid4();
	const pageIds = pages.map(() => uuid4());
	return withGenerationRetry(
		() =>
			uploadNotebook(api, visibleName, pages, {
				parentId: options.parentId,
				docId,
				pageIds,
				now: options.now,
			}),
		options.retry,
	);
}

/** One page of a notebook as stored on the account. */
export interface NotebookPageFile {
	pageId: string;
	bytes: Uint8Array;
}

/**
 * Read every `.rm` page of a document plus its content JSON. Used by the
 * handwriting capture and the page-size detection; the annotation import has
 * its own reader in the pull orchestration.
 */
export async function readNotebook(
	api: RawSyncApi & { getText?: (id: string, hash: string) => Promise<string> },
	docId: string,
): Promise<{ pages: NotebookPageFile[]; content: string | null }> {
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
	return { pages, content };
}
