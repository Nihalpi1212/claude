# type-paragraph-panel

The Paragraph panel and paragraph composition in Pigment 0.4: the seven alignments, indents, space before and after,
hyphenation with the Hyphenation dialog, the Justification dialog, Roman Hanging Punctuation, Adobe's Single-line and
Every-line composers, Unicode line breaking, bulleted and numbered lists, Reset Paragraph and the options-bar button
that shows the Character and Paragraph panels (ARCHITECTURE.md, "0.4 features (contracts)", package 4).

## User guide

### What the Paragraph panel changes

Window > Paragraph (or Type > Panels > Paragraph Panel, or the panel button in the Type tool's options bar) shows the
Paragraph panel. Like the Character panel it works on:

- **the paragraphs under the selection** while you edit text with a Type tool. With only a text cursor, the paragraph
  the cursor is in; with a selection, every paragraph the selection touches.
- **every selected text layer** when you are not editing text: all their paragraphs, one History step per change.
- **new text** when no text layer is selected. The panel then says "These settings apply to new text". The alignment
  you choose there is also the alignment in the Type tool's options bar.

When the paragraphs have different values, the field is empty and no alignment button is lit. The Properties panel
shows the same controls in its **Paragraph** section for a text layer.

### Alignment

The seven buttons are, from the left: **Left align text**, **Center text**, **Right align text**, **Justify last
left**, **Justify last centered**, **Justify last right** and **Justify all**. The justify alignments stretch every line
of a paragraph text box to both edges; their last line is set left, centred or right, and Justify all stretches the last
line too. Point text (text without a box) is not justified. A line that ends with a forced line break (Shift+Enter) is
justified like any other line of the paragraph.

### Indents and spacing

- **Indent left margin** and **Indent right margin** move the paragraph's lines in from the box edges.
- **Indent first line** indents the paragraph's first line from the left indent. A negative value makes a hanging
  indent (the first line starts further left).
- **Add space before paragraph** and **Add space after paragraph** add room between paragraphs. Space before the first
  paragraph of a layer is ignored.

The values are in the type unit you chose for the Character panel (pixels, points or millimetres).

### Hyphenation

Turn on **Hyphenate** to let Pigment break words at the end of lines. Words are hyphenated by the patterns of their
language (the Character panel's **Language**): American and British English, German, French, Spanish, Italian, Dutch and
Portuguese. Text in another language is not hyphenated. A soft hyphen typed into a word (U+00AD) always marks a place
where the word may break, and shows a hyphen when it does.

**Hyphenation…** in the panel menu sets:

- **Words Longer Than**: shorter words are never hyphenated.
- **After First** and **Before Last**: the least number of letters before and after a hyphen.
- **Hyphen Limit**: the most lines in a row that may end with a hyphen (0: no limit).
- **Hyphenation Zone**: for text that is not justified, how far from the right edge a line must end before Pigment
  hyphenates the next word instead of moving it to the next line. 0 hyphenates whenever it helps.
- **Hyphenate Capitalized Words** and **Hyphenate Last Word** (the paragraph's last word).

When the selected paragraphs have different settings, the field is empty and reads "Mixed"; leave it empty to keep each
paragraph's own value, or type a value to set it for all of them. OK makes one History step.

### Justification

**Justification…** in the panel menu sets how justified lines are stretched and compressed:

- **Word Spacing**: the space between words, in percent of the normal space: the least (Minimum), the preferred
  (Desired) and the most (Maximum). Desired applies to every line, also lines that are not justified.
- **Letter Spacing**: space added between letters, in percent of the normal space (0 % adds none).
- **Glyph Scaling**: how much the letters themselves may be made narrower or wider.
- **Auto Leading**: the line spacing of Auto leading, in percent of the largest font size on the line.
- **Single Word Justification**: how a justified line with a single word is set: Full Justify (its letters spread to
  both edges), Align Left, Align Center or Align Right.

Pigment stretches word spacing first, up to its Maximum, then letter spacing, then glyph scaling; beyond all three it
stretches word spacing further. Compression goes the other way, down to the Minimums. As in the Hyphenation dialog,
empty fields keep each paragraph's own values, and Minimum cannot be more than Desired nor Desired more than Maximum.

### Composers

The panel menu chooses how lines are broken:

- **Adobe Every-line Composer** (the default) looks at the whole paragraph and picks the breaks that give the most even
  spacing (justified text) or the most even right edge (ragged text), hyphenating only where it pays off.
- **Adobe Single-line Composer** sets one line at a time: it fills each line as far as it can, prefers adjusting word
  spacing to hyphenating, and hyphenating to letter spacing.

### Line breaks

Pigment breaks lines where the Unicode line breaking rules allow: after spaces, after hyphens and dashes, between
Chinese and Japanese characters (not before closing punctuation or small kana), at word boundaries in Thai and its
neighbours, never inside numbers such as 3.14 or 1,000.00, and after a slash in a long address. **Line breaks** in the
panel menu can switch a paragraph to **At Spaces Only (Pigment 0.3)**: breaks after spaces and nowhere else, as
Pigment 0.3 did. Documents saved by Pigment 0.3 open with that setting and the Single-line Composer, so their text
keeps every line it had.

A word longer than the line is broken where it must (Photoshop does the same) instead of sticking out of the box.

### Roman Hanging Punctuation

With **Roman Hanging Punctuation** (panel menu) on, punctuation at the start and end of lines hangs outside the margins
so the edges of the text look straight: quotes, hyphens, periods and commas hang wholly outside; colons, semicolons,
dashes, ellipses, asterisks and tildes by half.

### Bulleted and numbered lists

The two list buttons turn the paragraphs into a bulleted or a numbered list (press the button again to turn the list
off). A paragraph without a left indent gets one, so the marker sits inside the box. With a list on, the row shows:

- the marker: •, ◦, ▪, –, ✓ or ★ for bullets; 1. 2. 3., a. b. c., A. B. C., i. ii. iii. or I. II. III. for numbers;
- **Start**: the first number of a numbered list;
- **Level** (1 to 9): nested lists. The default bullet changes with the level (•, ◦, ▪), and the numbers of a nested
  list start again after each item of the list above it.

### Reset Paragraph

**Reset Paragraph** (panel menu) sets every paragraph setting back to Photoshop's defaults: left alignment, no indents
or spacing, no hyphenation, the default hyphenation and justification settings, the Every-line Composer, Unicode line
breaks, no hanging punctuation and no list.

### The panel button in the Type tool's options bar

The button shows the Character panel (the first time) or the Paragraph panel (if that was in front the last time).
Pressed again while one of them is in front, it brings back the panel that was there before.

## Release notes

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

## Known gaps

- The engines of 0.4 cannot narrow word spaces below their normal width (they clamp a composer's word spacing at 0), so
  compressing a justified line below 100 % word spacing narrows the letter gaps instead; the line still ends at the
  margin. Fixed when the engines accept negative word spacing (`SPACES_SHRINK` in `lib/type/paragraph.js`).
- Letter spacing is spread over code points on the stub engine and over shaping units on the HarfBuzz engine; with
  ligatures and non-zero letter spacing a justified line can end a fraction of a pixel off the margin.
- Hyphenate Across Column is stored but has no effect (Pigment has no text columns).
- Only the eight bundled languages hyphenate; the patterns of a language other than American English load the first
  time text in it hyphenates, and the text is laid out again when they arrive.
- East Asian Width, which UAX 14 consults for a few quotation and bracket rules, is approximated by the wide and
  fullwidth blocks; Japanese small kana follow the "strict" rule (no line starts with them).
- Lists use the paragraph's left indent for the marker; there is no separate setting for the gap between marker and
  text. Numbering continues over the consecutive numbered paragraphs of one layer only.
- PSD export writes 0.3's alignment only; justification, hyphenation, composer and list settings stay in .pigment files
  until psd-text (0.5).
