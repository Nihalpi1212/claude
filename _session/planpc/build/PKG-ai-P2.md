# PKG ai-P2: `pigment-genai`, the headless install and `pigment-cli ai`

Branch `claude/pigment-photocraft`. Three local commits, not pushed:

- `200ae8c`: the crate;
- `c544db7`: the automation and CLI hooks, `pigment-cli ai` and their tests;
- `ffb311f`: the docs.

## What was built

### `crates/genai` (package `pigment-genai`)

Its root is `#![cfg(not(target_arch = "wasm32"))]`, so the crate is empty on the web build. It is ported from Nib's `nib-genai` and from the JavaScript `providers.js`. Files:

- `provider.rs`: the `Provider` trait (`generate_image`, `edit_image`, `chat`, `list_models`, `max_edge`, `edit_frame`, `native_transparency`). It also holds:
  - `ProviderConfig`, `ModelKind {Chat, Image, Other}` and `ModelInfo`;
  - `pick_model`, which follows JS `pickPreferred`: an exact match, then a prefix match, then the first model of the kind;
  - `preferred_models` (JS `PREFERRED_MODELS`) and `fallback_model`;
  - `translate_error`: Nib's version plus the JS `SUBSCRIPTION_HINTS`;
  - `json_value_bound`.
- `provider/openai.rs` and `provider/gemini.rs` build the request bodies and parse the answers as pure functions:
  - JS's nearest sizes and ratios, the gpt-image-1 and 1.5 fields, the DALL·E rules, Gemini `imageSize` and modalities;
  - the edit form with the mask converted to each provider's convention;
  - chat with tools, with history replayed verbatim.
- `chat.rs`: `clean_schema`, `gemini_schema`, `gemini_declaration`, `parse_args` (unreadable arguments become `{_raw}`), `result_text` and `describe_request`.
- `http.rs`: Nib's version. User-Agent `Pigment/<version>`.
- `keys.rs`: `service()` returns `brand::APP_ID + ".ai"`. Keys use keyring 3.6 on macOS and Windows and a 0600 `ai-keys.json` elsewhere. `FILE_BACKEND` is "a file only you can read".
- `settings.rs`: `ai.json` with JS's fields (shape in docs/generative-ai.md). A model of `None` means automatic. `PromptFeature` and `set_last_prompt` remember the last prompt per feature, cut to 4000 characters.
- `accounts.rs`: `AiAccounts`.
  - `connect` checks a key with the provider before storing it.
  - It also has `set_key`, `clear_key`, `set_default_provider` (which also resets `imageProvider` and `chatProvider`), `set_models`, `set_consented`, `set_allow_agents`, `reload` (re-reads `ai.json`) and `status()`.
  - The catalog cache lasts 10 minutes. `known_model` and `shown_model` give the model without a network call.
  - `PIGMENT_AI_BASE_URL_{OPENAI,GEMINI}` accept loopback addresses only.
- `image_util.rs`: decoding with limits (PNG, JPEG, WebP), PNG and base64, `openai_mask` and `white_mask`.
- `backend.rs`: `GenAiBackend` implements the engine trait.
  - Constructors: `new(Arc<Mutex<AiAccounts>>, Caller)`, `from_config_dir`, and `deferred`, which opens the accounts on first use.
  - `Caller::{Person, Agent, CommandLine{allow_ai}}`. A caller that may not send gets the error kind `notAllowed`.
  - Before every request it re-reads settings, then checks the caller, then consent and the provider (through the engine's `resolve_provider`), then the model. The catalog is read without holding the lock.

### Headless install, in `crates/automation/src/genai.rs`

- `backend(caller)`, `session(caller)` and `install(session, caller)`. The accounts come from `app_dirs::from_env()`, or are in-memory when there is no home folder.
- `Headless::new()`, `with_workspace()` (MCP and serve) give `Caller::Agent`.
- `trusted_local()` (CLI) gives `CommandLine { allow_ai: false }`.

### CLI, in `apps/photocraft-cli/src/ai.rs`

- `pigment-cli ai status|set-key|clear-key|test|consent|agents|use`.
  - `set-key` reads the key from stdin, with echo turned off through `stty` on a Unix terminal.
  - A key given in argv is refused.
  - Keys are checked with the provider unless `--no-check` is given.
- `run --allow-ai`: `ai::install(h, &RunArgs)` refuses any step for which `may_send` is true, before any work, and otherwise installs the backend that may send.
- `batch` and droplets never send.

## Hooks into upstream files (all in FORK.md, marked `Pigment: generative AI`)

| File | Hook |
|---|---|
| `Cargo.toml` (workspace) | the `pigment-genai` workspace dependency; `Cargo.lock` gains keyring 3.6.3, security-framework 2.11 and windows-sys 0.60 |
| `crates/automation/Cargo.toml` | the `pigment-genai` dependency |
| `crates/automation/src/lib.rs` | `pub mod genai;` |
| `crates/automation/src/headless.rs` | `untrusted()` and `trusted_local()` build their session with `genai::session(..)` (one line each) |
| `apps/photocraft-cli/Cargo.toml` | the `pigment-genai` dependency |
| `apps/photocraft-cli/src/args.rs` | `Ai(crate::ai::AiArgs)`, and `allow_ai` in `RunArgs` |
| `apps/photocraft-cli/src/lib.rs` | `mod ai;` and the dispatch line |
| `apps/photocraft-cli/src/document.rs` | `crate::ai::install(&mut h, a)?;` in `run_cmds` |
| `apps/photocraft-cli/tests/it/main.rs` | `mod ai;` |
| `apps/photocraft-cli/tests/it/man_and_completions.rs` | two lines adding the `ai*` man pages to the expected list |

## Tests and checks

New tests:

- `crates/genai/tests/genai/` holds 42 tests: 41 pass and 1 is `#[ignore]` (the real OS keychain). All run against a `TcpListener` mock on 127.0.0.1.
  - `keys.rs`: 7.
  - `providers.rs`: 17, including JPEG answers, the DALL·E 2 square rule, the multipart field order and the mask alpha.
  - `chat.rs`: 6. These cover Gemini's schema, the OpenAI and Gemini rounds, a provider switch sent as text, Describe, and a two-round tool loop through the backend for both providers.
  - `backend.rs`: 12. These cover OpenAI padding and the crop back, Gemini's ratio with white padding and the mask, transparency, cover-fit and keying, Describe, automatic models from the catalog read once, refusals that send nothing, settings re-read, a status without keys, connect, the deferred open, and the engine commands end to end with a 429 mapped to `quota`.
- `crates/automation/src/genai.rs`: 1 unit test. Headless sessions have the backend, and an agent is refused without `allowAgents`.
- `apps/photocraft-cli/tests/it/ai.rs`: 3 tests.
  - Keys come from stdin only and are never printed; a refused key is not stored; the key file is 0600; status, test and clear-key work.
  - Consent, agents and use are written to `ai.json`.
  - `run` refuses without `--allow-ai` and sends nothing. With it, Generative Fill runs end to end and `info` shows the "Generative Fill" layer. An `ai.*` step in a `batch` action list sends nothing.

Commands run, all green:

- `cargo test -p pigment-genai`
- `cargo test -p photocraft-automation`: every target
- `cargo test -p photocraft-cli`: lib and `it`, 87 tests
- `cargo fmt --all -- --check`
- `cargo clippy -p pigment-genai -p photocraft-automation -p photocraft-cli --all-targets -- -D warnings`
- `cargo check -p pigment-genai --target wasm32-unknown-unknown`
- `scripts/pigment-rebrand.py --check`

## Decisions taken here (also in docs/generative-ai.md)

- **No composite in the backend.** It returns the answer scaled back to the size sent and does not composite it through the mask. The engine composites once (P1), which avoids a double blend at the feathered edge.
- **Transparency without alpha.** Every model without real alpha is asked for a white background, which is then keyed out. JS did this only for Gemini's new images; here it also covers gpt-image-2 and DALL·E, and Remove Background's edit on those models.
- **Automatic models.** A request's model comes first, then the one chosen in settings, then the catalog's pick (one `GET /models`, cached for 10 minutes), then a known model. An invalid key during that listing fails the request; any other listing error falls back to the known model.
- **Consent from the terminal.** `pigment-cli ai consent` and `ai agents on` exist, because headless and CLI-only users otherwise have no way to agree. MCP and the control channel still cannot grant either.
- **Stale settings.** The backend re-reads `ai.json` before every request, so a running MCP server follows changes made in AI Accounts.

## For the next packages

- **P3, interface:**
  - Install the backend with `GenAiBackend::new(Arc<Mutex<AiAccounts>>, Caller::Person)` and share the same `Arc` with the AI Accounts dialog. `AiAccounts::new(config_dir)` takes the app's `app_dirs::config_dir()`.
  - Run `connect(p, key, cancelled)` for Connect off the UI thread; it blocks for up to 30 s.
  - Settings saves go to `ai.json`. Use `settings.set_last_prompt` and `save()` for the per-feature prompts, and `image_provider` and `chat_provider` for where windows start.
  - Gate the app's MCP bridge and control channel (`Services::automation_command`): refuse when `photocraft_engine::ai_cmds::may_send` is true and `allowAgents` is off. Only headless sessions are gated today.
  - Error kinds to handle: `notAllowed` (new), plus `missingKey`, `invalidKey` and `needsConsent`. Offer AI Accounts for these.
  - `AccountStatus` has `chat_model_automatic` and `image_model_automatic` for the "(automatic)" label.
- **P4, Assistant:**
  - Call `backend.chat(&ChatRequest)` once per round.
  - Append `ChatMessage::Turn(turn)` and then `ChatMessage::ToolResults` with each call's `call_id` and `name`.
  - A provider switch mid-conversation is handled: the turn is sent as text.
  - `Choice.provider = None` resolves for chat models.
- **P5, ChatGPT:**
  - `SecretStore` is keyed by `ProviderId`; add an `openai-chatgpt` account, or extend the trait.
  - `translate_error` already has the plan-route hints.
  - `status_of` in `backend.rs` sets `image_capable = connected`. A ChatGPT sign-in must set it to false.
  - `openai::parse_models` already reads `{models:[{slug}]}`.

## Not done

- The macOS Keychain and Windows Credential Manager paths (`keys::os`, keyring 3.6) could not be compiled or run here: there is no cross toolchain. The code is Nib's. The round-trip test is `#[ignore]`d. CI's macOS and Windows legs are the first build.
- The desktop app does not install the backend yet (P3), and nothing gates the running app's bridge or control channel yet (P3).
- `ai.status` (the engine command) does not report `allowAgents`; `pigment-cli ai status` does.
- Gemini `functionResponse` parts carry no call `id`, as in JS.
- Echo is not turned off on Windows: the prompt says the key will show as it is typed, and piping the key in is the alternative.
