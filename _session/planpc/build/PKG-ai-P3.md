# PKG ai-P3: the interface (menus, Generate window, AI Accounts, Describe, task bars, app wiring)

Branch `claude/pigment-photocraft`. Two local commits, not pushed:

- `a042ddc`: the interface, its hooks and tests;
- `d2be723`: the docs (`docs/generative-ai.md` › The interface, FORK.md rows).

## What was built

All the new code is in `crates/ui-egui/src/ai_ui.rs` and `crates/ui-egui/src/ai_ui/`. The design is in `docs/generative-ai.md`, section "The interface".

### `ai_ui.rs`

- **Compiled on every target.** The browser build keeps the same signatures as stubs (`mod web`), so no hook needs a `cfg`.
- **`AiUi`** is held in the new `PhotocraftApp.ai` field. It holds:
  - `store`: the shared `Arc<Mutex<AiAccounts>>`;
  - `status`: a cached `BackendStatus`, refreshed on events and never per frame;
  - the window states, the task bar's prompt and `after_remove`;
  - the `agent` flag.
- **Setup:**
  - `install(app, dir)` installs the accounts and the backend. The desktop app calls it.
  - `install_accounts(app, AiAccounts)` does the same with given accounts (used by the tests).
  - `refresh` re-reads the status. `fits`, `fitting`, `consented` and `account_blocker` answer from that cache.
- **Menus:** `ITEMS` holds each item as (id, label, path, the item it follows). `menu_items`, `place_after`, `handles` and `is_enabled` serve the menus and the palette. The shell has two commands of its own: `ai.accounts` and `ai.removeBackgroundWithProvider`.
- **`menu(app, id, params)`:**
  - With no params, or with only `prompt`, a feature command opens the Generate window.
  - With any other params, the engine command runs directly.
  - Describe asks the provider at once.
  - Remove Background runs `local`. "with AI Provider" runs `provider` after the account checks, and opens AI Accounts when a check fails.
- **`on_job_event`:** the windows take the jobs they started. It also arms the Generate Background bar after any Remove Background (`ai.removeBackground` or `layer.removeBackground`).
- **`gate` and `as_agent`:**
  - A control request or synthetic input may run a command for which `may_send` is true only while `allowAgents` is on. The setting is re-read each time.
  - The person's own input is never gated.
  - AI Accounts also ignores synthetic clicks on keys, consent and permissions, so an agent cannot grant itself access.

### `ai_ui/generate.rs`: the Generate window

- One non-modal window covers Fill, Expand, Generate Image, Generate Background and Sky Replacement.
- **Prompt:** prefilled with the feature's last prompt from `ai.json`. Sky Replacement starts with JS's default.
- **Options:**
  - Fill: variations 1 to 3.
  - Expand: width, height and a 3×3 anchor.
  - Generate Image: a layer or a new document, its size, and transparency.
- **Provider and model:** the provider row shows only when two providers fit. The model field applies to this request only. The chosen provider is saved as `imageProvider`.
- **Running:**
  - Generate is dimmed with the reason in its tooltip.
  - While a request runs it becomes Stop, with the elapsed time.
  - An error offers Open AI Accounts… or Try Again.
  - A note says what the feature sends, and that a stopped request may still be billed.
- **Public API:** `open`, `close`, `blocked`, `params`, `start`, `stop`.
- The window runs `app.run(feature, params)`, so it goes through `jobs_ui`, the gate and the status bar like any other command.

### The other files

- **`ai_ui/describe.rs`:** the result window, with Copy, Use as Document Description (`file.fileInfo {"description"}`, one undo step) and Close. A failure shows there too, with AI Accounts when that is the fix.
- **`ai_ui/accounts.rs`: AI Accounts** is a modal. It has:
  - the billing and privacy wording;
  - OpenAI and Gemini tabs;
  - the key state (a hint and where the key is stored);
  - a masked key field with Connect, which checks the key on a worker thread with `provider_with_key` and `list_models`, then runs `set_key` and `cache_catalog`. The field is wiped, and its egui `TextEditState` is dropped whenever it is empty;
  - Test Connection (a worker thread), Remove Key and Get a key…;
  - the preferred provider;
  - chat and image models, with Automatic and Use Suggested;
  - the timeout;
  - `CONSENT`;
  - Allow agents to run AI commands.
- **`ai_ui/task_bar.rs`:**
  - A selection bar with a prompt field and Generate, which runs Fill at once.
  - The Generate Background… bar after Remove Background.
  - The Crop bar's Generative Expand. The frame's size and the sides it reaches past become the width, height and anchor; then the frame is let go.
  - All of them show only once a provider has an image key.

## Decisions (recorded in `docs/generative-ai.md`)

- **Placement** follows the brief's Photoshop places:
  - Edit: Generative Fill… after Content-Aware Fill, then Generate Image… and Sky Replacement…, and AI Accounts… after Toolbar….
  - Layer: Remove Background, Remove Background with AI Provider and Generate Background…, after Mask All Objects.
  - Describe Image… goes in Image, after Calculations…. INTEGRATION.md places it in Image, which the brief allows.
  - Generative Expand is in the palette (no menu path) and in the Crop task bar.
  - Generative Fill is also a row of `SELECTION_MENU`.
- **The AI shell commands are not in `engine::shell_commands`.** `ai.accounts` and the provider Remove Background live in `ai_ui`, so the web build and headless shortcut sets don't list them. The cost: they can't be bound under Edit › Keyboard Shortcuts; the engine's `ai.*` commands can.
- **Remove Background with a provider** is a separate Layer item, the JS feature. The menu default is local.
- **The Crop options bar's Fill: list keeps its two entries**, because its state is a saved bool. Generative Expand lives in the task bar slot instead.
- **Model per request:** the window's model field is not saved. AI Accounts holds the saved model.
- **Connect checks the key before storing it**, as JS did. There is no "save without checking" in the dialog; `pigment-cli ai set-key --no-check` covers that.
- **Closing the Generate window leaves its job running.** The status bar shows the job with Cancel. A failure after the window closes falls back to the shell's notice.

## Hooks into upstream files (all in FORK.md, under "What Pigment added › Generative AI")

- `crates/ui-egui/Cargo.toml`:
  - `pigment-genai` (not on wasm);
  - the dev-dependency on `photocraft-engine` with `testgen`.
- `crates/ui-egui/src/lib.rs`: `pub mod ai_ui;` and `pub ai: ai_ui::AiUi`.
- `crates/ui-egui/src/app.rs`: `ai: Default::default()`.
- `crates/ui-egui/src/app/frame.rs`: `crate::ai_ui::show(self, &ctx)` after `dialogs::show`.
- `crates/ui-egui/src/app/commands.rs`: `crate::ai_ui::gate(self, id, &params)?` in `run_command_at_depth`.
- `crates/ui-egui/src/control.rs`: `handle` wraps `dispatch` in `ai_ui::as_agent`.
- `crates/ui-egui/src/menus/items.rs`:
  - `is_live` gets `|| ai_ui::handles(id)`;
  - `extra.extend(ai_ui::menu_items(app))`;
  - the `PLACE_AFTER` lookup falls back to `ai_ui::place_after`.
- `crates/ui-egui/src/menus/state.rs`: `is_enabled` asks `ai_ui::is_enabled`.
- `crates/ui-egui/src/menus/invoke.rs`: `ai_ui::menu` in `invoke_early_commands`.
- `crates/ui-egui/src/jobs_ui.rs`:
  - `on_event` gives `ai_ui::on_job_event` the event first;
  - `dialog` skips `ai.*` jobs (no modal).
- `crates/ui-egui/src/canvas.rs`: `ai_ui::task_bars(app, ui, xf)` after `crop_task_bar::draw`.
- `crates/ui-egui/src/tools/crop_task_bar.rs`: `ai_ui::crop_task_bar_item` in the slot.
- `crates/ui-egui/src/canvas/canvas_tool_menu.rs`: the `Generative Fill…` row and its doc line.
- `crates/ui-egui/src/canvas/canvas_tool_menu/tests.rs`: the expected selection-menu order includes the new row.
- `crates/ui-egui/src/prefs/prefs_ui/agents.rs`:
  - the Generative AI rows (`ai_ui::preferences_button`);
  - the `aiAccounts` action.
- `crates/ui-egui/tests/it/main.rs`: `mod ai;` (not on wasm).
- `apps/photocraft/src/main.rs`: `ai_ui::install(&mut app, &dir)` with `services::config_dir()`.

## Tests

`crates/ui-egui/tests/it/ai.rs` has 12 kittest tests. They drive the whole app through `build_eframe`. The features run against `MockBackend`, and AI Accounts against a `TcpListener` on 127.0.0.1. Nothing reaches the network. The tests check that:

- the menu places and their order are right, there is no AI menu, and the selection menu has a Generative Fill row;
- items are dimmed for a missing backend or selection, never for a missing key;
- Fill sends nothing before Generate, runs in the background with no modal and with Stop shown, sends the prompt, lands one "Generative Fill" layer, and one Undo takes it back;
- Stop cancels a request that never answers, and the note mentions billing;
- without a key, or without the agreement, Generate is dimmed, Open AI Accounts… opens AI Accounts, and nothing is sent;
- AI Accounts:
  - Connect sends exactly one `/v1/models` check;
  - the "ends in …WXYZ" hint and "OpenAI connected." are shown;
  - the key appears nowhere: not in the accessibility tree, `ui.inspect`, `UiState`, the preferences, the menus or `ai.status`;
  - Test Connection reports "3 models available";
  - the consent checkbox saves `consented`, and Done closes the dialog;
- Preferences › AI Integrations' button opens AI Accounts;
- Describe shows the answer, Use as Document Description sets the description, and one Undo restores it;
- Describe without a provider opens AI Accounts and sends nothing;
- task bars:
  - none without a key;
  - the selection bar appears with a key, and its Generate runs Fill;
  - Remove Background with the provider is followed by the Generate Background… bar;
  - the Crop bar's Generative Expand sets width 250, height 160 and anchor `right`, and drops the frame;
- agents:
  - `engine.execute ai.generativeFill` is refused with "Allow agents…" and sends nothing;
  - `ai.status` passes;
  - with `allowAgents` on, the agent's call goes through;
  - the person's own call goes through without it;
- the last prompt comes back from `ai.json`, and Sky Replacement starts with its default prompt.

The selected in-crate lib tests are covered under "Checks run" below.

## Checks run

- **`cargo test -p photocraft-ui-egui --test it -- ai::`:** 12 of 12 pass.
- **The whole `it` binary:** 322 pass and 4 fail. The four failures are all `custom_print_paper::*`, which panic with "No glyph for は": CJK fonts are missing in this container. This is the brief's known craft-fonts case, and the module does not touch AI.
- **`cargo fmt --all -- --check`:** clean.
- **`cargo clippy -p photocraft-ui-egui --lib --test it -- -D warnings`:** clean.
- **`cargo clippy -p photocraft --bin pigment -- -D warnings`:** clean.
- **The selected lib tests (`cargo test -p photocraft-ui-egui --lib -- menus canvas_tool_menu agents jobs_ui shortcut control::tests palette crop_task_bar`):** 622 pass. `selection_menus_follow_photoshop_order` now expects the new row (a one-line hook, listed in FORK.md). One test fails: `type_tool::canvas_tests::temporary_type_transform_…`, with a missing glyph (container fonts, unrelated).
- **`scripts/pigment-rebrand.py --check`:** clean.

## Not done / for later

- **Window › Assistant (P4).** No `window.panel.aiAssistant` row exists yet.
- **No wasm check of ui-egui was run** (`cargo check -p photocraft-web --target wasm32-unknown-unknown`): there was not enough time and disk. The `web` stubs mirror the native signatures used by the hooks. Run the check first in P4.
- **No i18n rows.** All strings are English through `tl!`.
- **AI Accounts has no Sign in with ChatGPT row yet (P5).** Add it in `accounts.rs` `key_rows` for OpenAI, marked experimental behind one constant.
- **No variation picker.** Each variation is its own layer, as in JS.
- **Actions playback of an inserted `ai.*` step by an agent** (`actions.play` from MCP) goes through the engine's step authorizer, not `ai_ui::gate`. Recording never stores `ai.*`, so only a hand-built action could contain one. If that matters, add `may_send` to `authorize_desktop_engine_step`.
- **Status freshness.** The cached status refreshes when a window opens, after an AI Accounts action, and on install. A key set externally with `pigment-cli ai set-key` while the app runs shows once a window opens.

## For P4 (the Assistant)

- **Tools:** run them through `menus::invoke` or `app.run`; `ai_ui::gate` already applies to agents. The in-app Assistant is the person (not `automation_input`), so `ai.generativeFill` passes. Keep the JS allowlist.
- **The backend:** use `app.session.generative()`. The accounts are in `ai_ui::store(app)` and `ai_ui::with_accounts`; the settings `chat_provider` and `models(p).chat_model` are there.
- **Adding `window.panel.aiAssistant`:**
  1. Add an `ITEMS` row in `ai_ui.rs` with path `["Window"]` (or add it to `shell_commands` if it should be bindable).
  2. Add it to `SHELL`.
  3. Answer `checked` with a small hook in `menus/state.rs`.
- **Failures:** use `ai_ui::on_job_event` to take the Assistant's `ai.chat` job events; it returns `true` when it handles one.
- **Tests:** follow `tests/it/ai.rs`: `harness(prepare)`, `with_mock`, `until_idle`.
