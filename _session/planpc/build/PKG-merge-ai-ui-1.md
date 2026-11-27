# Merge 057297b, step "ai-ui part 1" (§6 step 7, part 1 of 3: the AI interface's core)

Branch `claude/pigment-merge-057297b`, one commit on top of the app commit `8ead1af` (hash in the
commit list of this run; message "Pigment merge 057297b, AI interface part 1: …"). Pushed. Only
`pigment/crates/ui-egui` changed.

## What I did

1. **`src/ai_ui.rs`: the stub is working code again**, from 0.5.0's file
   (`git show f4e3ffa:pigment/crates/ui-egui/src/ai_ui.rs`), with:
   - `pub mod accounts; pub mod describe; pub mod generate;` (non-wasm). **Not** `assistant`,
     `assistant_tools`, `task_bar`: those files stay in the tree, not compiled (parts 2 and 3).
   - `menu_items(app) -> Vec<craft::menu::Row>`: `Row::new(path, id, label).enabled(menus::is_enabled(app, id))`,
     `.kind(ItemKind::Check(on))` when `checked` answers. `ITEMS` is unchanged (ids, labels, places);
     a `NOT_PORTED = [ASSISTANT]` list keeps Window › Assistant out of the menus and `SHELL` until
     part 3. `checked` answers `None` for now (part 3: `Some(app.ai.assistant.open)` for ASSISTANT).
   - `handles` back to the shell list (`ai.accounts`, `ai.removeBackgroundWithProvider`);
     `is_enabled`, `gate`, `as_agent`, `agents_allowed` (re-reads `ai.json`), `place_after` as 0.5.0.
   - `install(app, dir)`, `install_accounts`, `install_backend` and the `AppBackend` agents gate,
     `store`, `with_accounts`, `refresh`, `status`, `fits`, `fitting`, `consented`, `account_blocker`,
     `open_accounts`, `menu` (Generate window, Describe, Remove Background local/provider, AI Accounts;
     the `ASSISTANT` arm is gone until part 3), `on_job_event` (Remove Background's `after_remove`,
     describe, generate), `message`, `fixed_in_accounts`, `retryable`, `error_kind`: 0.5.0's code.
   - **`show(app, ui: &mut egui::Ui)`** (step 5's signature): takes `accounts_asked`, then draws
     `generate::show`, `describe::show`, `accounts::show` with `ui.ctx()`. They stay egui windows
     (`egui::Window` for Generate and Describe, `egui::Modal` for AI Accounts, moved to the top so it
     is above Preferences), drawn after `dialogs::run` in `app/frame.rs`. They are not hosted dialogs.
   - `task_bars(app, ui, rect, &CanvasSpace)` and `crop_task_bar_item(app, ui)` still draw nothing
     (part 2). `AiUi` keeps `after_remove` (set by Remove Background now, read by part 2's bar); the
     `bar_prompt` and `assistant` fields are gone until parts 2/3 put them back.
   - `forget_assistant_models(app)`: an empty hook AI Accounts calls where 0.5.0 called
     `assistant::forget_models` (Connect, Remove Key, sign-in/out). **Part 3: make it call
     `assistant::forget_models(app)`.**
   - New `button(ui, label, primary, enabled) -> craft::ui::buttons::ButtonOutput`: the framework's
     `Button` (`Variant::PRIMARY` for the main action). It replaces `crate::widgets::{primary_button,
     secondary_button}` (deleted upstream) in generate.rs, describe.rs and accounts.rs. `hairline` →
     `ui.separator()`. Everything else in those three files is 0.5.0's code unchanged (egui text
     fields, checkboxes, `selectable_label`s, links, `crate::theme::Tokens`, which still exists).
   - **D1, Preferences › AI Integrations:** `preferences_button(ui) -> bool` is replaced by
     **`preferences_rows(ui, &PrefsAi)`**, called from `prefs_ui/agents.rs::page` after the
     framework's `AgentsPage` (so it is on the page `custom_rows.rs` draws): a "Generative AI" line,
     the sentence on what the AI commands use, **AI Accounts…** (framework `Button`; sets
     `accounts_asked`, which `show` opens next pass), and **"Allow agents to run AI commands"**
     (framework `Field` + `Checkbox`, the AI Accounts caption under it). `PrefsAi` (`ai_ui`,
     `#[derive(Clone)]`, `PrefsAi::of(app)`) holds the `accounts_asked` flag and the accounts store;
     `PrefsCustom.ai_accounts` became `PrefsCustom.ai: PrefsAi`, and `agents::page` takes `&PrefsAi`.
     That checkbox is AI Accounts' own setting (`ai.json`), not a preference: the person's click
     saves it **at once** (`AiAccounts::set_allow_agents`), not at OK, as AI Accounts' checkbox does.
     A click in a pass that carries injected input (`WindowHost::of(ui.ctx()).injected_pass()`)
     changes nothing, so an agent can't grant itself the permission from Preferences either.
     Nothing calls `agents::mcp_flag()`, `launcher_allows(` or `AgentSwitch::watch`.

2. **Tests (`tests/it/ai.rs`), compiled again** (`#[cfg(not(target_arch = "wasm32"))] mod ai;` in
   `tests/it/main.rs`):
   - `Harness = egui_kittest::Harness<'static, Box<PhotocraftApp>>` (`PhotocraftApp::new` returns a
     `Box` now); `control::Outcome` → `control::Reply`; `menus::menu_items` → `menus::menu_rows`
     (`i.command.id`); `actions.list.push(..)` returns a `Result` now (`.expect`).
   - `synthetic_click` / `synthetic_type`: `ui.click` / `ui.type` answer `Reply::AfterInput` and the
     window host injects the events in the passes after (upstream removed `take_synthetic_step`):
     a new `until_injected(h)` steps until `WindowHost::injected_idle()`. `pointer_click` is unchanged
     (press and release in one frame work with the framework's buttons and egui's widgets).
   - **Moved out, not compiled yet:**
     `tests/it/ai_task_bar.rs` (new; for part 2): `task_bar_items_appear_only_with_a_key`,
     `generate_background_follows_the_document_the_job_ran_on`, `expand_from_crop_on_a_very_wide_document`,
     `expand_from_crop_keeps_the_frame_where_expand_is_disabled`, `the_bar_generate_sends_one_request`
     (0.5.0's bodies as they were; header names what needs changing: `app.ui.crop_rect` is gone).
     End of `tests/it/ai_assistant.rs` (for part 3): `a_sign_in_serves_the_assistant_and_describe_and_images_ask_for_a_key`,
     with a comment naming the `super::ai::{browser_lands, invoke, plan_harness, plan_server, until_idle}`
     import it needs (those are `pub(super)` in ai.rs now, `PlanServer` and its fields too).
   - **New:** `preferences_allow_agents_to_run_ai_commands_on_the_person_s_click_only` (an agent's
     `ui.click` neither grants nor revokes it; the person's click turns it on and off). Checked that
     it fails with the `injected_pass` guard removed.

## Hand merges / changes to Pigment's code, and why

| File | Change | Why |
|---|---|---|
| `src/ai_ui.rs` | stub → 0.5.0's module on `craft::menu::Row`, framework buttons, `show(ui)`; Assistant and task bars left out | §5.1; parts 2/3 |
| `src/ai_ui/{generate,describe,accounts}.rs` | `crate::widgets::*` → `super::button` / `ui.separator()`; `assistant::forget_models` → `super::forget_assistant_models` | `widgets` deleted upstream |
| `src/prefs/prefs_ui/agents.rs`, `custom_rows.rs` | `preferences_rows(ui, &PrefsAi)` after `AgentsPage`; `PrefsCustom.ai` | D1: AI Accounts… and "Allow agents to run AI commands" on the page |
| `tests/it/ai.rs`, `main.rs`, `ai_task_bar.rs`, `ai_assistant.rs` | above | new APIs; split by part |

Behaviour change against 0.5.0: Preferences › AI Integrations gains "Allow agents to run AI
commands" (0.5.0 had it in AI Accounts only; it is still there too). The user guide
(`docs/user/…`, `docs/generative-ai.md`) should say so (step 8).

## Tests and checks (CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_STRIP=symbols, TMPDIR=/dev/shm/pt, CRAFT_I18N_DIR, CRAFT_FONTS_DIR at cc9269c)

| Command | Result |
|---|---|
| `cargo nextest run --profile ci -p photocraft-ui-egui --test it -E 'test(/^ai::/)'` | **25 run: 25 passed** (the 24 of 0.5.0's 30 that drive part 1, plus the new one) |
| `cargo nextest run --profile ci -p photocraft-ui-egui --lib --tests --no-fail-fast` | see "Full suite" below |
| `cargo clippy -p photocraft-ui-egui --all-targets -- -D warnings` | clean |
| `cargo fmt -p photocraft-ui-egui -- --check` | clean |

Not run: the wasm build (not in Pigment's CI; the `web` module keeps the signatures: `install`,
`menu`, `on_job_event`, `show`, `task_bars`, `crop_task_bar_item`, `preferences_rows`,
`open_accounts`), `apps/photocraft` (its `ai_ui::install(&mut app, &dir)` call is unchanged),
`xtask panel-commands` (the AI windows' clicks call `ai_ui` functions that run commands; check in
step 9 whether the xtask scans `ai_ui`).

## Left for parts 2 and 3

- **Part 2 (task bars):** port `ai_ui/task_bar.rs` (uses `crate::widgets::task_bar`, `ViewXform`,
  `app.ui.crop_rect`, `app.ui.dialogs`) onto `craft::ui::canvas_controls::TaskBar` as
  `tools/crop_task_bar.rs` does; put `pub mod task_bar;` and the `bar_prompt` field back; fill
  `task_bars` (hook in `canvas/document_display.rs`, gets `rect` and `CanvasSpace`) and
  `crop_task_bar_item` (hook in the crop task bar's `TaskBar` body); `mod ai_task_bar;` in
  `tests/it/main.rs` and port those five tests (`crop_task_bar::eligible`,
  `app.canvas_tools.crop.tool.frame()` instead of `crop_rect`). The harness turns the context task
  bar off (`app.ui.panels.context_task_bar = false`) as 0.5.0's did.
- **Part 3 (Assistant):** `pub mod assistant; pub mod assistant_tools;`, the `assistant` field,
  drop `ASSISTANT` from `NOT_PORTED` and add it to `SHELL`, `checked` → `Some(app.ai.assistant.open)`,
  the `ASSISTANT => assistant::toggle(app, params)` arm in `menu`, `assistant::on_job_event` in
  `on_job_event`, `assistant::show` in `show`, `forget_assistant_models` → `assistant::forget_models`;
  `craft_ui::ComboBox` → `craft::ui::choice::Select` or egui's; `app.ui.dialogs` → `app.dialog_open()`;
  `mod ai_assistant;` in `tests/it/main.rs` and the moved sign-in test at its end.
- **Step 8 (FORK.md):** the hook table: `ai_ui::show(self, ui)` in `app/frame.rs`,
  `ai_ui::preferences_rows` in `prefs_ui/agents.rs::page`, `PrefsCustom.ai` in `custom_rows.rs`,
  `ai_ui::menu_items` returning `craft::menu::Row`s in `menus/items.rs`.
