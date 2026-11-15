# type-menu-commands (0.5, package 13)

The Type menu's commands: Warp Text, the anti-aliasing methods, Create Work Path, Convert to Shape, Convert to Point
Text / Convert to Paragraph Text, Update All Text Layers, Paste Lorem Ipsum; the Horizontal and Vertical Type Mask
tools; the options bar's orientation button.

## User guide

### Warp Text

**Type > Warp Text…** (or the warp button in the Type tool's options bar) bends the selected text layers into one of
fifteen shapes: Arc, Arc Lower, Arc Upper, Arch, Bulge, Shell Lower, Shell Upper, Flag, Wave, Fish, Rise, Fisheye,
Inflate, Squeeze and Twist. Choose **Horizontal** or **Vertical** to bend along the width or the height of the text,
and set **Bend**, **Horizontal Distortion** and **Vertical Distortion** (−100 % to 100 %). The canvas shows the result
while the dialog is open; Cancel puts the text back. Choose **None** to remove a warp.

The warp stays live: the text remains editable, and the warp follows every change to the text, its font and its box.
While you edit warped text, it is shown without the warp; the warp comes back when you commit. The shapes are the
same as Edit > Transform > Warp's presets. Text on a path and stacked vertical text cannot be warped.

### Anti-aliasing

**Type > Anti-Alias** (also the anti-aliasing menu in the options bar and in the Character panel) sets how the edges
of the selected text layers are smoothed:

- **None**: no smoothing; every pixel is fully in or fully out (hard, jagged edges, for pixel art and masks).
- **Sharp**: the crispest smoothing.
- **Crisp**: a little smoother than Sharp.
- **Strong**: heavier-looking text.
- **Smooth**: the smoothest edges (the default).
- **Windows LCD** is drawn like Smooth, and **Windows** like Sharp.

Pigment draws None, Sharp, Crisp and Strong itself from the glyph outlines, after any warp and any Free Transform, so
the edges stay as chosen when the text is rotated or scaled. These are close approximations of Photoshop's methods,
which Adobe does not document. Text whose font is drawn by the browser (see below) gets the same edges by reshaping
the browser's drawing.

### Create Work Path and Convert to Shape

**Type > Create Work Path** puts the outlines of the selected text layers into the Work Path (Paths panel): one
subpath for each contour of each letter, with the warp and any transformation applied. The text layer stays as it
is. **Type > Convert to Shape** replaces each selected text layer with a shape layer of those outlines, in the text
colour, keeping the layer's name, opacity, blend mode, styles, masks and place in the stack. The shape is no longer
editable as text.

Both need the font's outlines. Pigment has them for fonts it reads itself: the bundled fonts, fonts added with Type >
Add Fonts…, and installed fonts Pigment may read (always in the desktop app; in the browser, after you allow access
to local fonts). A font the browser draws for Pigment has no outlines, and these commands say so. Colour emoji and
characters drawn by a fallback font in the browser are left out.

### Convert to Point Text / Convert to Paragraph Text

The command's name follows the active text layer. **Convert to Paragraph Text** puts point text into a paragraph box
just wide enough for its lines. **Convert to Point Text** ends each line of a paragraph where it wrapped (a return
replaces the wrap); text that did not fit in a fixed box is deleted, and Pigment tells you so.

### Update All Text Layers, Paste Lorem Ipsum

**Update All Text Layers** lays out every text layer again with the fonts available now (for example after you
installed a font). It does not add a history step. **Paste Lorem Ipsum** works while you edit text: it inserts the
standard placeholder paragraph at the cursor, and fills a fixed paragraph box to its end.

### Type Mask tools

The **Horizontal Type Mask** and **Vertical Type Mask** tools share the Type tools' slot (Shift+T cycles all four).
Click or drag and type as with the Type tools; the canvas turns red except for the letters. Commit (✓,
Ctrl/Cmd+Enter, or a click outside) and the letters become a selection, as one "Type Mask" history step; no layer is
made. Hold Shift for the first click to add to the current selection. The selection follows the tool's font, size,
anti-aliasing (None gives a hard-edged selection) and orientation.

### Orientation button

The first button in the Type tool's options bar switches the selected text layers between horizontal and vertical
(one "Text Orientation" step) and switches the tool to the other orientation. With no text layer selected it only
switches the tool.

## Release notes

- New: Type > Warp Text… with fifteen styles, Horizontal / Vertical, Bend and the two distortions; the warp stays live
  and editable, and is kept in .pigment files.
- New: Type > Anti-Alias: None, Sharp, Crisp, Strong, Smooth, Windows LCD, Windows actually change how text is drawn
  (0.4 stored the setting only). The options bar and the Character panel run the same command: one "Anti-Alias" step.
- New: Type > Create Work Path, Type > Convert to Shape (from glyph outlines).
- New: Type > Convert to Point Text / Convert to Paragraph Text, Update All Text Layers, Paste Lorem Ipsum.
- New: Horizontal and Vertical Type Mask tools in the Type tools' slot; Shift+T now cycles four tools (0.4: two).
- New: the options bar's orientation button works (it was disabled in the 0.5 skeleton).
- Changed: text layers whose anti-aliasing is None, Sharp, Crisp, Strong or Windows look different from 0.4 (which
  drew every method as Smooth). Documents from 0.4 keep their stored method, so such text now draws with it.

## Known gaps

- **PSD**: the warp and the anti-aliasing method are written to and read from PSD by psd-text (S11.4). Until that
  package lands, a warped text layer is saved to PSD as unwarped editable text (the warp is lost in the PSD file;
  .pigment keeps it), and the method is not written.
- Sharp, Crisp, Strong and Windows are approximations; Windows LCD has no sub-pixel colour.
- Warped text is edited unwarped (as decided in review, decision 15). Text on a path and stacked vertical text are
  never warped, as in Photoshop.
- Create Work Path and Convert to Shape need glyph outlines: text drawn by the browser's own font engine (a font
  Pigment cannot read) has none, and colour glyphs are left out. Stacked vertical text has no outlines either.
- Convert to Shape takes the fill colour and the text stroke (as an outside shape stroke) of the first character:
  text in several colours becomes a shape of one colour.
- The Type Mask tools keep a temporary text layer (drawn invisible) in the Layers panel while you type; it goes when
  you commit or cancel. Alt does not subtract (Alt-click types a box size, as with the Type tools).
- Convert to Paragraph Text makes a box that grows with the text (Photoshop's box has a fixed height).
- Update All Text Layers relayouts every open document, not only the active one.
