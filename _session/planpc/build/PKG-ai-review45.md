# PKG ai-review45: review of P4 (the Assistant) and P5 (Sign in with ChatGPT)

Branch `claude/pigment-photocraft`. Reviewed from the code (P4: `d39ce30`, `9e34d4f`, `a3f9673`,
`d361bd0`; P5: `8a526b7`, `9811c96`, `fe3e942`, `3a4f755`), not from the notes. This review's
commits are listed at the end.

## Verdict

Both packages hold up. The parity list of PIGMENT-AI.md §4 and §9 is there, the differences are
decisions of the brief or are recorded in `docs/generative-ai.md`, and no route was found by which
an agent or the command line spends the person's money without the opt-in. Tokens stay in the key
store. Five defects were found and fixed, each with a test that failed on the code as it was
(the failures were seen, not assumed: see "Tests added"). None is a blocker. The largest: the
Assistant's file rule was enforced for `run_command` only, so `apply_adjustment` and
`apply_filter` read any file the model named.

## What was wrong, and what changed

1. **`apply_adjustment` and `apply_filter` skipped the Assistant's command policy (major, safety).**
   `docs/generative-ai.md` says "any command with a param that names a file … the Assistant works on
   the open document only", and `assistant_tools::blocked` enforced it, but only `run_command`
   called `blocked`. `apply_adjustment {kind:"colorLookup", params:{file:"/any/path"}}` and
   `apply_filter {kind:"distort.displace", params:{mapPath:"/any/path"}}` went straight to
   `app.run`, and the engine read the file. P4's own test checked the file only through
   `run_command`. A model steered by text in the image could have Pigment read local files into
   the document (and, with Attach image, send what they did to the provider).
   - Fix: `apply_kind` asks `blocked(spec.id, &params)` after sanitizing. The docs say that every
     tool that runs a command by id asks.
2. **Gaps in the blocked list (minor, safety).** The list is by family, and these did not fit a
   blocked family:
   - `layer.smartObjects.revealInFinder` starts the OS file manager (its twin
     `file.revealInFinder` was blocked by the `file.` prefix);
   - `layer.videoLayers.newVideoLayerFromFile` and `replaceFootage` read a file, or open a file
     chooser without params;
   - `image.variables.*` and `image.applyDataSet`: a data set's pixel-replacement value is a file
     path, nested where no key check sees it, and Apply Data Set reads it;
   - `layer.copyToDocument` changes another document;
   - `history.deleteState`, `history.deleteSnapshot` can't be undone (the rule that blocked
     `history.clear`); `history.options` is an app-wide setting;
   - the person's preset libraries (brushes, swatches, patterns, gradients, styles, shapes,
     contours) outlive the document and Undo does not restore them, yet the Assistant could delete,
     reset, rename, move or overwrite their entries. It may still list them, use a preset and add
     one (`PRESET_FAMILIES`, `changes_presets`).
   - A file named deeper in the params (`{"options":{"file":…}}`), and a colour `profile` given as
     a bare `.icc` or `.icm` file name, also passed. The key check now goes as deep as
     `sanitize_params` keeps params (four levels).
3. **The file rule refused params that are no file (minor, parity).** The rule was by key name
   alone, so `edit.contentAwareFill {"output":"new"}`, `select.refineEdge {"output":"layerMask"}`,
   and every shape, vector mask and frame drawn from a `path` object were refused with "works on
   the open document only, not on files or scripts": commands `list_commands` offers the model,
   which then could not run them as documented.
   - Fix (`names_a_file`): text under a file key is a file unless it is one of the values the
     command's own params spec lists for that key (top level only); a list with text in it is
     files; an object or a list of numbers is geometry, and its own keys are checked in turn.
     `script` and `steps` stay refused whatever they hold.
4. **An agent's clicks in the Assistant window changed the person's settings (minor, safety).**
   AI Accounts drops everything but tab switches and Close for synthetic input. The Assistant
   window did not: with "Allow agents to run AI commands" off, an agent's `ui.click` could turn
   Attach image on (so the person's next message sends the image), change the saved chat provider
   and chat model (what the person's next messages cost), and clear the conversation. Sending was
   already refused.
   - Fix: in `assistant::show`, synthetic input without the permission does only Send (which
     `send` refuses), Stop and AI Accounts….
5. **A step of any size was accepted (minor, robustness).** An answer's text is cut to 20,000
   characters and 32 calls, but a call's arguments and tool name had no bound: megabytes of
   arguments were cloned and serialized for the conversation every frame and sent back to the
   provider with each of up to twelve rounds.
   - Fix: a call with more than 64 KiB of arguments (as JSON) or a tool name over 64 characters
     fails the turn before any step runs ("The model asked for a step too large to run"), like the
     32-call bound. An unknown tool's name in a step's label is cut to 60 characters.
6. **A refused access token could reach a message (minor, safety, defence in depth).** On the plan
   route a 401 refreshes the token and retries; only the new token was taken out of the retry's
   answer, and the message redaction reads the stored tokens, which are the new ones by then. A
   provider that quoted the refused token in the retry's error put it in the Assistant's
   conversation.
   - Fix: `plan_call` scrubs both tokens from the answer.

## Tests added

Each was seen to fail without its fix, then passes with it. The three interface tests for
points 1, 3 and 5 and the provider-crate test were run on the code as it was (`3a4f755`) and
failed on the defect. The agent test first failed there on a mistake of its own (two "Clear"
labels), so it and the two unit tests were confirmed afterwards by switching the fixes off: the
window's rule (the test fails with "the agent's clicks changed a setting"), and the presets rule,
the depth of the key check and the listed-choices test (both unit tests fail).

- `crates/ui-egui/tests/it/ai_assistant.rs`:
  - `no_tool_reads_a_file_or_reaches_outside_the_document`: a LUT file that turns everything red,
    named through `apply_adjustment` (as an object and as JSON text), `apply_filter`, a nested
    param and a profile file name; 18 commands refused by `run_command` and never offered by
    `list_commands`; a built-in look and reading a library still work. Before the fix:
    `apply_adjustment … ran: "Applied Color Lookup to \"Background\""`.
  - `a_param_named_like_a_file_param_that_is_no_file_runs`: Content-Aware Fill's `output`, a
    shape from a `path`; a file under the same keys is still refused.
  - `an_agents_clicks_change_neither_the_model_nor_what_is_attached`: `ui.click` on Attach
    image, the other provider and List models; with the permission, and for the person, they work.
  - `an_answer_with_a_step_too_large_to_run_runs_none`: 300,000 characters of arguments, a
    5,000-character tool name; an ordinary long text step still runs.
- `crates/ui-egui/src/ai_ui/assistant_tools.rs` (unit):
  `the_blocked_list_keeps_other_files_other_documents_and_the_preset_libraries` (what is blocked
  and what stays, each id checked to exist) and
  `a_param_names_a_file_at_any_depth_unless_it_is_a_listed_choice_or_geometry`.
- `crates/genai/tests/genai/chatgpt.rs`:
  `a_refused_token_quoted_after_the_retry_is_taken_out`. Before the fix the message read
  "OpenAI said: ACCESS-TOKEN-1 was refused a moment ago…".

## What was checked and found sound

- **Parity, P4** (PIGMENT-AI.md §9): the window's rows and strings, Enter and Shift+Enter, the
  empty states, a turn's order of checks, 40 messages, only the latest image, twelve rounds, the
  outcome texts, Stop, the fourteen tools with their defaults and messages, `describeCall`'s
  labels, the dialog wait. Differences are recorded decisions: a floating window, `list_commands`
  in place of the inlined command list, ranges from each command's spec, layer ids as numbers,
  the model list on request.
- **Parity, P5** (§4): the constants, PKCE, the authorize URL's order, one attempt, the ports and
  their warning, the state check before anything else, the exchange's fields, the ID token checks
  and messages, `earliest_refresh_at`, rotation, the fatal codes, the generation guard, the
  plan-route reshaping, SSE folding, the 401 retry, the callback page, the pasted address.
- **Money.** A message needs the agreement, a connected chat provider and, for an agent (a
  control request, synthetic input, a gated session), the permission; `admit` is asked before the
  first request. Among `ai.*` the Assistant reaches Generative Fill only, with the prompt alone
  (one variation, no model choice), by its tool or by `run_command`; `apply_*` can't name an
  `ai.*` command. No control method or command sends a message. Sign in with ChatGPT can't be
  started, cancelled or signed out by synthetic input, and never serves an image model.
- **Secrets.** Tokens are in the key store only (`Record` has no `Debug`); nothing logs one; the
  authorize address is not written to the status bar; `ai.status` reports neither the e-mail nor
  a hint; errors of the exchange and the refresh have the code, the verifier and the tokens taken
  out; the callback page escapes what it quotes; the listener binds 127.0.0.1 only and a callback
  without the attempt's state changes nothing.
- **Hostile answers.** No tool call, too many, unknown tools, arguments that are not objects,
  JSON text, numbers out of range, rectangles off the canvas, a failed or cancelled request, a
  stream without a final event, a stream's error event, a token answer without an access token
  or an ID token, tokens too long to keep, a callback over 8 KiB.
- **Fit.** P4 added two hooks (`menus/state.rs`, `tests/it/main.rs`) and P5 one changed line
  (`man_and_completions.rs`); all three are in FORK.md. This review touched no upstream file.

## Checks run (on the final tree, `cdbefa3`)

- `cargo test -p pigment-genai`: 2 unit and 76 integration pass, 1 ignored (the real OS keychain).
  Before the review: 2 and 75.
- `cargo test -p photocraft-ui-egui --test it -- ai`: 84 pass (80 before the review, 4 new).
- `cargo test -p photocraft-ui-egui --lib -- ai_ui`: 8 pass (6 before, 2 new).
- `cargo test -p photocraft-cli --test it -- ai`: 10 pass.
- `cargo test -p photocraft-automation --lib -- genai`: 1 pass.
- `cargo clippy -p pigment-genai -p photocraft-ui-egui --all-targets -- -D warnings`: clean.
- `cargo fmt --all -- --check`, `scripts/pigment-rebrand.py --check`: clean.
- Not run: the whole workspace suite, the rest of the interface's unit tests (`--lib` beyond
  `ai_ui`), the panic hunt (no engine command was added or changed), `cargo xtask wasm` (the files
  changed are compiled for the desktop only), `cargo xtask layers` and `scorecard` (no crate,
  preference or panel command was added). CI runs them.
- CI: run 44206281536 on `cdbefa3` was in progress when this note was written (a run takes about
  55 minutes); see the review's return for how it ended. The run before it, on P5's head
  `3a4f755`, was green.

## For the next engineer

- **Every new Assistant tool that runs a command by an id the model chose must call
  `assistant_tools::blocked`.** `apply_kind` was the gap. The tools with a fixed command and
  fixed params (`crop`, `select`, …) need not.
- **At an upstream merge**, look at the new commands against `blocked`: a command outside a
  blocked family that reads a file under a key not in `PATH_KEYS`, names files in nested values
  (as data sets do), starts a program, changes another document or an app-wide store is the
  Assistant's by default. `the_blocked_list_keeps_other_files_other_documents_and_the_preset_libraries`
  asserts each listed id still exists, so a rename upstream shows.
- `names_a_file` trusts a command's params spec for the choices of a key. A command that lists a
  path-like value as a choice would let it through; none does today.
- The window's rule for synthetic input is in `assistant::show`, next to the acts. A new act is
  dropped for an agent without the permission unless it is added to that `matches!`.

## Not fixed, and why

- **A model can ask for many paid fills in one turn.** Up to 12 rounds of 32 calls, each a
  Generative Fill request. The JavaScript app had the same shape (12 rounds, no cap on calls).
  Each shows as a step with the job and Cancel in the status bar, and Stop ends the turn. A cap
  per turn would be a product decision.
- **Turning "Allow agents to run AI commands" off does not stop an agent's turn already
  running** (P4's note; the rounds after the first are not re-admitted).
- **A tool call while Free Transform is open** can be queued behind the transform's commit
  (`after_transform_commit`) and report success before it has run. Only when the person, or the
  model through `edit.freeTransform`, left a transform box open.
- **The wait for a dialog counts `app.ui.dialogs` only.** A command whose window is kept elsewhere
  (the workspace and analysis dialogs, Camera Raw, Liquify) does not make the turn wait.
- **`run_command` results can carry file paths** (`document.inspect`, `session.inspect`,
  `actions.get`, `prefs.get`) to the provider, as any command result did in the JavaScript app.
- **An agent that opens AI Accounts can read the signed-in e-mail address** from the dialog
  (`ai.status` withholds it). The address is not a credential.
- **After 40 messages the history sent can start with an assistant message** (the oldest user
  message is dropped first), as in the JavaScript app. Whether Gemini accepts that was not
  checked against the live service.
- **Sign in with ChatGPT was never run against the live service**, nor the chunked store on a
  real Windows Credential Manager (P5's notes). Unchanged.
- **The release notes and the README still say the AI is not in 0.5.0** (P4's and P5's notes).
  Left for the docs and release task.

## Commits (both pushed to `claude/pigment-photocraft`)

- `8b41109` Pigment: a refused ChatGPT token is taken out of the retry's answer too
- `cdbefa3` Pigment: the Assistant's file rule holds for every tool, and its window for agents
