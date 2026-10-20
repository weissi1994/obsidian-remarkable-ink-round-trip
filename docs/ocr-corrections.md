# Handwriting corrections: how they are kept and learned from

How a remark's text, once corrected in Obsidian, survives later imports and
improves reading. User-facing summary: README → *Correcting what was read*.

## Remark identity — `src/incoming/remarkid.ts`

- `remarkId(strokes)`: 12 hex digits, FNV-1a over the strokes' rounded device
  coordinates. Same ink → same id on every import; independent of the remark's
  position on the page. Ink that was added to becomes a new remark.
- The id names the image (`<deviceDocId>-p<page>-<id>.png`) and ends the
  callout as a block id line, `> ^ink-<id>` (`remarkIdLine`). An image under
  the pre-id name `…-p<page>-<n>.png` is reused while its stored ink
  (`reMarkable/.sync/ink/`) is identical, so older notes don't change
  (`main.ts` → `remarkImagePath`).
- `findRemark(note, {id, image})` finds a remark's block by id line (or by
  image, for notes from before ids) and returns its text: quoted lines other
  than the callout title, image and id line.

## Where a remark is placed — `src/incoming/sourceprojection.ts`

A remark is anchored to the source line of the printed row it was written
against (`anchorLine`), then moved to the end of that line's block
(`blockEnd`): the closing fence of a code block, else the end of the run of
non-blank lines (table, callout, paragraph), carried across blank lines while
a list continues. It is inserted with a blank line before and after, so it
never splits a block or absorbs the lines after it.

## Back on the tablet — where it was written

With *Settings → Handwriting → Handwritten remarks* on **Ink where I wrote
it** (the default), a remark goes back to the tablet as its ink alone, at the
spot it was written — not as a callout with a title and typeset text.

1. **Import** (`incoming/marks.ts` `groupNotes`): besides the quote, a note
   mark records `at = { text, x, below }` — the text of the row it was quoted
   from, its left edge in points, and how far its top sits under that row's
   baseline. It travels in the render request (`StrokeRenderRequest.at`)
   into the remark's stroke record (`reMarkable/.sync/ink/<image>.json`,
   `InkStrokes.at`).
2. **Send** (`preprocess/preprocess.ts` `remarksInPlace`): the embed map
   flags a remark image whose stroke record has `at` (`inPlace`). Its whole
   callout — title, text, image, id — becomes one `*[remark: <image>]*` line.
   Any other remark callout is sent as before, minus its `^ink-` line, which
   was written onto the page as stray text until now.
3. **Render** (`ink/inkrender.ts`): the placeholder becomes an `inkoverlay`
   block. The typesetter (`convert/pdf.ts`) gives it no room and no layout
   line; it only reports the cursor (`drawOverlay`). `overlayPlacements`
   then looks for the nearest row before it whose text is `at.text` and puts
   the ink at the recorded offset — so it follows its line when text above
   it grows or shrinks. When that row is gone (the line was edited) the ink
   goes right under the text it follows. It is clamped onto the page. A
   remark whose position was never recorded is drawn in the flow at its
   natural size instead.
4. **Re-import**: the redrawn ink is the plugin's own (author 1, regenerated
   from the stored send), so it is not read as a new remark. The layout lists
   the remarks it drew in place (`PdfLayout.remarksInPlace`); the projection
   steps over their callouts in the note (`hiddenRemarks`), which are no
   longer on the page and would otherwise break the word alignment.

Limits: only remarks imported from this version on have a recorded place —
older ones stay callouts on the tablet (their original ink is no longer in
the notebook to measure). Erasing or lasso-moving a redrawn remark on the
tablet changes nothing in the note; the next send draws it where it was.

## Keeping the note's text — `src/sync/twoway.ts`

Every import re-reads the whole notebook, and the three-way merge base is the
note *as sent*, which has no remarks. Without care, every remark already in
the note would be inserted again on both sides of the merge and conflict.

`settleRemarks(ours, marks)` runs before projecting:

- a remark found in the note is dropped from the marks to place — its
  position and the owner's text win;
- **untouched readings improve, when clearly better:** the edge attaches to
  each unverified remark the text the plugin last wrote for it
  (`mark.replaces`, from `withEarlierReadings`) — but only if the new reading
  `isBetterReading` than the one the note shows, or the callout is empty
  (`replaces === ""`). If the callout still shows exactly that text, isn't
  confirmed, and the new reading differs, its text lines are replaced. Any
  other text — the owner's, even typed mid-sync — stays;
- a pre-id callout gets its `^ink-` line.

The summary-block form (no merge base) rewrites the whole block, so there the
marks take the note's text unless it is the untouched earlier reading
(`withNoteTexts`). Both forms return `refreshed` ids; the count goes into the
import report (`rereadRemarks`).

After the note is written, `notedReadings` sets each uncorrected record's
`transcript` to what the note now shows — only where that equals the reading
the plugin placed, so an edit made during the sync is still detected as a
correction on the next one.

Tests: `src/__tests__/remarkkeep.test.ts`.

## Scores — when is a new reading better?

Each reading is stored with its reader (`builtin`, `writepad`, `endpoint`)
and a score: `scoreAbove(confidence, cutOff)` = how far the reader's
confidence sits above that reader's own acceptance threshold, 0–1
(`OCR_TRUST` 0.65 for built-in, `WRITEPAD_TRUST` 0.7). That makes the two
local readers comparable. `isBetterReading(old, new)`:

- new reading has no score (vision endpoint) → never better;
- old reading has a score → new must beat it by `BETTER_BY` (0.1);
- old reading has none (stores from before scores, endpoint) → new must
  reach `SURE_ENOUGH` (0.5).

Record fields: `score`/`by` belong to the text the note shows, `readScore`/
`readBy` to the latest reading; `notedReadings` moves the latter into the
former once the note shows the new reading.

## Confirming — ✓

A remark is confirmed when its callout title (or, in the summary block, its
first line) ends in `✓` (`CONFIRM_MARK`). A ✓ inside the text — handwriting can
contain one — doesn't count. `learnFromNotes` copies it into
`record.confirmed` each sync (removing the ✓ un-confirms); a newly confirmed
reading teaches its words like a correction. Confirmed and corrected records
are *verified* (`isVerified`): never re-read, never replaced (also guarded in
`settleRemarks` against a ✓ added mid-sync), kept under the larger pruning
limit, and used as worked examples and training samples.

## In-note UI — `src/remarkui.ts`

A markdown post-processor adds ✓ (confirm) and ✎ (correct) buttons to the
title of every rendered remark callout. Block ids are hidden when rendered,
so the callout is matched by its source line (`getSectionInfo` →
`remarkAt`), or — in live-preview widgets where that is missing — by its
image. Buttons only edit the note (`confirmRemarkAt`, `setRemarkTextAt` via
`vault.process`), the same as typing; the next sync learns from it. ✎ opens a
modal with the ink image and a textarea (Save / Save and confirm ✓).
Commands: confirm / correct at cursor, confirm all in note (edited through the
editor, so undo works).

Tests: `remarkui.test.ts` runs in happy-dom against
`src/__tests__/helpers/obsidian.ts`, a stand-in for the types-only
`obsidian` package (aliased in `vitest.config.ts`).

## Insert as text — `src/incoming/remarkinsert.ts`

⤵ (button, editor, command) → `main.ts` `insertRemark`:

1. Text = the callout's text in the note now. `highlightedText` adds
   highlighter: at import, highlighter strokes that cover no printed words but
   overlap a remark are kept with it (`inkpull.ts` `highlightsOver` →
   `record.inkHighlights`, separate from the pen strokes, so id and OCR are
   unaffected). Ink words (`splitWords`) are paired with text words as in
   `learnCorrection`; a word counts as highlighted when a swipe covers half its
   width. Runs of same-colour words become `<mark style="background: rgb">`,
   the markup `sourceprojection.ts` gives imported highlights. No pairing →
   ≥ 80 % highlighted marks the whole text, else no highlight (`placed:false`,
   notice).
2. `insertRemarkText(note, id, text, {quote, column})` removes the callout,
   finds the anchor line — nearest line above holding the quote's first words
   (`record.quote`) — and places the text by the anchor's block: table row →
   cell `column` (from `tableColumnUnder` at import: the column whose cell text
   starts left of the ink's middle, among the table rows it overlaps; a table
   line's `level` is its row), `<br>` for line breaks, `\|` escaped; quote /
   callout → a line after the anchor with the same `>` prefix; list item → new
   sibling item (numbered +1, task → plain); code fence / paragraph →
   paragraph after the block; anchor not found → paragraph where the callout
   was.
3. `acceptRemark`: confirmed (+ corrected and learned from if changed),
   `inserted: true` — `withEarlierReadings` then drops the remark from every
   later import, so the callout never comes back. A remark with no record
   (OCR off) gets a stub record for that.

## Sample store — `src/ocr/samples.ts`

Stored in the vault's shared sync state (`ocr/samples.json` via
`SyncState.writeSamples`). `remarks` is keyed by remark id (image path in
stores from before ids):

| field | meaning |
|---|---|
| `strokes` | the ink, device units, rounded |
| `transcript` | the text the note has; the owner's once `corrected` |
| `read` | the reader's latest output |
| `corrected` | set when the note's text differed from `transcript` at a sync |
| `image`, `note` | where to find it again |
| `quote`, `wholePage` | the reading context, reused by the training export |

- `rememberRemark` never overwrites a known remark's `transcript` (that
  follows the note, via `notedReadings`); it updates `read`.
- `knownText`: a *verified* (corrected or confirmed) remark is not read again. Uncorrected remarks
  are re-read whenever their notebook changes (with a vision endpoint: one
  request each, per changed notebook).
- Records from before ids (keyed by image path) are never matched to marks,
  so they never get `replaces`: corrections made before the `corrected` flag
  existed are not overwritten.
- `learnFromNotes` (start of each sync): compares each remark's text in its
  note with `transcript`; a difference is a correction → word samples via
  `learnCorrection`, `corrected = true`. Corrections whose words can't be
  paired with the ink are returned as `unlearned` and shown in a notice.
- Pruning keeps 500 never-corrected and 2000 corrected remarks, newest first.

## Learning per reader

| reader | how corrections help |
|---|---|
| Built-in letters/words | word samples from corrections (`WordReader`) |
| WritePad | corrected words enter the vault, hence its lexicon |
| Vision endpoint | latest N corrections sent as prior user/assistant turns (`transport/ocr.ts`, setting `ocrExamples`) |

## Training export — `src/ocr/trainingset.ts`

Command *Export handwriting corrections as training data* →
`<handwriting folder>/training/`:

- `images/<id>.png`
- `dataset.jsonl` — `{"messages":[{"role":"user","content":"<image>PROMPT"},{"role":"assistant","content":TEXT}],"images":["images/<id>.png"]}`
- `dataset_info.json` — registers it as `remarkable_handwriting` (sharegpt formatting)

The prompt is `ocrPrompt` with the remark's own context, identical to reading
time. To fine-tune, copy the folder into LLaMA-Factory's `data/` (or point
`dataset_dir` at it) and train e.g. a LoRA on a Qwen2.5-VL base; serve the
result through any OpenAI-compatible server and set it as the endpoint model.
Whether a given server (e.g. Ollama) can load a LoRA adapter for a vision
model depends on that server and model — merging the adapter into the base
weights before serving avoids the question.

## Handwriting test — `src/ocr/testcapture.ts`

Measures the readers on the owner's real hand (#14). Training and
measuring are kept apart.

- **Sheet**: `buildSheet(profile, "test", TEST_SHEET_VERSION)`
  (`src/ink/handsheet.ts`), one prompt per row from `TEST_SHEET_PROMPTS`. It
  is pending as `pendingTestSheet` (`kind: "test"`) and shared in
  `.sync/handwriting.json`. A file written before the test sheet existed reads
  as none pending. To change the prompts, bump `TEST_SHEET_VERSION` and keep
  the old list, so a sheet already on a tablet still reads back.
- **Held out, never learned from.** *Save handwriting test sheet to the vault*
  calls `recognize(…)` and `WritePad.read(…)` directly. It never goes through
  `recognizeLocally`, `rememberReading` or `addSample`, so nothing reaches the
  sample store, the word reader or the worked examples. The endpoint is
  asked with **no** worked examples. A sheet the readers trained on could no
  longer measure them. If a "learn from this test sheet" is ever added, it
  must say so.
- **Readings** are what the plugin would read at import, with the vault's words.
  Each is kept with `accepted` (above `OCR_TRUST` / `WRITEPAD_TRUST`) even when
  it was not accepted. When WritePad's known-word gate drops a reading, the
  reading without the vault's words is stored, marked not accepted. An
  endpoint error is stored as `null`; a reader that wasn't run has no key.
- **CER** is `cer(got, want)`, edit distance over the prompt's length.
  Per item, whitespace is collapsed first (`itemCer`), so a line that ran onto a
  second row is not counted as misread.

Output, under `<handwriting folder>/test-sheets/<YYYY-MM-DD-HHmmss>/`:

- `handwriting-test-<stamp>.json`: the capture, the one file to attach.
- `p<page>-<row>.png`: each line's ink.
- `Handwriting test <stamp>.md`: readings, CER per line and per reader, the ink.

Capture format (`format: "remarkable-ink-handwriting-test"`, `version: 1`):

| field | |
|---|---|
| `createdAt`, `pluginVersion` | when and by which build |
| `sheet` | `{ kind: "test", version }`: the `TEST_SHEET_VERSION` it was sent with |
| `profile` | canvas `{ width, height, dpi }`, enough to rebuild the boxes |
| `hand` | the `HandLibrary` in use (letters from the handwriting sheet), or `null` |
| `items[]` | `{ id: "p1-03", prompt, box, strokes, readings }` |
| `strokes[]` | `{ tool, color, thicknessScale, points }`, where `points` is flat x, y, width, pressure in device units |
| `readings` | `{ builtin?, writepad?, endpoint? }`, each `{ text, confidence?, accepted }` or `null` |

**Privacy:** the capture holds the prepared prompts, the owner's ink of them,
the hand library (already shared in `.sync`) and the readings. It holds no
vault lexicon, no `samples.json` word samples or remarks, and no note paths or
remark texts.

**Replay** an attached capture with today's readers:

```
HANDWRITING_CAPTURE=path/to/handwriting-test-<stamp>.json npx vitest run src/__tests__/testcapture.test.ts
```

It prints, per reader, the captured CER next to the replayed CER, then every
line. Replay has no vault words, no word samples and no letters learned from
corrections, because none of them are in the file. It uses the built-in
reader's templates from `capture.hand`, falling back to print letters. So the
replayed number measures the readers alone, and the captured one is what the
owner saw. Replay asserts only that the file parses, not how accurate the
readers are. To make a synthetic capture for trying it out:
`HANDWRITING_CAPTURE_OUT=/tmp/capture.json npx vitest run src/__tests__/testcapture.test.ts`.
