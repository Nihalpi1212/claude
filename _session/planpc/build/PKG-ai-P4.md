# PKG ai-P4: the Assistant (Window › Assistant, its tools and the turn)

Branch `claude/pigment-photocraft`. Four commits, all pushed:

- `d39ce30` Pigment: Window › Assistant, the chat that edits the document (the code and its tests)
- `9e34d4f` Pigment: document the Assistant, and test its background steps and closed documents
- `a3f9673` Pigment: the Assistant keeps one full image, and bounds what an answer may ask for
- `d361bd0` Pigment: the Assistant's instructions spell out every adjustment's params

The contract is `pigment/docs/generative-ai.md` › "The Assistant". Read that first; this note is what
the next engineer needs beyond it.

## What was built

All new code is in two files under `crates/ui-egui/src/ai_ui/`. No engine change (INTEGRATION.md §6.6
asked for none) and no new hook into the frame loop: `ai_ui::show` already runs once a frame.

### `assistant.rs`: the window and the turn

- **`State`** (the new `AiUi.assistant` field, not on wasm): `open`, `input`, `attach`, the
  conversations (`HashMap<DocId, Vec<Message>>`), the running `Turn`, the model lists, `note`.
  Nothing of it is in `UiState`, the preferences or `ai.json`, so `ui.inspect` never shows a
  conversation.
- **`Message`**: `role`, `text`, `image` (the full composite, kept on the latest message only),
  a private 96 px preview, `calls: Vec<Call>`, `pending`, `error`, `needs_accounts`, `stopped`,
  `truncated`. **`Call`**: `name`, `args`, `result` (`None` while it runs), `waiting` (a dialog is up).
- **Public API** (what the tests drive): `open`, `toggle(params)`, `is_open`, `send(app, text) ->
  Result<bool, String>`, `stop`, `clear`, `running`, `stopping`, `messages`, `conversation(doc)`,
  `provider`, `model(p)`, `set_provider`, `set_model`, `set_attach`, `list_models`, `listed_models`.
- **`send`**: in this order: a document, no turn running, non-empty text, the agent check, a chat
  provider and the agreement (AI Accounts opens and `Ok(false)` leaves the typed text), the
  backend's `admit`. Then it stores the message (with `photocraft_compose::thumbnail(doc, 1024)`
  when Attach image is on) and starts the first round.
- **A round** is `session.start_job("ai.chat", {}, "Assistant", lock = false, work, apply)`. The
  worker calls `backend.chat(&req, &|| ctx.cancelled())`; `apply` leaves the `ChatTurn` in an
  `Arc<Mutex<Option<ChatTurn>>>` the turn holds. `ai.chat` is a job id, not an engine command; the
  `ai.` prefix is what keeps the modal progress window away (`jobs_ui::dialog`).
- **`poll`** (from `show`, once a frame, also while the window is closed) moves the turn on: one
  tool call a frame; then `ChatMessage::ToolResults` is appended and the next round starts. It also
  drops conversations of closed documents.
- **`on_job_event`** (called from `ai_ui::on_job_event`): takes the chat job's event (returns
  `true`), the model list's, a dropped request's; for a tool's job it records the result and returns
  `false`, so the shell reports the job as it does for any command.
- **The history sent** each round: the stored messages that are not pending and not failures, as
  `ChatMessage::User`/`Assistant` (only the last carries its image), then for this turn
  `ChatMessage::Turn(turn)` and `ChatMessage::ToolResults(..)` per round, as P2's notes asked.

### `assistant_tools.rs`: the tools and the checks

- `tools() -> Vec<ToolSpec>` (15: JS's 14 and `list_commands`), `instructions() -> String`,
  `run(app, ctx, name, args) -> Result<Outcome, String>`, `blocked(id, params) -> Result<(), String>`,
  `describe_call(name, args, failed)`.
- `Outcome::{Done(Value), Job { job, then }, Dialog { open_before, result }}`: a tool whose command
  became a background job (anything with `app.background_jobs`, which the desktop app sets) gives
  `Job`, and `then` turns the job's result into the tool's.
- Helpers, all with JS's messages: `parse_maybe_json`, `object_arg`, `value_arg`, `sanitize_params`,
  `rect_arg`, `color_arg` (with the 148 CSS colour names), `capped`, `dialog_result`.
- The kinds of `apply_adjustment` and `apply_filter` are the registry's `image.adjustments.*` and
  `filter.*` ids (minus `NOT_A_KIND`); `find_kind` accepts any spelling. Ranges for clamping come
  from `filter_dialog::parse_spec` of the command's own params string.

### Other changes

- `crates/genai/src/settings.rs`: `AiSettings.assistant_attach` (`assistantAttach`, default true; an
  older `ai.json` without it reads as true).
- `ai_ui.rs`: the `ASSISTANT` id (`window.panel.aiAssistant`), its `ITEMS` row (Window, after
  Adjustments) and `SHELL` entry, `checked(app, id)`, `set_agent_now` made `pub(crate)`, the two
  modules, `assistant::toggle` in `menu`, `assistant::on_job_event` and `assistant::show`.
- `tests/it/ai.rs`: its helpers (`harness`, `with_mock`, `type_into`, `synthetic_click`, …) are now
  `pub(super)` so `ai_assistant.rs` shares them.

## Hooks into upstream files (both in FORK.md, "What Pigment added › Generative AI")

| File | Hook |
|---|---|
| `crates/ui-egui/src/menus/state.rs` | `checked` asks `crate::ai_ui::checked(app, id)` (4 lines, marked `// Pigment: Window › Assistant.`) |
| `crates/ui-egui/tests/it/main.rs` | `mod ai_assistant;` (not on wasm) |

Everything else P4 touches is Pigment's own files. The existing hooks P3 placed (`frame.rs` →
`ai_ui::show`, `jobs_ui.rs` → `ai_ui::on_job_event`, `invoke.rs` → `ai_ui::menu`, `items.rs` →
`ai_ui::menu_items`) carry the Assistant without change; their FORK.md rows now mention it.

## Decisions taken here (all recorded in docs/generative-ai.md)

- **A floating window, Window › Assistant**, after Adjustments (the brief's decision 2). The item is
  the shell's, in `ai_ui::ITEMS`, like P3's: not in `engine::shell_commands`, so it has no row in
  Edit › Keyboard Shortcuts and does not exist on the web build.
- **`list_commands` replaces the command list** in the instructions; the adjustment and filter
  kinds are still inlined with their params (about 15,000 characters of instructions in all; a
  filter's spec over 160 characters is left as `{…}`, every adjustment is spelt out).
- **Ranges come from each command's params spec**, not from JS's two tables (whose parameter names
  don't exist here).
- **The specific tools never open a dialog** (they call `app.run` with params). `run_command` goes
  through `menus::invoke`, so without params a command with a dialog opens it, and the turn waits for
  the person, as JS did.
- **The blocked list is wider than INTEGRATION.md's**, in JS's spirit ("close things, quit, open
  native dialogs, talk to the providers"): also `prefs.*`, `plugin.*`, `updates.*`, `ui.*`, most of
  `actions.*`, `document.*` and `session.*` (the read-only ones pass), what can't be undone, every
  import and export, and any command with a param naming a file, folder or script. The exact rules
  are `ALLOWED`, `BLOCKED_PREFIXES`, `BLOCKED_IDS`, `PATH_KEYS` and `moves_files` in
  `assistant_tools.rs`; the unit test there asserts every `ai_cmds::COMMANDS` id but Generative Fill
  is blocked, whatever is added later.
- **The model list is asked for** (List models, or AI Accounts' list from the last ten minutes),
  never fetched when the window opens: this port sends nothing unasked. Automatic needs no list.
- **The provider and chat model are read from `ai.json` each time**, not cached in the window, so a
  change in AI Accounts is the Assistant's at once.
- **Stop** drops a request in flight at once; a step running as a job or waiting on a dialog is let
  finish (JS's "Stopping after the current step…").
- **A step waits while the person has a dialog open** (`app.ui.dialogs` not empty), so it never
  edits behind one.
- **Two bounds JS did not have**: the model's text is kept to 20,000 characters, and an answer with
  more than 32 tool calls fails the turn before any runs.

## Tests

New, all against the engine's `MockBackend` (no network):

- `crates/ui-egui/tests/it/ai_assistant.rs`: 23 kittest tests. A `Recorder` there wraps the mock and
  keeps every `ChatRequest` whole (the mock only counts messages and tools).
  - The tools without a window (`tools::run` on a `PhotocraftApp`): the layer tools and ids;
    `fill_selection` and alpha; adjustments and filters clamped, kinds however spelt, params as JSON
    text; `select` and `add_text`; `canvas_size` (with and without a Background), `crop`,
    `resize_image`; `list_commands`; `run_command` runs, refuses, reads JSON text; among the `ai.*`
    commands only Generative Fill runs. Each editing tool is checked to be exactly one history step
    that Undo and Redo walk (`one_step`).
  - The turn in the app: the image (2048 × 512 document → 1024 × 256), the tools and the instructions
    go out, the tool's result and the model's turn (with its `provider_state`) come back, one undo
    step, the labels shown, Enter sends; later messages send only the latest image, Attach image
    off sends none, Shift+Enter is a new line; the 12-round limit is reported and "Done."; an
    answer with 200 tool calls runs none; Stop in flight and between steps; a step that runs as a
    background job is waited for, and Stop lets it finish; a dialog makes the turn wait; a
    conversation per document, a tool refused once its document is not active, Clear and closing
    the document; 40 messages kept; blocked commands refused and the model told; agents (synthetic
    click on Send, `as_agent`) refused without "Allow agents to run AI commands", nothing connected
    opens AI Accounts and keeps the text, a failed request shows AI Accounts; the Window item, its
    check mark, the saved choices and the model list.
  - `PIGMENT_AI_EVIDENCE_DIR=<folder>` makes three of them save a PNG of the window (empty, working,
    after a turn), for a look.
- `crates/ui-egui/src/ai_ui/assistant_tools.rs`: 6 unit tests (the blocked list, the instructions
  and the curated commands exist, kind lookup, argument parsing and clamping, colours, result caps).
- `crates/genai/tests/genai/keys.rs`: `assistantAttach` saved, read back, defaulted.

Results here (all on the final tree):

- `cargo test -p photocraft-ui-egui --test it -- ai`: 77 pass (23 new, 17 of P1 to P3 and the
  review, and others the filter matches).
- The whole `it` binary: 352 pass, 1 ignored (before the last commit; with `CRAFT_FONTS_DIR` set).
- `cargo test -p photocraft-ui-egui --lib -- ai_ui menus canvas_tool_menu parity shortcut palette
  agents jobs_ui control::tests native_menu`: 629 pass.
- `cargo test -p pigment-genai`: 2 + 42 pass, 1 ignored. `cargo test -p photocraft-cli --test it -- ai`:
  9 pass. `cargo test -p xtask`: 88 + 13 pass.
- `cargo nextest run --profile ci -p photocraft-ui-egui -p pigment-genai --lib --tests -E
  'test(/ai_assistant|ai::|ai_ui|keys::/)'`: 169 pass (CI's runner).
- `cargo clippy -p photocraft-ui-egui -p pigment-genai --all-targets -- -D warnings`: clean.
  `cargo fmt --all -- --check`: clean.
- `cargo check --target wasm32-unknown-unknown -p photocraft-ui-egui -p pigment-genai`: compiles
  (the same three upstream warnings as before).
- `cargo xtask layers`, `panel-commands`, `scorecard --check`: pass. `scripts/pigment-rebrand.py
  --check`, `cargo metadata --locked`: clean.
- A mutation run: with `blocked` switched off, all images resent and the active-document check
  removed, five of the tests fail as they should. Removing the agent check in `send` alone does not
  fail a test, because the app's backend (`AppBackend::admit`) refuses the same call with the same
  message: there are two guards and the tests see the behaviour, not which one held.
- Not run: the whole workspace suite and the engine's `panic_hunt` (no engine command was added or
  changed). CI runs both.

## Pitfalls met (so you don't meet them again)

- `clippy::cognitive_complexity` (30) is on for tests: a test with more than about 25 asserts fails
  clippy. Split it.
- `egui::ComboBox` is a disallowed type here; use `craft_ui::ComboBox`.
- The mock's script is one queue for chat and images: a turn that runs Generative Fill needs
  `answer(calls)`, then `MockAnswer::Solid(..)`, then the final `answer(text)`, in that order.
- A request the mock never answers (a 60 s delay) leaves its scripted answer in the queue when it
  is cancelled; don't script one for it.
- `f32` ranges from `parse_spec` must go through their decimal text to become `f64` (0.1f32 as f64
  is 0.100000001, which a command refuses at the upper bound).
- `menus::invoke` of a filter returns the command's own result (`{"filter": …, "layer": …}`), and
  `edit.undo` returns `true`; only a command with no result reads "ok".
- `jobs_ui::cancel` writes "Canceled Assistant" in the status bar; that is the shell's wording for
  any cancelled job, not an error.

## Not done

- **No i18n rows.** Every string is English through `tl!`. The tool descriptions and the
  instructions are English on purpose (they are for the model).
- **The release notes and the README still say the generative AI is not in 0.5.0**
  (`docs/RELEASE-NOTES-0.5.0.md` lines 37 and 233, `README.md`). P1 to P4 left them for the docs and
  release task; they are now wrong for everything but Sign in with ChatGPT. `docs/gaps.md` (G15) and
  `docs/target-app-parity.md` are upstream's and unchanged.
- **Not bindable.** `window.panel.aiAssistant` and `ai.accounts` are not in
  `engine::shell_commands`, so they have no Keyboard Shortcuts row. Move them there if a shortcut is
  wanted (then the web build needs them hidden).
- **The attached image is composed on the interface thread** at Send (`thumbnail(doc, 1024)`).
  Large documents use the compositor's proxy; composing on the request's worker is the refinement.
- **No streaming.** The answer appears when the request ends, as in JS (which folded SSE into one
  answer too).
- **The Assistant's window is not a docked panel** (JS: a panel in the bottom group).
- **Gemini's `functionResponse` carries no call id** (P2's note, unchanged).
- **A turn started by an agent runs its tools as the person's** once it was admitted ("Allow agents
  to run AI commands" was on at Send). Turning the switch off mid-turn does not stop that turn.
- **The interactive look was checked from three offscreen renders only** (the PNGs above); IME in the
  message field and the native macOS menu item were not exercised.
- CI: see "CI" below.

## CI

Pigment CI is green on the first commit (d39ce30, run 180) and on the last (d361bd0, run 183): the
whole workspace suite under cargo-nextest, the panic hunt, the doctests, the repository checks and
the CLI smoke test. Runs 181 and 182 were replaced in the queue by the next push (shown as
cancelled), not failed. The engineer was stopped by a usage limit while waiting for run 183; this
section was added by the orchestrator afterwards.

## For P5 (Sign in with ChatGPT)

- The Assistant asks for `ModelKind::Chat` everywhere (`fitting(app, ModelKind::Chat)`,
  `account_blocker(app, ModelKind::Chat)`), so a ChatGPT sign-in that is `chat_capable` and not
  `image_capable` works in it with no change. Its `generative_fill` tool then fails with the engine's
  "not connected for image models" message, which the model reads; that is JS's behaviour
  ("an image model may not be connected").
- The window's "Not connected" and "Add an API key in AI Accounts" lines, and `account_blocker`'s
  chat wording ("Connect OpenAI or Google Gemini in AI Accounts first."), already fit a sign-in.
- The model list comes from `ai.testConnection`'s `{models: [{id, kind}]}` with kind `"text"`; the
  plan route's catalog (`{models[].slug}`) must come out the same way from the backend's
  `list_models`.
- Tokens must be redacted in chat errors too: the Assistant shows a failed request's message in
  the conversation (through `ai_ui::message`).
- A 401 on the plan route that ends the turn should carry a kind `ai_ui::fixed_in_accounts` knows
  (`invalidKey`, `missingKey`, `needsConsent`, `notAllowed`), or a message naming AI Accounts, so the
  conversation offers Open AI Accounts….

## For the review of P4

- The riskiest part is `assistant_tools::blocked`: it is a list, and the registry grows with every
  upstream merge. The rule of thumb in it: families that touch files, the app or other documents
  are blocked by prefix; a new command in an allowed family is the Assistant's by default. At a
  merge, look at new commands that take a file under a key not in `PATH_KEYS`.
- `run_command` goes through `menus::invoke`, which runs shell commands too (view, transform boxes).
  Only ids `menus::is_live` knows run.
- The turn is a small state machine in `poll`; its states are `job` (a request in flight),
  `current` (a step waiting on a job or a dialog), `queue` (calls to run), `stopping`. Every exit is
  `finish`.
