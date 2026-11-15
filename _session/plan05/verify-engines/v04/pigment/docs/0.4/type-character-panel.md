# type-character-panel

The Character panel and the Properties panel for type in Pigment 0.4: every character format on a range of text or on
several text layers, type units, the font size list, kerning (Metrics, Optical, manual), Reset Character
(ARCHITECTURE.md, "0.4 features (contracts)", package 3).

## User guide

### What the Character panel changes

The Character panel (Window > Character, or the panel button in the Type tool's options bar) works on:

- **the selected characters** while you edit text with a Type tool. Select a word and change its size, and only that
  word changes. With only a text cursor and no selection, a change applies to the next characters you type, as in
  Photoshop.
- **every selected text layer** when you are not editing text. A change applies to all their text; the History panel
  gets one step for the change, however many layers are selected.
- **new text** when no text layer is selected. The panel then says "These settings apply to new text", and what you set
  there (tracking, underline, scale and so on) is what the next text you create starts with.

When the selection has several values (two sizes, bold and regular), the field is empty, a toggle button is half
lit and a list shows a blank entry. Typing a value or picking one sets it for the whole selection.

Every change you make in the panel also becomes the starting point for new text, as in Photoshop, except the colour of
existing text (which does not change your foreground colour) and manual kerning (which belongs to one pair of
letters).

### The fields

- **Font** and **Style**: the font family and the face (weight, italic).
- **Size**: the font size, with a list of the usual sizes (6 to 72). Drag the label left or right to change the value.
- **Leading**: the distance between lines. "Auto" (the default) follows the size (120 % of the largest size on the
  line, set in the paragraph's justification settings); the field then shows the computed value in brackets. Type a
  value to fix it, or pick **Auto** in its list to go back.
- **Kerning**: **Metrics** uses the pairs stored in the font; **Optical** spaces each pair by the shapes of its letters
  (useful for fonts with poor kerning and for mixed fonts); **0** turns kerning off. The number next to it is manual
  kerning in thousandths of an em: with the text cursor between two letters it changes the space between that pair,
  on a selection it applies to every letter. Alt+Left / Alt+Right while editing change it in steps.
- **Track**: tracking, the space added between all letters of the selection, in thousandths of an em.
- **V** and **H**: vertical and horizontal scale in percent.
- **Shift**: baseline shift (positive moves the letters up).
- **Color**: the text colour.
- The toggle buttons: **Faux Bold**, **Faux Italic**, **All Caps**, **Small Caps**, **Superscript**, **Subscript**,
  **Underline** and **Strikethrough**. Faux Bold and Faux Italic are drawn by Pigment and work with any face, also with
  a face that is already bold or italic. All Caps and Small Caps, and Superscript and Subscript, exclude each other.
- **Language**: the dictionary used to hyphenate the text. The list shows the languages Pigment can hyphenate and the
  languages already used in the document.
- **aa** (anti-aliasing): None, Sharp, Crisp, Strong or Smooth, stored with the layer.
- **Orientation**, **Stroke** and **Text** (point text or a paragraph box with its width and height) are Pigment's
  own rows below. Choosing **Paragraph box** for point text puts a box around the text as it is; **Point text** removes
  the box. An empty box height means the box grows with the text.

The panel menu (the ••• button) has the toggles again, **Fractional Widths** (on by default; off rounds each letter's
width to whole pixels), **System Layout** (lays the layer out like an operating-system text field), **No Break** (the
selected words are never split across lines), the type unit, and **Reset Character**.

### Type units

Sizes, leading, baseline shift and the box size are shown in pixels, points or millimetres. Choose the unit in the
Character panel menu or in Preferences > Type Units. Points and millimetres are converted with the document's
resolution (Image > Image Size): 12 pt is 12 px at 72 ppi and 50 px at 300 ppi. The options bar's size field uses the
same unit and has the same list of sizes; drag its "T" icon to change the size.

### Reset Character

Panel menu > Reset Character sets leading, kerning, tracking, scales, baseline shift, the toggles, language, Fractional
Widths and No Break back to their defaults for the selection (or the selected layers, or new text). It keeps the font,
style, size, colour and stroke.

### The Properties panel for type

With a text layer selected, the Properties panel shows the layer's transform, a **Character** section with the same
controls as the Character panel (it changes the same thing), the paragraph controls once the Paragraph panel is there,
**Edit Text** and a button that opens the Character panel.

## Release notes

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

## Known gaps

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
