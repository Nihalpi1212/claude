# PKG-port-B3: the Single-line and Every-line composers and hyphenation (group BT, package 3)

Spec: PORTS-B.md rows 15 (layout), 20, 7 (hyphenation), with row 3's and row 4's composer clauses; REBASE-BT.md "B3"
(wins where they differ). Tree: `claude/pigment-photocraft` on top of d6fe4428 (B2). CI before starting: the newest
finished run (4adcf9c6, B1) was green; B2's run (d6fe4428) was still in progress, so nothing to fix first.
REBASE-BT's B3 line numbers were checked against the tree and still hold (`Para::break_lines` shaping.rs:390,
`map_offset` 293, `break_area` 90; groups A, P, FU did not touch `crates/text`).

## What was built

`crates/text/src/layout/compose.rs` (new) breaks box text with Adobe's composers and hyphenates it.

- **Which paragraphs compose** (`Para::composes`): horizontal box text (`is_box`, not vertical, not area) whose
  paragraph has `composer: EveryLine` (Photoshop's default, `ParagraphStyle::default()`) or `hyphenate`. Everything
  else is the fast path: parley's greedy `break_all_lines`, byte-identical (the whole upstream text suite passes
  unchanged). Old native files and PSDs without `EveryLineComposer` read as SingleLine (B1), so they keep their breaks
  unless they hyphenate.
- **Items:** the paragraph is shaped once and broken without a width; its clusters (logical order, ligature pieces
  merged) become `craft::text::linebreak` boxes (advance × horizontal scale, rounded when `whole_px.advances`: row 3),
  spaces glue (stretch from Word Spacing max − desired; **no shrink**, see below), no-break spaces glue behind an
  infinite penalty, forced breaks fill + forced. Opportunities come from `craft::text::segment::line_breaks` (UAX #14
  with kinsoku), minus Hangul–Hangul (parley's KeepAll); after `-`/U+2010 they are explicit-hyphen penalties (cost 50,
  unflagged); after U+00AD discretionary hyphens (drawn). Hyphenation points: `craft::text::hyphen::hyphen_points_in`
  on whitespace-delimited words split where the run language changes (`run.language`, default en-US;
  `Lang::for_language`), with Limits { Words Longer Than, After First, Before Last, Capitalized }; Hyphenate Last Word
  off drops the paragraph's last word; none in a No Break run; none in a paragraph with right-to-left script. Emergency
  penalties inside pieces wider than the narrowest line. No Break (row 4): no break inside a no-break range or at its
  end; a break may start one (that is what the spec's own "aaa bbb ccc" test and parley's lagging wrap mode need).
- **Every-line:** JS `composeEvery`'s passes on `linebreak::knuth_plass`: without hyphenation at pretolerance (ratio 1
  = badness 100), with it at tolerance (ratio 2^(1/3) = badness 200), then `break_paragraph` with emergency breaks at a
  huge tolerance (overfull accepted). Line penalty 10, hyphen 50, double hyphen 3000, fitness 3000, Hyphen Limit as
  craft's hard `hyphen_limit`, ragged lines rated against 6 spaces with `Rag.hyphenation_zone` = Zone × px/pt,
  `uniform_from` 1 with a first-line indent. **Not ported:** JS's final-hyphen demerits 5000 (craft has no parameter).
- **Single-line:** JS `composeSingle` ported over the same items (`single_line`): the last whole-word break that fits;
  a hyphen only if no whole word fits, or (justified) the whole-word line's ratio is outside −1..1, or (ragged) it would
  leave at least the Hyphenation Zone; Hyphen Limit; emergency breaks only when nothing fits. The spec says "craft's
  `greedy` with stretch/shrink weights"; craft's greedy cannot express "spacing within Minimum..Maximum beats a
  hyphen", so the JS algorithm is used (recorded choice).
- **Line breaking in parley** (`compose_lines`, a 3-line hook in `Para::break_lines`): instead of inserting U+2028 and
  an offset map (spec decision 2, step 4), parley breaks the paragraph again one line at a time with
  `set_line_max_advance` = the composed line's width in parley's own units (+1e-3 relative), so parley's breaker ends
  each line exactly at the chosen opportunity; `set_prior_line_width` gives each line the box width (less the hyphen),
  so parley still aligns and **justifies** the lines (Regular breaks; LS-inserted breaks would be Explicit and parley
  would not justify them before B4). A word with hyphenation points is shaped `WordBreak::BreakAll` (hook in `shape`)
  so parley may break inside it. After breaking, the line starts are compared with the composer's; on any mismatch the
  paragraph takes `break_all_lines(Some(avail))` (parley greedy). **Choice recorded:** no text insertion, so
  `LineInfo.range`, clusters and carets stay in layer offsets with no insertion map; the spec's "offset map in
  layout.rs" is not needed.
- **The hyphen** (`place_hyphen`, a 1-line hook in `place_line`): on a Regular line ending at a hyphenation point or
  after a soft hyphen, U+2010 (else `-`) in the face of the line's last glyph, placed at that cluster's end, glyph range
  empty (b..b), no cluster (so the caret at the break shows on the next line), its width added to the line extent;
  `snap_line` (B2) rounds it with the line.
- **Dependencies:** `crates/text/Cargo.toml` adds the `craft` facade features `text`, `text-german`, `-french`,
  `-spanish`, `-italian`, `-dutch`, `-portuguese` (REBASE's line). Cargo.lock unchanged. `cargo tree -e features -i
  hypher`: alloc + the six languages, no Slovak. Notices in `NOTICE` and `ATTRIBUTION.md` (copyright lines from the JS
  `patterns/LICENSES.md` and craft-i18n's pattern headers; hypher's exact pattern versions may differ from those files,
  as they come from hyph-utf8 through hypher 0.1.8). The wasm size was not measured (no web build here): the six tries
  are small, check `packaging/web/package.sh` once.

## Not done (and why)
- **Word-space shrinking** (Justification minimum): parley's justification only stretches, so shrinking would make
  lines overflow the box. `Setting.shrink` exists (tests use it); B4 turns it on with its own `apply_justification`.
  Letter/glyph tiers and hanging punctuation are B4.
- **Area type** keeps parley's slot greedy with no hyphenation (spec: "pass the slot widths to greedy"). `BreakAll`
  would let parley break hyphenatable words at any letter there, so it needs its own slot-aware composer pass; left.
- **Right-to-left paragraphs** compose (Every-line) but get no hyphenation points.
- The fallback (parley greedy on a mismatch) can break a `BreakAll` word at a letter that is not a hyphenation point
  (no hyphen drawn). Not seen in tests; it needs an opportunity only one of parley/craft-segment sees.
- `LineInfo.x1` of a justified line is parley's unjustified extent, as on the fast path (upstream behaviour).
- The release-build bench was run at the workspace's `opt-level = 1` dev profile: 42–45 ms for 2,000 words
  (parley greedy alone ~13 ms), under the 50 ms target already; not run in `--release`.
- UI (Hyphenate check box, Hyphenation… dialog, composer menu rows) is B5.

## Files
New: `crates/text/src/layout/compose.rs`, `crates/text/src/layout/compose_tests.rs`, `crates/text/src/pigment_compose_tests.rs`.
Hooks (all in docs/FORK.md, "The Single-line and Every-line composers and hyphenation (typography, part 3)"):
- `crates/text/Cargo.toml`: craft features.
- `crates/text/src/layout.rs`: `mod compose;`.
- `crates/text/src/layout/shaping.rs`: field `Para.hyphens: OnceCell<compose::Hyphens>` + init; `shape`:
  `self.push_hyphen_words(&mut b)`; `break_lines`: `if !self.compose_lines(layout) { parley greedy }`.
- `crates/text/src/layout/lines.rs`: `place_line`: `state.extra += self.place_hyphen(out, line, c0, g0)` (after the
  glyph runs, before vertical squeeze / JustifyAll / B2's `snap_line`).
- `crates/text/src/lib.rs`: `#[cfg(test)] mod pigment_compose_tests;`.
- `NOTICE`, `ATTRIBUTION.md`.

## Tests
- `layout::compose::tests` (11, fixed advances, ported from JS `type-paragraph-panel.test.mjs`): the classic
  minimum-raggedness case (Single-line "aaa bb/cc/ddddd", Every-line "aaa/bb cc/ddddd"); Single-line is first fit;
  justified Every-line differs from greedy and fits (with shrink, and without); spacing within range beats a hyphen;
  ragged hyphenation only past the zone, an overlong word hyphenates whatever the zone; Hyphen Limit 1 and 2 for both
  composers, Hyphenate Last Word; Words Longer Than / After First / Before Last; No Break (no hyphen, "aaa bbb ccc"
  breaks after "aaa"); emergency breaks draw no hyphen; explicit vs soft hyphens.
- `pigment_compose_tests` (10 + 1 ignored bench, Inter at 72 dpi): "internationalization" in a 60 px box hyphenates at a
  craft-text point, lines and clusters cover the layer text, the caret at the break is on the next line; Words Longer
  Than 25 → no hyphen; Hyphen Limit 1 for both composers; "Wasserstoff" differs de/en-US and a German run breaks at a
  German point; a no-break word takes no hyphen; Every-line's rag is more even than Single-line's; Single-line without
  hyphenation is greedy; composed justified lines end flush (hyphen included); Fractional Widths off composes inside the
  box on whole pixels; first-line indent and forced line breaks.
- Runs: `cargo nextest run --profile ci -j 4 -p photocraft-text -p photocraft-io -p photocraft-engine --features
  photocraft-io/heif --lib --tests`: 6924 passed, 46 skipped. ui-egui whole suite (`nextest --profile ci -j 3 -p
  photocraft-ui-egui --features photocraft-io/heif --lib --bins --tests`): 3849 passed, 6 skipped.
- Checks: `cargo fmt --all -- --check`, `cargo clippy -p photocraft-text --all-targets -- -D warnings`,
  `python3 scripts/pigment-rebrand.py --check`: OK. No engine command, crate, preference or panel command was added
  (no panic hunt, xtask layers/panel-commands/scorecard needed).

## Commit (pushed to `claude/pigment-photocraft`; CI on it not waited for)
- `1f878ad6` Pigment Single-line and Every-line composers and hyphenation (B3), text and docs

CI before starting: B1 and B2 runs green.

## For the next package (B4)
- Turn on `Setting.shrink` (in `Setting::of`) only together with a justification pass in `lines.rs` that can close
  spaces up; then a composed line may be wider than the box at natural spacing, and the parley per-line width
  (`targets`) must stay the natural width (it does: it sums parley's raw advances).
- Tiers: `items()` builds glue with tier 0 only; add letter (tier 1) and glyph (tier 2) stretch/shrink on boxes and
  `Params.tier_cost`; `Line.ratio/tiers` are available from `knuth_plass` (the Single-line port computes its own ratio
  from tier 0: extend `Sums`).
- B4 replaces parley's justification for composed paragraphs: `compose_lines` currently relies on parley's Justify
  (Regular breaks + `set_prior_line_width`). Keep B2's `snap_line` after your justification and after
  `place_hyphen`. A hyphenated line's prior width is the box less the hyphen.
- Hanging punctuation: `Item.hang` on break items/boxes; `place_hyphen` is where a hanging hyphen would move.
- B5 (UI) can now show the Hyphenate check box (`panel.rs:97` `.hyphenate(false)`), and the Paragraph Style Options
  Hyphenate row; the `languages.rs` "(no dictionary)" marks for de/fr/es/it/nl/pt go away now that the features are on.
