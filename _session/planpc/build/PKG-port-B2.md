# PKG-port-B2: the Character interface, and No Break, Fractional Widths and System Layout in the layout (group BT, package 2)

Spec: PORTS-B.md rows 1, 2, 3, 4, 5, 6, 7 (UI), 19 (Character menu); REBASE-BT.md "B2" (wins where they differ).
Tree: `claude/pigment-photocraft`, on top of 4adcf9c6 (B1). CI before starting: the newest finished run (8854e4e9,
group FU's last review fix) was green; B1's run (4adcf9c6) was still in progress, so there was nothing to fix first.
REBASE-BT's line numbers were checked against the tree before each edit (groups A, P and FU did not move the B2
places: `panel.rs` builder, `values.rs` Position arm, `registry.rs` `character` entry, `invoke.rs`
`invoke_type_command`, `layout.rs` `Env`, `lines.rs` `emit_run`/`place_line`, `style.rs` `style_props`).

## What was built

### Layout (`crates/text/src/layout/whole_px.rs`, new; hooks in `layout.rs`, `lines.rs`, `style.rs`, `shaping.rs`, `lib.rs`)
- `Env.whole_px: WholePixels { advances, baselines }` from the layer: `advances` = Fractional Widths off or
  System Layout on; `baselines` = System Layout on.
- `snap_line(out, c0, g0, d0)`, called in `place_line` after the JustifyAll justification and before the vertical
  rotation, horizontal lines only: the line starts on a whole pixel, each caret cluster's advance (horizontal
  scale, kerning and tracking included) is rounded, every glyph moves by what the rounding added before its cluster
  and is rounded, decorations follow, and the line's `x0`/`x1` take the start and end shifts.
  **Choice (recorded):** the spec says "round each cluster's advance ... in `emit_run`"; it is done as one pass
  over the placed line instead, so kerning, tab stops, JustifyAll and decorations stay right without touching
  `emit_run`'s accumulation. JS (`shaper.js:360`) rounded the unit advance without tracking; here tracking is
  included (parley's cluster advance carries it).
  **Choice:** vertical type keeps fractional positions (the spec names horizontal metrics only).
- System Layout: baselines go through `WholePixels::baseline` in `frame_line` (so later lines follow the
  snapped one), and `layout::drawn_antialias(layer)` draws Sharp (None stays None) without changing the stored
  setting; used by `TextEngine::render` (REBASE's lib.rs:137), and also by `ui-egui/src/tools/type_box_preview.rs`
  (the live box preview, which rasterizes on its own) and `io/src/text_import.rs` (an imported layer's first
  render), so all three look the same.
- No Break: `style_props` pushes `TextWrapMode::NoWrap` for a no-break run (`Wrap` otherwise, parley's default, so
  layouts without No Break are unchanged: the whole text suite, 368 tests, still passes), and `push_run_piece`
  pushes `OverflowWrap::Normal` on the run so a no-break word wider than the box runs out of it rather than
  break at the edge (#6694's BreakWord stays for other runs). parley lags the wrap mode by one cluster, so the break
  before the first no-break cluster is still allowed and the one after its last is not: "no break at the edges"
  on the right only. That matches Photoshop for a selection that ends at a word's end.
- Line breaking measures shaped (fractional) widths, as the spec allows for the parley path (< 1 px per glyph).

### Character panel (`type_tool/panel.rs`, `values.rs`, new `languages.rs`, `defaults.rs`)
- `character_controls` builds `CharacterControls` with `.superscript(true).languages(&languages::rows())`: the
  framework draws Superscript and Subscript after Small Caps and Photoshop's bottom-row Language select. The
  Properties panel's Character section shares the function, so it follows. (The options bar uses `TypeBar`, which
  has no such toggles.)
- `values.rs`: `CharacterChange::Position` → `{"baseline": "superscript"|"subscript"|"normal"}` (the stale comment
  is gone); `target_styles` is now `pub(super)` (the panel menu reads No Break from it).
- `languages.rs`: 41 rows (tag, Photoshop's English name), English first. **Best knowledge, not checked against a
  Photoshop 2026 install.** "Has hyphenation" = `craft::text::hyphen::Lang::for_language(tag).is_some()`; "has
  spelling" is English only until B8 brings craft-proof through an engine helper (REBASE B2 step 2). A row with
  neither reads "Name (no dictionary)" (`tl!("(no dictionary)")`). Note: ui-egui enables only the facade's `text`
  feature, so today only English has hyphenation; the suffixes change when B3 turns on the six language features.
- New text: `default_style_params` adds `"language"` = the interface language's row (`for_interface`: exact tag,
  else the first row with the same primary subtag, Chinese by script, else en-US), unless a saved default names
  one. Reset Character resets the language too (to none), as B1 resets everything to `CharStyle::default()`.

### Character panel menu (`type_tool/panel_menu.rs`, new; `registry.rs` `character` entry, `invoke.rs`)
- Rows (`CHARACTER_ITEMS`): `type.character.{fauxBold, fauxItalic, allCaps, smallCaps, superscript, subscript,
  underline, strikethrough}`; separator; `type.fractionalWidths`, `type.systemLayout`, `type.noBreak`; separator;
  `type.resetCharacter`. Labels and chords from the command catalogue (B1's specs).
- States: checked from `values::character_values` (mixed = unchecked), No Break from `target_styles`, the layer
  flags from `target_text`. Fractional Widths is disabled while System Layout is on.
- `run_item`: the command with `formatting_params(app)` (layer or layers, range, coalesce), and `"on"` = the
  opposite of the shown check, so it follows what the user saw (as `toggle_opentype`). Without a type target the
  eight toggles and No Break set the next layer's defaults (`apply_defaults`, no history step); the layer flags
  and Reset Character are disabled there. **Choice (recorded):** the spec does not say; the panel's own buttons do
  the same.
- `invoke_type_command` also gives these ids the panel's target (`panel_menu::takes_panel_target`), so a key the
  user assigns in Edit › Keyboard Shortcuts, or another route through `menus::invoke`, works without params.
- The Paragraph entry is untouched (B5).

### Chords: not shipped (REBASE B2 step 3's check failed)
- REBASE's plan, `textEditor` rows in `shortcut_dispatch::command_rows`: the framework's `AppCatalog::new`
  refuses any row outside the app scope (`CommandDefError::NotApp`), and a refused catalog leaves the runtime with
  none of the app's rows. Test: `a_text_editor_row_in_the_app_catalog_is_refused`.
- The alternative, a Pigment command set in the `textEditor` typing scope (a `#[derive(CommandSet)]` with
  `scope = "textEditor", typing` and Photoshop's defaults): the keys are taken while the editor holds them, but the
  runtime reports only app-scope commands to the app (`FrameOutput::fired`: "the app-scope commands fired"); others
  go only to a component that takes them, and the editor takes only `TextEditorCommand`. The probe set (test-only)
  never reaches `shortcut_dispatch`, while the editor's own ⇧⌘K does. Test:
  `a_text_editor_scope_chord_never_reaches_the_app`.
- So `type.character.superscript`, `.subscript` and `.smallCaps` have **no default chord**; the panel menu and
  Edit › Keyboard Shortcuts reach them (an app-scope key the user gives them works everywhere, not only while
  editing). Recorded in FORK.md. If that test ever fails, the framework passes such commands on: give the three
  their chords then.

## For the project's owner

craft-libs is pinned (`18ffc07`), and changing it is your call. The request, for craft-libs' `craft-text`
(`crates/text/src/ui/editor/commands.rs` and `editor.rs`):
- add `CharToggle::Superscript`, `CharToggle::Subscript` and `CharToggle::SmallCaps` (today it has All Caps,
  Underline, Faux Bold, Faux Italic and Strikethrough);
- add `TextEditorCommand` rows with Photoshop's chords: Superscript `Cmd+Shift+=`, Subscript `Cmd+Alt+Shift+=`,
  Small Caps `Cmd+Shift+H`, in the `textEditor` typing scope (so they beat View › Zoom In's alternate `Cmd++` and
  View › Show › Target Path `Cmd+Shift+H` only while type is edited, as in Photoshop);
- the editor hands them to `TextEditorHost::style_key` like the other toggles.
Pigment's side then is one arm in `type_tool/host.rs` (`LayerHost`) mapping the three toggles to
`{"baseline": ...}` / `{"caps": "smallCaps"}`, and deleting the "no default chord" note in FORK.md. An alternative
craft-libs could offer instead: a way for an app to register its own commands in a typing scope and receive them
(e.g. the editor passing unknown `textEditor` commands on to the app's `fired` list).

## Files
New: `crates/text/src/layout/whole_px.rs`, `crates/text/src/pigment_type_tests.rs`,
`crates/ui-egui/src/tools/type_tool/{languages.rs, panel_menu.rs, pigment_character_tests.rs}`.
Changed (hooks, all in docs/FORK.md, section "The Character panel's Superscript, Subscript, Language and panel menu;
No Break, Fractional Widths and System Layout in the layout (typography, part 2)"):
- `crates/text/src/layout.rs`: `mod whole_px; pub use whole_px::drawn_antialias;`, `Env.whole_px` + its init line.
- `crates/text/src/layout/lines.rs`: `frame_line` baseline line; `place_line` `d0`, the `snap_line` call, `x0` shift.
- `crates/text/src/layout/style.rs`: `TextWrapMode` in `style_props`.
- `crates/text/src/layout/shaping.rs`: `OverflowWrap::Normal` in `push_run_piece`.
- `crates/text/src/lib.rs`: `render` uses `drawn_antialias`; `mod pigment_type_tests`.
- `crates/io/src/text_import.rs`, `crates/ui-egui/src/tools/type_box_preview.rs`: `drawn_antialias`.
- `crates/ui-egui/src/tools/type_tool.rs`: `mod languages; pub(crate) mod panel_menu;`, test module.
- `crates/ui-egui/src/tools/type_tool/panel.rs`: `.superscript(true).languages(&languages)`.
- `crates/ui-egui/src/tools/type_tool/values.rs`: Position arm, `pub(super) fn target_styles`.
- `crates/ui-egui/src/tools/type_tool/defaults.rs`: the language default.
- `crates/ui-egui/src/panels/registry.rs`: `rows`/`states`/`run` on `character`.
- `crates/ui-egui/src/menus/invoke.rs`: `takes_panel_target` in `invoke_type_command`.
- `docs/FORK.md`.

## Tests
RESULTS_PLACEHOLDER

## Spec rows
- Row 1/2 Superscript/Subscript: panel toggles (framework) wired to `baseline`, menu rows with checkmarks; the
  chords are not shipped (see above). PSD was done before B2.
- Row 3 Fractional Widths: menu row (checked, greyed under System Layout), whole-pixel layout. B1 did the model,
  command and PSD.
- Row 4 No Break: menu row, NoWrap/OverflowWrap layout. Not done: "a hyphenatable no-break word gets no hyphen" and
  the composer path's "no penalties inside or at the edges": B3 (there is no hyphenation or composer yet).
- Row 5 Reset Character: menu row (command from B1).
- Row 6 System Layout: menu row; whole-pixel advances, snapped baselines, Sharp curve; toggling off restores the
  layout exactly (test). PSD: XMP (B1); `textGridding` still unverified.
- Row 7 (UI): the Language select and the table; the new-text default. Not done here: hyphenation by language (B3),
  spelling by language (B8), the PSD `Language` table (needs samples; B1 left it empty).
- Row 19 (Character menu): done. The Paragraph menu is B5's.

## For the next package (B3 onward)
- `lines.rs` order B2 → B3 → B4 → B5: B2's hook is the `snap_line` call in `place_line`, after the JustifyAll
  `justify_line` and before `rotate_to_text_space`. B4's justification replaces `justify_line`/parley's justify for
  composed paragraphs: keep the snap after it, so Fractional Widths off still holds on justified lines.
- B3's composer must take rounded box widths when `env.whole_px.advances` is on (spec row 3), and give no penalty
  inside a `no_break` run (and none at its edges) and no hyphenation points in it (row 4). The fast path already
  honours `no_break` through parley's `TextWrapMode`.
- `languages.rs` `has_spelling` is a stand-in: B8 replaces it with the engine helper
  (`type_spell_cmds::has_dictionary(tag)`), per REBASE B2 step 2. When B3 enables the facade's language features
  in ui-egui (or the workspace), the "(no dictionary)" suffixes of German, French, Spanish, Italian, Dutch and
  Portuguese go away; `languages::tests` only pins English and Japanese.
- New text now carries a `language` (en-US for an English interface). Tests that compare a new layer's run style to
  `CharStyle::default()` would see it; none in ui-egui did.
- The Paragraph registry entry is free for B5's `rows`/`states`/`run`; `panel_menu.rs` is the place for
  `paragraph_rows` etc.
