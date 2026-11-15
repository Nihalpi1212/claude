# type-fonts (0.5, package 12)

The font menu with real styles, search, previews and filters; variable fonts; Add Fonts; missing fonts; missing
glyph protection.

## User guide

### Choosing a font

The family field in the Type tool's options bar, the Character panel and the Properties panel's Character section
shows the family in its own typeface. Click it (or start typing a name into it) to open the font menu:

- **Search**: type any part of a family or style name ("semibold italic" finds every family with that style).
- **Filter by classification**: All Classes, Serif, Sans Serif, Slab Serif, Script, Handwritten, Monospace,
  Decorative, Blackletter. The class comes from the font itself (its OS/2 and PANOSE classification); installed
  fonts are read in the background the first time and remembered.
- **Favourites**: click the star in front of a family; the star button at the top shows only your favourites.
- **Similar fonts**: the ≈ button lists the families that look most like the current one (same class, similar
  x-height, cap height and width).
- **Recently used** families are listed first, under "Recent".
- Each row shows a sample in that family. The sample text is chosen at the bottom of the menu (Sample, Aa, Abc,
  The quick brown fox, or the selected text), and its size with **Type > Font Preview Size** (None, Small, Medium,
  Large, Extra Large, Huge) or the size list beside it.
- **Live preview**: hover over a family (or move through the list with the arrow keys) to see the selected text
  layers, or the selected characters while you edit, in that family on the canvas. Nothing changes until you click a
  family or press Enter; Escape or a click outside closes the menu and the text goes back to its font.

The **style** list beside the family lists the family's real styles (Light, Regular, Semibold Italic…), not a fixed
list. Families whose files Pigment cannot read (in the browser version, without permission to read your installed
fonts) keep the five weights of 0.4, drawn by the browser.

### Variable fonts

A variable font lists its named instances as styles. The Character panel (and the Properties panel's Character
section) shows a slider for each of its axes (Weight, Width, Slant, Optical Size and the font's own axes); a value
between the named instances is shown as "Bold (custom)" in the style list. The axis values are saved in .pigment
files.

### Add Fonts

**Type > Add Fonts…** adds TrueType and OpenType files (.ttf, .otf, .ttc) to Pigment without installing them in the
system. They are kept with your presets (the Preset Manager lists them under Fonts) and are there the next time you
start Pigment. Files that are not fonts are listed in a message.

### Bundled fonts

Pigment ships **Source Sans 3** (variable, upright and italic; family name "SourceSans3VF") so there is always a
font with real styles and variable axes. It is also the font that replaces missing fonts and draws missing
characters.

### Missing fonts

When a file you open uses fonts you do not have, a notice lists them once; its **Manage…** button opens **Type >
Manage Missing Fonts…**, where you choose a family and style to replace each one (Source Sans 3 in the missing
font's weight by default). **Type > Replace All Missing Fonts** replaces every missing font with Source Sans 3 at
once, keeping each run's weight and slant. Until you replace them, the text is drawn with a substitute. Batch and the
Image Processor do not stop for missing fonts: they write a line to their log.

### Missing glyph protection

A character the text's font does not have (an arrow, a symbol, a letter of another script) is drawn with the first
font that has it: Source Sans 3 first, then the other fonts Pigment has loaded. Emoji are drawn by the system's
emoji font, as before. **Preferences > Fonts > Enable missing glyph protection** turns it off; the same section sets
the font preview size.

## Release notes

- Font menu: search, WYSIWYG samples with a choice of sample text, Font Preview Size, live preview on the canvas,
  classification filters (Serif, Sans Serif, Slab Serif, Script, Handwritten, Monospace, Decorative, Blackletter),
  favourites, similar fonts and recently used families.
- The font style list shows the family's real styles; variable fonts list their named instances and get axis sliders
  in the Character panel.
- Type > Add Fonts… loads font files without installing them; they are kept for the next session.
- Type > Font Preview Size, Manage Missing Fonts…, Replace All Missing Fonts.
- Missing fonts in opened files are reported once (Batch: in its log).
- Missing glyph protection: characters a font lacks are drawn with a fallback font.
- Bundled font: Source Sans 3 (variable).
- New Preferences section **Fonts** (after Type): Enable missing glyph protection (default on), Font preview size
  (default Medium). Settings `typeFonts.glyphProtection` (new sub-key, absent means on) and `typeFonts.previewSize`.
- Changed: the style values of the options bar and the Character panel are PostScript names for families whose
  faces Pigment knows (`'700'`-style keys remain for the others); a style chosen this way sets the run's PostScript
  name, so the exact face is kept.
- Changed: a character the font lacks used to be drawn by the browser's own fallback font; it is now drawn with
  Source Sans 3 or another loaded font that has it (its outline is then known to Pigment). Emoji are unchanged.
- Changed: the family control is a font menu instead of a plain list; the Character panel's family and style rows
  are replaced the same way.

### Third-party notices

- **Source Sans 3** 3.52.0, © 2010–2024 Adobe, with Reserved Font Name "Source". SIL Open Font License 1.1.
  From the npm package `source-sans` (`VF/SourceSans3VF-Upright.ttf`, `VF/SourceSans3VF-Italic.ttf`). Bundled in
  `src/renderer/fonts/` with its licence `SourceSans3-LICENSE.md`.
- Test fixtures only (not shipped): **Liberation Sans** Regular and Bold, **Liberation Serif** Regular, **Liberation
  Mono** Regular 2.1.5, © 2010 Google Corporation, © 2012 Red Hat, Inc., SIL Open Font License 1.1, from the Debian
  package `fonts-liberation`; licence in `tests/fixtures/fonts/Liberation-LICENSE.txt`.

## Known gaps

- Installed fonts are listed with their real styles only where Pigment may read them (Electron; the browser version
  only after the "local fonts" permission was granted). Without it, the browser version lists the families it can
  detect, with 0.4's synthesised weights.
- The classification of installed fonts is read in the background on first start (a few files at a time); until a
  family is read, its name decides its class when it can.
- A custom axis value is kept on the text and in the style key; tool presets keep it through the style key.
- Variable fonts in WOFF/WOFF2 files cannot be added (HarfBuzz reads TrueType and OpenType only).
- PSD: until psd-text lands, a text layer whose runs carry a PostScript name or axis values (a style chosen from a
  family with real styles, an axis slider) is not "PSD expressible" for 0.4's text mapping and is saved as pixels with
  the "saved as pixels" notice; families listed with 0.4's synthesised weights are saved as editable text as before.
  psd-text writes the PostScript names (FontSet) and the named instance of a variable font; axis values between
  instances have no PSD field and are reported.
- The hover preview previews the family only; the style in the list stays what it is until a family is chosen.
- Similar fonts compare classification and a few metrics (x-height, cap height, average width), not glyph shapes.
