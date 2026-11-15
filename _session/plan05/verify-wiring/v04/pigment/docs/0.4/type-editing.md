# type-editing

Editing text with the Type tools in Pigment 0.4: selection, the formatted clipboard, undo while typing, the box
handles, transforming and moving text while editing, and Photoshop's type shortcuts (ARCHITECTURE.md, "0.4 features
(contracts)", package 2).

## User guide

### Typing

Click with the Horizontal or Vertical Type tool to start point text, or drag to draw a paragraph box. A new text layer
starts with placeholder text ("Lorem Ipsum", or a paragraph of it in a box), already selected: the first key you type
replaces it. To start with an empty layer instead, turn off **Fill new type layers with placeholder text** in
Preferences > Type. Click a text layer with a Type tool, or double-click it with the Move tool, to edit it.

Pigment draws its own text cursor and selection on the canvas, over the text as it is laid out, so they follow every
size, font and line of the layer. Input methods for Chinese, Japanese and Korean, and dead keys for accents, work as in
any text field: the text being composed appears in the layer, underlined, until you confirm it.

- **Tab** types a tab character (tab stops come from the paragraph's tab spacing).
- **Enter** starts a new paragraph; **Shift+Enter** starts a new line in the same paragraph.
- **Ctrl+Enter** (Cmd+Return on macOS), Enter on the numeric keypad or the ✓ button commits the text; **Esc**
  cancels the edit.
- Clicking outside the text commits it. Choosing a command in a menu with the mouse also commits the text first, then
  runs the command.

### Selecting text

- Drag across text to select it. Shift-click extends the selection.
- Double-click selects a word, three clicks a line, four clicks a paragraph, five clicks all the text. Dragging after
  a double-click extends the selection by whole words (and by lines or paragraphs after three or four clicks).
- **Ctrl+A** selects all the text.
- The arrow keys move by character; **Ctrl+Left** / **Ctrl+Right** by word; **Home** / **End** go to the start and
  end of the line; **Ctrl+Home** / **Ctrl+End** to the start and end of the text; **Ctrl+Up** / **Ctrl+Down** by
  paragraph. Add Shift to extend the selection. On macOS, Cmd+Left / Right go to the line's start and end, and
  Cmd+Up / Down to the text's start and end.
- **Ctrl+H** hides the selection highlight while you look at the formatting (press it again to show it).

### Undo while typing

While you edit text, Edit > Undo, Ctrl+Z and Redo step through your typing and formatting changes inside the text.
When you commit, the whole edit becomes one step in the History panel.

### Cut, copy and paste

Cut and copy put the text on the system clipboard, so you can paste it into other applications. Pasted into a Pigment
text layer, it keeps its fonts, sizes, colours and paragraph formats. If you copied something else since (in Pigment or
another application), Paste inserts that plain text in the format at the cursor.

**Edit > Paste Special > Paste Without Formatting** pastes the clipboard's text in the format at the cursor, even when
it was copied from formatted Pigment text.

### Paragraph boxes

While editing paragraph text, the box shows eight handles. Drag a corner or an edge to change the box's width and
height. A box keeps the height you give it: text that does not fit is hidden, and the bottom-right handle shows a red
plus sign. Make the box taller, or the text smaller, to show it.

To make a box of an exact size, Alt-click (Option-click on macOS) with a Type tool: Pigment asks for the width and the
height of the box. Alt-dragging asks too, with the size you dragged filled in.

### Moving and transforming text while editing

- Drag starting outside the text to move it. Hold **Ctrl** (Cmd on macOS) and drag inside the text to move it too.
- Hold **Ctrl** (Cmd) to see the transform box. Drag a handle to scale the text, or drag just outside a corner to
  rotate it. When you release the mouse button, the transform is applied and you go on editing.

### Type shortcuts

These keys work while you edit text (Ctrl is Cmd on macOS). With a selection they change the selected characters; with
just the cursor, size, leading and baseline changes apply to what you type next.

| Keys | Action |
|---|---|
| Shift+Ctrl+. / Shift+Ctrl+, | Font size up / down by 2 px |
| Alt+Shift+Ctrl+. / , | Font size up / down by 10 px |
| Alt+Up / Alt+Down | Leading tighter / looser by 2 px |
| Alt+Ctrl+Up / Down | Leading by 10 px |
| Alt+Left / Alt+Right | Kerning (at the cursor) or tracking (on a selection) by 20/1000 em |
| Alt+Ctrl+Left / Right | Kerning or tracking by 100/1000 em |
| Shift+Alt+Up / Down | Baseline shift up / down by 2 px (Shift+Alt+Ctrl: 10 px) |
| Shift+Ctrl+L / C / R | Align left / centre / right |
| Shift+Ctrl+J / F | Justify, last line left / justify all |
| Shift+Ctrl+B / I | Faux Bold / Faux Italic |
| Shift+Ctrl+U / Shift+Ctrl+/ | Underline / Strikethrough |
| Shift+Ctrl+K / H | All Caps / Small Caps |
| Shift+Ctrl+= / Alt+Shift+Ctrl+= | Superscript / Subscript |
| Shift+Ctrl+X / Alt+Shift+Ctrl+X | Horizontal / vertical scale back to 100 % |
| Alt+Shift+Ctrl+A | Auto leading |
| Shift+Ctrl+Q | Tracking back to 0 |
| Alt+Shift+Ctrl+H / T | Hyphenation on or off / switch the paragraph composer |
| Ctrl+H | Hide or show the selection highlight |

Several of these keys run other commands when no text is being edited (Shift+Ctrl+L is Auto Tone, Shift+Ctrl+C Copy
Merged): while you type, they act on the text only.

## Release notes

- The Type tool draws its own cursor and selection over the layer's real layout, so text with several fonts and sizes
  in one layer can be edited; text on a path and stacked vertical text are edited the same way. Input methods (CJK)
  and dead keys are supported.
- New type layers start with selected placeholder text ("Lorem Ipsum"); Preferences > Type turns it off. A layer whose
  placeholder text was never replaced is kept when you commit it, as in Photoshop (only Esc removes it).
- Paragraph boxes drawn with the Type tool keep their height (0.3 boxes grew with the text): text beyond the box is
  hidden and the overflow handle shows a plus sign. Boxes from 0.3 documents still grow until their height is dragged.
- Paragraph boxes have eight handles (0.3: four corners, width only).
- Type keys changed: **Ctrl+B / I / U** and **Ctrl+Shift+> / <** inside a type session are now **Shift+Ctrl+B / I /
  U** (faux bold, faux italic, underline) and **Shift+Ctrl+. / ,** (size), with the rest of Photoshop's type keys
  (table above). 0.3's Ctrl+B and Ctrl+I set the font's weight and italic face; Shift+Ctrl+B and I set faux bold and
  faux italic, which work with any font (choose the face in the options bar or the Character panel).
- **Tab** types a tab character while editing (0.3 ignored it). **Shift+Enter** types a line break inside the paragraph.
- Edit > Undo, Cut, Copy, Paste, Clear and Select All act on the text while you edit, also from the menu. Other menu
  commands commit the text first (0.3 ran them beside the open editor).
- Ctrl/Cmd-dragging the text, or dragging outside it, moves the text while editing (0.3 committed on any press outside
  the text). A click outside still commits.
- Double-clicking a text layer with the Move tool edits the text (0.3 started Free Transform).
- Alt-click with a Type tool asks for the size of a new paragraph box.
- Undo while typing undoes a whole run of typing at once (0.3 used the text field's own undo, character groups as the
  browser chose them).

## Known gaps

- Bidirectional text (Arabic, Hebrew mixed with Latin) is edited in logical order: the arrow keys move through the
  characters in the order they are stored, and the selection of a mixed line can show as several pieces.
- Word moves (Ctrl+Left / Right) follow the browser's word segmentation of the text's language; on macOS, Option+Left
  / Right kern (as in Photoshop) instead of moving by word.
- The transform box shown with Ctrl/Cmd is Free Transform's: its distort and perspective modifiers are not offered while
  editing (only scale and rotate, and skew with Free Transform's own keys).
- Alt-click asks for the box size in pixels; ruler units come with the rulers work (guides-snapping).
- The placeholder fills a paragraph box with one paragraph of Lorem Ipsum; a very large box shows it with space left.
- The browser build pastes from the clipboard Pigment last wrote or, when the browser allows it, the system clipboard
  (navigator.clipboard); the desktop app always reads the system clipboard.
