# Review of group L (legacy `.pigment` importer: L1, L2, L3)

Branch `claude/pigment-photocraft`. Reviewed commits `d6247d8`, `ee0c526` (L1), `c2243fb` (L2),
`9adda5f` (L3) against `planpc/ports/PORTS-A.md` section 7 and the three PKG notes. CI on `9adda5f`
(run 44380051338) was green before this review.

## Commits (both pushed)

| Commit | What |
|---|---|
| `c085534` | Smart object placed too large: priced whole, reported, no longer fills memory. New test over every layer kind in Grayscale, 16 and 32 bits, through PSD and the new format. |
| `762d536` | A played Save step (actions, Batch) no longer stops at the legacy save prompt. Docs (FORK.md, release notes, user guide) say so; a misplaced comment in `dialogs.rs` moved to its `mod` line. |

CI on `762d536` was not waited for. **Check it first.**

## Findings

1. **Major, fixed (`c085534`). A smart object with a large transform killed the app.**
   `legacy_pigment/smart.rs` `render()`: when the engine's renderer refuses a placement (its
   `check_budget` errors), the importer falls back to `place_source` itself. The fallback priced only
   the placement clipped to the canvas, but `place_source` builds the unclipped surface. A 64 px PNG
   with `transform: [1000,0,0,1000,0,0]` hung for minutes and was OOM-killed. `[1e7,…]` did the same.
   A file only needs a scaled-up smart object for this to happen. Now the whole output is priced with
   `photocraft_algo::transform::warp_output_size`, as the engine prices it. If it does not fit, the
   layer stays undrawn and is reported ("could not be drawn"). Test:
   `text_smart_tests::a_smart_object_placed_too_large_is_reported_not_drawn`. Without the fix it
   timed out at 120 s; with it, 0.02 s.
2. **Major, fixed (`762d536`). Playing an action's Save step opened the legacy prompt.**
   `replay_save` (`ui-egui/src/app/files.rs`, which actions and Batch use) went through
   `save_in_place`, so it reached `legacy_save_prompt::intercept`. The action carried on with
   `confirmationPending` and nothing was written, so a "Save, Close" action or a Batch left the
   document unsaved. That contradicts the prompt module's own doc ("Recorded actions … don't ask") and
   `replay_save`'s contract ("no dialog or prompt"). It now calls `save_in_place_unasked` (one line,
   listed in FORK.md). Test: `legacy_save_prompt::tests::a_played_save_step_writes_without_asking`,
   which fails without the fix.
3. **Gap, covered by a new test (`c085534`).** No test opened L2/L3 layer kinds outside RGB 8-bit,
   or saved them as PSD. `layer_kinds_tests::every_layer_kind_opens_in_every_depth_and_mode_and_saves_as_psd_and_pigment`
   rewrites each v3 adjustment/fill/shape/style/blending/vector/text/smart fixture to RGB 16, RGB 32,
   Grayscale 8 and Grayscale 16. Each one opens, draws, and keeps its mode, depth and layer count
   through PSD and `.pigment`. Everything passed, so no defect was found there. A wider probe (Bitmap
   and CMYK too) also passed, except one upstream behaviour: a Bitmap document with alpha channels
   comes back from PSD as Grayscale. That is the PSD writer, not the importer.
4. **Minor, not fixed (upstream text engine).** A type layer with tens of thousands of style runs is
   quadratic: 6,000 runs took 2.6 s, 12,000 took 9.9 s, and 60,000 runs over 1 M characters took
   about 290 s, in the optimized test profile. The importer allows 65,536 runs (`text::MAX_RUNS`), as
   the PSD importer does (`MAX_ENGINE_RUNS`), so a PSD has the same cost. The time is in
   photocraft-text layout and drawing, not in `text.rs`. No real Pigment document is near this.
5. **Minor, not fixed (upstream vector).** A shape whose path has about 1,600 subpaths (no
   operations, so `PathOp::Join`) takes about 12 s in `CompiledShape`. A structured fuzz of every
   fixture found this (16 rounds per fixture, numbers set to extremes, arrays duplicated). It found no
   panic, and every other mutated file opened in under 4 s.
6. **Minor, not fixed (UX).** Closing or quitting with a dirty legacy document, then choosing Save
   in the unsaved-changes prompt, opens the legacy prompt next to the close prompt. The close prompt
   does not move on after the legacy Save, so the user clicks Save a second time (that save no longer
   asks). Nothing is lost. The disk-change prompt behaves the same way upstream.
7. **Minor, not fixed (performance).** `legacy_save_prompt::still_legacy` reads the whole file on the
   UI thread at every File › Save of a document whose import report says it came from Pigment
   0.1–0.4. That report survives saving, so it keeps happening after the file is native. Only the ZIP
   directory is needed.
8. **Noted, by design.** The picture bounds in `DIFFERENT_BY_DESIGN` are wide for adjustments that
   PhotoCraft computes as Photoshop does. Brightness/Contrast differs by 22 levels on average,
   Photo Filter and Colorize by about 12, CMYK Levels by 12.75. Those layers look visibly different
   from 0.4 once opened, and a field test checks each one's settings. The docs list them as
   "approximated". A6 or a later package could match the app's methods if users complain.

## Checked and fine

- Spec rows: the document, every layer kind, masks, vector masks, styles, blending, type, smart
  objects, smart filters, report and save prompt are implemented or recorded with a reason. The
  recorded gaps are: the active layer (no field in `ImportResult`), no `from_legacy_pigment` flag
  (the import report is used instead), 0.4 "vertical" kept as turned horizontal type, Color and
  Vibrance, Clarity and Dehaze and Grain kept as `pcJS`, noise gradients sampled, and pattern strokes
  without angle or phase.
- `filters.rs::adjustment` matches the engine's `adjust_params::to_params` key by key. Color Lookup
  is left out on purpose: its params carry no table.
- Hostile input: the existing fuzz loop, `hostile_*` tests and my structured fuzz found no panic.
  Container limits, the pattern budget, the nesting depth and dashes (budgeted upstream) hold.
- Every fixture opened, saved as PSD and reopened with the same layer count.
- Hooks: FORK.md lists every upstream file touched. `crates/format/src/brand.rs` and
  `.github/workflows/pigment-ci.yml` are Pigment's own. The L1 CI repair in `panels_toggle_tests.rs`
  is listed further down in FORK.md.
- Undo: opening is not a history step, and the prompt adds none.

## Checks run

- `cargo test -p photocraft-io --lib legacy_pigment`: 69 passed, 2 ignored (before: 67).
- `cargo test -p photocraft-ui-egui --lib -- legacy_save_prompt file_open file_dialog panels::actions disk_change discard`: 392 passed.
- `cargo clippy -p photocraft-io -p photocraft-ui-egui --all-targets -- -D warnings`: clean.
- `cargo fmt --all -- --check`: clean. `python3 scripts/pigment-rebrand.py --check`: clean.
- Not run: the engine tests (the engine was not changed), workspace-wide tests and clippy (CI runs
  them), the panic hunt and the xtask checks (no command, crate, preference or panel command was
  added).

## For the next group (A)

- Check CI on `762d536` first.
- A6: add the three new kinds to `adjust.rs` and to the `adjustment()` arm of `filters.rs`. P3:
  noise gradients only touch `gradient.rs`.
- Findings 4 and 5 are upstream performance limits, worth an upstream issue rather than a Pigment
  change. Finding 6 could be fixed by having `legacy_save_prompt::confirm` call
  `discard_ui::saved_document` after a successful Save, as `write_answered_save` does.
- Probing tools I used and did not commit: whole-document mode/depth rewriting (now the new test)
  and a JSON-level mutator over the fixtures (seeded xorshift; numbers to ±1e300, 1e7, "x" or null,
  arrays duplicated up to 2,000 times). Run probes with `MALLOC_ARENA_MAX=2` when you `ulimit -v`:
  otherwise glibc's 64 MB arenas trip the limit and look like real allocation failures.
