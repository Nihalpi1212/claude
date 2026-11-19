# Merge plan: PhotoCraft `057297b` into Pigment

For the engineer who does the merge in `/home/user/claude` (branch off `claude/pigment-photocraft`,
which built Pigment 0.5.0 at `f4e3ffa`). Everything below was measured on a trial apply in a scratch
worktree; nothing in `/home/user/claude` was changed. Follow `pigment/docs/FORK.md` › "Merging a later
upstream revision"; this page says what that method meets at this revision.

## 1. NEW

- **NEW = `057297bb0b0872244ac0910e640db8d87e46572f`** (storytold/photocraft `main` on 19 Nov 2026,
  "Merge pull request #15687 from aiongg/ci-strip-opt0", committed 2026-11-18 22:35 −0500).
  `git ls-remote https://github.com/storytold/photocraft main` gave it; FORK.md's `6dbe43e` (18 Nov)
  is older (the branch was force-updated past it).
- OLD = `abb30dff47638eaa38a09de11b60ae8a14baa334` (`pigment/UPSTREAM-REVISION`).
- **Pin NEW and do not chase upstream** during the merge: it moves by thousands of lines a day.
- Upstream's workspace version at NEW is still **0.23.1**, `rust-version` still 1.95, `craft-i18n.rev`
  unchanged (`e56d26244bbac099bfd42e23fb12f78a4be418a7`).

## 2. The numbers

### The patch (FORK.md step 2)

`git diff --binary OLD NEW -- . ':!docs/brand' ':!.github' ':!.coderabbit.yaml' ':!sonar-project.properties'`
(25.7 MB, no binary hunks):

| | files |
|---|---|
| entries in the patch | **1,856** (+132,138 / −281,951 lines; 1,863 files with `.github` etc.) |
| modified | 1,100 |
| added | 231 |
| deleted | 452 (157 of them `assets/icons/*.svg`) |
| renamed | 73 (mostly single-file test binaries moved into `tests/it/` or `tests/global_state/`) |

By area: `crates/ui-egui` 1,176 files (718 M, 158 A, 280 D, 20 R), `crates/engine` 233, `assets` 157,
`crates/io` 45, `crates/compose` 30, `apps/photocraft` 27, `crates/automation` 22, `crates/gpu` 22.
Upstream did **not** touch `packaging/`, `docs/user/`, `assets/app-icon/`, `xtask/src/layers.rs` or
`crates/engine/tests/panic_hunt.rs`.

### The trial `git apply --3way --directory=pigment`

- As written in FORK.md step 3 it **applies nothing**: `git apply` is all-or-nothing, and 13 deletions
  fail ("patch does not apply") because Pigment edited those files. Apply with
  `--exclude=pigment/<path>` for the 13 and then `git rm` them (list in §4.1).
- With the 13 excluded: **1,843 entries applied, 1,784 of them cleanly, 59 files with conflicts
  (104 conflict hunks), 13 failed** (all upstream deletions of files Pigment changed). No hunk failed
  for a rename: the 3 upstream renames of files Pigment changed (`crates/automation/tests/mcp_live.rs`,
  `crates/plugins/tests/abi.rs`, `crates/ui-egui/tests/flatpak_updates.rs`, each into `tests/it/`) were
  followed; Pigment's own renames (packaging, WiX, icons) and deletions (`docs/brand`, icons, the
  desktop file) met no upstream change.
- The 59 conflicted files: 25 are files whose only Pigment change is the rebrand script's (take
  upstream's, re-run the script), 34 are hand-changed (§4). Conflict hunks per file are in §4.
- `pigment-rebrand.py --check` on the trial tree: 40 files would change (new upstream strings).

**"Applied cleanly" understates the work.** Upstream moved its interface onto the craft framework
(`craft::ui`, `craft::automation`, `craft::settings`, `craft::update`...). Many ui-egui hooks merged
textually but now call modules and types that no longer exist (§5). Expect compile errors in files that
merged cleanly.

### Crates and dependencies

- **No crate added or removed** in the workspace (`crates/*`, `apps/*`, `xtask` the same 30 manifests).
  Pigment's `crates/genai` (`pigment-genai`) stays the only extra one.
- **Workspace `Cargo.toml`** (merged cleanly; review):
  - `craft-ui`, `craft-flags`, `craft-ai-agents` leave `[workspace.dependencies]`; the framework comes
    through one facade, **`craft`** (craft-libs `18ffc07519b15f5ef39e752aa0f405261fec8ebb`,
    `default-features = false`; crates enable features: ui-egui uses `ui, layers, color-ui, draw,
    imaging, window, keymap, automation, theme-store, …, dialogs, update, automation-agents`).
  - **craft-libs pin `e2dc681a3` → `18ffc07519b15f5ef39e752aa0f405261fec8ebb`** for every craft-* crate,
    except **`craft-svg` pinned separately at `7b8c1eccea0c695a495ab279c9523e6efcc9b8be`**.
    New workspace deps: `craft-plist`, `craft-metadata`.
  - `craft-update` features `["egui"]` → `["ui"]`.
  - **egui fork `6d518fc7…` → `e9711ca9b69772f875ae0d1cef1977ff8c16234d`** (still egui 0.37.0; must
    equal `craft::egui_fork::REV`, checked by the new `cargo xtask egui-fork`). winit pin unchanged.
  - `[patch.crates-io]` gains `krilla`, `hayro-cmap`, `hayro-postscript`, `linesweeper` from craft-libs.
  - New `[workspace.metadata.cl]` (craft-libs' `tools/cl`), ~30 `[profile.test.package.craft-*]`
    opt-levels (0/1), `wasm-release` now thin LTO with 16 codegen units.
  - `rust-version` stays **1.95**, edition 2024 (craft-libs too). Pigment's CI pins 1.97.0: fine.
- **`.cargo/config.toml`**: new `[target.'cfg(all(windows, target_env = "msvc"))'] rustflags`
  delay-loading `opengl32.dll` (needs `delayimp.lib`; affects Pigment's Windows release build).
- **`Cargo.lock`** (2 conflict hunks): 922 → 999 packages. New: the framework crates (`craft`,
  `craft-automation`, `craft-behavior`, `craft-browse`, `craft-cloud-ui`, `craft-color-ui`, `craft-dds`,
  `craft-dialogs`, `craft-draw`, `craft-font-catalog`, `craft-font-manager`, `craft-font-store`,
  `craft-host`, `craft-imaging`, `craft-ipp`, `craft-keymap`, `craft-layers`, `craft-menu`,
  `craft-pages`, `craft-platform`, `craft-plist`, `craft-quit`, `craft-review`, `craft-settings`,
  `craft-table`, `craft-text`, `craft-theme`, `craft-theme-editor`, `craft-theme-store`, `craft-time`,
  `craft-timeline`, `craft-ui-*`, `craft-win32`, `craft-window`), `icu_calendar`, `icu_collator`,
  `icu_datetime`, `icu_time`, `hypher`, `inventory`, `libtest-mimic`, `multiversion`,
  `unicode-linebreak`, `webpki-roots` (through ureq), …; gone: `paste`, `pulp`, `raw-cpuid`,
  `icu_casemap`, `fax_derive`, `reborrow`. Bumps that touch Pigment's own deps: `ureq` 3.5.0 → 3.5.1
  (`ureq-proto` 0.6 → 0.7), `sha2` gains 0.11 beside 0.10, `zip` 9.1 → 9.5, `rmcp` 3.6 → 3.9, `uuid`,
  `toml`. `craft-flags` and `craft-ai-agents` stay in the lock (pulled by `craft-automation`).
  `keyring` and its platform deps are Pigment's and are not in upstream's lock.
- **System libraries: none new.** Linux CI packages unchanged (`libxkbcommon-dev libwayland-dev
  libx11-dev libxrandr-dev libxi-dev libgl1-mesa-dev libgtk-3-dev mesa-vulkan-drivers libvulkan1`).
- **craft-i18n.rev: unchanged** (`e56d262…`; the Flatpak manifests need nothing).
- **craft-fonts commit CI pins: `b076417b5880bd4154bd22f00695b1d28c6bea83` →
  `cc9269cd8d8258785dac603fba3122e5d2556795`** (upstream's ci.yml, release.yml, freebsd.yml). Change
  it in `.github/workflows/pigment-ci.yml` (line 87) and `pigment-release.yml` (`CRAFT_FONTS_REF`).

## 3. Strategy

1. Merge in a branch of `claude/pigment-photocraft` at **NEW only**, as one upstream-import commit
   (the patch applied, with the 13 deletions and the 25 script-only conflicts resolved mechanically),
   then one commit per step of §6. The first commit is the reference diff against upstream for review.
2. **Script-only files take upstream's version**: 58 upstream-changed files carry nothing of Pigment
   but what `scripts/pigment-rebrand.py` writes (verified: the script run on the import `15b8ea5`
   reproduces Pigment's file byte for byte). For their 25 conflicts: `git checkout --theirs` (or
   upstream's blob at NEW), then the script. 11 of them upstream deleted: `git rm`.
3. **Hand-changed files** (84 that upstream also changed; 34 conflicted, 2 deleted upstream, 48 merged
   textually): resolve per §4. The rule is FORK.md's step 4: Pigment's names, ids, links, folders,
   update behaviour and agents gate; upstream's everything else. Where upstream replaced the code a
   hook sat in (the UI moved to the craft framework), **re-place the hook on the new code** rather
   than keep the old block.
4. **Port Pigment's own UI to the framework APIs** instead of resurrecting the deleted ui-egui modules
   (`widgets`, `ViewXform`, the old dialog list): `ai_ui/*` and `dialogs/legacy_save_prompt.rs` (§5).
   Pigment's engine, genai, importer and CLI code need almost nothing.
5. **Keep Pigment's no-network and own-folders promises against the framework**, which now reaches
   further by default: the update checker, the ArtCraft Launcher switch, the suite theme folder and the
   framework's own words (§5.3, §7).
6. Re-run the rebrand pass last, after all code compiles, then the checks of FORK.md step 5.

## 4. Hand-merge list

Columns: Pigment's change (`15b8ea5..claude/pigment-photocraft`), upstream's (`OLD..NEW`), trial result.

### 4.1 Upstream deleted files Pigment changed (13: `git rm` each)

| File | Pigment had | Where it went upstream / what to do |
|---|---|---|
| `apps/photocraft/src/agent_link.rs` | hand: launcher watch marked never wired | Replaced by `craft::automation::agents::{AgentLink, AgentSwitch}` built in `main.rs`. Delete; Pigment's gate moves to `main.rs` (§4.2). |
| `crates/engine/src/cmd/updates_cmds.rs` | hand: `RELEASES` → Pigment's releases | `help.checkForUpdates` is now a shell command (`shell_commands.rs`) handled by `ui-egui/src/updates_ui.rs`; `RELEASES` moved to **`crates/engine/src/build_info.rs`** (used by `error.rs`). Delete; set `build_info::RELEASES` to `https://github.com/Nihalpi1212/claude/releases`. |
| `apps/photocraft/src/updates.rs` | script | Deleted upstream (checker is now craft-update's `Updater` in `updates_ui.rs`). Delete, and drop `mod updates;` + its comment from `main.rs`. |
| `apps/photocraft/src/control_server.rs` | script (`pigment:` log line) | Moved into `craft::automation` (server). Delete. |
| `apps/photocraft/src/screen_color.rs` | script | Framework `ScreenColorPicker::new(&mut app.screen_pick, "PhotoCraft")` in ui-egui; the script rebrands that string. Delete. |
| `apps/photocraft/tests/mac_menu_appkit.rs` | script | Moved to craft. Delete. |
| `crates/ui-egui/examples/cursor_bench.rs`, `src/canvas/tool_cursor.rs`, `src/dialogs/credits/ui_tests.rs`, `src/input/single_line_drag.rs`, `src/menus/menu_nav/tests.rs`, `src/widgets/field_wheel.rs`, `src/widgets/text_field_menu.rs` | script (strings naming the product) | Moved into the framework. Delete. |

### 4.2 Hand-changed files upstream also changed

Build and legal files

| File | Pigment | Upstream | Trial | How to merge |
|---|---|---|---|---|
| `Cargo.toml` | +3/−1 (`pigment-genai`, version 0.5.0) | +168/−54 (§2) | clean | Check `version = "0.5.0"` (or 0.6.0-dev) and `pigment-genai` survived. |
| `Cargo.lock` | +171/−38 (genai, keyring) | +1,601/−520 | 2 hunks | Take upstream's lock, then `cargo metadata` / `cargo check` (not `--locked`) to add `pigment-genai`, `keyring` and its deps; never `cargo update`. Commit, then CI's `--locked` holds. |
| `crates/ui-egui/Cargo.toml` | +4 (genai, `testgen` dev-dep) | +16/−19 (`craft` facade features) | 1 hunk (a comment) | Keep `photocraft-engine = { …, features = ["testgen"] }` under dev-deps with upstream's comment. |
| `crates/automation/Cargo.toml`, `crates/engine/Cargo.toml`, `crates/io/Cargo.toml`, `apps/photocraft-cli/Cargo.toml`, `apps/photocraft/Cargo.toml` | genai dep, `testgen`, `craft-zip`, rustix/pty, `[[bin]] pigment` | craft-flags/ai-agents → `craft` | clean | Verify each Pigment line; `apps/photocraft-cli` still needs `rustix`/`pty`. |
| `apps/photocraft/build.rs`, `apps/photocraft-cli/build.rs` | Windows resources | +7/−4 (delay-load comments) | clean | Check ProductName/CompanyName still Pigment's. |
| `crates/ui-egui/build.rs` | +99/−5 `rebrand_catalog` | −30 (`deflate_egui_fonts` gone) | clean | Fine; the framework now reads its words from the same catalogs (`i18n::framework_i18n`), so the catalog rebrand covers framework rows too. |
| `NOTICE`, `ATTRIBUTION.md` | Pigment lines | +125 (jpeg-encoder 0.6.1 notices, `licenses/jpeg-encoder-0.6.1/`), −30 | clean | Keep both. |
| `docs/scorecard.md` | regenerated (+settings counts) | regenerated | 2 hunks | Take upstream's, run `cargo xtask scorecard`, commit the output; `--check` must pass. |

Engine, io, automation, CLI

| File | Pigment | Upstream | Trial | How to merge |
|---|---|---|---|---|
| `crates/engine/src/lib.rs` | `pub mod legacy_pigment_render`, `generative`, `ai_cmds`, Session field | `kys` → `keymap_defs` | 1 hunk | Drop `pub mod kys;`, keep `pub mod keymap_defs;`; move Pigment's comment to the `legacy_pigment_render` line. |
| `crates/engine/src/shell_commands.rs` | 4 links, no `help.discord`, "About Pigment" | `window.theme.*` gone (framework); `help.checkForUpdates` added here; `view.screenMode.cycleBack` | 1 hunk | Keep Pigment's four link rows and add `("help.checkForUpdates", "Check for Updates…", &["Help"], None)`. |
| `crates/engine/src/cmd.rs`, `cmd/actions_cmds.rs` (`recorded()` at l. 597), `jobs.rs` (`VIEW_EDITS`, `import_options`), `cmd/file_cmds/open.rs`, `cmd/smart_cmds.rs`, `cmd/smart_cmds/rendering.rs`, `error.rs` | AI and importer hooks | refactors (+290/−273 actions, +198/−26 rendering) | clean | All anchors exist at NEW and the hooks survived. `refresh_layer_with` mirrors the new `refresh_layer` (unapplied-filter check); re-read it. Run `ai_cmds` tests and the panic hunt. |
| `crates/engine/src/cmd/file_cmds.rs`, `file_cmds/batch_run.rs`, `file_cmds/paths.rs`, `print_cmds.rs` (+tests), `notes_cmds.rs`, `prefs/validate.rs` | `.pigment` extension, `HIDDEN_UNTIL_IMPLEMENTED` += `general.automaticallyCheckUpdates` | features | clean | Grep for new `.pcraft`-only lists or messages upstream added (§6 step 8). |
| `crates/io/src/lib.rs`, `pattern_map.rs`, `psd_export.rs`, `svg/tests.rs` | importer route, `.pigment` in messages | small | clean | Nothing. |
| `crates/automation/src/agent_link.rs` | gate: `mcp_flag()`/`launcher_allows_agents()` false, `SERVER_NAME = "pigment"` | −333: connection file, token file, probe, switch → `craft::automation::agents`; `agents_allowed_now` = `agents::agents_allowed(agents::mcp_flag(), agents::launcher_allows(LAUNCHER_APP_ID), connect_agents)` | 4 hunks | Take upstream's file; make `agents_allowed_now` return `integrations.connect_agents` (or call `agents::agents_allowed(false, false, …)`); keep Pigment's test `pigment_reads_neither_the_suite_flag_nor_the_launcher`. Find where the MCP server name now lives (craft automation, `serverInfo`) and keep `pigment`. |
| `crates/automation/src/live.rs` | Pigment wording | `integrations.agents.{when_app_closed, read_folder(), write_folder()}`; `Connection` from craft | 1 hunk | Take upstream's code; the script rebrands "PhotoCraft isn't running"; keep Pigment's "Let AI apps use this window" in the timeout message. |
| `crates/automation/src/security.rs`, `server.rs`, `args.rs`, `workspace.rs`, `lib.rs`, `tests/it/main.rs`, `tests/it/mcp.rs` | `PIGMENT_CONTROL_TOKEN*`, help text, `pub mod genai`, `mod legacy_pigment` | token/server code moved to craft (−122 security) | clean | Check no `PHOTOCRAFT_CONTROL_*` name came back: craft's `args` builds names from a prefix (`"PHOTOCRAFT"`); if photocraft code starts passing a prefix, pass `"PIGMENT"`. |
| `apps/photocraft-cli/src/automation.rs` | live MCP whenever not `--headless` | live only with `craft::automation::agents::mcp_flag()` | 1 hunk | Keep Pigment's condition (`None if !a.headless =>`): Pigment never has the flag. |
| `apps/photocraft-cli/src/document.rs` | `crate::ai::install(&mut h, a)?` | `GpuPolicy::from_args(&a.gpu)?` | 1 hunk | Both lines. |
| `apps/photocraft-cli/src/batch.rs`, `tests/it/cli.rs` | `.pigment`, version line tests | small | clean | Nothing. |
| `apps/photocraft-web/src/web.rs` | `.pigment` in `OPEN_EXTS` | +113/−101 | clean | Nothing. |
| `crates/compose/src/pattern.rs` | `pigment:` log prefix | small | clean | Nothing. |

Desktop app

| File | Pigment | Upstream | Trial | How to merge |
|---|---|---|---|---|
| `apps/photocraft/src/main.rs` | no update check, no `--finish-update`, Pigment's agents gate, viewport title/app id, `ai_ui::install` | −286/+154: `window_policy::apply`, `AgentSwitch::watch(LAUNCHER_APP_ID, …)`, `AgentLink::{from_launch,new}`, `craft_update::self_update::finish` still called | 4 hunks | Take upstream's structure; **do not create `AgentSwitch::watch`** (it polls the ArtCraft Launcher's files): use `AgentSwitch::fixed(false, false)` or none; keep `--finish-update` unwired; keep `ai_ui::install(&mut app, &dir)` after background jobs; drop `mod updates`. |
| `apps/photocraft/src/services.rs` | `PRESETS_DIR = "Preset Library"`, `OPEN_EXTS` with `pigment`, no update service | −336: open/save filters moved to `ui-egui/src/file_dialog/filters.rs`; settings through `craft::settings::SettingsStore` (`config.toml`); `check_updates`/`last_update` gone; new `agent_automation(&AgentSettings)` | 2 hunks (one of 319 lines) | Take upstream's; keep `PRESETS_DIR` (upstream writes `d.join("Presets")` again: the case clash with 0.4's `presets`); put `pigment` into `file_dialog/filters.rs`. |
| `apps/photocraft/src/services/tests.rs` | presets folder, no updater | −358 | 3 hunks | Take upstream's; re-add Pigment's assertions that fit (Preset Library). |

Interface (ui-egui): mostly re-placing hooks on the framework

| File | Pigment | Upstream | Trial | How to merge |
|---|---|---|---|---|
| `src/lib.rs` | `pub mod ai_ui`, `pub use dialogs::legacy_save_prompt`, `UPDATE_APP` (Pigment ids, icon, repo), the `ai` field | −317/+230; `UPDATE_APP` is `craft::update::app::App { ..craft::update::suite::PHOTOCRAFT }`; `widgets`, `screenshot` modules gone | 1 hunk | Keep Pigment's `UPDATE_APP` with `craft::update::app::App` paths. Check the `ai` field. |
| `src/app.rs` | `ai: Default::default()` | +123/−111 | clean | Survived (l. 228). |
| `src/app/frame.rs` | `ai_ui::show(self, &ctx)` after `dialogs::show` | `ui_body` draws `AppShell…show(ui, self)`, then `jobs_ui::dialog`, `updates_ui::show`, `dialogs::run(self, ui)` | 1 hunk | Take upstream's; put the hook right after `crate::dialogs::run(self, ui);`. |
| `src/app/commands.rs` | `ai_ui::gate` in `run_command_at_depth` | −51/+34 | clean | Survived (l. 74). |
| `src/app/files.rs` | `save_in_place` → `legacy_save_prompt::intercept`; `save_in_place_unasked` | −67/+37 | clean | Survived; the prompt itself must be ported (§5.2). |
| `src/canvas.rs` | `ai_ui::task_bars(app, ui, xf)` after `crop_task_bar::draw` | −3,004: drawing moved to `canvas/document_display.rs`; no `ViewXform` | 1 hunk | Take upstream's; call the hook in `canvas/document_display.rs` after `crate::crop_task_bar::show(app, ui, rect)` (active document only), with the new view type. |
| `src/tools/crop_task_bar.rs` | `ai_ui::crop_task_bar_item` in the Generative Expand slot | framework `TaskBar` (`craft::ui::canvas_controls`), `Button`/`ToggleButton`; slot comment kept (l. 47) | 1 hunk | Take upstream's; add Generative Expand as a framework `Button` in that slot. |
| `src/canvas/canvas_tool_menu.rs` (+`tests.rs`) | "Generative Fill…" row in `SELECTION_MENU` | −845/+817 / −1,237/+540 | clean / 1 hunk | Row survived (l. 640); re-add the expected row in `selection_menus_follow_photoshop_order`. |
| `src/canvas/start_screen.rs` | Pigment's links, no Discord | framework `StartLink` rail: Home, Learn (`TUTORIALS` getartcraft.com), Website, Discord, GitHub | 2 hunks | Take upstream's; `links()` gets Learn (Pigment's guide), Report an Issue, Pigment on GitHub, Pigment Releases, PhotoCraft (upstream). |
| `src/links.rs` | Pigment's URLs, `credit`, footer links, Help-menu test | −75; adds `TUTORIALS` | 2 hunks | Keep Pigment's constants and add `TUTORIALS` → Pigment's user guide (tag `pigment-v<version>`); keep `credit` if About can show it (below); keep the Help-menu test, now with `help.checkForUpdates`. |
| `src/dialogs.rs` | About (version line, credit), `save_prompt*` arms, `ROUTES`, `file_command`, legacy buttons | −1,346/+618: dialogs hosted by `app.framework.dialogs` (`StandardPrompt`, `HostedParamDialog`, `take_results`, `TAKERS`); `title`, `command_body`, `confirm_command`, `ROUTES`, `file_command` gone; About is `dialogs/credits.rs::about_info` (`AboutInfo`, `AboutLink`, `HostedAbout`) | 5 hunks | Take upstream's file. Pigment's About goes into `credits::about_info`: name "Pigment", blurb, `brand::version_line()`, links (Pigment's four), no `.community(Discord)`, credit line (as blurb or `built_with`). The legacy prompt becomes a `StandardPrompt` (§5.2) registered where upstream registers prompt rows. |
| `src/menus/items.rs` | `is_live` asks `ai_ui::handles`; extras `ai_ui::menu_items`; `ai_ui::place_after` | `MenuItem` → `craft::menu` `Row` (`Row::new(path, id, label)`, `.command.id`); `menu_rows` | 2 hunks | Keep the three hooks; `ai_ui::menu_items` must return `Row`s. |
| `src/menus/state.rs` | `help.checkForUpdates` always enabled; `ai_ui::is_enabled`, `ai_ui::checked` | `analysis_ui` → `analysis`; shortcut-only rule | 3 hunks | Keep Pigment's three blocks with upstream's renames. |
| `src/menus/invoke.rs` | `ai_ui::menu` in `invoke_early_commands` | −253/+171 | clean | Survived (l. 176). |
| `src/control.rs` | `handle` runs `dispatch` inside `ai_ui::as_agent` | `handle` returns `craft::automation::Reply` (was `Outcome`) | clean | Survived (l. 114); `as_agent`'s generic return now `Reply`. |
| `src/control/dispatch.rs` | `brand::is_native_extension` | `Outcome` → `Reply` | 1 hunk | Upstream's signature, Pigment's condition. |
| `src/jobs_ui.rs` | `on_job_event` first; `ai.*` jobs never modal | −272/+120 | clean | Both survived (l. 619, 917). `dialog` now takes `ui`. |
| `src/home_recent_ui.rs` | `is_native_extension` | −1,038/+262 | clean | Survived (l. 419). |
| `src/updates_ui.rs` | link to releases; no check at launch | rewritten on `craft::update::updater::Updater` (`check_now`, `check_at_start`, `read_last_update`) | 6 hunks | Take upstream's shape; `check` opens `build_info::RELEASES` (via `links::open`) and returns `{"status":"opened"}`; `tick` never calls `check_at_start` (may keep `read_last_update`, a local file); keep Pigment's two tests. |
| `src/prefs/prefs_ui/agents.rs` | Pigment's switch rows, Generative AI rows, AI Accounts… button | the page is the framework's `craft::automation::ui::agents::AgentsPage` drawn from `custom_rows.rs`; `sync_agent_link` drives `AgentLink` | 3 hunks | Take upstream's; Pigment's switch (`connectAgents`) and the AI rows go into `custom_rows.rs` around `AgentsPage` (§5.3). |
| `src/prefs/prefs_ui/agents_tests.rs` | tests of Pigment's switch | −169/+73 | 1 hunk | Rewrite against the new page. |
| `src/prefs/prefs_ui/fields.rs` | labels "Open Pigment", "Ask to open Pigment", `connectAgents` row | −611/+237: `rules()`/`SettingRule`, `spelled()` | 3 hunks | Take upstream's; the closed-app labels are the framework's (`{app}` from the host name). |
| `src/i18n/tests.rs` | test that embedded catalogs name neither product | −69 | 2 hunks | Keep Pigment's test. |
| `src/file_dialog/tests.rs` | `.pigment` suggested names | −759/+599 | 2 hunks | Upstream's tests with `.pigment`; add `pigment` to `file_dialog/filters.rs` (`OPEN_EXTS` and the native save filter). |
| `src/tools/type_tool/panels_toggle_tests.rs` | `bare_app()` waits for the font scan | −102/+28 | 1 hunk | Keep the `// Pigment:` line if `bare_app` still exists; drop it if upstream fixed the race. |
| `src/panels/actions.rs` | string | −2,290/+319 | 2 hunks | Upstream's; script/`trn` string. |
| `examples/snapshot.rs` | `pigment` string | +48/−22 | 1 hunk | Upstream's + script. |
| `tests/it/main.rs` | `mod ai; mod ai_assistant; mod legacy_pigment;` | test modules regrouped | 2 hunks | Upstream's list plus Pigment's three. |
| `tests/it/flatpak_updates.rs` (renamed from `tests/`) | Pigment's Flatpak permissions | −27 | 1 hunk | Keep Pigment's assertions (no `org.freedesktop.Flatpak`, no launcher folder). |

### 4.3 Script-only files (58): take upstream's, run the script

Conflicted (25): `crates/engine/src/cmd/file_cmds/export.rs`, `cmd/swatch_cmds.rs`, `preset_store.rs`,
`crates/raw/src/shared.rs`, and in `crates/ui-egui/src/`: `dialogs/file_ui/print.rs`,
`dialogs/new_doc_ui.rs`, `dialogs/new_doc_ui/tests.rs`, `dialogs/rasterize_prompt.rs`,
`dialogs/screen_picker.rs`, `gpu_status.rs`, `i18n/live_tests.rs`, `menus/native_menu.rs`,
`menus/native_menu/tests.rs`, `menus/tests.rs`, `panels.rs`, `panels/actions/tests.rs`, `panels/brand.rs`,
`panels/title_bar.rs`, `prefs/kys_import.rs`, `prefs/kys_import/tests.rs`, `prefs/prefs_ui/save.rs`,
`prefs/prefs_ui/shortcut_set_tests.rs`, `prefs/prefs_ui/shortcuts.rs`, `smart_svg_ui.rs`,
`tools/type_tool/canvas_tests.rs`.
Merged cleanly (22): `AGENTS.md`, `apps/photocraft/src/{linux_libs,tablet}.rs`,
`crates/automation/tests/it/mcp_live.rs` (renamed), `crates/engine/src/cmd/{atn_cmds,automate_cmds,
automate_cmds/tests,file_cmds/export_clut_cube_header_tests,layer_menu_cmds,smart_svg_cmds}.rs`,
`crates/engine/src/shortcut_sets.rs`, `crates/engine/tests/it/{corpus_atn,shortcut_sets}.rs`,
`crates/io/src/{psd_import/tests,svg}.rs`, `crates/plugins/tests/it/abi.rs` (renamed),
`crates/ui-egui/examples/type_bench.rs`, `crates/ui-egui/src/{dialogs/open_prompt,notices,os_window,
prefs/prefs_ui/startup,theme/tests}.rs`. Deleted upstream (11): §4.1.

The other 83 hand-changed and 19 script-only files Pigment changed were not touched upstream.

## 5. API changes Pigment's own code must follow

Checked by resolving every path Pigment's own files use against OLD and NEW (and craft-libs at
`18ffc07`). **Engine, genai, importer, CLI: nothing breaks** — every upstream function they call exists
at NEW with the same name: `active_layer_of`, `allocation::{check_dense, checkpoint}`,
`commands::{find, list_entry, mask_at_depth, CommandSpec}` (`CommandSpec` fields unchanged),
`document_preset_cmds::MAX_RESOLUTION`, `extra_cmds::background_to_layer_for_mask`,
`file_cmds::{import, write_file_info}`, `image_util::parse_size`, `jobs::{JobCtx, run}`,
`layer_copy_cmds::layered`, `layer_place::{Place, insert_new}`, `pixels_mut`,
`smart_cmds::{refresh, refresh_layer}`, `photocraft_algo::segment::{Rng, sky}`,
`photocraft_compose::{flatten_to_surface, render, thumbnail, masks::*}`, `photocraft_format::zip`,
`photocraft_io::import_with`, `photocraft_raster::{Interrupt, stored_tiles_bytes, from_rgba}`; the
importer's anchors (`route`, `import_stages`, `import_preflight`, `import_options`,
`import_result_for_open`, `open_with_options`, `open_bytes_with_options`, `untrusted`, `trusted_local`)
too. Upstream has **no generative commands of its own** (no `ai.*` ids, no craft-ai use), so FORK.md's
alias-or-hide decision does not arise; craft's `ai`/`ai-core` features stay off.

### 5.1 Gone or moved, used by `crates/ui-egui/src/ai_ui*` (≈5,200 lines) and its tests

| Pigment uses | At NEW | Use instead |
|---|---|---|
| `crate::widgets::{primary_button, secondary_button, hairline}` (accounts, assistant, describe, generate, ai_ui) | `widgets` module deleted | `craft::ui::buttons::Button` (roles) and the framework's separators/primitives (`craft::ui::primitives`, `craft::ui::style`) |
| `crate::widgets::task_bar` (`ai_ui/task_bar.rs`) | deleted | `craft::ui::canvas_controls::TaskBar` (as `tools/crop_task_bar.rs`) |
| `crate::canvas::ViewXform` (`ai_ui.rs`, `task_bar.rs`) | gone | the document view of `canvas/document_display.rs` (`space.view`, the tile `rect`) |
| `app.ui.crop_rect` | gone | `crop_task_bar::eligible` / `app.canvas_tools.crop.tool.frame()` |
| `app.ui.dialogs` (`.len()`, `.is_empty()`, assistant, task bar) | gone | `app.dialog_open()`, `app.framework.dialogs` (`DialogHost`) |
| `crate::menus::MenuItem` | gone | `craft::menu` `Row` (`Row::new(path, id, label).enabled(…)`) |
| `photocraft_ui_egui::control::Outcome` (tests/it/ai.rs) | gone | `control::Reply` (= `craft::automation::Reply`, variants `Done`, `AfterInput`) |
| `craft_ui::ComboBox` (`assistant.rs`) | `craft-ui` no longer a direct dep | `craft::ui::choice::Select` or egui's `ComboBox` |
| `crate::analysis_ui` (hooks beside Pigment's) | renamed | `crate::analysis` |

Still there: `app.automation_input`, `app.last_canvas_rect`, `app.run`, `app.sync_views`,
`app.with_document` (now in `file_dialog.rs`), `app.save_dialog_flow`, `app.services.open_url`,
`app.ui.{status, status_error, panels, task_bar_shown, tool, text_edit}`.
Raw `egui::Window`s still work, but they no longer sit on the dialog host: modality and Esc against
hosted dialogs must be checked, and `xtask panel-commands`' allow-list is now empty (click handlers
must dispatch commands).

### 5.2 `dialogs/legacy_save_prompt.rs`

Uses `crate::dialogs::dont_show_again`, `crate::state::DialogKind`, `app.ui.open_dialog`,
`app.ui.dialogs`, `crate::widgets::{DialogButton, ButtonRole, dialog_buttons}` and the `dialogs.rs`
arms (`save_prompt*`, `ROUTES`, `file_command`): all gone. Rewrite as a framework prompt, as upstream's
own prompts are (`dialogs/alerts.rs`, `delete_layer_prompt.rs`): `StandardPrompt::custom(msg)
.title(..).button(Save).button(Save As…).button(Cancel).dont_show_again().tag(..)` opened on
`app.framework.dialogs`, its answer taken in `prompts_take` rows; the "Don't show again" key goes into
`dont_show_again_keys()`. Keep `intercept` / `save_in_place_unasked` / `replay_save` as they are.
`crates/ui-egui/tests/it/legacy_pigment.rs` drives it through `ui.*`: re-check the control names.

### 5.3 Agents, updates, settings: the framework's defaults to override

- `photocraft_automation::agent_link::{CONNECTION_FILE, TOKEN_FILE, SERVER_NAME, PROBE_TIMEOUT,
  Connection, read_connection, …}` → `craft::automation::agents::*` (`Connection::new` takes the app
  string). `mcp_flag()` / `launcher_allows_agents()` → `agents::mcp_flag()` /
  `agents::launcher_allows(id)`; Pigment must call neither. `Integrations.read_root/write_root/
  when_app_closed` → `Integrations.agents: AgentSettings` (`read_folder()`, `write_folder()`).
- **Agents page**: `AgentsPage::new(..).mcp_flag(false)` (Pigment's case) shows only Allow Agent
  Control and Control Port: no switch, folders or When Closed. With `.mcp_flag(true)` it shows them
  but its words say "ArtCraft Launcher › Settings › AI agents" (`agents.intro`, `agents.off`, English
  defaults in craft-libs `automation/src/ui/agents/words.rs`). Decide: draw Pigment's switch row plus
  the framework page with `mcp_flag(true)` and override those two words (craft-i18n rows or the
  framework's `Overrides`), or keep Pigment's own rows. The AI Accounts… button and "Allow agents to run
  AI commands" go into `custom_rows.rs`.
- **Updates**: `craft_update::*` → `craft::update::*`; `Updater::check_at_start` (once per launch when
  the hidden pref is on) must never run.
- **Preferences** now live in `config.toml` through `craft::settings::SettingsStore<SavedPrefs>`
  (`prefs::store_options(dir)`, `Location::Dir(config_dir)`); `preferences.json` is imported while no
  `config.toml` exists and never written again. `SavedPrefs::APP_ID = "photocraft"` matters only for
  `Location::Default`/portable: keep passing Pigment's folder. Pigment 0.5's `preferences.json`
  (with `connectAgents`, `controlPort`, `readRoot`) must import.
- **Suite theme folder**: `framework.rs` opens `SuiteWatch` on `SuiteDir::resolve(false)` =
  `~/.config/ArtCraft/themes` (`%LOCALAPPDATA%\ArtCraft\themes`, `~/Library/Application Support/
  ArtCraft/themes`) or `$CRAFT_SUITE_DIR`. That reads and writes ArtCraft's folder: use
  `SuiteDir::at(<Pigment settings>/Themes)` (or `resolve(true)`, in memory).
- **Host identity**: `Host::builder(AppInfo { id: "photocraft", name: "PhotoCraft", .. })` in
  `app/framework.rs`: the framework shows `name` ("When {app} is closed", alerts); the script rebrands
  it; leave `id`.

## 6. Order of work (each step ends with something that builds)

0. **Set up.** `git switch -c claude/pigment-merge-057297b claude/pigment-photocraft`. Fetch NEW
   (`git fetch --depth=1 origin 057297bb0b0872244ac0910e640db8d87e46572f` in a clone; the diff needs
   only OLD's and NEW's trees). Make the patch as FORK.md step 2.
1. **Import commit.** `git apply --3way --directory=pigment --exclude=pigment/<13 paths of §4.1>
   upstream.patch`; `git rm` the 13; for the 25 script-only conflicts take upstream's blob; resolve the
   three manifest conflicts (`Cargo.lock` → upstream's, `crates/ui-egui/Cargo.toml`, and check
   `Cargo.toml`); commit with the conflict markers of the 34 hand files still in (or resolved to
   upstream's side with a TODO list), so review sees upstream's change alone. **Builds:**
   `cargo metadata` and `cargo check -p photocraft-format -p photocraft-io -p photocraft-raw` (L0–L3 and
   the 0.1–0.4 importer). Run `cargo test -p photocraft-io legacy_pigment`.
2. **Engine.** `lib.rs`, `shell_commands.rs`, `build_info::RELEASES`, then the clean hooks. **Builds:**
   `cargo test -p photocraft-engine --features testgen` (incl. `ai_cmds::tests`) and the panic hunt
   (`--test panic_hunt -- --ignored`).
3. **genai + automation.** `agent_link.rs`, `live.rs`, `security.rs`/`args.rs` env names, `genai.rs`.
   **Builds:** `cargo test -p pigment-genai -p photocraft-automation` (incl. `tests/it/legacy_pigment.rs`).
4. **CLI.** `automation.rs`, `document.rs`. **Builds:** `cargo build -p photocraft-cli`,
   `pigment-cli --version`, `cargo test -p photocraft-cli` (ai, legacy_pigment, man pages).
5. **ui-egui without the AI windows.** Resolve the ui-egui files of §4.2 on upstream's code; turn
   `ai_ui` into a stub with the same hook signatures (no windows, `None`/`false`), and port
   `legacy_save_prompt` (§5.2), About, links, start screen, `updates_ui`, the agents page, theme suite
   folder. **Builds:** `cargo test -p photocraft-ui-egui` (upstream's suite green; `legacy_pigment` UI test).
6. **Desktop app.** `main.rs`, `services.rs` (+tests), `PRESETS_DIR`, no `AgentSwitch::watch`, no
   self-update. **Builds:** `cargo build -p photocraft`; `pigment --version` prints
   `Pigment 0.5.0 (based on PhotoCraft 0.23.1)`; start it on a scratch `PIGMENT_CONFIG_DIR` and check
   the folder (only `config.toml`, `logs/`, `Preset Library/`, … ; nothing under `ArtCraft/`).
7. **Port the AI interface** (§5.1): generate, describe, accounts, task bar, Assistant, menus as `Row`s,
   control `Reply`. **Builds:** `cargo test -p photocraft-ui-egui --test it ai ai_assistant`.
8. **Rebrand pass and docs.** FORK.md step 5 (`pigment-rebrand.py`, `--check`, the two `rg`s) plus
   `rg -n '\.pcraft' pigment --glob '*.rs'` for new user messages that should also name `.pigment`;
   new `///` in clap/MCP files; step 6 (`UPSTREAM-REVISION`, FORK.md's revision and "Upstream after the
   import", hook tables updated for every moved hook); step 7 (endpoint and clash tables, §7).
   **Builds:** `cargo build -p photocraft -p photocraft-cli`.
9. **CI and the full gate.** `.github/workflows/pigment-ci.yml` and `pigment-release.yml`: craft-fonts
   `cc9269cd…`; `CARGO_PROFILE_TEST_STRIP=symbols` and `CARGO_PROFILE_DEV_DEBUG=0` for tests (upstream:
   test build ~19 GB → ~6.5 GB); add `cargo xtask egui-fork` and `cargo xtask test-binaries` to the
   repository checks. Move `crates/genai/tests/genai/` to `crates/genai/tests/it/` (the new
   `test-binaries` check rejects any `tests/<dir>/main.rs` but `it`). `.config/nextest.toml` comes from
   upstream (the `gpu` group is now `package(photocraft-gpu) | test(/(^|::|_)gpu_tests::/)`; priority
   overrides for slow tests; nextest still 0.9.150). Run the whole gate; then FORK.md step 9 on
   `scripts/upstream-test-failures.txt` (§7). **Builds:** CI green.

## 7. What else FORK.md steps 5–9 ask of this merge

- **Rebrand (step 5).** 40 files have new product-name strings (`--check` on the trial): About and
  credits, alerts' titles, `framework.rs` host name, `filters.rs` ("PhotoCraft", `&["pcraft"]` → make it
  "Pigment" with `pigment` and `pcraft`), "PhotoCraft Basics" (new default actions set,
  `library_commands.rs::BASICS_SET`), "{n} steps have no PhotoCraft equivalent yet",
  `write_cube_export("PhotoCraft", …)` (a LUT file's creator line: decide keep or rebrand),
  "PhotoCraft Manages Colors" (a print-dialog choice, keep the id `photocraftManages`), viewport title,
  `os_window::APP_ID`. **Strings the script cannot reach now live in craft-libs**: `agents.intro`/
  `agents.off` (ArtCraft Launcher), craft-update's dialogs (only if shown), the theme store's folder name.
- **Version line (step 6).** Upstream's version at NEW is **0.23.1**: `UPSTREAM_VERSION` and the tests
  stay; only `UPSTREAM-REVISION` and FORK.md change. Since 0.23.1 now names two very different trees,
  consider printing the short revision too (`based on PhotoCraft 0.23.1+057297b`).
- **Update paths and requests (step 7).** New or moved: craft-update's `Updater` in
  `updates_ui.rs` (startup check, manual check; must stay off), `craft_update::self_update::finish` in
  `main.rs` (keep unwired), `build_info::RELEASES` (new home of the error-message link),
  `links::TUTORIALS` (getartcraft.com; replace), the ArtCraft Launcher poll in `AgentSwitch::watch`
  (local files, not network; do not start it), `craft-font-store` now linked (Google Fonts/Noto
  installs over jsDelivr and GitHub; PhotoCraft calls no install path at NEW and the store needs
  `enable_network()`: add a row to the endpoint table saying so). The font catalog also reads the suite
  store `~/.local/share/craft-fonts` (`Craft Fonts` on macOS/Windows, `$CRAFT_FONT_STORE`) read-only.
- **Settings folder (step 7).** New: `config.toml` (preferences; `preferences.json` stays, read once).
  No clash with Pigment 0.1–0.4's `settings.json`, `recent.json`, `ai-credentials.json`, `presets/`.
  `Presets` must stay `Preset Library`. If themes go to the settings folder, name the folder `Themes`
  (no 0.4 name clashes). Add both to the clash table.
- **Environment variables.** New folder-choosing variables from the framework: `CRAFT_SUITE_DIR`,
  `CRAFT_FONT_STORE`. FORK.md's rule (Pigment's own names for folder/port/token variables) says pass
  Pigment's folder explicitly so `CRAFT_SUITE_DIR` set for an installed PhotoCraft does not share its
  themes; `CRAFT_FONT_STORE` is the suite's font folder and can stay.
- **Upstream test-failure list (step 9).** Of the 60 entries in `scripts/upstream-test-failures.txt`,
  **7 no longer exist** at NEW (`photocraft-raw`: `dng::default_crop_origin_without_size_falls_back_
  to_active_area_with_warning`, `dng::enormous_double_crop_origin_is_rejected`,
  `dng::floating_point_raw_data_that_isnt_jpeg_xl_is_unsupported`,
  `dng::out_of_range_default_crop_falls_back_to_active_area_with_warning`,
  `hasselblad::truncated_strip_is_malformed`, `vendor_codecs::rw2_format4_rejects_other_block_widths`,
  `vendors::cr2_cfa_phase_is_measured_for_every_row_phase_and_border_parity`): delete them. The other
  53 still exist; upstream moved craft-libs and rewrote those tests (+554/−159 in format/io-svg/raw
  tests, craft-svg on its own pin for the SVG budgets), so expect most to pass: run the "Known upstream
  test failures" step and delete each that passes.
- **What CI runs (upstream).** `cargo xtask ci` is now split: `ci lint` (fmt, **egui-fork**, clippy,
  layers, panel-commands, **test-binaries**, scorecard `--check`, wasm, i18n-report), `ci tests
  [--gpu|--no-gpu]` (nextest + panic hunt over partitions, `scripts/ci-test-shard.sh`), `ci doctest`,
  `ci build`; `$PHOTOCRAFT_CI_EXCLUDE`. `panel-commands`' allow-list is now empty (Color panel fixed
  upstream). Layers table unchanged (Pigment's `pigment-genai` L6 rows stay valid). New ast-grep rules
  (`lint/ast-grep/`: `args-os`, `clap-error-message(-variable)`, `string-error`) run in upstream's
  `ast-grep.yml`; Pigment's CI does not run them (optional; Pigment's CLI and genai may not pass). The
  panic hunt is unchanged (`crates/engine/tests/panic_hunt.rs`, allow-listed binary). New test
  binary layout: integration tests are modules of `tests/it/main.rs`; process-global ones in
  `crates/engine/tests/global_state/`. New tests need no new files or services: GPU tests run on
  lavapipe as before (`PHOTOCRAFT_REQUIRE_GPU_TESTS` makes a skip fail, CI only), Japanese-font tests
  want `CRAFT_FONTS_DIR` (pin above), snapshot knobs (`SNAPSHOT_RERUNS`, `PHOTOCRAFT_SRGB_SNAPSHOTS`) are
  optional; 4 new tests are `#[ignore]`d benchmarks or known framework issues.

## 8. Risks

1. **The interface was rebuilt on the craft framework.** −3,004 lines in `canvas.rs`, −1,346 in
   `dialogs.rs`, 280 ui-egui files deleted: Pigment's ui hooks need re-placing and its AI interface
   (≈5,200 lines, plus ≈2,450 lines of UI tests) porting. Textually clean merges will not compile; the
   UI tests that click by label will need new names.
2. **Silent regressions of Pigment's promises.** The framework defaults to PhotoCraft's suite
   behaviour: update check at launch, ArtCraft Launcher switch, `ArtCraft/themes` folder, words naming
   the ArtCraft Launcher. Each compiles and passes upstream's tests; only Pigment's tests and a manual
   check of the settings folder and network (step 6) catch them. Keep Pigment's tests that assert these
   (`no_check_runs_at_launch…`, `pigment_reads_neither…`) and add one for the theme folder.
3. **Agents gate semantics.** Without the MCP flag the framework page hides the folders and When
   Closed; Pigment's switch has no framework home. A wrong choice either loses settings from the UI or
   shows ArtCraft wording. Needs a decision before step 5.
4. **Preferences migration.** 0.5 users' `preferences.json` (and `Integrations` reshaped into
   `agents`) must import into `config.toml`; Pigment's hidden `automaticallyCheckUpdates` must stay
   hidden under the new `rules()`.
5. **Upstream's new naming rule** (AGENTS.md "Our features use our own names", RFC-0029): Pigment's
   "Generative Fill…", "Generative Expand" are another company's distinctive feature names. FORK.md says
   AGENTS.md's engineering rules apply to Pigment: decide whether this one does (labels only; ids stay).
6. **Size and CI time.** 77 more packages; upstream needed test-profile opt-levels and stripping to
   fit runners (test build ~19 GB unstripped; local disk here had 7 GB free). Pigment's single CI job
   may exceed its time or disk; adopt upstream's settings in step 9.
7. **Windows build.** `.cargo/config.toml`'s delay-load flags apply to every msvc build; Pigment's
   release workflow must not set `RUSTFLAGS` (it would drop them).
8. **Upstream keeps moving.** Two days moved `main` by hundreds of commits; this plan is for NEW only.
   A later merge should come sooner and smaller.
9. **Untested here.** No cargo was run: compile errors and test results are predictions from the
   trees. craft-libs' behaviour at `18ffc07` (e.g. whether the 53 known failures pass) is unverified.

## 9. Estimate

| Work | Days |
|---|---|
| Steps 0–1: import commit, mechanical resolutions, lockfile | 0.5–1 |
| Steps 2–4: engine, genai/automation (agents gate), CLI | 1.5–2 |
| Step 5: ui-egui hooks on the framework (About, links, start screen, updates, agents page, menus, dialogs, legacy save prompt, control `Reply`) | 3–4 |
| Step 6: desktop app (agents switch, services, folders) | 1 |
| Step 7: AI interface port and its UI tests | 4–6 |
| Step 8: rebrand pass, FORK.md and docs | 1 |
| Step 9: CI changes, full test runs, fixing failures, the known-failures list | 2–3 |
| **Total** | **13–18 engineer-days (about 3–4 weeks for one engineer)** |

The AI interface port and the decisions in risks 3 and 5 dominate; everything outside `ui-egui` and
`apps/photocraft` is about a week.

## Appendix: how the numbers were made

- Upstream clone `/home/user/storytold/photocraft` (shallow; `git fetch --depth=1 origin main`).
- Trial: `git worktree add --detach <scratch>/merge-trial claude/pigment-photocraft`, then the apply
  above; conflicts counted by `<<<<<<<` markers. The worktree was removed afterwards.
- Script-only vs hand: `pigment-rebrand.py` (Pigment's current copy) run on `git archive 15b8ea5
  pigment`, compared byte for byte with `claude/pigment-photocraft` for each of the 244 upstream files
  Pigment modified: 77 equal (script-only), 167 not (hand); 58 and 84 of them changed upstream.
- API check: every `crate::…`/`photocraft_*::…`/`super::…` path and `use` in Pigment's own files
  resolved against OLD and NEW; method and field uses grepped; craft-libs read at `18ffc07` (shallow).
