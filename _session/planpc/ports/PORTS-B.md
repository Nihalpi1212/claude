# Ports B: Type, Select/Filter/View, tools, File/Edit (Pigment-ahead rows)

Scope: the 37 Pigment-ahead rows of `photocraft-eval/pigment-ahead.md` listed in the brief (19 Type, 10 Select/Filter/View,
5 tools, 3 File/Edit). The generative-AI rows belong to `planpc/ai/` and are not touched here.

Read-only research. Sources checked for this plan:
- the JavaScript Pigment on `claude/fervent-newton-263lz3` ("JS" below), and its 0.5 work on
  `origin/claude/fervent-newton-263lz3-wip05` ("JS 0.5");
- the Rust tree `/home/user/claude/pigment` at `ffb311f` ("PC" below);
- craft-libs at the pinned rev `e2dc681a3` (`/home/user/storytold/craft-libs`; the checkout is at that commit).

Paths are relative to `pigment/` for the Rust tree and to `pigment/` on the JS branch for JS files.

## 0. Decisions that shape every type package

1. **Use craft-libs' `craft-text` for hyphenation and line composition.** It exists at the pinned rev
   (`crates/text`, MIT OR Apache-2.0):
   - `craft_text::hyphen`: `Lang::for_language(tag)`, `hyphen_points_in(word, &Limits, lang)` and `Limits { min_word, after_first, before_last, capitalized }`;
   - `craft_text::linebreak`: a box/glue/penalty model (`Item`, `Kind`, `Params`, `Rag`), `break_paragraph` (Knuth–Plass passes, then greedy), `greedy`, and per-item `hang`, `flagged`, `hyphenation` and `emergency`. It also has a `hyphen_limit` and `Rag::hyphenation_zone`.

   That is Adobe's composer model: word, letter and glyph tiers, a Hyphen Limit, a Hyphenation Zone and hanging punctuation. So we don't port the JS composer (`lib/type/paragraph.js`). Its tests become our acceptance tests.

   The dependency line is
   `craft-text = { git = "https://github.com/storytold/craft-libs", rev = "e2dc681a3", default-features = false, features = ["hyphen", "linebreak", "german", "french", "spanish", "italian", "dutch", "portuguese"] }`
   in `Cargo.toml` `[workspace.dependencies]`, then `craft-text.workspace = true` in `crates/text/Cargo.toml`.
   - Never enable `slovak-gpl` or `all-languages` without a licence review.
   - hypher's default features pull in GPL Slovak data through feature unification. Check `cargo tree -e features -i hypher` once (only after the AI team releases the build lock).
2. **parley keeps shaping. Our composer chooses the breaks.**
   - Today `crates/text/src/layout/shaping.rs` `Para::break_lines` calls parley's greedy `break_all_lines`, and parley justifies (`Alignment::Justify`). parley 0.11 has no soft-hyphen support and no hook for custom break positions: `break_overrides.rs` only sees code-point pairs, not positions.
   - So a wrapping paragraph that needs the composer runs this pipeline:
     1. shape it unbroken (`break_all_lines(None)`) and read the cluster advances;
     2. build `craft_text::linebreak::Item`s: boxes for clusters, glue for spaces, penalties at UAX #14 opportunities (parley's/ICU's, read from the unbroken layout's clusters) and at hyphenation points;
     3. run `break_paragraph`;
     4. shape again with the chosen breaks forced. Insert U+2028 at each break, and U+2010 at a hyphenated break, into the paragraph text. `Para` already maps offsets through `prefix`/`map_offset`; extend that mapping with an insertion list so carets, selection and `LineInfo.range` stay in layer-text offsets;
     5. place each line with the composer's per-line ratio, applied as word, letter and glyph adjustments in `layout/lines.rs` (replacing parley's justify for these paragraphs).
   - A **fast path** keeps today's parley path unchanged: point text, path text, and paragraphs whose settings are all Photoshop's defaults (Single-line composer, no hyphenation, default justification, no hanging). Existing layout tests then stay byte-identical.
3. **Composer default.**
   - `ParagraphStyle::default()` gets `composer: EveryLine`, as in Photoshop and JS.
   - The serde default for a *missing* field is `SingleLine` (`#[serde(default = "legacy_composer")]`, overriding the struct-level `#[serde(default)]` for that field). Native documents saved before the port then reopen with exactly the breaks they had.
   - PSD import reads `EveryLineComposer`, so Photoshop files get Photoshop's composer.
4. **Model fields first, in one package (B1).** That is CharStyle and ParagraphStyle in `crates/doc/src/text.rs`, the layer flags in `TextLayer` (`crates/doc/src/lib.rs`) and the native manifest (`crates/format/src/manifest.rs` `ContentM::Text`, `crates/format/src/convert.rs`), plus the engine keys and the PSD mapping. Later packages then never fight over these files.
5. **Where Photoshop's PSD storage is not known, store it privately and say so.**
   - Two items have no EngineData key we could verify: bulleted/numbered lists, and System Layout. The same goes for any hyphenation or justification setting without a verified key (Hyphenate Capitalized Words, Last Word, Across Columns, Single Word Justification).
   - They go in a Pigment XMP property on the layer (`Layer.xmp`, written into `shmd` by `crates/io/src/psd_export.rs` `layer_xmp_block`). The namespace is `urn:x-pigment:type:1`, the property `pigment:typeExtra`, the value JSON.
   - Photoshop keeps layer XMP, so a Photoshop round trip doesn't lose them, but Photoshop doesn't apply them. The PSD export warning list (`warnings` in `psd_export.rs`) names layers whose lists Photoshop won't show.
   - No EngineData key is invented. When someone saves a Photoshop 2026 sample with the setting on, map its key and drop the XMP fallback for it.
6. **Hooks into upstream files stay one or two lines** and go in `docs/FORK.md` under "What Pigment added". New code goes into new files wherever a module boundary allows.
7. **i18n**: English `tl!("…")` keys only. Rows come later through craft-i18n (`crates/ui-egui/src/i18n.rs` header). Hover tips that are still plain English literals in `type_tool/panel.rs` must go through `tl!` once they are new strings, because `every_tl_literal_is_translated` checks complete catalogs. Read that test before adding tips.
8. **Engine commands for everything scriptable.** Every new toggle and dialog result is an engine command (journaled, recorded into Actions, reachable from MCP/CLI) and has a menu or panel entry. The UI only opens dialogs.

### 0.1 Hyphenation and spelling dictionaries: JS then, Rust now

**What JS used.** Its own Liang implementation, `lib/type/hyphenation.js` (`parsePatterns`, `liang`, `hyphenateWord`, `ensureLanguage`; not Hypher). It ran on hyph-utf8 TeX patterns copied from the npm package `hyphen@1.14.1` (ISC) by `scripts/build-type-paragraph-data.mjs`, listed in `lib/type/patterns/LICENSES.md`:

| JS file | hyph-utf8 | Licence |
|---|---|---|
| en-us.js | hyph-en-us.tex | all-permissive (FSF), © Kuiken |
| en-gb.js | hyph-en-gb.tex | MIT |
| de.js | hyph-de-1996.tex | MIT |
| fr.js | hyph-fr.tex | MIT |
| es.js | hyph-es.tex | MIT/X11 |
| it.js | hyph-it.tex | LPPL or MIT (used as MIT) |
| nl.js | hyph-nl.tex | MIT |
| pt.js | hyph-pt.tex | BSD 3-clause |

Line breaking used Unicode 16 LineBreak.txt (`patterns/line-break.js`, Unicode License V3). JS had no spelling per language: "spelling waits for the spelling checker" (`docs/parity/type.md` row 22).

**What the Rust port uses** (all at the pinned craft-libs rev):
- **Hyphenation: `craft-text::hyphen`.**
  - English: the bundled Moby Hyphenator II dictionary (public domain) plus craft-text's own trained en-us patterns (CC0-1.0).
  - Other languages: hyphen patterns from hyph-utf8 as packaged by typst's `hypher` crate (code MIT OR Apache-2.0), one cargo feature each. The pattern licences are per file: LPPL, MIT, BSD-3-Clause, Unlicense or permit-any-use. Slovak is GPL-2.0-or-later and stays off.
  - Enable German, French, Spanish, Italian, Dutch and Portuguese: the seven JS languages plus en-US. More languages are one feature each, after their header is read.
  - Copy the notices of the enabled pattern files into Pigment's NOTICE/ATTRIBUTION (craft-libs `NOTICE` lines 66–80 and `ATTRIBUTION.md` row 22 have the text).
  - **One regression against JS**: craft-text hyphenates British English with the US dictionary, while JS had hyph-en-gb (MIT). File a craft-libs follow-up to add en-GB patterns; it doesn't block the port.
  - Alternatives considered and not chosen:
    - the `hyphenation` crate (MIT/Apache, Knuth–Liang over hyph-utf8; its `embed_all` embeds files of mixed licences, and it has no paragraph model);
    - `hypher` directly (that is what craft-text wraps);
    - a port of hyphenation.js (about 120 lines, but it duplicates what craft-text already has).
- **Spelling: craft-libs' `craft-proof`** (MIT OR Apache-2.0).
  - It gives per-language spelling (`is_correct_in`, `suggest_in`, `check_text` with per-run `ProofLang`) and a Hunspell `.aff/.dic` reader.
  - Its English data is SCOWL plus the public-domain Moby list. Other languages use Hunspell dictionaries installed on the system or in a dictionaries folder (`set_dictionaries_folder`).
  - Dictionaries with restrictive licences (it_IT is GPL) are deliberately not bundled.
  - This replaces the English-only `crates/text/src/spell.rs` (SCOWL 50) as the backend of `type_spell_cmds.rs` (package B8).

## 1. Model and PSD map (built in B1, used by everything else)

### `crates/doc/src/text.rs`

`CharStyle` gets `pub no_break: bool` (default false). `language: Option<String>` already exists.

`ParagraphStyle` gets these fields, all `#[serde(default)]`:

```rust
pub hyphenation: Hyphenation,          // settings; `hyphenate: bool` stays the on/off
pub justification: Justification,
#[serde(default = "legacy_composer")]
pub composer: Composer,                // SingleLine | EveryLine; Default::default() = EveryLine
pub hanging_punctuation: bool,         // Roman Hanging Punctuation
pub list: Option<ListStyle>,
```

```rust
pub struct Hyphenation {
    words_longer_than: u8,   // 2..=25
    after_first: u8,         // 1..=15
    before_last: u8,         // 1..=15
    hyphen_limit: u8,        // 0..=25, 0 = no limit
    zone_pt: f32,
    capitalized: bool,
    last_word: bool,
    across_column: bool,
}
pub struct Justification {
    word: [f32; 3],          // %, 0..=1000
    letter: [f32; 3],        // %, -100..=500
    glyph: [f32; 3],         // %, 50..=200
    single_word: SingleWord, // Justify | Left | Center | Right
}
pub struct ListStyle {
    kind: ListKind,          // Bullet | Number
    marker: String,          // bullet char, or "decimal|lowerAlpha|upperAlpha|lowerRoman|upperRoman"
    start: u32,
    level: u8,               // 0..=8
}
```

Defaults:
- `Hyphenation`: what a Photoshop 2026 sample's ParagraphSheet holds. The values commonly seen are HyphenatedWordSize 6, PreHyphen 2, PostHyphen 2, ConsecutiveHyphens 8 and Zone 36; JS used 7/2/2/2/36 (`lib/type/model.js` HYPHENATION_DEFAULTS). A test pins whatever the sample says.
- `Justification`: Photoshop's 80/100/133, 0/0/0 and 100/100/100.
- Auto Leading stays where it already is, in `ParagraphStyle.auto_leading`.

### `crates/doc/src/lib.rs` `TextLayer`

Add `pub fractional_widths: bool` (default **true**) and `pub system_layout: bool` (default false).
- Both are per layer, as in Photoshop: "you cannot set the option for selected characters".
- Mirror them in `crates/format/src/manifest.rs` `ContentM::Text`. Give the manifest field a named default function so missing means true, then update `crates/format/src/convert.rs` lines 149 and 484.

### Engine keys

`crates/engine/src/cmd/type_cmds.rs`:
- `apply_char_props` gains `"noBreak":bool`.
- `apply_para_props` gains:
  - `"hyphenation":{"wordsLongerThan","afterFirst","beforeLast","hyphenLimit","zone":pt,"capitalized","lastWord","acrossColumn"}` (a partial object merges, as JS `mergeChanged` did);
  - `"justification":{"wordSpacing":[min,des,max],"letterSpacing":[…],"glyphScaling":[…],"singleWord":"justify|left|center|right"}`;
  - `"composer":"singleLine|everyLine"`, `"hangingPunctuation":bool`;
  - `"list":null|{"type":"bullet|number","marker":str,"start":0..9999,"level":1..9}`.
- Update the `CHAR_PARAMS` docs and the `type.setStyle` params string (line 1177).
- `type.edit` gains layer keys `"fractionalWidths":bool` and `"systemLayout":bool`.
- Validation goes next to `check_size_tracking`. Out-of-range values are an error, never a clamp-and-continue: that is the house style, for example `"leading"`.

### PSD (EngineData; `crates/text/src/psd/build.rs` and `import.rs`)

| Model | EngineData | Where | Status |
|---|---|---|---|
| `baseline` (super/sub) | `FontBaseline` 1/2 | StyleSheetData | done (tests in `psd.rs:240`) |
| `no_break` | `NoBreak` bool | StyleSheetData | new, read and write |
| `language` | `Language` int | StyleSheetData | new: table in a new `crates/text/src/psd/language.rs` built **from Photoshop samples** (one saved type layer per language in Photoshop's menu). Unknown codes import as `None` and the original value round-trips through `psd_raw`. Never guess a code. |
| `fractional_widths` | `UseFractionalGlyphWidths` bool | EngineDict (layer) | new: import it; `build.rs:991` now writes `true` only when absent, so write the layer's value |
| `system_layout` | unknown (candidate: the TySh descriptor's `textGridding` `None`/`Round`, written at `build.rs:1098`) | layer | verify with a sample saved both ways; if `textGridding` follows the toggle, map it; else XMP (decision 5) |
| `hyphenate` | `AutoHyphenate` | ParagraphSheet | done |
| hyphenation settings | `HyphenatedWordSize`, `PreHyphen`, `PostHyphen`, `ConsecutiveHyphens`, `Zone` (pt; scale with `k` like `FirstLineIndent`) | ParagraphSheet | new; capitalized/lastWord/acrossColumn in XMP until a key is verified |
| justification | `WordSpacing`, `LetterSpacing`, `GlyphSpacing` (3 reals each, fractions: 0.8/1.0/1.33), `AutoLeading` | ParagraphSheet | new (AutoLeading already written); single-word justification in XMP |
| `hanging_punctuation` | `Hanging` bool | ParagraphSheet | new |
| `composer` | `EveryLineComposer` bool | ParagraphSheet | new |
| `list` | none known | XMP `pigment:typeExtra` | new; export warning |

- Write in `paragraph_properties()` (build.rs:67) and `style_sheet_data()` (build.rs:21), and in the run-edit paths that patch an imported object (`build.rs:404–499` compares and sets keys one by one). Read in `char_style()` and `para_style()` (import.rs:567 and 627).
- The XMP part goes in a new `crates/io/src/type_xmp.rs` (`write(&TextLayer) -> Option<serde_json::Value>`, `apply(&mut TextLayer, &Value)`). Hook it with one line in `psd_export.rs` near `layer_xmp_block` and one in `psd_import.rs` where `shmd` XMP is taken (line 492). It uses craft-libs' XMP helpers (`craft_psd::metadata::put_layer_xmp`). Merge into an existing packet; never replace it.

## 2. The rows

Each row gives:
- **PS**: what Photoshop does.
- **JS**: what the JavaScript app did.
- **PC**: what PhotoCraft has now (checked in code).
- **Build**: what to build.
- **PSD**: where Photoshop stores it.
- **Tests**: the tests that prove it.
- **Size**.

### Type: Character panel (package B1 model, B2 UI)

#### 1. Subscript
- **PS**: Character panel button T₁ (8th row of toggles), panel menu and Type menu; ⌥⇧⌘= .
- **JS**: `lib/type/char-format.js` TOGGLES (`'subscript','position','sub'`); drawn smaller and lowered from the font on the HarfBuzz engine.
- **PC**:
  - Model `FontBaseline::Subscript` (`crates/doc/src/text.rs`), `type.setStyle {"baseline":"subscript"}` (`type_cmds.rs:398`), PSD `FontBaseline` 2.
  - The panel has 6 toggles, no super/sub (`crates/ui-egui/src/tools/type_tool/panel.rs` ~l.370, `toggles: [..; 6]`), and `CharToggle` (`type_tool/editing.rs:232`) has no Superscript/Subscript.
- **Build**:
  - In `panel.rs` make the toggle array 8 in Photoshop's order: Faux Bold, Faux Italic, All Caps, Small Caps, **Superscript, Subscript**, Underline, Strikethrough.
  - The glyph is `T` with a small raised/lowered `1` drawn in `toggle_cell`.
  - Click → `apply(.., json!({"baseline": if on {"normal"} else {"subscript"}}))`.
  - Add `CharToggle::Superscript` and `CharToggle::Subscript` (also `SmallCaps`, which is missing too) in `editing.rs`. Bind ⇧⌘= and ⌥⇧⌘= in `type_tool/keys.rs` next to the existing toggles (`keys.rs:320`); also ⇧⌘H for small caps, as Photoshop.
  - The Character panel menu (B2) lists Superscript and Subscript with checkmarks.
  - i18n: `tl!("Superscript")`, `tl!("Subscript")`.
- **PSD**: done.
- **Tests**:
  - `type_tool/tests.rs`: clicking the 6th cell sets `baseline` on the selection and shows checked; ⌥⇧⌘= toggles it.
  - `panels_toggle_tests.rs` style: the panel has 8 toggles in order.
  - The PSD round trip already exists.
- **Size**: S (shared with row 2).

#### 2. Superscript
- **PS**: as row 1, ⇧⌘= .
- **JS**: TOGGLES `'superscript'`.
- **PC**: as row 1 (`FontBaseline::Superscript`).
- **Build**: row 1's cell 5, `{"baseline":"superscript"}`.
- **Tests**: as row 1.
- **Size**: S (with row 1).

#### 3. Fractional Widths
- **PS**: Character panel menu toggle, per type layer, on by default. Off, glyph advances are rounded to whole pixels: useful for small screen text.
- **JS**: `model.js` CHAR_DEFAULTS `fractionalWidths: true`; `char-format.js characterMenuItems` toggles it; `shaper.js:360` rounds `u.advance` when false. JS kept it per character run, unlike Photoshop.
- **PC**: none (map: no field). `build.rs:991` writes `UseFractionalGlyphWidths true` only when absent.
- **Build**:
  - Model `TextLayer.fractional_widths` (B1).
  - Engine command `type.fractionalWidths` `{"layer"|"layers","on":bool?}`; omitted `on` toggles from the representative layer. It goes in a new `crates/engine/src/cmd/type_layer_opts_cmds.rs`, registered by one line in `cmd.rs` beside `type_extra_cmds::specs()`; History label "Fractional Widths". It sets the field through `type.edit` internals and re-lays out.
  - Layout:
    - in `crates/text/src/layout/lines.rs` (`emit_run`), when the layer's flag is off, round each cluster's advance (px at document resolution, after horizontal scale) and accumulate the rounding into the following glyphs' x;
    - line breaking of box text uses the rounded widths: the composer items (B3) take rounded box widths; the fast parley path breaks with fractional widths, a known difference under 1 px per glyph.
  - The flag must reach the layout env: add `fractional_widths` and `system_layout` to the struct that `layout.rs` builds from `TextLayer` (where `antialias` is read today).
  - UI: Character panel menu item with checkmark (B2).
- **PSD**: `UseFractionalGlyphWidths` on read and write (B1).
- **Tests**:
  - `crates/text/src/tests.rs`: Inter at 9 pt, 72 dpi, "illicit": with the flag off every glyph x is an integer and the line is ≥ its fractional width minus 0.5 px per glyph.
  - PSD: write/read false; a Photoshop-written true survives.
  - Engine: `type.fractionalWidths` toggles, undo restores.
- **Size**: S.

#### 4. No Break
- **PS**: Character panel menu; the selected characters never break across lines (also no hyphenation inside).
- **JS**: `model.js` `noBreak`; `layout.js:151–152` filters break opportunities inside a run marked noBreak.
- **PC**: none.
- **Build**:
  - `CharStyle.no_break` and the engine key `"noBreak"` (B1).
  - Command `type.noBreak` `{"layer"?,"range"?,"on":bool?}` (toggle, label "No Break") in the new `type_layer_opts_cmds.rs` (a thin wrapper over `style_range`).
  - Layout:
    - fast path: in `crates/text/src/layout/style.rs` `style_props` push `StyleProperty::TextWrapMode(parley::TextWrapMode::NoWrap)` for runs with `no_break`. parley 0.11 honours it per cluster (`line_break.rs:570`);
    - composer path (B3): no penalties inside or at the edges of a no-break range, and no hyphenation points in it.
  - Overflow: a no-break run longer than the box runs out of the box, as Photoshop does. The emergency break (`OverflowWrap::BreakWord`, `shaping.rs:334`) must not apply inside it: push `OverflowWrap::Normal` on that range.
- **PSD**: `NoBreak` (B1).
- **Tests**:
  - Layout: "aaa bbb ccc" in a box fitting "aaa bbb" breaks after "bbb"; with "bbb ccc" no-break it breaks after "aaa".
  - A hyphenatable no-break word gets no hyphen.
  - PSD round trip.
- **Size**: S.

#### 5. Reset Character
- **PS**: Character panel menu; resets every character attribute of the selection (or the layer) to defaults, font and size included.
- **JS**: `char-format.js resetCharacter` with `char-values.js resetCharacterPatch` keeps font, size and colour (`RESET_KEEPS`). The JS parity table marks this "Partial" for that reason.
- **PC**: none.
- **Build**:
  - `type.resetCharacter` `{"layer"|"layers","range"?}` in a new `crates/engine/src/cmd/type_reset_cmds.rs` (registered in `cmd.rs`, one line).
  - It applies `CharStyle::default()` to the range through `style_range` and keeps only `style_sheet` (the applied character style; Photoshop keeps the style assignment and drops overrides), labelled "Reset Character".
  - Follow Photoshop, not JS: font, size and colour reset too.
  - Panel menu item (B2).
- **PSD**: n/a.
- **Tests**: engine: a run with bold, tracking 50, superscript and red, after reset, equals `CharStyle::default()`; undo restores; with a range only that range changes.
- **Size**: S.

#### 6. System Layout
- **PS**: Character panel menu, per layer: "view type using the operating system's default text handling" (for UI mock-ups). In practice, whole-pixel glyph positions with the platform's rasterisation.
- **JS**: `model.js` TYPE_OPTION_DEFAULTS `systemLayout`; `char-format.js toggleAttribute('systemLayout')` stores the flag in `typeOptions`. **No rendering effect in JS.**
- **PC**: none.
- **Build**:
  - `TextLayer.system_layout` (B1) and command `type.systemLayout` `{"layer"|"layers","on"?}` in `type_layer_opts_cmds.rs`.
  - Effect, to exceed JS: whole-pixel advances (as Fractional Widths off), the baseline snapped to a whole pixel, and the Sharp anti-alias curve while on, as `AntiAlias::Windows` does (`text.rs` notes `Windows` renders like Sharp). The stored `antialias` is not changed, so turning it off restores the look.
  - The Character panel menu shows Fractional Widths greyed while System Layout is on: Photoshop does this.
- **PSD**: see the table: verify `textGridding`, else XMP.
- **Tests**: the layout positions are integers; toggling off restores the identical layout; `type.systemLayout` undo.
- **Size**: S.

#### 7. Character language (hyphenation and spelling dictionaries)
- **PS**: Character panel language menu (bottom left); picks the hyphenation and spelling dictionary per character.
- **JS**: `char-format.js` language select (lines 357–371, 499–508), listing `api.hyphenationLanguages()` and the document's languages (`char-values.js documentLanguages/languageOptions`); `hyphenation.js patternLanguage()` maps regional tags to the eight pattern sets.
- **PC**:
  - `CharStyle.language: Option<String>`, used only as parley's `Locale` (`layout/style.rs:126`), and the engine key `"language"`.
  - No UI. PSD does **not** read or write `Language` (the map's "round-tripped" is only the native format).
  - Spelling is English SCOWL only (`crates/text/src/spell.rs`).
- **Build**:
  - **UI (B2)**: a language dropdown at the bottom of the Character section of `panel.rs`, beside anti-aliasing as in Photoshop, listing Photoshop's languages. Keep the table in a new `crates/ui-egui/src/tools/type_tool/languages.rs` (BCP-47 tag, English name, has hyphenation via `craft_text::hyphen::Lang::for_language(tag).is_some()`, has spelling via `craft_proof::has_dictionary(Some(tag))`). Languages without data show a faint "(no dictionary)" suffix. Default for new text: the UI language's tag, falling back to en-US. Write with `{"language": tag}`.
  - **Hyphenation (B3)**: each run's language picks the hyphenator.
  - **Spelling (B8)**: per-run language through craft-proof.
  - **PSD (B1)**: the `Language` table from samples.
- **Tests**:
  - The UI dropdown sets the run language.
  - Hyphenation differs by language ("Wasserstoff" in de vs en-US).
  - Spelling: "colour" is flagged in en-US and not in en-GB (via craft-proof).
  - PSD: once the table exists, write and read for each mapped language.
- **Size**: M (UI S, PSD table S plus sample work, spelling in B8).

### Type: fonts (package B7)

#### 8. Font menu WYSIWYG preview with selectable sample text
- **PS**: the font menu shows each family in its face ("Sample"). Photoshop has no sample choice; this is a JS extra in the spirit of Illustrator's.
- **JS 0.5**: `lib/type/font-picker.js`:
  - `SAMPLES` = Sample, Aa, Abc, "The quick brown fox", `$selection` (the selected text);
  - a footer `<select class="fp-sample-text">` beside the size select;
  - saved in `settings.typeFonts.sample` (`shared/defaults.js:95`).
- **PC**: WYSIWYG samples with a fixed `SAMPLE = "AaBbCc"`, plus an Arabic sample (`crates/ui-egui/src/text/font_preview.rs:12–16`); used by `type_tool/fonts.rs:593–710` and `text/font_filters.rs`.
- **Build**:
  - `TypePrefs.font_sample: FontSample` in `crates/engine/src/prefs.rs`. Make it a `choice!` enum like `FontPreview` (line 113): `Default = "default"` (today's AaBbCc), `Sample`, `Aa`, `Abc`, `QuickBrownFox`, `Selection`, plus `prefs/validate.rs` `"type.fontSample"`.
  - `font_preview.rs`: `sample_text(pref, selection: Option<&str>) -> Cow<str>`. Selection uses the first line of the selected text, capped at 24 chars, falling back to Sample when empty. The cache key includes the text (`CACHE_ID` cache).
  - Width: keep the slot width from `slot_width`; longer samples clip with a fade.
  - UI: a footer row in the font popup (`type_tool/fonts.rs`, where the list is drawn) with two dropdowns, "Sample text" and "Font preview size", writing `prefs.set` `type.fontSample` and `type.fontPreview`.
  - Strings: `tl!("Sample text")`, `tl!("Selected text")`, `tl!("The quick brown fox")`.
- **PSD**: n/a.
- **Tests**:
  - `font_picker_tests.rs`: choosing "Abc" re-renders the rows with "Abc" (inspect the cache keys or the painted galley text).
  - Selection mode with text selected uses it.
  - Prefs validate rejects an unknown value.
- **Size**: S.

#### 9. Font Preview Size wiring (None, Small … Huge)
- **PS**: Type › Font Preview Size: None, Small, Medium, Large, Extra Large, Huge. It is the same setting as Preferences › Type.
- **JS 0.5**:
  - menu radio items `type:font-preview-size` (`shared/menu-template.js:489`);
  - `font-picker.js PREVIEW_PX` (none 0 … huge 34);
  - Preferences section in `font-library.js` 782–805, sharing `settings.typeFonts.previewSize`.
- **PC**:
  - Preferences › Type works (`prefs.type_.font_preview`, read by `type_tool/fonts.rs:328`).
  - The Type-menu commands `type.fontPreviewSize.*` only set `o.font_preview_size` in `menus/view_cmds/dispatch.rs:394`, which nothing reads, and the checkmark reads that field (`dispatch.rs:146`).
  - There is no "None" item (`menu_catalog.rs:519–523`; `FONT_PREVIEW` in `view_cmds.rs:180` has 5 entries).
- **Build**:
  - In `dispatch.rs`, `type.fontPreviewSize.<k>` runs `app.run("prefs.set", json!({"path":"type.fontPreview","value": k}))`. Map `none` to `"off"` and `extraLarge` to `"extraLarge"`.
  - The checkmark reads `app.session.prefs().type_.font_preview`.
  - Delete `font_preview_size` from `view_cmds.rs:113/145`. Check `grep font_preview_size` for other readers: only dispatch.
  - Add `(&["Type", "Font Preview Size"], "None", None, "type.fontPreviewSize.none")` first in `menu_catalog.rs`, and `"none"` to `FONT_PREVIEW`.
- **Tests**:
  - Menu invoke `type.fontPreviewSize.large` → `prefs().type_.font_preview == Large` and the menu check follows.
  - The Preferences change is reflected in the menu check.
  - `none` hides samples (`font_preview::sample(Off)` is None).
- **Size**: S.

#### 10. Manage Missing Fonts / Replace All Missing Fonts / Resolve Missing Fonts
- **PS**:
  - Opening a file with missing fonts warns.
  - Type › Manage Missing Fonts… (Resolve Missing Fonts… in older releases) lists each missing font (PostScript name) with a replacement family and style; Replace All Missing Fonts substitutes the default.
- **JS 0.5** `lib/type/missing-fonts.js`:
  - `missingNotice`;
  - `defaultReplacement` (the default family's style nearest the missing face's weight and slant, from `parsePostScriptStyle`);
  - `replaceFonts` (one history entry "Resolve Missing Fonts", recorded for Actions);
  - `manageDialog`;
  - an open hook that is interactive only for user opens and writes a log line in Batch.
- **PC**:
  - `type.replaceAllMissingFonts` works; `type.resolveMissingFonts {"map":{"Family":"Family"}?}` lists missing families or replaces by family name only (`crates/engine/src/cmd/type_extra_cmds.rs:905–957`).
  - Opening warns (`crates/ui-egui/src/file_open.rs:165–180`).
  - There is no dialog: the menu item runs the command with no params, which only returns the list.
- **Build**:
  - **Engine**: extend `resolve_missing`/`replace_fonts`:
    - map keys may be a PostScript name or a family;
    - values may be a string (family) or `{"family":str,"style":str?,"postscriptName":str?}`;
    - the list form returns `[{"family","postscriptName","style","weight","italic","layers":[ids],"suggested":{"family","style"}}]`;
    - `suggested` is the default family's nearest style (port `defaultReplacement`: weight and italic from `photocraft_text::psd` `guess_from_postscript`, which already exists in import.rs).
    - Missing detection groups runs by PostScript name first, then family (`style_font_missing`, `type_extra_cmds.rs`).
    - Keep the History label "Resolve Missing Fonts"; Replace All stays "Replace Missing Fonts" (existing).
  - **UI**: a new `crates/ui-egui/src/dialogs/missing_fonts_ui.rs` "Manage Missing Fonts":
    - a table with Missing font (family and PostScript), Replace with (family picker, the shared `family_picker` from `type_panels_ui.rs:543`) and Style, plus "Resolve" and "Cancel";
    - it runs `type.resolveMissingFonts` with the map.
  - **Menu** (`menu_catalog.rs`):
    - add `(&["Type"], "Manage Missing Fonts…", None, "type.manageMissingFonts")`, a UI command that opens the dialog, routed in `menus/invoke.rs` like other dialog openers;
    - keep "Replace All Missing Fonts";
    - point "Resolve Missing Fonts…" at the same dialog.
  - **Open notice**: the warning from `file_open::with_missing_fonts_of` gets a "Manage…" action in the warning toast/status, which opens the dialog. Use the status bar's existing action-button mechanism if there is one (check `app/files.rs:125`); else a one-line button in the open-warnings dialog.
- **PSD**: n/a; the PostScript names are kept already.
- **Tests**:
  - Engine (`type_extra_cmds.rs` tests): a layer with runs "MissingSans-Bold" and "MissingSans-Regular" lists two entries with `suggested` weights 700 and 400; a map by PostScript name to `{"family":"Inter","style":"Bold"}` changes only that run; one undo step.
  - UI: the dialog opens from the menu, and Resolve issues the command with the map (inspect `app.session.journal`).
- **Size**: M.

### Type: editing (package B6)

#### 11. Cut, copy and paste with formatting kept between type layers
- **PS**: copy/paste inside and between type layers keeps character and paragraph formatting; Paste Without Formatting strips it.
- **JS** `lib/type/clipboard.js`:
  - `makeClip` (a formatted slice and plain text) and `setInAppClip`;
  - `choosePaste` uses the formatted in-app clip while the system clipboard still holds its text, else the system text with the caret style;
  - `applyPaste` inserts runs and paragraph styles.
- **PC**: `type_tool/editing.rs:108 copy_selection` writes plain chars with `ctx.copy_text`. Paste arrives as `Event::Paste(text)` and `insert()` → `insertion_style::replace` → `type.edit {"replace", "runs":[one style]}`.
- **Build**:
  - A new `crates/ui-egui/src/tools/type_tool/clipboard.rs`. It holds the in-app clip in `PhotocraftApp` state (one field, `type_clip: Option<TypeClip>`) and `TypeClip { text: String, runs: Vec<TextRun>, paragraphs: Vec<ParagraphRun> }`, sliced from the layer with byte↔char conversion (reuse `byte_at` from `type_spell_cmds.rs` or the editing helpers).
  - `copy_selection` (editing.rs) also stores the clip: two lines calling `clipboard::remember`.
  - On `Event::Paste(s)`: if `type_clip.text == normalise(s)` and the paste isn't plain, insert formatted. `type.edit` with `"replace"` and `"runs":[{start,end,…all char keys of each run}]` (the runs param exists; serialise each `CharStyle` to the char keys with a new `type_cmds::char_props_json(&CharStyle) -> Value`, the inverse of `apply_char_props`), and the **new** `type.edit` param `"paragraphs":[{start,end,…para keys}]`. That needs a `para_props_json` and `style_paragraphs` per range, in `type_cmds.rs` (same file as B1; B6 runs after B1).
  - A multi-paragraph paste brings its paragraph styles; a single-paragraph paste keeps the destination paragraph's style, as Photoshop.
  - Cross-application: other apps get plain text (unchanged).
  - Cut is copy plus delete (already).
- **Tests**:
  - Type tool harness: copy bold-red "ab" from layer 1, paste into layer 2 → the runs are bold red.
  - Change the system clipboard to other text → the paste is plain with the caret style.
  - Two paragraphs centred/right paste with their alignment.
  - Undo is one step ("Paste" label follows `type.edit` coalescing).
- **Size**: M.

#### 12. Paste Special › Paste Without Formatting (File/Edit row)
- **PS**: Edit › Paste Special › Paste Without Formatting: while editing type, pastes plain text with the formatting at the insertion point.
- **JS**:
  - `type/editor.js:934–940` registers `edit:paste-without-formatting` (enabled only while editing) and calls `activeEditor.paste({plain:true})`;
  - `main/clipboard.js` reads the system text;
  - menu `shared/menu-template.js:225`.
- **PC**: none (Paste Special has Paste in Place, Into and Outside: `menu_catalog.rs:88–90`; `edit_cmds.rs:1262`, `extra_cmds.rs:947`).
- **Build**:
  - Add `(&["Edit", "Paste Special"], "Paste Without Formatting", None, "edit.pasteSpecial.pasteWithoutFormatting")` first in Paste Special, as in Photoshop.
  - It is a UI command (the clipboard is the window's), enabled only while `app.ui.text_edit.is_some()`. Route it where `edit.paste` is intercepted during type edits (`app/commands.rs` routes type-edit Edit commands; check `copy_selection` callers).
  - Effect: set a one-shot `app.ui.paste_plain = true` and send `ViewportCommand::RequestPaste` (`editing.rs request_paste`). The `Event::Paste` handler sees the flag, inserts via the plain path (today's `insert`) and clears the flag.
  - Record into Actions as `type.insertText`? Photoshop doesn't record it; the plan doesn't either.
- **Tests**:
  - With a formatted clip in place, the menu command pastes with the caret's style (the runs equal the caret style).
  - Disabled when not editing (`checked`/`enabled` query).
- **Size**: S.

#### 13. Alt-click to enter paragraph box width and height numerically
- **PS**: with a Type tool, Alt/Option-click (or Alt-drag) on the canvas opens "Paragraph Text Size" (Width, Height, in the type or ruler units) and makes a paragraph box of that size at the click.
- **JS**:
  - `lib/tools/text.js:736–749` (Alt-click or Alt-drag → `boxSizeDialog(app, size)` from `type/editor.js`, prefilled from the drag or a default);
  - hint at `text.js:257`.
- **PC**: `type_tool/pointer.rs pointer_up` (l.323) makes point text on a click or a box on a drag. `pointer_up(app, start, end)` has no modifiers (`canvas/gesture.rs:123`); Alt only resizes from the centre while dragging a handle (`pointer.rs:205`).
- **Build**:
  - Pass `alt: bool` into `pointer_up` (gesture.rs:123 and pointer.rs; the `editing.rs:571` test caller too). If `alt` and the press didn't land in an edit session, don't create: open a new `crates/ui-egui/src/dialogs/paragraph_size_ui.rs` "Paragraph Text Size" with:
    - Width and Height fields in the type unit (`type_unit(app)` as `panel.rs` uses), prefilled with the drag size or, for a click, Photoshop's default box (the size it shows; JS used the last size);
    - OK / Cancel.
  - OK runs the same `type.create` params `pointer_up` builds, with `"box":[x,y,w,h]` (factor the param building out of `pointer_up` into `fn create_params(app, start, end) -> Value` so both paths share it).
  - Type Mask tools behave the same.
  - Strings: `tl!("Paragraph Text Size")`, `tl!("Width:")`, `tl!("Height:")`.
- **PSD**: n/a (BoxBounds as usual).
- **Tests**:
  - Pointer harness: an Alt click opens the dialog (state set) and no layer is created.
  - Confirm with 200×80 pt at 144 dpi → `TextShape::Box` width 400 px, height 160 px at the click.
  - Cancel creates nothing.
- **Size**: S.

### Type: paragraph and composition (packages B3, B4, B5)

#### 14. Bulleted and numbered lists
- **PS**: Paragraph panel list controls (recent releases): bullet or numbering, marker style, start number, levels; the marker sits in the left indent.
- **JS** `lib/type/paragraph.js`:
  - `LIST_MARKERS` (bullets • ◦ ▪ – ✓ ★; numbers decimal/lower-alpha/upper-alpha/lower-roman/upper-roman);
  - `listNumber(paras, i)` (counts same-level numbered paragraphs; a shallower one ends the count);
  - `listFormatter` (default bullets by level), `toRoman`, `toAlpha`;
  - `listPatch` (turning on gives a paragraph with no left indent 1.5 em per level);
  - Paragraph panel controls `panels/paragraph.js:262–274` (marker, start, level) and `toggleList`;
  - engines draw the marker in the indent (`type/layout.js` `listMarker` hook).
- **PC**: none (no field in `ParagraphStyle`).
- **Build**:
  - Model `ParagraphStyle.list` and keys (B1).
  - **Layout (B5)**: a new `crates/text/src/layout/lists.rs`:
    - `marker_text(paras: &[ParagraphStyle], i) -> Option<String>`, porting `listNumber`/`listFormatter`/`toRoman`/`toAlpha` verbatim;
    - `place_marker(...)`: shape the marker with the paragraph's first run style and place it on the first line's baseline, right-aligned at `start_indent − 0.5 em` (as JS, which places it inside the left indent; RTL mirrors it). Its glyphs append to `TextLayout.glyphs` with a cluster range of the paragraph start, so hit-testing never lands on it.
    - Hook: one call in `crates/text/src/layout.rs` after a paragraph's first line is placed.
  - **UI (B5)**: in the Paragraph section of `panel.rs`:
    - two toggle cells (bulleted list, numbered list), then marker dropdown, start number and level fields shown when a list is on;
    - turning on applies `listPatch`'s indent rule (`startIndent` 1.5 em × (level+1) if it was 0).
  - **Engine**: `type.list` `{"type":"bullet|number|none",…}` as a labelled wrapper ("Bullets", "Numbering") in `type_layer_opts_cmds.rs`.
- **PSD**: XMP `pigment:typeExtra.lists` per paragraph index; the export warning "layer X: Photoshop will not show its list markers". No EngineData invented.
- **Tests**:
  - `lists.rs` unit: numbering 1, 2, (level 1: a, b), 3; start 5; roman iv; the bullet by level.
  - Layout: the marker glyphs sit left of the first line, inside the indent, and don't change hit-testing.
  - PSD round trip via XMP; the warning is present.
- **Size**: M.

#### 15. Hyphenate, and the Hyphenation settings dialog
- **PS**:
  - Paragraph panel "Hyphenate" checkbox.
  - Panel menu "Hyphenation…": Words Longer Than _ letters, After First _, Before Last _, Hyphen Limit _ hyphens, Hyphenation Zone _, Hyphenate Capitalized Words, Hyphenate Last Word, Hyphenate Across Column.
  - The hyphenator uses the character's language.
- **JS**:
  - `type/hyphenation.js` (Liang over hyph-utf8, the 8 languages above, loaded on demand);
  - `panels/paragraph.js hyphenationDialog` (l.458–506);
  - limits applied in `paragraph.js` (After First/Before Last per word; Hyphen Limit and Zone in `knuthPlass`/`composeSingle`);
  - "Hyphenate Across Column has no effect (no columns)".
- **PC**:
  - `ParagraphStyle.hyphenate` flag; ⌥⇧⌘H (`editing.rs:329 toggle_hyphenate`); PSD `AutoHyphenate`.
  - Layout never hyphenates (`panel.rs:498` comment #6710; `type_panels_ui.rs:463` hides it from style options).
- **Build**:
  - **Engine and model**: B1.
  - **Layout (B3)**: the composer pipeline (decision 2). Hyphenation points come from `craft_text::hyphen::hyphen_points_in(word, &Limits{min_word: words_longer_than, after_first, before_last, capitalized}, lang)`, where:
    - `lang = Lang::for_language(run.language or the document default "en-US")`;
    - words are letter runs (`\p{L}\p{M}'’`, as JS `LETTER_RUN`) inside one run's language;
    - none inside No Break ranges;
    - `last_word=false` drops points in the paragraph's last word.
  - Penalties are `flagged: true, hyphenation: true` with width = the hyphen's advance in that run's font (shape "‐" once per style). `Params.hyphen_limit` = `hyphen_limit`; `Rag.hyphenation_zone` = `zone_pt × k` for ragged alignments.
  - On a hyphenated break, shape U+2010 at the line end (decision 2's forced-break pass). The hyphen belongs to no layer-text offset: map it to the break offset with zero length.
  - **UI (B5)**:
    - Paragraph section: "Hyphenate" checkbox (`tl!("Hyphenate")`) at the bottom of `panel.rs`'s Paragraph section; it replaces the #6710 comment.
    - New dialog in `crates/ui-egui/src/dialogs/type_paragraph_dialogs.rs`: `hyphenation_dialog`, with the fields above and a live Preview checkbox. OK runs `type.setStyle {"hyphenate":on,"hyphenation":{…}}` on the targets (the `formatting_params(app)` targets), label "Hyphenation".
    - Restore hyphenation in the Paragraph Style Options editor (`type_panels_ui.rs:457–463`, and test `hyphenate_is_not_shown_in_paragraph_style_options` reversed).
- **PSD**: B1 table.
- **Tests**:
  - Layout, en-US, Inter 12 pt, box 60 px: "internationalization" hyphenates at a craft-text point, the line ends with "‐", and the caret offsets still map to layer text.
  - Words Longer Than 25 → no hyphen. Hyphen Limit 1 → no two consecutive hyphenated lines.
  - German text with `language: "de"` hyphenates by German patterns.
  - PSD keys round trip.
  - The dialog OK issues one `type.setStyle`.
- **Size**: L (layout M–L in B3, UI S in B5).

#### 16. Reset Paragraph
- **PS**: Paragraph panel menu; paragraph attributes back to defaults.
- **JS**: `paragraph.js resetParagraphPatch` (every key undefined); `panels/paragraph.js resetParagraph` (label "Reset Paragraph").
- **PC**: none.
- **Build**: `type.resetParagraph` in `type_reset_cmds.rs` (B1): `ParagraphStyle::default()` (keeping `style_sheet`) on the targeted paragraphs, label "Reset Paragraph". Panel menu item (B5).
- **Tests**: engine: justified, indented, hyphenating, list paragraph → default; only targeted paragraphs; undo.
- **Size**: S.

#### 17. Roman Hanging Punctuation
- **PS**: Paragraph panel menu toggle. Punctuation at line starts and ends hangs outside the margins (`. , ' " - ‐ ‑` fully; `: ; – — …` half).
- **JS**:
  - `paragraph.js HANG_FULL`/`HANG_HALF`/`hangFraction` (full: `.,'"‘’“”‚„‹›«»-‐‑` and soft hyphen; half: `:;–—…*~`);
  - `setLine` returns `hang {start,end}`;
  - menu item `panels/paragraph.js:392`.
- **PC**: none.
- **Build**:
  - Model and key (B1).
  - **Layout (B4)**: in the composer items, a line-ending break after a hanging mark gets `Item.hang = fraction × mark advance` (craft-text gives the width back to the line). A box at a line start that is a hanging mark gets `hang` too.
  - In `lines.rs` `line_start`, shift the line start by `−hang_start` and allow the end to overrun by `hang_end` (applies to box/area text only; point text has no margins).
  - A drawn hyphen at a hyphenated break hangs fully.
  - Menu item (B5): `type.hangingPunctuation` `{"on"?}` toggle in `type_layer_opts_cmds.rs`, label "Roman Hanging Punctuation".
- **PSD**: `Hanging`.
- **Tests**:
  - A left-aligned box line starting with “ → the first glyph x is less than the box left by ≈ its advance.
  - A justified line ending with "." → the period extends past the right edge by its advance and the letters before it align flush.
  - Half for "—".
- **Size**: M (in B4).

#### 18. Justification settings (word, letter and glyph spacing min/desired/max, auto leading)
- **PS**: Paragraph panel menu "Justification…":
  - Word Spacing (min/desired/max, %, 0–1000);
  - Letter Spacing (−100–500 %);
  - Glyph Scaling (50–200 %);
  - Auto Leading %;
  - Single Word Justification.
- **JS**:
  - `paragraph.js spacing()` and `setLine()` stretch word spacing to max, then letter spacing, then glyph scaling, then beyond word max; shrink word to min, letter to min, then glyph min. With `SPACES_SHRINK` word spaces close up below natural.
  - `justificationDialog` `panels/paragraph.js:513–592`; defaults `model.js JUSTIFICATION_DEFAULTS`.
- **PC**:
  - Justified alignment via parley `Alignment::Justify` (`shaping.rs:466`); the last-line Justify All slack is spread over every cluster by `lines.rs justify_line` (l.223).
  - No settings. `auto_leading` exists, editable only through `type.setStyle` and Paragraph Style Options.
- **Build**:
  - Model and keys (B1).
  - **Layout (B4)**: composer items get tiers:
    - glue: natural width = space advance × desired word %, stretch to max, shrink to min;
    - boxes: letter-spacing stretch/shrink of (max − desired)/(desired − min) × space width per gap, and glyph-scaling tiers per box (`Item.stretch/shrink` tiers 1 and 2, `Params.tier_cost`).
  - `Line.ratio` and `Line.tiers` from `break_paragraph` feed a new `lines.rs` `apply_justification(out, c0, g0, &LineAdjust{word_px, letter_px, glyph_scale})`. It replaces parley's justify and `justify_line` for composer paragraphs; glyph scaling scales x advances and outlines horizontally, as horizontal scale does today (`scale_of`).
  - Single Word Justification: a justified line with no glue aligns per `single_word`.
  - Ragged (non-justified) paragraphs use the desired spacing only: Photoshop does.
  - Auto Leading in the dialog writes `autoLeading` (exists).
  - **UI (B5)**: `justification_dialog` in `type_paragraph_dialogs.rs` with 3×3 fields, Auto Leading and the Single Word dropdown; OK → `type.setStyle {"justification":{…},"autoLeading":%}`, label "Justification". Validation: min ≤ desired ≤ max per row, as Photoshop's alert.
- **PSD**: WordSpacing, LetterSpacing, GlyphSpacing, AutoLeading (B1); single-word in XMP.
- **Tests**:
  - Layout: a justified 3-line box with word 80/100/133 → interior spaces within [0.8, 1.33] × space width except when impossible.
  - Letter 0/0/0 → letter gaps unchanged.
  - Glyph 100/100/100 → no scaling.
  - Single-word "center" centres a lone word.
  - Dialog validation rejects min > desired.
- **Size**: M–L (in B4).

#### 19. Paragraph panel
- **PS**: Window › Paragraph:
  - alignment ×7, indents, space before/after, Hyphenate;
  - panel menu: Roman Hanging Punctuation, Justification…, Hyphenation…, Adobe Single-line Composer, Adobe Every-line Composer, Reset Paragraph (and the East Asian items, out of scope).
- **JS**: `panels/paragraph.js createParagraphControls` and `paragraphMenuItems` (l.388–404).
- **PC**: `type_tool/panel.rs:415–499`: alignment, direction, indents and spacing; no Hyphenate, no menu (`panel_docking.rs panel_menu` has no "character"/"paragraph" arms).
- **Build**: this row closes when rows 14–18 and 20 land. B2 creates `crates/ui-egui/src/tools/type_tool/panel_menu.rs` with `character_menu(app, ui)` and `paragraph_menu(app, ui)`, hooked by two arms in `panels/panel_docking.rs panel_menu` (check the panel ids in `PANELS`: the Character group's tabs are "Character"/"Paragraph", `dock.rs:111`). The Properties panel's type section gets the same menu items under its section header's "…" if Properties has one; else only the panels.
  - Character menu (B2): Faux Bold, Faux Italic, All Caps, Small Caps, Superscript, Subscript, Underline, Strikethrough (checkmarks); separator; Fractional Widths, System Layout, No Break; separator; Reset Character.
  - Paragraph menu (B5): Roman Hanging Punctuation; Justification…; Hyphenation…; Adobe Single-line Composer; Adobe Every-line Composer; separator; Reset Paragraph.
- **Tests**: `panel_menu.rs` tests open each menu (egui harness `query_all_by_label`), click "No Break" → the command is journaled; checkmarks follow the selection.
- **Size**: S (the menus themselves).

#### 20. Adobe Single-line Composer / Every-line Composer
- **PS**: Paragraph panel menu, per paragraph; Every-line is the default (total-fit line breaking), Single-line is greedy with Adobe's preferences.
- **JS**: `paragraph.js composeSingle` (greedy: compressed or expanded spacing preferred over hyphenation, a hyphen only past the zone in ragged text) and `composeEvery` → `knuthPlass` (TeX costs: line penalty 10, hyphen 50, double-hyphen 3000, final hyphen 5000, fitness 3000, tolerances 100/200, emergency 1000).
- **PC**: none; parley greedy only. The Language Options "composer" flag at `dispatch.rs:399` is unrelated, World-Ready.
- **Build (B3)**: a new `crates/text/src/layout/compose.rs`:

  ```rust
  pub(super) struct ComposeInput<'a> {
      layout: &'a Layout<RunBrush>,
      ps: &'a ParagraphStyle,
      styles: &'a [CharStyle],
      ...
  }
  pub(super) fn compose(
      input: &ComposeInput,
      width: &dyn Fn(usize) -> f32,
  ) -> Composed { breaks: Vec<Break { at: usize, hyphen: bool, adjust: LineAdjust, hang: (f32, f32) }> }
  ```

  - Items as decision 2. EveryLine → `craft_text::linebreak::break_paragraph(items, width, &params, &[pretolerance, tolerance])` with Params set from the JS constants above. SingleLine → `craft_text::linebreak::greedy` with `stretch_weight`/`shrink_weight` set so shrinking within min is preferred over hyphenation, as JS composeSingle's preferences.
  - `width(n)` = box width − indents (first-line indent on n=0). Area type (`layout/area.rs break_area`) keeps the slot-driven greedy: pass the slot widths as `width(n)` only to `greedy`; Every-line on area type falls back to greedy, documented.
  - `Para::break_lines` (`shaping.rs:390`) decides the fast path versus compose (decision 2) with a 3-line change; the forced-break reshape lives in `compose.rs`.
  - Menu items in B5: `type.composer.singleLine` and `type.composer.everyLine` (radio commands in `type_layer_opts_cmds.rs`, label "Composer").
- **PSD**: `EveryLineComposer`.
- **Tests**:
  - Port the cases of JS `tests/unit/type-paragraph-panel.test.mjs` (composers, hyphenation limits, justification, hanging, lists) as layout tests: the classic Knuth–Plass example paragraph breaks into fewer badly-spaced lines with Every-line than greedy, and Single-line equals greedy on ragged text.
  - Fast-path golden: an existing layout test file run unchanged.
  - Performance: a 2,000-word box lays out under 50 ms in release (an `#[ignore]` bench).
- **Size**: L (B3).

#### 21. Alt-click numeric paragraph box
Covered by row 13 (one Pigment-ahead row; the number is kept so packages can cite it).

### Select, Filter and View

#### 22. Show › Smart Guides: equal spacing (package B9)
- **PS**: while moving a layer, when its gap to a neighbour equals another gap between layers on the same axis, pink equal-spacing markers show and the move snaps to it.
- **JS**: `lib/smart-guides.js spacingTargets(rect, boxes, axis)` (candidate positions that equalise gaps), `spacingMarks(rect, target, axis)` and `drawSmartOverlay`.
- **PC**: alignment lines only (`crates/engine/src/snap.rs` `SnapTargets`, `snap_rect`, `SnapLine`, `SnapKind`); Cmd-hover distances in `crates/ui-egui/src/tools/move_distance.rs`. No spacing.
- **Build**:
  - In `snap.rs` add `pub struct SpacingMark { vertical: bool, gaps: Vec<(f64, f64)>, at: f64 }` and a `boxes: Vec<[f64;4]>` list in `SnapTargets` (filled in `from_document` with layer rects, as `layer_rect` gives).
  - `pub fn spacing(&self, r: [f64;4], tol: f64) -> (Option<f64>, Option<f64>, Vec<SpacingMark>)` ports `spacingTargets`: for neighbours overlapping on the other axis, the offsets that make the left gap equal the right gap, or equal an existing gap between two other boxes.
  - `snap_rect` folds the spacing offset in when it beats the alignment snap.
  - Draw in `crates/ui-egui/src/canvas/snap_ui.rs draw()`: magenta gap bars with end ticks in `smart_color(app)`, plus a distance label (row 31's painter).
- **Tests**:
  - `snap.rs` unit: three boxes at x 0–10, 30–40 and a moving box near 55 snaps to 60–70, with 2 gap marks.
  - No spacing snap when the boxes don't overlap on y.
  - The UI draw test style of `guide_ants_tests.rs`.
- **Size**: M.

#### 23. Blur Gallery: Effects (Bokeh), Motion Effects and Noise (package B10)
- **PS**:
  - Blur Gallery side panel tabs:
    - Effects (Field/Iris/Tilt-Shift): Light Bokeh, Bokeh Color, Light Range;
    - Motion Effects (Path/Spin): Strobe Strength, Strobe Flashes, Strobe Flash Duration;
    - Noise: Uniform, Gaussian or Grain; Amount, Size, Roughness, Color, Highlights.
- **JS**:
  - `shared/pixels/blur-gallery.js`: `bokehLuts` (a per-luminance gain/saturation boost in light range before blurring), `addGrain` (value-noise grain: amount, size, roughness, colour, highlights, uniform/gaussian, seeded), spin strobe (`spinBlur` l.892–978: `flashes` sharp copies along the arc);
  - UI `lib/blur-gallery-ui.js` (`BOKEH_FIELDS`, `STROBE_FIELDS`, `NOISE_FIELDS`, tabs).
  - JS had no Strobe Flash Duration and no Grain type.
- **PC**: `FilterParams::TiltShift/IrisBlur/FieldBlur/SpinBlur/PathBlur` (`crates/algo/src/lib.rs:524–545`) and `crates/algo/src/gallery.rs` have no effects; specs at `crates/engine/src/filters_ext.rs:829–858`; workspace UI `crates/ui-egui/src/dialogs/blur_pins.rs`.
- **Build**:
  - **Algo**: a new `crates/algo/src/gallery/effects.rs`:
    - `pub struct GalleryEffects { bokeh: Bokeh{light, color, range:[u8;2]}, strobe: Strobe{strength, flashes, duration_deg}, noise: GalleryNoise{kind: Uniform|Gaussian|Grain, amount, size, roughness, color, highlights, mono, seed} }` (serde default all off);
    - `fn bokeh_boost(src) -> Image` (port `bokehLuts`, applied to the source before `variable_blur`);
    - `fn add_noise(out, blur_amount_map)` (port `addGrain`; noise scaled by the local blur amount, as Photoshop restores grain only where blurred);
    - strobe for spin and path: blend `flashes` sharp offsets over a duration arc.
  - Add `effects: GalleryEffects` (`#[serde(default)]`) to the five variants in `lib.rs` and update their match arms (`lib.rs:785, 839, 1046`).
  - **Engine**: params in `filters_ext.rs` blur gallery specs: `"bokeh":{"light":0..100,"color":0..100,"range":[0..255,0..255]}`, `"strobe":{"strength":0..100,"flashes":1..100,"duration":1..360}` (spin/path), `"noise":{"type":"uniform|gaussian|grain","amount":0..100,"size":0..100,"roughness":0..100,"color":0..100,"highlights":0..100,"monochromatic":bool,"seed":u32}`. Parse in `tilt_shift`/`iris_blur`/… (`filters_ext.rs:214–220`).
  - **UI**: three collapsible sections under the blur sliders in `blur_pins.rs`'s panel (Effects, Motion Effects, Noise), shown per blur kind as Photoshop does; they are dialog fields, so `ui.dialog.set` automation works.
  - Smart filter: the params serialise with the filter, nothing extra.
- **PSD**: smart filter descriptors for Blur Gallery keep their raw descriptor (check `crates/io` smart filter mapping for `blurbTransform`); new params are Pigment-native only, noted in FORK.md.
- **Tests**:
  - Algo: bokeh light 100 on a dark image with one bright dot makes the blurred dot's peak brighter than without; noise amount 0 is identical to the old output; a fixed seed is deterministic; the strobe with 3 flashes shows 3 peaks along the arc on a point source.
  - Engine: the params round trip through the journal.
- **Size**: M–L.

#### 24. Blur Gallery: Path Blur depth (package B11)
- **PS**: Path Blur:
  - on-canvas paths with curve handles;
  - Basic Blur / Rear Sync Flash;
  - Speed, Taper, Centered Blur;
  - End Point Speed per path end (arrows);
  - Edit Blur Shapes (per-end blur direction arrows);
  - multiple paths.
- **JS**: `blur-gallery.js pathPolyline/pathSegments` (polyline paths; `endSpeeds` per end; `centeredBlur`); `blur-gallery-ui.js` path editing (`endSpeeds` arrow drag l.471–738, `centeredBlur` checkbox l.118). JS has no curve handles, no Edit Blur Shapes and no Rear Sync preset.
- **PC**: `BlurPath { points, speed, taper }` (`crates/algo/src/params_ext.rs:277`); `pathBlur {"speed","taper","startX","startY","endX","endY","paths":json}`; parameter dialog only (gaps.md G7).
- **Build**:
  - **Algo** (`gallery.rs path`):
    - `BlurPath` gains `knots: Vec<{anchor, in, out}>` (curves; `points` stays for compatibility as a polyline when `knots` is empty), `end_speeds: [f32;2]`, `end_shapes: [[f32;2];2]` (per-end direction vectors; Edit Blur Shapes);
    - top-level `centered: bool` and `mode: Basic|RearSyncFlash`. Rear Sync Flash weights the sample at the path end with a flash weight, as Photoshop's strobe at the end.
    - The motion direction per pixel comes from the nearest path tangent, blended toward the end shapes near the ends; centred samples ± half the length.
  - **UI**: path editing in `blur_pins.rs`:
    - click to add anchors, drag to make handles, double-click to end the path, Alt-click a point to toggle a corner;
    - end arrows dragged for end speed;
    - with Edit Blur Shapes checked, red shape arrows dragged.
    - All are dialog fields `paths`, as pins are today.
- **Tests**:
  - Algo: a straight path equals the old output when knots are empty (back-compat); centred vs not, the shift of the centroid; end speed 0 at one end tapers the blur to zero there.
  - UI harness: a click-click-double-click makes a 2-knot path in fields.
- **Size**: L.

#### 25. Lens Correction: tools (package B12)
- **PS**: Lens Correction workspace tools: Remove Distortion (drag in or out), Straighten (draw a line), Move Grid, Hand, Zoom.
- **JS**: `lib/lens-correction.js`: a workspace with a preview (zoom levels `ZOOMS`, pan), `TOOLS` Hand / Straighten / Remove Distortion, the grid, two tabs; `shared/pixels/lens.js straightenAngle`, `detectHorizon`, `gridLines`.
- **PC**: `filter.lensCorrection` (`crates/engine/src/cmd/lens_cmds.rs`, `LENS_DOC` l.451, with `straighten: [[x,y],[x,y]]`) opens the generic parameter dialog (`dialogs/edit_history.rs:201 open_command_dialog`). No workspace.
- **Build**: a new `crates/ui-egui/src/dialogs/lens_correction_ui.rs`, a modal workspace like `liquify_ui.rs` and `camera_raw_ui.rs`:
  - left: a preview canvas with a tool strip (Remove Distortion, Straighten, Move Grid, Hand, Zoom), using the existing filter preview worker (`dialogs/filter_preview_worker.rs`);
  - right: Auto Correction / Custom tabs with the `LENS_DOC` fields;
  - bottom: Preview, Show Grid, Size, Color.
  - Tools:
    - Remove Distortion: a drag toward or away from centre changes `distortion` (±100 over half the preview);
    - Straighten: the drawn line sets `angle` via `photocraft_algo::lens::straighten_angle` (`lens.rs:259`);
    - Move Grid: offsets the grid;
    - Hand and Zoom: view only (Space and Alt as usual).
  - Route `filter.lensCorrection` to this dialog in the place generic filter dialogs are chosen (one match arm).
  - OK runs `filter.lensCorrection` with the fields.
- **Tests**:
  - UI harness: a straighten drag at 10° sets `angle ≈ -10`; a distortion drag sets the sign by direction.
  - OK journals `filter.lensCorrection` with the values.
- **Size**: L (shared with rows 26–27, B12 2 days).

#### 26. Lens Correction: Custom tab (Fix Green/Magenta Fringe)
- **PS**: Custom tab: Geometric Distortion; Chromatic Aberration Fix Red/Cyan, Green/Magenta, Blue/Yellow Fringe; Vignette Amount and Midpoint; Transform: Vertical, Horizontal, Angle, Scale.
- **JS**: `shared/pixels/lens.js` `chromaRC`, `chromaBY`, `chromaGM` (each channel at its own magnification `1 + 0.01 × amount/100`, l.231); field `S('chromaRC', …)` l.598.
- **PC**: `red_cyan` and `blue_yellow` only (`crates/algo/src/lens.rs:99–101, 187–188`).
- **Build**:
  - `LensCorrection.green_magenta: f64` in `algo/src/lens.rs`. Green is the reference channel there, so G/M scales red and blue together opposite to green: `ca_r -= gm × 4e-5; ca_b -= gm × 4e-5`, equivalent to moving green against both.
  - Param `"greenMagenta":-100..100=0` in `LENS_DOC` and its parser in `lens_cmds.rs`.
  - Field in the Custom tab (row 25 UI).
- **PSD**: the smart filter descriptor; if a Photoshop sample carries a G/M key (`LnCr` descriptor), map it in the lens smart-filter mapping, else Pigment-only.
- **Tests**: algo: G/M +50 shifts red and blue edges outward relative to green by the same amount as R/C+B/Y −50 together; 0 is identity.
- **Size**: S.

#### 27. Lens Correction: Preview, Show Grid, grid Size and Color
- **PS**: bottom bar: Preview, Show Grid, Size, Color.
- **JS**: `lens-correction.js` `prefs { grid, gridSize 64, gridColor '#808080' }` saved in `settings.lensCorrection`, and the grid size input l.176–184.
- **PC**: preview yes (generic dialog); no grid.
- **Build**: in `lens_correction_ui.rs`:
  - Show Grid, Size (8–512 px), and a Color swatch (colour picker);
  - draws a grid over the preview offset by Move Grid;
  - remembered in UI prefs: add `LensCorrectionUi { grid, size, color }` to `crates/engine/src/prefs.rs` UI state, or the dialog-memory mechanism other dialogs use (check `dialogs/*` "remember"); not in the document.
- **Tests**: the grid toggles on, the size persists across opens.
- **Size**: S.

#### 28. Sharpen: Shake Reduction (package B13)
- **PS**: Filter › Sharpen › Shake Reduction:
  - estimates camera-shake blur traces in regions and deconvolves;
  - Blur Trace Bounds, Source Noise (Auto/Low/Medium/High), Smoothing, Artifact Suppression;
  - Advanced: multiple trace regions, a Detail loupe.
  - Adobe has dropped this filter from current releases, but it is in the 1,432-row list and Pigment users had it.
- **JS**: `shared/pixels/filters-more-a.js`:
  - `estimateShakeKernel` (the cepstrum of the sharpest tile ≤512 px finds one straight motion line: length and angle; `lineKernel`);
  - `noiseConstant`, `wienerDeconvolve` (radix-2 FFT);
  - smoothing (a bilateral pass), artifact suppression (fade the result where the local luma deviation is low);
  - registry `'shake-reduction'` defaults `{traceBounds 41, sourceNoise 'auto', smoothing 30, artifactSuppression 30}` l.1326.
- **PC**: none (no `shake` in the tree; `menu_catalog.rs:627–631` has no entry). `rustfft` is in Cargo.lock and used by `crates/algo/src/blur/motion_fft.rs`.
- **Build**:
  - **Algo**: a new `crates/algo/src/sharpen/shake.rs`: `estimate_kernel(img, rect, trace_bounds) -> Option<Kernel>` (port the cepstrum estimate on rustfft), `wiener(img, rect, &kernel, k)`, `smooth`, `suppress_artifacts`.
  - `FilterParams::ShakeReduction { trace_bounds, source_noise: Auto|Low|Medium|High, smoothing, artifact_suppression, regions: Vec<ShakeRegion{rect, bounds}> }`. Regions: each gets its own kernel and the result blends by inverse distance to region centres. That goes beyond JS's single trace: Photoshop's Advanced mode.
  - **Engine**: `filter.sharpen.shakeReduction` `{"traceBounds":10..199=41,"sourceNoise":"auto|low|medium|high"="auto","smoothing":0..100=30,"artifactSuppression":0..100=30,"regions":[{"rect":[x,y,w,h],"bounds":px}]?}` in `crates/engine/src/filters.rs` (`filter_cmd!` like the sharpen ones at l.480) and its parse at l.106. Menu row `(&["Filter","Sharpen"], "Shake Reduction…", None, "filter.sharpen.shakeReduction")` (sorted as Photoshop: after Sharpen More).
  - **UI**: the generic filter dialog first; a region rectangle overlay as `blur_pins.rs` pins do (click-drag adds a region) is a follow-up inside the package if time allows. The kernel trace preview (a small image of the estimated kernel) appears in the dialog.
- **Tests**:
  - Algo: blur a synthetic edge image with a 15 px horizontal line kernel → the estimate finds length 15 ± 2 and angle 0 ± 5°; the deconvolved MSE against the original is lower than the blurred MSE; a sharp image is returned unchanged (`detected=false`).
  - Determinism.
- **Size**: L.

#### 29. Focus Area: View modes (package B14)
- **PS**: Select › Focus Area dialog View menu: Marching Ants, Overlay, On Black, On White, Black & White, On Layers, Reveal Layer.
- **JS**: `lib/select-mask.js FOCUS_VIEWS`: Overlay, On Black, On White, Black & White, Onion Skin, None. No Marching Ants, On Layers or Reveal Layer.
- **PC**: `select.focusArea` (`crates/engine/src/cmd/smartselect_cmds.rs:604`, `{range, noise, sampleAllLayers, mode}`) in the generic dialog; no views.
- **Build**:
  - A new `crates/ui-egui/src/dialogs/focus_area_ui.rs`: a non-modal dialog with a live preview of the focus mask on the canvas through `crate::canvas::select_mask_view` (its `Mode` enum `select_mask_view.rs:30` already has OnionSkin, MarchingAnts, Overlay, OnBlack, OnWhite, BlackWhite, OnLayers). Add `RevealLayer` (show the layer unmasked; a two-line enum addition).
  - Focus Area uses Photoshop's list (no Onion Skin). The preview runs the engine algorithm (`crates/algo/src/segment/focus.rs focus_area`) through the existing preview worker pattern.
  - Route `select.focusArea` to the dialog (one arm).
- **Tests**: the dialog's view dropdown switches the preview mode; OK journals `select.focusArea` with the values.
- **Size**: M (with row 30).

#### 30. Focus Area: parameters and output
- **PS**: In-Focus Range (with Auto), Advanced: Image Noise Level (Auto); Output: Soften Edge, Output To (Selection, Layer Mask, New Layer, New Layer with Layer Mask, New Document, New Document with Layer Mask); a Select and Mask… button.
- **JS**: `select-mask.js focusArea()` (l.92–160) with Auto range, noise, hardEdge, output, and Select and Mask hand-off; `select-mask/ops.js` → `segment.js focusArea/focusMeasure` (Laplacian energy and graph cut).
- **PC**: range, noise, sampleAllLayers and mode only.
- **Build**:
  - Engine `select.focusArea` params:
    - `"autoRange":bool` (pick the range from the sharpness histogram: Otsu threshold on `focus.rs sharpness`);
    - `"autoNoise":bool`;
    - `"softenEdge":bool` (feather ≈ 1 px plus anti-aliasing of the region; Photoshop's "Soften Edge");
    - `"output":"selection|layerMask|newLayer|newLayerWithMask|newDocument|newDocumentWithMask"`, reusing the output routine of `select.refineEdge` (same names in `smartselect_cmds.rs` l.598: factor out its output helper).
  - UI: Auto checkboxes, Soften Edge, Output To; the "Select and Mask…" button commits the focus selection then opens the Select and Mask workspace (`select_mask_ui.rs` open function).
  - The Focus Area add/subtract brushes are a separate Missing row, out of this scope.
- **Tests**: engine: `autoRange` on a half-sharp/half-blurred image selects the sharp half (IoU > 0.8); `output:"newLayerWithMask"` makes a layer with a mask; `softenEdge` gives intermediate alpha on the edge.
- **Size**: M.

#### 31. Select and Mask: Refine Mode (Color Aware / Object Aware)
- **PS**: Properties: Refine Mode, Color Aware (simple, high-contrast backgrounds) or Object Aware (hair on complex backgrounds; a learned model).
- **JS**: `shared/pixels/matte.js detectEdge`: in the band, alpha is a blend of a guided filter fitted on trusted pixels outside the band and a local foreground/background colour projection (`colorAlpha`); `MODE_COLOR_WEIGHT { color: 0.75, object: 0.25 }`. Approximate, documented as such.
- **PC**: Color Aware only (`dialogs/select_mask_ui.rs:23` greys Object Aware pending a learned model, #2788). `crates/algo/src/matting.rs` does the guided filter refinement.
- **Build**:
  - `select.refineEdge` gets `"refineMode":"color|object"="color"`.
  - In `matting.rs` add the trusted-pixel weighted guided filter (trust 1 outside the band, 0.02 inside; JS `detectEdge`) and the colour projection estimate, blended by mode weight: object leans on the weighted guided filter (0.75), colour on the projection (0.75). Color Aware stays today's algorithm when `refineMode` is absent, for back-compat.
  - Un-grey the radio in `select_mask_ui.rs`, with a tooltip saying it is a classical approximation (no learned model).
  - When the AI team or a later package adds a local segmentation model, `refineMode:"object"` switches to it without an API change.
- **Tests**: algo: on a synthetic soft-edged disc against a textured background, object mode's alpha error ≤ colour mode's (and both differ); color mode is unchanged from today (golden).
- **Size**: S–M.

### Tools

#### 32. Shape fill: none, solid, gradient, pattern (package B15)
- **PS**: shape options bar Fill (and Stroke) popover: No Color, Solid, Gradient, **Pattern** tabs; also in Properties.
- **JS**: `lib/shape-paint-ui.js` with a pattern tab (`pattern-picker.js`); `properties/shape.js`.
- **PC**: the engine supports `Fill::Pattern` for shapes (`crates/doc/src/lib.rs:331`; `shape.create/edit {"pattern":name,"scale"}` at `vector_cmds/params.rs:150, 216`; PSD vscg `patternLayer` at `crates/io/src/vector_map.rs:314`). The swatch never offers it (`crates/ui-egui/src/tools/shape_paint_ui.rs:22–25`, `PaintChange` has no pattern).
- **Build**:
  - `PaintChange::Pattern(Fill)`; a Pattern tab in the popover reusing the pattern library grid (`tools/paint_picker.rs library()` / `dialogs/pattern_fill_ui.rs` picker), with Scale, Angle and Link with Layer.
  - `paint_param` emits `{"pattern":{"id","name","scale","angle","link","phase"}}`. Extend `params.rs:216` to accept that object as well as the string form.
  - Same for stroke if `ShapeStroke` paint allows patterns (check `ShapeStroke`; Photoshop allows a pattern stroke).
- **Tests**:
  - UI: choosing a pattern sets `Fill::Pattern` on the selected shape.
  - Engine: the object form parses; PSD export writes a vscg `patternLayer` (exists; add a round-trip assertion with angle/scale).
- **Size**: S–M.

#### 33. Polygon tool: Smooth Corners and Smooth Star Indents (package B15)
- **PS**: Polygon tool gear: Star Ratio, Smooth Star Indents; Smooth Corners (older option sets; today the corner radius field).
- **JS**: `lib/shape-geometry.js:408`, vertex radius = `outer ? (smoothCorners ? Infinity : cr) : (smoothIndents ? Infinity : cr)` through `roundedPolygon` (infinite radius clamps to half the shorter side); options `tools/vector.js:1015, 1207`.
- **PC**: `LiveShape::Polygon { sides, star_ratio, corner_radius }` (`crates/doc/src/vector.rs:308`). `vector/src/shapes.rs polygon_rounds_vertex` (l.131) rounds only a star's outer points; inner points always stay sharp. No smooth flags.
- **Build**:
  - `LiveShape::Polygon` gains `#[serde(default)] smooth_corners: bool, smooth_indents: bool`.
  - In `shapes.rs`, vertex radius = outer: `if smooth_corners { f64::INFINITY } else { corner_radius }`; inner: `if smooth_indents { INFINITY } else { 0.0 }`. `fillet` already caps at half of each edge.
  - Params `"smoothCorners":bool, "smoothIndents":bool` in `vector_cmds/params.rs` (beside `starRatio` at l.358).
  - UI: checkboxes in the polygon gear popover (`tools/vector_ui/options.rs`), plus the Create Polygon dialog (`dialogs/shape_dialog.rs` KEYS).
- **PSD**: polygons export as paths today (no polygon live-shape mapping in `vector_map.rs:398–435`). Unchanged; noted.
- **Tests**:
  - `shapes.rs` unit: a 5-point star with smooth indents has curve knots (non-equal handles) at inner vertices and sharp outer ones.
  - Serde back-compat (old JSON without the fields).
- **Size**: S.

#### 34. Object Selection tool: Rectangle / Lasso mode, Object Subtract, Hard Edge (package B16)
- **PS**: options bar: Mode (Rectangle/Lasso), Sample All Layers, Hard Edge, Object Subtract, plus Object Finder.
- **JS**: `lib/tools/object-select.js`: options `mode rect|lasso`, `objectSubtract` (default true), `hardEdge`; Alt with Object Subtract off subtracts the drawn region as is (`plain()`); `segment.js objectSelect(img, region, {hardEdge})`.
- **PC**:
  - `select.object {"rect"|"point","mode","sampleAllLayers"}` (`smartselect_cmds.rs:580`); `algo/src/segment/grabcut.rs object_select(sampler, canvas, rect, work_px)`.
  - The tool is in `tools/retouch_ui.rs:644–656` and `state/tool_options.rs`; Object Finder in `tools/object_finder.rs`.
  - No lasso, no Hard Edge, no Object Subtract.
- **Build**:
  - Engine `select.object`: add `"lasso":[[x,y],…≥3]` (the region is the polygon: the trimap's probable foreground inside, background outside a dilated band), `"objectSubtract":bool=true` (with mode subtract and false, subtract the plain region), `"hardEdge":bool=false` (threshold the GrabCut alpha at 0.5, no anti-aliasing).
  - `object_select` takes a `Region` mask instead of a rect (keep the rect wrapper).
  - UI: the options-bar Mode dropdown, Hard Edge and Object Subtract checkboxes (`tool_options.rs` fields `object_mode`, `object_hard_edge`, `object_subtract`); a lasso drag in `retouch_ui.rs` collects points like the Lasso tool.
- **Tests**:
  - Engine: lasso around a synthetic disc selects the disc (IoU > 0.9); hardEdge gives only 0/255 alpha; subtract with objectSubtract false removes the exact polygon.
  - Tool harness: lasso mode drag journals `lasso`.
- **Size**: M.

#### 35. Smart guides and measurement labels (package B9)
- **PS**: with Smart Guides, moving or duplicating shows pink distance labels (px or ruler unit) to neighbours and the canvas; the equal-spacing marks carry their gap value; drawing a shape shows its W/H.
- **JS**: `smart-guides.js distances(a, b)` and `drawSmartOverlay(…, {format})` labels on gaps and equal spacing; Ctrl-hover distances.
- **PC**: Cmd-hover distances with labels (`tools/move_distance.rs`, labels in the ruler unit); alignment lines without labels during a drag (`canvas/snap_ui.rs draw`); no spacing labels (map: `ui-parity.md`).
- **Build**:
  - Factor `move_distance.rs`'s label painter into a `pub(crate) fn distance_label(painter, xf, pos, value_px, unit)`.
  - During a Move drag with smart guides on, draw distance labels from the moving bounds to the nearest neighbour on each axis (`move_distance::Overlay` computed against the nearest box instead of a hovered one), and on each `SpacingMark` gap (row 22).
  - While drawing a marquee or shape, the W/H tooltip is "Show Transformation Values" (Preferences › Interface). Check it exists before adding; if missing, add it here.
- **Tests**:
  - UI: moving a layer 12 px right of another shows a label "12 px".
  - The equal spacing labels equal gaps.
  - No labels with Smart Guides off.
- **Size**: S–M (in B9).

#### 36. Adjustment Brush tool (package B17)
- **PS** (Photoshop 2025 and later):
  - the Adjustment Brush paints an adjustment non-destructively;
  - the first stroke makes an adjustment layer of the chosen kind with a black (hide-all) mask and paints it white; later strokes paint that mask; Subtract (or Alt) paints black;
  - settings are in Properties.
  - Toolbar group: verify; this plan puts it in the Brush group (B), as in the JS app's hint text and Photoshop's placement as far as known.
- **JS**: `lib/tools/adjustment-brush.js`:
  - `AdjustmentBrushTool extends StrokeTool`; options kind (every `LAYER_KINDS` adjustment), add/subtract mode, brush options;
  - `targetLayer()` (the active adjustment layer of that kind with a mask);
  - the first stroke creates the layer and joins both history entries into one;
  - Properties opens after the first stroke; Alt subtracts (`tool-traits.js:27`).
- **PC**: none (`Tool` enum, `crates/ui-egui/src/state/tool.rs`).
- **Build**:
  - `Tool::AdjustmentBrush` in `state/tool.rs`: name "Adjustment Brush Tool", key B, in the Brush slot list (l.104), paints with brush settings. A new `crates/ui-egui/src/tools/adjustment_brush.rs`:
    - options `adjustment_brush_kind` (default "brightnessContrast") and `adjustment_brush_mode` (add|subtract) in `tool_options.rs`;
    - on stroke start, if the active layer isn't an adjustment of that kind with a mask: run `layer.newAdjustmentLayer.<kind>` then `layer.layerMask.hideAll` (`menu_catalog.rs:323`), all with the stroke's `"coalesce"` key, so the creation and the first stroke are one History step;
    - paint with the existing brush stroke command with `"target":"mask"` (`canvas/strokes.rs:810`; stroke params allow it), foreground forced white (add) or black (subtract), without changing the user's swatches;
    - after the first stroke, open Properties on the adjustment (`window.panel.properties`).
    - Alt temporarily subtracts.
  - Toolbar icon (`icons`); `tl!("Adjustment Brush Tool")`, `tl!("Adjustment")`.
- **Tests**:
  - Canvas harness: the first stroke creates one adjustment layer with a mask that is white along the stroke and black elsewhere; the History has one new state; a second stroke paints the same mask; Alt-stroke paints black; switching kind then stroking makes a new layer.
- **Size**: L.

### File and Edit

#### 37. Fill: Scripted Patterns (package B18)
- **PS**: Edit › Fill › Contents Pattern › Script: Brick Fill, Cross Weave, Place Along Path, Random Fill, Spiral, Symmetry Fill, each with Pattern Scale, Spacing, Color and Brightness Randomness, and per-script options.
- **JS**: `lib/scripted-patterns.js`:
  - `SCRIPTS` (six scripts, fields above), `SYMMETRY_TYPES` (nine), `scriptPlacements(id, {area, tile, options, paths})` (seeded and deterministic), `symmetryOps`, `recolorTile` (hue rotation keeping luminance plus brightness), `drawPlacements`, `MAX_COPIES 50000`;
  - called by `lib/edit-ops.js`.
- **PC**:
  - `edit.fill` contents pattern (`crates/engine/src/cmd/fill_cmds.rs`, CONTENTS l.20) fills a tiled pattern only.
  - "Bricks" and "Weave" are plain procedural patterns (`pattern_cmds.rs:92`), not scripts.
  - Fill dialog `dialogs/fill_ui.rs`.
- **Build**:
  - **Algo**: a new `crates/algo/src/scripted_patterns.rs`, porting `scriptPlacements`, `symmetryOps` and `recolorTile` verbatim:
    - `Placement { x, y, angle, scale, flip_x, flip_y, hue, bright }`;
    - `render(placements, tile, area) -> Surface`, compositing each transformed and recoloured copy with bilinear resampling via the existing transform helpers;
    - seeded with the existing `photocraft_paint::rng`, or a local splitmix: one RNG, documented.
  - **Engine**: `edit.fill` gets `"script":{"id":"brickFill|crossWeave|placeAlongPath|randomFill|spiral|symmetryFill","scale":%,"spacing":px,"offset":%,"colorRandom":%,"brightRandom":%,"alignment":"along|alternate","progression":%,"distance":px,"angle":deg,"fit":bool,"density":0.1..10,"minScale":%,"maxScale":%,"rotate":bool,"symmetry":"translation|mirror|mirrorBoth|glide|rotate180|rotate120|rotate90|rotate60|kaleidoscope","translateX":%,"translateY":%,"seed":u32}` with `contents:"pattern"`.
    - Place Along Path reads the active work path or the selected path (`"path":name?`); it is an error without one, as Photoshop greys it.
    - The seed is recorded in the journal, so Actions replay exactly. Photoshop has no seed; we record one so replays match.
  - **UI**: in `fill_ui.rs` under Pattern, a "Script" checkbox, the script dropdown, and per-script fields (the field table ported from `SCRIPTS`).
- **PSD**: n/a (pixels).
- **Tests**:
  - Algo: placement counts for brick 100×100 with a 10×10 tile and spacing 0 → 100 copies, rows offset by 50 %; spiral is monotonic in radius; a symmetry rotate-90 placement set is invariant under 90° rotation of the area centre; a fixed seed is deterministic.
  - Engine: `edit.fill` with a script changes pixels; place-along-path without a path errors.
- **Size**: L.

#### 38. Cursors: brush leash colour (package B17)
- **PS**: Preferences › Cursors › Brush Leash: "Show Leash While Smoothing" and its colour.
- **JS**: `shared/defaults.js:85` `cursors.leashColor '#4080ff'`; `lib/brush-cursor.js` draws the smoothing leash (`stroke.leash`).
- **PC**:
  - Prefs `Cursors { painting, show_crosshair_in_brush_tip, show_only_crosshair_while_painting, other, brush_preview_color }` (`crates/engine/src/prefs.rs:851`).
  - The leash is drawn in fixed white with a black halo (`crates/ui-egui/src/canvas/strokes.rs:725 draw_smoothing_string`, called from `canvas/paint.rs:608`); no preference.
- **Build**:
  - `Cursors.show_brush_leash: bool` (default true) and `brush_leash_color: String`. Default: Photoshop's (read from a Photoshop 2026 Preferences sample; JS used `#4080ff`).
  - `prefs/validate.rs` paths `cursors.showBrushLeash` and `cursors.brushLeashColor`.
  - The Preferences › Cursors page gets the checkbox and a colour swatch, using the same widget as Brush Preview colour (find it via `brush_preview_color` in `prefs_ui`).
  - `draw_smoothing_string` takes the colour, keeping the dark halo for contrast, and isn't called when off.
- **Tests**: prefs validate accepts and rejects; with `showBrushLeash:false` the smoothing string isn't drawn (paint test that inspects shapes); the colour is applied.
- **Size**: S.

(Rows 1–38 cover the 37 Pigment-ahead rows: 19 Type, 10 Select/Filter/View, 5 tools and 3 File/Edit. Row 21 only points to row 13. Other JS tests to port as oracles: `tests/unit/blur-gallery.test.mjs` (B10, B11) and `tests/unit/lens.test.mjs` (B12).)

## 3. Packages (about one to two engineer-days each)

The order is a single sequence that never has two packages editing the same files at once. Packages without a dependency between them can run in parallel if more engineers are free; the dependency list says which.

Files every package may append to: `crates/ui-egui/src/menu_catalog.rs` (rows only), `docs/FORK.md`, and the i18n English keys. Merge conflicts there are line-level and trivial.

| # | Package | Rows | Owns (new or main files) | Size | After |
|---|---|---|---|---|---|
| B1 | type-model-psd | 3, 4, 5, 6, 7 (PSD), 15 (model), 16, 17 (model), 18 (model), 20 (model), 14 (model) | `doc/src/text.rs`, `doc/src/lib.rs` (TextLayer), `format/src/manifest.rs`, `format/src/convert.rs`, `engine/src/cmd/type_cmds.rs` (prop keys), new `engine/src/cmd/type_reset_cmds.rs`, new `engine/src/cmd/type_layer_opts_cmds.rs`, `text/src/psd/{build,import}.rs`, new `text/src/psd/language.rs`, new `io/src/type_xmp.rs` | 2d | — (after AI P5, or coordinate `cmd.rs` registration lines) |
| B2 | type-character-ui | 1, 2, 3, 4, 5, 6, 7 (UI), 19 (Character menu) | `ui-egui/src/tools/type_tool/panel.rs` (Character section), new `type_tool/panel_menu.rs`, new `type_tool/languages.rs`, `type_tool/editing.rs` (CharToggle), `type_tool/keys.rs`, `panels/panel_docking.rs` (2 arms), `text/src/layout/style.rs` (NoWrap), `text/src/layout/lines.rs` (whole-pixel advances) | 1.5d | B1 |
| B3 | type-composer-hyphenation | 15 (layout), 20, 7 (hyphenation) | `Cargo.toml` + `text/Cargo.toml` (craft-text), new `text/src/layout/compose.rs`, `text/src/layout/shaping.rs` (3-line hook), `text/src/layout.rs` (offset map), NOTICE/ATTRIBUTION | 2d | B1, B2 (lines.rs) |
| B4 | type-justification-hanging | 18, 17 (layout) | `text/src/layout/compose.rs` (tiers, hang), `text/src/layout/lines.rs` (`apply_justification`, hang offsets) | 1.5d | B3 |
| B5 | type-paragraph-ui-lists | 14, 15 (UI), 16 (UI), 17 (UI), 18 (UI), 19 (Paragraph menu), 20 (UI) | `type_tool/panel.rs` (Paragraph section), `type_tool/panel_menu.rs` (paragraph_menu), new `ui-egui/src/dialogs/type_paragraph_dialogs.rs`, new `text/src/layout/lists.rs` + 1-line hook in `layout.rs`, `panels/type_panels_ui.rs` (style options hyphenate) | 2d | B1, B4 |
| B6 | type-editing | 11, 12, 13/21 | new `type_tool/clipboard.rs`, `type_tool/editing.rs` (paste path), `type_tool/pointer.rs`, `canvas/gesture.rs` (alt arg), new `dialogs/paragraph_size_ui.rs`, `engine/src/cmd/type_cmds.rs` (`type.edit` "paragraphs", `char_props_json`/`para_props_json`), `app/commands.rs` (route) | 1.5d | B1 (`type_cmds.rs`), B2 (`editing.rs`) |
| B7 | type-fonts | 8, 9, 10 | `ui-egui/src/text/font_preview.rs`, `type_tool/fonts.rs`, `engine/src/prefs.rs` (TypePrefs.font_sample), `engine/src/prefs/validate.rs`, `menus/view_cmds.rs`, `menus/view_cmds/dispatch.rs`, `engine/src/cmd/type_extra_cmds.rs` (resolve map), new `dialogs/missing_fonts_ui.rs`, `file_open.rs` | 1.5d | — (independent of B1–B6) |
| B8 | type-spelling-languages | 7 (spelling) | `Cargo.toml` (craft-proof), `engine/src/cmd/type_spell_cmds.rs`, `text/src/spell.rs` (thin wrapper or retire), Preferences › Type "Dictionaries folder" field in `prefs.rs` | 1d | B1, B2 (language UI) |
| B9 | smart-guides-spacing-labels | 22, 35 | `engine/src/snap.rs`, `ui-egui/src/canvas/snap_ui.rs`, `ui-egui/src/tools/move_distance.rs` | 1.5d | — |
| B10 | blur-gallery-effects | 23 | new `algo/src/gallery/effects.rs`, `algo/src/gallery.rs`, `algo/src/lib.rs` (variants), `engine/src/filters_ext.rs`, `ui-egui/src/dialogs/blur_pins.rs` | 2d | — |
| B11 | path-blur | 24 | `algo/src/gallery.rs` (`path`), `algo/src/params_ext.rs` (BlurPath), `engine/src/filters_ext.rs` (pathBlur), `ui-egui/src/dialogs/blur_pins.rs` (path editing) | 2d | B10 |
| B12 | lens-correction-workspace | 25, 26, 27 | new `ui-egui/src/dialogs/lens_correction_ui.rs`, `algo/src/lens.rs` (green_magenta), `engine/src/cmd/lens_cmds.rs`, dialog routing (1 arm), prefs UI state | 2d | — |
| B13 | shake-reduction | 28 | new `algo/src/sharpen/shake.rs`, `algo/src/lib.rs` (variant), `engine/src/filters.rs` | 2d | — (after B10 if both edit `algo/src/lib.rs` the same day) |
| B14 | focus-area-and-object-aware | 29, 30, 31 | new `ui-egui/src/dialogs/focus_area_ui.rs`, `ui-egui/src/canvas/select_mask_view.rs` (RevealLayer), `engine/src/cmd/smartselect_cmds.rs` (focusArea, refineEdge refineMode, output helper), `algo/src/segment/focus.rs`, `algo/src/matting.rs`, `ui-egui/src/dialogs/select_mask_ui.rs` | 2d | — |
| B15 | shapes-pattern-polygon | 32, 33 | `ui-egui/src/tools/shape_paint_ui.rs`, `tools/vector_ui/options.rs`, `dialogs/shape_dialog.rs`, `doc/src/vector.rs` (LiveShape::Polygon), `vector/src/shapes.rs`, `engine/src/cmd/vector_cmds/params.rs` | 1d | — |
| B16 | object-selection-modes | 34 | `engine/src/cmd/smartselect_cmds.rs` (select.object), `algo/src/segment/grabcut.rs`, `ui-egui/src/tools/retouch_ui.rs`, `ui-egui/src/state/tool_options.rs` | 1d | B14 (`smartselect_cmds.rs`) |
| B17 | adjustment-brush-and-leash | 36, 38 | `ui-egui/src/state/tool.rs`, new `ui-egui/src/tools/adjustment_brush.rs`, `state/tool_options.rs`, toolbar icon, `engine/src/prefs.rs` (Cursors), `prefs/validate.rs`, prefs UI Cursors page, `ui-egui/src/canvas/strokes.rs` (leash colour) | 2d | B16 (`tool_options.rs`), B7 (`prefs.rs`) |
| B18 | scripted-patterns | 37 | new `algo/src/scripted_patterns.rs`, `engine/src/cmd/fill_cmds.rs`, `ui-egui/src/dialogs/fill_ui.rs` | 2d | — |

**Suggested single-engineer order**: B1 → B2 → B3 → B4 → B5 → B6 → B7 → B8 → B9 → B10 → B11 → B12 → B13 → B14 → B16 → B15 → B17 → B18.

It runs the type chain first, because B1's model touches the most shared files. Total ≈ 31 engineer-days.

With two engineers:
- Engineer 1 runs the type chain B1–B8.
- Engineer 2 runs B9 → B10 → B11 → B12 → B13 → B14 → B16 → B15 → B17 → B18.
- The only shared files are `menu_catalog.rs` rows and `engine/src/prefs.rs` (B7 and B17: do B7's prefs change before B17's, or rebase).

**Conflict notes**:
- `engine/src/cmd.rs` registration lines: B1 adds two `specs()` lines; the AI team adds `ai_cmds` there. Land B1 after AI P5 or rebase.
- `text/src/layout/lines.rs`: B2 → B3 → B4 → B5, strictly in that order.
- `type_tool/panel.rs`: B2 edits the Character section, B5 the Paragraph section.
- `smartselect_cmds.rs`: B14 → B16.
- `blur_pins.rs` and `gallery.rs`: B10 → B11.
- `algo/src/lib.rs` `FilterParams`: B10, B13 (and B11 indirectly); sequential.

**Per-package rules** (same as AI-PORT.md):
- one cargo at a time with `-j 4`;
- `CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0`;
- run the tests of touched crates;
- fmt and clippy `-D warnings` on touched code;
- commit locally with the two trailers;
- a hand-off note in `planpc/build/PKG-<package>.md`;
- FORK.md entries for every upstream hook.

## 4. Dropped or not carried

- **JS "Line breaks: At Spaces Only (Pigment 0.3)" and the 0.3 greedy composer** (`paragraph.js legacyGreedy`, `isLegacyParagraph`, `breakRules:'legacy'`): a compatibility mode for 0.3 documents. PhotoCraft breaks by UAX #14 through parley/ICU, which is better, and no Pigment-on-PhotoCraft document was ever laid out the 0.3 way. The legacy `.pigment` importer (`crates/io/src/legacy_pigment.rs`) maps `breakRules:'legacy'` to Single-line, with no setting.
- **JS's own Liang hyphenator and pattern files** (`lib/type/hyphenation.js`, `lib/type/patterns/*`): not ported as code. `craft-text` provides the same patterns (via hypher) and a better English dictionary.
  - One language regresses: en-GB uses the US English data until craft-libs adds hyph-en-gb (MIT).
- **JS's own composer code** (`paragraph.js composeSingle/composeEvery/knuthPlass/setLine`): replaced by `craft-text::linebreak` (same algorithm family, with tiers, hang, zone and hyphen limit); the JS behaviour is the test oracle.
- **Hyphenate Across Column**: stored and round-tripped, no effect: PhotoCraft type has no columns. JS was the same.
- **Shake Reduction's Detail loupe**: not built; the dialog's preview and zoom cover it. Multiple trace regions are built.
- **Object Aware as a learned model**: not available offline (PhotoCraft #2788, no ML runtime). The classical approximation ships, labelled as such, and the API is ready for a model.
- Nothing else in scope is dropped.

## 5. Things to verify with Photoshop samples before or during the packages

These need a Photoshop 2026 PSD saved with the setting on and off; no key is guessed.
1. The EngineData `Language` integer per language (B1).
2. Whether System Layout changes the TySh `textGridding` value (B1).
3. ParagraphSheet keys, if any, for Hyphenate Capitalized Words, Last Word, Across Column and Single Word Justification (B1); defaults of HyphenatedWordSize, PreHyphen, PostHyphen, ConsecutiveHyphens and Zone.
4. Whether Photoshop stores bulleted and numbered lists, and how (B1/B5).
5. The Lens Correction smart-filter descriptor key for Fix Green/Magenta Fringe (B12).
6. Photoshop's default brush leash colour (B17); the Adjustment Brush's toolbar group (B17).
7. Whether the Type › Font Preview Size menu has "None" in Photoshop 2026 (B7). Keep it either way: Preferences has Off.
