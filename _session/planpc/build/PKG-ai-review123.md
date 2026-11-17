# PKG ai-review123: review of P1, P2 and P3 (engine seam, provider crate, interface)

Branch `claude/pigment-photocraft`. Reviewed from the code (commits `093b6f0` to `d2be723`), not from the notes.
Commits of this review are listed at the end.

## Verdict

The three packages hold up: the parity list of PIGMENT-AI.md that P1 to P3 cover is there, keys stay out of
every place they should, nothing is sent before consent or without a key, and a cancelled or failed request
leaves the document as it was. Five real defects were found and fixed (one a way for an agent to spend the
person's money), each with a test. CI's two failures on `d2be723` are fixed.

## What was wrong, and what changed

1. **CI (blocker for the branch, fixed first, commit `3c5c86b`).**
   - `cargo xtask layers`: `pigment-genai` was not in the layers table. It is now L6, with two intra-layer
     orderings so `automation` and `ui-egui` (also L6) may depend on it (`xtask/src/layers.rs`; FORK.md lists it).
   - `docs/scorecard.md` was stale (the new crate makes it "26 of 26 crate roots"). Regenerated.
2. **An action could send, and an agent could use that (major, safety).** The docs said "playing an action,
   a batch or a droplet never calls a provider", but only *recording* skipped `ai.*`. An action holding an
   `ai.*` step (built with `actions.insert`, or loaded from a file) ran it, and in the desktop app the steps of
   a played action go straight to `Session::execute`, past `ai_ui::gate`. So an agent with "Allow agents to run
   AI commands" off could insert a step and play it. P3's notes named this gap.
   - Fix, in the engine (`ai_cmds::admitted`): a command that sends is refused while an action plays
     (`s.actions.playing > 0`: the engine's `actions.play`, the shell's playback, a batch's or a droplet's
     named action) or while an event's script runs (`s.file_menu.firing`: Script Events Manager), **whoever
     plays it**, with kind `notAllowed` and the message `ai_cmds::NOT_FROM_ACTIONS`, before the backend is
     asked. The local Remove Background is not a sending command and still plays.
   - This is stricter than the JavaScript app (which replayed AI steps and billed again). It is what decision 7
     of the brief asks ("a replay never spends money by surprise") and what `docs/generative-ai.md` already
     promised. To allow it for the person again, drop the `playing` test in `admitted`; the agent case is then
     still held by the next point.
3. **A command an agent reaches through another command (major, safety).** Same root: `ai_ui::gate` sees only
   what goes through `PhotocraftApp::run`. A script an agent runs (`file.scripts.browse` with an `ai.*` step)
   dispatches its steps inside the engine.
   - Fix: `GenerativeBackend::admit(automated)` (new trait method, default admits). The engine asks it on the
     calling thread before a sending command starts its job, with `automated = session.authorize.is_some()`.
     The app installs its backend behind `ai_ui`'s `AppBackend`, which refuses when the command starts for an
     agent (`AiUi::agent_now`, set by `as_agent` and by `gate` for every command the app runs) or under the
     session's automation gate, unless "Allow agents to run AI commands" is on. `GenAiBackend::admit` applies
     its `Caller` rule early (headless agents, `pigment-cli run` without `--allow-ai`).
   - This part came from the first reviewer's recovered edits (kept and finished). Their tests said "the person
     playing the action sends"; with point 2 that is no longer so, and the tests now use a script for the
     agent case and assert that an action never sends.
4. **Layer › Remove Background was not recorded into actions (minor, parity).** The menu item runs
   `ai.removeBackground {"method":"local"}`, and every `ai.*` id was unrecorded, so recording an action lost
   the step (PhotoCraft's `layer.removeBackground` from Properties is recorded; the JavaScript app recorded it
   too). `ai_cmds::unrecorded(id, params)` is now `may_send(id, params)`: the local method is recorded and
   plays; the provider method is not.
5. **A hostile answer could cost over a gigabyte (minor, robustness).** `image_util::decode` let an
   8192 × 8192 image through (a flat PNG of that size is a few hundred kilobytes), and the backend resamples
   answers as premultiplied floats, 16 bytes a pixel. The size is now read from the header first and refused
   over 24 megapixels (`MAX_PIXELS`; requests ask for at most 2048 px a side and get under 5 megapixels back).
6. **The key could reach a message through a 2xx answer (minor, safety, defence in depth).** Only non-2xx
   answers were redacted. Errors read out of a successful answer (an `error` object in a 200, a refusal,
   "the model answered with text instead of an image: …") quote the provider's text. Every provider call's
   error now goes through `provider::redacted`.

## Tests added (each fails without its fix)

- Engine, `ai_cmds/tests.rs`:
  - `a_step_that_sends_never_runs_from_an_action_or_an_event_script` (four sending commands in actions, a
    nested action, a script that plays an action, a script bound to New Document; the backend is never asked);
  - `an_automated_caller_is_admitted_by_the_backend_before_anything_is_sent` (own request, Test Connection,
    a script's step under a gate; the person's script runs);
  - `the_local_remove_background_is_recorded_and_plays`.
- `pigment-genai`:
  - `image_util::tests` (2): the pixel budget from a header-only PNG, ordinary answers still decode;
  - `providers::a_key_quoted_in_a_successful_answer_never_reaches_a_message`.
- Interface, `tests/it/ai.rs`:
  - `an_agent_running_a_script_with_an_ai_step_needs_permission_too`;
  - `an_action_with_an_ai_step_never_sends` (the agent's play and the person's);
  - `synthetic_input_neither_sends_nor_grants_itself_permission`: `ui.click` events delivered as the input
    hook delivers them. P3 had the guard in AI Accounts and in `gate` but no test of either for synthetic
    input;
  - `generate_image_makes_a_new_document_in_the_background` and
    `generative_expand_grows_the_canvas_in_one_undo_step`: the two window flows P3 did not run end to end as
    background jobs (how the app runs them);
  - `ai_accounts_connects_a_key_that_never_shows_anywhere` now also checks the accessibility tree,
    `ui.inspect` and the interface state **while the key is typed**, not only after Connect wiped it.

## What was checked and found sound

- **Parity** (PIGMENT-AI.md sections 2, 3.5, 6, 7, 8, 10 against the code): the seven features, their options
  and defaults (variations 1 to 3, Expand's default prompt and anchors, Sky's default prompt, Generate Image's
  16 to 8192 px and new-document name and description, the last prompt per feature, the provider order),
  request shapes for both providers, mask conventions, padding, keying, the placement of decision 2. The
  differences are decisions of the brief or of INTEGRATION.md (Remove Background masks in place; Generate
  Background finds the subject locally; Expand is one step; consent; no AI menu).
- **Keys**: only `ApiKey::expose` reads one, only for a header (`Authorization`, `x-goog-api-key`, never a
  URL). Not in `ai.json`, `ui.inspect`, `UiState`, preferences, menus, `ai.status` (at most four characters),
  logs (no log line carries a message, a prompt or a key), or CLI output (stdin only, argv refused).
- **Nothing before consent or a key**: the engine checks before the job (`resolve_provider`), the backend
  again before sending. Test Connection and Connect send the key only, by design.
- **Agents**: headless sessions (`Caller::Agent`), `pigment-cli run` (`--allow-ai`), the control channel and
  MCP through the window (`as_agent`), synthetic input (`automation_input`), AI Accounts under synthetic
  input (tabs and Close only), actions, scripts, script events, batch.
- **Pixels outside the mask**: fills land as layers whose alpha is answer alpha × mask; the engine tests
  compare the composite outside the mask in RGB, Gray, CMYK and Lab at 8, 16 and 32 bits.
- **Hostile answers**: wrong size (engine `check_answer`), undecodable, no image, a link, text instead of an
  image, safety blocks (both providers, 4xx and in-body), a body over 64 MiB, a JSON bomb, a redirect (not
  followed), a timeout, cancel before sending.
- **Hooks**: each a line or two, all in FORK.md (this review added `xtask/src/layers.rs`).

## For the next engineer

- **P4 (Assistant).** `ai.generativeFill` from the Assistant goes through `PhotocraftApp::run` like any
  command: it is the person's, so `gate` passes it. Do not run Assistant tools inside `as_agent`. If a tool
  plays an action or a script, the rules above apply to it unchanged. `chat()` has no `admit` of its own: the
  Assistant calls the backend directly, not through an engine command, so check `Caller`/consent there (the
  backend's `prepare` does for `GenAiBackend`).
- **P5 (ChatGPT).** `provider::redacted` and `check` redact one secret, the API key. Tokens need the same
  (access and refresh tokens, and the id token), in the token exchange and refresh calls too.
- **`AiUi::agent_now`** is written by `as_agent` (the control channel) and by `gate` on every
  `PhotocraftApp::run`. Any new path that reaches an `ai.*` engine command without `run` must sit inside one
  of them, or the app's backend takes it for the last caller.
- The engine test build takes about 10 minutes here and any edit under `crates/engine/src` rebuilds the
  interface too; batch engine edits.

## Not fixed, and why

- **A script the person runs can send** (File › Scripts › Browse with an `ai.*` step, after consent). Left
  as it is: a script is a program the person chose to run, and `pigment-cli run --allow-ai` users need it.
  An agent's script is refused.
- **Stop does not abort the HTTP request.** ureq blocks until the response headers arrive; Cancel is polled
  before sending and between body chunks. The job is dropped at once (the document is free, nothing lands),
  and the worker thread ends when the provider answers or the timeout passes. Same as the JavaScript app.
- **Memory for very large documents.** `region::resize_rgba8` holds the whole result as floats: a document-
  size Generate Image or Expand on a 48-megapixel canvas peaks near 1.2 GB. `allocation::check_dense` refuses
  absurd sizes, but a banded resize would be kinder. Not a correctness problem.
- **A corrupt `ai-keys.json` reads as empty**, so the next Connect rewrites it with one key (Linux only).
- **Small interface gaps against the design**: the model is a text field with the automatic model as its
  hint, not a list from the catalog; "Transparent background" is not hidden for DALL·E models;
  `ai.status` does not report `allowAgents` (`pigment-cli ai status` does); echo stays on at a Windows
  terminal for `ai set-key` (the prompt says so).
- **macOS Keychain and Windows Credential Manager** paths compile in CI but were never run with a real
  store (the round-trip test is `#[ignore]`).
- Not run here: the whole workspace test suite (CI does), `cargo xtask wasm`, `panic_hunt`.
