# Merge 057297b, step "ui" (§6 step 5: the interface without the AI windows)

Branch `claude/pigment-merge-057297b`, commit **`b4f88a0`** "Pigment merge 057297b, interface: Pigment's
hooks on upstream's framework UI (AI windows stubbed)", on top of the CLI commit `f42fe5f`. Pushed.
Tree clean after it. Only `pigment/crates/ui-egui` changed.

Before any edit, `cargo check -p photocraft-ui-egui --lib` failed with 38 errors: all in `ai_ui*`,
`legacy_save_prompt.rs`, the two icon paths (`ai.storyteller.photocraft.png`) and
`links::{DISCORD, ARTCRAFT_WEBSITE}` (start screen, credits). Everything else of upstream's
framework UI compiled with Pigment's clean hunks (gate in `app/commands.rs`, `files.rs` intercept,
`control.rs` `as_agent`, `jobs_ui.rs`, `home_recent_ui.rs`, `menus/invoke.rs`, the
`canvas_tool_menu.rs` row).

## What I did, file by file

1. **Rebrand pass on ui-egui only** (as the engine and automation steps did for theirs): the script's
   `rewrite()` over `crates/ui-egui/` (30 files: framework host name, alerts' titles, About, `filters.rs`,
   gpu_status, title bar, the two icon `include_bytes!`, the flatpak test's manifest paths, …).
   `pigment-rebrand.py --check` now lists no ui-egui file (only `apps/photocraft/src/main.rs`,
   `apps/photocraft/tests/windows_delay_loads.rs`, `crates/raw/src/shared.rs`: steps 6 and 8).
   By hand: `examples/snapshot.rs` `"WAYLAND_DISPLAY= pigment"` (examples are not rewritten by the script).
2. **`ai_ui.rs` → stub** (whole file rewritten; 0.5.0's is `git show f4e3ffa:pigment/crates/ui-egui/src/ai_ui.rs`).
   Kept: the ids, `ITEMS`, `ACCOUNTS_PATH`, `AGENTS_REFUSED`, `AiUi { agent, agent_now, accounts_asked }`,
   `as_agent`, `set_agent_now`, `gate` (same rule; `agents_allowed` is `false` with no accounts), `place_after`.
   Stubbed (same signatures unless said): `handles` → false, `menu_items(app) -> Vec<craft::menu::Row>` → empty
   (was `Vec<MenuItem>`), `checked`/`is_enabled` → None, `install(app, &Path)` → nothing (no backend on the
   session: an engine `ai.*` command refuses, nothing is sent), `open_accounts` → nothing, `menu` → None,
   `on_job_event` → false, **`show(app, ui: &mut egui::Ui)`** (was `&egui::Context`; it runs after
   `dialogs::run(self, ui)` and opens AI Accounts when `accounts_asked` was set), **`task_bars(app, ui, rect:
   egui::Rect, space: &craft::ui::canvas::CanvasSpace)`** (was `&ViewXform`; `space.view` is the
   `CanvasView`), `crop_task_bar_item(app, ui)`, `preferences_button(ui) -> bool` → false.
   `ai_ui/*.rs` stay in the tree **not compiled** (no `mod` lines) for the ai-ui steps to port in place.
3. **Hooks re-placed on upstream's code:**
   - `app/frame.rs`: `crate::ai_ui::show(self, ui)` right after `crate::dialogs::run(self, ui);`.
   - `canvas/document_display.rs` `canvas_controls`: `crate::ai_ui::task_bars(app, ui, rect, space)` after
     `frame_tool::task_bar::show`, inside the active-document check (one task bar per window).
   - `tools/crop_task_bar.rs`: `crate::ai_ui::crop_task_bar_item(app, ui)` in the Generative Expand slot,
     inside the framework `TaskBar` body, before `preset_list`.
   - `menus/items.rs`: `|| crate::ai_ui::handles(id)` at the end of `is_live`; the `PLACE_AFTER` lookup
     `.or_else(|| crate::ai_ui::place_after(&e.command.id))`.
   - `menus/state.rs`: `help.checkForUpdates` always enabled (first line of `is_enabled`);
     `ai_ui::is_enabled` after `crate::analysis::handles` (was `analysis_ui`); `ai_ui::checked` after the
     analysis/workspace/file_ui line.
   - `control/dispatch.rs` `open_pcraft_directory`: `brand::is_native_extension(ext)` with upstream's `Reply`.
4. **`dialogs/legacy_save_prompt.rs`** (§5.2) rewritten as a framework prompt: `StandardPrompt::custom(message)
   .title("Save").paragraph(…)` with the same three/four sentences, buttons Save (Proceed) / Save As…
   (Alternate) / Cancel, or with parts left out Save As… (Proceed, the default) / Save (Alternate) / Cancel and
   no box; `.dont_show_again()` otherwise; tag `PendingLegacySave { doc, path, left_out, choices }` (the script's
   `FormatChoices` ride in the tag, so `record`/`from_step` are gone). Opened with `alerts::open_prompt`; asked
   again while open returns the open one's id. `answer` (a row at the end of `dialogs::PROMPTS`) runs
   `save_in_place_unasked` or `save_dialog_flow` in `with_document(doc)`; a ticked box is kept with
   `alerts::remember_skip` after a successful save; errors go to the status bar (`alerts::report_error`).
   `PREF` (`file.save.legacyPigment`) is now one of `dialogs::dont_show_again_keys()` (array of 5), so the
   one-time memory move leaves it in `Preferences.dialogs` where `alerts::dismissed` reads it.
   `intercept`, `save_in_place_unasked`, `replay_save` unchanged.
   **Behaviour change:** the framework keeps "Don't show again" only with the Proceed answer, so a ticked box
   with Save As… is no longer remembered (0.5.0 kept it either way). Automation: `ui.dialog.set`
   `{"choice": "alternate"}` / `{"skip": true}`, then `ui.dialog.confirm`.
5. **About** (`dialogs/credits.rs::about_info`): name "Pigment"; blurb = the sentence, `brand::version_line()`
   (`Pigment 0.5.0 (based on PhotoCraft 0.23.1+057297b)`, D3) and `links::credit()` on three lines; version
   = `build_info::long_version()` (the framework writes "Version …"); links `links::ABOUT` = Report an Issue,
   Pigment on GitHub, Pigment Releases, PhotoCraft (upstream project); **no `.community` (Discord)**;
   built-with line kept. The title is the framework's "About {app}" = "About Pigment".
6. **`links.rs`**: new `ABOUT` table and `credit()` (returns the string; the old drawing `credit(ui)` and
   `link_row` are gone with the old About). `TUTORIALS` was already Pigment's. Tests back:
   `help_menu_lists_links_then_separator_then_system_info_and_about` (now over `menus::menu_rows`, separator =
   empty id; order Report an Issue, Pigment on GitHub, Pigment Releases, PhotoCraft (upstream project), Check
   for Updates…, ---, System Info…, About), `repository_links_name_this_release_s_tag_not_the_default_branch`
   (+ `build_info::RELEASES == links::RELEASES`), `link_commands_open_their_urls`, and new
   `about_and_home_name_pigment_s_pages_only`.
7. **Start screen** (`canvas/start_screen.rs`, framework `StartLink` rail): Home, Learn (`TUTORIALS`, Pigment's
   user guide at its tag), Releases, Report an Issue, GitHub (Pigment's tree). No Website/Discord.
   `links()` is `pub(crate)` for the test.
8. **`updates_ui.rs`**: upstream's `Updater` shape kept for the result window and the last-update read;
   `check` opens `links::RELEASES` through `links::open` and returns `{"url": …, "status": "opened"}` (rejects
   params, as 0.5.0); the result window's Check Now / Check Again call `check` too. Nothing calls `check_now`
   or `check_at_start` (`tick` only `read_last_update`, from the engine step). Tests: Pigment's
   `no_check_runs_at_launch_even_with_automatic_checks_on` and
   `check_for_updates_opens_the_releases_page_and_fetches_nothing` (both with a counting `CheckSource`, which
   never runs) replace upstream's `manual_check_works_…`; upstream's `update_window_is_drivable_…` kept.
9. **`lib.rs` `UPDATE_APP`**: Pigment's again on `craft::update::app::App` — icon, accent `e1 1d 74`,
   developer "Pigment contributors", `bundle_id_override: brand::APP_ID`,
   `..App::new("pigment", "Pigment", "Image editing", "Nihalpi1212/claude")`.
10. **Agents page (D1)**, `prefs/prefs_ui/agents.rs` + `custom_rows.rs`: `agents::page` draws Pigment's switch
    (Field "Let AI apps use this window", a Checkbox on draft key `integrations.connectAgents`, off by
    default), then the framework `AgentsPage::new(..).mcp_flag(true)` inside
    `with_env(.. WordsOverride::Overlay(pigment_words()))`, where `pigment_words()` replaces `agents.intro`
    ("… while Let AI apps use this window is on …") and `agents.off` ("Off: AI apps get a session without a
    window.") via `AgentsWords::word(id)`; then `ai_ui::preferences_button(ui)`, whose click sets
    `app.ai.accounts_asked` (an `Arc<AtomicBool>` cloned into `PrefsCustom`; the window has no app).
    `PrefsCustom.mcp_flag` (read from `agent_switch.mcp_flag()`) is gone. `sync_agent_link` lets agents in on
    `agents::agents_allowed(false, false, connect_agents)`: `Services::agent_switch` is never consulted
    (whatever the app step puts there). `fields.rs`: label override `connectAgents` → "Let AI apps use this
    window". Nothing calls `agents::mcp_flag()`, `launcher_allows(` or `AgentSwitch::watch` in ui-egui.
    `control/inspect.rs` still reports `agentLink.mcpFlag/launcher` from `agent_switch` (upstream's; harmless).
11. **Theme folder (D4)**: `Framework::open_suite(ctx, folder: Option<PathBuf>)` opens `SuiteDir::at(folder)`
    or `SuiteDir::memory()`, store tag `pigment <version>`, keeps `suite_folder`; `PhotocraftApp::open_suite(ctx)`
    (signature unchanged, the app calls it) passes `<settings store dir>/Themes` (`app::prefs::THEME_FOLDER`), in
    memory when the services have no settings store. Never `SuiteDir::resolve` (`ArtCraft/themes`,
    `$CRAFT_SUITE_DIR`).
12. **File pickers** (`file_dialog/filters.rs`): `pigment` first in `OPEN_EXTS`; the "Pigment" open and save
    types are `["pigment", "pcraft"]`. `file_dialog/tests.rs`: the PDN save suggests `/pics/layers.pigment`;
    `pigment` is a layered extension in `save_as_offers_only_writable_formats_including_ico`.
13. **`i18n/tests.rs`**: Pigment's `embedded_catalogs_are_rebranded` back (upstream deleted the az test it sat
    beside; not restored). **`tools/type_tool/panels_toggle_tests.rs`**: upstream removed `bare_app`, so the
    `// Pigment:` font-scan wait is dropped. **`tests/it/main.rs`**: `mod legacy_pigment;` back; `ai` and
    `ai_assistant` left out with a comment. `tests/it/legacy_pigment.rs`: `Box<PhotocraftApp>`.
14. **New tests**: `app::prefs::theme_folder_tests::themes_live_in_pigment_s_settings_folder_not_artcraft_s`;
    `agents_tests::{pigment_s_switch_alone_turns_the_agent_link_on_and_off (switch fixed(true,true),
    (true,false), (false,true)), the_agents_page_reads_neither_the_suite_flag_nor_the_launcher,
    ai_integrations_have_pigments_own_switch_and_the_folders}` (kittest: switch, Pigment's words, folders,
    "When Pigment is closed", no "ArtCraft", click + OK saves `connect_agents`); upstream's two launcher-switch
    tests are replaced. `tests::prefs_harness` is `pub(super)`.

## Tests and checks (CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_STRIP=symbols, TMPDIR=/dev/shm/pt, CRAFT_I18N_DIR, CRAFT_FONTS_DIR at cc9269c)

| Command | Result |
|---|---|
| `cargo nextest run --profile ci -p photocraft-ui-egui --lib --tests --no-fail-fast` (CI's runner; build ≈ 45 min cold) | **3653 run: 3651 passed, 2 failed, 6 skipped**; the 2 were my test expectations (`.pigment` not a codec format; a kittest label matched twice), fixed and rerun: pass (11 targeted tests + the kittest one). Includes the 4 legacy save-prompt tests, `it::legacy_pigment::*` (2), `it::flatpak_updates`, the links/updates/agents/i18n/theme tests above, and all of upstream's suite incl. GPU groups on lavapipe. |
| `cargo clippy -p photocraft-ui-egui --all-targets -- -D warnings` | clean |
| `cargo fmt -p photocraft-ui-egui -- --check` | clean |
| `pigment-rebrand.py --check` | no ui-egui file (3 others, steps 6/8) |

Not run: `apps/photocraft` (step 6), xtask checks (`panel-commands` — the agents page's checkbox edits the
draft, no command; `scorecard`, `layers`: step 9), the workspace gate.

**AI tests the stub disables (68, none compiled):**
- `tests/it/ai.rs` (30): menus_put_each_feature_in_its_photoshop_place, items_dim_for_the_document_not_for_a_missing_key, generative_fill_sends_nothing_before_generate_and_lands_as_one_step, a_failed_variation_keeps_the_ones_that_arrived_and_says_so, stop_cancels_a_request_that_never_answers, without_a_key_or_the_agreement_generate_is_dimmed_and_links_to_ai_accounts, ai_accounts_connects_a_key_that_never_shows_anywhere, preferences_open_ai_accounts, describe_image_shows_the_answer_and_can_become_the_description, describe_without_a_provider_opens_ai_accounts, task_bar_items_appear_only_with_a_key, generate_background_follows_the_document_the_job_ran_on, expand_from_crop_on_a_very_wide_document, expand_from_crop_keeps_the_frame_where_expand_is_disabled, the_bar_generate_sends_one_request, describe_shows_a_bounded_answer, agents_need_permission_to_run_ai_commands, an_agent_running_a_script_with_an_ai_step_needs_permission_too, an_action_with_an_ai_step_never_sends, synthetic_input_neither_sends_nor_grants_itself_permission, done_with_a_model_that_is_not_a_model_id_says_so, ai_accounts_left_open_keeps_what_the_command_line_changed, ai_accounts_removes_a_sign_in_the_feature_hides, synthetic_input_chooses_neither_the_models_nor_the_provider, generate_image_makes_a_new_document_in_the_background, generative_expand_grows_the_canvas_in_one_undo_step, the_last_prompt_comes_back, sign_in_with_chatgpt_from_ai_accounts, the_pasted_address_finishes_a_sign_in_and_agents_cannot_start_or_end_one, a_sign_in_serves_the_assistant_and_describe_and_images_ask_for_a_key.
- `tests/it/ai_assistant.rs` (29): the_layer_tools_run_their_commands_and_check_ids, fill_selection_honours_alpha, adjustments_and_filters_are_clamped_and_take_json_text, select_and_add_text, canvas_size_crop_and_resize, canvas_size_without_a_background_adds_transparency, list_commands_finds_commands_and_never_offers_a_blocked_one, run_command_runs_commands_and_reads_json_text, run_command_refuses_what_the_assistant_may_not_run, among_the_ai_commands_only_generative_fill_runs, a_turn_sends_the_image_runs_the_tools_and_shows_the_answer, later_messages_send_only_the_latest_image, an_answer_with_too_many_tool_calls_runs_none, the_tool_round_limit_is_reported, stop_ends_the_turn_and_nothing_runs_after_it, conversations_belong_to_their_document, closing_the_document_or_clear_ends_its_turn, a_conversation_keeps_forty_messages, the_model_sees_refusals_and_only_generative_fill_reaches_a_provider, a_command_that_opens_a_dialog_waits_for_the_person, a_model_list_that_failed_can_be_asked_for_again, a_step_that_runs_in_the_background_is_waited_for, agents_need_permission_and_a_missing_account_keeps_the_message, the_window_item_and_the_saved_choices, no_tool_reads_a_file_or_reaches_outside_the_document, a_param_named_like_a_file_param_that_is_no_file_runs, an_agents_clicks_change_neither_the_model_nor_what_is_attached, a_turn_of_large_steps_keeps_the_window_quick, an_answer_with_a_step_too_large_to_run_runs_none.
- `src/ai_ui/assistant_tools.rs` unit tests (9): the_blocked_list_keeps_files_settings_windows_and_providers_from_the_assistant, the_blocked_list_keeps_other_files_other_documents_and_the_preset_libraries, the_spelling_dictionary_and_the_favourite_fonts_are_the_persons, a_param_names_a_file_at_any_depth_unless_it_is_a_listed_choice_or_geometry, the_curated_commands_exist_and_the_kind_lists_come_from_the_registry, kinds_are_found_however_they_are_spelt, arguments_are_parsed_clamped_and_cut, colours_are_hex_rgb_or_css_names, results_are_capped_and_dialog_answers_explained.

Disk at the end: ≈ 8 GB free (`df -h /`); test executables over 20 MB were deleted before clippy.

## For the next steps

- **Step 6 (app)**: `ai_ui::install(&mut app, &dir)` and `app.open_suite(&ctx)` keep their signatures. The
  app must give the settings store with `Location::Dir(<Pigment's settings folder>)` so the themes land in
  `<that>/Themes`. Whatever `Services::agent_switch` the app sets, ui-egui ignores it for the gate (prefer
  `AgentSwitch::fixed(false, false)` or none; never `watch`). The app's `AgentLink::new(dir, app)` app string
  should name Pigment.
- **ai-ui steps**: put the real code behind the stub's hooks (signatures above, two changed: `show` takes
  `ui`, `task_bars` takes `rect` + `CanvasSpace`); `menu_items` must build `craft::menu::Row`s
  (`Row::new(path, id, label).enabled(..)`, check kind for the Assistant); `handles` back to the shell list;
  `install` back (accounts + `AppBackend`); `preferences_button` must draw on the framework (no
  `crate::widgets`), the click already reaches `open_accounts` through `accounts_asked`; add `mod ai;
  mod ai_assistant;` (with `#[cfg(not(target_arch = "wasm32"))]`) to `tests/it/main.rs` and the `pub mod`
  lines in `ai_ui.rs`. "Allow agents to run AI commands" can join the page in `agents::page` after the button.
- **Step 8 (FORK.md)**: the ui-egui hook table must name the new places (frame.rs after `dialogs::run`,
  `canvas/document_display.rs`, the crop task bar's `TaskBar` body, `menus/items.rs`/`state.rs`,
  `dialogs::PROMPTS` + `dont_show_again_keys` for the legacy prompt, `credits::about_info`, `links::ABOUT`,
  `start_screen::links`, `updates_ui::check`, `prefs_ui/agents.rs::page` + `custom_rows.rs`,
  `app/prefs.rs::open_suite`/`THEME_FOLDER` + `app/framework.rs::open_suite`), the settings-folder clash table
  gains `Themes/` (and `config.toml`), and the "no update check" section names the result window's Check
  Now/Again. Also note the legacy prompt's "Don't show again" now sticks with Save only.
