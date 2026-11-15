# Pigment generative AI on PhotoCraft: integration design

Status: design for the "Port Pigment's generative AI to the new base" work package. It was written
by reading the code only. No cargo run, and no file in any repository changed.

Sources read:

- JavaScript Pigment 0.2 to 0.4, branch `claude/fervent-newton-263lz3` of `/home/user/claude`: `pigment/src/main/ai.js`
  (889 lines), `pigment/src/renderer/lib/ai/{accounts,assistant,client,features,providers}.js`,
  `pigment/src/renderer/lib/panels/assistant.js`, `pigment/docs/USER-GUIDE.md` § AI,
  `pigment/tests/unit/ai.test.mjs`, `pigment/tests/e2e/ai-*.spec.mjs`.
- The Rust tree: `/home/user/claude/pigment` (PhotoCraft 0.23.1). Every path below that starts with `crates/` or `apps/` is relative to it.
- Nib: `origin/claude/nib-vector-editor`, `nib/crates/genai`, `nib/crates/ui-egui/src/ai.rs`,
  `src/ai/{generate,accounts}.rs`, `tests/ai.rs`, `nib/docs/generative-ai.md`, `nib/docs/FORK.md`
  (head `1fbbfc3`, 2026-11-14).
- craft-ai-integrations: `/home/user/storytold/craft-ai-integrations` (head `db30646`, 2026-11-15,
  a single squashed commit).

---

## 0. Summary and recommendation

**Use a mix, with Nib's approach as the core.** Upstream's direction is kept open behind one seam:

1. **The AI features become ordinary PhotoCraft engine commands** (`ai.generativeFill`,
   `ai.generativeExpand`, `ai.generateImage`, `ai.removeBackground`, `ai.replaceBackground`,
   `ai.replaceSky`, `ai.describe`, `ai.testConnection`). They live in a new
   `crates/engine/src/cmd/ai_cmds/` module. They run through the existing jobs system
   (`photocraft_engine::jobs::run`): worker thread, progress, Cancel, one undo step. Because they
   are engine commands, the menus, the command palette, Actions, the CLI (`run --cmd`), MCP
   (`command_run`) and the in-app Assistant all reach them with no extra plumbing.
2. **The engine never talks to the network.** It defines a small trait,
   `photocraft_engine::generative::GenerativeBackend`, and calls it through
   `Session::generative()`. Tests install a mock. The desktop app and the CLI install a real
   backend.
3. **The first real backend is a new crate, `crates/genai` (package `pigment-genai`)**, ported
   from Nib's `nib-genai`. It keeps Nib's provider layer, HTTP, key storage, settings, consent,
   errors and redaction, with their tests. Pigment's raster request shapes (JS
   `providers.js`) are added, along with chat with function tools (for the Assistant), image
   description, and later Sign in with ChatGPT. Nib's vector operations are not ported.
4. **craft-ai-integrations is not adopted now.** Today it covers only part of what Pigment users
   had:
   - no Gemini text, vision or image generation with an AI Studio key;
   - no vision input to OpenAI chat;
   - no outpaint;
   - no ChatGPT sign-in.

   Its APIs are still evolving: it carries a local `craft-ai-core` that differs from the
   craft-libs copy. No app has adopted it: one local PhotoCraft fill is reported, with poor
   blending. Its widgets are not localised, and it keeps its settings in the ArtCraft Launcher's
   folder.

   The trait in (2) is shaped after its capabilities (`image.inpaint`, `image.outpaint`,
   `image.generate`, `text.complete`), and the command ids and parameters are ours. When
   upstream PhotoCraft adopts craft-ai-client, a second backend can be written on `AiClient`
   without touching the commands, the UI or the tests. One part is worth taking early as an
   optional local route: the rten engines for Remove Background and Select Subject. That is a
   follow-up package (§7, P6).

Section 1 lists what must not be lost. Sections 2 and 3 cover the two candidate foundations. Section
4 explains the choice. Section 5 lists the PhotoCraft integration points, read from the code.
Section 6 is the concrete design. Section 7 is the package breakdown.

---

## 1. What the JavaScript Pigment users had (the parity list)

| JS feature (menu AI) | JS command | What it does | Rust target |
|---|---|---|---|
| AI Accounts… | `ai:accounts` | One card per provider. OpenAI: **Sign in with ChatGPT** (chat models only) or an **API key** (needed for images). Gemini: API key. Chat and image model per provider, Preferred provider, Sign out. | `ai.accounts`: a modal dialog in ui-egui (§6.5). The ChatGPT sign-in is package P5. |
| Generative Fill… | `ai:generative-fill` | Needs a selection. Prompt, provider and model, **1 to 3 variations**, each a new layer above the active one holding only the selected area. One undo step. | `ai.generativeFill` |
| Generative Expand… | `ai:generative-expand` | New width and height plus an anchor, or an existing transparent band. The canvas grows and the empty area is filled. | `ai.generativeExpand`, also offered in the Crop task bar |
| Generate Image… | `ai:generate-image` | Prompt. Result as a layer at document size, or as a new document of a chosen size. Optional transparent background (gpt-image models return real alpha; Gemini answers are keyed off white). | `ai.generateImage` |
| Remove Background | `ai:remove-background` | Asks the image model for the subject on transparency. Result: a **copy** of the layer with a layer mask; the original is hidden. | `ai.removeBackground` (provider route). PhotoCraft already has a local `layer.removeBackground` (§5.12). |
| Replace Background… | `ai:replace-background` | Subject mask, then fill outside it from a prompt | `ai.replaceBackground` |
| Replace Sky… | `ai:replace-sky` | Selection, or a sky mask detected at the top, then fill from a prompt | `ai.replaceSky` (mask from the selection or the local `select.sky`) |
| Describe Image | `ai:describe` | Text description of the composite. Copy, or **Use as document description**. | `ai.describe`, then `file.fileInfo {"description": …}` |
| Window/AI › AI Assistant | panel | Chat per document, optional downscaled composite attached. Tools: `get_document`, `set_active_layer`, `apply_adjustment`, `apply_filter`, `run_command` (with a blocked list), `new_layer`, `set_layer_props`, `select`, `crop`, `resize_image`, `canvas_size`, `fill_selection`, `add_text`, `generative_fill`. 12 tool rounds per turn, 40 messages kept, Stop, clear. Each action is a normal undoable step. | `window.panel.aiAssistant` (package P4) |

Behaviour to keep (from the JS code and the User Guide):

- **Nothing is sent until the person runs a feature.** There are no background calls. Model lists
  are fetched when needed and cached for 10 minutes.
- **The original pixels are never changed by a fill.** The answer is composited through the mask
  (`compositeThroughMask`), so pixels outside the selection stay exact.
- **The fill region** (`fillRegion`): the selection bounds padded 25% on each side, made
  square-ish, clamped to the canvas, at most 1536 px. The padding shrinks first. The image is padded
  to the provider's aspect ratio rather than stretched (`padToAspect`), and resampled back.
- **OpenAI image sizes.** gpt-image models take 1024², 1536×1024 and 1024×1536; dall-e-3 the 1792
  shapes; dall-e-2 squares. The edit mask uses alpha 0 for "may change". gpt-image-1 and 1.5 take
  `background`, `input_fidelity: high` and `quality: auto`.
- **Gemini images.** Aspect ratios are 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9 and 21:9.
  gemini-3 uses `responseModalities: ["IMAGE"]` with `imageSize` 1K, 2K or 4K; older models use
  `["TEXT","IMAGE"]`. A mask is sent as a white-on-black image with an instruction. Transparency
  is requested as a plain white background, then keyed (`keyWhiteBorder`).
- **Preferred models**, first present wins (`providers.js` `PREFERRED_MODELS`):
  - OpenAI chat: gpt-5.5, 5.1, 5, 4.1, 4o. OpenAI image: gpt-image-1.5, gpt-image-1, gpt-image-2.
  - Gemini chat: gemini-2.5-pro, 2.5-flash, 2.0-flash.
  - Gemini image: gemini-3.1-flash-image, gemini-3.1-flash-image-preview,
    gemini-3-pro-image-preview, gemini-2.5-flash-image.
- **Errors in plain words.** A connection problem offers "AI Accounts…". ChatGPT plan error codes
  (`subscription_sharing_*`) get the hints in `SUBSCRIPTION_HINTS`.
- **Cancel** discards the late answer (the JS bridge could not abort a request either).
- Settings: `settings.ai = {openaiChat, openaiImage, geminiChat, geminiImage, defaultProvider,
  imageProvider, chatProvider, lastSkyPrompt}`. Secrets: `<userData>/ai-credentials.json`, sealed
  with Electron `safeStorage`.

**Migration from JS Pigment.** Electron `safeStorage` values cannot be unsealed from Rust without
reimplementing Chromium's OS-keychain wrapping. **Do not migrate keys or tokens.** Ask once, in AI
Accounts ("Add your key again: keys from Pigment 0.4 are not carried over"). Model preferences
can be read from the JS `settings.json` (package 40, which opens old `.pigment` files, owns
finding that file). If old recorded Actions contain `ai:*` steps, map them:

| JS id | Rust id |
|---|---|
| `ai:generative-fill` | `ai.generativeFill` |
| `ai:generative-expand` | `ai.generativeExpand` |
| `ai:generate-image` | `ai.generateImage` |
| `ai:remove-background` | `ai.removeBackground` |
| `ai:replace-background` | `ai.replaceBackground` |
| `ai:replace-sky` | `ai.replaceSky` |
| `ai:describe` | `ai.describe` |

---

## 2. Nib's genai (the vector move, done once already)

### 2.1 Crate layout

`nib/crates/genai`, package `nib-genai`, 4,329 lines. The crate root is
`#![cfg(not(target_arch = "wasm32"))]`, so it compiles to an empty crate on the web.

| File | Role | Raster reuse |
|---|---|---|
| `src/lib.rs` | re-exports `GenAi, AiAccounts, AccountStatus, CancelToken, AiError, ErrorKind, Jobs, JobEvent, Provider, ProviderConfig, ProviderKind, AiSettings, Feature, FeatureRequest, Generated, Prepared, Applied` | rewrite the re-exports |
| `src/provider.rs` | `ProviderKind {OpenAi, Gemini}` (id, label, default base URL, default models, `preferred_models`); `ProviderConfig` (base URL, text and image model, timeout 300 s, `max_response_bytes` 64 MiB); request types `TextRequest {instructions, prompt, images, json, max_output_tokens}`, `ImageRequest {prompt, width, height, transparent, references}`, `EditRequest {prompt, image: PNG, mask: Option<PNG> (alpha 0 = may change)}`; `ImageData {mime, bytes}`; `ModelInfo {id, kind}`; `pick_model`; **`trait Provider { kind, config, generate_text, generate_image, edit_image, list_models }`**; `build(cfg, key)`; `translate_error`; `json_value_bound` (refuses more than 1,000,000 JSON values before parsing); `nearest_ratio` | **as is**. Extend the request types: add `ChatRequest` (§6.3). |
| `src/provider/openai.rs` | `POST /responses` (`store: false`; JSON via `text.format = json_object`; images as `input_image` data URLs); `POST /images/generations` (gpt-image: `output_format png`, `quality auto`, `background transparent/auto`; dall-e: `response_format b64_json`); `POST /images/edits` multipart (`image[]`, `mask`, `input_fidelity high`); `GET /models`; `image_size(model, w, h)`; `parse_text` (refusal and incomplete handling); `parse_image` (link-only answer → a clear error); `model_kind` | **as is**. Add function tools to `/responses`. |
| `src/provider/gemini.rs` | `POST /models/{model}:generateContent` (percent-encoded), `systemInstruction`, `responseMimeType: application/json`; image modalities (gemini-3: IMAGE only); `imageConfig.aspectRatio`; edit = image + white-on-black mask + instruction; `parse_text`, `parse_image` (`promptFeedback.blockReason`, `finishReason` → `safety`); `GET /models?pageSize=200` | **as is**. Add `functionDeclarations` and `imageConfig.imageSize` (JS `geminiImageSize`). |
| `src/http.rs` | ureq 3 on rustls (ring) with `platform-verifier` (the OS trust store); `Body::{None, Json, Multipart}`; `Multipart` builder; total timeout, connect at most 20 s; reads in 64 KiB chunks, stopping at the size cap or on cancel; **HTTPS only, no redirects**, the proxy from the environment; loopback HTTP allowed only for tests (`is_loopback`); `User-Agent: Nib/<version>` | **as is** (User-Agent `Pigment/<version>`) |
| `src/keys.rs` | `ApiKey` (shape check, `MAX_KEY_LEN` 512, `Debug` prints `ApiKey([redacted])`, no Display/Serialize, `hint()` = the last 4 characters); **`trait SecretStore { get, set, clear, backend }`**; `default_store(config_dir)`; `MemoryStore`; `FileStore` (`ai-keys.json`, created 0600, atomic replace through a 0600 temporary file, re-chmodded to 0600 when read, deleted with the last key, 64 KiB cap); `os::OsStore` through **keyring 3.6** (`apple-native` → macOS Keychain, `windows-native` → Windows Credential Manager). Service `io.github.nihalpi1212.nib.ai`, account = provider id. | **as is**. Service `<Pigment app id>.ai`, taken from the brand constant the rebrand defines. |
| `src/accounts.rs` | `AiAccounts::{new(config_dir), in_memory(), with_store, set_base_url (loopback only), has_key, set_key, clear_key, default_provider, set_default_provider, set_models, set_consented, save, status() -> Vec<AccountStatus>, provider(kind) -> Arc<dyn Provider>, test_connection}`; `base_url_env(kind)` (`NIB_AI_BASE_URL_OPENAI` and `_GEMINI`, which refuse non-loopback addresses) | **as is** (env `PIGMENT_AI_BASE_URL_*`) |
| `src/settings.rs` | `AiSettings {default_provider, openai: Models, gemini: Models, timeout_secs (10–600), consented}` in `ai.json`. **No keys and no base URL**, so editing the file can't redirect a key. | **as is**. Add `image_provider`, `chat_provider`, `last_sky_prompt` and per-provider chat/image models to match JS. |
| `src/error.rs` | `AiError {kind, message, status}`. `ErrorKind`: `missingKey invalidKey quota safety network timeout badResponse cancelled badRequest notFound server document keyStore needsConsent`, with `id()`, `retryable()`, `redact(secret)` and `to_json()`. `From<vectorcraft_engine::EngineError>`. | **as is**. Change the `From` impl to `photocraft_engine::EngineError`. |
| `src/cancel.rs` | `CancelToken(Arc<AtomicBool>)`: `cancel`, `is_cancelled`, `check` | **as is**. Add a constructor that polls a closure, so `JobCtx::cancelled` can drive it. |
| `src/image_util.rs` | `decode` (with `MAX_SIDE` 8192), `encode_png`, `png_size`, `white_mask`, `cover`, **`ExpandPlan {new, inputs, compose}`** (an expand canvas, the mask, and composition that keeps the original pixels exactly), `parse_size`, `ratio_size` | **as is**. Expand is already raster. |
| `src/jobs.rs`, `src/genai.rs` | own job table: a thread per job, mpsc results, a waker that repaints egui, `cancel` reports at once and drops the late result, `wait(timeout)` for CLI and MCP, at most 16 results kept; `GenAi::{start, poll, apply, discard, cancel, test_connection}` | **not needed**: PhotoCraft's engine jobs do this (§5.3). Keep the lessons. |
| `src/ops.rs`, `ops/{vector,recolor,rewrite,expand}.rs` | prepare (UI thread, reads the document) → run (worker, no Session) → apply (one undo group of engine commands, re-checking what it relies on) | **pattern only**. `ops/expand.rs` shows how an image is replaced in place. |
| `src/sanitize.rs` (roxmltree SVG allowlist), `src/palette.rs`, `src/fit.rs`, `src/prompts.rs` (SVG and trace briefs, palette JSON) | | **vector-specific: drop** (except the expand prompt) |

### 2.2 Providers

| | OpenAI | Google Gemini |
|---|---|---|
| Base URL | `https://api.openai.com/v1` | `https://generativelanguage.googleapis.com/v1beta` |
| Auth | `Authorization: Bearer <key>` | `x-goog-api-key: <key>` (never `?key=`) |
| Text / JSON | `POST /responses` | `POST /models/{m}:generateContent` |
| Image | `POST /images/generations`; with references `POST /images/edits` with `image[]` | generateContent, `responseModalities`, `imageConfig.aspectRatio` |
| Masked edit | `POST /images/edits` multipart: `image[]`, `mask` (alpha 0 = change), `input_fidelity high` | generateContent: image + white-on-black mask + instruction |
| Models | `GET /models` | `GET /models?pageSize=200` |
| Nib's defaults | gpt-5.1 / gpt-image-1 | gemini-2.5-flash / gemini-2.5-flash-image |

Nib says its request shapes, model choices and error translation "follow the proven ones" of
Pigment JS. The port is therefore a reunion, not a redesign.

### 2.3 Consent, privacy and answer validation

- **Consent** is agreed once in AI Accounts (`AiSettings::consented`). Without it, `start` returns
  `needsConsent`, and the MCP or control channel cannot grant it.
- **Only what the feature needs is sent.** Results are kept in memory only (at most 16). OpenAI
  requests carry `store: false`. Logs name the feature, the provider and the outcome kind, never
  the prompt, key or answer.
- **Answers are treated as hostile.** JSON is bounded before parsing. Images are decoded with size
  and allocation limits. Base64 is checked. An SVG is sanitised: vector only. Errors carry the
  provider's message clipped to 300 characters. Key errors never quote the key; any message
  containing the key gets `[redacted]`.
- **Keys are never stored** in documents, `ai.json`, preferences, logs, crash reports, MCP output
  or `ui.inspect`. The status shows "connected" and the last four characters.

### 2.4 Threading and cancellation

Each request runs on a worker thread. Blocking ureq cannot be aborted from another thread, so:

- the cancel token is checked before sending, between 64 KiB chunks, and between variations;
- `cancel` reports *cancelled* at once and the late result is dropped;
- the provider still finishes, and bills, a request that was already sent, and the UI says so.

### 2.5 egui UI

These files total 1,564 lines.

- **`ui-egui/src/ai.rs`.** Defines `AiUi` (the `GenAi`, the account status as last read, window
  state) and the command ids `ai.textToVector`, `ai.shapeFill`, `ai.pattern`, `ai.expand`,
  `ai.recolor`, `ai.rewrite`, `ai.generatePanel`, `ai.accounts`, `ai.panel.generate`,
  `ai.panel.stop` and `ai.panel.place`. It provides `unsuitable()` (why a menu item is dimmed),
  `enabled`, `disabled_hint`, `checked`, `command`, `poll` (once per frame), `show`, `message`
  (rewrites "AI › AI Accounts" to the real path), `retryable`, `task_bar_items`, and
  `use_config_dir`.
- **`ai/generate.rs`, the Generate window.** A single non-modal `egui::Window`. It holds the prompt,
  the feature's options, a provider choice shown only when both providers have keys, and Generate,
  which becomes **Stop** with a spinner and elapsed seconds while a request runs. Below that are the
  error with **Open AI Accounts…** or **Try Again**, the results (click to place, one undo step;
  in-place features swap), and a line saying what will be sent.
- **`ai/accounts.rs`, AI Accounts.** A modal dialog. It shows a plain note on what is sent and who
  bills, OpenAI and Gemini tabs, and the key state with the store's name. The masked key field
  lives in `ai::accounts::Form`, never in `UiState` or dialog fields, and is cleared on save. It
  also has Test Connection (a job listing models), Remove Key, Get a key…, "Use this provider",
  Text model and Image model fields with **Use Suggested** and **Default**, the request timeout,
  and the one-time agreement checkbox.
- **Decisions worth copying.** There is no top-level AI menu: items sit where people look. A
  missing key does not dim menu items; the window explains, and only **Generate** is dimmed, with
  the reason as its tooltip. Task bar items appear only once a provider has a key.

### 2.6 Tests

There are 62 tests in `crates/genai/tests/genai/`, one test binary, with a local `TcpListener` mock
server (`common.rs`: `Got`, `Reply::{ok, json, after}`) and no real network:

| File | Tests | What it covers |
|---|---|---|
| `providers.rs` | 18 | request bodies, recorded answers, error translation, the key only in a header, the multipart mask, redaction, timeout, cancel before send, size cap, unreachable host, base URL rules |
| `ops.rs` | 19 | |
| `sanitize.rs` | 11 | |
| `units.rs` | 8 | |
| `keys.rs` | 6 | 0600 atomic file, status without keys, settings round trip |

There are also 12 kittest tests in `crates/ui-egui/tests/ai.rs`. They check that:

- nothing is sent before Generate;
- a result is placed as one undo step and Undo reverts it;
- Stop cancels;
- Test Connection reports the models;
- the typed key never appears in the accessibility tree, the preferences, `ai.json`, `ui.inspect`
  or the command list.

### 2.7 Hooks into upstream files (Nib `docs/FORK.md` § What Nib added)

There are new files and small hooks, all marked `#[cfg(not(target_arch = "wasm32"))]`:

- the `ai` field and module in `lib.rs`;
- `app.rs` (poll and draw);
- `menus/{run,state,bar,tree,ui_commands}.rs`, `canvas/task_bar.rs`, `prefs_dialog.rs`,
  `palette.rs` and `control.rs`.

The rule is "on a merge, keep them", and "check that the engine commands it drives keep their
parameters". The PhotoCraft equivalents are listed in §6.8.

### 2.8 What carries over and what doesn't

- **Nearly as is:** `provider.rs`, `provider/openai.rs`, `provider/gemini.rs`, `http.rs`, `keys.rs`,
  `accounts.rs`, `settings.rs`, `error.rs`, `cancel.rs`, `image_util.rs`, and the test harness
  `tests/genai/common.rs`, `providers.rs` and `keys.rs`. About 2,200 of the 4,329 lines.
  - The only vectorcraft dependencies outside `ops` are three things, each replaceable:
    `vectorcraft_format::base64_{encode,decode}` (use the `base64` crate, already in the engine at
    0.22 and in ui-egui at 0.23), `vectorcraft_engine::guard::catch_panic` (not needed with engine
    jobs) and `From<EngineError>`.
  - The ureq version and features match PhotoCraft's `Cargo.lock`: ureq 3.5.0 with rustls and
    `rustls-platform-verifier`, already there through craft-update. Only `keyring` 3.6 (macOS and
    Windows only) is new.
- **Vector-specific (drop):** `ops/vector.rs`, `ops/recolor.rs`, `ops/rewrite.rs`, `sanitize.rs`,
  `palette.rs`, `fit.rs`, the SVG and trace prompts, and roxmltree.
- **Missing in Nib, which Pigment had:**
  - chat with function tools across rounds (the Assistant);
  - Describe (a text request with an image: `TextRequest.images` already exists);
  - Sign in with ChatGPT (PKCE loopback flow, token refresh, plan-route reshaping, SSE
    aggregation: all in JS `main/ai.js`, with the pure parts unit-tested);
  - Gemini `imageSize`;
  - per-provider chat and image model choice with "Preferred provider";
  - variations for image edits.

---

## 3. craft-ai-integrations (the shared ArtCraft layer)

### 3.1 What the crates give

| Crate | Gives | Relevant to Pigment |
|---|---|---|
| `craft-ai-core` (9,005 lines) | the data model, wasm-safe: connections, `CapabilityId` (`image.inpaint`, `image.outpaint`, `image.generate`, `image.edit`, `image.segment`, `image.matte`, `text.complete`, …), `Role`, `Request` and `Payload`, `ConsentLedger` and `Disclosure`, `Provider` trait (`models`, `estimate`, `submit → JobId`, `poll → JobSnapshot`, `cancel`), conformance tests, mock | the contract |
| `craft-ai-native` | secret stores: OS keychain through **keyring 4.2** (`apple-native`, `windows-native`, `zbus-secret-service`); a passphrase-encrypted file (argon2 + chacha20poly1305); environment. The shared store with a locked atomic writer, consent file, history file. Default location `<config>/ArtCraft/ai`. `SharedStore::new(path)` takes any path. | keys |
| `craft-ai-client` | `AiClient::{standard(app), new(app, shared, secrets)}`, `status(&role)`, `plan(&role, request)`, consent check, `start(&plan, &ledger) → Job`, `poll` and `wait`, `cancel`; `ToolDesk` (which model serves each tool), `ConnectionManager`, `ProviderFactory`, `RunRecord`, setup flow | the app API. It depends on every adapter (comfyui, sam3, seedance, vertex, declarative, engine; candle, rten and burn are optional). |
| `craft-ai-openai` | OpenAI-compatible: `text.complete` over **`/chat/completions`** (streaming, tools, structured output); `image.generate`, `image.edit`, `image.inpaint` over `/images/*`. "Not yet: … **image input to chat (vision)**." | Fill, Generate. Not Describe, and not the Assistant's attached image. |
| `craft-ai-gemini` | **only `image.inpaint`** with an AI Studio key (Interactions endpoint, Nano Banana 2.1, Pro, 2, 2 Lite; JPEG output; mask as a second picture). "Built and tested offline only." | Fill only. No Gemini text, chat, Describe or Generate Image. |
| `craft-ai-bfl` | FLUX image and video, FLUX.1 Fill `image.inpaint` (no outpaint mapping) | a new provider Pigment never had |
| `craft-ai-vertex`, `craft-ai-artcraft`, `craft-ai-seedance`, `craft-ai-declarative`, `craft-ai-comfyui`, `craft-ai-sam3`, `craft-ai-media`, `craft-ai-http` | Vertex express images, ArtCraft Omni, video, data-file adapters, ComfyUI, SAM 3 bridge, hosted media copier, one TLS setting | not needed for parity |
| `craft-ai-engine`, `-rten`, `-candle`, `-burn` | local runners. **rten** (pure Rust, CPU): SAM 2.1 for `image.segment` (click and box prompts; ~35 ms per hover after a ~0.7 s first look, measured on one Windows machine); **BEN2 + ViTMatte** for `image.matte` (Remove background; 67 s for a 1600×1200 picture on Apple Silicon). Burn (GPU, optional): SAM 2.1, InSPyReNet. Candle: SAM 3 (Apache-2.0-only port). | an optional better local Remove Background or Select Subject |
| `craft-ai-features` | the built-in tool catalogue: `select-subject`, `remove-background`, `remove-object`, **`generative-fill`** (OpenAI, BFL, Gemini, ArtCraft Omni), **`generative-expand`** (`image.outpaint`), `generate-image`, video… Each "use" names a PhotoCraft feature. | the role ids upstream will use |
| `craft-ai-egui` | theme-neutral widgets: `ai_status`, `consent_prompt(_with_terms)`, `job_progress`, `ConnectionPanel`, `connection_form`, `model_picker`, `missing_model_popup`, `history_view`, `native_model_setup`; wording in `text` | AI Accounts and the picker. **English only** (plain `&'static str`), not through craft-i18n. |
| `craft-ai-agents`, `craft-ai-mcp` | the launcher's agents switch and app list; one MCP gateway for every Craft app | PhotoCraft **already depends on `craft-ai-agents`** (workspace `Cargo.toml`, rev `35e0352…`, the head of storytold/craft-ai-integrations#197) |

### 3.2 Maturity and API stability (from `README.md` and `docs/STATUS.md`)

- "The extension APIs are still evolving."
- `craft-ai-core` is a **local copy** that differs from the craft-libs one.
  `docs/CORE-SYNC.md` lists additions not yet upstream (`ConsentTerm`, `model_folders`, a JPEG XMP
  check) and says the dependency cannot switch yet.
- Every hosted adapter has been tested against scripted localhost servers only.
- Live runs: two recorded `AiClient` runs. OpenAI text ended in a quota error. One ArtCraft Omni
  image succeeded.
- One PhotoCraft run: "a local PhotoCraft build based on `storytold/photocraft#10903` completed one
  Nano Banana 2 fill through the Omni adapter. The tester reported poor blending. … Document pixel
  preservation, saved-result integrity and undo/redo were not verified."
- "No app imports the widgets." Native widget behaviour (IME, focus, clipboard) is not verified.
  macOS and Linux keychains are not verified.
- The built-in recommended-models catalogue `catalog.json` is empty.
- The repository head is one squashed commit, so there is no history to judge churn by.

### 3.3 Adding it to the workspace

- **egui compatibility: yes.** Both trees pin the same storytold fork:
  - `egui` and family at `6d518fc799681571963842f95b55a6b68431b15a`;
  - `winit` at `a517b3846ee8457d84ee4975110bfda6797c44dc`.

  PhotoCraft's `Cargo.toml` already repeats the `[patch.crates-io]` recipe that
  craft-ai-integrations asks adopters to repeat. `craft-ai-egui` needs Rust 1.95, which is
  PhotoCraft's `rust-version`.
- **Dependency lines.** Git dependencies in `[workspace.dependencies]`:

  ```toml
  craft-ai-client = { git = "https://github.com/storytold/craft-ai-integrations", rev = "<rev>" }
  craft-ai-core = { …same rev… }
  craft-ai-egui = { …same rev… }
  ```

  Bump the existing `craft-ai-agents` to the **same rev**. That avoids two checkouts of one
  repository, and two `craft-ai-core` identities later. Then run `cargo deny` (craft-ai ships a
  `deny.toml`).
- **Footprint.** keyring 4.2 brings zbus on Linux. Also new: argon2, chacha20poly1305, `url`, `png`
  0.18 and, through `craft-ai-client`, every adapter crate. rten 0.28 and its models are optional.
  Gate it all with `[target.'cfg(not(target_arch = "wasm32"))'.dependencies]`: only `craft-ai-core`
  builds for wasm.
- **The shared store and branding.** `AiClient::standard` reads and writes the ArtCraft Launcher's
  store (`<config>/ArtCraft/ai`) and the `craft-ai` keychain service. A rebranded Pigment that,
  like Nib, "reads nothing from upstream's folders" must call
  `AiClient::new(app, SharedStore::new(<pigment config>/ai/store.json), secrets)` with its own
  keychain service name.

### 3.4 Licences

- The workspace is MIT OR Apache-2.0 (`LICENSE-MIT`, `LICENSE-APACHE`), like PhotoCraft.
- `craft-ai-engine-candle` contains an **Apache-2.0-only** port of the Hugging Face SAM 3 code (its
  `NOTICE`). Do not enable the `candle` feature, or carry its NOTICE.
- Model weights are downloaded at run time, never bundled:

  | Model | Licence | Size |
  |---|---|---|
  | SAM 2.1 ONNX | Apache-2.0 (Meta), as declared by the converter | |
  | BEN2 | MIT | 222,932,053 bytes |
  | ViTMatte small | Apache-2.0 (conversion states none) | 103,885,865 bytes |
  | ViTMatte base | Apache-2.0 (conversion states none) | 387,371,620 bytes |
  | InSPyReNet | MIT, as declared by the author | |
- Nib's genai: MIT OR Apache-2.0, the same team. keyring, ureq and rustls are MIT/Apache; ring is
  ISC/Apache. They are already in the PhotoCraft lock, except keyring.

---

## 4. Why this choice

| | Nib's genai | craft-ai-integrations today |
|---|---|---|
| Fill (OpenAI, Gemini) | yes (edit with mask) | OpenAI yes. Gemini inpaint yes, tested offline only. |
| Expand | yes (`ExpandPlan`) | no outpaint adapter; could be done as inpaint on a grown canvas |
| Generate Image, Gemini key | yes | no (only Vertex express) |
| Describe (vision) | yes (`TextRequest.images`, both providers) | no (OpenAI vision "not yet", no Gemini text) |
| Assistant (tools, both providers) | text only; tools to add | OpenAI `/chat/completions` tools, no vision, no Gemini |
| ChatGPT sign-in | no (port from JS) | no |
| Keys on Linux | 0600 file (no D-Bus) | Secret Service via zbus, or an encrypted file needing a passphrase UI, "not verified" |
| Localised UI | ours, through `tl!` | widgets English-only |
| Proven in an app | Nib, with 12 UI tests | none |
| Upstream alignment | none | upstream PhotoCraft's planned route (`tools/crop_task_bar.rs`: "once generative fill comes through the shared AI layer (#41, #1199)"; catalogue entries "Used live from PhotoCraft") |

Craft-ai-integrations would leave Describe, half of the Assistant, Gemini Generate Image and
Expand without a provider. Adopting it would mean adding adapters there first, in another team's
repository, against an API that is still moving. Nib's code covers almost everything, has the same
request shapes as JS Pigment, and runs in a shipped app.

Upstream alignment is kept through three choices:

1. The **engine trait** (§6.2) speaks in capabilities and pixels, never in provider types. An
   `AiClient`-backed implementation is a drop-in later.
2. Our command ids are in the `ai.*` namespace, so a future upstream `edit.generativeFill` cannot
   collide on a merge. Our command can then forward to it, or keep its own id as an alias.
3. Our role-like ids follow `craft-ai-features` where they overlap: `generative-fill`,
   `generative-expand`, `generate-image`, `remove-background`.

**When to revisit:** craft-ai-integrations has Gemini text and vision, OpenAI vision, and outpaint;
upstream PhotoCraft has merged its adoption; and `craft-ai-core` is one crate in craft-libs. At that
point write `crates/genai/src/craft_backend.rs` implementing `GenerativeBackend` over `AiClient`,
and offer it as a second connection type.

---

## 5. PhotoCraft integration points (read from the code)

### 5.1 Commands: registry, parameter schemas, undo

- **Registry:** `crates/engine/src/cmd.rs`.
  - `CommandSpec` has these fields:
    - `id: &'static str`, `label`;
    - `menu: &[&str]` (empty = not in menus);
    - `shortcut: Option<&str>` (egui notation, `Cmd+Shift+N`);
    - `params: &'static str`, a human- and agent-readable JSON-ish schema such as
      `r##"{"layer":id?,"sampleAllLayers":bool=false} → {layer,bounds}"##`;
    - `enabled: fn(&Session) -> Result<(), String>` (the `Err` text is the dimmed reason);
    - `run: fn(&mut Session, &Value) -> Result<Value>`;
    - `journal: bool` (false for queries).
  - The `cmd!` macro builds them. `registry()` is a `OnceLock` built once by `build()`.
  - Modules contribute with `v.extend(crate::cutout_cmds::specs())` (`cmd.rs:1369`), are declared
    as `pub mod cutout_cmds;` (`cmd.rs:83`) and re-exported in `lib.rs:85`.
  - Lookup: `commands::find(id)`, `command_specs()`, `list_entry(s, spec, reason)` (the
    `command.list` and MCP row: id, label, menu, shortcut, params, enabled, disabledReason,
    needsDocument, keywords). `SEARCH_KEYWORDS` adds aliases.
- **Parameter checking:** `crates/engine/src/param_check.rs` (`param_check::check(spec, params)`,
  used by `Session::precheck`). Dialogs are generated from the same `params` string (§5.7).
- **Running:** `Session::execute(id, params)` runs inline: tests, CLI, scripts.
  `Session::start(id, params)` runs a job-capable command in the background and returns
  `Started::{Done(v), Job(id)}` (`crates/engine/src/session/execute.rs`, `jobs.rs:1064`).
- **Undo and history:** `Session::edit(label, |doc: &mut Document, active: &mut Option<LayerId>|
  -> Result<R>)` is one named history step, with journal, damage and post-command hooks
  (`session/execute.rs:232`). `edit_visibility` is for visibility-only changes. Any command
  accepts `"coalesce": "<key>"`: consecutive edits with the same key share one step. Use this when
  an AI command must chain two engine commands into one step (Generative Expand: canvas size +
  new layer); otherwise do both inside one `s.edit` closure. There is no explicit undo-group API.
- **Worked example to copy:** `crates/engine/src/cmd/cutout_cmds.rs`, `layer.removeBackground`.
  It shows a pixel-layer check (`check`), `enabled`, `layer_param(s, p)`,
  `jobs::edit_job(s, label, |doc, active, ctx| …, finish)` with `ctx.stage(lo, hi, msg, |interrupt| …)`,
  `ctx.cancelled()`, and setting `layer.mask` through
  `commands::mask_at_depth(LayerMask{surface, ..LayerMask::reveal_all()}, doc.depth)`, plus its tests.

### 5.2 Pixels in and out

**Create a raster layer from RGBA pixels at a position.** The pattern is `edit.paste`,
`crates/engine/src/cmd/edit_cmds.rs:491`:

```rust
let surf = Surface::from_interleaved(PixelFormat::RGBA8, Rect::new(x, y, x + w, y + h), &rgba);   // photocraft_raster
let target = PixelFormat::new(fmt.mode, fmt.sample, true);          // fmt = doc.pixel_format()
let surf = if surf.format() == target { surf } else { surf.convert(target) };
s.edit("Generative Fill", |doc, active| {
    let mut l = Layer::raster(doc.next_layer_name("Generative Fill"), target);     // photocraft_doc::Layer
    *crate::pixels_mut(&mut l)? = surf;                                            // lib.rs:191, pub(crate)
    let id = crate::layer_place::insert_new(doc, *active, l, crate::layer_place::Place::AutoEditable);
    *active = Some(id);
    Ok(id)
})?;
```

- `layer_place::insert_new` and `Place::{Auto, AutoEditable, Above, Below}` handle groups,
  artboards and clipping (`crates/engine/src/layer_place.rs:64`). Use `Place::Above` for the
  second and later variations.
- For colour-managed conversion of a non-sRGB document, `color_cmds::convert_surface(&surface,
  ColorMode::Rgb, target, &transform)` exists (`cmd/color_cmds.rs:674`). Paste uses plain
  `Surface::convert`, so start with that for consistency and note it as a refinement.
- Resampling: `photocraft_algo::resample::resize_surface(&s, sx, sy, filter)`
  (`crates/algo/src/resample.rs:312`).

**Add a layer mask from the selection:**

- inside an edit:
  `layer.mask = Some(mask_at_depth(LayerMask { surface: doc.selection.clone()?, ..LayerMask::reveal_all() }, doc.depth)?)`;
- or call `layer_params::selection_mask(doc)` (`cmd/layer_params.rs:84`, `pub(crate)`);
- as a command: `layer.layerMask.revealSelection {"layer": id}` (`cmd.rs:823`), which also drops
  the selection in the same step.

**Read the selection mask.** `doc.selection: Option<Surface>` is a grayscale coverage surface
(`crates/doc/src/lib.rs:912`). Its bounds are `sel.content_bounds()`. Read it with
`sel.read_region(rect) -> Vec<f32>` or `sel.to_interleaved(rect)`. `inspect::document` reports
`hasSelection` and `selectionBounds`.

**Read the composite:**

- `photocraft_compose::thumbnail(doc, max_side) -> Rgba8Image` (`crates/compose/src/reduced.rs:15`)
  is a downscaled RGBA8, proxied for large documents. Use it for Describe and the Assistant
  attachment (1024 px).
- `photocraft_compose::render::composite_to_surface(doc, rect, fmt, background) -> Surface`
  (`crates/compose/src/render.rs:210`) gives an exact region. Pass `PixelFormat::RGBA8` and
  `None`, then call `to_interleaved(rect)`. Use it for the fill region. `flatten_to_surface(doc, fmt, bg)`
  gives the whole canvas.
- `photocraft_io::export_preview_png_with_renderer(doc, None)` gives a full-size 8-bit PNG.
- `photocraft_automation::files::render_png(doc, max_side)` is what MCP `doc_render_preview` uses.
- Colour: the composite is in `color_cmds::composite_profile(doc)`, which is the document profile
  for RGB and sRGB for CMYK and Lab (`crates/engine/src/display_color.rs` module docs).

**Read the active layer's pixels:**

- `Layer::surface()` returns the raster surface, or the cached render of text, shape and smart
  layers (`crates/doc/src/lib.rs`);
- then `Surface::read_rgba8_into(rect, &mut [[u8;4]])` (`crates/raster/src/lib.rs:1037`);
- for "the layer alone, masks and effects applied", use
  `photocraft_engine::pixels::composite_layers(&solo_doc, PixelFormat::RGBA8, None)`
  (`crates/engine/src/pixels.rs:11`);
- `smartselect_cmds::with_doc_sampler` is the layer sampler used by Select Subject.

**Encode and decode:** `photocraft_codecs::encode(&Image::from_u8(w, h, ChannelLayout::Rgba,
pixels)?, Format::Png, &Default::default())`, as used in `crates/automation/src/files.rs`. Decode
through `photocraft_codecs` too. It handles PNG, JPEG and WebP; Gemini may answer with JPEG.

### 5.3 Long jobs off the interface thread

`crates/engine/src/jobs.rs` (module docs at the top):

- `jobs::run(s, label, lock_document, work: FnOnce(&JobCtx) -> Result<T> + Send, apply:
  FnOnce(&mut Session, T) -> Result<Value> + Send)` (`jobs.rs:740`).
  - `work` runs on a worker thread named `photocraft-job-N` when started with `Session::start`, and
    inline under `execute`. It catches panics. It must only read what it captured: clone the
    `Arc<Document>` (documents are copy-on-write).
  - `apply` runs on the UI thread as one step through the normal command path.
  - With `lock_document`, other edits to that document are refused while the job runs, and apply
    fails if the document changed anyway.
- `jobs::edit_job(s, label, |doc, active, ctx| …, finish)` (`jobs.rs:894`) is the `Session::edit`
  form.
- `Session::start_job(command, params, label, lock, work, apply)` (`jobs.rs:1410`) is for
  non-command jobs.
- `JobCtx`: `progress(fraction, msg)`, `cancelled()`, `check()`, `stage(lo, hi, msg, |&Interrupt| …)`,
  `commit()` (point of no return).
- Session: `poll_jobs() -> Vec<JobEvent>`, `wait_job`, `cancel_job`, `try_cancel_job`
  (`CancelRefused`), `jobs()`. `JobInfo` has id, command, label, document, state, progress,
  message, elapsed_ms, result and error. At most 16 background jobs.
- Engine commands `jobs.list` and `jobs.cancel` (`jobs.rs:2165`) are also MCP `jobs_list` and
  `jobs_cancel`.
- **wasm:** `start` runs inline. Only `StepWork` jobs (Place) are sliced cooperatively.

UI side, `crates/ui-egui/src/jobs_ui.rs`:

- `jobs_ui::run(app, id, params)` starts in the background when `app.background_jobs` is set
  (the desktop app does this).
- `tick` is called every frame from `app/frame.rs:99`.
- `status_progress` draws the status bar with Cancel.
- `dialog` is a **modal** progress window for a job that locks the active document, shown after
  `DIALOG_DELAY_MS`. Exempt today: Batch, saves, and `file.placeEmbedded` and `file.placeLinked`
  when the status bar is visible (`place_uses_status_bar`, `jobs_ui.rs:1146`).
- **Hook needed:** add `ai.*` to that exemption, so a 30-second generation does not block the
  window behind a modal. The person can still pan, zoom, use other documents and press Cancel in
  the status bar.

### 5.4 Menus, palette, invoke

- **`crates/ui-egui/src/menu_catalog.rs`.** `CATALOG: &[(&[&str] path, label or "---", Option<shortcut>, id)]`
  holds Photoshop's tree, in order, generated from the recorded menu structure. An item whose id
  is a live engine or UI command is enabled; others render disabled.
  - Relevant rows: `(&["Edit"], "Content-Aware Fill…", None, "edit.contentAwareFill")` (line 100),
    `(&["Edit", "Preferences"], "AI Integrations…", None, "edit.preferences.integrations")` (line
    155), and `(&["Select"], "Sky", None, "select.sky")`.
  - It has **no Generative Fill or Generative Expand rows**.
- **`crates/ui-egui/src/menus/items.rs`.**
  - `menu_items(app)` = the catalogue, then `UI_COMMANDS`, then engine commands with a `menu`
    path.
  - `PLACE_AFTER: &[(id, after)]` puts an outside command right after a catalogue item. Use it
    for `("ai.generativeFill", "edit.contentAwareFill")` instead of editing the catalogue.
  - `is_live(id)` lists the shell handlers (`crate::analysis_ui::handles`,
    `crate::preset_panels::handles`, …). Add `crate::ai_ui::handles`.
- **`crates/ui-egui/src/menus.rs`.** `UI_COMMANDS =
  photocraft_engine::shell_commands::SHELL_COMMANDS` (`crates/engine/src/shell_commands.rs`:
  id, label, menu path, default shortcut). These are shell-only commands the engine knows, so
  headless shortcut sets see them. Add `ai.accounts` and `window.panel.aiAssistant` there, in a
  Pigment block at the end. `TOP_MENUS` lists the 10 Photoshop menus.
- **`crates/ui-egui/src/menus/invoke.rs`.** `invoke(app, ctx, id, params)` is the one entry for
  menus, shortcuts, palette and automation. It checks `app.services.automation_command` first when
  `app.automation_input`. `invoke_early_commands` chains shell handlers of the form
  `if let Some(r) = crate::xxx_ui::menu(app, id, params) { return Some(r); }`. Add
  `crate::ai_ui::menu` there.
- Enabled and checked state: `menus/state.rs` (`is_enabled`, `checked`) and
  `menus/enable_rules.rs`. Also `menus/native_menu.rs` (macOS), `menus/search.rs` and
  `dialogs/palette.rs` (command palette).

### 5.5 Contextual task bar, canvas menu, options bar

- **`crates/ui-egui/src/widgets/task_bar.rs`.** The reusable floating bar: position rule, grip, the
  ⋯ menu (`MoreMenu`), `TaskBarPlace` state, `show(...)`, `position(place, anchor, area, size)`.
  Its docs anticipate other contexts: "Remove Background #2815, selections #2708, #7633, #8106".
- **`crates/ui-egui/src/tools/crop_task_bar.rs`.** The Crop tool's bar, drawn from `canvas.rs:1784`.
  Item 2 is reserved: "*Generative Expand goes here* once generative fill comes through the shared
  AI layer (#41, #1199)". The slot is marked at line 66.
- **`crates/ui-egui/src/canvas/canvas_tool_menu.rs:498`.** `SELECTION_MENU`: "Its Generative Fill
  row has no PhotoCraft command and is left out." That is where a `Generative Fill…` row goes.
- **`crates/ui-egui/src/panels/options_bar.rs:654`.** The Crop "Fill:" dropdown says "Generative
  Expand is not offered".
- No selection task bar exists yet. A Generative Fill bar under the selection is new code built on
  `widgets::task_bar::show`.

### 5.6 Preferences

- `crates/ui-egui/src/prefs/prefs_ui.rs` and `prefs/prefs_ui/*.rs` hold the pages.
- `prefs_ui/agents.rs` is **Preferences › AI Integrations**. It covers agents and MCP only: the
  ArtCraft Launcher switch through `Services::launcher_agents`, the port, the folders, and what
  `photocraft-cli mcp` does while the app is closed.
- Add a "Generative AI" group there with an **AI Accounts…** button, as Nib put one in Preferences.
  Engine preferences (`app.session.prefs()`) are saved with the app. **Do not put AI settings
  there:** they go in `ai.json` (§6.4).

### 5.7 Dialog and window patterns

- **Spec-driven dialogs:** `crates/ui-egui/src/dialogs/filter_dialog.rs`.
  - `open_with_spec(app, command, label, spec, fixed) -> u64` builds a dialog from a params-spec
    string (`parse_spec`; field kinds `Range`, `Choice`, `Bool`, `Int`, `Text`). On OK it runs the
    command with `params_of(fields)`.
  - `open(app, command)` uses the command's own `params`. Example: `menus/invoke.rs`
    `frame_convert_dialog`.
  - This is enough for Generate Image's size and target, Expand's size and anchor, and
    Variations. A multi-line prompt and the provider/model picker need a custom window.
- **Floating windows:** `egui::Window::new(title)…` with `handles(id)`, `checked(app, id)` and
  `menu(app, id, params)`, as in `crates/ui-egui/src/tools/analysis_ui.rs` (Notes and Measurement
  Log, `window.panel.notes`).
- **Modals:** `egui::Modal::new(Id)…show(ctx, …)`, as in `jobs_ui::dialog`.
- **Dialog state** lives in `app.ui.dialogs` (`state::DialogKind`). Its fields are visible to
  `ui.dialog.get` and `ui.inspect`, so **key fields must never live there.** Nib's rule: the key
  field belongs to the AI UI's own struct.

### 5.8 Strings and i18n

- `crates/ui-egui/src/i18n.rs` provides `tl!`, `tr`, `tr_ctx`, `tr_id` (command-id keyed), `trn`
  (plurals) and `fmt` (`{name}` placeholders).
- Catalogues live in **storytold/craft-i18n**: `locales/<code>/common.tsv` and `photocraft.tsv`,
  at the commit in `craft-i18n.rev` (`e56d262…`). `crates/ui-egui/build.rs` embeds them from
  `CRAFT_I18N_DIR`.
- **A feature PR adds English only.** Missing rows show in English and never fail a build.
  `cargo xtask i18n-report` lists the gaps.
- Engine command labels and params stay English; menus translate them through `tr_id`.

### 5.9 MCP, control channel, CLI: what the Assistant maps onto

- **MCP server:** `crates/automation/src/server.rs` (rmcp 3.5).
  - Tools: `session_list`, `doc_open`, `doc_new`, `doc_save`, `doc_export`, `doc_inspect`,
    `doc_render_preview`, `doc_select`, `doc_close`, **`command_list`**, **`command_run`**,
    **`command_batch`**, `jobs_list`, `jobs_cancel`, `ui_inspect`, `ui_screenshot`, `ui_pointer`,
    `ui_menu_invoke`, `ui_set` and `control_call`.
  - `command_run` waits on a job, and cancels it when the wait is dropped.
  - Headless sessions are in `crates/automation/src/headless.rs` (`render_png`); the bridge to a
    running app is `bridge.rs`.
  - The agents gate is `craft-flags` plus `craft-ai-agents` (`crates/automation/Cargo.toml`).
- **Control channel:** `crates/ui-egui/src/control/dispatch.rs`, for example `"jobs.list"` and
  `"ui.inspect"`.
- **Authorisation:** `Services::automation_command` and `automation_authorize`
  (`crates/ui-egui/src/services.rs:582`) gate commands that come from automation.
- **CLI:** `apps/photocraft-cli/src/args.rs`, enum `Command { Convert, Info, Run, Batch, Droplet,
  Commands, Mcp, Serve, … }`. `run` takes `--file|--new` and `--cmd id=json` steps and `--out`;
  `commands` lists the registry. **Every engine command is reachable from the CLI and MCP with no
  extra code.**
- **What this means for the Assistant.** Its tool set maps onto the same surfaces that MCP already
  exposes, but runs in-process through `menus::invoke`:

  | Assistant tool | Maps onto |
  |---|---|
  | `get_document` | `photocraft_engine::inspect::document(app.session.active()?)`, the `doc_inspect` payload |
  | `list_commands {filter}` | `command_specs()` + `list_entry` + `list_entry_matches`, as `command_list` does |
  | `run_command {id, params}` | `menus::invoke(app, ctx, id, params)` behind an Assistant allowlist |
  | `render_preview` | `photocraft_compose::thumbnail` |
  | `generative_fill` | `ai.generativeFill` |

  JS's specialised tools (`apply_adjustment`, `select`, `crop`, `canvas_size`, `fill_selection`,
  `add_text`, …) become thin wrappers that build the right engine params (`image.adjustments.*`,
  `select.rect`, `image.crop`, `image.canvasSize`, `edit.fill`, `type.create`, `layer.setProps`,
  `layer.new.layer`) and validate ranges, as JS's `ADJUST_RANGES` did.

### 5.10 The web (wasm) build

- `apps/photocraft-web` (eframe web runner, WebGPU with a WebGL2 fallback). The engine and
  ui-egui compile to wasm32.
- `Session::start` runs inline (no threads). ureq, keyring and blocking IO do not exist there.
- **Gate every AI dependency and call site** with `#[cfg(not(target_arch = "wasm32"))]`, as Nib
  did. Its genai root is `#![cfg(not(target_arch = "wasm32"))]`, and ui-egui takes it as a
  `[target.'cfg(not(target_arch = "wasm32"))'.dependencies]` entry.
- The engine `ai.*` commands stay compiled on wasm, because they have no network code. They are
  disabled with "Generative AI is available in the desktop app" when no backend is installed.
  Their menu items are hidden there, as Nib drops `ai.*` items from the browser build's menus and
  palette.
- The web bundle has a size budget: egui fonts are shipped deflated "for the web build's size
  gate", per `Cargo.toml`. Nothing AI-related may enter the web dependency graph.
- JS Pigment's browser version kept keys in the browser. A later web backend could implement
  `GenerativeBackend` over `web_sys` fetch (OpenAI and Gemini accept browser CORS requests) with
  `localStorage` keys. **Out of scope for this work package.**

### 5.11 Where the app wires things

- `crates/ui-egui/src/app/frame.rs`: the per-frame hooks. Poll AI UI state next to
  `jobs_ui::tick` (line 99) and draw windows next to `jobs_ui::dialog` (line 367).
- `crates/ui-egui/src/services.rs`: `Services` holds the platform functions (file IO, clipboard,
  `open_url`, `encode_png`, `agent_link`, …). Add `generative: Option<Arc<dyn GenerativeBackend>>`
  here, or install it straight on the session at start-up.
- `apps/photocraft/src/services.rs` and `apps/photocraft/src/app_dirs.rs` (`config_dir()`) build the
  desktop services and the settings folder (`PHOTOCRAFT_CONFIG_DIR`, the portable `…Data` folder;
  the rebrand renames these). The CLI builds its own session in `apps/photocraft-cli/src/lib.rs`.

### 5.12 Local features that already overlap

| Command | File | What it is | Use for AI |
|---|---|---|---|
| `layer.removeBackground` | `crates/engine/src/cmd/cutout_cmds.rs` | Select Subject + edge refinement → a layer mask on the same layer, one step, no network | the default Remove Background route |
| `select.subject`, `select.sky` | `crates/engine/src/cmd/select_extra_cmds.rs:234`, `crates/algo/src/segment/{subject,sky}.rs` (`select_subject_with`, `select_sky`) | local subject and sky selection | the masks for Replace Background and Replace Sky. Better than JS's top-edge flood fill. |
| `edit.contentAwareFill` | | local PatchMatch fill | a no-network alternative to offer in the empty-prompt case |

---

## 6. The design

### 6.1 Crates and files (new files unless marked hook)

```
crates/engine/src/generative.rs              trait GenerativeBackend + request/answer types (no I/O)
crates/engine/src/generative/mock.rs         MockBackend (scripted answers; cfg(any(test, feature = "testgen")))
crates/engine/src/cmd/ai_cmds.rs             specs(): the ai.* commands
crates/engine/src/cmd/ai_cmds/region.rs      fill_region, pad_to_aspect, masks, composite_through_mask, key_white_border
crates/engine/src/cmd/ai_cmds/fill.rs        ai.generativeFill, ai.replaceBackground, ai.replaceSky
crates/engine/src/cmd/ai_cmds/expand.rs      ai.generativeExpand
crates/engine/src/cmd/ai_cmds/generate.rs    ai.generateImage
crates/engine/src/cmd/ai_cmds/background.rs  ai.removeBackground
crates/engine/src/cmd/ai_cmds/describe.rs    ai.describe, ai.status, ai.testConnection
crates/engine/src/cmd/ai_cmds/tests.rs
crates/engine/src/cmd.rs                     hook: `pub mod ai_cmds;` + `v.extend(crate::ai_cmds::specs());`
crates/engine/src/lib.rs                     hook: `pub mod generative;`, Session field + set_generative()

crates/genai/  (package pigment-genai, root #![cfg(not(target_arch = "wasm32"))])
  Cargo.toml                                 ureq 3.5 (rustls-no-provider, _ring, gzip, platform-verifier), keyring 3.6 mac/win, base64, serde_json, log, thiserror, photocraft-engine, photocraft-codecs
  src/lib.rs
  src/provider.rs  provider/openai.rs  provider/gemini.rs   ported from Nib + chat tools + describe
  src/chat.rs                                ChatRequest/ChatTurn/ToolCall, schema cleaning (JS cleanSchema/geminiSchema)
  src/http.rs  keys.rs  accounts.rs  settings.rs  error.rs  cancel.rs  image_util.rs   ported from Nib
  src/backend.rs                             impl photocraft_engine::generative::GenerativeBackend for GenAiBackend
  src/chatgpt.rs                             (P5) Sign in with ChatGPT
  tests/genai/{main,common,providers,keys,chat,backend,chatgpt}.rs

crates/ui-egui/src/ai_ui.rs                  AiUi state, handles/checked/menu/poll/show, unsuitable()
crates/ui-egui/src/ai_ui/accounts.rs         AI Accounts modal
crates/ui-egui/src/ai_ui/generate.rs         the feature window (prompt, options, provider/model, Generate/Stop, error)
crates/ui-egui/src/ai_ui/describe.rs         Describe result window (Copy, Use as document description)
crates/ui-egui/src/ai_ui/task_bar.rs         selection task bar (Generative Fill) + crop slot item
crates/ui-egui/src/ai_ui/assistant.rs        (P4) the Assistant window
crates/ui-egui/src/ai_ui/assistant_tools.rs  (P4) tool schemas, allowlist, argument checks
crates/ui-egui/tests/ai.rs                   kittest + mock backend

apps/photocraft-cli/src/ai.rs                `ai status|set-key|clear-key|test` (hook: one variant in args.rs)
docs/generative-ai.md                        the contract, like Nib's (coordinate the FORK list with the rebrand)
```

### 6.2 The engine seam: `photocraft_engine::generative`

```rust
// crates/engine/src/generative.rs  (no network, compiles for wasm)
use photocraft_raster::Rgba8Image;

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProviderId { OpenAi, Gemini }                 // later: Craft(connection id) for an AiClient backend

pub struct BackendStatus {                             // what menus and dialogs need; no secrets
    pub providers: Vec<ProviderStatus>,                // id, label, connected, hint ("…abcd"), store name, image_capable, chat_capable, image_model, chat_model
    pub default_provider: Option<ProviderId>,
    pub consented: bool,
}

pub struct Choice { pub provider: Option<ProviderId>, pub model: Option<String> }   // None = the defaults

pub struct ImageEdit {                                 // image.inpaint
    pub choice: Choice,
    pub prompt: String,
    pub image: Rgba8Image,                             // sRGB, straight alpha, the region
    pub mask: Option<Rgba8Image>,                      // alpha 255 = may change (Pigment's convention; providers convert)
    pub transparent: bool,                             // ask for alpha (gpt-image-1) or white-keyed (others)
}
pub struct ImageGen { pub choice: Choice, pub prompt: String, pub width: u32, pub height: u32, pub transparent: bool }
pub struct Describe { pub choice: Choice, pub image: Rgba8Image, pub prompt: Option<String> }
pub struct ChatRequest { pub choice: Choice, pub instructions: String, pub messages: Vec<ChatMessage>, pub tools: Vec<ToolSpec> }
pub struct ChatTurn { pub text: String, pub tool_calls: Vec<ToolCall>, pub provider_state: serde_json::Value /* opaque: OpenAI items, Gemini parts incl. thought signatures */ }

#[derive(Debug)]
pub struct GenError { pub kind: &'static str /* AiError ErrorKind::id(): missingKey, needsConsent, quota, safety, … */, pub message: String, pub status: u16 }

pub trait GenerativeBackend: Send + Sync {
    fn status(&self) -> BackendStatus;
    /// Each call blocks; `cancelled` is polled before sending, between response chunks and between steps.
    fn edit_image(&self, req: &ImageEdit, cancelled: &dyn Fn() -> bool) -> Result<Rgba8Image, GenError>;
    fn generate_image(&self, req: &ImageGen, cancelled: &dyn Fn() -> bool) -> Result<Rgba8Image, GenError>;
    fn describe(&self, req: &Describe, cancelled: &dyn Fn() -> bool) -> Result<String, GenError>;
    fn chat(&self, req: &ChatRequest, cancelled: &dyn Fn() -> bool) -> Result<ChatTurn, GenError>;
    fn list_models(&self, provider: ProviderId, cancelled: &dyn Fn() -> bool) -> Result<Vec<(String, &'static str /* text|image|other */)>, GenError>;
}
```

- Session hook (in `crates/engine/src/lib.rs`): add a field `generative: Option<Arc<dyn GenerativeBackend>>`
  to `Session`, with `pub fn set_generative(&mut self, b: Option<Arc<dyn GenerativeBackend>>)` and
  `pub fn generative(&self) -> Option<Arc<dyn GenerativeBackend>>`. These are two to three lines in an
  upstream file; list them in FORK.md.
- `EngineError`: return `EngineError::Other(format!("{kind}: {message}"))`, or add a typed
  `EngineError::Generative { kind, message }` so the UI can offer **AI Accounts…** or **Try
  Again**. A typed variant is cleaner: `JobEvent::error` already carries typed errors (`jobs.rs:424`).
- The trait answers **sRGB RGBA8 at the size asked**. The provider-specific steps all happen inside
  the backend, using Nib's code and JS `providers.js`: padding to the provider's aspect ratio,
  provider sizes, mask conventions, PNG and base64, keying white for Gemini transparency, and
  resampling back. The engine command owns the document-side steps: choosing the region,
  compositing through the mask, and making the layers.

### 6.3 The commands

All are registered by `crates/engine/src/cmd/ai_cmds.rs`. All are `journal: true` except
`ai.describe`, `ai.status` and `ai.testConnection`. Each follows `run` → `jobs::run(s, label,
true, work, apply)`. The **work** step runs on the worker: it composes the region from the captured
`Arc<Document>`, calls the backend, checks `ctx.cancelled()`, and composites through the mask. The
**apply** step runs on the UI thread as one `s.edit`.

| Id | Params (`params` string) | Enabled when | Result / effect |
|---|---|---|---|
| `ai.generativeFill` | `{"prompt":str,"variations":1..3=1,"provider":"openai\|gemini"?,"model":str?,"layer":id?} → {layers:[id]}` | document, selection, not locked | `n` raster layers named "Generative Fill", "Generative Fill 2" …, each the region with alpha = the feathered selection (JS `featherKeepingBorder`, radius 1), above the active layer (`Place::AutoEditable`, then `Place::Above`). The last one is active. One step "Generative Fill". The selection is kept, as in JS. |
| `ai.generativeExpand` | `{"width":int?,"height":int?,"anchor":"nw\|n\|ne\|w\|c\|e\|sw\|s\|se"="c","prompt":str="",…choice} → {layer}` | document | Grow the canvas (as `image.canvasSize` with transparent fill), then fill the transparent band of the composite. **One step**: do both inside one `s.edit` (call `canvas_geom` like `image.canvasSize` does), or use `coalesce`. Without a size, fill the existing transparent area (JS behaviour). Uses Nib `ExpandPlan` for the mask and composition. |
| `ai.generateImage` | `{"prompt":str,"target":"layer\|document"="layer","width":16..8192?,"height":16..8192?,"transparent":bool=false,…choice} → {layer}\|{document}` | always (layer target: a document) | Layer: document-sized, cover-fit, never stretched (JS `coverTo`). Document: `Session::add_document` with one layer. |
| `ai.removeBackground` | `{"layer":id?,"method":"local\|provider"="local",…choice} → {layer}` | pixel layer, unlocked | `local`: run `layer.removeBackground` (no network, no consent). `provider`: JS behaviour. A copy of the layer named "… (no background)" carrying a mask from the model's alpha (an opaque answer is keyed off its white border), intersected with an existing enabled mask. The original is hidden. One step. |
| `ai.replaceBackground` | `{"prompt":str,"layer":id?,…choice}` | pixel layer | Subject mask from `subject::select_subject_with` (local), inverted, then the fill path. |
| `ai.replaceSky` | `{"prompt":str,…choice}` | document | Mask: the selection, else `segment::sky::select_sky` (local), else an error asking for a selection. Then the fill path. Remember `lastSkyPrompt` in the UI. |
| `ai.describe` | `{"prompt":str?,…choice} → {text}` | document | `thumbnail(doc, 1024)` → `describe`. `journal: false`. Lock not needed (`lock_document: false`). |
| `ai.status` | `{} → {providers:[{id,label,connected,hint,store,imageModel,chatModel}],defaultProvider,consented}` | always | `journal: false`. Never returns a key. |
| `ai.testConnection` | `{"provider":…} → {models:[…]}` | backend installed | `journal: false`, `lock_document: false`. The only call that "tests" a key. |

Rules every command follows:

- **Refuse before sending:** no backend installed, `needsConsent`, `missingKey`, an empty prompt
  where one is required, an unsuitable selection or layer. The error kinds match Nib's.
- **Never write outside the mask.** The answer is resampled to the region and blended with the
  original by the mask (JS `compositeThroughMask`). For Fill, the layer holds only the masked
  pixels, so the document's own pixels are untouched by construction.
- **Cancel:** `ctx.cancelled()` is passed to the backend as `&|| ctx.cancelled()`. The result is
  dropped, and the UI says "a request already sent may still be billed".
- **Locked document:** `lock_document: true` keeps the apply step exact (no stale-document checks)
  and blocks only edits to *that* document. With the status-bar exemption (§5.3) nothing modal
  appears. The alternative, an unlocked job applied to a document found by `DocId` with Nib-style
  re-checks, is a later refinement if people miss editing during a request.
- **Labels and layer names are English engine strings**, like every engine label. The UI translates
  the menu labels through `tr_id`.

### 6.4 `pigment-genai`: keys, settings, consent, providers

- **Keys:** Nib's `SecretStore`.
  - macOS Keychain and Windows Credential Manager through keyring 3.6 (`apple-native` and
    `windows-native`).
  - Linux and the BSDs: `<config_dir>/ai-keys.json`, 0600, written atomically. In portable mode it
    lives in the portable data folder, and is never copied there by the first portable start.
  - Service `<app id>.ai`, accounts `openai`, `gemini`, and later `openai-chatgpt` (a JSON blob of
    tokens).
  - `ApiKey` is the only type holding a key.
- **Settings:** `<config_dir>/ai.json`. Port `AiSettings` and add the JS fields:

  ```json
  {"defaultProvider":"openai","imageProvider":null,"chatProvider":null,
   "openai":{"textModel":"…","imageModel":"…"},"gemini":{…},
   "timeoutSecs":300,"consented":false,"lastSkyPrompt":null,"allowAgents":false}
  ```

  It holds no keys and no base URL.
- **Consent:** one agreement in AI Accounts, worded like Nib's: "I agree that the AI commands send
  my prompt and, where a feature needs it, the image or selection, to the provider I chose."
  Each window also shows a line saying what *this* feature sends. **`allowAgents`** (default off)
  is a second, explicit switch: whether MCP, control and CLI callers may run `ai.*` commands, which
  are billed to the person's account. The automation gate (`Services::automation_command`) refuses
  `ai.*` unless it is set. CLI `run` refuses `ai.*` unless `--allow-ai` is given.
- **Providers:** port Nib's two providers, then add the following.
  - **Chat with tools:**
    - OpenAI: `POST /responses` with `tools: [{type:"function", name, description, parameters}]`.
      Round-trip the model's output items, then one `function_call_output` per call.
    - Gemini: `tools: [{functionDeclarations}]`. Send the model turn back verbatim, thought
      signatures included, then `functionResponse` parts. JS `providers.js` lines 391–524 hold
      both loops and `cleanSchema` and `geminiSchema`.
    - The backend runs one round per `chat` call. The **loop** lives in the UI, because tools must
      run on the UI thread.
  - **Describe:** `TextRequest {images: [png]}`, already supported on both providers.
  - **Model catalogs:** `list_models`, parsed as in JS `normalizeCatalog`. Default picking uses
    the JS `PREFERRED_MODELS` lists through `pick_model`.
  - **Gemini `imageSize`:** 1K, 2K or 4K by long edge for gemini-3 models.
- **Errors:** Nib's `translate_error` plus the JS `SUBSCRIPTION_HINTS` for plan-route codes. Redact
  the key.
- **CLI:** `photocraft-cli ai status`, `ai set-key <openai|gemini>` (reads standard input with echo
  off and refuses a key in argv), `ai clear-key`, `ai test`. `run` and MCP headless sessions
  install `GenAiBackend::new(AiAccounts::new(config_dir))` when the `ai` feature is on.

### 6.5 Interface

- **Menus.** Nib's "where people look" rule, with Photoshop's places:

  | Item | Command | Placement |
  |---|---|---|
  | Edit › Generative Fill… | `ai.generativeFill` | `PLACE_AFTER` `edit.contentAwareFill` |
  | Edit › Generative Expand… | `ai.generativeExpand` | after Generative Fill |
  | File › Generate Image… | `ai.generateImage` | after `file.newFromClipboard` |
  | Layer › Remove Background | `ai.removeBackground` | |
  | Edit › Replace Background… / Replace Sky… | `ai.replaceBackground`, `ai.replaceSky` | |
  | Image › Describe Image… | `ai.describe` | |
  | Edit › AI Accounts… | `ai.accounts` (shell) | above Preferences |
  | Window › AI Assistant | `window.panel.aiAssistant` (shell) | |

  If the owner prefers JS's single **AI** menu, add `"AI"` before `"Window"` in `TOP_MENUS` and give
  the commands `menu: &["AI"]`. That is a one-line hook.
- **Windows.**
  - One non-modal **Generate** window (`ai_ui/generate.rs`) per feature, ported from Nib's
    `generate.rs`. Fields:
    - the prompt, multi-line;
    - the feature's options: variations 1–3, width, height, anchor, target, transparent;
    - provider (shown when two have keys) and model (filled from `ai.testConnection` or cached
      catalogs, defaulting to the remembered choice);
    - **Generate**, which becomes **Stop** while it runs (it calls `jobs.cancel`);
    - the error line with **Open AI Accounts…** or **Try Again**;
    - the "what is sent" line.
  - Generate calls `jobs_ui::run(app, "ai.generativeFill", params)`. The result lands as layers
    when the job applies, as in JS. A variation picker can come later.
- **AI Accounts** (`ai_ui/accounts.rs`). Port Nib's dialog: provider tabs, key state with the store
  name, a masked key field in `AiUi`'s own form, Save Key, Test Connection (`ai.testConnection` as
  a job), Remove Key, Get a key… (`Services::open_url`), "Use this provider", text and image
  model with Use Suggested and Default, timeout, consent, and **Allow agents to run AI
  commands**. In P5, add an OpenAI **Sign in with ChatGPT** row: Copy link, paste the callback
  address, Sign out, the account e-mail, and "chat only".
- **Task bars.**
  - A Generative Fill bar under an active selection (`ai_ui/task_bar.rs`, using
    `widgets::task_bar::show`), with a prompt field and Generate. It shows only once a provider
    has a key, so the bar stays as it was for people who don't use AI.
  - Fill item 2 of `crop_task_bar.rs` with **Generative Expand**: the crop frame's size becomes
    `width` and `height`.
  - Add a `Generative Fill…` row to `SELECTION_MENU`.
- **Status and progress:** the status bar's job readout with Cancel (§5.3). Nothing modal.
- **Strings:** English through `tl!` and `fmt`. Rows go to craft-i18n later.

### 6.6 The Assistant (P4)

- **Window.** `window.panel.aiAssistant`, a floating `egui::Window` like Notes. A conversation is
  kept per `DocId` (40 messages) in `AiUi`, never in `UiState`. The top row holds the provider and
  chat model. Enter sends; Shift+Enter starts a new line. There are **Attach image** (sends
  `thumbnail(doc, 1024)` as PNG), **Stop** and Clear.
- **The loop** (UI thread). Each round starts a non-command job:
  `session.start_job("ai.chat", json!({}), "Assistant", false, work = backend.chat(req), apply = return the turn)`.
  On the turn's arrival, each tool call runs through `menus::invoke` and its result is shown as a
  step. The tool outputs are appended and the next round starts. There are at most 12 rounds;
  **Stop** ends the turn after the current step.
- **Tools** (`ai_ui/assistant_tools.rs`):
  - JS's 14, re-targeted to engine commands (§5.9);
  - **`list_commands {filter}`**, which replaces the JS command list in the instructions (the
    PhotoCraft registry is too large to inline);
  - **`run_command {id, params}`** behind an allowlist.
  - **Blocked**, as in JS `BLOCKED_COMMANDS`: `file.*` except `file.fileInfo`, `edit.preferences*`,
    `help.*`, `window.*`, tools, `ai.*` other than `ai.generativeFill`, `actions.play`,
    `jobs.cancel`.
  - Run every call through the same `automation_command` policy shape, with an Assistant-specific
    function. Validate arguments: layer ids exist, numbers are clamped (JS `ADJUST_RANGES` and
    `FILTER_RANGES`), and objects that arrive as JSON text are parsed (`parseMaybeJson`).
- **Engine changes:** none. The tools use existing commands.

### 6.7 Sign in with ChatGPT (P5)

Port `pigment/src/main/ai.js` to `crates/genai/src/chatgpt.rs`. The pieces are pure functions with
the JS unit tests as vectors:

- the constants `CHATGPT_AUTH` (authorize and token URLs, issuer `https://auth.openai.com`, scope,
  `dynamic_agent_client`, `agent_name_hint` "Pigment", ports 1455–1460, callback
  `/auth/callback`, 5-minute timeout, refresh lead 5 minutes);
- PKCE S256 (`sha2` and base64url; sha2 0.10 is already in the tree through automation);
  `buildAuthorizeUrl` with `ext_agent_host_id` (a stable `urn:uuid:`);
- a loopback listener (`std::net::TcpListener` on 127.0.0.1, the first free port) serving the
  `callbackPage`;
- `parseCallback` (a URL, a path or a bare query, for the manual paste);
- token exchange (form POST);
- `validateIdToken` (issuer, audience, expiry, nonce; no signature check, as in JS) and
  `accountInfo` (e-mail, plan scope);
- refresh with rotation, `FATAL_TOKEN_ERRORS`, and the "replaced while refreshing" generation
  guard;
- `reshapeForPlanRoute` (`store: false`, `stream: true`, system to `instructions`, dropped params
  and hosted tools);
- `aggregateSse`.

Behaviour to keep:

- **ChatGPT never serves image models** (`providerFits`: images need an API key).
- A 401 on the plan route refreshes once, then gives up.
- Tokens live in the `SecretStore` under `openai-chatgpt`.

### 6.8 Hooks into upstream files (for FORK.md)

Every hook is small and marked `// Pigment: generative AI` and, where it touches I/O,
`#[cfg(not(target_arch = "wasm32"))]`:

| File | Hook |
|---|---|
| `Cargo.toml` (workspace) | `pigment-genai = { path = "crates/genai" }`; `keyring` 3.6 target deps live in `crates/genai/Cargo.toml` |
| `crates/engine/src/cmd.rs` | `pub mod ai_cmds;`, `v.extend(crate::ai_cmds::specs());` |
| `crates/engine/src/lib.rs` | `pub mod generative;`, the `Session` field, `set_generative` and `generative` |
| `crates/engine/src/shell_commands.rs` | `ai.accounts`, `window.panel.aiAssistant` rows |
| `crates/ui-egui/Cargo.toml` | `pigment-genai` under the not-wasm target |
| `crates/ui-egui/src/lib.rs` | `mod ai_ui;`, the `ai: ai_ui::AiUi` field |
| `crates/ui-egui/src/app/frame.rs` | `ai_ui::poll` near `jobs_ui::tick`, `ai_ui::show` near `jobs_ui::dialog` |
| `crates/ui-egui/src/menus/invoke.rs` | `crate::ai_ui::menu(app, id, params)` in `invoke_early_commands` |
| `crates/ui-egui/src/menus/items.rs` | `is_live` (`ai_ui::handles`) and `PLACE_AFTER` rows |
| `crates/ui-egui/src/menus/state.rs` | `checked` for the Assistant |
| `crates/ui-egui/src/jobs_ui.rs` | `ai.*` in the status-bar exemption |
| `crates/ui-egui/src/tools/crop_task_bar.rs` | item 2 |
| `crates/ui-egui/src/canvas.rs` | draw the selection task bar next to `crop_task_bar::draw` (line 1784) |
| `crates/ui-egui/src/canvas/canvas_tool_menu.rs` | `SELECTION_MENU` row |
| `crates/ui-egui/src/prefs/prefs_ui/agents.rs` | the AI Accounts button |
| `crates/ui-egui/src/services.rs` | optional `generative` service |
| `crates/ui-egui/src/control/dispatch.rs` | optional `ai.status` passthrough (engine command works already) |
| `apps/photocraft/src/services.rs` (or `main.rs`) | build `AiAccounts::new(config_dir)` and install the backend |
| `apps/photocraft-cli/src/args.rs` | `Ai(AiArgs)` variant and `--allow-ai` |
| `crates/automation/src/headless.rs` | install the backend, gated by `allowAgents` |

---

## 7. Package breakdown

Order: **P1 → (P2 ∥ P3) → P4 → P5**. P6 is optional and comes later. P1 is small and unblocks
everyone with the mock backend.

### P1. Engine seam and AI commands (headless)

- **Files:** `crates/engine/src/generative.rs`, `generative/mock.rs`, `crates/engine/src/cmd/ai_cmds*.rs`.
  Hooks in `cmd.rs` and `lib.rs`.
- **Delivers:**
  - the trait and types of §6.2, and `Session::set_generative`;
  - the nine commands of §6.3 with params strings and enabled reasons;
  - the region and mask helpers ported from JS `features.js` and `providers.js`: `fillRegion`,
    `featherKeepingBorder`, `compositeThroughMask`, `alphaToMask`, `invertMask`,
    `transparentAreaMask`, `keyWhiteBorder`, `coverTo`;
  - the local masks for Replace Sky and Replace Background (`select_sky`,
    `select_subject_with`).
- **Tests, headless** (`ai_cmds/tests.rs`), using `MockBackend`:
  - scripted images, a delay, a scripted error kind, and a record of each request with prompt,
    image size and mask coverage;
  - each command changes the document as specified in one step named after the feature;
    Undo restores it exactly, and Redo replays it;
  - pixels outside the mask stay exact at every depth (8, 16, 32) and in Gray, CMYK and Lab
    documents;
  - variations make n layers in order;
  - Expand grows the canvas and fills the band in one step;
  - Generate Image makes a layer or a new document;
  - Remove Background in local and provider modes;
  - no backend, no consent, no key and no selection each send nothing (the mock records zero
    calls) and leave the document unchanged;
  - cancel during the call drops the result;
  - a bad answer (wrong size, a decode error) changes nothing;
  - `ai.status` never returns a key.
  - Also check the commands appear in `command_list` with correct `needsDocument`, and that the
    wasm build compiles (`cargo check -p photocraft-engine --target wasm32-unknown-unknown`, once
    the build lock is free).
- **Risks:**
  - **Colour.** sRGB in and out versus document profiles (Adobe RGB, CMYK). Start with
    `Surface::convert` like Paste and add `convert_surface` with the document profile. Test it.
  - **Memory.** A 1536² region is fine. Document-sized Generate Image at 8192² is 256 MiB of f32
    RGBA, so go through `crate::allocation::checkpoint` as Paste does.
  - **Locking.** `lock_document: true` blocks edits to that document for the length of the
    request. Accept it for v1.

### P2. `pigment-genai`: providers, keys, settings, backend, CLI

- **Files:** `crates/genai/**`, `apps/photocraft-cli/src/ai.rs` and the args hook,
  `crates/automation/src/headless.rs` hook.
- **Delivers:**
  - Nib's provider, http, keys, accounts, settings, error, cancel and image_util, renamed and
    stripped of vector code;
  - chat with tools for both providers, Describe, catalogs, JS preferred models, Gemini
    `imageSize`;
  - `GenAiBackend` implementing the engine trait: OpenAI and Gemini request shaping, padding to
    aspect, masks, keying, resampling;
  - `ai` CLI subcommands, and `--allow-ai` for `run`.
- **Tests, headless** (`tests/genai/`): port Nib's `common.rs` mock server and its
  `providers.rs` (18) and `keys.rs` (6). Add:
  - edit, generate, describe and chat request bodies for each provider, against recorded answers
    (text, function calls, Gemini thought signatures, safety blocks, link-only images, JPEG
    answers);
  - padding to aspect and the mask conventions (alpha 0 for OpenAI, white-on-black for Gemini);
  - the key only in a header and redacted in errors;
  - timeout and cancel;
  - an end-to-end CLI run: `photocraft-cli run --new … --cmd 'ai.generativeFill={"prompt":"x"}' --out out.png`
    with `PIGMENT_AI_BASE_URL_OPENAI=http://127.0.0.1:<port>` and a key file in a temporary
    `PHOTOCRAFT_CONFIG_DIR`.
- **Risks:**
  - **Keychains.** The macOS and Windows stores can't be exercised on Linux CI. Keep keyring's
    real-store test `#[ignore]`, as both projects do.
  - **The Linux key file is plain** (0600). Say so in AI Accounts, as Nib does.
  - **Provider APIs move.** Model names, gpt-image-2 parameters, the gemini-3 image config. Keep
    the parameter rules in one place per provider, with tests per model family.
  - **Billing.** A cancelled request is still billed. Agents and the CLI need the explicit
    `allowAgents` or `--allow-ai`.

### P3. Interface: menus, Generate window, AI Accounts, task bars

- **Files:** `crates/ui-egui/src/ai_ui*.rs`, `crates/ui-egui/tests/ai.rs`. The hooks of §6.8.
  Wiring in `apps/photocraft` (backend install, config dir).
- **Delivers:** §6.5, plus Describe's result window (Copy, which uses the clipboard service, and
  "Use as document description", which runs `file.fileInfo {"description": …}` as one step).
- **Tests** (kittest, mock backend, no network). Port Nib's 12:
  - each command opens its window and is dimmed with a reason when the selection doesn't suit;
  - without a key, Generate is dimmed and links to AI Accounts, which also opens from Edit and
    from Preferences › AI Integrations;
  - consent is required;
  - nothing is sent before Generate;
  - a result lands as one undo step;
  - Stop cancels a request that never answers;
  - Test Connection lists models;
  - the typed key never appears in the accessibility tree, the preferences, `ai.json`,
    `ui.inspect`, the command list or the status;
  - task bar items appear only with a key;
  - the job shows in the status bar, not in a modal.

  Also add a `menus/tests.rs`-style check that the new ids are live and placed after their anchor
  items.
- **Risks:**
  - **Merge friction.** The hooks are in heavily edited upstream files (`invoke.rs`, `items.rs`,
    `canvas.rs`). Keep each to a line or two, and list them in FORK.md.
  - **Parity tests.** `menus/parity.rs` and its tests may expect catalogue order. Run them.
  - **The rebrand runs in parallel.** Don't touch brand strings or packaging. Take the app id and
    keychain service from the rebrand's brand constant.

### P4. The Assistant

- **Files:** `crates/ui-egui/src/ai_ui/assistant*.rs`, and tests in `crates/ui-egui/tests/ai.rs`
  or `tests/ai_assistant.rs`.
- **Delivers:** §6.6.
- **Tests.** The mock backend scripts `ChatTurn`s with tool calls:
  - each tool maps to the right engine command and is one undo step;
  - blocked ids are refused, and the model sees the refusal;
  - argument clamping and JSON-text objects;
  - 12-round truncation reported;
  - Stop between steps;
  - per-document conversations;
  - the attached image's size;
  - the Assistant never calls `ai.*` other than Generative Fill, and never runs with
    `allowAgents` off from MCP.

  Headless part: the tool dispatcher `assistant_tools::run(app, call)` is a plain function.
  Unit-test it against `PhotocraftApp` in kittest without drawing.
- **Risks:**
  - The engine registry is large, so models pick wrong ids. `list_commands {filter}` with
    `SEARCH_KEYWORDS` helps; keep a short curated list in the instructions.
  - Params strings are not JSON Schema, so `run_command.params` stays a free object, validated by
    `Session::precheck` before running.

### P5. Sign in with ChatGPT

- **Files:** `crates/genai/src/chatgpt.rs`, `tests/genai/chatgpt.rs`, and the AI Accounts row.
- **Delivers:** §6.7.
- **Tests, headless:** port `pigment/tests/unit/ai.test.mjs`'s 13 tests one to one. They cover:
  - PKCE, the authorize URL, callback parsing and ID-token claims;
  - plan-route reshaping, SSE aggregation and error translation;
  - catalogs;
  - the full loopback flow against a mock token server: refresh rotation, fatal errors, busy
    ports, cancel during the exchange, a missing ID token, and a key set during a refresh.

  The interactive part (the browser opening, the callback page) needs a manual check.
- **Risks:**
  - **The flow is not documented.** The dynamic agent client and `chatgpt.tokens.use.direct` are
    the "open-source Sign in with ChatGPT token-sharing flow". OpenAI may change or end it.
    Isolate it so it can be turned off without touching API-key users.
  - **Loopback ports** may be taken; the manual paste flow covers that.
  - **No images on the plan route.**

### P6 (optional, later). Local engines from craft-ai-integrations

- Add `craft-ai-engine-rten` and `craft-ai-features` as git dependencies (native only, without the
  `candle` feature). Offer **Remove Background › Method: Local (BEN2 + ViTMatte)** and better
  Select Subject (SAM 2.1). Model files are downloaded on request, pinned by size and SHA-256 from
  the `craft-ai-features` recipes.
- **Risks:**
  - downloads of hundreds of MB (BEN2 + ViTMatte together ~714 MB);
  - CPU time: 67 s for 1600×1200;
  - no Linux or Windows run of BEN2 yet;
  - licence notices.

  Only worth doing if PhotoCraft's own `layer.removeBackground` (classical, instant) is found
  lacking.

### What each package can verify without a window

| Package | Headless | Needs the UI |
|---|---|---|
| P1 | everything (`cargo test -p photocraft-engine ai_cmds`), CLI `run --cmd ai.*` with the mock, MCP `command_run` through the headless server tests | none |
| P2 | everything against the localhost mock; CLI end to end | none |
| P3 | kittest covers almost all of it | final look, focus and IME in the prompt field, native menus on macOS |
| P4 | the tool dispatcher and the loop with scripted turns | conversation layout |
| P5 | all protocol logic | browser hand-off, callback page |

---

## 8. Cross-cutting risks and open questions

1. **Upstream PhotoCraft adopts craft-ai-integrations.** Then merges will bring upstream's own
   generative commands and task-bar items into the files we hooked (the `crop_task_bar.rs` slot,
   `SELECTION_MENU`).
   - Mitigation: `ai.*` ids, small hooks, and the engine trait as the only coupling.
   - At that merge: either alias our commands to upstream's, or keep ours and hide upstream's
     items.
   - Decide per merge. Record it in FORK.md.
2. **Two AI configurations.** If upstream ships `AiClient`, it will read the ArtCraft store and the
   `craft-ai` keychain service. Pigment should keep its own (`<config>/ai.json`, its own service)
   unless the owner wants to share the launcher's setup.
3. **Remove Background semantics.** PhotoCraft masks the layer in place (a Photoshop Quick
   Action). JS Pigment made a masked copy and hid the original. The design keeps both behind
   `method`. The owner should choose the menu default; local is proposed, since it needs no key.
4. **Variations UX.** Photoshop puts variations in one Generative layer, chosen in Properties. JS
   and this design add one layer per variation. A picker is a possible follow-up, and needs no
   engine change.
5. **Billing and safety wording** must be in every window, as both Nib and craft-ai-egui insist.
6. **Web build.** No AI in this package. Keep every dependency target-gated, and check
   `apps/photocraft-web` builds (wasm check) at the end of P1, P2 and P3.
7. **Build lock.** The rebrand engineer holds the cargo lock now. P1 can be written and unit-tested
   as soon as it is free. Nothing in this design depends on the README, packaging or brand strings
   they are editing.
