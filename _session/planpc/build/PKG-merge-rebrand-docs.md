# Merge 057297b, step "rebrand-docs" (§6 step 8: the rebrand pass and the documents)

Branch `claude/pigment-merge-057297b`, one commit on top of ai-ui part 3's `acdfbdb`: "Pigment merge
057297b, rebrand pass and documents" = **`88de0b5`** (pushed; tree clean after it). Files changed: `crates/raw/src/shared.rs`, `crates/ui-egui/src/prefs/prefs_ui/fields.rs`,
`docs/FORK.md`, `docs/generative-ai.md`, `docs/user/guides/use-generative-ai.md`,
`docs/user/guides/open-pigment-0-4-documents.md`, `README.md`.

## FORK.md step 5: the rebrand pass and its checks

1. **`python3 scripts/pigment-rebrand.py`**: it changed only `crates/raw/src/shared.rs`, the last
   file `--check` listed after the earlier steps: two raw-import warnings, "some raw correction opcodes
   are not applied by Pigment" and "the raw camera profile's ProfileGainTableMap is not applied by
   Pigment". No test matches these strings. **`--check` is clean (exit 0)**, and also after the doc edits.
2. **`rg 'PhotoCraft'` in `.rs` outside comments**: 31 lines. I compared them with the same search
   at `f4e3ffa` (0.5.0). It is the same set; only the version-line tests now carry `+057297b`, and
   `links.rs`'s two lines moved into the `ABOUT` table and `credit()`. All are kept markers: the XMP
   toolkit, profile descriptions, font-face alias, case probe, the upstream link, credit and version
   line, Windows copyright, the catalog rebrand, the example plug-in, xtask, and tests.
3. **`rg 'getartcraft|discord\.gg|storytold/photocraft'`** outside docs/book: 37 lines. It is the
   same file set as 0.5.0: corpus links in xtask and tests, upstream issue links in comments, the
   PDF spot-plates XMP namespace, the README and ATTRIBUTION credits, `links::UPSTREAM`,
   `contributors.json`, the script itself, and the snapshot example's `preview_release`. Nothing new.
   **FORK.md's command was wrong:** with `pigment` as the search path, `--glob '!docs/**'` does not
   exclude `pigment/docs/`. The globs are relative to the folder searched. Step 5 now says
   `cd pigment` and searches `.`.
4. **`rg '\.pcraft'` for user messages**: I compared non-test, non-comment lines with 0.5.0's.
   **One regression, fixed:** upstream moved the Preferences labels into a `label_override` table
   (`prefs_ui/fields.rs`). 0.5.0's Pigment line for `pcraftFullComposite` was lost there, so the
   label said "Save Full-Size Composite in .pcraft Files". The catalogs are rebranded to say
   `.pigment`, so that label would also have found no translation. It now says "… in .pigment
   Files", marked `// Pigment:`. New test
   `prefs_ui::fields::pigment_tests::labels_name_pigment_s_extension_and_the_update_check_stays_hidden`
   checks three things: that label; that no rule's label or help names `.pcraft` or PhotoCraft; and
   that `general.automaticallyCheckUpdates` is still hidden (plan risk 4). Every other `.pcraft`
   message already names `.pigment` too.
5. **New `///` in the clap and MCP files** (`HELP_DOC_FILES`, plus Pigment's `ai.rs` and
   `server/*.rs`): I grepped the doc lines for photocraft, artcraft, launcher, `.pcraft`, discord.
   They are all the env-var names Pigment keeps (`PHOTOCRAFT_GPU`, …) and `.pigment or .pcraft`
   pairs. No other file has clap derives.
6. **§7's rebrand list, decided and recorded** in a table in FORK.md › "Upstream after the import":
   - "Pigment Basics" (engine step).
   - CUBE creator "Pigment".
   - "Pigment Manages Colors", with the id `photocraftManages` kept.
   - "{n} steps have no Pigment equivalent yet".
   - The file type "Pigment" with `pigment`, `pcraft`.
   - The host name, viewport title, `os_window::APP_ID` and screen picker: Pigment's. The host id
     `photocraft` is kept as an internal key.
   - The raw warnings.
   - The File Handling label above.
   - craft-update's `App::website()` (getartcraft.com): not called anywhere. The other craft-update
     words appear only in the result window, which carries Pigment's `UPDATE_APP`.
   - Strings in craft-libs: `agents.intro`/`agents.off` are overridden (ui step), and the theme
     folder is D4.
   - D2 is written down there: labels of Pigment's own features are unchanged, and AGENTS.md rule
     10 is a question for the owner.

## FORK.md step 6: revision, "Upstream after the import", hook tables

- `UPSTREAM-REVISION` (057297b) and `brand.rs` `UPSTREAM_REVISION` were already done in the cli step.
  FORK.md's top bullet now names `057297bb…` (19 Nov) and says 0.5.0 was `abb30df`.
- **"Upstream after the import" rewritten.** It says what the merge was, what the framework changed
  for Pigment's promises (updates, agents, `config.toml`, themes, words in craft-libs, version line)
  and the decisions table. The parity page measures 0.5.0, and upstream's docs/book describe 057297b.
- **Renamed table:** new Themes row (`ArtCraft/themes`/`$CRAFT_SUITE_DIR` → `<settings>/Themes`).
  "Pigment Basics" added to the shortcut-set row. The About row names `dialogs/credits.rs::about_info`.
- **AI agents and MCP** rewritten on the framework. It covers `craft::automation::agents`,
  `AgentSwitch::fixed(false, false)`, `agents_allowed_now`, the connection file written only while
  the switch is on, and the page layout. The page is Pigment's switch, then `AgentsPage::mcp_flag(true)`
  with `pigment_words`, then `ai_ui::preferences_rows`. `sync_agent_link` ignores the switch.
  `SERVER_NAME` is read by `conventions.rs`.
- **Updates and the network** rewritten. `updates_ui::check` opens the releases page, and so do
  the release window's Check Now and Check Again. `Updater::check_now` and `check_at_start` are
  never called, and `tick` reads only the local record. `self_update::finish` is not wired. The
  app's `craft-update` dependency is kept so the manifests stay upstream's. The lines saying "no
  update service in services.rs" and "updates.rs kept for merges" are gone, because both are gone
  upstream.
- **Generative AI hook table**, the rows that moved:
  - `app/frame.rs`: `show(self, ui)` after `dialogs::run`.
  - `control.rs`: `Reply`.
  - `menus/items.rs`: `menu_rows` / `Row`s.
  - `menus/state.rs`: `analysis`, native menus.
  - `jobs_ui.rs`.
  - `canvas.rs` → `canvas/document_display.rs::canvas_controls`.
  - The crop task bar's `TaskBar` body.
  - `prefs_ui/agents.rs`: `preferences_rows`, and a new row for `custom_rows.rs` (`PrefsCustom.ai`).
  - `tests/it/main.rs`.
  - The `canvas_tool_menu/tests.rs` row is removed: upstream deleted
    `selection_menus_follow_photoshop_order`. The `canvas_tool_menu.rs` row now says
    `tests/it/ai.rs::menus_put_each_feature_in_its_photoshop_place` covers the place.
- **Importer:** the `dialogs.rs` row now names `legacy_save_prompt::answer` in `PROMPTS` and `PREF`
  in `dont_show_again_keys()`. The section's prompt description says it is a framework
  `StandardPrompt` and that "Don't show again" sticks with Save only.
- **Hand-done list** ("The rest was done by hand"): `file_dialog/filters.rs`, the fields.rs label,
  `brand.rs` for the version line, About in `dialogs/credits.rs`, the theme folder in
  `app/{framework,prefs}.rs`, and `custom_rows.rs`.
- **Not renamed:** `LAUNCHER_APP_ID` now lives in `crates/automation/src/agent_link.rs`, and the
  framework host id `photocraft` is internal.
- **Classification table:** the `ArtCraft` row is now 5 lines. The never-wired launcher watch is
  gone, so what remains is the About credit and the tests that the launcher and Flatpak folder are
  gone.
- **Merging steps**, from this merge's lessons:
  - Step 3: `git apply` is all-or-nothing; `--exclude` and `git rm` the deleted files Pigment changed.
  - Step 5: the fixed `rg` commands, the `.pcraft` search, and "compare with the last release's list".
    Words in craft-libs need overrides on Pigment's side.
  - Step 7: newly linked craft crates can bring network paths (`cargo tree -i ureq`), and the
    framework's default folders are the suite's, so pass Pigment's own.
  - The panels_toggle paragraph now says upstream removed `bare_app`, so the repair went with it.

## FORK.md step 7: endpoints, settings folder, environment variables

- **Endpoint table:**
  - The releases row is now craft-update's `Updater` in `updates_ui.rs`.
  - The `--finish-update` row names `craft::update::self_update::finish`.
  - The launcher row names `craft::automation::agents::{launcher_allows, mcp_flag}` and
    `AgentSwitch::watch`, and says Pigment uses `fixed(false, false)`.
  - The control-server row names `craft::automation::{server, agents}`, built in `main.rs`.
  - **New row: craft-font-store.** It covers Google Fonts and Noto (jsDelivr,
    raw.githubusercontent, notofonts.github.io) and the craft-i18n language packs. It is linked
    through craft-font-manager, and I checked that nothing in Pigment builds an installer:
    `SuiteStore`/`Installer` are unused and nothing calls `enable_network`, which is refused for
    agents anyway. The store reads the suite's installed fonts read-only (`craft-fonts` /
    `Craft Fonts` / `$CRAFT_FONT_STORE`).
  - "font downloads" is dropped from the "none" row.
  - Checked: `cargo tree -p photocraft -i ureq` shows ureq only through craft-font-store,
    craft-update and pigment-genai. None of theme-store, settings, host, platform, window,
    ui-shell, ui-patterns, ui-panels, ui-widgets, ui-canvas, dialogs, menu, quit, text,
    font-catalog, font-manager, imaging, draw or color-ui uses ureq, TcpStream or std::net.
    craft-cloud-ui is linked but has no IO.
- **Settings folder clash table:**
  - Added `config.toml`, `config.toml.bak` (the last copy that parsed) and `config.broken-<ts>.toml`
    (craft-settings `recovery.rs`).
  - `preferences.json` is now "read once into config.toml, never written".
  - Added `Themes/` (`selection.json`, `selection.lock`, `library/`), and `ai.json`/`ai-keys.json`,
    which were missing before.
  - A new paragraph says none of these clash with 0.1–0.4. **A watch item found:** craft-settings
    has `PresetFolder::new(config_dir, kind)` → `<config>/presets/<kind>/` and `Profiles` →
    `profiles/`. Pigment calls neither at 057297b, I grepped pigment and craft-libs' linked crates.
    But `presets/` *is* the JavaScript app's folder, so FORK.md tells a later merge to use another
    folder or `in_settings` if upstream adopts it.
- **Environment variables** (Not renamed): `CRAFT_SUITE_DIR` is not read (D4), and
  `CRAFT_FONT_STORE` is read as upstream reads it. I diffed upstream's own `PHOTOCRAFT_*`/`CRAFT_*`
  literals from OLD to NEW in non-test code, and it adds none (5 removed). The framework's are
  `CRAFT_SUITE_DIR` (theme-store), `CRAFT_FONT_STORE` (font-catalog), `CRAFT_UPDATE_*`/
  `CRAFT_VERSIONS_FILE` (craft-update, whose paths are not called), `CRAFT_FLAGS*` (never read),
  and `CRAFT_FONTS_DIR` (font-catalog tests only).

## Other documents

- `docs/generative-ai.md` describes the task bars on the framework `TaskBar`. It also covers the
  turned frame, Delete Cropped Pixels off, the bar not showing with the Frame tool, the Preferences
  permission row (saved at once to `ai.json`, injected clicks change nothing) and the Assistant's
  model select.
- `docs/user/guides/use-generative-ai.md`: Generative Expand needs Delete Cropped Pixels off to drag
  the frame past the canvas. The agents' permission is also in Preferences › AI Integrations, and
  only your own click turns it on.
- `docs/user/guides/open-pigment-0-4-documents.md`: "Don't show again" sticks only with **Save**.
- `README.md` › Status: the tree has merged 057297b for the next release (0.5.0 is still abb30df).
- Not touched: `docs/RELEASE-NOTES-0.5.0.md` and `docs/parity/README.md` (history of 0.5.0).

## Builds, tests, checks (CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_STRIP=symbols, -j 4, TMPDIR=/dev/shm/pt, CRAFT_I18N_DIR, CRAFT_FONTS_DIR=craft-fonts at cc9269c)

| Command | Result |
|---|---|
| `cargo build --locked -j 4 -p photocraft -p photocraft-cli` | **builds** (5 m 30 s), no warnings from workspace crates (only upstream's 6 unused-patch warnings) |
| `target/debug/pigment --version`, `target/debug/pigment-cli --version` | `Pigment 0.5.0 (based on PhotoCraft 0.23.1+057297b)` both |
| `python3 scripts/pigment-rebrand.py --check` | clean, exit 0 |
| `rustfmt --check --edition 2024` on `fields.rs`, `shared.rs` | clean |
| `cargo nextest run --profile ci --locked -p photocraft-ui-egui --lib -E 'test(/pigment_tests/) \| test(/embedded_catalogs_are_rebranded/) \| test(/prefs_ui::/) \| test(/links::/) \| test(/updates_ui::/)'` | **74 run: 74 passed** (incl. the new fields test, `i18n::tests::embedded_catalogs_are_rebranded`, the agents page, links and updates tests) |
| `cargo clippy --locked -p photocraft-raw -p photocraft-ui-egui --all-targets -- -D warnings` | clean (1 m 29 s) |
| `cargo fmt --all -- --check` | clean |

## Left for step 9 (not this step)

- `docs/scorecard.md`: regenerate with `cargo xtask scorecard` (the import took upstream's).
- FORK.md step 9's paragraph still says "60 integration tests". Step 9 updates it along with
  `scripts/upstream-test-failures.txt` (7 entries no longer exist, plan §7).
- CI changes (craft-fonts pin, test-profile stripping, `egui-fork`/`test-binaries` checks,
  `crates/genai/tests/genai/` → `tests/it/`). FORK.md's Generative AI paragraph names
  `crates/genai/tests/genai/`, so update it when the folder moves.
- Whether to drop the app's unused `craft-update` dependency. FORK.md now says it is kept for
  manifest parity; change that line if step 9 drops it.
- The earlier steps' open remarks still apply: the cancel test (engine), `scratch_save` under plain
  `cargo test` (automation).
