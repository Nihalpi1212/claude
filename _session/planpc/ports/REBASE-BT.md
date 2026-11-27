# REBASE-BT: group BT (B1 to B8, typography) re-checked against Pigment on PhotoCraft 057297b

Read each section beside its package in `PORTS-B.md` (sections 0, 1, the rows of section 2 it lists, and section 3).
**Where the two disagree, this file wins.** Where this file says nothing, the spec stands as written, tests included.
The spec's intent and its tests' intent still hold; the places, the framework pieces, the hooks and some APIs change.

**Tree checked:** `/home/user/claude/pigment` on `claude/pigment-photocraft` at `03ccb71` (`UPSTREAM-REVISION` =
`057297b`). Upstream's own change was diffed with `git diff abb30df 057297b` in `/home/user/storytold/photocraft`.
craft-libs is pinned at `18ffc07` (`Cargo.toml:15`, the `craft` facade) and was read in
`~/.cargo/git/checkouts/craft-libs-d830b991a08c6c3d/18ffc07` (below, `CL/` = that folder's `crates/`). The JS
references (`claude/fervent-newton-263lz3`) are still readable with `git show`; the files the spec calls
`lib/type/…` are at `pigment/src/renderer/lib/type/…` on that branch. No cargo was run and nothing in the repository
was changed. Paths below are relative to `pigment/`.

**Upstream's measured documents claim none of the group's rows.** `docs/scorecard.md` Type section (TYPE-218-1 to
-10, lines 247 to 260) has no superscript, Fractional Widths, No Break, System Layout, language, hyphenation,
justification, composer, hanging punctuation, lists, Reset Character/Paragraph, panel menus, missing-fonts dialog,
font sample text, formatted paste, Paste Without Formatting or numeric paragraph box. `docs/target-app-parity.md:484`
says only "composer parity partial". `docs/gaps.md` names none of them. `docs/parity-checklist.md` counts every Type
menu item live (74/74) because each has a command id, `type.resolveMissingFonts` included, although its menu click
only lists. TYPE-218-8 (scorecard line 258: paste replaces the selection) is plain-text paste only.
**What the code shows upstream did:** the Font Preview Size menu now sets the preference (row 9, B7), and the
framework the UI moved to already has Superscript/Subscript toggles, a Language select, a Hyphenate check box and a
Missing Fonts dialog, which PhotoCraft leaves switched off or unused. No row is dropped as a whole; row 9 shrinks to
one menu row.

## 0. What changed for the whole group

1. **Model, engine, layout: unchanged in the group's places.** `crates/doc/src/text.rs`, `crates/doc/src/lib.rs`
   (`TextLayer`), `crates/format/src/{manifest,convert}.rs`, `crates/text/src/layout*.rs` and
   `crates/engine/src/cmd/type_extra_cmds.rs` are byte-identical to abb30df. `type_cmds.rs` changed one line
   (`refresh_at` 655: `build_tysh` now returns `Option`). `crates/text/src/psd/{build,edit,import}.rs` gained
   robustness work (style-run compaction, `Txt2Error`, a 1024-byte font name cap) and shifted lines. Current lines:
   - `doc/src/text.rs`: `CharStyle` 62 (`baseline` 93, `language` 103), `ParagraphStyle` 190 (`auto_leading` 198,
     `hyphenate` 200), `impl Default for ParagraphStyle` 206.
   - `doc/src/lib.rs`: `TextLayer` 397 (`psd_raw` 407, `antialias` 416, default 435).
   - `format/src/manifest.rs`: `ContentM::Text` 256. `format/src/convert.rs`: 149 and 484/497 (unchanged).
   - `engine/src/cmd/type_cmds.rs`: `check_size_tracking` 110, `apply_char_props` 243 (`"baseline"` 396, `"language"`
     432), `apply_para_props` 440, `style_range` 493, **`style_paragraphs` 521 (already exists)**, `type.info` ~885,
     `CHAR_PARAMS` 1007, `type.edit` 1047 (params 1051, `antialias` 1155), `type.setStyle` 1172 (params 1177),
     `size_key` specs 1264.
   - `text/src/psd/build.rs`: `style_sheet_data` 23, `paragraph_properties` 72 (writes `AutoHyphenate` 89,
     `AutoLeading` 90), run-edit compares ~440 to 560 (`number`/`flag` 445, Td features 549),
     `UseFractionalGlyphWidths` written only when absent **1072**, `textGridding` **1181**.
   - `text/src/psd/import.rs`: `char_style` 565, `para_style` 633 (`hyphenate` 652). `guess_from_postscript` is in
     `text/src/fonts.rs:833` (re-exported to `psd.rs:22`), not in import.rs.
   - `io/src/psd_export.rs`: `layer_xmp_block` 644 (returns early when `l.xmp` is `None`), `warnings` 125.
     `io/src/psd_import.rs`: `shmd` XMP taken at 492 (unchanged).
   - `engine/src/cmd.rs`: `type_extra_cmds::specs()` 1405, `type_spell_cmds::specs()` 1408, `ai_cmds::specs()` 1475.
     **The spec's "land B1 after AI P5" is obsolete**: the AI port is merged.
   - `text/src/layout.rs`: `Engine::layout` 291, the per-layout `Env` built at 313 (struct 371). The spec's
     "where `antialias` is read today" is wrong: layout never reads it; `text/src/lib.rs:137` passes
     `layer.antialias` to `render::rasterize_warped`.
   - `text/src/layout/shaping.rs`: `map_offset` 293, `OverflowWrap::BreakWord` 334, `Para::break_lines` 390
     (`break_all_lines` 396/402), `Alignment::Justify` 474. `layout/lines.rs`: `scale_of` 117, `justify_line` 223,
     `line_start` 339, `emit_run` 454. `layout/style.rs`: `style_props` 100 (`Locale` 126). `layout/area.rs`:
     `break_area` 90.

2. **craft-libs moved from `e2dc681` to `18ffc07`, and is used through the `craft` facade.** Do not add
   `craft-text` or `craft-proof` as git dependencies of their own.
   - craft-text is `craft::text` (facade feature `text`, plus `text-german`, `text-french`, `text-spanish`,
     `text-italian`, `text-dutch`, `text-portuguese`; `CL/craft/Cargo.toml:739` to 800). It is already in
     `Cargo.lock` (line 2192) with `hypher 0.1.8` (4239), because `crates/ui-egui/Cargo.toml:13` enables `text` and
     `text-font-picker`. craft-text's default features (`hyphen`, `bidi`, `segment`) are on through the facade.
     craft-text depends on hypher with `default-features = false` (`CL/text/Cargo.toml`), so the GPL Slovak data
     cannot come in through feature unification; still run `cargo tree -e features -i hypher` once.
   - **`linebreak` is no longer a feature; it is always built** (`CL/text/src/lib.rs`). Its API is what the spec
     names: `Item` (`kind`, `width`, `stretch`/`shrink` tiers, `flagged`, `hang`, `hyphenation`, `emergency`;
     constructors `boxed`, `glue`, `penalty`, `forced`, `no_break`, `emergency`), `Params` (`tolerance`,
     `line_penalty`, `flagged_demerits`, `fitness_demerits`, `hyphen_limit`, `tier_cost`, `stretch_weight`,
     `shrink_weight`, `rag: Option<Rag>`), `Rag` (`hyphenation_zone`, …), `break_paragraph(items, width, params,
     tolerances) -> Breaks { lines: Vec<Line { ratio, tiers, … }>, method, … }`, `greedy(items, width, params)`
     (`CL/text/src/linebreak/mod.rs:30` to 385).
   - `craft::text::hyphen`: `Lang::for_language(&str)` (148, takes BCP 47 tags and InDesign names),
     `hyphen_points_in(word, &Limits, Lang)` (370), `Limits { min_word, after_first, before_last, capitalized }`
     (53; `usize` fields, default 5/2/2/true).
   - New since the spec: `craft::text::composer` (a glyph-level Knuth–Plass "Every-line composer" with `Glyph` and
     `Flexibility` traits) and `craft::text::lists` (bullet/number markers per level, `NumberStyle`, `ListMarker`,
     `markers`, `line_starts`). B3 still uses `linebreak` (it has the tiers, hang, zone and hyphen limit the spec's
     pipeline needs). B5 keeps the JS numbering (see B5: `lists::markers` numbers differently).
   - craft-proof is `craft::proof` (facade feature `proof`, `CL/craft/Cargo.toml:641`). It is **not** in Cargo.lock
     yet, but every dependency it adds is (`toml 1.2.1`, `unicode-normalization 0.1.26`, `miniz_oxide 0.9.1`,
     `log`), so enabling it needs no new crate download. Its English data is embedded from `CRAFT_I18N_DIR` at build
     time (`CL/proof/build.rs`: SCOWL en-US, **en-GB**, en-CA, en-AU); without it English falls back to its Moby list.
   - Licence notices: Pigment's `NOTICE` and `ATTRIBUTION.md` name only SCOWL (`NOTICE:31`, `ATTRIBUTION.md:26`).
     The hyphenation pattern notices for the six enabled languages come from `CL/../NOTICE` (hypher section) and
     go into both files with B3.

3. **The type interface is the framework's.** `crates/ui-egui/src/tools/type_tool/panel.rs` is now 119 lines: the
   Character and Paragraph sections are `craft::text::ui::character::{CharacterControls, ParagraphControls}`
   (`CL/text/src/ui/character.rs`, `character/paragraph.rs`), drawn by `character_controls` (panel.rs:73) and
   `paragraph_controls` (93). Their values and edits go through `type_tool/values.rs` (`character_values`,
   `character_step` 276, `paragraph_step` 318, `apply_character_events` 430, `apply_paragraph_events` 437), shared
   with the options bar (`options_bar.rs`) and the Properties type sections (`type_properties`, panel.rs). Gone:
   the hand-drawn toggle array (`toggles: [..; 6]`, `toggle_cell`), `type_tool/keys.rs`, `CharToggle` in
   `editing.rs`, `copy_selection`, `canvas/gesture.rs`'s `pointer_up`, `type_panels_ui.rs` (now the folder
   `panels/type_panels_ui/`), `text/font_preview.rs`, `text/font_filters.rs` and `view_cmds.rs`'s `FONT_PREVIEW`.
   - The canvas editor is the framework's `craft::text::ui::editor::TextEditor` over Pigment's
     `type_tool/host.rs` `LayerHost` (`TextEditorHost`: `replace(range, text, EditKind)`, `style_key(StyleKey, …)`).
     Its formatting chords are `TextEditorCommand` in the `textEditor` typing scope
     (`CL/text/src/ui/editor/commands.rs`): All Caps, Underline, Faux Bold, Faux Italic, Strikethrough, Hyphenate,
     leading/baseline/tracking steps. The framework's `CharToggle` has only those five toggles; Pigment cannot add
     variants (pinned craft-libs).
   - **The editor owns Copy, Cut and Paste** (`CL/text/src/ui/editor.rs:548` to 556, 618): Copy puts the plain
     selection on the clipboard with `cx.clipboard().put(&[ClipItem::Text])` (egui's `copy_text`); Paste calls
     `host.replace(range, text, EditKind::Pasted)`. The menu bar's Edit rows are the framework's `EditCommands`,
     which the focused editor takes first (`menus/invoke.rs:687` comment).
   - The type tool's pointer is a framework `CanvasTool` (`type_tool/pointer.rs`): `press` 271 → `press_at` 175;
     `release` 300 → `create_text(app, start, end)` 216 (this is the spec's `pointer_up`). `ToolPointer::mods` carries
     Alt.

4. **Panel menus are registry rows.** `crates/ui-egui/src/panels/registry.rs`: each `PanelEntry` has `rows`, `states`
   and `run` (lines 36 to 41). The Character and Paragraph entries (125, 133) have none today. The model to copy is
   `panels/history_menu_ui.rs`: an `ITEMS: &[Option<&str>]` list of command ids, `panel_rows` →
   `PanelRow::Command(CommandRef::new(id))` or `PanelRow::Separator`, `command_states` →
   `CommandState::new().enabled(..).checked(..)`, `run_fired` → `app.run(cmd, params)`. Labels and chords come from
   the app's command catalogue (`input/shortcut_dispatch.rs` `command_rows`, which takes every engine
   `CommandSpec` through `keymap_defs::command_defs()`). `xtask panel-commands` has an empty allow-list, so every
   click handler dispatches a command id. **The spec's "two arms in `panels/panel_docking.rs panel_menu`" become
   `rows`/`states`/`run` fields on the two registry entries.**

5. **Dialogs are on the framework's dialog host.** A form dialog is a `ParamDialog::command(key, title, rows)` of
   `Param` rows opened with `dialogs::params::open_param` / `open_param_unsaved`, and answered by a `ParamFamily`
   (`owns`, `run`, optional `check` that keeps the dialog open with a message, `cancel` that undoes a live preview)
   listed in `dialogs.rs` `PARAM_FAMILIES` (line 68; one line per family). The smallest example is
   `dialogs/count_group_name_ui.rs` (77 lines). A framework pattern dialog (`StackDialog`) is opened on
   `app.framework.dialogs` and taken by a `take` function listed in `dialogs.rs` `TAKERS` (438); example
   `panels/type_panels_ui/spelling.rs` (the framework's `CheckSpellingDialog`). `Param` offers `number`, `int`,
   `bool`, `choice`, `radio`, `visible_when`, `enabled_when`, `section` (`CL/ui-patterns/src/patterns/form_dialogs/param.rs`).

6. **Menus.** `menu_catalog.rs` is Photoshop's tree; add a row only for an item Photoshop has, then run
   `cargo xtask parity` (rewrites `docs/parity-checklist.md`; `xtask scorecard --check` reads its live count; raise
   `menus/parity.rs` `FLOOR`, now 663, if you like). A command the shell runs needs a row in
   `crates/engine/src/shell_commands.rs` `SHELL_COMMANDS` (line 9; `is_live` reads it) and an arm in
   `menus/invoke.rs`; the type arms are in `invoke_type_command` (651), which also fills in the Character panel's
   target (`type_tool::formatting_params`) for ids it lists (`type.openType.*`, `type.antiAlias.*`, …, line 662).
   An engine command whose `CommandSpec.menu` is non-empty becomes a menu row on its own (`menus/items.rs:183`).

7. **Engine commands with chords.** The model is `type_cmds.rs:1264` `size_key` (engine `CommandSpec.shortcut`,
   targeted by `invoke_type_command`). Engine chords bind in the Application scope.

8. **Words.** `tl!()` (English) for Pigment's own strings; the framework's words come with it: Superscript,
   Subscript and Language (`CL/text/src/ui/character.rs:80` to 92), Hyphenate (`character/paragraph.rs:39`), the
   Missing Fonts dialog's (`CL/font-manager/src/missing.rs` `MissingFontsWords`). The spec's
   `every_tl_literal_is_translated` test no longer exists; `cargo xtask i18n-report` lists untranslated strings.

9. **The legacy `.pigment` importer (group L, Pigment's own) now reports these features as losses**
   (`crates/io/src/legacy_pigment/text.rs` 135 to 163: "No Break", "Fractional Widths off", "bulleted and numbered
   lists", "Roman Hanging Punctuation", "Justification word, letter and glyph spacing", "Hyphenation settings";
   expected list in `legacy_pigment/text_smart_tests.rs:135`). Whichever package adds a model field maps the JS
   value into it there and removes that loss line. JS keys (`model.js` 50 to 75 on the JS branch): char `noBreak`,
   `fractionalWidths` (per run in JS); paragraph `hyphenation {minWord, after, before, limit, zone, capitalized,
   lastWord, acrossColumn}` (defaults 7/2/2/2/36/true/true/true), `justification {word, letter, glyph,
   autoLeading, singleWord}` (singleWord default `'justify-all'`), `composer: 'every'|'single'`,
   `breakRules: 'standard'|'legacy'`, `hangingPunctuation`, `list {type, marker, start, level}`; layer
   `typeOptions.systemLayout`. JS 0.3 documents get `{composer:'single', breakRules:'legacy'}` (`model.js:808`).
   These are Pigment files: no FORK.md hook entry.

10. **Checks that now apply.** New engine commands: `cargo test -p photocraft-engine --test panic_hunt -- --ignored`.
    New preferences (B8; B7 only if its sample pref is built): `prefs/validate.rs` (choices at 95, and
    `HIDDEN_UNTIL_IMPLEMENTED` 37: a preference nothing reads must be listed there, the `prefs_usage` test checks
    both ways), the Preferences page builds its rows from the model (`ui-egui/src/prefs/prefs_ui/fields.rs`
    `rules()`; label overrides at 199), then `cargo xtask scorecard --check`. New catalogue rows: `cargo xtask parity`.
    Panel rows: `cargo xtask panel-commands`.

---

## B1: type model and PSD (rows 3, 4, 5, 6, 7 PSD, 14/15/17/18/20 model, 16)

### Status of each row

| Row | Now in Pigment | Evidence |
|---|---|---|
| 3 Fractional Widths (model, PSD, command) | missing | no field in `TextLayer` (`doc/src/lib.rs:397`); `build.rs:1072` writes `UseFractionalGlyphWidths true` only when absent; import never reads it |
| 4 No Break (model, key, command) | missing | no `no_break` in `CharStyle` (`text.rs:62`); legacy importer reports it lost (`legacy_pigment/text.rs:135`) |
| 5 Reset Character | missing | no `type.resetCharacter` in any `specs()` |
| 6 System Layout (model, command) | missing | no field; `textGridding` written `None` only when absent (`build.rs:1181`) |
| 7 Language in PSD | missing | `char_style` (import.rs:565) and `style_sheet_data` (build.rs:23) have no `Language` |
| 14/15/17/18/20 model and keys | missing | `ParagraphStyle` (`text.rs:190`) has only `hyphenate` and `auto_leading`; `paragraph_properties` (build.rs:72) writes only `AutoHyphenate`/`AutoLeading` |
| 16 Reset Paragraph | missing | no command |

Nothing dropped. Upstream changed none of these files except PSD line shifts.

### Where things are now

| Spec names | Now |
|---|---|
| `crates/doc/src/text.rs`, `doc/src/lib.rs` `TextLayer` | unchanged; lines in §0.1 |
| `crates/format/src/manifest.rs` `ContentM::Text`, `convert.rs` 149/484 | unchanged (manifest 256; convert 149, 484, 497) |
| `type_cmds.rs` `apply_char_props`, `apply_para_props`, `check_size_tracking`, `CHAR_PARAMS`, setStyle params "line 1177", `type.edit` | all there: 243, 440, 110, 1007, 1177, 1047 |
| new `type_reset_cmds.rs`, `type_layer_opts_cmds.rs`, registered "beside `type_extra_cmds::specs()`" | still new; register at `cmd.rs:1405` (one line each, next to `type_extra_cmds`) |
| `build.rs` `paragraph_properties` "67", `style_sheet_data` "21", run-edit "404–499", `UseFractionalGlyphWidths` "991", `textGridding` "1098" | 72, 23, ~440–560, 1072, 1181 |
| `import.rs` `char_style` "567", `para_style` "627" | 565, 633 |
| new `crates/text/src/psd/language.rs` | still new |
| new `crates/io/src/type_xmp.rs`, hooks in `psd_export.rs` near `layer_xmp_block`, `psd_import.rs:492` | still new; `layer_xmp_block` 644 (it returns when `l.xmp` is `None`, so the hook must supply a packet); `psd_import.rs:492` unchanged |
| `craft_psd::metadata::put_layer_xmp` | there (`CL/psd/src/metadata.rs:143`); it writes a whole packet. Setting one property inside a packet is Pigment's to write (no craft helper) |
| `guess_from_postscript` "in import.rs" | `text/src/fonts.rs:833` |

### The plan, adjusted

The spec's B1 stands, with these changes:
1. **Registration:** `cmd.rs:1405`, one line per new file, with no AI coordination.
2. **Commands in `type_layer_opts_cmds.rs`** (spec names kept): `type.fractionalWidths`, `type.systemLayout`,
   `type.noBreak`, and also the character toggles that B2's panel menu and chords need, so every Character panel
   menu row is a command: `type.character.fauxBold`, `.fauxItalic`, `.allCaps`, `.smallCaps`, `.superscript`,
   `.subscript`, `.underline`, `.strikethrough`, each `{"layer"|"layers"?,"range"?,"on":bool?,"coalesce"?}`
   (omitted `on` toggles from the first run of the target, as `type.openType.*` do), journaled, labelled with
   Photoshop's menu words. Superscript/subscript set `"baseline"`, small/all caps `"caps"`. Give them no
   `CommandSpec.shortcut` here (B2 decides the chords, see B2). Also the paragraph toggles B5 needs:
   `type.hangingPunctuation`, `type.composer.singleLine`, `type.composer.everyLine` (radio), `type.list`.
3. **Native round trip:** the paragraph fields are inside `ParagraphStyle`, which the manifest stores as the doc
   type; the two layer flags go into `ContentM::Text` with a named default function for `fractional_widths`
   (missing = true). Keep the `legacy_composer` serde default exactly as the spec says.
4. **XMP (decision 5):** `io/src/type_xmp.rs` gives `write(&TextLayer) -> Option<serde_json::Value>`,
   `apply(&mut TextLayer, &Value)`, and `merge_into(packet: Option<&str>, value) -> Option<String>` (adds or replaces
   `pigment:typeExtra` in namespace `urn:x-pigment:type:1`, keeps every other property; writes a minimal packet when
   the layer has none). Hook in `psd_export.rs`: one line before `layer_xmp_block` (644) that computes the packet to
   write for a type layer; `layer_xmp_block` itself takes that packet instead of `l.xmp` (a two-line change: list
   both in FORK.md). Hook in `psd_import.rs` after line 495: `type_xmp::apply` when the layer is text. The list
   export warning goes into `warnings` (psd_export.rs:125).
5. **PSD keys:** as the spec's table. Writing `UseFractionalGlyphWidths`: replace the "only when absent" at
   `build.rs:1072` with the layer's value. `build_tysh` now returns `Option` (`type_cmds.rs:655`); nothing to change.
   The sample work in spec §5 items 1 to 3 is still open: neither the tree nor craft-libs has a sample or code with
   `HyphenatedWordSize`, `EveryLineComposer`, `NoBreak`, `Hanging` or `Language`. No key is invented.
6. **New: the legacy importer** (`crates/io/src/legacy_pigment/text.rs`, §0.9). Map JS `noBreak` → `no_break`;
   `fractionalWidths` (per run in JS) → the layer flag, off when every run has it off (else on, and keep a loss line
   "Fractional Widths off on some characters"); `typeOptions.systemLayout` → `system_layout`; `hyphenation` →
   `Hyphenation` (minWord→words_longer_than, after→after_first, before→before_last, limit→hyphen_limit,
   zone→zone_pt, capitalized, lastWord→last_word, acrossColumn→across_column); `justification.{word,letter,glyph}`
   → `Justification`, `singleWord` 'justify-all'/'left'/'center'/'right' → `SingleWord` (record the mapping of
   'justify-all' to `Justify`); `composer:'single'` or `breakRules:'legacy'` → `SingleLine`, else `EveryLine`;
   `hangingPunctuation`; `list` → `ListStyle` (B5's numbering reads it). Remove the matching loss lines and update
   `text_smart_tests.rs:135`.
7. **Engine keys:** as the spec. Also add `"noBreak"` and the paragraph keys to `type.info`'s output only if
   `type.info` lists style keys by name (it serialises the runs; check ~885).

**Tests (spec's, plus):** legacy import of a JS 0.4 type layer with noBreak, hyphenation, justification, composer
'single', a list and hanging punctuation → the fields are set and no loss is reported for them
(`legacy_pigment/text_smart_tests.rs`); a 0.3 layer (`breakRules:'legacy'`) opens Single-line. PSD write/read of
each new key; XMP round trip through `psd_export`/`psd_import` with an existing layer packet kept intact; panic hunt
over the new commands.

**Effort:** 2.5 days (the spec's 2, plus the legacy mapping and the packet-merge helper).

---

## B2: Character interface (rows 1, 2, 3, 4, 5, 6, 7 UI, 19 Character menu)

### Status of each row

| Row | Now in Pigment | Evidence |
|---|---|---|
| 1, 2 Superscript/Subscript buttons | partly done (framework) | `CharacterControls` draws both toggles in Photoshop's order when `.superscript(true)` (`CL/text/src/ui/character.rs:481`, 652 to 685); Pigment leaves it off (`panel.rs:79`) and drops the change: `values.rs:302` "The engine has no superscript/subscript style key" is wrong, `"baseline":"normal|superscript|subscript"` exists (`type_cmds.rs:396`, `CHAR_PARAMS`). Values already carry the position (`style_options.rs:151`) |
| 1, 2, small caps chords (⇧⌘=, ⌥⇧⌘=, ⇧⌘H) | missing | not in `TextEditorCommand`; no engine command |
| 3 Fractional Widths menu item, whole-pixel layout | missing | no panel menu; no rounding in `lines.rs` `emit_run` (454) |
| 4 No Break menu item, layout | missing | `style.rs` `style_props` (100) has no `TextWrapMode` |
| 5 Reset Character menu item | missing | |
| 6 System Layout menu item, rendering | missing | |
| 7 Language select | partly done (framework) | `CharacterControls::languages(&[(tag, name)])` draws Photoshop's bottom-row select (character.rs:484, 707) and `CharacterChange::Language(tag)` is already mapped to `{"language": tag}` (`values.rs:307`); Pigment passes no list, so it is hidden |
| 19 Character panel menu | missing | registry entry `character` (registry.rs:125) has no `rows` |

Nothing dropped.

### Where things are now

| Spec names | Now | Use instead |
|---|---|---|
| `type_tool/panel.rs` toggle array, `toggle_cell` (~l.370) | gone | `character_controls` (panel.rs:73): add `.superscript(true)` and `.languages(&list)` to the builder at line 79 |
| `type_tool/editing.rs:232 CharToggle` | gone (the framework's `craft::text::ui::editor::CharToggle`, 5 variants) | engine toggle commands from B1 (`type.character.*`) |
| `type_tool/keys.rs:320` | gone | chords: see plan step 3 |
| `panels/panel_docking.rs panel_menu` arms | gone | `rows`/`states`/`run` on registry entry `character` (`panels/registry.rs:125`); model `panels/history_menu_ui.rs` |
| new `type_tool/panel_menu.rs` | still new | holds `character_rows`, `character_states`, `run_fired` (and B5's paragraph ones) |
| new `type_tool/languages.rs` | still new | feeds `.languages()` |
| `text/src/layout/style.rs` (NoWrap), `lines.rs` (whole pixels) | unchanged | as the spec; the flags reach layout through `layout.rs` `Env` (built at 313, struct 371) |
| "the struct `layout.rs` builds where `antialias` is read" | layout does not read `antialias`; render does at `text/src/lib.rs:137` | System Layout's Sharp curve: one change at lib.rs:137 (`if layer.system_layout { AntiAlias::Sharp } else { layer.antialias }`) |
| test files `type_tool/tests.rs`, `panels_toggle_tests.rs` | there; `panels_toggle_tests.rs` now tests the options bar's panel button (#12054) | panel tests go in a new `type_tool/panel_menu_tests.rs` (harness as `font_picker_tests.rs:14` to 44) |

### The plan, adjusted

1. **Superscript/Subscript in the panel:** `panel.rs:79` gets `.superscript(true)`; `values.rs:303` maps
   `CharacterChange::Position(p)` to `{"baseline": "normal"|"superscript"|"subscript"}` and its stale comment goes.
   The Properties type section and the options bar share `character_controls`/`character_step`, so they follow.
   Words come from the framework.
2. **Language select:** `type_tool/languages.rs` keeps the spec's table (BCP-47 tag, English name). "Has hyphenation"
   is `craft::text::hyphen::Lang::for_language(tag).is_some()` (ui-egui already has `craft::text`); "has spelling"
   comes in B8 through an engine helper (`type_spell_cmds::has_dictionary(tag)`), so ui-egui need not enable
   `proof`. The suffix "(no dictionary)" is part of the name string the select shows. Pass the list with
   `.languages(&list)` at panel.rs:79. Default for new text: the spec's rule, in `type_tool/defaults.rs`
   `default_style_params`.
3. **Chords (⇧⌘= superscript, ⌥⇧⌘= subscript, ⇧⌘H small caps).** They collide in the Application scope with View ›
   Zoom In's alternate `Cmd++` (`prefs/tests.rs:865`; Shift+= on US keyboards) and View › Show › Target Path
   `Cmd+Shift+H` (`shell_commands.rs:49`); Photoshop binds them only while type is edited. Add them as rows in the
   `textEditor` scope in `input/shortcut_dispatch.rs` `command_rows` (`CommandDef::new(CommandRef::new(id), label,
   Scope::new("textEditor"))`, as the Application rows at line 233 are built). **First prove with a test** that such a
   row fires while the editor holds the keys and reaches `run_fired` (the framework delivers `textEditor` commands to
   the editor, which ignores ids it does not know). If it does not, ship the commands with no default chord (the
   panel menu and Edit › Keyboard Shortcuts still reach them), record it in FORK.md, and note the craft-libs ask
   (`CharToggle::{Superscript, Subscript, SmallCaps}` with Photoshop's chords). Route the ids through
   `invoke_type_command` (menus/invoke.rs:662 list) so a chord or menu click without a target gets the panel's.
4. **Character panel menu** (`type_tool/panel_menu.rs`, rows on registry entry `character`): Faux Bold, Faux Italic,
   All Caps, Small Caps, Superscript, Subscript, Underline, Strikethrough (B1's `type.character.*`, checked from
   `values::character_values`); separator; Fractional Widths, System Layout, No Break; separator; Reset Character.
   Fractional Widths shows disabled while System Layout is on. Each `run_fired` arm runs its command with
   `formatting_params(app)` merged in (as `toggle_opentype`, panel.rs:31). Two hook lines in `registry.rs` (listed in
   FORK.md). The Properties panel has no section menu; the panels only, as the spec allows.
5. **Layout:** as the spec (NoWrap and `OverflowWrap::Normal` for no-break runs in `style.rs`; whole-pixel advances in
   `lines.rs emit_run`; the two flags in `Env`).

**Tests:** `type_tool/tests.rs`: the Character panel shows Superscript and Subscript after Small Caps (query the
toggles by their framework labels); clicking Subscript sets `baseline` subscript on the selection and shows it
pressed; the language select lists the table and sets the run language. `panel_menu_tests.rs`: the Character menu
lists the rows in order; clicking No Break journals `type.noBreak`; checkmarks follow the selection; Fractional
Widths is disabled under System Layout. Chord test from step 3. Layout tests as the spec (Inter 9 pt "illicit",
the no-break box case). `cargo xtask panel-commands`.

**Effort:** 1–1.5 days (the toggles and the select are the framework's; the chords need the scope check).

---

## B3: composer and hyphenation (rows 15 layout, 20, 7 hyphenation)

### Status of each row

| Row | Now in Pigment | Evidence |
|---|---|---|
| 15 hyphenation in layout | missing | no hyphenation anywhere in `crates/text/src` (only PSD font names); `panel.rs:96` "PhotoCraft's layout does not hyphenate (#6710)" |
| 20 Single-line / Every-line composer | missing | `Para::break_lines` (shaping.rs:390) calls parley's greedy `break_all_lines`; parley still 0.11 (`text/Cargo.toml`) |
| 7 per-run hyphenation language | missing | `language` is only parley's `Locale` (style.rs:126) |

Nothing dropped. Upstream did nothing here (`target-app-parity.md:484`: "composer parity partial").

### Where things are now

| Spec names | Now |
|---|---|
| `craft-text = { git, rev = "e2dc681a3", features = [...] }` in `[workspace.dependencies]` | **not that**: in `crates/text/Cargo.toml` add `"text", "text-german", "text-french", "text-spanish", "text-italian", "text-dutch", "text-portuguese"` to the existing `craft = { workspace = true, default-features = false, features = ["font-catalog", "font-manager"] }` line. Use it as `craft::text::{hyphen, linebreak}`. `linebreak` needs no feature now. craft's `text` also pulls `craft-keymap` (small). Already in Cargo.lock |
| `craft_text::linebreak::{Item, Kind, Params, Rag, break_paragraph, greedy}` | same names (`CL/text/src/linebreak/mod.rs`); `greedy(items, width, &Params)`; `Breaks.lines[i].ratio/tiers` |
| `craft_text::hyphen::{Lang, hyphen_points_in, Limits}` | same; `Limits` fields are `usize` |
| `text/src/layout/shaping.rs` `Para::break_lines`, `prefix`/`map_offset` | 390, 293 |
| `text/src/layout/area.rs break_area` | 90 |
| new `text/src/layout/compose.rs` | still new |
| NOTICE / ATTRIBUTION | Pigment's own files at the repository root (`NOTICE`, `ATTRIBUTION.md`) |

### The plan, adjusted

The spec's B3 stands: decision 2's pipeline, the fast path, `compose.rs`, the 3-line hook in `Para::break_lines`, the
area fallback, the JS-oracle tests and the `#[ignore]` bench. Changes:
- The dependency line above replaces the spec's. Build on the web target too (`packaging/web/package.sh` caps each
  file at 25 MiB; the six pattern sets are small, but check the wasm size once).
- English hyphenation is craft-text's bundled dictionary and patterns (no `CRAFT_I18N_DIR` needed).
- The B2 → B3 → B4 → B5 order on `lines.rs` stands.
- `craft::text::composer` (new) is not used: it works on glyphs with its own costs and has no tiers, hang or hyphen
  limit API. Say so in a comment in `compose.rs`.
- The licence notices go into `NOTICE` and `ATTRIBUTION.md` (the six enabled languages' pattern lines from
  craft-libs' `NOTICE` hypher section).

**Effort:** 2 days (unchanged).

---

## B4: justification and hanging punctuation (rows 18, 17 layout)

### Status of each row

| Row | Now in Pigment | Evidence |
|---|---|---|
| 18 justification tiers | missing | parley `Alignment::Justify` (shaping.rs:474) and `justify_line` (lines.rs:223) only |
| 17 hanging punctuation | missing | `line_start` (lines.rs:339) has no hang |

Nothing dropped.

### Where things are now

`lines.rs` `justify_line` 223, `line_start` 339, `scale_of` 117, `emit_run` 454; `Item.hang`, `Item.stretch/shrink`
tiers, `Params.tier_cost`, `Line.ratio`/`Line.tiers` exist in `craft::text::linebreak` as the spec assumed. Nothing
else moved.

### The plan, adjusted

As the spec, on B3's `compose.rs`. No interface work. **Effort:** 1.5 days (unchanged).

---

## B5: Paragraph interface and lists (rows 14, 15 UI, 16 UI, 17 UI, 18 UI, 19 Paragraph menu, 20 UI)

### Status of each row

| Row | Now in Pigment | Evidence |
|---|---|---|
| 14 lists (layout, UI, command) | missing | no field, no marker drawing |
| 15 UI: Hyphenate check box | partly done (framework) | `ParagraphControls` draws it by default (`CL/text/src/ui/character/paragraph.rs:191`, 271) and `ParagraphChange::Hyphenate` is mapped to `{"hyphenate": on}` (`values.rs:341`); Pigment hides it with `.hyphenate(false)` (panel.rs:97) because layout did not hyphenate. ⌥⇧⌘H already toggles (`editing.rs:195`, via the framework's `StyleKey::Hyphenate`; test `input_tests.rs:564`) |
| 15 UI: Hyphenation… dialog | missing | |
| 15 UI: Paragraph Style Options Hyphenate | missing | `panels/type_panels_ui/style_options.rs:31` "#6710: layout never hyphenates", `ROWS_PARA` (32) has 16 rows without `StyleAttribute::Hyphenate` (the attribute itself is mapped, 71 and 85) |
| 16, 17, 18, 20 UI (menu items, Justification… dialog) | missing | registry entry `paragraph` (registry.rs:133) has no rows |
| 19 Paragraph panel menu | missing | as above |

Nothing dropped.

### Where things are now

| Spec names | Now | Use instead |
|---|---|---|
| `type_tool/panel.rs:415–499` Paragraph section, `panel.rs:498` #6710 comment | gone; `paragraph_controls` (panel.rs:93); comment at 96 | `.hyphenate(false)` → remove (default true); list controls: see plan |
| `type_tool/panel_menu.rs` `paragraph_menu` | new (B2 creates the file) | `paragraph_rows`/`paragraph_states`/run arms; registry entry `paragraph` (133) |
| new `dialogs/type_paragraph_dialogs.rs` with `hyphenation_dialog`, `justification_dialog` | still new | two `ParamDialog`s and one `ParamFamily` (model `dialogs/count_group_name_ui.rs`), one line in `dialogs.rs` `PARAM_FAMILIES` (68) |
| `panels/type_panels_ui.rs:457–463`, test `hyphenate_is_not_shown_in_paragraph_style_options` | moved to `panels/type_panels_ui/style_options.rs` (`ROWS_PARA` 32); the test no longer exists | add `StyleAttribute::Hyphenate` to `ROWS_PARA` (17 rows), delete the comment at 31; new test that the Paragraph Style Options editor shows Hyphenate |
| new `text/src/layout/lists.rs` + 1-line hook in `layout.rs` | still new | as the spec |
| `formatting_params(app)` targets | there (`type_tool/defaults.rs:36`) | |

### The plan, adjusted

1. **Paragraph panel (panel.rs:97):** drop `.hyphenate(false)` and its #6710 comment. The framework's
   `ParagraphControls` has no list controls and Pigment cannot add rows inside it, so draw the list row **after** the
   framework controls in `paragraph_controls`, in a `craft::ui::layout_components::Row` of its own:
   two `craft::ui::buttons::ToggleButton`s (Bulleted List, Numbered List; icons from
   `CL/ui-contract/icons/icons.toml`, else Pigment SVGs in `assets/icons/` listed in `icon_data.rs`), then, while a
   list is on, a `craft::ui::pickers::Select` for the marker and two `craft::ui::text::NumberField`s (start, level),
   each change dispatching `type.list` (B1) with `formatting_params`. Same row in the Properties type section
   (shared `paragraph_controls`). The click handlers dispatch commands, so `xtask panel-commands` passes.
2. **Paragraph panel menu** (`panel_menu.rs`, rows on registry entry `paragraph`): Roman Hanging Punctuation
   (`type.hangingPunctuation`, checked); Justification… and Hyphenation… (UI ids `type.justification` and
   `type.hyphenation` in `SHELL_COMMANDS` with an empty path, arms in `invoke_type_command` that open the dialogs;
   with params they could later apply directly); Adobe Single-line Composer / Adobe Every-line Composer
   (`type.composer.*`, radio checks); separator; Reset Paragraph (`type.resetParagraph`).
3. **Dialogs** (`dialogs/type_paragraph_dialogs.rs`): `ParamDialog::command` with `Param::int` rows for Words Longer
   Than, After First, Before Last, Hyphen Limit, `Param::number` (in the type unit) for the Zone, `Param::bool` for
   Capitalized, Last Word, Across Columns, and the Hyphenate check; Justification: 3×3 `Param::number` rows in %
   (use `Param::section` per row of Photoshop's grid), Auto Leading %, and a `Param::choice` for Single Word
   Justification. **Validation** (min ≤ desired ≤ max, ranges) is the family's `check` (returns `Err(Label)`; the
   dialog stays open with the message, as `count_group_name_ui::check`). **OK** runs one `type.setStyle` on the
   `formatting_params` targets, label "Hyphenation" / "Justification" (pass a `coalesce` key or give `type.setStyle`
   a label param, whichever `type.setStyle` already supports; else add the two as labelled B1 wrapper commands).
   **Live Preview:** the spec's Preview check box becomes a `Param::bool("preview")` whose rows apply through
   `type.setStyle` with a dialog-scoped `coalesce`, undone by the family's `cancel` hook (the `ParamFamily.cancel`
   that `filter_dialog::cancel` uses). Strings through `tl!`.
4. **Lists layout:** as the spec (`text/src/layout/lists.rs`, port `listNumber`/`listFormatter`/`toRoman`/`toAlpha`
   from `pigment/src/renderer/lib/type/paragraph.js:679` to 747). **Do not swap in `craft::text::lists::markers`**:
   it numbers differently from what JS users had (letters repeat, 27 → "AA", where JS `toAlpha` gives "aa"; a deeper
   bulleted paragraph ends a JS count but not craft's). Record this choice in the hand-off note.
5. **Style Options:** `ROWS_PARA` gains `StyleAttribute::Hyphenate`.

**Tests:** the spec's, with: the Paragraph panel shows Hyphenate and it sets `hyphenate` (framework label "Hyphenate");
the list row appears, and turning bullets on journals `type.list` and applies the 1.5 em indent; the Paragraph menu
rows, checks and radio; the Hyphenation dialog's OK issues one `type.setStyle` (inspect `app.session.journal`), and
Cancel after a preview leaves no history step; the Justification dialog refuses min > desired and stays open;
Paragraph Style Options shows Hyphenate. `cargo xtask panel-commands`.

**Effort:** 2 days (unchanged: the check box is free, the list row and the dialogs are framework pieces).

---

## B6: editing (rows 11, 12, 13/21)

### Status of each row

| Row | Now in Pigment | Evidence |
|---|---|---|
| 11 formatted copy and paste between type layers | missing | the framework editor copies plain text (`CL/text/src/ui/editor.rs:548`, 618) and pastes through `LayerHost::replace` → `insertion_style::replace` (`insertion_style.rs:53`), which inserts with the caret's style; scorecard TYPE-218-8 is plain paste only |
| 12 Paste Without Formatting | missing | Paste Special has three rows (`menu_catalog.rs:88` to 90) |
| 13 Alt-click numeric paragraph box | missing | `create_text` (pointer.rs:216) never opens a dialog; `alt_click_tests.rs` covers other tools only |

Nothing dropped.

### Where things are now

| Spec names | Now | Use instead |
|---|---|---|
| `type_tool/editing.rs:108 copy_selection`, `ctx.copy_text` | gone; the editor copies | detect the copy after the editor's pass (plan step 1) |
| `Event::Paste(text)` → `insert()` → `insertion_style::replace` | `TextEditorHost::replace(range, text, EditKind::Pasted)` (host.rs:66) → `insertion_style::replace` (53) | the paste hook goes in `insertion_style::replace` on `EditKind::Pasted` |
| clip in `PhotocraftApp` state | `crate::state::UiState` (`state.rs:193` has `type_insertion_style`) | add `type_clip: Option<TypeClip>` and `paste_plain: bool` there |
| `byte_at` from `type_spell_cmds.rs` | private there (27) | use the type tool's `byte_of` (`super::byte_of`, used in host.rs) |
| `type_cmds.rs` `type.edit` "runs", `style_paragraphs` | there (1047; `style_paragraphs` 521 already exists) | add the `"paragraphs"` param and `char_props_json`/`para_props_json` |
| `app/commands.rs` route for Edit commands while typing | `menus/invoke.rs` `invoke_type_command` (651; `select.all` while typing fires `EditCommands::SelectAll`, 689) | route `edit.pasteSpecial.pasteWithoutFormatting` there |
| enable rule | `menus/state.rs:102` (Paste in Place's rule) | `app.ui.text_edit.is_some()` |
| `canvas/gesture.rs:123 pointer_up(app, start, end)`, `pointer.rs:205`, test caller `editing.rs:571` | gone; `CanvasTool::release` (pointer.rs:300) → `create_text(app, start, end)` (216); `pointer.mods.alt` | |
| new `dialogs/paragraph_size_ui.rs` | still new | a `ParamDialog` + `ParamFamily` (model `count_group_name_ui.rs`), one line in `PARAM_FAMILIES` |
| `type_unit(app)` "as panel.rs uses" | now `values::doc_unit(app)` (`values.rs:28`, a `craft::text::ui::DocUnit`) | `Param::number_in_units`/`unit` for the two fields |

### The plan, adjusted

1. **Remember the clip on copy and cut.** New `type_tool/clipboard.rs`. In `controls.rs` `editor()` (196), note the
   selection before `editor.show_at` (214) and, after it, look in egui's platform output for a `CopyText(t)` from
   this pass (`ctx.output(|o| o.commands …)`). If `t` equals the noted selection's text, call
   `clipboard::remember(app, layer, range)` (a `TypeClip { text, runs, paragraphs }` sliced from the layer). That is
   two lines in `controls.rs`. A cut deletes after copying; remember before the deletion by slicing from the noted
   selection on the pre-pass text (keep the slice taken before the pass, store it when the copy shows up).
2. **Formatted paste.** In `insertion_style::replace` (53), when `kind == EditKind::Pasted`, `!app.ui.paste_plain`
   and `type_clip.text == normalise(text)` (line endings as the editor normalises them: `\n`), build the `type.edit`
   with `"replace"`, `"runs"` from the clip (`char_props_json`) and, for a multi-paragraph clip, `"paragraphs"`
   (`para_props_json`). One `if` line calling `clipboard::formatted_params` in `replace`. Otherwise today's path.
3. **Paste Without Formatting.** Catalogue row `(&["Edit", "Paste Special"], "Paste Without Formatting", None,
   "edit.pasteSpecial.pasteWithoutFormatting")` first in Paste Special (it is Photoshop's); a `SHELL_COMMANDS` row so
   it is live; the `invoke_type_command` arm sets `app.ui.paste_plain = true` and fires
   `EditCommands::Paste` (`fire(ctx, CommandRef::new(EditCommands::Paste.id()), FireSource::Menu)`, as `select.all`
   does at 689); `insertion_style::replace` clears the flag after the paste. Enabled only while editing
   (`menus/state.rs`). Then `cargo xtask parity`.
4. **Alt-click.** In `CanvasTool::release` (pointer.rs:300), when `pointer.mods.alt` and the press made no session,
   open the Paragraph Text Size dialog instead of `create_text`. Factor the parameter building out of `create_text`
   into `fn create_params(app, start, end) -> Value` so the dialog's OK runs the same `type.create` with
   `"box":[x,y,w,h]`. Prefill: the drag's size, or for a click Photoshop's default box (JS used the last size; keep
   the last size, as the brief says, and record it). The captured value holds the click point and the document's
   activation (`count_group_name_ui::open` captures `gen`); the `check` refuses OK after a document switch.
   The Type Mask tools share `pointer.rs`, so they follow.

**Tests:** the spec's, through the type tool harness of `type_tool/canvas_tests.rs`: copy bold red "ab" from layer 1
(fire `EditCommands::Copy` while editing), paste into layer 2 → runs bold red; put other text on the clipboard →
plain paste with the caret style; two paragraphs centred/right paste with their alignment; one undo step; Paste
Without Formatting with a formatted clip pastes plain, and is disabled when not editing; Alt-click opens the dialog
and creates nothing, OK 200×80 pt at 144 dpi → box 400×160 px at the click, Cancel creates nothing.

**Effort:** 1.5 days (unchanged; the copy detection replaces the two lines in `copy_selection`).

---

## B7: fonts (rows 8, 9, 10)

### Status of each row

| Row | Now in Pigment | Evidence |
|---|---|---|
| 8 WYSIWYG sample with selectable sample text | partly done upstream; the choice is **blocked** | the font picker is the framework's (`craft::font_manager::picker`, through `CharacterControls::font_picker`, `type_tool/fonts.rs:129`). Each row draws the word `fontPicker.sample` ("Sample", `CL/font-manager/src/picker.rs:44`) in the family's face, and a banner shows the selected characters or the layer's text in the lead family (`fonts.rs:75 preview_text`, test `font_picker_tests.rs:120 the_preview_sets_the_type_layers_text_or_the_selection_being_typed`): JS's `$selection` sample is there. `FontPickerSource` takes `preview_text` but no per-row sample (`CL/text/src/ui/character.rs:186` to 200), and `FontPickerSettings` has no sample field (`picker.rs:192`) |
| 9 Font Preview Size wiring | **done upstream** except the None item | `menus/view_cmds/dispatch.rs:294` runs `prefs.set {"values": {"type.fontPreview": k}}`, the check reads the pref (127), live ids are `FontPreview::parse` (51); `font_preview_size` and `FONT_PREVIEW` are gone; Preferences and menu share `prefs.type_.font_preview`, which the picker reads (`fonts.rs:113`). Missing: the "None" row (`menu_catalog.rs:519` starts at Small) |
| 10 Manage Missing Fonts | partly done (framework, unused) | `craft::font_manager::missing::{MissingFontsDialog, document_fonts, DocumentFont, MissingFontsResult}` (`CL/font-manager/src/missing.rs`: a row per missing font with a `FontPicker` for its replacement, a Document Fonts section, Replace Fonts / Don't Replace; built after PhotoCraft's `missing_fonts`). PhotoCraft does not open it (no use in `crates/ui-egui`). Engine unchanged: `type.resolveMissingFonts` maps by family only (`type_extra_cmds.rs:951`, spec 1097), `replace_fonts` 905, `style_font_missing` 824, `missing_fonts` 861. Open still warns only (`file_open.rs:159` to 170, `app/files.rs:129`) |

**Dropped:** row 9's wiring (done upstream at 057297b; abb30df only set `o.font_preview_size`). Only its None row stays,
in this package.

### Where things are now

| Spec names | Now | Use instead |
|---|---|---|
| `crates/ui-egui/src/text/font_preview.rs` (`SAMPLE`, cache), `text/font_filters.rs`, `type_tool/fonts.rs:593–710` | gone | the framework picker; Pigment owns only `type_tool/fonts.rs` (163 lines: `font_state`, `FontSourceState::source`, `finish_font_state`) |
| `TypePrefs` `font_preview` (prefs.rs:113) | `prefs.rs:1109`, `choice! FontPreview` at 112 | |
| `prefs/validate.rs` `"type.fontPreview"` | 96 | |
| `menus/view_cmds.rs:113/145 font_preview_size`, `dispatch.rs:394/146` | gone / dispatch 51, 127, 294 | |
| `menu_catalog.rs:519–523` | same lines | add None first |
| `type_extra_cmds.rs:905–957` | `replace_fonts` 905, `resolve_missing` 951, specs 1091/1097 | |
| new `dialogs/missing_fonts_ui.rs` with a table and `family_picker` from `type_panels_ui.rs:543` | `family_picker` gone with `type_panels_ui.rs` | `missing_fonts_ui.rs` wraps the framework's `MissingFontsDialog` (opened on `app.framework.dialogs`, taken in `TAKERS`, dialogs.rs:438) |
| `menus/invoke.rs` dialog openers | `invoke_type_command` (651) | |
| `file_open::with_missing_fonts_of`, `app/files.rs:125` status action | `file_open.rs:168`; open finishes in `dialogs/open_prompt.rs:360 open` | open the dialog there for user opens |

### The plan, adjusted

1. **Row 9:** one catalogue row `(&["Type", "Font Preview Size"], "None", None, "type.fontPreviewSize.off")` before
   Small. Use `off` (the preference's own value): dispatch already accepts and checks it, so no mapping and no
   dispatch change. `cargo xtask parity`.
2. **Row 8:** the per-row sample choice needs a craft-libs change (a `FontPickerSource::sample(&str)` or a
   `FontPickerSettings.sample`), which FORK.md treats as a question for the project's owner (pinned craft-libs).
   Do not build `TypePrefs.font_sample` until that exists: a preference nothing reads fails `prefs_usage`. Record in
   FORK.md that Pigment's 0.5 sample choice (Sample/Aa/Abc/"The quick brown fox") waits on craft-libs, and that the
   "selected text" choice is covered by the picker's banner. If the owner adds the API, the spec's plan applies with
   `font_state` setting it from the pref and the footer replaced by Preferences › Type (the framework picker has no
   footer to add dropdowns to).
3. **Row 10, engine:** as the spec (map keys PostScript name or family; values string or
   `{"family","style"?,"postscriptName"?}`; the list form with `postscriptName`, `style`, `weight`, `italic`, `layers`,
   `suggested` from `photocraft_text::fonts::guess_from_postscript` (fonts.rs:833); labels kept). Extend the spec's
   params string at `type_extra_cmds.rs:1097`.
4. **Row 10, dialog:** `dialogs/missing_fonts_ui.rs`: build `DocumentFont`s from `type.resolveMissingFonts`'s list
   (family, style, PostScript name), rows through `craft::font_manager::missing::document_fonts(catalog, &fonts)`,
   open `MissingFontsDialog::new(catalog, rows).default_family(<Pigment's default family>)` on
   `app.framework.dialogs`; its `take` (one line in `TAKERS`) turns `MissingFontsResult.replacements` into the map
   (key: the PostScript name when the row has one, else the family) and runs `type.resolveMissingFonts` once. The
   framework dialog picks a family only; the engine chooses the style (the nearest weight and slant, the `suggested`
   rule). Record that the spec's per-row Style column is not drawn. Words come from `MissingFontsWords`.
5. **Row 10, menu:** add `(&["Type"], "Manage Missing Fonts…", None, "type.manageMissingFonts")` (Photoshop 2026's
   name) with a `SHELL_COMMANDS` row and an `invoke_type_command` arm that opens the dialog; the same arm opens it for
   `type.resolveMissingFonts` called with no params (the menu click), so scripts calling it with no params from the
   engine still get the list. Keep Replace All Missing Fonts. `cargo xtask parity`.
6. **Row 10, on open:** after `open_prompt.rs:360 open` adds a document opened by the user (not Batch, not the
   automation open in `app/files.rs:180`), open the dialog when the document has missing fonts, as Photoshop and
   the framework's doc comment do; Batch keeps the warning line only (JS wrote a log line). The existing warning
   notice stays. This replaces the spec's "Manage…" button on the status line.

**Tests:** engine as the spec (`type_extra_cmds/tests.rs`: two PostScript names, suggested 700/400, a map by
PostScript name to `{"family":"Inter","style":"Bold"}` changes only that run, one undo step). UI: the Type menu
item opens `MissingFontsDialog` (`app.framework.dialogs.is_open::<MissingFontsDialog>()`); Replace Fonts journals
`type.resolveMissingFonts` with the map; opening a file with a missing font opens the dialog (extend
`file_open/tests.rs:1533 opening_type_in_a_missing_font_warns`); a Batch open does not. Row 9: invoking
`type.fontPreviewSize.off` sets `prefs().type_.font_preview == Off` and the None row is checked; the existing
`view_cmds/tests.rs:222` live check covers the others.

**Effort:** 1 day (row 9 is one line, row 8 waits, row 10 uses the framework dialog).

---

## B8: spelling per language (row 7 spelling)

### Status of each row

| Row | Now in Pigment | Evidence |
|---|---|---|
| 7 spelling by the run's language | missing | `type_spell_cmds.rs:16` uses `photocraft_text::spell::Dictionary` (SCOWL 50, US English only, `text/src/spell.rs`); the Check Spelling dialog is the framework's `CheckSpellingDialog` (`panels/type_panels_ui/spelling.rs:4`) and the Type tool's canvas menu lists suggestions (`canvas/canvas_tool_menu.rs`), both through `edit.checkSpelling` |

Nothing dropped.

### Where things are now

| Spec names | Now |
|---|---|
| `Cargo.toml` (craft-proof) | `craft::proof`: add `"proof"` to the `craft` features in `crates/engine/Cargo.toml:51` (deps already in Cargo.lock) |
| craft-proof API `is_correct_in`, `suggest_in`, `check_text`, `ProofLang`, `set_dictionaries_folder`, `has_dictionary` | all there (`CL/proof/src/lib.rs` 283, 605, 636, 673; `languages.rs:132`; `lang.rs:7`, with `EnGb`) |
| `engine/src/cmd/type_spell_cmds.rs` | there (list 94, change 119, changeAll 146, add 177, `check_spelling` 219, specs 279) |
| `text/src/spell.rs` "thin wrapper or retire" | keep it: `engine/src/command_hints.rs:31/45` uses `spell::edit_distance`, and `spell::words` is used by changeAll (155) |
| Preferences › Type "Dictionaries folder" in `prefs.rs` | `TypePrefs` at `prefs.rs:1103`; precedent for a folder string: `plug_ins.additional_plugins_folder` (prefs.rs:1083) |

### The plan, adjusted

As the spec, with: craft-proof through the facade; per-run `ProofLang` from `CharStyle.language` (B1's field already
exists) with `check_text(text, spans)`; user words still from `prefs.user_dictionary` (prefs.rs:1576); the new pref
`type.dictionariesFolder: String` (read by `type_spell_cmds` before each check, applied with
`set_dictionaries_folder` when it changed since the last call); a `pub fn has_dictionary(tag) -> bool` in
`type_spell_cmds.rs` for B2's language list. Tests that pin British results need the embedded data: guard
"colour is flagged in en-US and not in en-GB" on `craft::proof::has_dictionary(Some("en-GB"))` (test runs set
`CRAFT_I18N_DIR`, so it runs in CI). Keep the Actions recording tests (`type_spell_cmds.rs:416` to 450) green.
Run `cargo xtask scorecard --check` (new pref).

**Effort:** 1 day (unchanged).

---

## Order and shared files, adjusted

- Order stands: B1 → B2 → B3 → B4 → B5 → B6 → B7 → B8. B7 no longer touches `engine/src/prefs.rs` (row 8 waits), so
  the B7/B17 prefs conflict note in the spec is gone; B8 adds the one Type pref.
- Shared files now: `panels/registry.rs` (B2 `character`, B5 `paragraph`: two-field hooks each), `type_tool/panel.rs`
  (B2 line 79, B5 line 97), `type_tool/values.rs` (B2), `menus/invoke.rs` `invoke_type_command` (B2, B5, B6, B7),
  `engine/src/shell_commands.rs` rows (B5, B6, B7), `menu_catalog.rs` rows (B6, B7) then `cargo xtask parity`,
  `dialogs.rs` `PARAM_FAMILIES`/`TAKERS` lines (B5, B6, B7), `crates/io/src/legacy_pigment/text.rs` (B1, Pigment's
  own). `text/src/layout/lines.rs`: B2 → B3 → B4 → B5 strictly, as before.
- FORK.md "What Pigment added" (`docs/FORK.md:366`) lists every upstream hook named above.
