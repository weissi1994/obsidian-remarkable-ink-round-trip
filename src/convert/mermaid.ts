/**
 * Mermaid fences → PNG diagrams (fork feature: image blocks, GP-fork-1).
 *
 * DOM-touching edge module: everything here needs a live document (Obsidian's
 * bundled mermaid measures text via the DOM, and rasterising goes through a
 * canvas). The pure pipeline (mdblocks/pdf) never imports this file — it only
 * consumes the DiagramImage[] this produces, so vitest stays DOM-free and the
 * layout replay at import time (buildLayout) needs no mermaid at all: it
 * substitutes the *recorded* dimensions instead (see mapping.ts `images`).
 *
 * Determinism note: mermaid output is NOT stable across versions, which is
 * why the placed dimensions are recorded per upload rather than re-rendered
 * on import — the same principle as the typo version (GP_E3_S15).
 */

import { loadMermaid } from "obsidian";
import { selfCloseVoidTags } from "./svgxml";

/** One rendered diagram, in fence-occurrence order. Dimensions in PDF points. */
export interface DiagramImage {
	/** Natural width/height in PDF points (px * 72/96). */
	w: number;
	h: number;
	/** PNG bytes to embed; absent when only geometry is replayed (import). */
	png?: Uint8Array;
}

/**
 * Minimal surface of Obsidian's bundled mermaid. `loadMermaid` is a module
 * export of "obsidian", not a global: declaring it ambiently type-checked
 * fine but bundled to a bare identifier, so every render threw a
 * ReferenceError that send.ts swallowed into "no diagrams".
 */
interface MermaidApi {
	render(id: string, text: string): Promise<{ svg: string }>;
}

/** CSS px (96 dpi) → PDF points (72 dpi). */
const PX_TO_PT = 72 / 96;
/** Rasterisation scale: ~3× oversampling for the device's ~226–229 dpi. */
const RASTER_SCALE = 3;

/**
 * Fence scan, mirroring mdblocks' FENCE_RE walk exactly: the n-th source
 * returned here is the n-th `lang === "mermaid"` code block parseBlocks
 * produces, so substituteDiagrams can pair them by order alone.
 */
export function extractMermaidSources(markdown: string): string[] {
	const FENCE_RE = /^(?:```|~~~)/;
	const lines = markdown.split("\n");
	const sources: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].trim();
		if (!FENCE_RE.test(trimmed)) continue;
		const lang = trimmed.replace(/^(?:```|~~~)/, "").trim().toLowerCase();
		const body: string[] = [];
		i++;
		while (i < lines.length && !FENCE_RE.test(lines[i].trim())) {
			body.push(lines[i]);
			i++;
		}
		if (lang === "mermaid") sources.push(body.join("\n"));
	}
	return sources;
}

/**
 * Render every mermaid fence in the (preprocessed) markdown to a PNG.
 *
 * A diagram that fails to render yields `null` in its slot: substitution
 * then leaves that fence as the code block it is today — the pen-friendly
 * failure mode, and byte-identical to pre-fork behaviour.
 */
export async function renderMermaidDiagrams(
	markdown: string,
): Promise<(DiagramImage | null)[]> {
	const sources = extractMermaidSources(markdown);
	if (sources.length === 0) return [];
	const mermaid = (await loadMermaid()) as MermaidApi;

	const out: (DiagramImage | null)[] = [];
	for (let i = 0; i < sources.length; i++) {
		try {
			out.push(await renderOne(mermaid, sources[i], i));
		} catch (error) {
			// Falling back to a code block is right, but silence here cost a
			// release: the failure showed up nowhere but the mapping table.
			console.error(
				`reMarkable Round-Trip: mermaid diagram ${i + 1} did not render, sending it as a code block`,
				error,
			);
			out.push(null);
		}
	}
	return out;
}

async function renderOne(
	mermaid: MermaidApi,
	source: string,
	index: number,
): Promise<DiagramImage> {
	// A per-diagram init directive rather than mermaid.initialize():
	// initialize() reconfigures the instance Obsidian itself renders
	// previews with, and stomping the app's theme from a plugin is exactly
	// the kind of side effect that comes back as a bug report. The
	// directive scopes "neutral" (black-on-white, e-ink friendly) to this
	// one render.
	const themed = `%%{init: {"theme": "neutral"}}%%\n${source}`;
	const { svg } = await mermaid.render(`remarkable-round-trip-mermaid-${index}`, themed);

	const { widthPx, heightPx } = svgSize(svg);
	const png = await rasterise(svg, widthPx, heightPx);
	return { w: widthPx * PX_TO_PT, h: heightPx * PX_TO_PT, png };
}

/** Intrinsic pixel size of a rendered mermaid SVG (viewBox, else width/height). */
function svgSize(svg: string): { widthPx: number; heightPx: number } {
	const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
	const root = doc.documentElement;
	const viewBox = root.getAttribute("viewBox");
	if (viewBox !== null) {
		const parts = viewBox.trim().split(/[\s,]+/).map(Number);
		if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
			return { widthPx: parts[2], heightPx: parts[3] };
		}
	}
	const w = parseFloat(root.getAttribute("width") ?? "");
	const h = parseFloat(root.getAttribute("height") ?? "");
	if (w > 0 && h > 0) return { widthPx: w, heightPx: h };
	throw new Error("mermaid SVG carries no usable size");
}

/**
 * SVG string → PNG bytes via an <img> and a canvas. The SVG travels as a
 * data URL: mermaid inlines its styles into the SVG, so nothing external
 * needs fetching (an SVG loaded through <img> could not fetch it anyway).
 * A white background is painted first — the device page is white, and a
 * transparent PNG over pdf-lib's default renders fine, but an explicit
 * fill keeps dark-theme CSS variables from ever leaking through.
 */
async function rasterise(
	svg: string,
	widthPx: number,
	heightPx: number,
): Promise<Uint8Array> {
	const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(selfCloseVoidTags(svg))}`;
	const image = await loadImage(url);

	// createEl attaches to the right document in popped-out windows — the
	// same reason renderHandwriting uses it.
	const canvas = createEl("canvas");
	canvas.width = Math.max(1, Math.round(widthPx * RASTER_SCALE));
	canvas.height = Math.max(1, Math.round(heightPx * RASTER_SCALE));
	const context = canvas.getContext("2d");
	if (context === null) throw new Error("no 2D canvas available for rendering");
	context.fillStyle = "#ffffff";
	context.fillRect(0, 0, canvas.width, canvas.height);
	context.drawImage(image, 0, 0, canvas.width, canvas.height);

	const blob = await new Promise<Blob>((resolve, reject) => {
		canvas.toBlob(
			(b) => (b !== null ? resolve(b) : reject(new Error("canvas.toBlob produced nothing"))),
			"image/png",
		);
	});
	return new Uint8Array(await blob.arrayBuffer());
}

function loadImage(url: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const image = new Image();
		image.onload = () => resolve(image);
		image.onerror = () => reject(new Error("SVG could not be decoded as an image"));
		image.src = url;
	});
}
