# Parity: Type

Part of [Pigment and Photoshop: feature parity](../PARITY.md), as of Pigment 0.4 (November 2026). The rows planned for 0.4 ("0.4 · *package*") show their 0.4 status and the counts below include them; the other rows and the overview paragraph describe Pigment 0.3.1 as the audit found it.

Pigment's type support is a single-style text layer drawn with Canvas fillText (src/renderer/lib/document.js TextLayer, lib/tools/text.js, lib/panels/character.js, lib/text-path.js): point text, a width-only paragraph box, text on a path, two vertical modes, family / weight / italic / size / leading / tracking / colour / underline / three alignments, in-place editing through a transparent textarea, and editable text in PSD import/export for the first style run only. Everything that needs a real type engine is absent: mixed formatting inside one layer (admitted in README), kerning control, horizontal/vertical scale, baseline shift, caps, super/subscript, strikethrough, every OpenType feature, anti-aliasing methods, variable-font axes, and the whole Paragraph panel (justification, indents, spacing, hyphenation, composers, lists). There is no Type menu (seven items live under Layer > Type), no Paragraph, Glyphs, Character Styles or Paragraph Styles panel, no Type Mask tools, no live Warp Text (the 15 warp presets exist but force rasterising), no Create Work Path / Convert to Shape, no Find and Replace, Check Spelling, Lorem Ipsum, missing-font handling or type preferences. The biggest single gap is the engine itself: a rich-text model (style runs and paragraph runs) with a shaper that reads font files (HarfBuzz/opentype.js via queryLocalFonts blob data) is the XL prerequisite for roughly two thirds of the missing entries, including faithful PSD round-trips (today PSD export writes the CSS family name instead of the PostScript name and marks real bold as faux bold). Genuinely not feasible offline are only Adobe Fonts (browse, activate, auto-resolve missing fonts), Match Font and Similar Fonts as Adobe's trained models, and Adobe's bundled licensed fonts; honest substitutes are user-installed fonts, PANOSE/OS/2-based similarity and bundled OFL families. Verified by reading the code at commit aa196d0 (0.3.1); the app was not run.

55 missing · 15 partial · 7 approximate · 5 not feasible · 71 done · 153 entries

## character-panel

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| All Caps | Character panel button / menu | Done | 0.4: Character panel button and menu | S | 0.4 · type-character-panel |
| Small Caps | Character panel button / menu | Done | 0.4: the font's real small capitals on the HarfBuzz engine; faked on the Canvas engine | S | 0.4 · type-character-panel |
| Strikethrough | Character panel button / menu | Done | 0.4: position and thickness from the font | S | 0.4 · type-character-panel |
| Subscript | Character panel button / menu | Done | 0.4: from the font on the HarfBuzz engine | S | 0.4 · type-character-panel |
| Superscript | Character panel button / menu | Done | 0.4: from the font on the HarfBuzz engine | S | 0.4 · type-character-panel |
| Fractional Widths | Character panel menu | Done | 0.4: Character panel menu | S | 0.4 · type-character-panel |
| No Break | Character panel menu | Done | 0.4: Character panel menu | S | 0.4 · type-character-panel |
| Reset Character | Character panel menu | Partial | 0.4: in the panel menu; keeps the font, size and colour, which Photoshop resets too | S | 0.4 · type-character-panel |
| System Layout | Character panel menu | Done | 0.4: Character panel menu | S | 0.4 · type-character-panel |
| Character language (dictionary for hyphenation and spelling) | Character panel: language menu | Done | 0.4: language menu, used for hyphenation (eight bundled languages); spelling waits for the spelling checker | S | 0.4 · type-character-panel |
| Character panel: baseline shift | Window > Character | Done | 0.4: per character | S | 0.4 · type-character-panel |
| Character panel: kerning (Metrics / Optical / manual values) | Window > Character | Done | 0.4: Metrics, Optical (from the outlines on the HarfBuzz engine, Metrics elsewhere), 0 and manual values | L | 0.4 · type-character-panel |
| Character panel: scrubby sliders, unit entry and arithmetic in fields | Window > Character | Done | 0.4: scrubby labels, units and arithmetic in every field | S | 0.4 · type-character-panel |
| Character panel: vertical scale and horizontal scale | Window > Character | Done | 0.4: per character | S | 0.4 · type-character-panel |
| Font size with units (pt, px, mm), preset size list and scrubby label | Options bar and Character panel: size | Done | 0.4: pixels, points or millimetres (Preferences › Type Units), the size list and a scrubby icon | S | 0.4 · type-character-panel |
| Character panel: font family | Window > Character | Partial | Select of installed families (panels/character.js). No search, preview, favourites, recents or filters. | M | 0.5 · type-fonts |
| Character panel: leading, including Auto | Window > Character | Done | 0.4: leading with Auto; mixed sizes follow Photoshop's leading rule | S | 0.4 · type-character-panel |
| Faux Bold | Character panel button / menu | Done | 0.4: per character, any font | S | 0.4 · type-character-panel |
| Faux Italic | Character panel button / menu | Done | 0.4: per character, any font | S | 0.4 · type-character-panel |
| Underline | Character panel button / menu | Done | 0.4: position and thickness from the font | S | 0.4 · type-character-panel |
| Character panel: tracking | Window > Character | Done | 0.4: tracking in 1/1000 em that keeps kerning, ligatures and complex scripts | S | 0.4 · type-engine-core |
| Options bar: text colour swatch | Type tool options bar | Done | 'color' option; new text takes the foreground colour, editing a layer changes its colour (whole layer only). |  |  |
| Character panel: colour | Window > Character | Done | Colour input for the whole layer; drags merge into one history entry. |  |  |

## opentype

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| OpenType: Discretionary Ligatures | Character panel OpenType buttons | Missing | No feature control. | S | 0.6 · type-opentype-glyphs |
| OpenType: Fractions | Character panel OpenType buttons | Missing | No feature control. | S | 0.6 · type-opentype-glyphs |
| OpenType: Oldstyle figures | Character panel OpenType buttons | Missing | No feature control. | S | 0.6 · type-opentype-glyphs |
| OpenType: Ordinals | Character panel OpenType buttons | Missing | No feature control. | S | 0.6 · type-opentype-glyphs |
| OpenType: Swash | Character panel OpenType buttons | Missing | No feature control. | S | 0.6 · type-opentype-glyphs |
| OpenType: Titling Alternates | Character panel OpenType buttons | Missing | No feature control. | S | 0.6 · type-opentype-glyphs |
| OpenType: Stylistic Alternates and Stylistic Sets | Character panel OpenType buttons; Properties > Type Options | Missing | No feature control. | S | 0.6 · type-opentype-glyphs |
| OpenType: Ornaments, Justification Alternates, proportional / tabular figures | Character panel menu > OpenType | Missing | No feature control. | S | 0.6 · type-opentype-glyphs |
| OpenType submenu (Standard Ligatures, Contextual Alternates, Discretionary Ligatures, Swash, Oldstyle, Stylistic Alternates, Titling Alternates, Ornaments, Ordinals, Fractions, Justification Alternates, Japanese forms) | Type > OpenType; Character panel menu > OpenType | Missing | No OpenType feature state or UI. Canvas text only gets Chromium's defaults (liga, calt, kern) and loses even those when tracking is non-zero (drawSpaced draws glyph by glyph). Needs a shaper with feature control (HarfBuzz wasm or opentype.js over font data from queryLocalFonts().blob()). | L | 0.6 · type-opentype-glyphs |
| OpenType: Contextual Alternates toggle | Character panel OpenType buttons | Partial | No toggle; on by Chromium default only in the whole-line drawing path. | S | 0.6 · type-opentype-glyphs |
| OpenType: Standard Ligatures toggle | Character panel OpenType buttons | Partial | No toggle. Ligatures appear by Chromium default when tracking is 0 and disappear when tracking is set, on a path and in stacked text. | M | 0.6 · type-opentype-glyphs |

## fonts

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Favourite fonts (star) and favourites filter | Font menu | Missing | No favourites. | S | 0.5 · type-fonts |
| Font menu WYSIWYG preview with selectable sample text | Font menu | Missing | Family names only, in the UI font. | M | 0.5 · type-fonts |
| Live preview of a font on the canvas while hovering the list | Font menu | Missing | A native select cannot report hover; the change applies only on selection. | M | 0.5 · type-fonts |
| Filter fonts by classification (Serif, Sans Serif, Script, Monospace, Decorative ...) | Font menu filter | Missing | No filter. Adobe's classification metadata is not available; a local equivalent can be derived from each font's OS/2 family class and PANOSE values. | M | 0.5 · type-fonts |
| Recently used fonts at the top of the list | Font menu; Preferences > Type | Missing | No recents list. | S | 0.5 · type-fonts |
| Variable fonts: named instances and axis sliders (weight, width, slant, optical size, custom) | Properties panel / Character panel for variable fonts | Missing | No axis UI or font-variation data. An installed variable font only receives the five CSS weights from the style list. | M | 0.5 · type-fonts |
| Font Preview Size (None, Small ... Huge) | Type > Font Preview Size | Missing | Font pickers are plain <select> elements (text.js typeOptions, character.js) with no sample preview at all, so there is nothing to size. | S | 0.5 · type-fonts |
| Manage Missing Fonts / Replace All Missing Fonts / Resolve Missing Fonts | Type > Manage Missing Fonts; missing fonts dialog on open | Missing | No detection: a family that is not installed silently renders in Chromium's fallback face, with no dialog, no layer badge and no substitution UI. The fallback font detector in text.js (detectFonts) could be reused to test availability. | M | 0.5 · type-fonts |
| Font search by name | Font menu search field | Partial | Only the native select's type-ahead on the first letters; no substring search across family and style. | S | 0.5 · type-fonts |
| Options bar: font family picker (search field, WYSIWYG list, filters) | Type tool options bar | Partial | A native select of family names (typeOptions 'family'). No text search field, no preview, no filters, no recent list; only the select's type-ahead. | M | 0.5 · type-fonts |
| Colour, emoji and SVG fonts | Font menu; Glyphs panel (EmojiOne, Trajan Color) | Partial | 0.4: colour fonts and emoji drawn in colour, fallback to another installed font; OpenType-SVG glyphs draw as plain outlines | M | 0.4 · type-engine-core |
| Font style list showing the family's real styles | Options bar and Character panel: font style | Approximate | Fixed list of ten entries (Light, Regular, Medium, Bold, Black, each with Italic; STYLES in text.js) mapped to CSS weight/italic, whatever the family contains. Styles such as Condensed, Semibold, Display or Oblique are unreachable, and absent weights are synthesised by Chromium without telling the user. queryLocalFonts already returns style and postscriptName per face but only .family is read. | M | 0.5 · type-fonts |
| Missing glyph protection (automatic fallback font for unsupported characters) | Preferences > Type | Approximate | Always on implicitly: Chromium substitutes a system fallback face per character. Not switchable and the substituted font is not reported. | S | 0.5 · type-fonts |
| Show Similar Fonts | Font menu filter | Not feasible | Absent. Photoshop uses Adobe's trained visual-similarity model. Honest substitute: similarity from PANOSE/OS-2 metrics and measured glyph proportions of installed fonts. |  |  |
| Fonts bundled with the application | Photoshop installation (Myriad, Minion, Source families, EmojiOne ...) | Not feasible | Pigment ships no fonts (no @font-face or font files in src/renderer). Adobe's commercial families cannot be shipped; OFL families (Source Sans/Serif, Source Han, Noto, Noto Color Emoji) can be bundled so documents have a guaranteed default. |  |  |
| System font list | Font menu | Done | loadSystemFonts uses window.queryLocalFonts (main.js grants the 'local-fonts' permission) and falls back to probing 79 common families (detectFonts). bridge.localFonts is referenced but not implemented in preload.cjs, which is harmless. |  |  |

## type-editing

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Check Spelling | Edit > Check Spelling | Missing | No command; the editor textarea sets spellcheck=false. Adobe's dictionaries are licensed; open Hunspell dictionaries (bundled, per language) with a Hunspell port are the offline substitute. Needs Ignore / Ignore All / Change / Change All / Add, Check All Layers and a per-text language. | M | 0.7 · type-styles-prefs |
| Find and Replace Text | Edit > Find and Replace Text | Missing | No command or dialog (Find Next, Change, Change All, Change/Find; Search All Layers, Forward, Case Sensitive, Whole Word Only, Ignore Accents). | M | 0.7 · type-styles-prefs |
| Double-click text with the Move tool to edit it | Move tool | Done | 0.4 | S | 0.4 · type-editing |
| Placeholder text in new type layers (Lorem ipsum, pre-selected) | New type layer; Preferences > Type | Done | 0.4: selected Lorem Ipsum, off in Preferences › Type | S | 0.4 · type-editing |
| Move the text while editing (Ctrl/Cmd-drag, or drag away from the text) | Type tool editing session | Done | 0.4 | S | 0.4 · type-editing |
| Tab characters | Type tool editing session | Done | 0.4: Tab types a tab, placed by the paragraph's tab spacing | S | 0.4 · type-editing |
| Transform while editing (Ctrl/Cmd shows the transform box: scale, rotate, skew the text) | Type tool editing session | Done | 0.4: scale, rotate and skew with Free Transform's box; distort and perspective are not offered while editing | M | 0.4 · type-editing |
| Cut, copy and paste text, with formatting kept between type layers | Edit menu while editing | Done | 0.4: formatted clipboard between type layers, Paste Without Formatting | S | 0.4 · type-editing |
| Type keyboard shortcuts (size, leading, kerning/tracking, baseline, alignment, caps, super/subscript, scale reset) | Keyboard while editing | Done | 0.4: Photoshop's type keys | S | 0.4 · type-editing |
| Resize the paragraph box while editing (eight handles) | Type tool editing session | Done | 0.4: eight handles; the box keeps its height and shows overflow | S | 0.4 · type-editing |
| Undo/redo inside an editing session | Edit > Undo while editing | Done | 0.4: undo steps through typing and formatting runs; the commit is one History step | S | 0.4 · type-editing |
| IME and dead-key input (CJK, accents) | Type tool editing session | Done | 0.4: input methods and dead keys, composed text drawn in the layer | S | 0.4 · type-editing |
| Selecting text: drag, double-click word, triple-click line, quadruple-click paragraph, five clicks / Ctrl+A all | Type tool editing session | Done | 0.4: all of them; bidirectional text is selected in logical order | M | 0.4 · type-editing |
| Double-click the T thumbnail to edit and select all text | Layers panel | Done | panels/layers.js line 270 runs layer:edit-text, which activates the tool and selects all. Properties panel has an Edit Text button. |  |  |
| Click existing text to edit, caret at the click | Type tool | Done | hitTextLayer + caretIndex (works through the layer matrix, on a path and for stacked text). |  |  |
| Editing overlay tracks zoom, canvas rotation and layer transform | Type tool at any zoom | Done | layoutEditor positions the textarea with the view matrix times the layer matrix and a measured CSS baseline; wheel events are forwarded so zooming while editing works. |  |  |
| Cancel text (Esc) | Type tool editing session | Done | Esc and the cross button call cancelSession, restoring the snapshot or removing a new layer. |  |  |
| Commit text (Ctrl/Cmd+Enter, numeric Enter, tick, click outside, switch tool or layer) | Type tool editing session | Done | onEditorKey, deactivate, layer:activated listener and the options bar tick all call commitSession; one history entry per session. |  |  |
| Keyboard navigation (arrows, word and line jumps, Home/End, Shift to extend) | Type tool editing session | Done | Native textarea caret movement; Home/End are re-implemented for path and stacked text (onEditorKey). |  |  |
| Options bar: Cancel and Commit buttons | Type tool options bar while editing | Done | renderOptions adds the check and cross buttons during a session (commitSession / cancelSession). |  |  |

## type-engine

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Overflow indicator (plus sign in the box handle) | Paragraph text box | Done | 0.4 | S | 0.4 · type-engine-core |
| Anti-aliasing method (None, Sharp, Crisp, Strong, Smooth, Windows LCD, Windows) | Type > Anti-Alias; Type tool options bar; Character panel | Missing | No control anywhere and no field in the font object (DEFAULT_TEXT_STYLE in document.js). Canvas fillText always gives Chromium's greyscale anti-aliasing. None could be done by thresholding; Sharp/Crisp/Strong/Smooth are Adobe rasteriser variants and can only be approximated with an own glyph rasteriser (coverage gamma / emboldening). PSD import drops the antiAlias value. | M | 0.5 · type-menu-commands |
| Warp Text (live, editable): 15 styles, Horizontal / Vertical, Bend, Horizontal Distortion, Vertical Distortion | Type > Warp Text; options bar Create Warped Text | Missing | No warp property on TextLayer. The 15 presets with Bend/H/V do exist for pixels (WARP_PRESETS and presetControls in lib/warp.js, bezierWarp in shared/pixels/warp.js) but Edit > Transform > Warp asks to rasterise a text layer first (warp.js line 1308). Missing: Horizontal/Vertical axis switch, storing the warp on the layer and re-applying it after each text render, PSD import/export of the warp. | M | 0.5 · type-menu-commands |
| Several character formats inside one text layer (per-character font, style, size, colour, decoration) | Type layers | Done | 0.4: laid out and drawn by the HarfBuzz engine; PSD gets a layer with several styles as pixels until psd-text (0.5) | XL | 0.4 · type-engine-core |
| Per-paragraph formatting inside one layer (alignment, indents, spacing per paragraph) | Type layers; Paragraph panel | Done | 0.4: alignment, indents, spacing and the other paragraph settings per paragraph | L | 0.4 · type-engine-core |
| Text inside a closed shape or path (area type) | Type tool: click inside a closed path | Missing | Clicking a path always starts text on the path (pathHit in text.js); there is no in-shape line breaker. | L | 0.8 · type-on-path-area |
| Text on a path: baseline shift to move text off the path | Character panel baseline shift on path type | Partial | layoutOnPath honours pathText.baselineShift and Image Size scales it, but no UI or command sets it. | S | 0.8 · type-on-path-area |
| Text on a path: start and end brackets, drag to slide, drag across the path to flip | Path Selection / Direct Selection tool on type path | Partial | A start-offset I-beam can be dragged, but only inside a Type tool editing session (hitOffsetHandle); no end bracket; flipping is the menu command text:flip-path, not a drag across the path; the Path Selection tool does nothing to it. | M | 0.8 · type-on-path-area |
| Text on a path: create by clicking a path, type along it | Type tool over a path | Partial | lib/text-path.js layoutOnPath: glyph-by-glyph placement on the flattened path, special cursor, Layer > Type > Text on Path to attach an existing layer. Limits: only the first subpath is used (admitted in ARCHITECTURE Known gaps), iteration is per UTF-16 unit so emoji and combining marks break, no kerning or ligatures, new lines are ignored, and the layer keeps a private copy of the path that cannot be reshaped with the Direct Selection or Pen tools afterwards (vector.js has no pathText target). | M | 0.8 · type-on-path-area |
| Paragraph text in a bounding box (width and height) | Type tool: drag | Done | 0.4: width and height; text beyond the box is hidden | M | 0.4 · type-engine-core |
| Type on high-resolution and zoomed canvases | Type layers | Done | Text is rasterised at document resolution and re-rendered live from parameters after Image Size (image-ops.js scales size, tracking, stroke and path) and Free Transform (matrix kept, text stays editable), as Photoshop does. Size limit 1296 px. |  |  |
| Point text | Type tool: click | Done | TextLayer with width null; click sets the baseline (beginNew). |  |  |

## paragraph-panel

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Indent left margin, indent right margin, first-line indent | Paragraph panel | Done | 0.4: Paragraph panel | S | 0.4 · type-paragraph-panel |
| Justify last left / last centred / last right / justify all | Paragraph panel | Done | 0.4: all four; PSD keeps them | M | 0.4 · type-paragraph-panel |
| Space before / space after paragraph | Paragraph panel | Done | 0.4: Paragraph panel | S | 0.4 · type-paragraph-panel |
| Bulleted and numbered lists | Paragraph panel (recent Photoshop releases) | Done | 0.4: bullets and numbering; the marker sits in the left indent and numbering runs within one layer | M | 0.4 · type-paragraph-panel |
| Hyphenate, and the Hyphenation settings dialog | Paragraph panel checkbox and menu | Done | 0.4: TeX patterns in eight languages and the Hyphenation dialog; Hyphenate Across Column has no effect (no columns) | M | 0.4 · type-paragraph-panel |
| Reset Paragraph | Paragraph panel menu | Done | 0.4: Paragraph panel menu | S | 0.4 · type-paragraph-panel |
| Roman Hanging Punctuation | Paragraph panel menu | Done | 0.4: Paragraph panel menu | S | 0.4 · type-paragraph-panel |
| Justification settings (word, letter and glyph spacing min/desired/max, auto leading) | Paragraph panel menu > Justification | Done | 0.4: the Justification dialog; justified lines close up word spaces down to the Minimum | M | 0.4 · type-paragraph-panel |
| Paragraph panel | Window > Paragraph | Done | 0.4: Window › Paragraph and the Properties section | M | 0.4 · type-paragraph-panel |
| Adobe Single-line Composer / Every-line Composer | Paragraph panel menu | Approximate | 0.4: both composers, with Unicode line breaking; Pigment's own Every-line algorithm, so lines can break differently from Photoshop's. East Asian Width is approximated | L | 0.4 · type-paragraph-panel |
| Align left / centre / right | Paragraph panel | Done | font.align for the whole layer (TextLayer.renderBase, text on a path, stacked text). |  |  |
| Options bar: alignment (left / centre / right, or top / centre / bottom for vertical) | Type tool options bar | Done | Segment control 'align' in typeOptions; applies to the whole layer; stacked vertical text maps it to top/middle/bottom (layoutStacked). |  |  |

## type-tools

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Type tool context menu (Edit Type, Check Spelling, Find and Replace, Rasterize, Create Work Path, Convert to Shape, orientation, anti-alias, faux styles, Convert to Paragraph Text, Warp Text) | Right-click with a type tool or on a type layer | Missing | No canvas context menu for type. The Layers panel context menu offers only generic items (Rasterize Layer, Convert to Smart Object, styles). | S | 0.8 · context-menus-task-bar |
| Horizontal Type Mask tool | Toolbox: T group | Missing | No tool. Workaround today: make a text layer, Select > Layer Transparency as Selection (select:from-layer), delete the layer. A real tool needs the editing session to end in a selection instead of a layer, with the quick-mask overlay while typing. | M | 0.5 · type-menu-commands |
| Vertical Type Mask tool | Toolbox: T group | Missing | No tool; same as the horizontal mask tool. | S | 0.5 · type-menu-commands |
| Options bar: toggle text orientation button | Type tool options bar | Missing | Not in typeOptions(); orientation is changed from Layer > Type or the Character panel. | S | 0.5 · type-menu-commands |
| Alt-click to enter paragraph box width and height numerically | Type tool: Alt/Option-click | Done | 0.4: Alt-click asks for the box size | S | 0.4 · type-editing |
| Shift+T cycles the type tools | Toolbox shortcut | Partial | Both tools share the 'text' slot and cycle with Shift+T (tools.js register); only two of Photoshop's four tools exist to cycle through. | S | 0.5 · type-menu-commands |
| Options bar: toggle Character and Paragraph panels | Type tool options bar | Done | 0.4: the button toggles the panels | S | 0.4 · type-paragraph-panel |
| Horizontal Type tool | Toolbox: T | Done | TypeTool 'type-horizontal' (lib/tools/text.js), shortcut T, click for point text, drag for a paragraph box, click existing text to edit. |  |  |

## type-menu

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Paste Lorem Ipsum | Type > Paste Lorem Ipsum | Missing | No command ('lorem' appears nowhere in src). | S | 0.5 · type-menu-commands |
| Update All Text Layers | Type > Update All Text Layers | Missing | No command. Relevant after PSD import (Pigment always re-renders text with its own engine instead of keeping the stored pixels) and after fonts change. | S | 0.5 · type-menu-commands |
| Type menu as a top-level menu | Menu bar: Type | Done | 0.4: Type menu between Layer and Select; some of its commands (Warp Text, Convert to Shape and others) come in 0.5 | S | 0.4 · skeleton-04 |
| Convert to Point Text / Convert to Paragraph Text | Type > Convert to Point Text / Paragraph Text | Partial | Character panel 'Point text / Paragraph box' select plus box width (character.js setBox). No menu item. Paragraph to point just removes the width, so wrapped lines rejoin instead of becoming hard returns as in Photoshop. | S | 0.5 · type-menu-commands |
| Type > Panels submenu (Character, Paragraph, Glyphs, Character Styles, Paragraph Styles) | Type > Panels | Partial | Only Window > Character exists (menu.js line 27, panels/character.js). No Paragraph, Glyphs, Character Styles or Paragraph Styles panel exists to list. | S | 0.7 · type-styles-prefs |

## type-styles

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Style overrides: plus indicator, Clear Override, Redefine by merging override | Character / Paragraph Styles panels | Missing | Nothing to override. | M | 0.7 · type-styles-prefs |
| Load character and paragraph styles from another document | Styles panel menu > Load Styles | Missing | Absent; PSD import does not read named style sheets either. | M | 0.7 · type-styles-prefs |
| Load Default Type Styles / Save Default Type Styles | Type > Load / Save Default Type Styles | Missing | No character or paragraph styles exist, so no defaults file. The Character panel does persist last-used values as Type tool defaults (writeDefaults). | S | 0.7 · type-styles-prefs |
| Character Styles panel: create, apply, edit (Basic, Advanced, OpenType), duplicate, delete | Window > Character Styles | Missing | No panel and no style objects in the document model; depends on per-run formatting. | L | 0.7 · type-styles-prefs |
| Paragraph Styles panel: create, apply, edit (character formats, indents and spacing, composition, justification, hyphenation) | Window > Paragraph Styles | Missing | No panel and no style objects. | L | 0.7 · type-styles-prefs |

## glyphs

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| On-canvas glyph alternates popup for the selected character | Type tool: select a character | Missing | No alternates lookup (needs GSUB access) and no popup. | M | 0.6 · type-opentype-glyphs |
| Glyphs panel: grid of every glyph in the font, insert by double-click, zoom, font and style choice | Window > Glyphs | Missing | No panel. Needs the font's cmap and glyph table (font data from queryLocalFonts().blob() parsed with opentype.js or HarfBuzz). | L | 0.6 · type-opentype-glyphs |
| Glyphs panel: recently used glyphs | Window > Glyphs | Missing | No panel. | S | 0.6 · type-opentype-glyphs |
| Glyphs panel: subset filter (Entire Font, Alternates for Selection, Unicode ranges, OpenType categories) | Window > Glyphs | Missing | No panel. | M | 0.6 · type-opentype-glyphs |

## international

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| East Asian typography: Tsume, Aki, Mojikumi, Kinsoku Shori, Burasagari, character alignment, Warichu | Character and Paragraph panels with East Asian features | Missing | None. Paragraph wrapping breaks at ASCII spaces only, so Chinese/Japanese paragraph text does not wrap at all. | L | 0.9 · type-international |
| Middle Eastern and South Asian features: direction, digit type, kashida, justification alternates, diacritic positioning, ligature options | Character and Paragraph panels with Middle Eastern features | Missing | No controls. Arabic/Hebrew are shaped and reordered by Chromium inside each drawn line only while tracking is 0; alignment and caret mapping (caretIndex measures prefixes left to right) are not direction-aware. | L | 0.9 · type-international |
| Paragraph direction and World-Ready composers | Paragraph panel with Middle Eastern features | Missing | No right-to-left paragraph setting. | M | 0.9 · type-international |
| Language Options: Standard / East Asian Features / Middle Eastern and South Asian Features; text engine choice (Latin and East Asian vs World-Ready layout) | Type > Language Options; Preferences > Type | Missing | No setting. Layout is one hard-coded path (space-delimited greedy wrap, left-to-right x placement). | M | 0.9 · type-international |

## formats

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Text preserved as live text or vectors in PDF / SVG export | File > Save As Photoshop PDF; Export As SVG | Missing | Text is exported as pixels in every format other than .pigment and PSD; no vector or live-text output. | M | 0.7 · pdf-export |
| PSD import: text stays editable | File > Open (PSD/PSB) | Partial | textLayerFromPsd (io.js) builds an editable layer from the first style run and first paragraph run only: family guessed from the PostScript name by regex (cssFamilyFromPsFont), bold/italic from the name or faux flags, size, colour, leading, tracking, underline, alignment, orientation, box width, matrix. Dropped: all further style runs, text warp, anti-alias, kerning, scales, baseline shift, caps, strikethrough, OpenType flags, box height, justification, indents, text on a path. Text is always re-rendered by Pigment, so it can look different from the stored Photoshop pixels. | L | 0.5 · psd-text |
| PSD export: text stays editable in Photoshop | File > Save As PSD | Partial | textToPsd writes one style and one paragraph style. Defects: font.name is the CSS family name, not a PostScript name, so Photoshop is likely to report a missing font or substitute; real bold/italic are written as faux; text on a path and stacked text are rasterised (io.js line 616), as is text in a Grayscale/ink view when its colour differs; no warp, no runs. | M | 0.5 · psd-text |
| Native format keeps text editable | File > Save (.pigment) | Done | Text layers are serialised as parameters (document.json) including pathText and transform. Fonts are referenced by family name only; nothing warns when the family is absent on another machine. |  |  |

## vertical-type

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Character rotation and vertical-type glyph forms (vert/vrt2 punctuation, brackets) | Character panel (East Asian features) | Missing | Stacked text draws the horizontal glyph forms upright, so CJK punctuation, long vowel marks and brackets are wrong in vertical text; no per-character rotation. | M | 0.9 · type-international |
| Tate-Chu-Yoko (horizontal-in-vertical) | Character panel menu | Missing | Not supported by layoutStacked (one upright glyph per cell). | M | 0.9 · type-international |
| Vertical type on a path | Vertical Type tool on a path | Missing | Refused: setOrientation shows 'Text on a path is always horizontal'. | M | 0.9 · type-international |
| Standard Vertical Roman Alignment | Character panel menu | Approximate | Only as the all-or-nothing choice between 'Vertical' (everything rotated) and 'Vertical, Stacked' (everything upright) per layer; not per character. | M | 0.9 · type-international |
| Vertical Type tool | Toolbox: T group | Approximate | TypeTool 'type-vertical': creates horizontal text rotated 90 degrees clockwise by a layer matrix (letters sideways). Not a vertical layout; upright CJK needs switching the layer to 'Vertical, Stacked' afterwards. | M | 0.9 · type-international |
| Orientation: Horizontal / Vertical | Type > Orientation; options bar toggle; Character panel menu Change Text Orientation | Approximate | text:orientation command (text-path.js setOrientation), Layer > Type radios and the Character panel Orientation select. 'Vertical' is the horizontal line rotated 90 degrees through the layer matrix (all glyphs sideways, CJK included); 'Vertical, Stacked' draws every glyph upright one em apart (Latin included). Photoshop mixes per script (CJK upright, Roman rotated unless Standard Vertical Roman Alignment). A CJK or mixed-script user would notice. Refused for text on a path. | M | 0.9 · type-international |

## automation

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Actions record type layer creation and type edits | Actions panel while using the Type tool | Missing | Type tool sessions are not recorded (USER-GUIDE: tool strokes are not recorded; layer:edit-text is in IGNORED_COMMANDS in actions/model.js). A 'Layer Is Type Layer' condition exists for conditional actions. | M | 0.8 · actions-recording |
| Text variables and data sets (text replacement) | Image > Variables > Define / Data Sets | Missing | No variables feature. | L | 0.9 · variables-data-sets |

## prefs

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Preferences > Type (smart quotes, missing glyph protection, show font names in English, Esc commits text, enable glyph alternates, recent fonts count, placeholder text, text engine) | Edit > Preferences > Type | Missing | No type preferences in extras.js; Esc always cancels; quotes are typed as entered. | M | 0.7 · type-styles-prefs |
| Type units (points, pixels, millimetres) and point/pica size | Preferences > Units and Rulers | Missing | Only 'Ruler units' exists in Preferences; type is always in pixels. | S | 0.7 · type-styles-prefs |

## vector

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Convert to Shape | Type > Convert to Shape | Missing | No command. Same prerequisite as Create Work Path (glyph outlines), then build a ShapeLayer with the text colour. | M | 0.5 · type-menu-commands |
| Create Work Path from type | Type > Create Work Path | Missing | No command (grep finds none). Canvas API gives no glyph outlines; needs font file parsing (opentype.js/HarfBuzz) to emit glyph contours into doc.workPath. | M | 0.5 · type-menu-commands |

## 3d

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Extrude to 3D | Type > Extrude to 3D; options bar 3D button | Missing | Absent; Pigment has no 3D (README 'What it does not do'). Adobe has retired Photoshop's 3D features, so this is lowest priority; an honest equivalent would be a bevel/extrude raster effect, not a 3D scene. | XL | 0.11 · 3d-lite |

## layers

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Copy CSS / Copy SVG from a type layer | Layer > Copy CSS, Copy SVG | Missing | No command. | S | 0.7 · vector-io |
| Free Transform on type keeps it editable (scale, rotate, skew, flip) | Edit > Free Transform on a type layer | Done | Matrix stored in layer.transform (image-ops.js); Distort and Perspective are refused for text as in Photoshop; Warp demands rasterising (see Warp Text). |  |  |
| Masks and clipping on type layers | Layer > Layer Mask / Create Clipping Mask | Done | Generic layer features; text can be the clipping base or carry a mask. |  |  |
| Type layer as smart object | Layer > Smart Objects > Convert to Smart Object | Done | layer:smart-convert accepts text layers (smart-object.js shiftLayer handles text); the text stays editable inside the smart object's contents. |  |  |
| Type layer in the Layers panel (T thumbnail, name follows the text until renamed) | Layers panel | Done | Text badge, tooltip with the full text, automatic name from the first 30 characters while the name is still automatic (autoName in text.js). |  |  |
| Filter the Layers panel to type layers | Layers panel: Kind filter (T) | Done | layers-extras/find.js KINDS 'Type layers'. |  |  |
| Rasterize Type Layer | Type > Rasterize Type Layer; Layer > Rasterize > Type | Done | layer:rasterize (layer-ops.js line 572) under Layer > Rasterize > Layer and the Layers context menu 'Rasterize Layer'; Rasterize All Layers too. |  |  |

## panels

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Properties panel for a type layer (transform, character, paragraph, type options) | Window > Properties | Done | 0.4: editable transform, character and paragraph sections | M | 0.4 · type-character-panel |

## presets

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Tool presets for the type tools | Options bar tool preset picker; Window > Tool Presets | Missing | No tool preset system for type (the last-used options persist as defaults only). | M | 0.5 · presets-panels |

## workspace

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Contextual Task Bar for type (font, size, colour, style quick controls) | Floating task bar with a type layer selected | Missing | No contextual task bar. | M | 0.8 · context-menus-task-bar |

## ai

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Match Font | Type > Match Font | Not feasible | Absent. Photoshop uses Adobe's trained recognition model and the Adobe Fonts catalogue. Honest substitutes: compare the selection against renders of the installed fonts (shape/feature matching, offline) or ask the user's own OpenAI/Gemini key to name candidate typefaces. |  |  |

## cloud

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Adobe Fonts filter, activation and automatic activation of missing fonts | Font menu; opening a document | Not feasible | Needs Adobe's cloud service and subscription licence (README already states Adobe Fonts are out). Substitute: user-supplied font files and a clear missing-font dialog. |  |  |
| More from Adobe Fonts | Type > More from Adobe Fonts; font menu cloud button | Not feasible | Absent. Needs Adobe's font service and licence. Honest substitute: an 'Add Fonts...' command that loads user-supplied .ttf/.otf/.woff2 files into a Pigment fonts folder (FontFace API), and optionally bundled OFL families. |  |  |

## color-management

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Type in CMYK / Lab / Grayscale / 16- and 32-bit documents | Image > Mode with type layers | Approximate | Text colour is always an 8-bit sRGB value and is not converted by a mode change (ARCHITECTURE: 'Text, shape, fill and adjustment layers are not converted'); the mode is only a view over it. | M | 0.10 · cmyk-lab-storage |

## layer-styles

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Layer styles on live text | Layer > Layer Style on a type layer | Done | The compositor applies layer.styles to any layer type (compositor.js applyStyles), so Drop Shadow, Stroke, Bevel and the rest stay live on editable text. Pigment also has a non-Photoshop per-font stroke in the Character panel. |  |  |

## select

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Load a type layer's outline as a selection | Ctrl/Cmd-click the layer thumbnail | Done | panels/layers.js line 245 and Select > Layer Transparency as Selection (select:from-layer). |  |  |
