# PKG ai-P1: engine seam and `ai.*` commands (headless)

Branch `claude/pigment-photocraft`, commits `093b6f0` (code and tests) and `f3b7a7e` (docs). Local only, not pushed.

## What was built

- `crates/engine/src/generative.rs`: the engine seam. It holds `GenerativeBackend` (status, edit_image, generate_image, describe, chat, list_models) and these types:
  - `ProviderId` (`"openai"`, `"gemini"`), `ModelKind`;
  - `ProviderStatus`, `BackendStatus`, `Choice`;
  - `ImageEdit`, `ImageGen`, `Describe`;
  - the chat types `ChatRequest`, `ChatMessage`, `ChatTurn`, `ToolSpec`, `ToolCall`, `ToolResult`;
  - `GenError { kind, message, status }` and the `kind::*` ids;
  - `resolve_provider(status, choice, kind)`, which checks consent first, then the named provider, then the default, then OpenAI, then Gemini;
  - `Session::set_generative` and `Session::generative`.
- `crates/engine/src/generative/mock.rs`: `MockBackend`.
  - Construct it with `connected()`, `disconnected()` or `with_status()`.
  - Script it with `push(MockAnswer::{Image, Solid, Pattern, Echo, Text, Turn, Models, Error})`, `set_delay`, `set_hook` (runs mid-call, for example to cancel), `set_consented` and `set_status`.
  - Every request is recorded and read back with `calls()`: op, provider, model, prompt, size, mask coverage, transparent, message and tool counts.
  - It is compiled under `cfg(test)` or the new engine feature `testgen`.
- `crates/engine/src/cmd/ai_cmds.rs` and `ai_cmds/`: the 9 commands (table below), plus shared checks and helpers:
  - `COMMANDS`;
  - `unrecorded(id)`: never recorded into actions;
  - `may_send(id, params)`: whether a call may be billed, for the agent and CLI gates;
  - `SEND_MAX_EDGE` = 2048, `FILL_REGION_MAX` = 1536, `PROMPT_LIMIT` = 4000, `NO_BACKEND`.
- `ai_cmds/region.rs` (public, for P2 to reuse) ports the JS pixel helpers: `fill_region`, `feather_keeping_border`, `composite_through_mask`, `masked_layer`, `alpha_to_mask`, `invert_mask`, `transparent_area_mask`, `mask_image`, `is_opaque`, `key_white_border`, `fit_within`, `cover_to`, `crop`, `pad_to_aspect` and `resize_rgba8` (premultiplied; area averaging down, bilinear up).
- `docs/generative-ai.md` is the contract. `docs/FORK.md` has a new "What Pigment added › Generative AI" section with the hook table.

| Id | Label | Result (one undo step named after the label) |
|---|---|---|
| `ai.generativeFill` | Generative Fill… | 1 to 3 layers holding the answer inside the feathered selection, above the active layer or `layer`; the selection stays |
| `ai.generativeExpand` | Generative Expand… | the canvas grows exactly as `image.canvasSize` with a transparent extension, run in a scratch session on the worker; one "Generative Expand" layer fills the transparent area; canvas growth and fill are one step |
| `ai.generateImage` | Generate Image… | a document-size layer "Generated N", or a new RGB document (16 to 8192 px) whose description is the prompt |
| `ai.removeBackground` | Remove Background | `method` `local` (default) runs `layer.removeBackground`'s own `run`. `provider` turns the returned subject's alpha (white-keyed if the answer is opaque) into the layer mask, intersected with the old mask, in place |
| `ai.replaceBackground` | Generate Background… | the subject comes from the layer's mask or transparency, else local Select Subject; it is inverted and the fill path runs over the canvas |
| `ai.replaceSky` | Sky Replacement… | the mask is the selection, else `segment::sky::select_sky`; then the fill path |
| `ai.describe` | Describe Image… | `{text, provider}`, from a thumbnail of at most 1024 px; `journal: false` |
| `ai.status` | AI Status | `{installed, providers[9 keys], defaultProvider, consented}`; the hint is reduced to `…` plus the last 4 alphanumerics |
| `ai.testConnection` | Test AI Connection | `{provider, models:[{id,kind}]}`; needs a key, not consent |

All commands have `menu: &[]` and no shortcut. P3 places them.

## Hooks into upstream files (all listed in FORK.md, marked `// Pigment: generative AI`)

| File | Hook |
|---|---|
| `crates/engine/src/lib.rs` | `pub mod generative;`, `pub use cmd::ai_cmds;`, the private `Session` field `generative: Option<Arc<dyn GenerativeBackend>>` |
| `crates/engine/src/cmd.rs` | `pub mod ai_cmds;`, `v.extend(crate::ai_cmds::specs());` |
| `crates/engine/src/error.rs` | `EngineError::Generative { kind: &'static str, message: String }`; displays the message |
| `crates/engine/src/cmd/actions_cmds.rs` | `recorded()` adds `&& !crate::ai_cmds::unrecorded(id)` |
| `crates/engine/Cargo.toml` | the `testgen = []` feature |

## Tests and checks run

- New tests:
  - 26 command tests in `ai_cmds/tests.rs`;
  - 10 in `region.rs`;
  - 5 in `generative.rs`.
- Commands:
  - `cargo test -p photocraft-engine --lib -- ai_cmds generative`: 39 tests, all pass in about 0.5 s.
  - The whole engine library suite: 3928 passed, 0 failed, 16 ignored. `TMPDIR=/dev/shm/pt` was set.
  - Integration tests `panic_hunt` and `multi_channel_editing`: pass.
  - `cargo fmt --all -- --check`: clean.
  - `cargo clippy -p photocraft-engine --all-targets -- -D warnings`, with and without `--features testgen`: clean.
  - `cargo check -p photocraft-engine --target wasm32-unknown-unknown`: compiles. I installed the target with rustup. The only warnings are upstream's.
  - `scripts/pigment-rebrand.py --check`: clean.
- What the command tests cover:
  - one undo step, plus exact undo and redo;
  - pixels outside the mask stay exact in RGB, Gray, CMYK and Lab at 8, 16 and 32 bits;
  - variations come out in order;
  - Expand grows the canvas and fills the band, with an anchor offset;
  - Expand with no larger size: fills existing transparency, or refuses with "Nothing to expand";
  - a large region is sent scaled to 2048 and lands at full size;
  - Generate Image makes a layer, a new document, or a new document when none is open;
  - Remove Background: local (sends nothing), provider with the old mask, provider with white keying;
  - Generate Background and Sky Replacement, with a selection and with a detected sky in RGB and CMYK;
  - each refusal sends nothing and changes nothing: no consent, no key, no selection, empty prompt, unknown key, bad provider;
  - a wrong-size answer or a provider error changes nothing;
  - cancel, both inline (hook) and as a background job;
  - a background job lands as one step;
  - Describe, status (never a key), and testConnection;
  - a chat-only sign-in is refused for images;
  - commands are not recorded into actions;
  - `may_send`;
  - `needsDocument` in `list_entry`.

## Decisions taken here (also in docs/generative-ai.md)

- **Fill layer pixels.** A fill layer holds the answer's colour, with alpha = answer alpha × mask, over the untouched document. This avoids JS's double blend at the feathered edge. `composite_through_mask` is still provided for the backend.
- **Size checks.** Images go out at most 2048 px a side. The engine refuses an answer of the wrong size with `badResponse`.
- **Labels.** Labels and history names follow the brief's Photoshop placement: "Generate Background", "Sky Replacement". The ids stay `ai.replaceBackground` and `ai.replaceSky`.
- **Prompts.** A prompt is required for every command except Expand, which has JS's default prompt, and Describe, where the question is optional.
- **Remove Background.** Both methods need an unlocked pixel layer, as `layer.removeBackground` does. JS rasterized text and shape layers itself.
- **Strict params.** Unknown params are refused per command, so a misspelt key never runs a billed request on the defaults.
- **Locking.** v1 locks the document for the length of a request. JS's non-blocking behaviour is noted as a follow-up.

## What the next packages should know

- **P2, `pigment-genai`:**
  - Implement `GenerativeBackend`.
  - Answer images at exactly the size asked. Do the padding to aspect, provider sizes, mask conventions and keying inside the backend; `region::pad_to_aspect`, `key_white_border`, `cover_to` and `resize_rgba8` are there to reuse.
  - Map Nib's `ErrorKind::id()` into `GenError.kind`. These must be `&'static str`.
  - Install the backend with `session.set_generative(Some(Arc::new(...)))` in the CLI and headless sessions.
  - The agent and CLI opt-in (`allowAgents`, `--allow-ai`) is not built. Gate with `photocraft_engine::ai_cmds::may_send(id, params)`. It returns false for `ai.status` and the local Remove Background.
- **P3, interface:**
  - Every command has an empty `menu`. Use `PLACE_AFTER` and the shell handlers.
  - The engine reports a typed `EngineError::Generative { kind, .. }`; jobs keep it in `JobEvent::error`. Offer AI Accounts for `missingKey` and `needsConsent`.
  - Add `ai.*` to the `jobs_ui` status-bar exemption.
  - The enabled reason without a backend is `NO_BACKEND`. The web build should hide the items.
  - Use the `testgen` feature in ui-egui dev-dependencies for kittests.
- **P4, the Assistant:**
  - The chat types exist but nothing calls `chat()` yet.
  - `ChatMessage::Turn` carries `provider_state` back verbatim.
  - If the loop needs a different shape, change it; nothing depends on it.

## Not done in P1

- The colour round trip goes through `Surface::convert`, as Paste does, not through the document profile with `color_cmds::convert_surface`. Recorded as a refinement.
- No CLI or MCP end-to-end run. Nothing can install the mock into a CLI process; P2 does that with the real backend and a localhost mock server.
- No i18n rows. All labels are English engine labels; the UI translates them through `tr_id`.
- JS's per-feature last prompts (`lastSkyPrompt` …) belong in P2/P3 settings.
