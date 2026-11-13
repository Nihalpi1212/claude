# type-engine-core

The type engine of Pigment 0.4: font data, shaping with HarfBuzz, multi-run layout and rendering (ARCHITECTURE.md,
"0.4 features (contracts)", package 1).

## User guide

### How Pigment draws text

Pigment 0.4 shapes text with HarfBuzz, the shaping engine of Chrome, Firefox and Android. Kerning, ligatures (such as
"fi" and "ffi"), combining accents, emoji sequences and scripts whose letters change shape with their neighbours are
set as the font designer intended. Each glyph is drawn from the font's own outline.

Pigment reads the fonts installed on your computer. The desktop app has access to them from the start. In a browser,
open the font list in the options bar of the Type tool once, and allow the browser to use your fonts. A font's files
are read the first time a text layer uses it. Until they arrive, which takes a moment, the text is drawn with the
browser's own text drawing; then it is drawn again with the font. This does not add a step to History and does not
mark the document as changed.

When a font is not installed, Pigment uses a font with the same measurements where one exists, as the operating
system does: Liberation Sans for Arial and Helvetica, Liberation Serif for Times New Roman, Liberation Mono for
Courier New, Carlito for Calibri and Caladea for Cambria. Any other missing font is drawn with the browser's text
drawing, as in Pigment 0.3.

### Several formats in one text layer

A text layer can mix fonts, sizes, colours, tracking, baseline shift, super- and subscript, small and all caps,
underline and strikethrough from one character to the next. Each paragraph has its own alignment, indents and space
before and after. The Character and Paragraph panels set these values. With auto leading, each line is spaced from
the line above by the leading of its largest text, so a line with large letters does not run into the line above.

### Paragraph text in a box

Drag with the Type tool to make a text box. The text wraps at the box's width. A box can also have a fixed height:
lines that do not fit are hidden, and the box reports that its text overflows (the Type tool shows a plus sign in the
box's corner handle). Point text, made by clicking, grows with the text.

### Tracking

Tracking (Character panel) is set in thousandths of an em and is added after each character of the selection. A
ligature counts as one character, so tracking never breaks "fi" into two letters. No tracking is added after the last
character of a line, so tracked text stays aligned with the box's edge.

### Colour fonts and emoji

Colour fonts (COLR, CBDT, sbix, such as Noto Color Emoji or Segoe UI Emoji) draw in their own colours. Emoji
sequences (families, flags, skin tones) stay one character for the caret and for tracking. When the font of a run has
no glyph for a character, the browser's text drawing finds one in another installed font, so emoji and other scripts
appear in any font.

### Text on a path

Text on a path takes its glyphs from the same engine: kerning, ligatures, accents and emoji stay intact on a path, and
each run keeps its own size and colour.

## Release notes

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

## Known gaps

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
