# Type: PhotoCraft beyond Pigment's inventory, and what limits it

Judged from PhotoCraft's code at abb30df (crates/text, crates/engine/src/cmd/type_*.rs, crates/ui-egui/src/tools/type_tool, panels/type_panels_ui.rs), with docs/gaps.md G8 and docs/scorecard.md TYPE-218-* as leads.

## (a) PhotoCraft type features the page has no row for

Photoshop features the inventory missed:
- Type > OpenType > Numerals submenu (Default, Lining, Oldstyle, Proportional, Tabular and the four combinations), as radio styles that round-trip .pcraft (type_extra_cmds.rs numerals_*).
- Type > OpenType > Stylistic Sets, Set 1 to 20, one toggle per ssNN, round-tripped in .pcraft and PSD (#10285, #10308). The page groups stylistic sets with alternates. PhotoCraft has the full 20-set submenu.
- Paragraph direction buttons (Auto / LTR / RTL) in the Paragraph section and the options bar, plus bidi layout (ui text/bidi_text.rs, scorecard TYPE-218-2).
- Optical kerning computed from glyph outlines (text/src/optical.rs), with the Metrics/Optical mode carried in PSD Txt2.
- Opsz that follows the point size for variable fonts unless set (layout.rs variation_list).
- Edit > Transform > Warp on live type, which commits the layer's Warp Text in one step with no rasterize prompt, while Distort and Perspective are greyed, as in Photoshop (TYPE-218-9).
- Type Mask Escape-commits behaviour and a single undo step for the whole mask session (type_mask_cmds.rs).
- Preferences > Type: Show Font Names in English, Use ESC to Commit, Text Engine choice, Recent Fonts count (engine prefs.rs TypePrefs).
- Font menu filters: Show Variable Fonts, and Clear All (text/font_filters.rs).
- Missing-font warning when a file opens, also in Batch and Jobs logs (file_open.rs with_missing_fonts).
- Layer > Copy CSS for type layers in Photoshop's CSS form (layer_css_cmds.rs). Copy SVG is not there.
- Variables of type Text with data sets, Apply Data Set and Export Data Sets as Files (variables_cmds.rs, variables_ui.rs). This is a page row, but PhotoCraft's version is complete enough to note.

Beyond Photoshop:
- Every type operation is a headless engine command (type.create/edit/setStyle/caret/hitTest/navigate/insertText/info, type.fillPath, type.attachToPath, type.setPathPlacement and the rest), so type can be scripted over the CLI, the control protocol and MCP without the UI.
- Fallback font chains per script: Thai, Khmer, Lao, Myanmar, nine Indic scripts, Arabic, Hebrew, and CJK chains ordered by locale (text/src/fonts.rs, cjk.rs).
- Native COLR v0/v1 colour-font rendering with CPAL palettes in the document renderer (text/src/color_glyphs.rs). Pigment draws emoji through the Canvas fallback instead.
- PDF export writes glyph outlines plus an invisible, selectable and searchable text layer (ToUnicode Type 3 font) for topmost type (docs/pdf-vector-export.md). It honours the fonts' OS/2 embedding permissions.
- Paragraph-box handle drags lay out and render on a worker thread (tools/type_box_preview.rs, #7032). Text rasterisation stages run on all cores (docs/text-raster-performance.md).
- The spelling dictionary (SCOWL 50, en_US) is bundled offline and needs no system spell checker.
- Area type flows around holes and dents in the shape (text/src/area.rs).

## (b) What limits PhotoCraft's real usefulness in type

Open bugs and self-reported state:
- gaps.md G3 counted 46 open type issues out of 579 open issues on 2026-10-10.
- The Type tool froze the app for 60 s on one macOS machine (#2518). This is cited in gaps.md G8 and in target-app-parity.md as a readiness penalty.
- The scorecard's Type checklist shows 5 done, 5 partial, 0 missing. target-app-parity.md rates Type at 40% ready for real work, with an estimate of 120 to 200 h.

Features that exist but are thin or stubbed (checked in code):
- Hyphenation: the flag is stored (Alt+Shift+Cmd+H, PSD AutoHyphenate), but layout never breaks words (#6710, panel.rs:498). There is no Hyphenation dialog, no justification settings, no composer, no hanging punctuation and no bulleted or numbered lists. Pigment 0.4 has all of these.
- Type > Language Options and the Middle Eastern & South Asian Composer only move a checkmark: nothing reads `language_features` or `middle_eastern_composer` (menus/view_cmds/dispatch.rs:398).
- Type > Font Preview Size sets a view field that nothing reads. The font menu reads Preferences > Type > Font Preview Size, which does work.
- Type > Resolve Missing Fonts… has no dialog. The engine command returns the list of missing fonts, and replacing them needs a scripted map. Replace All Missing Fonts does work.
- Load/Save Default Type Styles keep the defaults in the session only (Session.type_defaults) and take only the first run of the active layer.
- Character Styles Style Options cover the basic attributes only, with no Advanced or OpenType pages.
- Superscript, Subscript, Character language and Standard Vertical Roman Alignment exist in the model, in type.setStyle and in PSD, but have no UI control.
- Cut, copy and paste inside text carry plain text only, so formatting is lost between layers (type_tool/editing.rs:108).
- The Glyphs panel lists only cmap-encoded characters, filtered by Unicode block. It shows no unencoded alternates, has no "Alternates for Selection" filter and has no on-canvas alternates popup.
- Features a font lacks are not greyed out in the OpenType UI (TYPE-218-5).
- Anti-aliasing: the seven modes are gamma curves on the same coverage. Windows and Windows LCD render as Sharp, with no hinting and no subpixel rendering (text/src/render.rs:96).
- Spelling is English-only.
- RTL has no visual caret: the arrow keys move in logical order. The paragraph direction is not stored in PSD.
- PSD round trip: path text in a document made in PhotoCraft is saved as point text, and area type as paragraph text with a warning. Photoshop area type opens as box text. Variable-axis values are not round-tripped.
- Area type has a 4096-anchor limit. Its first line sits about 0.24 em low, and its path has no handles after the type is placed.
- There are no East Asian composition features (mojikumi, kinsoku, tsume, aki, Tate-Chu-Yoko), no vertical type on a path, no Alt-click Paragraph Text Size dialog, no contextual task bar for type (the bar is used by Crop only) and no 3D.
- Performance (docs/text-raster-performance.md): rendering a full 300-dpi page of 14 pt text (4,000 characters, 3.75 MP of ink) takes 86 to 104 ms per edit on a 4-core laptop. About three quarters of that is per-pixel buffer work, not glyph geometry.
- gaps.md G9 reports that 8 of 199 preferences do nothing. I did not find a dead Type preference among them: smart quotes, missing glyph protection, English font names and placeholder text are all read in code.
