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

## Keeping the note's text — `src/sync/twoway.ts`

Every import re-reads the whole notebook, and the three-way merge base is the
note *as sent*, which has no remarks. Without care, every remark already in
the note would be inserted again on both sides of the merge and conflict.

`settleRemarks(ours, marks)` runs before projecting:

- a remark found in the note is dropped from the marks to place — its
  position and the owner's text win;
- **untouched readings improve:** the edge attaches to each uncorrected
  remark the text the plugin last wrote for it (`mark.replaces`, from
  `withEarlierReadings`). If the callout still shows exactly that and the new
  reading differs (and isn't empty), the callout's text lines are replaced.
  An image-only remark is the case `replaces === ""`. Any other text — the
  owner's, even typed mid-sync — stays;
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
- `knownText`: a *corrected* remark is not read again. Uncorrected remarks
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
