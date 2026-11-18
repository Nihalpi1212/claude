# PKG ai-final: the final check of the generative AI port

Branch `claude/pigment-photocraft`. Started on `b06b411` (Pigment CI run 188 green on it). This
step changed the documentation and one small thing in `pigment-cli`; its two commits are listed
at the end. CI on them was not waited for.

## Verdict

The port is whole: every AI feature of the JavaScript Pigment (PIGMENT-AI.md) is in the Rust
desktop app, changed where the brief or the design decided so, with a few small gaps (listed).
Every check below passes. One small failure was found and fixed (the command line's wording for
a missing agreement or key). What stays unproven is what no test here can show: the live providers, the live ChatGPT
sign-in, and the macOS and Windows key stores (see the list below).

## Checks run

On `b06b411` unless noted. One cargo process at a time, `-j 4`, with `CARGO_INCREMENTAL=0
CARGO_PROFILE_DEV_DEBUG=0 TMPDIR=/dev/shm/pt` and the `CRAFT_I18N_DIR` and `CRAFT_FONTS_DIR` CI uses.

| Check | Result |
|---|---|
| `cargo fmt --all -- --check` | clean (again on the final tree) |
| `cargo clippy --workspace --all-targets --locked --features heif --keep-going -- -D warnings` (CI's line) | exit 0, no warning (3 min 26 s on the warm build folder); again after the fix below: exit 0 |
| `python3 scripts/pigment-rebrand.py --check` | clean (again on the final tree) |
| `cargo xtask layers`, `panel-commands`, `scorecard --check` | pass (again on the final tree) |
| `cargo test -p xtask` | 88 and 13 pass (again on the final tree) |
| `cargo test -p photocraft-engine --lib -- ai_cmds generative` | 42 pass |
| `cargo test -p pigment-genai` | 2 unit and 76 integration pass, 1 ignored (the real OS keychain) |
| `cargo test -p photocraft-ui-egui --test it -- ai` | 84 pass |
| `cargo test -p photocraft-ui-egui --lib -- ai_ui` | 8 pass |
| `cargo test -p photocraft-automation --lib -- genai` | 1 pass |
| `cargo test -p photocraft-cli --test it -- ai` | 11 pass; after the fix, `--lib --test it`: 7 and 90 pass (12 match `ai`) |
| `bash packaging/linux/package-docs-test.sh` (it packs README.md) | pass, on the final tree |
| `target/debug/pigment --version`, `pigment-cli --version` (built with `--features heif`, as CI's smoke test) | both print `Pigment 0.5.0 (based on PhotoCraft 0.23.1)`, exit 0 |

Not run here: the whole workspace suite, the panic hunt and the doctests (CI run 188 passed them
on `b06b411`; the one code change since is in `pigment-cli`), `cargo xtask wasm` or any wasm32
check (nothing this step changed is compiled for the browser), and the tests under cargo-nextest
(plain `cargo test` here; CI uses nextest).

### The command line end to end, against a mock on 127.0.0.1

`e2e.sh` and `mock_provider.py` (kept beside these notes as `planpc/build/final-e2e/`, with the log
`e2e.log`): a Python stand-in for OpenAI (`GET /v1/models`, `POST /v1/images/edits` answering a
1024 x 1024 magenta PNG, 401 without the right key), a fresh `PHOTOCRAFT_CONFIG_DIR`, and
`PIGMENT_AI_BASE_URL_OPENAI=http://127.0.0.1:<port>/v1`. Nothing reached the network. In order:

1. `pigment-cli ai status`: both providers "not connected", the agreement "not given", where
   keys are kept; 0 requests.
2. `pigment-cli ai set-key openai <key>` (the key in argv): refused, exit 1, 0 requests.
3. `printf key | pigment-cli ai set-key openai`: "OpenAI connected", the models listed, exit 0;
   one `GET /v1/models` with the key in `Authorization` and not in the URL; the key is in neither
   stdout nor stderr; `ai-keys.json` is mode 600.
4. `pigment-cli ai status --json`: `connected: true`, `hint: "QRST"` (the last four), `method:
   "apiKey"`; the key is not in it.
5. `pigment-cli run --new … --cmd select.rect … --cmd ai.generativeFill --params '{"prompt":"a
   magenta box"}' --out x.png` without `--allow-ai`: refused before any work, exit 1, 0 requests,
   no file.
6. The same with `--allow-ai` and no agreement: refused at the step, exit 1, 0 requests, no file.
7. `pigment-cli ai consent`, then the same run with `--out out.png`: exit 0; two requests (the
   model list for the automatic model, then `POST /v1/images/edits`, multipart, with `image[]`,
   `mask` and the prompt). **`out.png` is a 64 x 32 PNG: magenta inside the selection (84 pixels are
   exactly 255, 0, 255, the 14 x 6 interior of the 16 x 8 selection; its edge ring is blended, as
   the one-pixel feather would), white at the pixels sampled outside it.**
   `--out out.pigment` and `pigment-cli info` show the document with the fill layer active.
8. `pigment-cli ai test openai`: "the key works (3 models)". `ai clear-key openai`: the key file
   is gone, `ai.json` holds no key, status says "not connected" and the agreement "given".

## The small failure found, and its fix (`a0e42ff`)

In step 6 the error read "Agree to this once in Edit › AI Accounts…, then try again." (and, with
no key, "Add an API key in Edit › AI Accounts…"): the engine's wording for the app, shown to
someone at a terminal, where the way is `pigment-cli ai consent` or `ai set-key`. `pigment-cli`
now prints a second line after such an error: "On the command line: `pigment-cli ai consent`
records the agreement." or "… `pigment-cli ai set-key <openai|gemini>` connects a provider, and
`pigment-cli ai status` shows what is set up." (kinds `needsConsent`, `missingKey`, `invalidKey`).

- `apps/photocraft-cli/src/ai.rs`: `hint(&CliError)`.
- Hook (in FORK.md): `apps/photocraft-cli/src/lib.rs`, one call after `error: {e}`.
- Test: `ai::a_refused_run_names_the_command_lines_way_to_agree_and_to_connect`
  (`apps/photocraft-cli/tests/it/ai.rs`): no agreement, no key, and an error that gets no line
  (no selection); nothing is sent. Not run without the fix: step 6's output above, from the
  binary before it, is that case without the line the test asks for.

## The feature walk (PIGMENT-AI.md, feature by feature)

The full table is in `pigment/docs/generative-ai.md` › "Pigment 0.4's features in Pigment 0.5,
one by one" (42 rows in four tables, with the decisions lettered A to I, a "New in 0.5" line and a
"Missing in 0.5.0" list). Each row was checked against the code (`ai_ui::ITEMS` for the places,
the commands' params and messages, the windows' strings), not copied from the notes. In short:

| PIGMENT-AI.md | Rust app | |
|---|---|---|
| §2.1 the AI menu | no AI menu; Edit, Layer, Image, Window, task bars, selection menu, palette | differs (decision 2) |
| §3 AI Accounts, keys, models, provider choice | `ai.accounts`: Edit › AI Accounts…, Preferences › AI Integrations; `pigment-cli ai` | has it; model fields are text, not lists (small gap); Linux key file not encrypted |
| §4 Sign in with ChatGPT | OpenAI's tab in AI Accounts; `pigment-cli ai sign-in` | has it, marked Experimental (decision 5); never run live |
| §5, §6 requests, errors | `pigment-genai` | has it; one timeout setting; secrets taken out of messages |
| §8.1 Generative Fill | `ai.generativeFill`: Edit › Generative Fill…, selection menu, task bar | has it |
| §8.2 Generative Expand | `ai.generativeExpand`: Crop task bar, palette | has it; one undo step; not in the Crop options' Fill: list |
| §8.3 Generate Image | `ai.generateImage`: Edit › Generate Image… | has it |
| §8.4 Remove Background | `ai.removeBackground` (`provider`): Layer › Remove Background with AI Provider; (`local`): Layer › Remove Background | differs (decision 1); needs a pixel layer (small gap) |
| §8.5 Replace Background | `ai.replaceBackground`: Layer › Generate Background…, task bar | differs: local subject, one request (INTEGRATION.md §6.3) |
| §8.6 Replace Sky | `ai.replaceSky`: Edit › Sky Replacement… | differs (decision 8) |
| §8.7 Describe Image | `ai.describe`: Image › Describe Image… | has it |
| §7.1 editing during a request | the document is locked | differs (decision 6) |
| §2.2 actions replay AI | never recorded, never played | differs (decision 7) |
| §9 the Assistant, 14 tools | `window.panel.aiAssistant`: Window › Assistant; 14 tools and `list_commands` | has it; a window, not a panel |
| §10 no consent | the one-time agreement | differs (decision 3) |
| the browser build's AI | none | missing (INTEGRATION.md §5.10: out of scope) |
| 0.4's keys and settings | not read | differs (decision 9) |

Nothing of PIGMENT-AI.md's feature list is missing from the desktop app. Missing are only: AI in
the browser build, drop-down model lists in AI Accounts and the Generate window, the provider's
Remove Background on type, shape and smart object layers without rasterizing, a docked Assistant
panel, shortcuts for the three shell items, and translations.

## Documentation changed (`753ccc2`)

- `pigment/README.md`: a "Generative AI" section (the features and their places as a table,
  setting up, what is sent and billed, Sign in with ChatGPT as experimental, actions and agents,
  `pigment-cli ai`, that no live account was available), a line under "What Pigment is", a bullet
  under "Pigment 0.4 and earlier" (keys are entered again), the MCP paragraph (agents need "Allow
  agents to run AI commands"), and the Status line, which said the AI was not in 0.5.0.
- `pigment/docs/RELEASE-NOTES-0.5.0.md`: a "Generative AI" section (features and places, keys and
  the sign-in entered again, nothing before the agreement, what differs from 0.4), and the Known
  issues: the AI was tested against stand-ins only, Sign in with ChatGPT may not work, the other
  0.4 additions are not in 0.5.0, the AI windows are English. **The line about old `.pigment`
  files not opening is unchanged** (the importer's engineer changes it).
- `pigment/docs/generative-ai.md`: the feature-by-feature section, a note that nothing was tried
  against a live provider, the command line's hint, four more entries under "Differences".
- `pigment/docs/FORK.md`: the hook row for `apps/photocraft-cli/src/lib.rs`.

Both README and the release notes say "Nothing is sent before the agreement" with the one
exception spelt out: Connect and Test Connection ask the provider for its model list with the key.

## Commits (pushed to `claude/pigment-photocraft`; CI was not waited for)

- `a0e42ff` Pigment: a refused ai step on the command line names pigment-cli ai's way to fix it
- `753ccc2` Pigment: the README and the release notes say what generative AI 0.5.0 has

## For the next engineer (group L, then the release)

- The legacy importer changes two lines that are still true today: README › "Pigment 0.4 and
  earlier" (the last bullet) and the release notes' first Known issue, plus CI's smoke test.
  The README's new bullet there ("The generative AI is back, and you connect it again") is
  independent of the importer.
- The release notes are the GitHub release's body (`pigment-release.yml` › Release notes); they
  link `blob/pigment-v0.5.0/pigment/docs/generative-ai.md`, which exists once the tag does.
- Before publishing: the first group of the list below, above all the macOS and Windows compile
  of P5's key store code (the dry run predates it).

## Everything the packages and reviews left open

Gathered from the "Not done" and "Not fixed" sections of PKG-ai-P1 to P5, PKG-ai-review123 and
PKG-ai-review45, and from this check. In brackets: where it was recorded. Nothing here is a
blocker found by a test; the first group is what no test here could show.

### 1. Needs a live account, or a real macOS or Windows machine, to check

No key or account existed here (the brief's decision 10), and the CI job is Linux only.

- **Every provider request against the real OpenAI and Google Gemini.** All tests use the engine's
  mock backend or a mock on 127.0.0.1 that answers as the JavaScript app's recorded shapes do.
  Unchecked live: `/images/edits` and `/images/generations` fields per model family
  (gpt-image-1, 1.5 and 2, DALL·E), `/responses` with function tools, Gemini `generateContent`
  with `imageConfig`, `imageSize` and thought signatures, the model catalogs, and the error
  bodies the translation reads. [all packages]
- **The preferred-model lists** (`gpt-5.5`, `gpt-image-1.5`, `gemini-3.1-flash-image` …) are 0.4's
  data. Whether each name exists today is unchecked; a wrong one only falls through to the next,
  then to the first model of the kind. [PIGMENT-AI.md §14.19]
- **Sign in with ChatGPT was never run against the live service**: whether OpenAI still accepts
  `dynamic_agent_client` with `agent_name_hint=Pigment`, the hand-off to the system browser, the
  callback page in a real browser, the token answers, the plan route's `/responses` stream and
  `/models`. Marked Experimental for this reason; `chatgpt::ENABLED = false` or
  `"chatgptSignIn": false` turns it off. A manual check list is at the end of PKG-ai-P5.md.
  [P5, review45]
- **A sign-in that did not grant the plan** (`plan: false`) is stored and shown; its requests
  then fail with the route's own message. As in 0.4, unchecked live. [P5]
- **macOS Keychain and Windows Credential Manager** (`keys::os`, keyring 3.6): never run with a
  real store (the round-trip test is `#[ignore]`), and P5's chunked sign-in store (600-character
  pieces on Windows) was type-checked against a stub of `keyring` only. **The release dry run
  that was green on all three platforms (run 44182518122) was on `d361bd0`, before P5**: the next
  release build is the first real macOS and Windows compile of P5's `keys::os` and
  `keys::chunked`. [P2, P5, review123]
- **Gemini and a history that starts with an assistant message.** After 40 messages the oldest
  user message is dropped first, as in 0.4. Whether Gemini accepts that was not checked. [review45]
- **Gemini's `functionResponse` carries no call id**, as in 0.4. [P2, P4]
- **The interface on a real desktop**: IME in the prompt and message fields, the native macOS
  menu items, focus. Checked from offscreen renders and kittest only. [P3, P4]
- **Windows terminals**: `pigment-cli ai set-key` does not turn echo off there (the prompt says
  so; piping the key in avoids it), and `ai sign-in` keeps its standard-input reader thread until
  the process exits. [P2, P5]

### 2. Product decisions (each works as built; the owner may want it otherwise)

- **A request locks its document** (the brief's decision 6). 0.4 let the person keep editing.
  The unlocked job with re-checks at apply is the follow-up in docs/generative-ai.md. [P1]
- **Actions never send, for the person too.** The brief asked that a replay never spend money by
  surprise; review123 made it a refusal for everyone. To let the person's own action send again,
  drop the `playing` test in `ai_cmds::admitted` (agents stay refused by `admit`). [review123]
- **A script the person runs can send** after the agreement (File › Scripts › Browse with an
  `ai.*` step). Left: a script is a program the person chose, and `pigment-cli run --allow-ai`
  needs it. An agent's script is refused. [review123]
- **No cap on paid fills in one Assistant turn**: up to 12 rounds of 32 calls, each possibly a
  Generative Fill request (0.4 had the same shape). Each shows as a step with Cancel; Stop ends
  the turn. [review45]
- **Turning "Allow agents to run AI commands" off does not stop an agent's turn already
  running** (the rounds after the first are not re-admitted). [P4, review45]
- **`run_command` results can carry file paths to the provider** (`document.inspect`,
  `session.inspect`, `actions.get`, `prefs.get`), as any command result did in 0.4. [review45]
- **An agent that opens AI Accounts can read the signed-in e-mail address** (`ai.status`
  withholds it). Not a credential. [review45]
- **`ai.status` reports neither `allowAgents` nor the e-mail**; `pigment-cli ai status` does.
  [P2, P5, review123]
- **Variations are one layer each**, as in 0.4; Photoshop's one generative layer with a picker
  is a follow-up that needs no engine change. [P3]
- **The Assistant is a floating window**, not a docked panel (0.4). [P4]
- **Not bindable**: `ai.accounts`, `ai.removeBackgroundWithProvider` and
  `window.panel.aiAssistant` are the shell's, outside `engine::shell_commands`, so they have no
  row in Edit › Keyboard Shortcuts (and don't exist on the web build). The engine's `ai.*`
  commands can be bound. [P3, P4]
- **Generative Expand is not in the Crop options bar's Fill: list** (the brief's decision 2 says
  "the Crop tool's task-bar slot and its options"). The list's state is a saved yes/no; the
  feature is in the task bar and the palette. [P3]
- **Generate Background finds the subject locally**, one request (0.4: two). Remove Background
  with AI Provider first gives the provider's subject. [P1]
- **Transparent background is offered for every model** and keyed off white where the model has
  no alpha (0.4 hid it for DALL·E and keyed only Gemini). [P2, review123]
- **The last prompt of each feature is kept in plain text in `ai.json`**, as 0.4 kept it in its
  settings (the brief's decision 9 allows it). [P2]
- **Sign Out revokes nothing at OpenAI**, and **`pigment-cli ai sign-in` prints the address and
  does not open the browser**. [P5]
- **No streaming**: an answer shows when its request ends, as in 0.4. [P4]
- **No translations**: every AI string is English through `tl!`; no craft-i18n rows were added.
  The release notes say so. [P1 to P5]
- **No AI in the browser build**, and **craft-ai-integrations is not adopted** (the brief's
  decision 4; INTEGRATION.md P6 is the later, optional package). [design]
- **Nothing migrates from 0.4** (decision 9): not the keys or the sign-in, and not the model
  choices, last prompts or `aiHostId` either, which INTEGRATION.md §1 and PIGMENT-AI.md §14.1
  thought the legacy importer could carry. [design]

### 3. Small gaps

- **Model fields are text**, not lists from the catalog, in AI Accounts and the Generate window
  (empty: automatic; Use Suggested after a list was read). Only the Assistant lists models, on
  request. [review123, P5]
- **Remove Background with AI Provider needs a pixel layer**; 0.4 rasterized type and shape
  layers itself. [P1]
- **Colour**: the answer comes back through `Surface::convert`, as Paste does, not through the
  document's profile (`color_cmds::convert_surface`). [P1]
- **Memory on very large canvases**: `region::resize_rgba8` holds the result as floats; a
  document-size Generate Image or Expand on 48 megapixels peaks near 1.2 GB. Absurd sizes are
  refused. [review123]
- **Stop does not abort a request in flight.** The job is dropped at once and nothing lands; the
  worker thread ends when the provider answers or the timeout passes (on the plan route, at the
  next chunk). The provider may bill it; every window says so. [review123, P5]
- **A corrupt `ai-keys.json` reads as empty**, so the next Connect rewrites it with one key
  (Linux and the BSDs). [review123]
- **Status freshness**: a key set with `pigment-cli ai set-key` while the app runs shows once an
  AI window opens. [P3]
- **The Assistant's attached image is composed on the interface thread** at Send. [P4]
- **A tool call while Free Transform is open** can be queued behind the transform's commit and
  report success before it has run. [review45]
- **The wait for a dialog counts `app.ui.dialogs` only**: a command whose window is kept
  elsewhere (workspace and analysis dialogs, Camera Raw, Liquify) does not make the turn wait.
  [review45]
- **The blocked list is a list**: at each upstream merge, new commands that read a file under a
  key not in `PATH_KEYS`, start a program or change another document are the Assistant's by
  default. `assistant_tools`' unit tests assert each listed id still exists. [review45]
- **`cargo xtask wasm` (the whole browser app) was not run** in any package; `cargo check
  --target wasm32-unknown-unknown -p photocraft-engine -p photocraft-ui-egui -p pigment-genai`
  compiled at P5's head, and review45 changed desktop-only files. CI has no wasm leg. [P3, review123, review45]
- **Review123's tests were run on the fixed tree only** (review45's were each seen to fail
  without their fix). [review123]
- **CI: one flaky upstream test**,
  `bridge_token::the_bridge_authenticates_to_the_headless_server_by_challenge` (a 5 s
  authentication timeout, older than the AI port). If a run is red on it alone, re-run the job.
  [review123]
