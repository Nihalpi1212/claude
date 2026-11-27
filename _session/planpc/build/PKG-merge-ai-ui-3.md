# Merge 057297b, step "ai-ui part 3" (§6 step 7, part 3 of 3: the Assistant)

Branch `claude/pigment-merge-057297b`, commit **`acdfbdb`** "Pigment merge 057297b, AI interface part 3:
the Assistant on the framework", on top of part 2's `ab3c8c7`. Pushed. Only `pigment/crates/ui-egui`
changed (`src/ai_ui.rs`, `src/ai_ui/assistant.rs`, `src/ai_ui/assistant_tools.rs`, `tests/it/ai.rs`
(one doc line), `tests/it/ai_assistant.rs`, `tests/it/main.rs`). **Nothing of the AI interface is
stubbed any more**: every `ai_ui` module of 0.5.0 compiles and is wired; the only no-op code left is
the browser build's `web` module, as in 0.5.0.

## What I did

1. **`src/ai_ui.rs`**: `pub mod assistant; pub mod assistant_tools;` (non-wasm); the `assistant:
   assistant::State` field on `AiUi`; `NOT_PORTED` removed (Window › Assistant is in `menu_items`
   again, after Window › Adjustments, as a `Row` with `ItemKind::Check(open)`); `ASSISTANT` back in
   `SHELL`; `checked` answers `Some(app.ai.assistant.open)` for it (also used by `menus/state.rs`'s
   hook for the native menu); `menu` has the `ASSISTANT => assistant::toggle(app, params)` arm;
   `on_job_event` asks `assistant::on_job_event`; `show` draws `assistant::show` (between Describe and
   AI Accounts, as 0.5.0); `forget_assistant_models` calls `assistant::forget_models`. Module doc:
   the "ported in three parts" paragraph is gone.
2. **`src/ai_ui/assistant.rs`** (0.5.0's file with these changes):
   - `crate::widgets::{primary_button, secondary_button}` → `super::button` (framework `Button`;
     Send primary, Stop/Clear/AI Accounts… secondary; Stop is disabled while stopping instead of
     `add_enabled_ui`; hover texts on `ButtonOutput.response`). `hairline` → `ui.separator()`.
   - **Model picker**: `craft_ui::ComboBox` (no longer a dependency; egui's `ComboBox` is disallowed by
     `clippy.toml`) → **`craft::ui::pickers::Select<String>`** labelled "Chat model", entries
     Automatic (`""`, "Automatic (<model>)") then the listed models (the current model first when it
     is not listed); a pick that differs from the current one becomes `Act::Model` (empty =
     automatic), so the existing `set_model` path saves it. The visible "Chat model:" label stays.
   - **Dialog wait**: `app.ui.dialogs` is gone. `poll` reads `app.dialog_count()` (the framework
     dialog host's stack) once before borrowing the turn: a step that opened a dialog waits while
     `dialog_count() > open_before`; no queued step runs while any hosted dialog is open.
3. **`src/ai_ui/assistant_tools.rs`**: `run_command` records `open_before = app.dialog_count()` and
   reports `Outcome::Dialog` when the count rose after `menus::invoke`. `crate::filter_dialog::{Kind,
   parse_spec}` is gone upstream (filter dialogs are the framework's `HostedParamDialog`): `blocked`'s
   choice lists and `Ranges::of` now read **`craft::ui::patterns::form_dialogs::Param::parse_list`**
   (the same notation parser, now in craft; `ParamKind::Choice` options are `(id, label)`, the ids are
   used; `Range` bounds are already `f64` parsed from the spec text, so 0.5.0's f32 → decimal-text
   detour is dropped; `doc`/`json` keys are no longer listed at all, which `blocked` and `Ranges`
   never used).
4. **Tests**: `mod ai_assistant;` in `tests/it/main.rs` (non-wasm). In `ai_assistant.rs`:
   `fn app() -> Box<PhotocraftApp>`; `menus::menu_items` → `menus::menu_rows` (`command.id`,
   `kind == ItemKind::Check(..)`); `a_command_that_opens_a_dialog_waits_for_the_person` waits for
   `app.dialog_open()` and ends the dialog with `ui.inspect` + `ui.dialog.cancel` (was
   `ui.dialogs.clear()`); the moved ChatGPT sign-in test now imports `browser_lands, invoke,
   plan_harness, plan_server, until_idle, control` from `super::ai` and `describe, generate`.
   **New** `the_chat_model_is_picked_in_the_window`: lists models through the window, opens the
   "Chat model" select with a pointer click, picks "chat-b" (saved, list closed, face shows it), then
   "Automatic (gpt-5)" (back to automatic).

## Hand merges / changes to Pigment's code

| File | Change | Why |
|---|---|---|
| `src/ai_ui.rs` | Assistant wired back (module, field, row, check, shell id, menu arm, job events, show, forget_models) | part 3 |
| `src/ai_ui/assistant.rs` | framework `Button`/`Select`, `ui.separator()`, `dialog_count()` | §5.1: `widgets`, `craft_ui::ComboBox`, `app.ui.dialogs` gone |
| `src/ai_ui/assistant_tools.rs` | `dialog_count()`, `Param::parse_list` | `app.ui.dialogs`, `filter_dialog::parse_spec` gone |
| `tests/it/ai_assistant.rs`, `main.rs`, `ai.rs` | above | new APIs |

Behaviour against 0.5.0: the chat model picker is the framework's select (keyboard, type-ahead and
wheel as every other select in the app); otherwise unchanged. No new interface strings except the
select's accessible name "Chat model" (`tl!`).

## Tests and checks (CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_STRIP=symbols, TMPDIR=/dev/shm/pt, CRAFT_I18N_DIR, CRAFT_FONTS_DIR at cc9269c)

| Command | Result |
|---|---|
| `cargo nextest run --profile ci -p photocraft-ui-egui --lib -E 'test(/ai_ui::/)'` | **9 run: 9 passed** (the `assistant_tools` unit tests) |
| `cargo nextest run --profile ci -p photocraft-ui-egui --test it -E 'test(/^ai::/) \| test(/^ai_assistant::/) \| test(/^legacy_pigment::/)'` | **63 run: 63 passed** (31 ai, 30 ai_assistant, 2 legacy_pigment), before the new select test |
| `cargo test -p photocraft-ui-egui --test it -- ai ai_assistant legacy_pigment` (the step's literal command; the filters match by substring) | **74 passed, 0 failed** |
| `… -E 'test(/^ai_assistant::/)'` after the new test | 31 passed (the new one also alone) |
| `cargo clippy -p photocraft-ui-egui --all-targets -- -D warnings` | clean |
| `cargo fmt --all -- --check` | clean |
| `cargo xtask panel-commands` | OK (0 direct mutations, 0 allow-listed) |
| `pigment-rebrand.py --check` | only `crates/raw/src/shared.rs` (step 8, as before) |
| `cargo nextest run --profile ci -p photocraft-ui-egui --lib --tests --no-fail-fast` (on `acdfbdb`) | **3724 run: 3724 passed, 6 skipped** (upstream's menu tests with Window › Assistant in) |

Screenshot evidence (`PIGMENT_AI_EVIDENCE_DIR`): the Assistant window renders with the framework
buttons and the select ("Automatic (gpt-5)") as 0.5.0's layout.

## Left (not this step)

- **Step 8 (FORK.md)**: the hook table: `ai_ui::checked` in `menus/state.rs::checked` (Window ›
  Assistant's check mark, native menus); the Assistant is drawn by `ai_ui::show(self, ui)` after
  `dialogs::run` in `app/frame.rs` (an egui window, not a hosted dialog); it reads the dialog host
  through `PhotocraftApp::dialog_count()` (upstream's `app/framework.rs`). `docs/generative-ai.md`
  may say the model picker is a select with keyboard and type-ahead.
- Not run: the wasm build (the `web` module's signatures are unchanged and `assistant` is non-wasm),
  `apps/photocraft` (no signature it calls changed).
