# Changelog — reMarkable Ink Round-Trip

## Unreleased

- **Handwriting comes into the note where you wrote it.** On the tablet your
  writing sits in a table cell, on a task, beside a line or between blocks;
  now it does in the note too, without a callout. A reading the plugin is
  confident of goes in as plain text right there — appended to the cell, as
  the empty task's text, at the end of the line, or as a paragraph of its own
  between blocks; anything else goes in as a small picture of your ink at
  the same place, about a line high. A hidden marker (`%%ink-<id>%%`) after
  each item finds it again on the next sync, so nothing is placed twice and
  reading the same page again leaves the note as it is. Your edits to the
  text stand; a picture gives way to a confident reading, and the plugin's
  own untouched text to a clearly better one. Writing more on the same
  remark updates the same item. Sent back, text is typeset and its strokes
  are gone from the page; a picture is your original strokes again where you
  wrote them. Fixing the text, or replacing a picture with text — by hand or
  with **Turn this handwriting into text** (command and right-click) —
  teaches the reader. "Confident" means: the built-in reader or WritePad
  clearly above its own threshold; for a vision endpoint, every word known to
  your vault or your learned hand, or the same as the local reading; never
  with made-up symbols. *Settings → Handwriting → Handwriting comes into the
  note as* switches back to the Remark callout; callouts already in a note
  are never rewritten. A page you added on the tablet, and typed-text
  notebooks, still come in as callouts; the faded ink overlay is for
  callouts only.
- **Fixes from the first device test of two-way sync:**
  - Handwriting readings no longer become nested callouts. A remark inside a
    callout (a clash callout, say) is read on its own: its text is no longer
    taken with its neighbours' titles and readings. Such text was learned as
    your "correction" and then sent to the vision model as a worked example,
    and the model answered every new remark with it. Remark text that holds
    callout or quote markup is no longer learned or sent as an example, and
    existing bad records are skipped. A model answer with such markup is
    dropped, and the remark keeps its image.
  - Two remark callouts at the same place are separated by a blank line.
    Without one, Obsidian shows them as one callout.
  - Writing on a printed line (in a table cell, on a task, beside the text)
    and writing in the free space below it are two remarks, even when they
    are close together.
  - A remark written in a table cell goes right after the table, not after
    a list that follows the table directly. It is set apart by blank lines.
  - An empty task (`- [ ]`) is drawn as a box you can tick, not as the text
    "-[]". This applies to notes sent from now on; notebooks already on the
    tablet keep their layout. A tick in the box is applied, and writing on
    the task is tied to it.
  - The import report no longer says a note "changed since it was sent — the
    marks cannot be placed" when the tablet's changes were merged into it, for
    example when only a frontmatter timestamp changed.
  - A remark callout at the end of a note no longer picks up the trailing
    space of the note's last line.
- **Full two-way sync — renames, moves and deletes follow both ways:** renaming
  or moving a note renames or moves its notebook (metadata only, nothing is
  redrawn), and renaming or moving a notebook — or its folder — on the tablet
  renames or moves the note. When both sides renamed, the vault's name wins.
  Renaming a sync folder updates *Folders to sync*. Deleting a note sends its
  notebook to the tablet's trash (kept, and reported, if it holds ink not read
  yet); deleting or trashing a notebook reads its new ink first, then moves the
  note to the new *Folder for archived notes* (default `reMarkable/Archive`)
  instead of sending it again. Restoring either side brings the other back;
  a note restored in the vault brings its notebook back to the folder it was
  in, unless that folder now mirrors another vault folder (renamed on the
  tablet meanwhile). Nothing is ever deleted for good. An account or endpoint
  switch archives, trashes and sends nothing. Notes deleted while Obsidian was
  closed count as deleted once they have stayed missing for three syncs and an
  hour.
- **Notebooks are updated in place:** a changed note rewrites only the pages
  whose text changed, in the same notebook. Page tags, templates, bookmarks and
  pages you added stay (an added page goes only once its ink is in the note).
  Notebook tags and the note's `tags` frontmatter sync both ways.
- **No more lost tablet ink:** a notebook is only rewritten or trashed while it
  is exactly as the plugin last read it. Ink written after the read is read in
  first; a notebook that could not be read is not touched. A send cut off by a
  crash or closing Obsidian is recognised on the next sync (no duplicate
  notebook), and the merge base only moves once the tablet really has the new
  notebook. Tablet changes are merged against the note as it is at the moment of
  writing, so typing during a sync is kept; the backup holds exactly the text
  that was replaced.
- **Better merging:** every change that doesn't touch the words the other side
  changed goes in — before, one clashing word sent the whole paragraph to the
  *Also changed on the reMarkable* callout and dropped the tablet's other edits
  in it. Lines added on both sides at the same spot are both kept. Editing one of
  several identical lines no longer cuts it apart. Importing again (after a held
  back send, say) changes nothing, and a clash you resolved never comes back.
  Each clash callout has its own id.
- **Nothing dropped silently:** a move into empty space, a partly erased word, a
  page that could not be read or a mark that could not be placed is listed in a
  *Pending from reMarkable* callout at the end of the note.
- **Placement:** words match only whole words (`the` no longer matches inside
  `theory`), a repeated phrase is matched where you marked it, a remark without
  printed text under it goes after the text above it on its page instead of to
  the end of the note, and adding a stroke to a handwritten remark updates it
  instead of adding a second one. Words the typesetter broke across lines (long
  URLs, compounds) can be erased and marked again.
- **Fixes found by replaying real notes in a learned hand:** a bar in the
  margin quotes the lines beside it again (it was dropped without a trace); a
  remark written under a code row goes after the code block, and importing it
  again no longer duplicates the code; a page added on the tablet no longer
  causes a false clash when the note ends in blank lines. Code lines cut at the
  page edge are matched to their words, and so is the text after them. Marks on
  and after runs of links land again (the page shows only the link text), a
  first heading that repeats the title no longer throws placement off, nor do
  title words or frontmatter values that recur in the body, and a remark
  written under a heading goes right below it, not past the next one.
- **Erased words are struck through by default** instead of removed (*A word you
  erase on the tablet becomes*). An existing install keeps the choice it has
  saved; pick *Struck through* there to switch.
- **Typed text:** text you type with the reMarkable keyboard comes into the note
  word for word, and notebooks started on the tablet bring theirs in verbatim.
- **Typed-text notebooks (experimental):** *Notes go to the tablet as → Typed
  text* sends notes as the tablet's own keyboard text. Typed edits come back
  exactly; pen ink becomes remarks and stays attached to its text on the tablet.
  Typing works on pages that already hold ink. Checked against rmscene, not yet
  on a device.
- **Several copies of the vault:** the copy that syncs on its own holds a lease
  in the shared state folder; the others leave automatic syncs to it, and a
  manual sync there asks first (new setting *This device's name*). A send
  another copy has in flight is left alone. A notebook another copy replaced
  by a send is not taken for trashed on the tablet while that copy's sync state
  has not arrived: the note is neither archived nor sent until it has. A note
  found in the archive folder while its notebook is still on the tablet goes
  back where it was synced, instead of its notebook following it into an
  archive folder on the tablet. A note whose record has not arrived waits only
  for a notebook of its name in the folder it would be sent to, not for one of
  yours elsewhere on the tablet. Damaged state files (merge conflict
  markers) are never overwritten, Syncthing/git conflict copies are listed
  instead of loaded, and notes copied with their `remarkable-id` get their own
  notebook. Unused files in the state folder move to its `trash` subfolder after
  a week.
- **Stop syncing with reMarkable** (command and right-click): writes
  `remarkable: false` into the note so it stays out even in a sync folder, and
  asks whether its notebook goes to the trash. **Sync with reMarkable** joins it
  again.
- **Sync status** lists every note by state (in sync, waiting to send, clash,
  tablet changes pending, not sent with the reason, archived, left out); click one
  to open it. A status-bar warning shows failing syncs, unsent notes and clashes;
  after three failed background syncs in a row a notice appears. Rate limits
  don't count, and their message no longer suggests turning folder mirroring off.
- **Watching notes:** a note you keep editing is sent at most a minute after its
  first unsent change; the plugin's own writes and the backup folder no longer
  trigger sends; watched notes sync through the same queue as *Sync now*.

- **Built-in reading no longer guesses at joined-up writing:** a joined-up
  word has no separate letters, so the letter reader matched each whole word
  as one symbol (`mmmmmmm` for "Ask about the budget and the timeline"). It
  now recognises joined-up words by their width and reads them only whole, as
  a word you wrote before; otherwise the remark goes straight to WritePad (or
  stays an image). Lines of joined-up writing are also cut into their words
  correctly now, so correcting such a remark teaches its words — before, a
  whole line counted as one word and taught nothing.

- **Handwriting test sheet (#14):** **Send handwriting test sheet to
  reMarkable** sends 18 short German and English lines to copy by hand.
  **Save handwriting test sheet to the vault** reads them with today's readers,
  learning nothing. It saves your ink, every reading (also the ones the plugin
  would not have used) and the character error rate per reader to
  `<handwriting folder>/test-sheets/<date-time>/`. The one
  `handwriting-test-….json` there is meant for attaching to an issue. It holds
  only the prepared lines, your ink of them, your learned letters and the
  readings, nothing else from the vault. A test sheet is also listed under
  *Settings → Handwriting*.

- **Learned handwriting follows the vault:** which hand is in use and the
  sheets waiting on the tablet now live in `reMarkable/.sync/handwriting.json`
  too, so every copy of the vault uses the hand learned on any of them. Word
  samples and corrections learned on different copies are merged at each sync
  instead of one copy's overwriting the other's.

- **No `OLLAMA_ORIGINS` needed:** the setup guide no longer asks you to set
  it; Ollama 0.1.42+ accepts the plugin's requests as they are.
- **Unconfirmed remarks show on the text:** a remark you have not confirmed
  yet is also drawn half-transparent over the note, roughly where you wrote it
  beside the printed line, in reading view and in the editor. Only a picture —
  the note and its callout are unchanged — and it goes once the remark is
  confirmed (✓) or inserted as text. **Show unconfirmed remarks on the text**
  under Handwriting turns it off.
- **One-click local reading (desktop):** *Settings → Reading handwriting (OCR)
  → Set up local reading for me* finds Ollama on this computer, downloads the
  handwriting model if it is missing — after you confirm, with progress and a
  Cancel — points the OCR settings at it and runs *Test connection*. If Ollama
  is not running it links to the installer. The manual endpoint settings stay
  for everything else.
- **Download and install Ollama (desktop):** when *Set up local reading for me*
  finds no Ollama, macOS and Windows get a button that downloads Ollama's
  official installer from its GitHub release — after you confirm, with its
  size, progress and a Cancel — checks it against the published SHA-256, opens
  it, and carries on once Ollama is running. Linux gets the official install
  command to copy. Any failure falls back to the ollama.com/download link.
- **One-click setup finds LM Studio too:** when Ollama is not running but LM
  Studio's server is, *Set up local reading for me* offers LM Studio and the
  vision models already downloaded there (loaded ones first), points the OCR
  settings at the one you pick and runs *Test connection*. It downloads
  nothing; with no vision model yet it says where to get one in LM Studio.
- **Tables, lists, task boxes, code and nested quotes inside quotes and
  callouts** are typeset as such, set in by the quote's bar: a table gets its
  grid, a task a box to tick, code its band, and a callout's title a line of
  its own. Before, everything in a quote ran together into one italic
  paragraph of pipes and markers. Notebooks already on the tablet keep their
  look until their note changes and is sent again.
- **Ticks, strikes and remarks inside quotes and callouts come back into the
  note:** a tick or a stripe on a task in a callout (`> - [ ] task`, also in a
  nested quote) marks it done or cancelled, like a task outside one. A remark
  written in a table cell inside a callout goes into that cell instead of
  breaking the table, and one written against a list item in a callout becomes
  a new item of that list.
- **Nested callouts get their title too:** a callout inside a callout or
  quote (`> > [!tip] Inner`) reaches the tablet as a bold "Inner" line at its
  quote depth instead of the literal `[!tip] Inner`, and callout syntax inside
  a code fence is no longer rewritten. Notes with a nested callout are sent
  once more on the next sync.
- **Handwriting sheets have a layer of their own to write on:** the boxes,
  guides and labels sit on a "Sheet" layer, and the page opens on an empty
  "Your handwriting" layer above it. The tablet's eraser and lasso only touch
  the selected layer, so fixing a letter can no longer erase a box line.
  Notebooks of your notes keep one layer — erasing and moving their words is
  how you edit them.
- **Handwritten remarks go back to the tablet as you wrote them:** ink only,
  at the spot you wrote it, beside the line you wrote it against (it follows
  that line when text above it changes) — no longer a callout box with a title,
  the typeset reading and a second copy of the ink below the paragraph. The
  note keeps its remark callout. *Settings → Handwriting → Handwritten
  remarks* switches back to callouts. Applies to remarks imported from now
  on. Notes with such remarks are re-sent once.
- **No more stray `^ink-…` lines on the tablet:** a remark callout's id line
  was written onto the page as text.

- **Insert a handwritten remark into the note as text (⤵):** a button on
  the remark callout (and in the correction editor, and a command) puts its
  text where the ink was written — into the table cell under it, as a line of
  the callout it was in, as a new list item, or as a paragraph after the text
  it follows — and removes the callout. Highlighter over the handwriting comes
  back as `<mark>` in the tablet's colour on the words it covered. The remark
  counts as confirmed (and corrected, if you changed it) at once and is not
  brought back by later imports.
- **Remarks no longer split tables, lists, callouts or code blocks:** a
  remark written next to a table row, a callout line, a list item or a line
  of code was inserted right after that line — splitting the block, and the
  lines after it ran on into the remark (where they would later have been
  learned as a "correction"). It now goes after the whole block.

- **Corrections to read handwriting stick, and teach every reader:**
  - Each remark gets a stable id — a hash of its ink — that names its image
    and ends its callout as a block id (`^ink-…`). A remark written above an
    old one no longer renumbers it (which overwrote its image and pinned
    corrections to the wrong ink). Images under the old numbered names keep
    them while their ink is unchanged.
  - A remark the note already shows is no longer imported again: a corrected
    text used to come back on every sync as an "Also changed on the
    reMarkable" conflict holding the old reading — or, in the summary block,
    replaced it. Your text and placement now stand; an image-only remark
    gets its text once it can be read.
  - A correction that cannot be matched to the ink word for word is reported
    in a notice instead of being dropped silently.
  - The vision endpoint learns too: your latest corrections go along with
    each request as worked examples (*Worked examples from your
    corrections*, default 3).
  - **Export handwriting corrections as training data** writes them as a
    LLaMA-Factory dataset for fine-tuning a vision model outside the plugin.
  - **Confirm or correct in the note:** ✓ and ✎ buttons on every remark
    callout; ✎ opens the ink beside its text. Commands to confirm the remark
    at the cursor or all in a note. A confirmed reading (✓ in the title) is
    never replaced and counts as known-correct for learning and export.
  - An untouched reading is only replaced by one the reader is clearly surer
    of (scores compared above each reader's threshold), so a right reading is
    no longer swapped for a different one of equal certainty. Vision-endpoint
    readings carry no score and only fill image-only remarks.

- **Joined-up writing read by WritePad:** remarks the built-in letter reader is
  unsure of are read again by the WritePad handwriting engine (PhatWare,
  GPL-3.0), built to WebAssembly and bundled with its English and German
  dictionaries — no download, nothing sent anywhere. Each remark is read in both
  languages, line by line; the vault's spelling wins among close alternatives,
  and an unsure reading still stays image only. Rebuild the engine with
  `scripts/build-writepad.sh` (needs the `vendor/writepad` submodule and
  Emscripten, taken from nix-shell when missing).

- **Your ink comes back as your ink:** a remark or page brought in from the
  tablet keeps its original strokes (`reMarkable/.sync/ink/`), and sending the
  note writes those strokes again — same pens, colours and size — instead of a
  hatched copy of its picture, or, inside a remark callout, the text
  `[image: …]` it used to become. Notebooks brought in from the tablet keep
  their real handwriting the same way. Remarks read before this get their
  shapes back from what the built-in reader remembered, in a black pen.
- **Light highlighter colours, for real:** on the Paper Pro and Move the bands
  are now written the way the tablet writes its own highlighter — its
  "highlight" colour with the exact tint — which the tablet honours; the tint
  alone, on a palette colour, still showed the dark pen blue. New command
  **Re-send every synced note to reMarkable** rewrites existing notebooks after
  a change like this one.
- **Several copies of one vault, one tablet:** the sync state — which notebook
  belongs to which note, what it was written from, the learned hand and word
  samples — moves from the plugin's own data into the vault
  (`reMarkable/.sync/`, one small file per note, pictures stored once), so a vault
  synced by git or Obsidian Sync carries it to every copy and none sends
  duplicates. Moved there automatically on first start. *Sync automatically from
  this device* lets one copy do the background syncing. Notebooks written by any
  copy are recognised by their pages and never brought in as new.
- **Notebooks started on the tablet come into the vault:** a notebook in the
  device folder of a synced vault folder becomes a note there — each page's ink
  as an image, with its text as read — and is sent back as a handwritten
  notebook in place of the original (moved to the tablet's trash), so it syncs
  both ways from then on. Fixing the read text teaches the built-in reader your
  hand. Notebooks changed in the last ten minutes are left until you are done.
- **Lighter highlighter colours:** every highlighter band the plugin writes —
  code blocks, inline code, quotes, highlights, table headers, diagram fills —
  now carries the exact light tint the tablet's own highlighter uses (light
  blue, yellow, pink…), so text on it stays readable. Before, code blocks came
  out in the pen palette's dark blue. Models without exact colours keep showing
  the palette colour.
- **Tables with a full grid:** an outer border, lines between columns and
  under every row, a heavier rule under the header (with a light grey band
  when colour accents are on), and padded cells so no line touches the text.
  Columns no longer break a word they have room for. Notebooks sent earlier
  keep their old tables.
- **Styled text in table cells:** bold, italic, inline code, highlights,
  underline and strike-through in a cell are drawn as they are elsewhere in the
  note, instead of plain.
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
