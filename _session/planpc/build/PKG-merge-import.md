# Merge 057297b, step "import" (§6 steps 0 and 1): the setup and the import commit

Branch `claude/pigment-merge-057297b` (from `claude/pigment-photocraft` at `f4e3ffa`), pushed.
Commit **`63f09b6`** "Pigment: import PhotoCraft 057297b (upstream's change alone, hand merges to follow)".
The tree is clean at that commit. No earlier PKG-merge notes existed.

## What I did

1. `git switch -c claude/pigment-merge-057297b claude/pigment-photocraft` (tree was clean).
2. The upstream clone `/home/user/storytold/photocraft` already had both OLD (`abb30df`) and NEW
   (`057297bb0b0872244ac0910e640db8d87e46572f`) objects; no fetch was needed. Patch as FORK.md step 2:
   `git diff --binary OLD NEW -- . ':!docs/brand' ':!.github' ':!.coderabbit.yaml' ':!sonar-project.properties'`
   → `scratchpad/merge/upstream.patch`, 25.7 MB, **1,856 entries** (the plan's number).
3. `git apply --3way --directory=pigment --exclude=pigment/<13 paths of §4.1>`: 59 files with
   conflicts, none failed. Then `git rm` of the 13 (§4.1 list, exactly).
4. **The 25 script-only conflicts** (§4.3 list; it matched the conflict list exactly, 59 = 25 + 34):
   upstream's blob at NEW. Before that I checked that for each of the 25 every line Pigment changed
   against OLD names the product (diff OLD↔f4e3ffa, lines without "pigment"/"photocraft": none).
   **The rebrand script was not run** (the commit is upstream's change alone; step 8 runs it):
   `pigment-rebrand.py --check` now lists 40 files (the plan's number) that would change.
5. **Manifests.**
   - `Cargo.lock`: upstream's blob at NEW, then `cargo metadata` added exactly `pigment-genai`,
     `keyring 3.6.3`, `byteorder 1.5.0`, `security-framework 2.11.1` (the versions Pigment's 0.5.0
     lock had; no `cargo update`). The workspace packages' version lines read 0.5.0. The 6
     "patch … was not used in the crate graph" warnings (egui_demo_lib, egui_inspection,
     egui_system_font_provider, hayro-cmap, hayro-postscript, krilla) are upstream's too: its lock has
     the same 6 `[[patch.unused]]` entries.
   - `crates/ui-egui/Cargo.toml` (1 hunk, a comment): upstream's comment, Pigment's
     `# Pigment: …` + `photocraft-engine = { workspace = true, features = ["testgen"] }` dev-dep kept.
   - `Cargo.toml` (merged cleanly): `version = "0.5.0"` and `pigment-genai = { path = "crates/genai" }`
     survived; `craft-zip` is in workspace deps (pinned at 18ffc07). The five member manifests of §4.2
     keep all Pigment lines (genai deps, `testgen`, `craft-zip`, rustix/pty, `[[bin]] pigment`,
     `pigment-cli`).
   - `docs/scorecard.md`: upstream's blob (regenerate with `cargo xtask scorecard` once xtask builds;
     Pigment's version counted 9 of 203 unread settings, including `general.automatically_check_updates`).
6. **The other 31 hand-changed conflicted files: each conflict hunk resolved to upstream's side**
   (`git merge-file --theirs` on the index stages 2/1/3), so Pigment's hunks in those files that
   merged cleanly stay and only the conflicting ones are upstream's. I checked the result equals the
   marker files with "ours" dropped, for all 31.
   **I chose upstream's side, not markers**, so the commit shows upstream's change alone and the lower
   layers build; the conflict-marker versions (both sides) are saved for the hand merges in
   **`planpc/build/merge-057297b-conflicts/<path>`** (34 files, as `git apply` left them; the
   snapshot carries them). `scratchpad/merge/ours-hunks.txt` lists Pigment's side of each of the 65
   hunks (not in the snapshot: it is under `scratchpad/merge/`, regenerate from the marker files).
7. `rm -rf pigment/target` (19 GB) before the first build. Checked out craft-fonts at
   `cc9269cd8d8258785dac603fba3122e5d2556795` in `/home/user/storytold/craft-fonts` (shallow fetch by
   sha; it was at `b076417`). **Other sessions on this machine now see the new craft-fonts commit**;
   CI still pins `b076417` until step 9 changes `pigment-ci.yml` and `pigment-release.yml`.

Status counts of the import commit: 1,100 M, 231 A, 452 D, 73 R (the plan's numbers). A tree check:
every file where Pigment's tree now differs from NEW is one Pigment had changed against OLD (plus the
3 renames Pigment's changes followed: `automation/tests/it/mcp_live.rs`, `plugins/tests/it/abi.rs`,
`ui-egui/tests/it/flatpak_updates.rs`).

## Builds and tests (CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_STRIP=symbols, -j 4)

| Command | Result |
|---|---|
| `cargo metadata --format-version 1` | ok (adds Pigment's 4 packages to the lock as above) |
| `cargo check -j 4 -p photocraft-format -p photocraft-io -p photocraft-raw` | ok, 1 m 41 s, no warnings from workspace crates |
| `cargo test -j 4 -p photocraft-io legacy_pigment` (TMPDIR=/dev/shm/pt, CRAFT_I18N_DIR, CRAFT_FONTS_DIR at cc9269c) | **70 passed, 2 ignored** (lib); it/ 0 matched. Same as before the merge (FIX-importer.md: 70). |

Not run: fmt, clippy, anything above io (expected not to compile: §5). CI on this push is expected red.
Disk after the builds: 23 GB free (`df -h /`), target ≈ 2 GB.

## TODO: the 34 hand-merge files (Pigment's side lost in the conflict hunks)

Each is now upstream's side in the conflict hunks. "Lost" = Pigment's side of the hunk (see the
marker file); "kept" = Pigment's clean hunks still in the file. Plan §4.2 says how to merge each.

Build and docs
- [x] `Cargo.lock`, `crates/ui-egui/Cargo.toml` — done here.
- [ ] `docs/scorecard.md` — upstream's; regenerate (`cargo xtask scorecard`), `--check` must pass (step 9 at the latest).

Engine (step 2)
- [ ] `crates/engine/src/lib.rs` — lost: the `// Pigment: smart objects of Pigment 0.1–0.4 documents are drawn by the engine.` comment (it sat above `pub mod kys;`, now `keymap_defs`). Kept: `generative`, `legacy_pigment_render`, `ai_cmds`, the Session field. Move the comment to the `legacy_pigment_render` line.
- [ ] `crates/engine/src/shell_commands.rs` — lost: Pigment's link rows `help.github` "Pigment on GitHub", `help.website` "Pigment Releases", `help.artcraftWebsite` "PhotoCraft (upstream project)" (upstream's side of the hunk was only `help.checkForUpdates`; no link row of upstream's came back, no Discord). Kept: the `// Pigment's links` comment, `help.reportIssue`, "About Pigment". Put back the three rows beside upstream's `help.checkForUpdates`.

Automation (step 3)
- [ ] `crates/automation/src/agent_link.rs` — 4 hunks, all upstream's now: Pigment's gate (`mcp_flag()`/`launcher_allows_agents()` false, `SERVER_NAME = "pigment"`), its module doc, test `pigment_reads_neither_the_suite_flag_nor_the_launcher`. Upstream's `agents_allowed_now` calls `agents::mcp_flag()` and `launcher_allows(LAUNCHER_APP_ID)`: **must not** (D1); return `connect_agents` only.
- [ ] `crates/automation/src/live.rs` — lost: Pigment's "Pigment isn't running…" messages and the "Let AI apps use this window" wording in the closed-app branch (now upstream's `integrations.agents.{when_app_closed, read_folder(), write_folder()}` code).

CLI (step 4)
- [ ] `apps/photocraft-cli/src/automation.rs` — lost: `None if !a.headless => PhotocraftMcp::live(live_config(a)?),`. Upstream's condition needs `agents::mcp_flag()`: put Pigment's back.
- [ ] `apps/photocraft-cli/src/document.rs` — lost: `// Pigment: generative AI. …` + `crate::ai::install(&mut h, a)?;` before `GpuPolicy::from_args`. Keep both lines.

ui-egui (step 5)
- [ ] `src/lib.rs` — lost: Pigment's `UPDATE_APP` (icon `io.github.nihalpi1212.pigment.png`, accent, "Pigment contributors", bundle id, `App::new("pigment", "Pigment", "Image editing", "Nihalpi1212/claude")`); now `craft::update::app::App { ..craft::update::suite::PHOTOCRAFT }`. Re-make with `craft::update::app::App` paths. Kept: `pub mod ai_ui`, `legacy_save_prompt` export, the `ai` field (check).
- [ ] `src/app/frame.rs` — lost: Pigment's old frame block with `ai_ui::show(self, &ctx)` after `dialogs::show`. Put the hook after `crate::dialogs::run(self, ui);` in upstream's `ui_body`.
- [ ] `src/canvas.rs` — lost: the old 2,109-line drawing block holding `ai_ui::task_bars(app, ui, xf)` after the crop task bar. Hook goes into `canvas/document_display.rs` after `crate::crop_task_bar::show(app, ui, rect)`.
- [ ] `src/tools/crop_task_bar.rs` — lost: `crate::ai_ui::crop_task_bar_item(app, ui);` in the Generative Expand slot. Re-add as a framework `Button` in that slot (ai-ui-2 for the real item).
- [ ] `src/canvas/canvas_tool_menu/tests.rs` — lost: the expected "Generative Fill…" row in `selection_menus_follow_photoshop_order` (206-line hunk, upstream rewrote the test). The row itself in `canvas_tool_menu.rs` is kept (clean).
- [ ] `src/canvas/start_screen.rs` — lost: Pigment's rail links (Releases, Report an Issue, …, no Discord). Upstream's `StartLink` rail (Home, Learn → getartcraft.com, Website, Discord, GitHub) is in: change `links()`.
- [ ] `src/links.rs` — lost (2 hunks): Pigment's URL constants, `credit`, footer `link_row`, the Help-menu test. Add `TUTORIALS` → Pigment's user guide; test now with `help.checkForUpdates`.
- [ ] `src/dialogs.rs` — lost (5 hunks): `save_prompt`/`save_prompt_body`, legacy-prompt buttons arm, About tab body (blurb, `brand::version_line()`, `links::credit`, `link_row`), `title()` ("About Pigment"), `confirm_command` arms. Upstream's file is the framework-hosted one: About goes to `dialogs/credits.rs::about_info`; the legacy prompt becomes a `StandardPrompt` (§5.2).
- [ ] `src/menus/items.rs` — lost: `|| crate::ai_ui::handles(id)` in `is_live`, `.or_else(|| crate::ai_ui::place_after(&e.id))`. Kept: the `ai_ui::menu_items` extras (clean; must return `Row`s).
- [ ] `src/menus/state.rs` — lost: `help.checkForUpdates` always enabled; `ai_ui::is_enabled` (after the `analysis_ui` check, now `analysis`); `ai_ui::checked` ("Window › Assistant").
- [ ] `src/control/dispatch.rs` — lost: `brand::is_native_extension(ext)` in `open_pcraft_directory` (now upstream's `.pcraft`-only test, `Reply` return).
- [ ] `src/updates_ui.rs` — lost (6 hunks): Pigment's module doc, the releases-link `check`, no check at launch, Pigment's two tests. Now upstream's `Updater` code (`check_at_start` **must never run**).
- [ ] `src/prefs/prefs_ui/agents.rs` — lost (3 hunks): Pigment's module doc, `sync_agent_link` doc, the 101-line page (switch `connectAgents`, Generative AI rows, AI Accounts…). D1: Pigment's switch row + `AgentsPage::mcp_flag(true)` with `agents.intro`/`agents.off` overridden; AI rows into `custom_rows.rs`.
- [ ] `src/prefs/prefs_ui/agents_tests.rs` — lost: `ai_integrations_have_pigments_own_switch_and_no_client_buttons`. Rewrite against the new page.
- [ ] `src/prefs/prefs_ui/fields.rs` — lost (3 hunks, 50/310/148 lines, the old field table): "Open Pigment", "Ask to open Pigment", the `connectAgents` row. Upstream's `rules()`/`SettingRule`; keep `automaticallyCheckUpdates` hidden.
- [ ] `src/i18n/tests.rs` — lost (2 hunks): Pigment's test that the embedded catalogs name neither product (hunk 2), plus context in hunk 1. Re-add.
- [ ] `src/file_dialog/tests.rs` — lost: `.pigment` suggested names (`/pics/layers.pigment`), "Pigment projects" temp dir. Add `pigment` to `file_dialog/filters.rs` (`OPEN_EXTS`, native save filter).
- [ ] `src/tools/type_tool/panels_toggle_tests.rs` — lost: the `// Pigment:` wait `let _ = photocraft_text::shared();` in `bare_app()`. Re-add if `bare_app` still races.
- [ ] `src/panels/actions.rs` — lost: Pigment's strings ("no Pigment equivalent"); script/`trn` only: the rebrand pass covers it (check after step 8).
- [ ] `examples/snapshot.rs` — lost: `"WAYLAND_DISPLAY= pigment"`; script string (step 8).
- [ ] `tests/it/main.rs` — lost: `mod ai;`, `mod ai_assistant;` (`#[cfg(not(target_arch = "wasm32"))]`, `// Pigment:` comments) and `mod legacy_pigment;`. **Pigment's test files `tests/it/{ai,ai_assistant,legacy_pigment}.rs` are in the tree but not compiled until these come back.**
- [ ] `tests/it/flatpak_updates.rs` — lost: Pigment's manifest paths `packaging/linux/flatpak/io.github.nihalpi1212.pigment{.bundle,}.yml` (now `include_str!` of `ai.storyteller.photocraft{.bundle,}.yml`, which will not compile: those files don't exist in Pigment). Keep Pigment's assertions.

Desktop app (step 6)
- [ ] `apps/photocraft/src/main.rs` — lost (4 hunks): `mod updates` comment (drop now: file deleted), Pigment's `--control` doc, the viewport (`with_app_id(APP_ID)`, `.with_title("Pigment")`), Pigment's agents gate block (`mcp_flag()` from Pigment's agent_link, `control_server::start`). No `AgentSwitch::watch`, keep `--finish-update`/self-update unwired, keep `ai_ui::install` (still there, line 571, merged cleanly).
- [ ] `apps/photocraft/src/services.rs` — lost: the 319-line hunk (old open/save filters with `pigment`, `PRESETS_DIR = "Preset Library"`, …) and `check_updates: None, last_update: None` (Pigment: no update service). Keep `PRESETS_DIR`.
- [ ] `apps/photocraft/src/services/tests.rs` — lost (3 hunks): Pigment's presets-folder and no-updater assertions.

Script-only and deleted files, done here: the 25 conflicts are upstream's blob (rebrand in step 8); the
13 deletions are gone (`agent_link.rs` and `updates.rs` of the app: drop their `mod` lines in main.rs
in step 6; `updates_cmds.rs`: `build_info::RELEASES` in step 2).

## Changes to Pigment's code

None beyond the merge resolutions above (the `ui-egui/Cargo.toml` comment). No Pigment-only file was
edited.

## Left for the next steps

Everything of §6 steps 2–9. The next engineer starts from `63f09b6` with a clean tree; target/ holds
only the format/io/raw check and the io test build.
