# Merge 057297b, step "engine" (§6 step 2)

Branch `claude/pigment-merge-057297b`, commit **`8cebf29`** "Pigment merge 057297b, engine: Pigment's
hooks on upstream's engine" on top of the import commit `63f09b6`. Pushed. Tree clean after it.

## What I did

1. **`crates/engine/src/shell_commands.rs`** (the import's 1 lost hunk): Pigment's three link rows put
   back after `help.reportIssue`: `help.github` "Pigment on GitHub", `help.website` "Pigment Releases",
   `help.artcraftWebsite` "PhotoCraft (upstream project)"; then upstream's new
   `("help.checkForUpdates", "Check for Updates…", &["Help"], None)`, `help.systemInfo`, "About Pigment".
   No `help.discord`. Order of the Help rows: Report an Issue, Pigment on GitHub, Pigment Releases,
   PhotoCraft (upstream project), Check for Updates…, System Info…, About Pigment. (ui-egui's
   `links.rs` Help-menu test, step 5, must expect `help.checkForUpdates` in this place.)
2. **`build_info::RELEASES`** (`crates/engine/src/build_info.rs`, upstream's new home of the link the
   memory-limit messages in `error.rs` give): `https://github.com/Nihalpi1212/claude/releases`, doc
   comment "Pigment's (docs/FORK.md)". `updates_cmds.rs` is gone (import commit).
3. **`crates/engine/src/lib.rs`**: the lost comment `// Pigment: smart objects of Pigment 0.1–0.4
   documents are drawn by the engine.` now sits on `pub mod legacy_pigment_render;` (`kys` →
   `keymap_defs` is upstream's). **`cmd.rs`**: the `// Pigment: generative AI` comment had sat above
   `mod adjust_params;` (also in 0.5.0); moved onto `pub mod ai_cmds;`.
4. **Every engine hook of §4.2 checked against NEW** (diff of upstream's blob at NEW against the tree,
   compared with Pigment's diff `15b8ea5..f4e3ffa`): every engine file Pigment changed has exactly
   Pigment's change on NEW's code (same +/− counts) — `cmd.rs` (ai_cmds module + specs),
   `actions_cmds.rs` `recorded()` (`ai_cmds::unrecorded`), `jobs.rs` (`VIEW_EDITS`,
   `legacy_pigment_render::install()` in `import_options`), `file_cmds/open.rs` (install in
   `import_result_for_open`, `pigment` in `OPEN_AS_EXTRA`, message), `smart_cmds.rs`
   (`pub use rendering::refresh_layer_with`), `smart_cmds/rendering.rs`, `error.rs`
   (`EngineError::Generative`, `build_info::RELEASES`), `prefs/validate.rs`
   (`general.automaticallyCheckUpdates` hidden), `Cargo.toml` (`testgen`), the `.pigment` lines in
   `file_cmds.rs`, `batch_run.rs`, `paths.rs`, `print_cmds.rs` (+tests), `notes_cmds.rs`,
   `video_cmds.rs`, the script strings. **`refresh_layer_with` re-read**: NEW's `refresh_layer` is
   still "refuse when `unapplied_filters` is non-empty, else `refresh_layer_in(doc, l, ctx)`";
   Pigment's twin mirrors it exactly with the caller's `JobCtx`. Nothing to change.
5. **API change hit in Pigment's own engine code** (the only one): craft's
   `craft::automation::actions::ActionList` replaced the `Vec<Action>` and steps are `ActionStep`
   (`{command, params}`), not `(String, Value)`. `cmd/ai_cmds/tests.rs` (3 tests):
   `s.actions.list.actions().iter()`, `step.command`, `ActionStep::new(id, params)`, and
   `s.actions.list.push(..).unwrap()` (push returns `Result` now). Pigment's non-test engine code
   compiled unchanged.
6. **Rebrand of the engine's script-only files now** (the step-8 pass would give the same result):
   `pigment-rebrand.py`'s `rewrite()` applied to the five engine files `--check` listed —
   `file_cmds/export.rs` (`write_cube_export("Pigment", …)`: the CUBE creator line, as 0.5.0 had; its
   test `header_follows_the_reference_comment_layout` expects "Pigment"), `swatch_cmds.rs` (message),
   and upstream's new default actions set: `actions_edit_cmds/library_commands.rs`
   `BASICS_SET = "Pigment Basics"` (+ its tests and the `actions.reset` help text in
   `actions_edit_cmds.rs`). Only the engine files; `--check` now lists no `crates/engine` file.
   Decision taken: the set is "Pigment Basics" (a product name in a visible set name; the id-free
   string is only ever matched against itself). A code comment at `library_commands.rs:153` still
   says `PhotoCraft Basics 2` (the script leaves comments).
7. **`crates/ui-egui/src/updates_ui.rs`, one hunk of step 5's file** (needed for the engine's own
   test): upstream's `tick` ran `Updater::check_at_start()` when `general.automatically_check_updates`
   is on — the update check at launch Pigment never makes. `tick` now only calls
   `read_last_update()` (a local file), with a doc comment saying `check_at_start` is never called.
   Without this the engine test `tests/it/prefs_usage.rs::every_preference_is_read_or_hidden` fails
   ("these preferences are read now: … general.automaticallyCheckUpdates"), because it scans all of
   `crates/` and `apps/` for reads. **Not compiled** (ui-egui doesn't build yet); the edit only
   removes the `if/else`. Step 5 still owns the rest of that file: `check` must open
   `build_info::RELEASES` (via `links::open`) and return `{"status":"opened"}` instead of
   `check_now()`, Pigment's module doc and two tests, and upstream's test
   `manual_check_works_when_automatic_checks_are_off_and_opens_status` will need rewriting then.
8. **FORK.md**: the endpoint-table row and the hand-done list name `crates/engine/src/build_info.rs`
   for `RELEASES` instead of `cmd/updates_cmds.rs`. Nothing else in FORK.md touched (step 8).

Not done here (not engine): D3's version line lives in `crates/format/src/brand.rs`
(`version_line()`/`UPSTREAM_VERSION`), so `Pigment 0.5.x (based on PhotoCraft 0.23.1+057297b)` is for
step 4/6/8 together with the CLI/app tests and CI's smoke-test pattern.
`.pcraft` mentions in the engine (`rg '\.pcraft' crates/engine/src`) are comments and tests only; no
new user message or extension list that should also name `.pigment`.

## Tests and checks (CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_STRIP=symbols, -j 4, TMPDIR=/dev/shm/pt, CRAFT_I18N_DIR, CRAFT_FONTS_DIR=craft-fonts at cc9269c)

| Command | Result |
|---|---|
| `cargo test -p photocraft-engine --features testgen --no-run` | builds, no warnings from workspace crates (after the ai_cmds test fix) |
| `cargo test -p photocraft-engine --features testgen --no-fail-fast` | lib **4135 passed, 1 failed** (below), 17 ignored; all 34 `ai_cmds::tests` pass; `tests/global_state` 26 passed; `tests/it` 740 passed + `prefs_usage` (failed before the updates_ui fix; rerun after it: 4/4 pass); `panic_hunt` 1 passed (non-ignored); doctests 0 |
| `cargo test -p photocraft-engine --features testgen --test panic_hunt -- --ignored` | **ok**, `no_command_panics_or_hangs_on_adversarial_params` passed in 42 s |
| `cargo clippy -p photocraft-engine --features testgen --all-targets -- -D warnings` | clean |
| `rustfmt --check --edition 2024` on the changed .rs files | clean |
| `pigment-rebrand.py --check` | no `crates/engine` file listed (other crates: step 8) |

**The one failure: `legacy_pigment_render::tests::cancelling_the_open_stops_the_smart_filters`**
("300ms: stopped 47.6s after the cancel"). Not a merge regression:
- I built **0.5.0 (`f4e3ffa`) in a scratch worktree** (own target dir, since removed) and ran the
  same test the same way: it **fails identically** (45 s). Also under `cargo nextest --profile ci`
  on the merge tree (48 s). Pigment CI at `f4e3ffa` (run 44445557238) passed it in 0.53 s.
- What happens (instrumented, instrumentation removed): the watcher cancels the `JobCtx` 0.16 s into
  the first smart filter, but that filter (Median radius 500 on the 1024 px placement) is one 1024 px
  algo tile (`auto_tile` for a 1024 halo), and photocraft-algo's tiled kernels check the interrupt
  only between tiles, so the first filter runs to its end (~45 s here) before `render_in`'s
  per-filter `ctx.check()` stops the rest. Same inputs at 0.5.0 (area −501..1525 ∩ extent 1024²,
  bounds 64², U8 RGBA). Why CI finishes the median in well under a second I could not establish
  (same features under `-p` and `--workspace`, single-threaded kernel here: user ≈ real). The
  0.5.0 notes (FIX-importer.md, IMP-3) say it passed here then; whatever changed is in the
  container, not the code. **Watch CI's result for this test** when the merge branch's CI first runs
  the engine; if it fails there too, the fix is in the test (a filter that checks its interrupt, or
  smaller tiles: e.g. a radius that keeps several tiles) or a mid-tile interrupt in algo (upstream
  code: avoid).

Disk: 18 GB free at the end (`df -h /`), target ≈ 7.5 GB.

## Left for the next steps

- Step 3 (genai + automation), 4 (CLI), 5 (ui-egui, including the rest of `updates_ui.rs` above and
  the Help-menu test in `links.rs` with the row order of item 1), 6–9 as the plan says.
- The cancel test above: confirm on CI.
- D3 (version line in `crates/format/src/brand.rs`) not done.
