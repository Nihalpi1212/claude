# FIX: the AI engine commands (hunt-ai-engine.json)

CI before starting: the newest finished non-cancelled run on `claude/pigment-photocraft` was green
(44415849674); the newer ones were cancelled by later pushes, none red. Nothing to fix first.

All four findings reproduced with tests that failed on the old code (run before any fix:
6 new tests failed, 28 passed). They were fixed together in one commit (see below), because
their tests share `ai_cmds/tests.rs` and AIE-3 and AIE-4 both change `fill.rs`: splitting would
have pushed intermediate commits nobody built or tested.

Commit: 4934ed8 (Pigment: AI requests keep their paid answers: resolution, guides, variations, feathered masks)

## AIE-1 (major): Generate Image into a new document refused the open document's resolution

- Reproduced: `generate_image_into_a_new_document_survives_any_resolution_of_the_open_one`
  failed with `file.new: resolution must be a number within 1..=30000` after the mock was called.
- Fixed in `crates/engine/src/cmd/ai_cmds/generate.rs`: the resolution passed to `file.new` is
  the open document's when finite and positive, clamped to 1..=`MAX_RESOLUTION` (30000); else 72.
  Checked 40000 -> 30000, 0 / NaN / -5 / inf -> 72, 300 -> 300, one call each. Every other value
  given to `file.new` (16..8192 sizes, string name, fixed mode/depth/background) was already valid.

## AIE-2 (minor): guides, slices and the ruler origin edited the document under a running request

- Reproduced: `guides_and_slices_wait_for_a_running_request` (view.newGuide returned Ok while
  Generative Fill ran) and the guard `every_view_command_a_running_job_allows_leaves_its_document_alone`
  (runs every journaled `view.*` command with a set of plausible params during a locking job and
  fails if the document Arc changes).
- Fixed in `crates/engine/src/jobs.rs` (upstream file, hook marked `// Pigment:` and listed in
  `docs/FORK.md`): `independent_of_document` keeps `VIEW_EDITS` (newGuide, moveGuide, editGuide,
  deleteGuide, clearGuides, clearCanvasGuides, clearSelectedArtboardGuides, newGuideLayout,
  newGuidesFromShape, setRulerOrigin, resetRulerOrigin, clearSlices, lockSlices) out of what a job
  lets through. The guard passes, so no other `view.*` command it reaches edits the Document.
  This also protects PhotoCraft's own locking jobs (filters etc.), which lost results the same way.

## AIE-3 (minor): a later variation failing dropped the variations already paid for

- Reproduced: `a_failed_variation_keeps_the_ones_received` (Solid, Solid, quota error -> Err, no layers).
- Fixed in `ai_cmds/fill.rs`: `fill_layers` returns the images with an optional error; after at
  least one success a non-cancel failure stops asking and keeps what arrived. `run_fill` lands them
  in one step and adds `failed: {kind, message}` to the result. The first failing, or a cancel at
  any point, is still an error and lands nothing (tested). `expand.rs` adapted (one variation).
  The old test "a second variation failing drops the first too" now expects the first kept.
- The Generate window (`crates/ui-egui/src/ai_ui/generate.rs`, Pigment's own file) shows the
  failure under the note ("The variations that arrived were kept. The next one failed: ..."),
  inline and from a background job; UI test `a_failed_variation_keeps_the_ones_that_arrived_and_says_so`.
  New string goes through `tl!` with the English fallback. Spec text and `docs/generative-ai.md` say so.

## AIE-4 (minor): provider Remove Background ignored the old mask's feather and relinked it

- Reproduced: `remove_background_by_provider_keeps_the_old_masks_feather_and_link` (hard edge,
  mask linked again) and `generate_background_reads_the_subject_through_the_masks_feather`
  (Generate Background's layer stepped 1 -> 0 between x=31 and 32).
- Fixed: new helper `mask_shown` in `crates/engine/src/cmd/ai_cmds.rs` reads the pixel mask as the
  compositor draws it (`photocraft_compose::masks::combined_mask` on a copy without the vector
  mask, as Layer > Layer Mask > Apply does). `background.rs` uses it for what is sent and for the
  new mask, which bakes the old feather and density in (feather 0, density 1, so not doubled) and
  keeps the old mask's `linked` flag; `enabled` is true since the new mask must show.
  `fill.rs` `visible_alpha` uses it too. The composite row across the edge is unchanged (< 0.02).

## Checks

- `cargo test -p photocraft-engine --lib`: 3941 passed, 0 failed.
- `cargo test -p photocraft-ui-egui --test it -- ai`: 94 passed.
- panic hunt (`cargo test -p photocraft-engine --test panic_hunt -- --ignored`): passed.
- `cargo fmt --all -- --check`, `cargo clippy -p photocraft-engine -p photocraft-ui-egui --all-targets -- -D warnings`,
  `python3 scripts/pigment-rebrand.py --check`: clean.

Nothing left for 0.6 from this hunt.
