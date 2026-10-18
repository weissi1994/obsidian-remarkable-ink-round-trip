/**
 * The four faces a handwritten send uses, and the options that reproduce a
 * send exactly (ink fork).
 *
 * Everything here is recorded per upload (InkSnapshot) or versioned
 * (INK_SHAPE_VERSION): the import regenerates the strokes it sent and must
 * get the same ones, even after the settings — or this file — changed.
 */

import type { InkSnapshot } from "../id/mapping";
import { GlyphSource, HandFont, builtinFont } from "./glyphs";
import { INK_PENS, InkFonts, InkRenderOptions } from "./inkrender";

/**
 * Renderer behaviour version. Bump whenever stroke generation changes for
 * the same inputs (jitter, resampling, face styles) — and keep the old
 * behaviour reachable by version, as upstream does with TYPO_VERSION.
 */
export const INK_SHAPE_VERSION = 1;

/** The print face code blocks are always written in. */
export const MONO_FONT = "hershey-sans";

/** Glyph source versions a send depends on, in snapshot order. */
export function fontVersionsOf(primary: GlyphSource, fallback: GlyphSource): string[] {
	return [primary.version, fallback.version, builtinFont(MONO_FONT).version];
}

/** Face styles per shape version. */
const FACE_STYLES: Record<number, { boldWeight: number; italicSlant: number; monoAdvance: number }> = {
	1: { boldWeight: 1.3, italicSlant: 0.18, monoAdvance: 0.75 },
};

export function makeInkFonts(
	primary: GlyphSource,
	fallback: GlyphSource,
	shape: number = INK_SHAPE_VERSION,
): InkFonts {
	const style = FACE_STYLES[shape] ?? FACE_STYLES[INK_SHAPE_VERSION];
	// Code stays in a print face whatever the hand: a script `kubectl` helps
	// nobody, and monospace columns need even glyphs.
	const mono = builtinFont(MONO_FONT);
	return {
		body: new HandFont(primary, fallback),
		bold: new HandFont(primary, fallback, { weight: style.boldWeight }),
		italic: new HandFont(primary, fallback, { slant: style.italicSlant }),
		mono: new HandFont(mono, fallback, { monoAdvance: style.monoAdvance }),
	};
}

/**
 * Rebuild the render options of a recorded send. `hand` resolves the owner's
 * handwriting library by version; null when that version is gone.
 */
export function inkOptionsFor(
	snapshot: InkSnapshot,
	seed: string,
	hand: (version: string) => GlyphSource | null,
): InkRenderOptions | null {
	const fallback = builtinFont(snapshot.fallbackFont);
	let primary: GlyphSource;
	if (snapshot.font === "hand") {
		const library = snapshot.hand === undefined ? null : hand(snapshot.hand);
		if (library === null) return null;
		primary = library;
	} else {
		primary = builtinFont(snapshot.font);
	}
	// The shapes must be the ones the send was written with, or the import
	// would compare the page against different letters.
	const versions = [primary.version, fallback.version, builtinFont(MONO_FONT).version];
	if (
		snapshot.fontVersions !== undefined &&
		snapshot.fontVersions.some((version, index) => version !== versions[index])
	) {
		return null;
	}
	const pen = { ...(INK_PENS[snapshot.pen] ?? INK_PENS.medium), color: snapshot.color };
	return {
		profile: snapshot.profile,
		fonts: makeInkFonts(primary, fallback, snapshot.shape),
		pen,
		jitter: snapshot.jitter,
		seed,
		imageStyle: snapshot.imageStyle,
	};
}
