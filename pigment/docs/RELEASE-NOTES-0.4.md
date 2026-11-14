# Pigment 0.4 release notes

"Photoshop parity, stage 2". Every new feature worth naming, every changed default, key and behaviour, and the known gaps, by area. The user guide (docs/USER-GUIDE.md, "New in Pigment 0.4") explains how to use them.

## Shared: keys, menus and behaviour

### Keys (Photoshop's defaults)

| Key | 0.3 | 0.4 |
|---|---|---|
| Ctrl+F | Last Filter | Edit > Search… (Last Filter is Alt+Ctrl+F) |
| Alt+Ctrl+F | (none) | Filter > Last Filter |
| Alt+Ctrl+Z | Step Backward | Edit > Toggle Last State (Step Backward and Step Forward have no key) |
| Alt+Shift+Ctrl+Z | Step Forward | (none) |
| Ctrl+Y | Redo | View > Proof Colors (redo with Shift+Ctrl+Z) |
| Alt+Shift+Ctrl+S | Export As… | Save for Web (Legacy)… |
| Alt+Shift+Ctrl+W | (none) | Export As… |
| Shift+Ctrl+' | (none) | Quick Export as PNG |
| Alt+Shift+Ctrl+E | Quick Export as PNG | Stamp Visible |
| Ctrl+/ | Keyboard Shortcuts | Lock Layers… (Keyboard Shortcuts is Alt+Shift+Ctrl+K, in the Edit menu) |
| Cmd+, (macOS) | Settings… | Hide / Show Layers (Settings… is Cmd+K, as on Windows and Linux) |
| Ctrl+E | Merge Down | Merge Down / Merge Layers / Merge Group / Merge Clipping Mask, by what is selected |
| Ctrl+B / I / U, Ctrl+Shift+> / < while editing text | bold, italic, underline, size | Shift+Ctrl+B / I / U, Shift+Ctrl+. / , (and the rest of Photoshop's type keys) |
| digits, Shift+digits, /, \\, Shift+=, Shift+-, Alt+[ ] , ., Shift+Alt+letters | (none) | layer opacity and fill, lock transparency, mask overlay, blend modes, layer navigation (they never act while a text field has focus) |
| Alt+Shift+Ctrl+M, Alt+Shift+Ctrl+N, Alt+Ctrl+E, Alt+Ctrl+; | (none) | Menus…, New Layer without the dialog, Stamp Layers, Lock Guides |
| Alt+Ctrl+L / M / U / B | (none) | Levels, Curves, Hue/Saturation, Color Balance with the last-used values |

Six existing browser-test lines that pressed Ctrl+F for Last Filter now press Alt+Ctrl+F.

**Matching on every keyboard.** Shortcuts with Alt or Shift are matched by the physical key when the key typed is not a
letter or digit, so on macOS Option combinations work although Option changes the typed character (Option+[ types “):
Alt+[, Alt+], Alt+, , Alt+., Alt+\\ and the Shift+Alt letter keys all work. A letter always means the letter typed, on
every layout (on AZERTY, Ctrl+Alt+Z is Ctrl+Alt+Z, not the key in the US Z position). Plain keys still go by the character they type: on a keyboard where /
or \\ needs Shift (German, for example), the plain / and \\ shortcuts do not fire. On Windows and Linux, Shift+Alt+letter
no longer opens a menu by its mnemonic: Pigment takes the key for the blend-mode shortcut.

### Menus

- A new **Type** menu between Layer and Select: Panels (Character, Paragraph), Orientation, Text on Path, Release from
  Path, Flip Text on Path, Edit Text, Rasterize Type Layer. Layer > Type and Layer > Edit Text moved there.
- New items, disabled until their feature lands: Edit > Toggle Last State, Search…, Paste Special > Paste Without
  Formatting, Menus…; Image > Adjustments and Layer > New Adjustment Layer > Color and Vibrance…, Clarity and Dehaze…,
  Grain…; Layer > Layer Style > Create Layers, Hide All Effects, Scale Effects…; Layer > Vector Mask; Layer > Rasterize
  > Type, Shape, Fill Content, Vector Mask, Smart Object; Layer > Arrange > Reverse; Layer > Distribute by edges and
  centres; Layer > Lock Layers…, Lock All Layers in Group…; Select > Similar Layers; View > Show > Smart Guides; View >
  Pattern Preview; View > Snap To; View > Guides (Lock Guides, Clear Canvas / Selected Artboard / Selected Guides, New
  Guide…, New Guide Layout…, New Guides From Shape, Edit Selected Guides…); Window > Paragraph, Gradients, Patterns.
- Keyboard Shortcuts… moved to the Edit menu (the Help item stays, without a key). Define Pattern, New Group and
  Duplicate Layer gained "…". New Guide… and Clear Guides moved into View > Guides.
- Toggle Developer Tools (development builds) is F12 on macOS too.

### Behaviour

- `.pigment` files are written as version 3 (guides with ids and colours in a document store, rich text, vector masks,
  blending options, mask density and feather). Pigment 0.3 still opens them: it reads the plain guides and each text
  layer's first style (guide colours and other formatting are lost there). Version 2 files open unchanged, their text
  laid out exactly as 0.3 did.
- New Guide and Clear Guides commit a running Free Transform first, and are refused inside Blur Gallery, Select and
  Mask and Content-Aware Scale (0.3 let them through). Closing the window cancels a running Free Transform and the
  on-canvas workspaces before the first "Save changes?" question. Select and Mask answers Toggle Last State with its own
  undo.
- Moving, Canvas Size, Crop, Convert to Layers and placing a smart object keep a live shape's parameters with the shape
  (0.3 left them behind outside the path tools). Image Size and Convert to Layers also scale effect spread, choke,
  soften and the pattern overlay scale.
- Holding Ctrl/Cmd while dragging with the Move tool turns snapping off.
- New Fill Layer > Pattern without a pattern stops instead of only warning. Gradient Fill edits keep midpoints and
  opacity stops.
- The Layer Style dialog no longer rounds opacities to whole percents when another field changes.
- Preferences: the grid spacing is in a new "Guides, Grid & Slices" section.
- A settings file or browser storage that cannot be written shows one error toast ("Settings could not be saved…")
  instead of a console message only.
- Ctrl+E runs Merge Down with one layer selected, as before; an action records it as Merge Down.
- Layer > Distribute by edges answers "Not available yet" until the Layer menu work lands.

### PSD in 0.4 (until psd-layers and psd-text, 0.5)

- Masks: a layer's raster mask is written with its density, feather and an enabled vector mask baked in, so Photoshop
  shows what Pigment shows; a layer with only a vector mask gets a raster mask. A disabled raster mask without a
  vector mask is written disabled, as in 0.3.
- Fill opacity and Blend If (the layer record's blending ranges, for every layer, adjustment layers included) are
  written and read. Knockout, the channel restriction and the five check boxes are not written, and layer effects are
  not written at all (as in 0.3): the merged image is right, the layer in Photoshop is not. Saving says how many layers
  lost their effects or Blending Options.
- Text: besides 0.3's family, size, colour, underline, leading and tracking, PSD text gets faux bold and italic,
  strikethrough, caps, baseline shift, scales, auto kerning, the justifications, the box size and the first baseline,
  and Pigment reads them back when it opens the file. A
  text layer with formatting PSD text cannot hold yet (several styles in one layer, a text stroke, attributes outside
  that list) is written as pixels, with one note per save ("N text layers with formatting PSD text cannot hold yet were
  saved as pixels"). 0.3 wrote a stroked text layer as text without its stroke.
- Adjustments: Hue/Saturation with its colour ranges and their bounds (Colorize is not written, with a notice);
  Gradient Map with its midpoints, transparency, smoothness, dither and interpolation method; Levels and Curves only in
  RGB. Color and Vibrance, Clarity and Dehaze and Grain have no PSD adjustment: they are written as hidden empty
  layers, and saving says so.
- Guides are written and read (image resource 1032); the ruler origin and guides above or left of the canvas are not,
  with a notice.

### Adjustment parameters that change shape

- Hue/Saturation gains colour ranges (`ranges`, at most six) besides the Master values; a 0.3 single-range layer
  opens as Master 0 plus that range with Photoshop's default bounds. 16 and 32-bit documents apply layers with ranges
  through the 8-bit path.
- Levels and Curves gain a channel space (RGB, Gray, CMYK, Lab) and Curves a drawn (pencil) curve; documents at 16 and
  32 bits apply those through the 8-bit path; RGB curves and levels stay exact.
- Gradient Map takes the full gradient (midpoints, opacity stops, smoothness, Reverse, Dither) and stays exact at 16
  and 32 bits. Old Gradient Map layers render as before (an 8-bit difference of at most one level on some reversed
  gradients and where two stops share a position).
- Adjustment dialogs open with the defaults (Photoshop's behaviour); Alt+Ctrl+L, M, U and B reopen Levels, Curves,
  Hue/Saturation and Color Balance with the last values (adjust-tonal).

## Type: the HarfBuzz type engine

- New: HarfBuzz text shaping and glyph-outline rendering for every text layer whose fonts are installed (harfbuzzjs
  1.6.4, MIT, built into the app at install time by `scripts/vendor/harfbuzz.mjs`).
- New: several character formats and paragraph formats in one text layer are laid out and drawn by the engine; text
  boxes have a height and report overflow.
- New: tracking in 1/1000 em that keeps kerning, ligatures and complex scripts; manual kerning; super- and subscript
  and small caps from the font (real small capitals when the font has them).
- New: colour fonts and emoji drawn in colour; characters missing from a font fall back to another installed font.
- New: text on a path follows the shaped glyphs (kerning, ligatures, accents and emoji sequences survive on a path).
- Changed: installed fonts are read from the system (desktop app) or, in the browser, after the font permission is
  granted. Missing Arial, Helvetica, Times New Roman, Courier New, Calibri and Cambria use their metric-compatible
  substitutes, as Linux does.
- Changed: with mixed sizes, each line is placed below the previous baseline by its own leading (Photoshop's rule).
  Text with one size and one leading is placed exactly as in 0.3; the first baseline is still 0.8 × the size below
  the top of the box.
- Changed: trailing spaces at the end of a line no longer count towards its width (they hang past the box edge, as
  in Photoshop), when the HarfBuzz engine draws the layer.
- Changed: underline and strikethrough take their position and thickness from the font when it is installed.
- Changed: Pigment needs `npm install` (or `npm ci`) to have run so that `src/renderer/vendor/harfbuzz/` exists. Without
  it, all text is drawn by the Canvas engine of 0.3 and a warning is logged.

### Known gaps

- Right-to-left text (Arabic, Hebrew) is shaped right to left inside each run, but a paragraph that mixes directions
  is not reordered as a whole (no Unicode bidirectional algorithm across runs), and the caret inside right-to-left text
  stands on the left edge of each character. Bidirectional layout belongs to type-international.
- OpenType-SVG colour glyphs draw with the font's outline glyphs: Chromium's text drawing does not paint SVG glyphs.
- Variable fonts are drawn at their default instance; named instances and axes come with type-fonts.
- In the browser build without the font permission, every layer is drawn by the Canvas engine (as in 0.3), unless a
  font file is added through `window.__pigmentTest.addFont` (tests) or, later, type-fonts.
- A font collection (.ttc) is shaped and drawn from its outlines, but its colour glyphs and its fallback text use the
  system's copy of the family through CSS (the collection's bytes cannot be handed to the browser face by face).
- Vertical text (Vertical Type tool) stays 0.3's rotated horizontal layout; stacked vertical text keeps 0.3's layout
  (now per grapheme cluster, so an emoji sequence or an accented letter stays one stacked glyph).

## Type: editing text

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

### Known gaps

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

## Type: the Character panel

- The Character panel works on the selected characters while editing (0.3: always the whole text), on all selected
  text layers at once as one undo step, or on the defaults for new text. With a text cursor and no selection a change
  applies to what you type next (0.3: to the whole text).
- New in the Character panel: leading with Auto, kerning (Metrics, Optical, 0, manual), tracking in 1/1000 em (0.3:
  letter spacing in px), vertical and horizontal scale, baseline shift, Faux Bold, Faux Italic, All Caps, Small Caps,
  Superscript, Subscript, Strikethrough, language, anti-aliasing, Fractional Widths, System Layout, No Break, Reset
  Character and a panel menu.
- Alignment moved out of the Character panel to the Paragraph panel (as in Photoshop); the options bar keeps it.
- Type units: Preferences > Type Units and the panel menu choose pixels (the default), points or millimetres for type
  sizes (new setting `type.unit`).
- The options bar's size field shows the type unit and has a list of sizes (6 to 72) and a draggable icon.
- The Properties panel's text section is editable (0.3: a summary).
- New text starts with the character settings last chosen in the panel (stored in `type.char`). Underline, stroke and
  letter spacing stored by 0.3's panel in the Type tools' options move there once.
- Optical kerning: the HarfBuzz engine spaces pairs by their outlines when a run's kerning is Optical.

### Known gaps

- Optical kerning needs the font's outlines, which only the HarfBuzz engine has. Where it cannot draw a layer (the
  browser build without installed fonts, a font that has not loaded yet), Optical falls back to Metrics.
- Anti-aliasing is stored with the layer (and written to `.pigment`) but text is still drawn smooth; the other
  methods are drawn from 0.5.
- Typing a unit or arithmetic into a field ("12pt", "10+2") comes with the numeric fields of
  conventions-shortcuts-fields; until then the fields take numbers in the panel's unit.
- Converting paragraph text to point text keeps each paragraph on one line; Photoshop inserts a line break at the end
  of every wrapped line.
- Reset Character keeps the font, size and colour; Photoshop resets them to its defaults too.
- The font family list stays a plain list until the font browser of 0.5.

## Type: the Paragraph panel

- New: the Paragraph panel (Window > Paragraph, Type > Panels > Paragraph Panel) and the Paragraph section of the
  Properties panel; Reset Paragraph, Hyphenation… and Justification… in its menu.
- New: Adobe Single-line and Every-line composers, justification with word spacing, letter spacing and glyph scaling,
  hyphenation in eight languages (TeX patterns from hyph-utf8), Roman Hanging Punctuation, bulleted and numbered lists,
  Unicode line breaking (UAX 14).
- Changed default: new text uses the Every-line Composer and Unicode line breaks (Photoshop's defaults). Paragraph text
  may break differently from 0.3: after a hyphen ("well-" / "known"), between Chinese and Japanese characters, and with
  more even line lengths. Text from Pigment 0.3 documents keeps its lines (it opens with the Single-line Composer and
  "At Spaces Only" line breaks).
- Changed: a word longer than a paragraph box is broken across lines instead of overflowing the box on its own line
  (new text only: 0.3 documents keep their lines).
- Changed: the options bar's panel button (Type tool) toggles: pressed again, it brings back the panel shown before.
- No key changes.

### Known gaps

- Letter spacing is spread over code points on the stub engine and over shaping units on the HarfBuzz engine; with
  ligatures and non-zero letter spacing a justified line can end a fraction of a pixel off the margin.
- Hyphenate Across Column is stored but has no effect (Pigment has no text columns).
- Only the eight bundled languages hyphenate; the patterns of a language other than American English load the first
  time text in it hyphenates, and the text is laid out again when they arrive.
- East Asian Width, which UAX 14 consults for a few quotation and bracket rules, is approximated by the wide and
  fullwidth blocks; Japanese small kana follow the "strict" rule (no line starts with them).
- Lists use the paragraph's left indent for the marker; there is no separate setting for the gap between marker and
  text. Numbering continues over the consecutive numbered paragraphs of one layer only.
- PSD export writes the alignment, including the justified ones; indents, spacing, justification settings,
  hyphenation, composer and list settings stay in .pigment files until psd-text (0.5).

## Layer styles: Blending Options and styles on groups

- New: Blending Options with Advanced Blending (fill opacity, channels, knockout Shallow and Deep, Blend Interior
  Effects as Group, Blend Clipped Layers as Group, Transparency Shapes Layer, Layer Mask Hides Effects, Vector Mask
  Hides Effects) and Blend If with split sliders.
- New: layer styles on groups.
- New: Layer › Layer Style › Create Layers, Hide All Effects / Show All Effects, Scale Effects….
- Changed: a Pass Through group whose `styles` object has every effect switched off now passes through (0.3 isolated it
  as soon as it had a styles object). A Pass Through group with effects or advanced blending options is isolated.
- Changed: the Layer Style dialog opens on groups (0.3 refused them).
- No default and no key changed.

### Known gaps

- PSD keeps Fill and Blend If; knockout, the channel restriction and the check boxes are not written (0.5,
  psd-layers), with a notice. The merged image in the PSD is right.
- 16 and 32 bits per channel: a pixel layer with knockout, Blend If or a channel restriction, or with layer effects, is
  composited through the 8-bit composite when the document is flattened, merged or exported at full depth (adjustment
  layers with Blend If and the base of Merge Clipping Mask stay in float).
- Create Layers cannot match the picture when the layer has knockout, an opacity below 100 % with exterior effects
  (the knocked-out shadow cannot be faded on its own), or a Fill below 100 % with interior effects (the clipped effect
  layers fade with the layer). It then says 'Some aspects of the effects cannot be reproduced with layers', as
  Photoshop does.
- Groups ignore Fill opacity unless they have effects (as 0.3).
- Blend If and knockout run per pixel on the visible part of the layer; very large layers with these options repaint
  more slowly than plain ones (no cost for layers without them).
- Blend If's Underlying Layer reads the composite below the layer inside its group (an isolated group's own content).

## Layer styles: effects, instances and contours

- Layer styles: every Photoshop field of the ten effects (contours, noise, glow technique and gradient fill, Bevel &
  Emboss Contour and Texture and Chisel Soft, gradient and pattern placement, Stroke gradient and pattern fills).
- Layer styles: several instances of Drop Shadow, Inner Shadow, Color Overlay, Gradient Overlay and Stroke.
- Layer styles: the Contour Editor and twelve built-in contours (preset kind `contours`).
- Layer styles: drag in the document to place a shadow, satin, gradient or pattern while the dialog is open.
- Documents from 0.3 render exactly as before: every new field's default gives 0.3's pixels (unit tested bit for
  bit).
- Changed: the Layer Style dialog's Gradient Overlay page uses the gradient picker instead of the Start / End colour
  fields, and the Pattern Overlay page the pattern picker instead of "Use current pattern". A Pattern Overlay now
  stores its pattern as a pattern reference (`{ dataUrl, presetId, name }`) instead of a data URL; 0.3's data URLs
  are still read. Editing a Gradient Overlay stores a v2 gradient (`gradient`) and keeps 0.3's `stops` in step with
  its colours.
- Changed: while the page of a draggable effect is shown, clicks in the document no longer cancel the Layer Style
  dialog (they place the effect); on the other pages a click outside the dialog cancels it as before.
- Changed: Layer › Layer Style › (effect) toggling and the fx menu's check marks count every instance of an effect.
- No new keys and no changed defaults. No settings are written (the `styles` namespace stays empty).

### Known gaps

- Dragging a shadow whose **Use global light** is on sets that effect's own angle and turns Use global light off for
  it; Photoshop moves the document's global light instead (and with it every effect that uses it).
- **Create Layers** (Layer › Layer Style › Create Layers, layer-style-blending) gets exact parts from `splitEffects`,
  except for effects with the Dissolve blend mode: their speckles are drawn again by the layer they become.
- Stroke: no Overprint option; Shape Burst runs across the stroke only (Photoshop's Shape Burst of a Gradient Overlay
  is not offered there, as in Photoshop).
- Contour presets are not yet imported from or exported to Photoshop's `.shc` files (preset-files-manager, 0.5).
- The Layer Style dialog has no "Make Default" button and no Styles page (presets-panels, 0.5).
- PSD export does not write layer effects, as in 0.3 (the merged image is right, and saving says how many layers lost
  them); PSD files are opened without their effects. psd-layers (0.5) maps them.

## Adjustments: Levels, Curves and the tonal dialogs

- Levels: input and output sliders with triangles, the clipping display with Alt-drag, black, grey and white point
  eyedroppers, Auto with Auto Color Correction Options, presets with Photoshop's .alv files, and channels in Gray,
  CMYK and Lab documents.
- Curves: pencil (drawn) curves and Smooth, black and white point sliders with Show Clipping, eyedroppers, the
  on-image tool, Curve Display Options, presets with Photoshop's .acv files, Auto and its options, channels in Gray,
  CMYK and Lab documents.
- Exposure eyedroppers; Threshold histogram and slider; Brightness/Contrast Auto.
- Equalize asks about the selection (selected area only, or the entire image based on it).
- Auto Color Correction Options, with Save as defaults for the Auto buttons and Image › Auto Tone / Contrast / Color.
- Adjustment presets for Levels, Curves, Exposure, Brightness/Contrast and Threshold: built-in lists, save, load,
  save to file, rename, delete, reset.
- New keys: Alt+Ctrl+L / M / U / B open Levels, Curves, Hue/Saturation and Color Balance with the last-used values.
- **Changed:** Image › Adjustments dialogs open with the default settings instead of the last-used ones (Photoshop's
  behaviour), except Shadows/Highlights, Replace Color, Match Color, HDR Toning and Color Lookup, which keep their last
  settings. Use the Alt+Ctrl keys above for the last values.
- **Changed:** the Levels dialog's Auto button moved from beside the Channel menu to the tool row under the editor and
  uses the Auto Color Correction Options (by default Enhance Per Channel Contrast at 0.1 % clipping, which is what 0.3's
  Auto did). The Curves dialog's own "Preset…" menu is replaced by the preset menu above the editor (the same curves,
  under Photoshop's names, plus more).
- **Changed:** Levels and Curves are drawn by the same code as before in RGB; their settings now carry a channel space
  (`space`), and an action or document saved by 0.4 with Levels or Curves in Gray, CMYK or Lab space, or with a drawn
  curve, is not understood by 0.3. 16 and 32-bit documents apply those (not RGB curves and levels) at 8 bits.
- Equalize run from an action recorded with a selection replays the choice made (`{ scope }`).

### Known gaps

- The clipping display (Alt-drag in Levels, Show Clipping in Curves) works in the dialogs; the Properties panel's
  editors do not show it yet, because the panel section (`lib/properties/adjustment.js`, adjust-color's) does not pass
  the preview hook the dialog passes (`clip`). The integrator or adjust-color can pass it.
- Levels' and Curves' output in the CMYK and Lab spaces is computed from the document's RGB pixels with Pigment's naive
  CMYK conversion and sRGB Lab, so it matches Photoshop only roughly (Pigment has no colour management).
- In 16 and 32-bit documents, a Levels or Curves layer in the CMYK or Lab space sends flattening, merging and
  full-depth exports through the 8-bit composite.
- Built-in preset values approximate Photoshop's (Adobe's numbers are not published).
- Auto Color Correction Options cannot be opened from the menus without a dialog (Photoshop has none either).
- The preset menu groups presets that come in groups (from a .pigment-presets file), but has no command to make a
  group or move a preset into one; that is the Preset Manager's job (0.5).

## Adjustments: Hue/Saturation and the colour dialogs

- New adjustments: Color and Vibrance, Clarity and Dehaze, Grain (adjustment layers; enabled in Image > Adjustments,
  Layer > New Adjustment Layer and the Adjustments panel).
- Hue/Saturation edits several colour ranges at once, with movable range bounds, range eyedroppers, the on-image tool
  and presets. Its parameters gain `ranges` (default `[]`); 0.3's single-range layers open as Master plus that range
  and render as before. 16 and 32-bit documents apply layers with ranges through the 8-bit path.
- Gradient Map gains `dither` (default false) and the full gradient field (Gradient Editor, presets, method).
- Shadows/Highlights gains `shadowTone`, `highlightTone` (50), `shadowRadius`, `highlightRadius` (null: `radius`),
  `color`, `midtone`, `blackClip`, `whiteClip` (0). Without them a 0.3 setting gives 0.3's result. **Changed
  default:** the first Shadows/Highlights dialog starts with Photoshop's settings, including Color +20 and 0.01 %
  clipping (0.3: Shadows 35 % only).
- Photo Filter has the Filter menu; Channel Mixer shows the total; Selective Color has presets.
- Preset files read and written: .ahu (Hue/Saturation), .cha (Channel Mixer), .asv (Selective Color), .blw (Black &
  White).
- HDR Toning has presets; its "flatten first?" question is unchanged.
- New tool: Adjustment Brush, in the Brush group (after Color Replacement). Shift+B now cycles through four tools.
- New command `layer:adjustment-preset` (the Adjustments panel's presets; actions record it).
- The Properties panel's adjustment toolbar has View Previous State.
- PSD: as in 0.3, Hue/Saturation writes its Master only; Color and Vibrance, Clarity and Dehaze and Grain have no PSD
  adjustment and are written as hidden placeholders (the merged image is right).

### Known gaps

- Photoshop's range bars let the four bounds overlap the next range's; here a range stays under 360 degrees and its
  bounds stay in order.
- Black & White's Auto, the Channel Mixer and HDR Toning presets and the Photoshop-like built-ins approximate
  Photoshop's values (the names are Photoshop's).
- .blw files are read by parsing their descriptor; files Photoshop writes with keys this reader does not know are read
  for the six weights and the tint only. HDR Toning (.hdt) and Shadows/Highlights (.shh) files are not read yet.
- Clarity and Dehaze use fixed neighbourhoods (about 24 px), not one relative to the image size as Camera Raw does, so
  that a partial repaint matches a full one; Dehaze assumes white haze.
- The Adjustments panel presets are built-in only (no user presets), and hovering a preset does not preview it.
- The Properties panel does not show Levels' and Curves' clipping display (adjust-tonal's editors offer it in the
  dialog).
- PSD has no adjustment for the three new kinds: they are saved as hidden empty layers, with a notice (psd-layers,
  0.5). Hue/Saturation's Colorize is not saved to PSD either.

## Gradients

- New: the five interpolation methods (Perceptual, Linear, Classic, Smooth, Stripes) and noise gradients, for every
  gradient (tool, fill layers, shapes, Gradient Map, Gradient Overlay, Stroke).
- New: the Gradient Editor (stops, midpoints, smoothness, presets with New, Save, Import and Export), the gradient
  picker with preset groups, the Gradients panel (Window > Gradients), live gradients (the Gradient tool's Gradient
  mode), and Gradient Fill layers with Method, Dither, Offset and the Properties fill section.
- Changed: the Gradient tool's options bar shows the gradient as a bar with a picker instead of a menu of eight names;
  its 0.3 choice is kept (the preset it named). The Gradient tool's default mode is **Classic**, Pigment 0.3's
  behaviour (Photoshop's default is Gradient).
- Changed: Gradient Fill layers made in 0.4 store the full gradient (midpoints, opacity stops, method). New Fill Layer >
  Gradient starts from the Gradient tool's gradient and style (0.3: foreground to background, linear).
- Changed: 0.3's eight gradient presets are in the Basics and "Spectrums and Metals" groups, next to new built-ins.
- Unchanged: 0.3 documents and 0.3-style gradients (classic, no dither) render exactly as before.
- Gradients made in 0.4 with a method other than Classic, with Dither, or noise, are drawn pixel by pixel: a Gradient
  Fill layer of 2000 × 1500 takes about 0.1 s to draw when it changes (it is cached afterwards); while you drag its
  on-canvas widget a fast preview is shown.

### Known gaps

- Photoshop `.grd` files are not read or written yet (preset-files-manager, 0.5). Import / Export use Pigment's
  `.pigment-presets` files.
- Gradient Fill layers are measured against the document; "Align with Layer" applies to shapes and effects only.
- The on-canvas widget edits colour stops; opacity stops and midpoints are edited in the Gradient Editor.
- The Gradients panel tab is added after the existing tabs of its group (Color, Swatches, Brushes, Gradients), not
  directly after Swatches.

## Patterns

- New: the pattern library, kept with the presets (persistent), with twelve built-in patterns; the Patterns panel
  (Window › Patterns); the pattern picker wherever a pattern is chosen.
- New: Edit › Define Pattern… asks for the pattern's name (the Pattern Name dialog). From an action or a script it
  takes the recorded name.
- New: Edit › Fill › Pattern has the Custom Pattern picker and the Scripted Patterns (Brick Fill, Cross Weave, Place
  Along Path, Random Fill, Spiral, Symmetry Fill).
- New: Pattern Fill layers have Angle, Link with Layer, Snap to Origin and can be moved by dragging in the Pattern Fill
  dialog; the Properties panel edits them.
- New: View › Pattern Preview.
- New: drag a pattern from the Patterns panel onto the canvas or a layer row to make a Pattern Fill layer.
- New: Bitmap's Custom Pattern can use a pattern of the library.
- Changed: there is always a current pattern (the first built-in until you pick or define one; 0.3 had none until
  Define Pattern). So Fill › Pattern, the Paint Bucket's pattern source, the Pattern Stamp and New Fill Layer › Pattern
  work without defining a pattern first. The current pattern is remembered across restarts (`settings.patterns.current`).
- Changed: the Paint Bucket's pattern tiles start at the document's origin (0.3 started them at the corner of the
  filled area), as Photoshop and Edit › Fill do.
- Changed: Layer › New Fill Layer › Pattern opens the Pattern Fill dialog on the new layer (0.3 made the layer
  without a dialog).
- Changed: patterns no longer disappear when Pigment closes, and the library is no longer limited to the last 24.
- No default key changed.

### Known gaps

- An action that recorded Layer › New Fill Layer › Pattern with a pattern that is no longer in the library replays
  with the current pattern.
- Bitmap › Custom Pattern replayed from an action in a new session, before the pattern's pixels have decoded, falls
  back to the fine dither (the conversion in `modes.js` reads the tile synchronously). The Bitmap dialog itself always
  decodes first.
- Photoshop's `.pat` pattern files are not read yet (preset-files-manager, 0.5).
- Scripted Patterns are Pigment's own placements modelled on Photoshop's scripts, not their exact output.

## Guides, rulers and snapping

- Guides have a colour each, can be selected, moved and deleted with the Move tool, and are edited with View › Guides ›
  Edit Selected Guides. New: Lock Guides (Alt+Ctrl+;), Clear Selected Guides, Clear Canvas Guides (was Clear Guides),
  New Guide Layout, New Guides From Shape, Clear Selected Artboard Guides (for artboards, later).
- New Guide asks for the orientation and the colour, takes units, and counts from the ruler origin. An action records
  the guide's colour.
- Guide positions keep two decimals (0.3 rounded guides from the rulers and New Guide to whole pixels).
- Rulers: units from the ruler's context menu, a movable ruler origin (drag the corner; double-click resets). A
  placed origin follows the image through Image Size, Canvas Size, Rotate, Flip and Crop; the untouched origin stays
  on the document corner.
- Grid: colour, style, Gridline Every with a unit and Subdivisions in Preferences › Guides, Grid & Slices. The grid
  now draws its subdivisions (the default is 4, so a 50 px grid shows fainter lines every 12.5 px) and starts at the
  ruler origin.
- Snapping (behaviour change): 0.3 snapped only Move tool drags, to the document edges and centre and to guides,
  taking the first target found. Now every placing tool snaps (marquee, crop, shapes, pen, path selection, Free
  Transform, type box, gradient, guides), to guides, the grid, other layers and the document per View › Snap To, and
  the nearest target wins. The Move tool snaps the layer's visible content instead of its whole canvas, and a
  Shift-constrained Move snaps along its axis only.
- Smart Guides are on by default (settings.guides.smartGuides, declared by the skeleton): alignment lines, equal
  spacing (also a snap target) and Ctrl-hover distances with the Move tool.
- Holding Ctrl/Cmd while dragging turns snapping off (from the skeleton).
- Preferences: the "Guides, Grid & Slices" section replaces the skeleton's (its grid spacing field is now "Gridline
  every" with a unit).

### Known gaps

- Artboard guides, slices and the slice preferences (colour, numbers) arrive with artboards (0.9) and slices (0.10);
  Snap To › Artboards and Slices have no targets until then.
- The Properties panel's transform section and the Free Transform options bar show X / Y from the ruler origin but in
  pixels, not in the ruler units (they are skeleton files; the integrator can switch them to `app.rulers.format`).
- The rulers do not follow a rotated view (as in 0.3).
- Smart Guides show for moves (Move tool, Free Transform, the type box) and for points that snap to a layer edge;
  Photoshop's Smart Guides for paths while they are drawn, and its angle readouts, are not there.
- Photoshop's Edit › Preferences "Show Smart Guides for…" options and the per-guide lock are not there.
- A guide drag is not a session: a key command during the drag does not cancel it.

## Vector masks, mask density and feather

- New: vector masks (Layer › Vector Mask › Reveal All, Hide All, Current Path, Delete, Disable / Enable, Link /
  Unlink; Layer › Rasterize › Vector Mask), edited with the path tools, shown in the Layers and Paths panels.
- New: Density and Feather for layer masks and vector masks, non-destructive (Properties panel).
- New: the mask overlay (rubylith) on **\\**, with Overlay Options (colour, opacity) and a Masks section in Preferences
  (`settings.masks.overlayColor`, default `#ff0000`; `settings.masks.overlayOpacity`, default 0.5).
- New: Mask and Shape buttons in the options bar of the Path Selection and Direct Selection tools; Make Vector Mask and
  Make Shape Layer in the Paths panel.
- New: Select and Mask…, Color Range… and Invert for the layer mask in the Properties panel.
- Changed: the mask overlay is drawn in the colour and opacity of the preferences (0.3: red at 50 %, the same default);
  the "mask alone" view and the overlay show the mask with its density and feather.
- Changed: the Properties mask section is now titled per mask kind ("Layer Mask", "Vector Mask") and has the new
  controls; Invert in it is recorded as `layer:mask-properties { part: 'raster', invert: true }` (0.3 did not go
  through a command).
- New command `layer:mask-properties` (`{ part: 'raster' | 'vector', density?, feather?, invert?, fromSelection?,
  merge? }`), recorded by actions: what the Properties sliders and buttons run.
- No key changes in this package (\\ for the overlay is the skeleton's).

### Known gaps

- Select and Mask from Properties starts the workspace from the layer mask and writes its result back as the layer
  mask; it is recorded as Select and Mask. Color Range from Properties makes two History steps (the selection, then the
  mask from it).
- Rename on the vector mask's Paths row renames the layer (the row's name is the layer's).
- Vector masks are not read from PSD files (as in 0.3) and are written baked (above).
- On large documents a feathered mask is refined incrementally while you paint on it, and for a moment the previous
  result may show while a path with feather is dragged (a reduced preview); the final result is exact.
- Mask density and feather apply to the layer mask of adjustment and fill layers too; Photoshop's Properties offers
  the same.

## Live shapes

- Shape tools' options bar: the "Fill (foreground)" and "Stroke" check boxes, the stroke colour and the alignment menu
  are replaced by Photoshop's Fill and Stroke swatches and the Stroke Options menu. The stored option keys are the same
  (`fillOn`, `strokeOn`, `strokeColor`, `strokeWidth`, `strokeAlign`), plus `fillPaint`, `strokePaint`, `strokeCap`,
  `strokeJoin` and `strokeDash`. A fill left at its default still uses the foreground colour.
- The Rectangle tool has a Radius field (default 0). The Polygon tool's Star check box and Indent field are replaced by
  the Star ratio in the gear menu; a star set in 0.3 is read as its ratio (100 − indent).
- The Line tool's arrowheads moved into the gear menu. A new arrowhead uses Photoshop's defaults: width 500 %, length
  1000 % of the weight (0.3 drew 5 × the weight, at least 6 px). Lines drawn in 0.3 keep their heads.
- Custom shapes are live shapes (`shapeKind: 'custom'`, the shape is a preset of the Shapes presets). Shift-drag keeps
  the custom shape's own proportions (0.3 drew it in a square). Custom shapes drawn in 0.3 stay plain paths.
- Clicking the canvas with a shape tool opens the shape's Create dialog with more fields. The Line tool still does
  nothing on a click.
- New shapes are written in the 0.4 form (rectangles: `radii` and `angle`; polygons: `starRatio` and the smoothing
  fields; lines: arrowheads as `{ width, length, concavity }`). 0.3 shapes are read without being rewritten until you edit
  them.
- A shape's render box is padded only as far as its stroke reaches: half the width for a centred stroke, the width
  outside, nothing inside, more for miter corners and square caps. 0.3 padded every stroke by its full width, so wide
  outside strokes and long miters were cut off.
- Miter corners use Photoshop's miter limit of 4 (0.3 drew with the browser's 10).
- Dashes are measured in stroke widths. In 0.3 they were in pixels, but no 0.3 tool could make one.
- A shape's gradient and pattern are placed against the shape's own bounds. 0.3 used the render box, which grew with
  the stroke.
- Free Transform, Image Size, Canvas Size, Crop, Rotate Canvas and placing into a smart object keep a shape live (0.3
  left its parameters behind after anything but a move). Rotation goes into the angle and scale into the size; skew and
  perspective make a path.
- Pattern fills and strokes of shapes keep their pixels in the document (`.pigment` files, actions), so they survive a
  save and reopen.

### Known gaps

- Corner widgets show with the shape tools and the Path Selection tool, not yet with the Move tool's transform
  controls.
- A non-uniform scale rounds corner radii by the smaller of the two factors, so the corners stay circular.
- The Line tool has no Create dialog (Photoshop has none either).
- PSD export writes shapes as pixels (as 0.3). The live parameters and stroke options go to PSD with psd-layers (0.5).
- The Stroke dialog has no "Align dashes to corners and path ends" option.

## The Layers panel

- Layers panel: Opacity and Fill are scrubby fields that change every selected layer, as one History step per drag.
- Layers panel: the blend-mode menu previews each mode on the canvas while you hover it; ↑ / ↓ step through the modes.
- Layers panel: drag several rows at once; Alt-drag copies; drop rows on New Layer to duplicate or on Delete to delete.
- Layers panel: drag down the eye column to show or hide many layers in one step.
- Layers panel: Alt-click the line between two layers to make or release a clipping mask.
- Layers panel: layer effects are listed under each layer with their own eyes; drag them between layers.
- Layers panel: a panel menu with Panel Options (thumbnail size and contents, effects, "copy" names) and Collapse All
  Groups.
- Layers panel: New Layer Ctrl/Cmd-click adds below the current layer, Alt-click opens the dialog; New Group Alt-click
  opens its dialog; Add Mask adds a vector mask on a layer that already has a layer mask, Alt-click hides.
- Find Layers: Selected type; Not locked, Vector mask and Advanced blending attributes.
- Isolate Layers: the samplers (Eyedropper, Magic Wand, Paint Bucket, Info and others) see only the isolated layers.
- **Changed default:** layer thumbnails show the layer's own pixels (Panel Options › Thumbnail Contents: Layer Bounds,
  `settings.layersPanel.thumbBounds: 'layer'`). Earlier versions showed the whole canvas; choose Entire Document for that.
- **Changed:** the blend-mode drop-down of the Layers panel is a button with its own list (so it can preview): it no
  longer is a `<select>`; it acts on every selected layer instead of the active one.
- **Changed:** Opacity, Fill and the lock buttons act on every selected layer, not only the active one.
- **Changed:** the row context menu's Merge Down is Merge Down, Merge Layers or Merge Group as Ctrl+E does
  (`layer:merge`), and Create Clipping Mask acts on the row's layer.
- **Changed:** a styled layer shows its effects as rows under it (Panel Options › Show effects under the layers turns
  that off).
- No key changed.

### Known gaps

- **Use Default Masks on Fill Layers** (`settings.layersPanel.fillDefaultMasks`, declared by the skeleton) is not in
  Panel Options: new fill and adjustment layers are made by `layer-ops.js` (finish-layer-menu), which does not add a
  mask in 0.4. Wired by the integrator or in 0.5.
- An effect switched off with its eye in the Layers panel keeps `present: true` (PSD's flag for "listed") so that its
  row stays; an effect switched off in the Layer Style dialog is no longer listed. Photoshop lists both.
- While isolated, a clipped layer whose base is hidden by the isolation is drawn unclipped on the canvas (0.3); merged
  sampling skips the base and so does not see the clipped layer.
- No Smart Object or Artboard filter types (0.4 has only embedded smart objects and no artboards).
- Expanding and collapsing groups and effect lists is not recorded in History (as in Photoshop); the group state is
  saved in `.pigment` files, the effects list state is not.
- With several selected layers in different modes the blend-mode button shows "—"; the arrow keys step from the active
  layer's mode and apply the result to all of them.

## The Layer menu

- The New Layer, New Group and Duplicate Layer dialogs (with destination document); New Fill Layer asks the New Layer
  questions first. The dialogs open only from the menu and the keys; code, actions and the Layers panel create without
  asking, as before.
- Opacity, Fill, blend mode, locks and Hide / Show Layers (new key **Ctrl+,**; macOS Cmd+, , which was Settings) act on
  every selected layer, as one History step. Before 0.4 they changed the active layer only.
- **Ctrl+E** is Merge Down / Merge Layers / Merge Group by context (it was always Merge Down), and Merge Clipping Mask
  on the base of a clipping mask. `layer:merge-down` keeps its meaning.
- New keys: digits and Shift+digits (opacity, fill), `/` (lock transparency), Shift+Alt+letters (blend modes),
  Shift+= / Shift+- (next / previous blend mode), Alt+[ ] , . and Shift+Alt+[ ] (layer navigation), Alt+Shift+Ctrl+E
  (Stamp Visible, was Quick Export), Alt+Ctrl+E (Stamp Layers), Alt+Shift+Ctrl+N (New Layer without the dialog),
  Ctrl+/ (Lock Layers…, was Keyboard Shortcuts). `/` depends on the keyboard layout: on a German keyboard it needs
  Shift and does not match.
- Layer › Arrange works on every selected layer; new Reverse. Layer › Distribute has every edge; **Distribute
  Horizontally / Vertically now make the gaps equal** (before 0.4 they spread the centres, which is now Horizontal /
  Vertical Centers; `layer:distribute` without an argument still spreads horizontal centres).
- Align and Distribute move linked layers along and leave the Background and position-locked layers in place.
- Lock Layers… and Lock All Layers in Group…; Stamp Visible, Stamp Layers; Select › Similar Layers.
- Layer › Rasterize honours Type / Shape / Fill Content and the selected layers.
- **The Background stays at the bottom** (it can no longer be moved up, grouped, or have layers put below it) and its
  opacity, fill, blend mode, masks and effects are locked; a layer mask converts it to "Layer 0". Renaming it makes it
  an ordinary layer.
- Duplicate Layer honours "Add copy to Copied Layers and Groups" (`settings.layersPanel.addCopy`).

### Known gaps

- Merge Group composites at 8 bits per channel in 16/32-bit documents. Merge Down, Merge Layers, Merge Visible,
  Merge Clipping Mask, the stamps and Flatten Image keep the float path of lib/depth.js, except for layers that need the
  8-bit composite (layer effects, knockout, Blend If on a pixel layer, blend modes other than Normal, Multiply and
  Screen, layers clipped to an adjustment layer).
- `layer:merge-down` run by its command id (a script, an old action) on a clipping base still merges the base into the
  layer below, its 0.3 meaning; Ctrl+E, the menus and the Layers panel run Merge Clipping Mask there.
- The Move tool and Free Transform still move a new document's Background (Photoshop converts it to a layer first). A
  two-digit opacity typed quickly is recorded by actions as two steps.
- The digits, `/`, Shift+= / Shift+- and the blend-mode keys always act on layers; painting tools' own opacity, flow and
  mode keys come with brush-painting-behaviours (0.5). While a painting tool is active the digits do nothing.
- Duplicate Layer into another document keeps the layer's position; it does not centre it in a document of another
  size, and it does not convert colours between image modes.
- The Background is still recognised by its name and place (0.3); a persisted background flag is psd-layers' (0.5).
- Vector masks on the Background are refused by masks-vector-masks (Photoshop converts the layer, as Pigment does for
  layer masks).

## Photoshop conventions: Search, temporary tools, numeric fields, dialogs

- Number fields evaluate arithmetic (`100+50`), percentages and units, step with Shift+arrow (×10) and the wheel, and
  their labels scrub.
- Holding Ctrl (Cmd) gives the Move tool and holding Alt with a painting tool the Eyedropper; holding a tool key
  switches to it only while held. Preferences > Tools and shortcuts turns this off.
- Ctrl+Space and Alt+Space zoom in and out (0.3 panned with Space whatever the modifiers).
- New preference: "Use Shift key for tool switch" (on by default, Pigment's 0.3 behaviour).
- Dialogs can be moved and remember where; the canvas under them is not dimmed any more and can be zoomed and panned;
  a click beside a dialog over a document no longer cancels it.
- Holding Alt in a dialog turns Cancel into Reset.
- Edit > Toggle Last State (Alt+Ctrl+Z) and Edit > Search… (Ctrl+F) work.

### Known gaps

- Search does not list open documents, help topics beyond the Help menu's items, or Photoshop's Stock and Learn
  results.
- Typed units need a unit label the field declares (`unit`, `units`, or a `.opt-unit` label right after the input); a
  field without one reads `2in` as inches converted to pixels at the document's resolution.
- Hand-built number inputs in other packages' files (Color, Brushes, Layers, Properties, Warp, Liquify, Lens
  Correction, Content-Aware Scale, Image Size, Preferences, Levels, Curves, Contour, Blending Options) get arithmetic,
  Shift+arrow, the wheel and label scrubbing from the enhancer, but no popup slider and no unit list of their own.
- The spring-loaded tool key switches the real tool (the options bar shows it while it is held) rather than a
  temporary one.

## Changes made when the packages were integrated

- Justified text closes up its word spaces down to the Justification dialog's Minimum (before, the compression went
  into the letter gaps).
- Hyphenation › Words Longer Than: a word of exactly that many letters is no longer hyphenated (Photoshop's rule).
- A Pattern Fill layer with Link with Layer on keeps its pattern on the layer when the layer is moved, and when Canvas
  Size, Crop or Reveal All shift the document. `.pigment` files keep a Pattern Fill's angle, Link with Layer, origin
  and preset.
- The Pattern Stamp tool has a pattern picker in its options bar (the current pattern until another is picked).
- While a temporary tool is held (Ctrl = Move, Alt = Eyedropper, Ctrl/Alt+Space = Zoom), the canvas shows that tool's
  own marks (the Eyedropper's ring, the Zoom marquee). Clone Stamp, Healing Brush, Dodge, Burn and the Adjustment Brush
  keep Alt for themselves: Alt does not switch them to the Eyedropper.
- The Channels panel's layer-mask row menu has Layer Mask Display Options…
- The new adjustment kinds (Color and Vibrance, Clarity and Dehaze, Grain) follow Color Lookup in the Adjustments
  panel and the Adjustment Brush's list, as in the menus, and have their own icons.
- PSD: a drawn (pencil) Curves channel is written as points sampled from it; Levels or Curves in a Gray, CMYK or Lab
  channel space are saved without their settings, with a message.
- 16 and 32 bits per channel: a layer with advanced blending options (knockout, Blend If, channels) flattens and
  merges through the 8-bit composite, and so do Levels and Curves in the CMYK or Lab space.
- A smart object's contents keep the document's ruler origin.
- Preferences: two sections that save to the same settings (Type and Type Units) no longer overwrite each other.

## Fixed during testing

A cross-feature bug hunt used the 0.4 features together, the way a Photoshop user would, and a review checked its
fixes. What changed for users, by area:

### Type

- PSD files saved by Pigment now reopen with editable text that keeps strikethrough, All Caps / Small Caps, horizontal
  and vertical scale, baseline shift, kerning 'none' and the justified alignments (Justify Last Left/Center/Right,
  Justify All).
- In vertical type, the arrow keys move the caret the way they point: Up and Down move along the column, Left and
  Right to the next and previous column (Shift extends the selection the same way).
- Type commands used without an open text session (Font Size up, Faux Bold, Underline and the like), and the same
  commands on action playback, are each their own History step. Only a repeat of the same command within 1.5 s merges.
- Clicking a fully locked text layer with a Type tool starts new text on top of it, as over a hidden layer, instead of
  refusing, so the letters you type no longer run tool shortcuts such as Q for Quick Mask.
- Actions: making a text layer with the Type tool and drawing a new shape layer with a shape tool are recorded, as Make
  Text Layer and Make Shape Layer steps, and play back; later steps on that layer (Shape Properties, Character,
  Paragraph, styles) work. Faux Bold, Underline, size changes and the other type commands used while typing the new
  text are part of its Make Text Layer step; new text cancelled with Escape leaves no steps behind.

### Layer styles and Blending Options

- Rasterize Layer (type, shape, fill, smart object) keeps the layer's Blending Options (Blend If, channels, knockout),
  so the image no longer changes.
- Rasterize Layer Style keeps Blend If, knockout and the channel restriction live on the new layer. When Blend If or a
  knockout under reduced fill will now also affect the baked effects, a notice says so.
- Clipping masks: a clipped layer no longer thins the base's soft edges where it has no pixels, so text and soft shapes
  keep their anti-aliasing. Painting on or editing a clipped layer is as fast as before that fix: the base is prepared
  once per change of the base, not on every repaint.
- Create Layers keeps restricted channels on the layers it makes, and is exact for interior effects on anti-aliased
  content. Where layers cannot match the picture it warns ('Some aspects of the effects cannot be reproduced with
  layers'); see "Compositing as in Photoshop" below for when that is.
- Layer Style dialog: with Use Global Light ticked, Angle and Altitude show and change the document's Global Light, so
  every effect that uses it moves. Cancel restores it, and OK records it with the style as one undo step.
- Copy, Paste and Clear Layer Style include the blend mode, Fill and advanced blending (Blend If, knockout, channels)
  with the effects, and a layer with only blending options can be copied. Paste Layer Style skips the Background and
  Lock All layers and is disabled when nothing selected can take a style. The Layers panel's context menus offer Copy,
  Paste and Clear Layer Style exactly when Layer › Layer Style does.
- Double-clicking an effect instance in the Layers panel, or choosing Edit from its menu, opens that instance in the
  Layer Style dialog, for example 'Drop Shadow (2 of 2)'.
- Emptying a number field in a dialog form and pressing Tab or OK keeps the previous value instead of storing 0.
- Saving as PSD says how many layers lost their layer effects or Blending Options.

### Adjustments, gradients and fill layers

- Gradient Maps saved as PSD keep their stop positions at every smoothness (Black to White, Spectrum and the other
  smoothness-0 presets used to reopen as a grey map), and Photoshop reads the stop positions correctly.
- Opening a PSD Gradient Map keeps its midpoints, transparency, smoothness and dither.
- OK in the Gradient Editor (or a preset pick) in a Gradient Fill layer's Properties is an undoable 'Edit gradient fill'
  step and marks the document as changed.
- View Previous State in Properties is only a display: saving, duplicating or running any other command first puts the
  layer's real settings back.
- New gradient presets made from a Gradient Fill layer no longer store that layer's style, reverse or position.
  Dropping a gradient preset on a document always places it across that document.
- Cancel in the Gradient Fill or Pattern Fill dialog of Layer › New Fill Layer cancels the whole command: no layer and
  no history entry are left, as with Solid Color.
- In Properties, each adjustment eyedropper pick, preset and Auto is its own undo step; an edit no longer merges into
  the preceding Reset.
- Escape in a number field that applies as you type (Properties adjustment settings, dialog fields) takes back the
  value you typed: the layer returns to its previous setting and no history step is left.
- New Fill Layer from a script or the API with a pattern paint makes a working Pattern Fill. Before, it made a layer
  that drew nothing, logged errors on every repaint and blocked saving the document.

### Shapes, masks, guides and rulers

- Shape layers align, distribute, Free Transform, quick Rotate/Flip and Reveal All by their drawn edges (the path plus
  the stroke). Shapes no longer land 1 to 2 px off, and repeated rotates or flips no longer move them. Align and
  Distribute place a shape by the whole pixels it covers, so an odd centred stroke (1 px, 3 px…) no longer ends half a
  pixel past the canvas edge.
- In Properties, mask Density and Feather changes each get their own History entry. A slider moved right after Add
  Vector Mask or a path move no longer merges into that step.
- Edit Selected Guides no longer moves a guide when you change only its colour.
- Rulers can show Picas (1 pc = 12 pt), from the ruler context menu or Preferences, and position fields take 'pc' or
  'pica'. Setting an unknown ruler unit from a script shows an error instead of being ignored.

### Layers and the Layer menu

- Ctrl+E (Layer › Merge) on the base of a clipping mask is Merge Clipping Mask: the base and its clipped layers become
  one layer, and the picture does not change. The menus say 'Merge Clipping Mask' there. The base's Blend If and
  channel settings stay on the merged layer; when that cannot match (Blend If with layer effects, or Blend Clipped
  Layers as Group off), a notice says so. On an adjustment layer that is a clipping base, it refuses with a message
  instead of turning the adjustment into an empty layer.
- Merge Down and Stamp Layers refuse to write into a layer below whose pixels are locked.
- Lock All also locks the layer's Opacity, Fill, blend mode and layer effects: the panel controls are disabled, and the
  digit keys, the blend-mode keys, Paste and Clear Layer Style leave the layer alone.
- A group that holds a layer locked in position can no longer be moved with the Move tool, the arrow keys or Align.
  Align keeps locked layers in place and aligns the others to the whole selection.
- Shift+digit (Fill) leaves groups alone; they have no Fill.
- Flatten Image asks 'Discard hidden layers?' when the document has hidden layers.
- Each committed change to the Layers panel's Opacity or Fill (Enter, Tab, one scrub) is its own history state. Escape
  in a number field (the Layers panel's Opacity, for example) drops what you typed and shows the field's value again.
- A document made by Duplicate Layer › Document: New asks to be saved when you close it.

### Shortcuts, Search and history

- In the desktop app, menu shortcuts such as Ctrl+E, Ctrl+J and Ctrl+, no longer act on the document while you type in
  a text or number field. Undo, the clipboard keys, Select All and the view and file commands still work.
- Toggle Last State (Alt+Ctrl+Z) after an Undo or a click in the History panel returns to the state you came from.
- Search: typing a command's name and pressing Enter runs that command. 'new layer' no longer runs Undo, 'layers'
  opens the Layers panel, and a menu command wins over a tool or panel with a longer name ('blur' runs Filter › Blur ›
  Blur, 'rotate' Edit › Transform › Rotate, 'gradient' New Fill Layer › Gradient…).

### Files

- PSD: Hue/Saturation colour ranges (with their edited bounds) are saved and read back.
- PSD: guides are saved in the file and come back when it is opened.
- PSD: saving says which adjustment layers have no PSD equivalent (Color and Vibrance, Clarity and Dehaze, Grain) and
  are saved as hidden empty layers. It also notes when Hue/Saturation Colorize, the ruler origin, or guides above or
  left of the canvas are not saved.

## Compositing as in Photoshop

The hunt left three changes to the compositing model for a decision. They are done in 0.4, following Photoshop's
documented behaviour, together with two items deferred from the packages.

### Layer effects blend with the layers below

- Each exterior effect (drop shadow, outer glow, the outer part of a bevel or emboss, the outer part of an outside or
  centred stroke) now blends with the layers below in its own blend mode and opacity, as in Photoshop. A coloured
  Multiply drop shadow darkens what it falls on, and a Screen outer glow does not show on white. Before, the effects
  were blended with the layer first, so a Multiply shadow over grey drew in Normal.
- The layer's own blend mode acts on its content and its interior effects only: a Normal stroke on a Multiply layer
  stays Normal.
- Layer Opacity fades the layer and its effects together, as one, from what lies below.
- Blend If hides the layer's own pixels and its interior effects but leaves the drop shadow, outer glow, outer bevel and
  outer stroke whole. Knockout cuts through for the layer's content after the exterior effects are drawn.
- This holds for every kind of layer (pixel, type, shape, fill, smart object), for groups with effects, clipping bases
  and clipped layers, and in 16-bit documents.
- Layer › Layer Style › Create Layers keeps the picture unchanged when effects use other blend modes, and no longer
  warns because the layer's own mode is not Normal. It still warns for knockout, a layer opacity below 100 % with
  exterior effects, and a Fill below 100 % with interior effects.
- Rasterize Layer Style and Convert to Smart Object keep the look where one layer can (all Normal, or a black Multiply
  shadow). Where they cannot, they say so: 'Some effects blend with the layers below in a mode of their own, which one
  layer cannot keep, so the image changed' (or '…which the smart object cannot keep…').
- Merge Down onto an opaque layer, Merge Visible, Stamp Visible and Flatten Image give exactly what the canvas shows.
- **Changed look:** documents whose effects use other modes than Normal (the default Drop Shadow is Multiply, the
  default Outer Glow Screen) can look different from earlier 0.4 builds and from 0.3; the new look is Photoshop's.
  Documents whose effects and layers are all Normal render exactly as before.

### Blending Options on adjustment layers

- Adjustment layers take Blending Options, as in Photoshop: Layer › Layer Style › Blending Options…, the fx button
  and the Layers panel menu open the Layer Style dialog on an adjustment layer with only the Blending Options page: the
  blend mode, Opacity, Fill, the R, G and B channels and Blend If. Knockout, the five check boxes and Global Light are
  not shown there, and the fx menu lists no effects.
- Blend If on an adjustment layer: This Layer reads the adjusted result and Underlying Layer the image below, with
  split sliders for a smooth fade, so a Curves can act on the highlights only, for example.
- Fill works on adjustment layers and scales the adjustment as Opacity does. Set it in the Layers panel's Fill field,
  on the Blending Options page or with Shift+digit.
- A channel switched off on the Blending Options page leaves that channel of the image unchanged.
- An adjustment layer's blend mode now applies (Curves in Luminosity mode keeps the colours). Before, it could be set
  but was ignored.
- Copy Layer Style works on an adjustment layer that has blending options. Paste Layer Style on an adjustment layer
  applies the blend mode, Fill, Blend If and channels and leaves the effects out (before, it skipped adjustment layers).
- In 16 and 32-bit documents, Merge Down, Merge Visible, Stamp Visible and Flatten Image keep these settings at full
  precision. An adjustment layer in a blend mode other than Normal, Multiply or Screen is composited at 8 bits there.
- PSD files keep Blend If (written and read for every layer) and the Fill of adjustment layers. A channel restriction
  is not saved to PSD, and the save notice says so.
- Adjustment layers that use none of these settings look exactly as before.

### Clipping masks and stamps in 16 and 32 bits

- Clipping masks no longer drop a 16 or 32-bit image to 8 bits. Merge Clipping Mask (Ctrl+E on the base), Merge Down
  of a clipped layer onto its base, Merge Layers, Merge Visible and Flatten Image keep the full precision of the clipped
  layers and their base, with Blend Clipped Layers as Group on or off. In 32-bit documents, highlights above white
  survive.
- Stamp Visible and Stamp Layers keep 16 and 32-bit precision (before, they always made 8-bit pixels).
- 16-bit PNG and TIFF exports of documents with clipping masks, or with groups in Normal, Multiply or Screen, are
  composited at full depth; the export dialog no longer says '8-bit composite' for them.

### Gradient Map interpolation in PSD

- Gradient Map adjustment layers saved as PSD keep their interpolation method. Perceptual, Linear and Smooth maps used
  to reopen as Classic. Pigment writes the codes Photoshop uses, so Photoshop opens them with the right method too.
- PSD files from Photoshop with Perceptual, Linear or Smooth Gradient Maps open with that method. Older files without a
  method open as Classic.

### Faster repaints

- On large documents, selecting another layer, adding a guide or stepping through History no longer recomposites the
  image. An edit to one layer repaints only the area it can affect, and brush strokes (and their undo and redo) repaint
  only the painted area, even under adjustment layers. On a 4000 × 3000 document with 30 layers, a text or shape edit
  went from 5 to 7 s to about half a second, and selecting a layer to about 20 ms.
- An edit high in the stack, such as an adjustment layer's settings, starts from a saved composite of the layers below
  it. Consecutive adjustment layers are applied in one pass, and an all-white adjustment mask is skipped.
- A layer with effects and Blend If is blended only where it has pixels.
- While you drag on a large document (a brush stroke, a slider or field in a panel, a Move), the view shows a quick
  preview at screen resolution and switches to full resolution when you release the mouse, as Photoshop does. Saved
  files, exports, merges and History always use full resolution. Proof Colors and Gamut Warning stay correct during
  the preview.
- The image is exactly the same as a full repaint in every case.

### Still open

- The adjustment filters themselves are not faster: editing an adjustment layer's settings again on a 4000 × 3000
  document still takes 1 to 5 s at full resolution (on release, after the preview), depending on the adjustments
  above it. A styled layer on a document-sized canvas renders its effects again on every change (about 0.6 s there).
  Opening and saving such a document take as long as before.
- During the preview, Clarity, Shadows/Highlights and Grain size look slightly different from the final result (they
  read their neighbourhood at screen scale).
- The retouch tools (clone, healing, dodge and the like) and the vector tools repaint the layer's whole box, not only
  where they paint. Partial repaints are off in documents with a Dissolve layer, a whole-image adjustment (Equalize,
  Match Color, HDR Toning, Replace Color, a dithered Color Lookup) or a non-RGB image mode.
- A view keeps up to four document-sized images for these caches (about 192 MB at 4000 × 3000).
- In 16 and 32-bit documents, layers with effects still composite at 8 bits, and so does Merge Group.
- Merge Down onto a lower layer that is transparent where the effects fall cannot keep an exterior effect in a mode of
  its own (it merges the two layers on their own, as Photoshop does), and Merge Down of an adjustment layer onto a
  layer below 100 % opacity bakes the adjustment and then fades it; neither shows a notice. Merge Down of a layer with
  Blend If on the Underlying Layer and Fill 0 % can still change the picture.
- With Blend Clipped Layers as Group off, Merge Clipping Mask can change soft edges of the base (by up to about 25
  levels), at every bit depth.
- PSD: the channel restriction of Blending Options is not saved (ag-psd drops a channel when reading it back);
  Photoshop's Stripes Gradient Map method has no known code and is saved as Classic.
- Create Layers on an effect in Dissolve mode makes the speckles again, in other places.
