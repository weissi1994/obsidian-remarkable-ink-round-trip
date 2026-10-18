# reMarkable Ink Round-Trip

A fork of [reMarkable Round-Trip](https://github.com/maxonamission/obsidian-remarkable-round-trip)
that keeps your notes in **two-way sync** with the tablet as **real pen
strokes**, in a handwriting font or your own hand (what
[Remarkify](https://remarkify.app) does for the way out). Change the note in
Obsidian and the notebook is rewritten; erase, move, mark or write on the tablet
and it is merged back into the note itself.

Because the strokes are real ink rather than a PDF, the tablet treats them like
your own writing. That opens up two gestures a PDF can't support, and the sync
understands both:

| On the tablet | In the note |
|---|---|
| **Erase** a word with the eraser | The word is removed (or struck through — your choice) |
| **Move** words with the lasso | The words move to where you dropped them |
| Strike through, underline, circle, margin bar, tick a box | Same as upstream: `~~struck~~`, `<u>…</u>`, `**circled**`, `>` quote, `- [x]` |
| Freehand **highlighter** over words | `<mark>` in the colour you used |
| Handwrite between the lines or in the margin | A remark callout with the image — and, opt-in, the text read by OCR |
| Add a page to write on | The whole page as a remark, after the text it follows |

Edited the note in Obsidian while the notebook was out? Both sides are merged —
word by word within a paragraph. Only where both changed the same words does the
note keep yours, with the tablet's version in an *Also changed on the
reMarkable* callout right below it. Before any tablet change goes in, the
previous version of the note is saved to the backup folder.

Pictures come along too: images in the note are redrawn as **coloured hatching**
in the tablet's inks (blue, red, green, yellow, pink, plus black and grey for
shading) — see [Pictures](#pictures). And **Mermaid diagrams** are drawn by hand:
traced into wobbly pen lines with labels in your handwriting — see
[Mermaid diagrams](#mermaid-diagrams).

Kept from upstream: the official cloud or your own rmfakecloud, and folder
mirroring. Gone: the PDF, EPUB and editable-text formats, companion notes and the
separate send/import commands — there is one way in and out, and it is ink.

## Getting started

1. **Install.** Copy `main.js`, `manifest.json` and `styles.css` into
   `<vault>/.obsidian/plugins/remarkable-ink-round-trip/` and enable
   *reMarkable Ink Round-Trip* under *Settings → Community plugins*. It has its
   own id, so it can sit next to the original plugin.
2. **Pair** under *Settings → Connection*, with a one-time code from
   my.remarkable.com — or toggle *Self-hosted endpoint* for rmfakecloud.
3. **Pick your canvas** under *Settings → Handwriting → Notebook page size* (it follows the reMarkable model by default; the Paper Pro Move must be picked here). Not
   sure which? Run **Detect reMarkable page size from my notebooks**: it reads the
   paper size the tablet records in any notebook you made on it (the Paper Pro
   writes 1620×2160; the Move preset is 954×1696 @ 264 dpi until detection says
   otherwise).
4. **Pick what syncs** under *Settings → Sync*: turn on *Sync folders* and list
   the vault folders to keep in sync. Any other note joins with right-click →
   *Sync with reMarkable* (or the command *Sync current note with reMarkable*)
   and stays in sync from then on.
5. **Work on either side.** The plugin checks the tablet when Obsidian starts and
   every few minutes (*Check the reMarkable every*, 0 = only on start and on
   demand); **Sync with reMarkable now** does it at once. A note you change in
   Obsidian is re-sent after a short quiet period — its notebook is read first,
   so ink not yet in the note is never lost.

## Your own handwriting

1. Run **Send handwriting sheet to reMarkable** (or the button under
   *Settings → Handwriting*). A notebook of labelled boxes arrives: lower and
   upper case, digits, ä ö ü ß Ä Ö Ü and common punctuation.
2. Write each character once, sitting on the solid line, capitals reaching the
   dashed line. Skip any you like — they fall back to the font you choose.
3. Let it sync, then run **Learn my handwriting from the sheet**. From then on,
   handwritten sends use your letters.
4. Optional: send a fresh sheet, fill it in again and run **Add handwriting
   variations from the sheet**. Up to three samples per character are used in
   turn, so a page of your “e”s doesn't look stamped.

Every send records which version of your hand it used, so re-learning later never
confuses the import of something you sent before.

## Built-in fonts

| Font | Look |
|---|---|
| Readability (EMS Readability) | Clean print — the default, easiest to read on e-ink |
| Hershey Sans | Technical print |
| Allure (EMS Allure) | Flowing script |
| Hershey Script | Classic joined script |

Code blocks always use Hershey Sans in fixed-width cells. See
[FONTS-LICENSE.md](FONTS-LICENSE.md) for origin and licences (SIL OFL 1.1 and the
Hershey licence).

## Pictures

Images embedded in the note — `![[photo.png]]`, `![alt](path/to/img.png)`, also
inside embedded notes — are redrawn as hatch strokes, like a sketch done with the
tablet's coloured fineliners:

- each pixel is reduced to one ink (blue, red, green, yellow, pink, or black and
  grey for tone) and a darkness level;
- light tones get one pass of parallel lines, mid tones a crossing pass, the
  darkest a third — every ink at its own angle, so overlapping colours stay
  distinguishable.

On a reMarkable without colour the same strokes show in grey. *Settings →
Handwriting → Pictures* switches between **Coloured hatch** (default), **Grey
hatch** and the old **Placeholder** line. The picture is drawn at its natural size
(pixels at 96 dpi), never wider than the text; an Obsidian size alias
(`![[photo.png|300]]`) sets the width. Only images on a line of their own are
drawn — an image in the middle of a sentence stays a placeholder.

The picture is quantised once at send time and kept with the sent text, so the
import always regenerates the strokes it sent. Erasing or scribbling over a
picture on the tablet is not mistaken for erased words; your scribbles come back
as remarks.

## Mermaid diagrams

Every ```` ```mermaid ```` block in the note is drawn instead of written out:

1. Obsidian's own Mermaid renders it, in a theme made for pen — black lines on
   white shapes whatever your Obsidian theme, a pale-yellow note colour, and
   saturated chart colours that map cleanly onto the tablet's inks.
2. The SVG is traced while it is live in Obsidian, so what you get is what the
   diagram shows: only visible strokes, arrowheads and other markers placed as
   the browser places them, label boxes measured with real font metrics, and
   lines cut where a box or a label covers them.
3. On the page, lines get a slight hand-drawn wobble (the *Hand-made look*
   slider sets how much), labels are written in your handwriting or the chosen
   font, and coloured areas — pie slices, notes, gantt bars — are hatched like
   pictures.

Flowcharts, sequence, class, state, ER, pie, gantt and mindmap diagrams are
tested against real Mermaid 11 output. A diagram is drawn at its natural size,
never wider than the text, so a very wide one (a long gantt chart) comes out
small. A diagram that fails to render stays a code block; *Settings →
Handwriting → Mermaid diagrams → As code* keeps them all as code.

The traced diagram is kept with the sent text, so neither a Mermaid update nor
an edit of the diagram changes what the import compares the page against.
Scribbles on a diagram come back as remarks; erasing part of it is not
reported as erased text.

## Reading handwriting (OCR) — opt-in

Off by default: upstream returns handwriting as an image on purpose, because a
wrong guess can be worse than the ink. Turn on *Settings → Reading handwriting*
to also get the text, from any OpenAI-compatible vision endpoint you choose:

- **Local, private:** Ollama (`http://localhost:11434/v1`, e.g. `qwen2.5vl:7b`)
  or LM Studio. The ink never leaves your machine.
- **Hosted:** any OpenAI-compatible API with a vision model; add the API key.

Only the cropped remark images are sent — never the note. The image stays next to
the transcript unless you turn that off, so a misread word is easy to check.

## How it works

The PDF typesetter is reused unchanged behind a small drawing seam, so a
handwritten note lays out by exactly the same rules as a PDF — same line breaks,
same smart page breaks, same task boxes and fill-in table rows. Its text calls are
recorded and turned into pen strokes from single-line glyphs, in device units, and
written as a v6 `.rm` notebook (the format reMarkable writes for its own
notebooks). The writer follows [rmscene](https://github.com/ricklupton/rmscene):
every block of a generated page re-serialises identically through rmscene's own
writer.

Every stroke the plugin writes has its own id. When the page comes back, the
import regenerates those strokes — deterministically, jitter included, from the
text it kept at send time — and compares:

- a stroke with our id and our shape is untouched;
- a new stroke whose `move_id` points at ours is a lasso move;
- a new stroke lying exactly along one of ours that disappeared is what the
  eraser left of it;
- everything else is yours, and goes to the upstream mark reader.

Missing ink is summed per word: mostly gone → erased; mostly elsewhere → moved,
and where it landed decides which word it now follows.

## Worth knowing

- **Move a word onto a line**, between or after words — that's where it lands in
  the note. Moves into empty space, or into typed text you added with a Type
  Folio, are reported but not applied.
- **A partly erased word** (a nicked letter) stays; it's listed in the log.
- **A re-send replaces the notebook.** After the tablet changes are merged, the
  note goes out again as a fresh notebook and the old one moves to the tablet's
  trash. Ink you write in the seconds between the check and the re-send is in
  that trashed copy.
- **Notebooks sent before two-way sync** (or as PDF, EPUB or editable text by an
  earlier version) carry no merge base: their tablet changes are added to the
  note as a summary block, and the next sync re-sends them as handwriting.
- **What a mark becomes** follows *Settings → What a pen mark becomes*; a
  strike-through, underline or highlight written into the note comes back to the
  tablet as plain words — a notebook can't show markdown styling.
- **Keep the plugin folder** when moving vaults: `hands/` holds your learned
  handwriting and `sent/` the text of each send — what the sync compares and
  merges against.
- **Inline styling** (a bold word inside a sentence) is written plain, as in the
  upstream PDF; whole bold or italic paragraphs keep their weight and slant.
- **Pages are bigger than a PDF send.** A full page is a few hundred KB of
  strokes; a long note takes a moment longer to sync.

## Status

Tested here against the `.rm` reference implementation and its real device
sample files (paper sizes, tombstones, lasso moves), with 505 tests passing — not
yet on a physical tablet. The first real-device check worth doing: sync a short
note, erase one word, lasso one word to another line, write a remark, edit
another line in Obsidian, and run *Sync with reMarkable now*. The log (`reMarkable Ink Round-Trip log.md`) lists for every
page how many generated strokes it found intact, moved, erased and how many are
yours.

## Licence

GPL-3.0-or-later, as the original. Original plugin © 2026 Max Kloosterman; ink
additions © 2026 Daniel. Bundled fonts keep their own licences
([FONTS-LICENSE.md](FONTS-LICENSE.md)).
