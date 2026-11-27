# Merge 057297b, step "ci" (§6 step 9: CI and the full gate)

Branch `claude/pigment-merge-057297b`, on top of rebrand-docs' `88de0b5`. Two commits, both pushed:

- **`b45cbd8`** "Pigment merge 057297b, CI: craft-fonts cc9269c, stripped test builds, egui-fork and
  test-binaries checks".
- **`9205833`** "Pigment merge 057297b: the known upstream test
  failures pass at 057297b, the list is empty".

## What I did

1. **`.github/workflows/pigment-ci.yml`**
   - craft-fonts `b076417b…` → **`cc9269cd8d8258785dac603fba3122e5d2556795`** (upstream's ci.yml and
     release.yml at NEW). This is what made CI's two font failures on `88de0b5` go away: the old pin
     has no Tamil font, and upstream's new all-language UI tests draw "த" (U+0BA4) with
     `MissingGlyphPolicy::Panic` (`prefs::prefs_ui::tests::theme_star_saves_favorite_and_menu_groups_it`,
     `i18n::live_tests::preferences_preview_does_not_commit_until_applied_and_survives_reload`).
   - Job env: `CARGO_PROFILE_DEV_DEBUG: '0'` and `CARGO_PROFILE_TEST_STRIP: symbols`, as upstream's gate
     (`dev-debug: "0"`, `CARGO_PROFILE_TEST_STRIP=symbols`): test build ~6.5 GB instead of ~19 GB.
     They apply to every step (clippy, tests, panic hunt, doctests, the smoke-test build), so all share
     one build and one rust-cache key (the key hashes CARGO_* variables, so the first run after this
     builds cold).
   - "Repository checks" now runs `cargo xtask egui-fork`, `layers`, `panel-commands`,
     **`test-binaries`**, `scorecard --check` (renamed step).
   - "Known upstream test failures" passes `--no-tests=pass`: with an empty list the filter is
     `none()` and nextest would otherwise exit 4 ("no tests to run").
2. **`.github/workflows/pigment-release.yml`**: `CRAFT_FONTS_REF` → `cc9269c…`. It sets no `RUSTFLAGS`
   (plan risk 7: `.cargo/config.toml`'s msvc delay-load flags stay in force). The release builds go
   through the packaging scripts; no test step, so no strip setting needed there.
3. **`crates/genai/tests/genai/` → `crates/genai/tests/it/`** (`git mv`, 7 files, no content change;
   the genai crate has no `[[test]]` entries). FORK.md's Generative AI paragraph names the new folder.
4. **`docs/scorecard.md`** regenerated (`cargo xtask scorecard`): settings that do nothing 9 → 10 of
   202 (the new one is `general.automatically_check_updates`, which Pigment hides and never reads:
   correct, plan risk 4), never-crash lints 25 → 26 of 26 crates (pigment-genai). This also fixes
   CI's `xtask scorecard::tests::staleness_check_and_determinism` failure on `88de0b5`.
5. **FORK.md step 9 on `scripts/upstream-test-failures.txt`.** Of 0.5.0's 60 entries, the 7 the plan
   named no longer exist at NEW (checked: no `fn` of that name in `crates/raw/tests`); the other 53
   **all pass** (`cargo nextest run --profile ci -p photocraft-format -p photocraft-io -p photocraft-raw
   --features photocraft-io/heif --lib --bins --tests -E "$(python3 scripts/upstream-test-filter.py
   --only)"`: **53 run, 53 passed**, here as root, including the permission tests). So the list is now
   empty, its header kept and rewritten (how to use it, what happened at 057297b). The filter script
   prints `all()` / `none()` for an empty list (it already handled that). The file now reads:

   ```
   # Integration tests that fail on PhotoCraft's own tree at the revision in UPSTREAM-REVISION, ...
   # pigment-ci.yml leaves exactly these tests out of the Tests step ... runs them on their own ...
   # Remove a line when it passes after a merge (docs/FORK.md, "Merging a later upstream revision").
   # One full test name per line ..., under a section line `# <package> --test <target> (<folder>)`
   #
   # Empty since the 057297b merge. Pigment 0.5.0 (upstream abb30df) listed 60 tests in photocraft-format,
   # photocraft-io and photocraft-raw, ... At 057297b upstream deleted 7 of them, and the other 53 pass
   # with craft-libs 18ffc07 (and craft-svg 7b8c1ec).
   ```
   FORK.md step 9 rewritten to match (no fixed count; remove deleted and passing tests; add only a
   test that also fails on upstream's own tree) and now also says to check the CI settings upstream's
   gate changed, since `.github/` is left out of the patch (craft-fonts pin in both workflows, the
   test-build environment, the `cargo xtask ci lint` checks).

No Rust code changed in this step. No hand merges (nothing conflicted).

## The gate, locally (CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_STRIP=symbols, 4 jobs, TMPDIR=/dev/shm/pt, CRAFT_I18N_DIR, CRAFT_FONTS_DIR=craft-fonts at cc9269c, PHOTOCRAFT_NO_PRINT=1)

| Check | Result |
|---|---|
| `cargo metadata --locked` | ok |
| `python3 scripts/pigment-rebrand.py --check` | clean |
| `cargo fmt --all -- --check` | clean |
| `cargo clippy --workspace --all-targets --locked --features heif --keep-going -- -D warnings` | **clean** (3 m 18 s) |
| `cargo xtask egui-fork` / `layers` / `panel-commands` / `test-binaries` / `scorecard --check` | all OK (27 crates no violations; 0 direct mutations; test-binaries ok with the 3 allow-listed binaries; scorecard up to date after regenerating) |
| `cargo test -p xtask` | 13 + 95 passed |
| `cargo nextest run --profile ci --workspace --locked --features heif --lib --bins --tests -E "$(… --skip)"` (= all()) | **14135 run: 14133 passed, 2 failed, 91 skipped** (24 min). Both failures are this container's, and both passed in CI on `88de0b5`: see below |
| Known upstream failures (`--only`, before emptying the list) | 53 run, 53 passed |
| Panic hunt (`--run-ignored only -E 'binary_id(photocraft-engine::panic_hunt)'`) | 1 passed (42 s) |
| Doctests (`cargo test --workspace --locked --features heif --no-fail-fast --doc`) | ok (no doctests run, 24 crates) |
| CLI smoke test (CI's step, run as a script) | **passes**: `Pigment 0.5.0 (based on PhotoCraft 0.23.1+057297b)` matches CI's `grep -qx` pattern; new/convert/info round trip, the 0.4 documents, File Info, the damaged-file error |
| Packaging script tests (`apprun-test`, `apprun-cli-test`, `verified-download-test`, `package-docs-test`) | all pass (desktop-file-validate and appstreamcli are not installed here; CI runs them) |

The two local failures:
- `photocraft-gpu::it bounded_readback::bounded_readback_preserves_effect_halos_across_seams`: the
  container's adapter refuses `RENDER_ATTACHMENT` on an `R32Float` texture ("downlevel restrictions").
  Upstream test, upstream crate; passes on CI's lavapipe.
- `photocraft-ui-egui::it ai_assistant::adjustments_and_filters_are_clamped_and_take_json_text`:
  "not enough working memory" for the clamped Gaussian Blur. The engine's budget
  (`photocraft_raster::memory`) reads the cgroup's limit minus its usage, and this container's
  cgroup counts the page cache of the 18 GB target dir (usage 10.8 of 14.3 GB). After
  `echo 1 > /proc/sys/vm/drop_caches` it **passes** alone. CI passes it. If it ever fails in CI, the
  test should apply a smaller-than-max radius, but the code is fine.

## CI

- `88de0b5` (before this step): clippy, rebrand, fmt, panic hunt, doctests, packaging, smoke test
  green; Tests failed on the 2 font tests and the scorecard test, repository checks on the stale
  scorecard: all three fixed by this step.
- **CI result on `9205833` (run 45931901504): green, every step.** Tests: 14135 run, 14135 passed,
  91 skipped (1556 s); known upstream failures: 0 tests (`--no-tests=pass`); panic hunt 1 passed;
  repository checks (with egui-fork and test-binaries), packaging, CLI smoke test, lockfile
  unchanged: success. The job took 70 min on a cold cache (the new CARGO_PROFILE_* variables change
  rust-cache's key), within its 150-minute limit. The run for `b45cbd8` was superseded (cancelled
  while pending) by `9205833`'s. Ready for the verifier to fast-forward `claude/pigment-photocraft`.

## Left

- Whether to drop `apps/photocraft`'s unused `craft-update` dependency: kept (FORK.md says it is
  kept so the manifests stay upstream's; nothing calls its network paths).
- Optional, not done: upstream's ast-grep rules (`lint/ast-grep/`), the wasm check and
  `i18n-report` of `cargo xtask ci lint` (Pigment's CI never ran them; plan §7 says optional).
- Disk: I removed 2,339 stale `photocraft_*`/`pigment_*`/`craft_*` artifacts from
  `target/debug/deps` (kept the newest 3 hashes per crate name; 12 GB freed) when the test build ran
  the disk down to 3 GB, and the test executables over 20 MB at the end.
