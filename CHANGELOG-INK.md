# Changelog — reMarkable Ink Round-Trip

## Unreleased

- **Tables with a full grid:** an outer border, lines between columns and
  under every row, a heavier rule under the header (with a light grey band
  when colour accents are on), and padded cells so no line touches the text.
  Columns no longer break a word they have room for. Notebooks sent earlier
  keep their old tables.
- **Faster, steadier re-sends:** the notebook a re-send replaces is moved to the
  trash in the same cloud update as the upload, halving the writes to the
  account's root index — fewer rate-limit waits and fewer clashes with the
  tablet syncing at the same time. Every landed upload is recorded at once, and
  the sync status shows the running batch (*Uploading 12/80*).
- **A clearer handwriting sheet with more characters:** each box shows its
  character in black at writing size beside the writing space, on the same
  lines — cap (dashed), x-height and descender (dotted) and baseline (solid) —
  so where every part belongs can be read off. New boxes: `[ ] { } < > « »
  „ “ ” ‘ ’ ^ ~ _ | \ $ £ ° … –` and ✓ ✗ → ← ↑ ↓. The word sheet shows each
  word above its lines. A sheet sent before is still read with its own layout.
- **Check marks, crosses and arrows** in a note (✓ ✔ ✗ ✘ → ← ↔ ↑ ↓) are now
  written as such — in your hand once learned — instead of `?` or `->`;
  notebooks sent earlier keep their look.
- **Joined-up handwriting, learned from you:** the built-in reader compares a
  whole word's trace with words you wrote before. It learns from every remark
  text you correct or type in under an image, and from a new **word sheet** of
  everyday German and English words (*Send joined-up word sheet to
  reMarkable*, then *Learn my joined-up words from the sheet*). Only close
  matches are used; unseen joined-up words stay in the image.
- **Built-in handwriting recognition, on by default:** remarks are read from
  their pen strokes inside the plugin — letters matched against your
  handwriting sheet (print letters without one), words corrected against your
  vault's vocabulary, so German and English work without a dictionary. Nothing
  leaves the device; an unsure reading stays image only. The vision-model
  endpoint remains as an option (*Read handwriting with*); an endpoint you had
  switched on keeps being used.
- **Inline styling in handwriting:** bold words are written with a heavier pen,
  italic ones slanted, `~~struck~~` and `<u>underlined</u>` words get a pen line
  through or under them, and `==highlights==` / `<mark style="background: …">`
  a highlighter band in the nearest tablet colour. Words keep their exact
  places, so marks still anchor; notebooks sent earlier replay unchanged. A
  mark made on the tablet now comes back to it styled after the sync.
- **Two-way sync, handwriting only.** Notes are kept in sync with the tablet as
  handwritten notebooks: erased, moved and marked words and handwritten remarks
  are merged into the note itself, and a changed note is re-sent. Edits made on
  both sides merge word by word; where both changed the same words the note
  keeps yours and shows the tablet's in an *Also changed on the reMarkable*
  callout. A backup of the note is saved before tablet changes go in.
- Syncs on startup, every few minutes (*Settings → Sync → Check the reMarkable
  every*) and with **Sync with reMarkable now**. Notes in the sync folders sync
  automatically; any other note joins with *Sync with reMarkable* and stays in.
- **Removed:** PDF and EPUB output, editable-text notebooks and *Get edited text
  back*, *Send … as …* and *choose layout* commands, companion notes and their
  settings, and the separate *reMarkable model* setting (folded into *Notebook
  page size*). Notebooks sent by those routes are re-sent as handwriting on the
  next sync; their unimported annotations are not read any more.
- **Colour accents:** code blocks get a blue highlighter band, inline code a
  pink one and quotes/callouts a yellow one — drawn with the tablet's own
  highlighter, so the text stays on top. Coloured areas in Mermaid diagrams
  (`style`/`classDef` fills, notes, pie slices) are filled with the highlighter
  in their nearest colour instead of hatched, and pale pastel fills now count
  as colour too. Colour shows on the Paper Pro and Move; other models show grey.
- *Settings → Handwriting → Colour accents* (on by default). Recorded per send:
  notebooks sent earlier are regenerated without accents, so their import is
  unchanged.

## 1.2.0 — 2026-10-18

- **Mermaid diagrams drawn by hand:** every ```` ```mermaid ```` block is rendered
  with Obsidian's own Mermaid in a pen-friendly theme, traced into strokes and
  drawn on the page: lines with a slight hand-drawn wobble, arrowheads and
  other markers, labels in your handwriting, coloured areas (pie slices,
  notes, gantt bars) hatched in the tablet's inks. Lines that a box or a label
  covers in the diagram are cut where they pass underneath.
- Flowcharts, sequence, class, state, ER, pie, gantt and mindmap diagrams
  tested against Mermaid 11 output; a diagram that fails to render stays code.
- *Settings → Handwriting → Mermaid diagrams*: drawn by hand (default) or as code.
- The traced diagram is stored with the send, so a Mermaid update never changes
  what the import compares against.

## 1.1.0 — 2026-10-18

- **Pictures as coloured hatching:** images embedded in a note (`![[photo.png]]`,
  `![alt](path)`, including inside embedded notes) are redrawn as hatch strokes
  in the tablet's own inks — blue, red, green, yellow and pink for colour,
  black and grey for tone, crossing passes for darker areas. Grey hatch and the
  old placeholder are the alternatives (*Settings → Handwriting → Pictures*).
- Obsidian size aliases (`![[photo.png|300]]`, `|300x200`) set the drawn size.
- The quantised picture is stored with the send, so the import regenerates the
  exact same strokes even if the image file changes later; erasing part of a
  picture on the tablet is not reported as erased text.
- Fixes from an independent review: newline-safe erase/move in the annotated
  copy, no moves that would split inline markup, highlights on erased words,
  moves recorded without a `move_id`, a guard against pages that cannot be
  reproduced exactly, pinned font versions, nested and marker anchors.

## 1.0.0 — 2026-10-18

First release of the fork, based on reMarkable Round-Trip 0.43.1.

- **Send as handwriting:** notes become notebooks of real pen strokes, laid out
  by the same typesetter as the PDF send. Commands, file menu, and a
  *Handwriting* option for *Send notes as* (folders and the watch folder too).
- **Built-in single-line fonts:** EMS Readability (default), Hershey Sans,
  EMS Allure, Hershey Script; accents and stand-ins composed where a font lacks
  them.
- **Your own handwriting:** send a sheet, fill it in on the tablet, learn it;
  add up to three variations per character from further sheets.
- **Canvas per device:** reMarkable 1/2/Paper Pure, Paper Pro, Paper Pro Move,
  or detected from a notebook made on the tablet.
- **Import understands the ink:** erased words are removed (or struck through),
  lasso-moved words move, freehand highlighter becomes `<mark>`, everything you
  wrote goes through upstream's mark reader.
- **Opt-in OCR** of handwritten remarks via any OpenAI-compatible vision
  endpoint (local Ollama / LM Studio or hosted), image kept alongside by default.
- Pen width, ink colour (Paper Pro/Move) and a "hand-made look" slider.
- The import report gains a handwriting line per note; the log file is now
  `reMarkable Ink Round-Trip log.md`.
