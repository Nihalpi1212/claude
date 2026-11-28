# PKG-port-B1: type model, commands and PSD keys (group BT, package 1)

Spec: PORTS-B.md section 1 and rows 3, 4, 5, 6, 7 (PSD), 14/15/17/18/20 (model), 16; REBASE-BT.md "B1".
Tree: `claude/pigment-photocraft`, on top of 8854e4e (group FU's last review fix). CI before starting: the newest
finished run (748ad9f) was green; 2d39c93 and 8854e4e were still running, so nothing to fix first.

## What was built

The model, the engine commands and keys, the native and PSD round trips and the legacy mapping of the JavaScript
Pigment's type settings. **No layout, panel, menu or chord uses them yet** (B2 to B5 do); the settings are kept,
saved, journaled and edited, but the text lays out as before.

### Model (`crates/doc/src/text.rs`, `crates/doc/src/lib.rs`)
- `CharStyle.no_break`.
- `ParagraphStyle.hyphenation: Hyphenation`, `.justification: Justification`, `.composer: Composer`
  (`#[serde(default = "legacy_composer")]`: missing = SingleLine; `Default` = EveryLine), `.hanging_punctuation`,
  `.list: Option<ListStyle>` (skipped when None).
- Types: `Hyphenation` (u8 fields, `zone_pt`; range consts `WORDS_LONGER_THAN` 2..=25, `AFTER_FIRST`/`BEFORE_LAST`
  1..=15, `HYPHEN_LIMIT` 0..=25, `ZONE_PT` 0..=8640 pt), `Justification` (`word`/`letter`/`glyph` `[f32; 3]` in %,
  ranges `WORD` 0..=1000, `LETTER` -100..=500, `GLYPH` 50..=200, `single_word: SingleWord`), `Composer`, `SingleWord`,
  `ListKind`, `ListStyle { kind, marker, start, level }` (`ListStyle::new(kind)`, `default_marker`, `MAX_START`
  9999, `MAX_LEVEL` 8), `LIST_NUMBER_STYLES` (decimal, lowerAlpha, upperAlpha, lowerRoman, upperRoman).
- **Choice (recorded):** the new structs' serde names are the command keys (camelCase: `wordsLongerThan`, `zone`,
  `wordSpacing`, `glyphScaling`, `singleWord`, `everyLine`, list `type`). Reason: `type_styles_cmds::parse_attrs`
  first tries a key as a model field; with snake_case model names a panel-shaped `{"hyphenation":{"afterFirst":3}}`
  would have parsed as a model value with defaults. Now both shapes are the same JSON.
- `TextLayer.fractional_widths` (default true), `.system_layout` (false).
- Native: `ContentM::Text` gains both flags (`default = "yes"` for fractional widths), `convert.rs` both ways.
- Hyphenation defaults 6/2/2/8/36 + three options on: the spec's "commonly seen" EngineData values. **No Photoshop
  sample was available**, so the test pins these, not a sample's; check them when a sample exists (spec §5 item 3).

### Engine (`crates/engine/src/cmd/type_layer_opts_cmds.rs`, `type_reset_cmds.rs`)
- Keys (one-line hooks in `type_cmds.rs`): `"noBreak"` (char); `"hyphenation"`, `"justification"` (partial objects
  merge), `"composer":"singleLine|everyLine"`, `"hangingPunctuation"`, `"list":null|{type,marker,start,level}` (a
  list object replaces the list, missing keys default, as JS normalize); `type.edit` `"fractionalWidths"`,
  `"systemLayout"`; `type.info` reports both flags. Validation `check_extra` is called at the end of
  `check_size_tracking`: out of range, wrong type, min > desired > max are errors.
- **Choice:** the list `level` is 0..=8 everywhere (model, key, `type.list`), not the spec's 1..9 in the key, so
  `type.info` shows what the key takes. The UI shows level + 1.
- Commands, all journaled, `menu: &[]`, no shortcut, Photoshop's words as labels and history names:
  `type.character.{fauxBold,fauxItalic,allCaps,smallCaps,superscript,subscript,underline,strikethrough}`,
  `type.noBreak`, `type.fractionalWidths`, `type.systemLayout` (per layer), `type.hangingPunctuation`,
  `type.composer.singleLine` / `.everyLine` (history "Composer"), `type.list` (`type` bullet|number|none, marker,
  start, level, `indent` = true: JS `listPatch`'s 1.5 em × (level+1) when the paragraph has no left indent; history
  "Bullets"/"Numbering"), `type.resetCharacter`, `type.resetParagraph`. Params: `layer` | `layers`, `range`, `on`
  (omitted: toggles from the active target's style where the edit starts, as `type.openType.*`).
  All Caps/Small Caps share `caps`, Superscript/Subscript share `baseline`: turning one on replaces the other,
  turning one off leaves the other.
- Reset Character/Paragraph follow Photoshop (font, size, colour reset too), keep the applied style and drop its
  overrides: each run becomes `text_styles.resolve_char(paragraph style, run style, "")`, each paragraph
  `resolve_para(style)`; with no styles that is `CharStyle::default()` / `ParagraphStyle::default()`.
- **Choice (B5 may revisit):** the list indent rule lives in the command, so scripts get it too.

### PSD (`crates/text/src/psd/pigment_keys.rs`, `language.rs`; `crates/io/src/type_xmp.rs`)
- EngineData written and read: `NoBreak`; `HyphenatedWordSize`, `PreHyphen`, `PostHyphen`, `ConsecutiveHyphens`,
  `Zone` (scaled like the indents), `WordSpacing`/`LetterSpacing`/`GlyphSpacing` (fractions), inserted after
  `AutoHyphenate`; `Hanging`, `EveryLineComposer` last. `UseFractionalGlyphWidths` is now written from the layer
  (was `true` when absent) and read into the layer.
- **Choice:** a ParagraphSheet without `EveryLineComposer` reads as SingleLine (PhotoCraft's own PSDs written before
  the key were laid out greedily). Out-of-range or disordered file values keep the defaults.
- `Language`: `language.rs` is an empty, sample-only table (`tag_for`, `code_for`); no code is guessed. An unknown
  code imports as no language; `build_engine_data` copies the template run's `Language` (by UTF-16 offset) onto a
  new run that has no language, so editing a Photoshop file keeps its languages. A run given a language in Pigment
  writes none until its code is in the table.
- XMP `pigment:typeExtra` (`urn:x-pigment:type:1`, JSON): System Layout, and per paragraph index the list,
  capitalized / lastWord / acrossColumn, singleWord; only non-defaults; nothing written when all are default.
  `merge_into` adds/replaces in element or attribute form under any prefix bound to the namespace, keeps every other
  property, makes a minimal packet only when needed, leaves a packet without an RDF element alone. Export:
  `export_packet(l)` feeds `layer_xmp_block`; a layer with lists warns ("Photoshop will not show its list markers").
  Import: `import_packet(l)` after the packet is taken (the packet stays in `l.xmp`).
- Not done in Txt2: Photoshop's `Txt2` paragraph runs are kept as the file has them (the spec only names
  EngineData). If Photoshop turns out to read paragraph settings from `Txt2` rather than EngineData, the new keys
  need writing there too; check with a sample.
- No spec §5 sample work was possible (no Photoshop here, no sample in the tree or craft-libs): `System Layout` is in
  XMP (no `textGridding` mapping), lists in XMP, `Language` table empty.

### Legacy `.pigment` (`crates/io/src/legacy_pigment/text.rs`)
noBreak, fractionalWidths (layer off when every run is off; else on with the loss line "Fractional Widths off on some
characters"), typeOptions.systemLayout, hyphenation (minWord/after/before/limit/zone, zone px → pt like indents;
missing subkeys and a hyphenating paragraph without the object get JS's 7/2/2/2/36; a non-hyphenating one without
it gets Photoshop's defaults), justification (word/letter/glyph clamped, disordered → default; singleWord
'justify-all' → Justify), composer ('single' or breakRules 'legacy' → SingleLine; 0.1–0.3 `from_legacy` now sets
both), hangingPunctuation, list (lower-alpha → lowerAlpha …). The loss lines for these are gone ("tab stops" stays).

## Hooks into upstream files (all in docs/FORK.md, section "Type settings: the model, the commands and the PSD keys")
- `crates/doc/src/text.rs`: fields, defaults, new types, `mod pigment_tests`.
- `crates/doc/src/lib.rs`: two `TextLayer` fields and defaults.
- `crates/format/src/manifest.rs`, `convert.rs` (rustfmt rewrapped the `ContentM::Text` destructuring line).
- `crates/format/tests/it/common/mod.rs` (sample sets the flags off-default), `tests/it/main.rs`.
- `crates/engine/src/cmd.rs` (two `pub mod`, two `specs()` lines), `lib.rs` (two `pub use`),
  `cmd/type_cmds.rs` (noBreak flag, `apply_para_extra`, `check_extra`, `apply_layer_keys`, param docs, `type.info`),
  `cmd/type_styles_cmds.rs` (perturbed values).
- `crates/text/src/psd.rs` (`pub mod language; mod pigment_keys;`), `psd/build.rs` (`put_char`, `put_para`,
  language keeping, `UseFractionalGlyphWidths`), `psd/import.rs` (`read_char`, `read_para`, fractional widths).
- `crates/io/src/lib.rs` (`pub mod type_xmp;`), `psd_export.rs` (warning; `layer_xmp_block` takes the packet),
  `psd_import.rs` (`import_packet`), `tests/it/main.rs`.

## Tests (all pass)
- doc `text::pigment_tests` (3), format it `type_settings` (2) — `nextest -p photocraft-doc -p photocraft-format
  -p photocraft-text --lib --tests`: 682 passed.
- text `psd::pigment_keys::tests` (5), `psd::language::tests` (2).
- io `type_xmp::tests` (5), it `psd_type_settings` (2), `legacy_pigment::text::tests` (+2),
  `text_smart_tests::mixed_runs_keep_their_characters_and_paragraphs` (updated) — `nextest -p photocraft-io
  --features photocraft-io/heif --lib --tests`: 1480 passed.
- engine `type_layer_opts_cmds::tests` (8), `type_reset_cmds::tests` (3) — whole `nextest -p photocraft-engine --lib
  --tests`: 5056 run, all pass after one test fix; panic hunt (`--test panic_hunt -- --ignored`): ok.
- ui-egui whole suite (nextest, -j 3, `--lib --bins --tests`): see the return summary.

## For the next package (B2 onward)
- Use the B1 command ids for the Character panel menu: `type.character.*`, `type.noBreak`, `type.fractionalWidths`,
  `type.systemLayout`, `type.resetCharacter`; B5: `type.hangingPunctuation`, `type.composer.*`, `type.list`,
  `type.resetParagraph`, and `type.setStyle` with `hyphenation` / `justification` for the dialogs. None has a menu
  row or chord; add chords per REBASE-BT B2 step 3.
- For per-paragraph styles use `photocraft_io::type_xmp::paragraph_styles` / `set_paragraph_styles` (paragraph runs
  merge equal neighbours, so a run index is not a paragraph index).
- Layout must read `TextLayer.fractional_widths`/`system_layout` (not yet in `layout.rs`'s `Env`), `no_break`,
  and the paragraph fields; nothing does yet.
- The composer default is EveryLine for new text but SingleLine for old native files and for PSDs without the key:
  B3's fast path should treat SingleLine + defaults as "today's layout" so old documents keep their breaks.
- Open: Photoshop samples for `Language`, `textGridding`/System Layout, hyphenation defaults, list storage, and
  whether `Txt2` carries the paragraph keys.
