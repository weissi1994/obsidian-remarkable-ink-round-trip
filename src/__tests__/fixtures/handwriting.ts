/**
 * Labelled handwriting samples for calibrating the $P letter reader's trust
 * threshold (`OCR_TRUST` in src/ocr/recognize.ts).
 *
 * Strokes are generated deterministically from the bundled fonts by the
 * `write(text, font, jitter)` helper in recognize.test.ts (seeded on the
 * text), so a sample only needs its parameters — not a raw stroke dump. This
 * keeps the fixture small and diffable while still regression-testing the
 * calibration against a *set* per class, not a single point.
 *
 * `kind` is the ground truth the reader must respect:
 *  - "print"   — separate print letters the reader should read confidently
 *                (confidence must stay ABOVE OCR_TRUST).
 *  - "cursive" — joined-up writing the segmenter mis-cuts into junk; the
 *                reader must fail safe to the image (confidence BELOW
 *                OCR_TRUST) instead of leaking garbage text.
 *
 * The confidences in the comments are the values observed on this code at the
 * time of calibration (vitest, Node 24, jitter 0.5). They are deterministic
 * for a given seed, so they double as a regression baseline: the set's print
 * minimum (~0.83) and cursive maximum (~0.74) are what fix OCR_TRUST ≈ 0.78.
 */

export type HandwritingKind = "print" | "cursive";

export interface HandwritingSample {
	/** Text rendered in `font` and read back by `recognize`. */
	text: string;
	/** Bundled font id (see src/ink/glyphs.ts). */
	font: string;
	/** Jitter passed to the `write` helper. */
	jitter: number;
	/** Ground truth: print should read confidently, cursive should fail safe. */
	kind: HandwritingKind;
}

/**
 * Print: separate letters in print fonts. These must read with confidence
 * ABOVE OCR_TRUST — the reader is doing its job. Lowest observed is the
 * hershey-sans "update the spreadsheet now" case at ~0.83, which is what
 * bounds how high OCR_TRUST may safely go.
 */
export const PRINT_SAMPLES: HandwritingSample[] = [
	{ text: "Check this again tomorrow", font: "readability", jitter: 0.5, kind: "print" }, // ~0.971
	{ text: "Please review the draft", font: "readability", jitter: 0.5, kind: "print" }, // ~0.972
	{ text: "Bitte noch einmal prüfen", font: "readability", jitter: 0.5, kind: "print" }, // ~0.961
	{ text: "Größe und Länge stimmen nicht", font: "readability", jitter: 0.5, kind: "print" }, // ~0.956
	{ text: "meeting is on Monday", font: "hershey-sans", jitter: 0.5, kind: "print" }, // ~0.968
	{ text: "send this to the team", font: "hershey-sans", jitter: 0.5, kind: "print" }, // ~0.983
	{ text: "update the spreadsheet now", font: "hershey-sans", jitter: 0.5, kind: "print" }, // ~0.831 (set min)
];

/**
 * Cursive: joined-up writing the segmenter mis-cuts. These must read with
 * confidence BELOW OCR_TRUST and must NOT return the correct text — the junk
 * (`"C%% @w mm %mmm"` etc.) is what the old 0.65 threshold leaked. Highest
 * observed is the hershey-script "we should talk soon" case at ~0.74, which is
 * what bounds how low OCR_TRUST may safely go. Note hershey-script leaks
 * markedly higher than allure, so a single allure point (the old test) never
 * exercised the real tail.
 */
export const CURSIVE_SAMPLES: HandwritingSample[] = [
	{ text: "Check this again tomorrow", font: "hershey-script", jitter: 0.5, kind: "cursive" }, // ~0.669 (the documented leak @0.65)
	{ text: "Please review the draft", font: "hershey-script", jitter: 0.5, kind: "cursive" }, // ~0.615
	{ text: "send this to the team", font: "hershey-script", jitter: 0.5, kind: "cursive" }, // ~0.725
	{ text: "we should talk soon", font: "hershey-script", jitter: 0.5, kind: "cursive" }, // ~0.739 (set max)
	{ text: "the quick brown fox jumps", font: "allure", jitter: 0.5, kind: "cursive" }, // ~0.527
	{ text: "meeting is on Monday", font: "allure", jitter: 0.5, kind: "cursive" }, // ~0.200
];

/** The whole labelled set, both classes. */
export const HANDWRITING_SAMPLES: HandwritingSample[] = [...PRINT_SAMPLES, ...CURSIVE_SAMPLES];

/** The specific sample that leaked junk above the old OCR_TRUST=0.65 (the red-gate case). */
export const LEAK_SAMPLE: HandwritingSample = CURSIVE_SAMPLES[0];
