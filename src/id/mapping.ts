/**
 * Local mapping store: document ID ↔ device document (PRD F5, foundation for
 * F10–F14). Persisted through the plugin's data.json (caller injects
 * load/save); pure logic lives here for testability.
 */

export interface MappingEntry {
	/** Stable document ID from the note's frontmatter. */
	docId: string;
	/**
	 * Vault path of the note as last synced: a different path now means the
	 * note was renamed or moved in the vault since (sync/reconcile.ts).
	 */
	notePath: string;
	/** Document UUID assigned by the reMarkable cloud on upload. */
	deviceDocId: string;
	/** ISO timestamp of the last upload. */
	uploadedAt: string;
	/** Simple content hash of the uploaded (preprocessed) markdown. */
	contentHash: string;
	/**
	 * What was delivered (GP_E7_S2): "pdf"/"epub" review copies, or "text" —
	 * a write-mode notebook whose import is the write-mode route, not the
	 * annotation pull. Absent = a pre-0.36 upload, always a review copy.
	 */
	/** "device": a notebook started on the tablet, brought in and about to be re-sent as ink. */
	format?: "pdf" | "epub" | "text" | "ink" | "device";
	/**
	 * Hash of the canonical form of the sent text (GP_E7_S3): exactly what
	 * an UNEDITED device copy reads back as. Lets the import tell "the
	 * device was never edited" apart from "the device and the vault both
	 * changed" — only the latter is a conflict. Text sends only; absent on
	 * 0.36.0 uploads, where that distinction degrades to the conflict ask.
	 */
	textHash?: string;
	/**
	 * Device document hash (its entry in the account root) the plugin last
	 * fully accounted for: the notebook as read and merged into the note, or
	 * as uploaded by the plugin itself. Equal to the current hash means
	 * "nothing new on the tablet"; a notebook is only replaced while its hash
	 * still equals this. Unset = not read since an upload of unknown hash.
	 * Stored as `importedHash` by earlier versions (migrateMapping).
	 */
	accountedHash?: string;
	/**
	 * Typography of this upload (GP_E3_S8). The layout map itself is far too
	 * big to keep here, so the import reproduces it from the note plus these
	 * numbers — which stays correct even if the settings changed since.
	 * Absent for EPUB: a reflowing document has no fixed geometry to anchor to.
	 * `typo` records the typesetter behaviour version (GP_E5_S4–S7); absent
	 * means version 1 (sent before 0.29.0).
	 */
	/**
	 * Ink fork: how a handwritten notebook was written, so the import can
	 * regenerate every stroke exactly. `pageIds` maps device pages back to
	 * layout pages; a page the tablet owner added is simply not in it.
	 */
	ink?: InkSnapshot;
	/** The notebook's name on the tablet as last synced; absent = not known yet (taken from the tablet). */
	deviceName?: string;
	/** The notebook's folder (collection id, "" = root) as last synced; absent = not known yet. */
	deviceParent?: string;
	/**
	 * The notebook's folder path on the tablet ("a/b", "" = root) as last
	 * synced: a folder renamed or moved on the tablet keeps its id, so only
	 * the path tells. Absent = not known yet (taken from the tablet).
	 */
	devicePath?: string;
	/**
	 * "archived": the note or the notebook went (vault delete, tablet trash);
	 * nothing is synced until one of them comes back. Absent = active.
	 */
	state?: "archived";
	/** Where an archived note was before it went into the archive folder, to move it back. */
	archivedFrom?: string;
	/**
	 * The notebook hash last reported as "written on the tablet, but its note
	 * was deleted": reported once per change, not on every sync.
	 */
	unappliedHash?: string;
	/**
	 * The tags the notebook and the note last agreed on: the base of the
	 * next three-way merge of the two (sync/tags.ts). Absent = never brought
	 * together; both sides' tags then count as added.
	 */
	tags?: string[];
	/** The notebook hash at which its tags were last `tags`; any other hash means they are read again. */
	tagsHash?: string;
	/**
	 * The note was not in the vault on the last sync, without a delete seen:
	 * maybe deleted, maybe not arrived yet (a vault still syncing in). Its
	 * notebook is only trashed when it is still missing on the next sync.
	 */
	noteMissing?: true;
	pdfLayout?: {
		fontSize: number;
		lineHeight: number;
		margin: number;
		typo?: number;
		/** Page size of this upload (GP_E6_S2); absent = reMarkable 1/2 screen. */
		pageWidth?: number;
		pageHeight?: number;
		/** Heading level up to which pages broke (GP_E6_S4); absent = 0. */
		breakAtHeading?: number;
		/** Whether #/## sections were packed (GP_E6_S9); absent = false. */
		packSections?: boolean;
		/**
		 * Placed diagram dimensions in PDF points, one entry per mermaid
		 * fence in occurrence order (fork: image blocks). Mermaid output is
		 * not stable across versions, so the import replays the *recorded*
		 * geometry instead of re-rendering — the same principle that keeps
		 * `typo` here (GP_E3_S15). A `null` entry is a fence that failed to
		 * render and went to the device as a code block. Absent = sent
		 * before the fork (or without diagrams): fences replay as code and
		 * the layout rebuilds unchanged.
		 */
		images?: ({ w: number; h: number } | null)[];
		/**
		 * Placed vault-image dimensions in PDF points, one entry per
		 * standalone image in occurrence order (fork: image blocks). A
		 * separate list from `images` on purpose: each substitution pass
		 * indexes by occurrence of its own placeholder kind, so a note holding
		 * both a diagram and a picture cannot mis-pair the two. A `null` entry
		 * is an image that could not be loaded and went as placeholder text.
		 * Absent = no standalone images, or sent before the feature existed.
		 */
		vaultImages?: ({ w: number; h: number } | null)[];
	};
}

/** Everything a handwritten send depends on (ink fork). */
export interface InkSnapshot {
	pageIds: string[];
	/**
	 * "typed": a typed-text notebook — one page of keyboard text holding the
	 * note body (sync/typednote.ts); the ink settings only record the
	 * settings of that send. Absent = handwriting.
	 */
	mode?: "typed";
	/** Built-in font id, or "hand" for the owner's captured handwriting. */
	font: string;
	/** Version hash of the handwriting library when font is "hand". */
	hand?: string;
	/** Built-in font used for characters the primary source lacks. */
	fallbackFont: string;
	pen: "fine" | "medium" | "bold";
	color: number;
	jitter: number;
	profile: { width: number; height: number; dpi: number };
	/** Renderer behaviour version (INK_SHAPE_VERSION) at send time. */
	shape: number;
	/**
	 * How pictures were drawn; absent = left as text placeholders. The
	 * quantised pictures themselves are stored with the sent text.
	 */
	imageStyle?: "colour-hatch" | "mono-hatch";
	/** Colour accents were drawn (highlighter bands, diagram fills); absent = not. */
	accents?: true;
	/** Inline styling was drawn and inline HTML read as styling; absent = neither. */
	inline?: true;
	/** Pictures inside quotes and callouts were drawn as pictures; absent = left as text. */
	quotePictures?: true;
	/** The content of quotes and callouts was typeset as blocks — tables, lists, code; absent = one italic run. */
	nestedQuotes?: true;
	/** The title the notebook was written with (its first line). */
	title?: string;
	/**
	 * Glyph source versions [primary, fallback, mono] at send time: a bundled
	 * font that changed in an update must not silently regenerate different
	 * strokes. Absent on nothing — recorded since the first ink release.
	 */
	fontVersions?: string[];
}

export type MappingTable = Record<string, MappingEntry>;

/** FNV-1a 32-bit hash — enough to detect "note changed since upload" (F14). */
export function contentHash(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Record a fresh upload. The hash of the previous copy is deliberately *not*
 * carried over: a re-send creates a new document on the device, so the new
 * entry carries the new document's hash (`accountedHash` of `entry`), or none.
 */
export function recordUpload(
	table: MappingTable,
	entry: Omit<MappingEntry, "uploadedAt"> & { uploadedAt?: string },
): MappingTable {
	return {
		...table,
		[entry.docId]: {
			...entry,
			uploadedAt: entry.uploadedAt ?? new Date().toISOString(),
		},
	};
}

/** A mapping as stored by an earlier version, in today's shape. */
export function migrateMapping(entry: MappingEntry & { importedHash?: string }): MappingEntry {
	if (entry.importedHash === undefined) return entry;
	const { importedHash, ...rest } = entry;
	return { ...rest, accountedHash: rest.accountedHash ?? importedHash };
}

export function lookupByDocId(table: MappingTable, docId: string): MappingEntry | undefined {
	return table[docId];
}

export function lookupByDeviceDocId(
	table: MappingTable,
	deviceDocId: string,
): MappingEntry | undefined {
	return Object.values(table).find((e) => e.deviceDocId === deviceDocId);
}
