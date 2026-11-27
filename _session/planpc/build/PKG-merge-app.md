# Merge 057297b, step "app" (§6 step 6: the desktop app)

Branch `claude/pigment-merge-057297b`, commit **`8ead1af`** "Pigment merge 057297b, desktop app: Pigment's
agents switch, names and tests on upstream's app", on top of the ui commit `b4f88a0`. Pushed. Tree clean
after it. Only `pigment/apps/photocraft` changed (4 files, +51 −14).

## What the import had left

The import commit had already resolved the app's hand files to upstream's side with Pigment's clean
hunks. `main.rs` was upstream's code plus Pigment's `--finish-update` comment (self-update not wired),
`launch_args::exit`, `eframe::run_native("Pigment", …)`, the version-line log line, the log messages,
`ai_ui::install(&mut app, &dir)` after `background_jobs`, and the desktop/flatpak test paths.
`services.rs` was upstream's plus `PRESETS_DIR = "Preset Library"` and `pigment` in the AppImage
command. The open/save filters had moved to ui-egui (`file_dialog/filters.rs`, done in step 5), and
`check_updates`/`last_update` are gone from `Services`. The app, `agent_link.rs`, `updates.rs`,
`control_server.rs` and `screen_color.rs` were deleted in the import. No `mod` lines were left for them.
`cargo build -p photocraft` built before any edit, so nothing failed to compile.

## Hand merges (all in `apps/photocraft`)

1. **`src/main.rs`, the agents switch (D1, plan §4.2):** upstream started
   `AgentSwitch::watch(agent_link::LAUNCHER_APP_ID, wake)`. That polls the ArtCraft Launcher's
   files. It is now
   `AgentSwitch::fixed(photocraft_automation::agent_link::mcp_flag(), …::launcher_allows_agents())`.
   Both are always `false`, so nothing watches the launcher. ui-egui's `sync_agent_link` ignores the
   switch anyway: Pigment's `connect_agents` alone lets agents in. `control/inspect.rs` reports the
   switch as `mcpFlag: false, launcher: false`. The comment above it says Pigment's switch is the
   one consent.
2. **`src/main.rs`, the agent connection:** `AgentLink::new(config_dir, brand::version_line())`
   (upstream gave `build_info::long_version()`). The connection file's `app` field, which is only
   used for diagnostics, now reads `Pigment 0.5.0 (based on PhotoCraft 0.23.1+057297b)`.
3. **`src/main.rs`, rebrand:** I ran the script's `rewrite()` on this file and on
   `tests/windows_delay_loads.rs` only. It changed the viewport title to `"Pigment"`, the line
   `pigment: control server listening on …` and `CARGO_BIN_EXE_pigment`. I fixed one doc line by
   hand: `PIGMENT_CONTROL_PORT` in `control_port_for`. `pigment-rebrand.py --check` now lists only
   `crates/raw/src/shared.rs` (step 8).
4. **`src/services.rs`:** I kept upstream's code and Pigment's `PRESETS_DIR`. The portable folder in
   `config_dir`'s doc now says `PigmentData` (`app_dirs.rs` already used that name). The settings
   store is `prefs::store_options(config_dir())`, which is `Location::Dir(<settings folder>)`, so
   `open_suite` puts the themes in `<settings>/Themes` (D4).
5. **Unchanged on purpose:** the self-update helper is still not wired in (`--finish-update` is
   unknown, as in 0.5.0). There is no `mod updates`. The `craft-update` dependency stays in
   `Cargo.toml` as upstream has it, though nothing in the app calls it now. Removing it would change
   `Cargo.lock` and cause conflicts at the next merge, so I left it for step 9 to decide.
   `PIGMENT_CONFIG_DIR` and the env names were already Pigment's.

## Tests added (`src/services/tests.rs`)

- `brush_presets_live_in_the_preset_library_folder`: `PRESETS_DIR` is `Preset Library`,
  `presets_dir()` is `config_dir()/Preset Library`, and `services.rs` contains no `join("Presets")`.
- `the_native_services_never_check_for_updates`: `services.rs` and `main.rs` contain none of
  `check_now(`, `check_at_start(`, `self_update::finish(` or `Updater::`.
- `the_app_never_watches_the_artcraft_launcher`: `main.rs` contains no `AgentSwitch::watch`,
  `agents::mcp_flag(`, `agents::launcher_allows(` or `craft_flags::`, does contain
  `AgentSwitch::fixed(`, and both of Pigment's `agent_link` answers are false.

## Checks (CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_STRIP=symbols, -j 4, TMPDIR=/dev/shm/pt, CRAFT_I18N_DIR, CRAFT_FONTS_DIR=craft-fonts at cc9269c)

| Command | Result |
|---|---|
| `cargo build --locked -p photocraft` | builds (about 20 min, mostly ui-egui at this profile) |
| `target/debug/pigment --version` | `Pigment 0.5.0 (based on PhotoCraft 0.23.1+057297b)`, exit 0. CI's pattern `grep -qx 'Pigment [0-9][^ ]* (based on PhotoCraft [0-9][^ ]*)'` matches (D3) |
| `cargo nextest run --profile ci --locked -p photocraft --no-fail-fast` | **232 run: 232 passed, 2 skipped**. Includes `it::command_line_usage::version_prints_the_long_version` (expects `+057297b`), `it::control_exit_code::*`, `it::startup_without_display::*`, the 3 new tests and `xwayland_command_matches_how_photocraft_was_installed` |
| `cargo clippy --locked -p photocraft --all-targets -- -D warnings` | clean |
| `cargo fmt -p photocraft -- --check` | clean |
| `pigment-rebrand.py --check` | only `crates/raw/src/shared.rs` (step 8) |

### The start on a scratch settings folder (what I looked at)

Scripts and logs are in `scratchpad/start-check/` (`run.sh`, `run2.sh`, `quit.py`, `strace*.log`,
`stderr*.log`). The container needed `apt-get install libxkbcommon-x11-0`: without it the app's
library check stops an X11 start. I ran `target/debug/pigment` under Xvfb (llvmpipe GL; there is no
Vulkan driver here, so the canvas used the CPU path) with `env -i`, a scratch `HOME` and
`XDG_RUNTIME_DIR`, `PIGMENT_CONFIG_DIR=<scratch>/settings`, and
`strace -f -e trace=%file,%network`:

1. **Plain start, stopped with SIGTERM after 25 s.** The settings folder held only `config.toml`
   and `logs/` (`pigment.log`, `pigment.lock`, `rotate.lock`). `gpu-starting.json` was removed once
   frames had rendered. The scratch HOME held only Mesa's shader cache. No socket other than
   AF_UNIX was opened: the X server, plus the session and system D-Bus, both missing here. No
   `connect` to AF_INET at all. No path containing ArtCraft, `flags.toml`, `craft-ai` or launcher
   was opened, stat'ed or created. The only reads of suite paths were
   `$HOME/.local/share/craft-fonts` (the font store, read-only, missing; the plan says it may stay)
   and `<settings>/Themes/selection.json` (Pigment's theme folder, D4; not created because nothing
   was saved). Writes outside those two folders: `/dev/shm/pt` (the scratch disk) and `/dev/null`.
   `find / -xdev -newer marker -iname '*artcraft*'` found nothing.
2. **Graceful close** (`--control 47361 --control-token …`, then `auth` and `app.quit` over loopback):
   the folder held `config.toml`, `logs/` and `ui.ron`. Nothing under ArtCraft, and no non-loopback
   connect.
3. **Agents gate:** with the default `[integrations] connectAgents = false`, no `agent-connection.json`
   appeared. With `connectAgents = true` in `config.toml`, `agent-connection.json` and
   `agent-control.token` appeared in the settings folder (loopback port, and
   `"app": "Pigment 0.5.0 (based on PhotoCraft 0.23.1+057297b)"`).

`Preset Library/` and `Themes/` are created only when something is saved there, so a bare start
has neither. The saved `config.toml` holds `automaticallyCheckUpdates = true` (upstream's hidden
default, the same as 0.5.0). Nothing reads it to start a check: there was no network traffic, and
ui-egui's `no_check_runs_at_launch_even_with_automatic_checks_on` covers it.

Disk: about 8 GB free at the end. I deleted `target/debug/examples` (4.7 GB, examples from earlier
steps) and `target/debug/incremental`.

## Left for the next steps

- **Step 7 (ai-ui):** nothing in the app. `ai_ui::install(&mut app, &dir)` is called with the
  settings folder after `background_jobs`, as before.
- **Step 8 (FORK.md), app rows that are now out of date:**
  - l. 177/181: `check_updates`/`last_update` no longer exist, and `apps/photocraft/src/updates.rs`
    is deleted.
  - l. 194: the update checker is craft-update's `Updater` in `updates_ui.rs`.
  - l. 195: the `--finish-update` row still holds, but the call it names lives in upstream's
    `main.rs` only.
  - l. 200: the control server and agent connection are `craft::automation::{server, agents}`,
    built in `main.rs`.
  - l. 251: the "never-wired launcher watch (`apps/photocraft/src/agent_link.rs`)" is gone. The app
    now uses `AgentSwitch::fixed` in `main.rs` and the switch is in `crates/automation/src/agent_link.rs`.
  - l. 118: the clash table gains `config.toml` and `Themes/`.
  - The hook table should name `main.rs`'s `AgentSwitch::fixed`, `AgentLink::new(…, version_line())`
    and the viewport title.
- **Step 9:** decide whether to drop the unused `craft-update` dependency of `apps/photocraft`. CI
  doesn't start the app. If a start check is wanted there, it needs `libxkbcommon-x11-0` and Xvfb.
