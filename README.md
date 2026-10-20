# reMarkable Ink Round-Trip

Keep your Obsidian notes in **two-way sync** with your reMarkable — as **real
handwriting**. Notes arrive on the tablet as pen strokes, in a single-line font or
your own hand. Erase a word, lasso it elsewhere, strike it through, circle it,
highlight it, write between the lines: the next sync merges it into the note
itself. Change the note in Obsidian and the notebook is rewritten. Start a
notebook on the tablet and it becomes a note.

A fork of [reMarkable Round-Trip](https://github.com/maxonamission/obsidian-remarkable-round-trip)
by Max Kloosterman, which sends notes as PDF for review and imports the
annotations into a companion note. This fork has one way in and out — ink — and
writes what you did on paper back into the note you wrote.

## Getting started

1. **Install.** Copy `main.js`, `manifest.json` and `styles.css` into
   `<vault>/.obsidian/plugins/remarkable-ink-round-trip/` and enable
   *reMarkable Ink Round-Trip* under *Settings → Community plugins*. It has its own
   id, so it can sit next to the original plugin.
2. **Pair** under *Settings → Connection* with a one-time code from
   [my.remarkable.com](https://my.remarkable.com/device/browser/connect) — or
   toggle *Self-hosted endpoint* for [rmfakecloud](https://ddvk.github.io/rmfakecloud/).
3. **Pick your canvas** under *Settings → Handwriting → Notebook page size*
   (reMarkable 1/2/Paper Pure, Paper Pro, Paper Pro Move). Not sure? Run
   **Detect reMarkable page size from my notebooks**.
4. **Choose what syncs** under *Settings → Sync*: turn on *Sync folders* and list
   the vault folders, e.g. `Projects, Tasks`. Any other note joins with
   right-click → **Sync with reMarkable** and stays in sync from then on.
5. **Work on either side.** The plugin syncs when Obsidian starts, every few
   minutes (*Check the reMarkable every*) and when a note in a sync folder you
   changed has been quiet for a moment. **Sync with reMarkable now** does it at
   once.

Optional, and worth it: fill in the [handwriting sheet](#your-own-handwriting)
so notes come in your own hand and the built-in reader knows your letters.

## How the two-way sync works

On every sync the plugin first reads the notebooks back, then sends what changed:

1. **Tablet → note.** Each notebook is compared with the strokes the plugin
   wrote (it regenerates them exactly, from the text it kept at send time), so
   your ink and its own letters are never confused. What you did is projected
   onto the note as it was sent and **merged three ways** with the note as it
   reads now — so edits you made in Obsidian meanwhile survive. Within a
   paragraph the merge goes word by word; only where both sides changed the same
   words does the note keep yours, with the tablet's version in an
   *Also changed on the reMarkable* callout right below. Before anything goes
   in, the previous version of the note is saved to the backup folder.
2. **Note → tablet.** Every note in the sync folders, or with a notebook
   already, that is new or changed is written into a fresh notebook. Its old
   notebook is read first — so no ink is lost — and moved to the tablet's trash
   in the same cloud update.
3. **New notebooks from the tablet.** A notebook you started in the device
   folder of a synced vault folder (on the tablet: the folder under *Obsidian*
   named like the vault folder) becomes a note there — each page's ink as an
   image with its text as read — and is sent back as a handwritten notebook in
   place of the original. From then on it syncs like any other note. A notebook
   changed in the last ten minutes is left alone, so it is never swapped out
   while you are still writing in it.

| On the tablet | In the note |
|---|---|
| **Erase** a word | The word is removed (or struck through — *A word you erase … becomes*) |
| **Move** words with the lasso | The words move to where you dropped them |
| A line **through** words | `~~struck~~` |
| A line **under** words | `<u>underlined</u>` |
| A **loop around** words | `**circled**` |
| A **bar in the margin** | The lines it ran along, as a `>` quote |
| The **highlighter** over words | `<mark>` in the colour you used |
| A **tick** in a drawn checkbox / a **stripe** through it | `- [x]` / `- [-]` |
| **Handwriting** between the lines or in the margin | A remark callout with the image — and its text (see [OCR](#reading-handwriting)); sent back, it is your original strokes again, where you wrote them |
| A **page you added** | The whole page as a remark, after the text it follows |

What the three inline marks become is yours to choose (*Settings → What a pen
mark becomes*): strikethrough, bold, italic, underline, highlight or nothing. A
mark written into the note comes back to the tablet styled the same way, so the
round trip stays stable.

Every run that did something writes a report to `reMarkable Ink Round-Trip log.md`:
what was read, what went into which note, and what was sent.

## What a note looks like on the tablet

The note is typeset on a fixed page grid — headings, lists, task boxes you can
tick, quotes, tables, code — and every word is written as pen strokes.

- **Inline styling** without moving a word: **bold** with a heavier pen, *italic*
  slanted, `~~strike~~` and `<u>underline</u>` as pen lines, `==highlight==` and
  `<mark style="background: …">` with the highlighter in the nearest tablet colour
  — in table cells too.
- **Colour accents** (*Settings → Handwriting → Colour accents*): light blue
  behind code blocks, pink behind inline code, yellow behind quotes and
  callouts, light grey behind table headers — the tablet's own light highlighter
  tints, so text stays readable.
- **Tables** in a full grid: border, column and row lines, a heavier rule under
  the header, padded cells, and no column so narrow that a word has to break.
  Empty rows become boxes to write in.
- **Your handwritten remarks** come back as your own strokes, where you wrote
  them, beside the line you wrote them against — the callout, its title and its
  text stay in Obsidian. If that line was rewritten, the ink goes right under
  the text it followed. (*Settings → Handwriting → Handwritten remarks →
  Callout with text* sends the callout instead; remarks read before this
  version are always sent that way.)
- **Pictures** (`![[photo.png]]`, `![alt](path)`) are redrawn as hatching in the
  tablet's inks — blue, red, green, yellow, pink, plus black and grey for tone.
  An Obsidian size alias (`![[photo.png|300]]`) sets the width.
- **Mermaid diagrams** are rendered with Obsidian's own Mermaid in a pen-friendly
  theme and traced into strokes: lines with a slight hand-drawn wobble, labels in
  your handwriting, coloured areas filled with the highlighter (hatched with
  colour accents off). Flowcharts,
  sequence, class, state, ER, pie, gantt and mindmap diagrams are tested.
- **Symbols** ✓ ✗ → ← ↔ ↑ ↓ are written as such, in your hand once learned.
- Colour shows on the Paper Pro and Move; other models show it in grey.

Layout presets (*Easy reading*, *Fill-in form*, *Compact*, or your own sizes)
and page breaks (smart: a section moves to a new page only when it would be
split; or before every `#` / `##`; `\pagebreak` always works) are under
*Settings → Page layout*.

## Your own handwriting

1. Run **Send handwriting sheet to reMarkable** (or the button under
   *Settings → Handwriting*). A notebook of boxes arrives: letters, digits,
   ä ö ü ß, punctuation, brackets (`[ ] { } < > « » „ “ ”`), symbols
   (`^ ~ _ | \ $ € £ ° @ # % & * + =`) and ✓ ✗ → ← ↑ ↓.
2. Each box shows its character on the left, at writing size, on the same lines
   you write on: cap line (dashed), x-height (dotted), baseline (solid),
   descender (dotted). Copy it in the space to its right; skip any you like.
   The page opens on its own layer, *Your handwriting*, above the boxes: erase
   a slip freely, the boxes stay.
   Accented letters (é, à, ç…) need no box — they are written as your own base
   letter with the accent added.
3. Let it sync, then run **Learn my handwriting from the sheet**. From then on
   notes are written in your letters.
4. Optional: fill in a fresh sheet and run **Add handwriting variations from the
   sheet** — up to three samples per character, used in turn.

Without a sheet, four bundled single-line fonts are available: Readability
(clean print, the default), Hershey Sans, Allure and Hershey Script. Code is
always written in Hershey Sans. See [FONTS-LICENSE.md](FONTS-LICENSE.md).

## Reading handwriting

Remarks come back as an image of your ink and — when they can be read — as text
(*Settings → Reading handwriting → Read handwriting with*):

- **Built-in** (default): reads the pen strokes themselves, inside the plugin — no
  model, no download, nothing sent anywhere, mobile included. Letters are matched
  against your handwriting sheet (or print letters without one), words against
  the words in your vault, so German, English and your own names and jargon are
  covered without a dictionary. **Joined-up writing** is read word by word
  against words you wrote before. It learns them two ways:
  - **From corrections:** fix the text of a remark in the note — or type what it
    says under one that came back as an image only — and the next sync learns
    those words from that ink (see [Correcting what was read](#correcting-what-was-read)).
  - **From the word sheet:** **Send joined-up word sheet to reMarkable**, write
    each everyday German and English word once the way you usually write, then
    **Learn my joined-up words from the sheet**.

  What the letter reader is unsure of goes to
  [WritePad](https://github.com/phatware/WritePad-Handwriting-Recognition-Engine),
  a handwriting engine made for joined-up writing that is built into the plugin
  (WebAssembly, with its English and German dictionaries). It reads the remark in
  both languages, prefers your vault's spelling among its close alternatives, and
  keeps the language that reads best.

  A reading it is unsure of stays image only rather than come back as a wrong
  guess.
- **Vision model endpoint**: any OpenAI-compatible vision model — local (Ollama,
  LM Studio) or hosted. Only the cropped remark images are sent there, never the
  note — plus, as worked examples, your latest corrected remarks (*Worked
  examples from your corrections*, 3 by default, 0 for none). First time? On
  desktop, *Set up local reading for me* finds a local Ollama, downloads the
  model (after asking) and fills the settings in; otherwise see the
  [endpoint setup guide](docs/ocr-endpoint-setup.md).
- **Off**: images only.

### Correcting what was read

Every remark callout ends in a hidden block id, `^ink-<id>` — a hash of the
remark's ink, which also names its image. Link to it like any block
(`[[Note#^ink-3f9a2c1b0d4e]]`).

```
> [!note] Remark
> what was read — edit this
> ![[reMarkable-in/handwriting/<notebook>-p01-3f9a2c1b0d4e.png]]
> ^ink-3f9a2c1b0d4e
```

Each remark callout has two buttons in its title:

- **✓ Confirm**: the reading is right. Adds ✓ to the title (typing ✓ at the
  end of the title does the same).
- **✎ Correct**: opens the ink next to its text — fix it, then **Save**,
  **Save and confirm ✓** or **Insert as text**.
- **⤵ Insert as text**: the text goes into the note where you wrote it, and
  the callout goes:
  - in a **table**, into the cell under the ink (line breaks become `<br>`);
  - in a **callout or quote**, as a line right after the one you wrote next to;
  - next to a **list item**, as a new item after it;
  - next to a **code block** or **paragraph**, as a paragraph after it.

  Words you went over with the **highlighter** on the tablet come back
  highlighted, in the same `<mark>` (in the tablet's colour) a highlight on
  printed text gets. If the text and the ink can't be matched word by word,
  a remark highlighted almost entirely is marked as a whole; otherwise the
  highlighting is left out and a notice says so.
- **Faded ink on the text**: until you ✓ Confirm it or Insert it as text, a
  remark's ink is also drawn half-transparent over the note, roughly where you
  wrote it beside the printed line — in reading view and in the editor. It is
  only a picture (the note is unchanged, the text under it stays selectable)
  and disappears once the remark is confirmed or inserted. Turn it off with
  **Show unconfirmed remarks on the text** under Handwriting.

The same as commands: **Confirm handwriting reading at cursor**, **Correct
handwriting reading at cursor**, **Insert handwriting reading as text at
cursor**, **Confirm all handwriting readings in this note**. Or simply edit the text in the callout (keep the id line). Either way,
from then on the text is yours:

- **Later syncs keep it.** The notebook is read again on every import, but a
  remark the note already has is never placed again — your text, and where you
  moved the callout, stand.
- **Readings you never touched improve — only when clearly better.** A
  remark whose text is still exactly what the plugin wrote is read again
  whenever its notebook changes. The new reading replaces the old one only if
  the reader is clearly surer of it than of the old one (scores are compared
  relative to each reader's own threshold); a different reading with about the
  same certainty doesn't swap a right one for a fluke. A vision endpoint gives
  no certainty, so its readings only fill in image-only remarks. The import
  report counts replaced readings; the note's previous version is kept as usual.
- **Confirmed or corrected remarks are final**: never read again, never
  replaced. A confirmed reading also teaches the built-in reader its words, and
  goes into the worked examples and the training export as a known-correct
  sample.
- **The reader learns from it.** The built-in reader stores the words with your
  ink; the vision endpoint gets your latest corrections as worked examples. A
  correction whose words can't be matched to the ink one by one (a different
  number of lines or words) teaches the built-in reader nothing — a notice
  says which, and it still counts as a correction.
- **Train a model on it:** **Export handwriting corrections as training data**
  writes `<handwriting folder>/training/` — `images/`, `dataset.jsonl` and
  `dataset_info.json` in the format [LLaMA-Factory](https://github.com/hiyouga/LLaMA-Factory)
  reads — to fine-tune a vision model on your hand outside the plugin. See
  [docs/ocr-corrections.md](docs/ocr-corrections.md).

### Test how well your handwriting is read

To find out how well each reader reads *your* hand, or to report that it doesn't:

1. Run **Send handwriting test sheet to reMarkable** (or *Send* under
   *Settings → Handwriting → Handwriting test*). A notebook of 18 short German
   and English lines arrives, with dates, numbers, punctuation and a few names.
2. Copy each line once, under it, the way you normally write, joined-up if that
   is how you write. Don't tidy it up. Skip any you like.
3. Let it sync, then run **Save handwriting test sheet to the vault**. Every
   line is read by today's readers (built-in, WritePad, and the vision endpoint
   when that is your reader). This **learns nothing**: the test only measures.
   The result lands in `<handwriting folder>/test-sheets/<date-time>/` and opens
   as a note. It shows each line's readings with their character error rate
   (CER), the mean CER per reader, and your ink.
4. To report it, attach `handwriting-test-<date-time>.json` from that folder to
   the issue. It holds the prepared lines, your ink of them, the letters learned
   from your handwriting sheet, and the readings. It holds nothing else from
   your vault: no notes, note names, remark texts or vault words.

The sheet stays on the tablet, so you can write more lines and save again. Each
save makes a new folder.

## Several copies of the vault

What ties a note to its notebook — which notebook it is, the text it was written
from, your learned handwriting and word samples — lives in the vault itself, in
`reMarkable/.sync/` (*Settings → Sync → Shared sync state folder*): one small file
per note, pictures stored once by their content. Sync the vault with git,
Obsidian Sync or Syncthing and every copy knows what the others sent — none sends
duplicates, and each can bring back what you did on the tablet. Notebooks written
by any copy are recognised by their pages, so they are never brought in as new.
A hand learned on one copy is the hand every copy writes and reads with, a sheet
sent from one can be read back on another, and joined-up words and corrections
learned anywhere are merged, never overwritten. Your pairing token and device settings stay in the plugin's own data.

Turn **Sync automatically from this device** off on all but one copy: two copies
syncing at once could both send a note changed before the vault sync carried
their state across. The others sync when you run **Sync with reMarkable now**.

## Commands

| Command | What it does |
|---|---|
| Sync with reMarkable now | Read the tablet back, bring in new notebooks, send what changed |
| Sync current note with reMarkable | The same for one note (also right-click on notes, folders and selections) |
| Re-read current note from reMarkable | Read its notebook again even when the tablet reports no change |
| Re-send every synced note to reMarkable | Rewrite all notebooks, e.g. after an update that changes how they look |
| Show sync status | Queue, running batch (*Uploading 12/80*), tracked notes |
| Check reMarkable cloud status (read-only) | Diagnose the connection |
| Send handwriting sheet / Learn my handwriting / Add handwriting variations | Your letters |
| Send joined-up word sheet / Learn my joined-up words | Your joined-up writing |
| Send handwriting test sheet / Save handwriting test sheet to the vault | Measure how well your handwriting is read; learns nothing |
| Detect reMarkable page size from my notebooks | Read the canvas from a notebook made on the tablet |

## How it works

The typesetter lays the note out on a page grid matching the tablet's canvas and
records where every word lands. Its drawing calls are recorded and turned into
pen strokes from single-line glyphs, written as a v6 `.rm` notebook — the format
the tablet writes for its own notebooks, following
[rmscene](https://github.com/ricklupton/rmscene). Every stroke carries its own id
under the plugin's own author. When a page comes back, the plugin regenerates
its strokes — deterministically, jitter included — and compares: a stroke with
its id and shape is untouched; a new stroke whose `move_id` points at one of its
own is a lasso move; a new stroke lying along one of its own that disappeared is
what the eraser left; everything else is yours and goes to the mark reader.
Missing ink is summed per word: mostly gone means erased, mostly elsewhere means
moved.

Everything a send depends on — fonts, handwriting version, typography, pen,
canvas, pictures as quantised — is recorded per send and versioned, so a
notebook sent today is read back exactly even after the settings or the plugin
changed.

## Worth knowing

- **Older sends.** Notes sent as PDF, EPUB or editable text by earlier versions,
  or before the two-way merge existed, are re-sent as handwriting on the next
  sync; changes that arrive without a record of the sent text are added to the
  note as a summary block instead of woven in.
- **A re-send replaces the notebook.** Ink written in the seconds between a
  sync's read and its send lands in the trashed copy.
- **A partly erased word** (a nicked letter) stays; the log lists it. **Moves**
  into empty space are reported but not applied.
- **First sync of many notes** can take a while: the reMarkable cloud limits how
  fast it accepts uploads, and the plugin waits when told to.
- **Pages are bigger than a PDF's.** A full page is a few hundred KB of strokes.

## Privacy

Your notes go only to the endpoint you configure — the official reMarkable cloud
or your own rmfakecloud — and, if you choose the vision endpoint, cropped remark
images to that endpoint. No telemetry. The pairing is a device token obtained
from a code you enter; it stays in the plugin's own settings and never goes into
the shared sync state.

Only when you press *Download and install Ollama* (desktop, in *Set up local
reading for me*) does the plugin contact `api.github.com` and GitHub's release
downloads for Ollama's official installer; it saves the installer to your
system's temp folder (`remarkable-ink-ollama`, outside the vault), checks it
against the SHA-256 GitHub publishes, and opens it — you run the installer.

## Status

Tested against the `.rm` reference implementation and real device sample files
(paper sizes, tombstones, lasso moves), with the full suite of unit tests
passing; real-device testing is ongoing. Reports and ideas:
[issues](https://github.com/weissi1994/obsidian-remarkable-round-trip/issues) —
attach `reMarkable Ink Round-Trip log.md`, it answers most questions.
[CHANGELOG-INK.md](CHANGELOG-INK.md) lists what changed;
[CHANGELOG.md](CHANGELOG.md) is the upstream history.

## Licence

GPL-3.0-or-later, as upstream — Copyright (C) 2026 Max Kloosterman, and the fork's
contributors. Bundled fonts: see [FONTS-LICENSE.md](FONTS-LICENSE.md) (SIL OFL 1.1
and the Hershey licence). The WritePad engine (`vendor/writepad`, built into
`src/ocr/writepad/engine.js` by `scripts/build-writepad.sh`) is GPL-3.0,
Copyright PhatWare Corp.
