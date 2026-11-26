# Merge 057297b, step "cli" (§6 step 4: the command line)

Branch `claude/pigment-merge-057297b`, commit **`f42fe5f`** "Pigment merge 057297b, command line:
Pigment's live-MCP condition, AI hook, version line", on top of the automation commit `51ac04f`.
Pushed. Tree clean after it.

This step was started by an engineer stopped by the owner's pause (Nov 19 06:22 UTC) and finished
after the resume (Nov 26). The paused work (8 files, +24 −11, snapshot `c00f21b` on
`claude/pigment-photocraft-wip`) was read, judged correct and kept; I added the dependency cleanup
and the FORK.md lines below, then ran the tests and the smoke test.

## Hand merges

1. **`apps/photocraft-cli/src/automation.rs`** (1 conflict hunk of the import, upstream's then):
   `mcp` is back to Pigment's condition, `None if !a.headless => PhotocraftMcp::live(live_config(a)?)`.
   Upstream's version added `&& craft::automation::agents::mcp_flag()`. That reads the suite's flags
   file (`ArtCraft/flags.toml` / `CRAFT_FLAGS`), which breaks D1, and without the flag
   `pigment-cli mcp` would never reach the open window. Pigment's doc comment for `mcp` had merged
   cleanly. The live config still uses `agent_link::agents_allowed_now`, which is Pigment's gate
   from step 3. Upstream's other changes in the file, `GpuPolicy::from_args(..)?` (now
   `crate::Result`) in three places, are kept.
2. **`apps/photocraft-cli/Cargo.toml`** (merged cleanly, changed here): upstream added
   `craft = { workspace = true, features = ["automation-agents"] }` only for that `mcp_flag()`
   call. Nothing else in the CLI uses `craft::`, so I removed the line and wrote a `# Pigment:`
   comment in its place. Features stay the same because `photocraft-automation` enables `craft`'s
   `automation-agents` itself. `Cargo.lock` loses one line (`"craft"` from photocraft-cli's
   dependencies). `--locked` builds pass with it. A later upstream merge may conflict on these
   lines; keep them out.
3. **`apps/photocraft-cli/src/document.rs`** (1 hunk): both lines, Pigment's
   `crate::ai::install(&mut h, a)?;` ("`ai.*` commands send only with --allow-ai") and then
   upstream's `GpuPolicy::from_args(&a.gpu)?`.
4. `batch.rs` and `tests/it/cli.rs`: upstream's changes (`ActionStep`, `ActionList::from_file`)
   merged cleanly, as the plan says. `build.rs` still has Pigment's ProductName, CompanyName,
   copyright and file names, and upstream's new `/DELAYLOAD:prntvpt.dll` is in.
   `tests/it/main.rs` is unchanged from 0.5.0. It isolates `CRAFT_MCP_DIR` and `CRAFT_FLAGS_FILE`,
   which is harmless now.

## The version line (decision D3)

- `crates/format/src/brand.rs`: new `pub const UPSTREAM_REVISION: &str = "057297b";`.
  `version_detail()` is `"{crate version} (based on PhotoCraft 0.23.1+057297b)"`, and
  `version_line()` is now `format!("{NAME} {}", version_detail())`, so the two can't drift. There is
  a new test, `the_short_revision_is_the_one_in_upstream_revision`: it does
  `include_str!("../../../UPSTREAM-REVISION")` and checks that the file holds 40 characters and
  starts with `UPSTREAM_REVISION`. The next merge must update both.
- `UPSTREAM-REVISION` = `057297bb0b0872244ac0910e640db8d87e46572f`.
- Tests follow: `apps/photocraft-cli/tests/it/cli.rs` (2 asserts),
  `apps/photocraft/tests/it/command_line_usage.rs` (the app's test, **not compiled yet**: the app
  builds in step 6), and the doc comment in `apps/photocraft/src/launch_args.rs`.
- Docs: `README.md` (the `--version` example), `docs/FORK.md` (the version line in 3 places,
  `UPSTREAM_REVISION` explained beside `UPSTREAM_VERSION`, and step 6 of "Merging a later upstream
  revision" now lists `UPSTREAM_REVISION` and the app's test). FORK.md's "AI agents and MCP" section
  gained a paragraph on the CLI's condition and the missing `craft` dependency, and its
  hand-changed list gained `apps/photocraft-cli/Cargo.toml`. `docs/RELEASE-NOTES-0.5.0.md` and
  `docs/parity/README.md` are history and were not touched.
- CI's smoke-test pattern `grep -qx 'Pigment [0-9][^ ]* (based on PhotoCraft [0-9][^ ]*)'` still
  matches, because `[^ ]*` takes `0.23.1+057297b`.

## Changes to Pigment's own code

The `brand.rs` version line above, the CLI's `Cargo.toml` line, and docs. No other Pigment-only file
changed.

## Tests and checks (CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_STRIP=symbols, -j 4, TMPDIR=/dev/shm/pt, CRAFT_I18N_DIR, CRAFT_FONTS_DIR=craft-fonts at cc9269c)

| Command | Result |
|---|---|
| `cargo build --locked --features heif -p photocraft-cli` | builds |
| `target/debug/pigment-cli --version` / `-V` | `Pigment 0.5.0 (based on PhotoCraft 0.23.1+057297b)` |
| `cargo test --locked --features heif -p photocraft-cli --no-fail-fast` | lib 8 passed; bin 0; `tests/it` **94 passed, 0 failed**: `ai::*` (8), `legacy_pigment::convert_draws_the_smart_filters_of_a_pigment_0_4_document`, `man_and_completions::*` (4), `cli::usage_and_unknown_command`, `cli::top_level_help_version_and_no_arguments`, `cli::mcp_*` included |
| `cargo nextest run --profile ci --locked --features heif -p photocraft-cli --lib --bins --tests` (CI's runner) | **102 passed, 0 skipped** |
| `cargo test --locked -p photocraft-format --lib brand` | 5 passed (incl. the two version tests) |
| `cargo clippy --locked --features heif -p photocraft-cli -p photocraft-format --all-targets -- -D warnings` | clean |
| `cargo fmt -p photocraft-cli -p photocraft-format -- --check`; `rustfmt --check --edition 2024` on `launch_args.rs`, `command_line_usage.rs` | clean |
| `pigment-rebrand.py --check` | no CLI or format file listed (33 lines in all, other steps' files) |
| **CLI smoke test** of `.github/workflows/pigment-ci.yml`, run by hand (the step's script without its `cargo build` line, `RUNNER_TEMP` = scratchpad `up-cli/`) | **every step passes, exit 0**: version pattern, `run --new … --out example.pigment`, convert to PNG and back, `manifest.json` inside, `info` 64×48, the 0.4 fixture `v3-groups.pigment` (info, PNG, native), `v3-tags-info.pigment` File Info (`"title":"A title"`, `"exposure":"1/250 s"`), and the damaged file failing with "This Pigment 0.4 file is damaged: document.json is not valid JSON" |

Note for the next engineer: set the three CARGO_* variables in **every** cargo call. One call here
without `CARGO_PROFILE_DEV_DEBUG=0` started a debug-info rebuild of the whole tree, which cost about
1 GB before I stopped it. A small env file sourced before each command avoids this.

Disk: 11 GB free at the end (`df -h /`).

## Left for the next steps (not done here)

- **Step 6 (app):** `apps/photocraft/tests/it/command_line_usage.rs::version_prints_the_long_version`
  already expects `+057297b`; run it once the app builds. Plan §6 step 6 still says the app prints
  `Pigment 0.5.0 (based on PhotoCraft 0.23.1)`; under D3 it prints `… 0.23.1+057297b`.
- **Step 5 (ui-egui):** About should show `brand::version_line()`, which now carries the revision.
- **Step 8 (FORK.md):** the "Upstream revision" bullet at the top still names `abb30df` (the file
  `UPSTREAM-REVISION` is 057297b now), and "Upstream after the import" is not updated. Those belong
  to step 8, with the hook tables.
- The `prefs_usage`, `scratch_save` and cancel-test remarks from the engine and automation notes
  still apply. Nothing new from the CLI.
