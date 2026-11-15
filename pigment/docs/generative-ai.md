# Generative AI in Pigment

Pigment 0.2 to 0.4 (the JavaScript app) had Generative Fill, Generative Expand, Generate Image,
AI Remove Background, Replace Background, Replace Sky, Describe Image, an Assistant that edits the
document, and AI Accounts with OpenAI and Gemini keys. Pigment 0.5 rebuilds them on PhotoCraft. This
page is the contract for that work: the engine seam, the commands and the rules they keep, the
provider crate and the command line. It grows with each part (the interface, the Assistant, Sign in
with ChatGPT).

## The engine seam: `photocraft_engine::generative`

The engine never talks to the network. `crates/engine/src/generative.rs` defines the
`GenerativeBackend` trait and the request and answer types; the `ai.*` commands call the backend
installed with `Session::set_generative`. The desktop app and `pigment-cli` install the
`pigment-genai` backend (OpenAI, Gemini); tests install `generative::mock::MockBackend` (compiled for
the engine's tests and, with the engine's `testgen` feature, for other crates' tests). Without a
backend the provider commands are disabled with "Generative AI is available in the desktop app", so
the web build compiles the same code and offers none of it.

| Trait method | Asks for | Answer |
|---|---|---|
| `status()` | providers, keys present, default provider, consent | `BackendStatus` (no secrets; a key hint `…abcd` at most) |
| `edit_image(&ImageEdit)` | change an image (inpaint), under an optional mask | an sRGB RGBA8 image of exactly the size sent |
| `generate_image(&ImageGen)` | a new image covering `width` × `height` | that size, cover-fit and cropped, never stretched |
| `describe(&Describe)` | words for an image | text |
| `chat(&ChatRequest)` | one round of a chat with function tools (the Assistant) | `ChatTurn`: text, tool calls, opaque provider state |
| `list_models(provider)` | the provider's models | `(id, "text" \| "image" \| "other")` |

- Images cross as sRGB, straight-alpha `Rgba8Image`s. A mask uses Pigment's convention: **alpha 255 =
  may change**, 0 = keep. The backend converts it to its provider's (OpenAI: alpha 0 = change;
  Gemini: white on black) and does the provider-specific steps: padding to the provider's aspect
  ratio, provider sizes, PNG and base64, keying a white background for transparency, resampling
  back. `photocraft_engine::ai_cmds::region` has the shared helpers (`pad_to_aspect`,
  `key_white_border`, `cover_to`, `resize_rgba8`, `composite_through_mask`, …).
- Every call blocks (the engine calls it on a job's worker thread) and polls `cancelled`. A cancelled
  call answers `GenError` of kind `cancelled`.
- `GenError { kind, message, status }`: `kind` is a stable id the interface picks a button by. The
  engine produces `unavailable`, `needsConsent`, `missingKey`, `badRequest`, `badResponse`,
  `document` and `cancelled`; backends add Nib's (`invalidKey`, `quota`, `safety`, `network`,
  `timeout`, `notFound`, `server`, `keyStore`). In the engine it becomes
  `EngineError::Generative { kind, message }` (a cancel becomes `EngineError::Cancelled`), which a
  failed job keeps as its typed error.

## The commands

All in `crates/engine/src/cmd/ai_cmds/`. None has a menu path or a shortcut yet: the interface
places them (Photoshop's places: Edit › Generative Fill…, Generate Image…, Sky Replacement…, AI
Accounts…; Generative Expand in the Crop tool's task bar; Generate Background after Remove
Background and in the Layer menu; Window › Assistant), and every one is in the command palette.

| Id | Label | Needs | Sends | Result (one undo step named after the label) |
|---|---|---|---|---|
| `ai.generativeFill` | Generative Fill… | a selection | the composite around the selection (the selection bounds padded 25 %, square-ish, at most 1536 px unless the selection is larger), the feathered selection, the prompt | 1 to 3 layers (`variations`) "Generative Fill" or "Generative Fill 1…3" above the active layer (or `layer`), each holding the answer inside the selection; the last is active; the selection stays |
| `ai.generativeExpand` | Generative Expand… | a document | the composite of the grown canvas, its transparent area, the prompt (a default prompt continues the scene) | the canvas grown as Image › Canvas Size grows it with a transparent extension (`width`, `height`, `anchor`), and one layer "Generative Expand" holding the answer in the transparent area. Without a larger size it fills the transparency the canvas already has |
| `ai.generateImage` | Generate Image… | nothing (a layer needs a document) | the prompt | a document-size layer "Generated N", or (`"target":"document"`) a new RGB document of `width` × `height` (16 to 8192) whose only layer is "Generated" and whose description (File Info) is the prompt; `transparent` asks for alpha |
| `ai.removeBackground` | Remove Background | an unlocked pixel layer | `local`: nothing; `provider`: the layer's visible pixels | a layer mask on the layer, in place (the Background becomes a normal layer). `local` (default) is PhotoCraft's `layer.removeBackground`; `provider` masks by the subject the model returns, keyed off white when it answers opaque, within the layer's existing mask |
| `ai.replaceBackground` | Generate Background… | a layer with pixels | the composite, everything around the subject, the prompt | a layer "Generate Background" above the subject's layer holding the new surroundings. The subject is what the layer shows when it is already cut out (a mask, transparency), else Select Subject's |
| `ai.replaceSky` | Sky Replacement… | a document | the composite, the sky, the prompt | a layer "Sky Replacement" holding the new sky. The sky is the selection, else Select › Sky's |
| `ai.describe` | Describe Image… | a document | the composite, at most 1024 px a side, and an optional question | `{text}`; changes nothing (the interface offers Copy and "Use as document description", which runs `file.fileInfo`) |
| `ai.status` | AI Status | — | nothing | `{installed, providers:[{id,label,connected,hint,store,imageCapable,chatCapable,imageModel,chatModel}], defaultProvider, consented}`; never a key |
| `ai.testConnection` | Test AI Connection | a connected provider | the key (lists the models) | `{provider, models:[{id,kind}]}` |

Every provider command takes `"provider":"openai|gemini"` and `"model"`; without them the default
provider (AI Accounts' "Use this provider") is tried first, then OpenAI, then Gemini, the first with
a key for the kind of model wins. A ChatGPT sign-in serves chat models only: images need an API key.
Unknown keys are refused (`{"promt": …}` must not run a billed request on the defaults). Prompts
are trimmed and cut to 4000 characters.

## Rules every command keeps

- **Nothing is sent before the checks pass:** a backend, the person's one-time consent (given in AI
  Accounts), a provider with a key for the kind of model, a prompt where one is needed, a document,
  layer or selection that suits. A refusal sends nothing and changes nothing. `ai.testConnection`
  needs no consent: it sends the key, not prompts or pixels.
- **One step.** The request runs as a job (`photocraft_engine::jobs::run`): on a worker thread when
  started with `Session::start`, inline under `Session::execute`. The result lands as one undo step
  named after the feature; Undo restores the document exactly.
- **The document's own pixels are never changed by a fill.** The answer lands in a new layer holding
  only the masked pixels (alpha = answer alpha × mask), so every pixel outside the mask stays exact,
  in every mode (RGB, Grayscale, CMYK, Lab) and depth.
- **Cancel** drops the answer; the provider may still bill a request that was sent.
- **Sizes.** Images go out as sRGB 8-bit at most 2048 px a side (the backend may scale further);
  answers are checked for size (a wrong size is refused and changes nothing) and scaled back to the
  region.
- **Never recorded into Actions.** `ai.*` steps stay out of recorded actions, so playing an action, a
  batch or a droplet never calls a provider. (`ai_cmds::unrecorded`.)
- **Agents and the command line opt in.** `ai_cmds::may_send(id, params)` says whether a call may be
  billed (everything but `ai.status` and the local Remove Background). Headless agent sessions (MCP,
  `pigment-cli serve`) refuse those unless Pigment's `allowAgents` setting is on, and
  `pigment-cli run` unless `--allow-ai` is given (see "Who may send" below; the running app's MCP
  bridge and control channel are the interface's part). The in-app Assistant may run only
  `ai.generativeFill` among the `ai.*` commands.
- **Locking.** v1 locks the document for the length of a request (`lock_document`), as PhotoCraft's
  long filters do: other documents stay editable, and the job shows in the status bar with Cancel.

## The provider crate: `pigment-genai`

`crates/genai` (package `pigment-genai`) is the backend the desktop app, `pigment-cli` and the
headless MCP sessions install. It is ported from Nib's `nib-genai` (HTTP, keys, settings, consent,
errors, the mock-server tests) and from Pigment 0.4's `providers.js` (the raster request shapes,
chat with function tools, Describe, the model catalogs). Native only: the crate is empty on wasm32,
and nothing of it is in the web build's dependency graph.

| File | What it holds |
|---|---|
| `provider.rs`, `provider/openai.rs`, `provider/gemini.rs` | the `Provider` trait; request bodies and answer parsing as pure functions; error translation (with the ChatGPT plan route's messages); the JSON bound |
| `chat.rs` | Gemini's schema subset (`clean_schema`, `gemini_schema`, `gemini_declaration`), tool arguments, Describe as a chat round |
| `http.rs` | ureq on rustls with the OS trust store: HTTPS only, no redirects, a 64 MiB answer cap, a timeout, Cancel polled between 64 KiB chunks; plain HTTP to loopback only (tests) |
| `keys.rs`, `settings.rs`, `accounts.rs` | where keys and settings live (below); `AiAccounts` (status, connect, models, consent, agents) |
| `image_util.rs` | decoding answers with limits (PNG, JPEG, WebP), PNG and base64, the providers' mask conventions |
| `backend.rs` | `GenAiBackend`, the engine trait, and `Caller` (who may send) |

**Requests.** As Pigment 0.4 made them:

| | OpenAI (`Authorization: Bearer`) | Google Gemini (`x-goog-api-key`, never in the URL) |
|---|---|---|
| Edit (`edit_image`) | `POST /images/edits` multipart: `image[]` (DALL·E 2 `image`), `mask` with alpha 0 where the image may change, the nearest size (gpt-image 1024², 1536×1024, 1024×1536; DALL·E 3 and 2 their own), `input_fidelity: high` and `background` for gpt-image-1 and 1.5, `output_format: png`, `quality: auto`; DALL·E `response_format: b64_json`; dall-e-3 is refused | `generateContent` with the instruction, the image and the mask as white on black; the nearest of ten aspect ratios; `imageSize` 1K/2K/4K for gemini-3 models; `IMAGE` alone for gemini-3, `TEXT`+`IMAGE` before |
| New image | `POST /images/generations`, the same size and fields | `generateContent`, the same image config |
| Chat, Describe | `POST /responses`, `store: false`, function tools (`strict: false`, `tool_choice: auto`); the model's output items go back verbatim next round, then one `function_call_output` per call | `generateContent` with `systemInstruction` and `functionDeclarations`; the model turn goes back verbatim (thought signatures included), then `functionResponse` parts |
| Models | `GET /models` | `GET /models?pageSize=200` |

The backend does the provider-specific pixel steps: an edit is scaled to the provider's longest
side (OpenAI 1536, Gemini 2048), padded, centred, to the provider's frame (transparent for OpenAI,
white for Gemini; the mask's padding is "keep"), and the answer is scaled to the padded size, the
original's rectangle cropped and scaled back to exactly the size the engine sent. **The backend
does not composite through the mask**: the engine does that once. A new image covers the size
asked, cropped, never stretched. Transparency: gpt-image-1 and 1.5 return alpha; every other model
(Gemini, gpt-image-2, DALL·E) is asked for "a plain, pure white (#ffffff) background", and an opaque
answer is keyed (`key_white_border`, threshold 232; for Remove Background the engine keys).

One `chat` call is one round: the tool loop belongs to the caller (the Assistant), because tools run
on the interface thread. `ChatTurn::provider_state` is `{"provider":"openai","items":[…]}` or
`{"provider":"gemini","parts":[…]}`; a turn from the other provider (a switch mid-conversation) goes
back as text instead.

**Models.** A request's own `model`, else the one chosen in AI Accounts, else "automatic": the first
of the provider's preferred models its catalog lists (exact id first, then a prefix, then the first
of the kind; Pigment 0.4's `PREFERRED_MODELS`: OpenAI chat `gpt-5.5`, `gpt-5.1`, `gpt-5`, `gpt-4.1`,
`gpt-4o`, image `gpt-image-1.5`, `gpt-image-1`, `gpt-image-2`; Gemini chat `gemini-2.5-pro`,
`gemini-2.5-flash`, `gemini-2.0-flash`, image `gemini-3.1-flash-image`, `…-preview`,
`gemini-3-pro-image-preview`, `gemini-2.5-flash-image`). The catalog is read once (30 s timeout)
and kept for ten minutes; when it can't be read, `gpt-5.1`, `gpt-image-1`, `gemini-2.5-flash` or
`gemini-2.5-flash-image`.

**Keys.** The macOS Keychain and the Windows Credential Manager (keyring 3.6, service
`<application id>.ai`, account `openai` or `gemini`); on Linux and the BSDs `ai-keys.json` in the
settings folder (or the portable data folder), created 0600, replaced atomically, made 0600 again
if someone loosened it, deleted with the last key. AI Accounts says "a file only you can read".
`ApiKey` is the only type that holds a key: its `Debug` is `[redacted]`, it has no `Display` or
`Serialize`, and any message holding the key in use is redacted. Status shows the last four
characters. **Connect** asks the provider (it lists the models) before storing a key, as 0.4 did;
a refused key is not stored. Keys and the ChatGPT sign-in are not migrated from the Electron app:
they are entered again.

**Settings.** `ai.json` in the settings folder, never a key and never a base URL:

```json
{"defaultProvider":"openai","imageProvider":null,"chatProvider":null,
 "openai":{"chatModel":null,"imageModel":null},"gemini":{"chatModel":null,"imageModel":null},
 "timeoutSecs":300,"consented":false,"allowAgents":false,
 "lastFillPrompt":null,"lastExpandPrompt":null,"lastGeneratePrompt":null,
 "lastBackgroundPrompt":null,"lastSkyPrompt":null}
```

A `null` model is automatic. Choosing the preferred provider resets `imageProvider` and
`chatProvider` with it (0.4). The backend re-reads the file before each request and status, so a
long-running MCP server follows what the person changes in AI Accounts.
`PIGMENT_AI_BASE_URL_OPENAI` and `PIGMENT_AI_BASE_URL_GEMINI` replace a provider's address with a
loopback one (the end-to-end tests' mock server); any other address is ignored.

**Who may send** (`Caller`). The person in the app: after the one-time consent. An agent (MCP and
`pigment-cli serve` sessions; `photocraft_automation::genai` installs the backend on every headless
session and opens the accounts only when an `ai.*` command first needs them): also needs
`allowAgents`. The command line: `pigment-cli run --allow-ai`; without it `run` refuses an `ai.*`
step before any work (and an action it plays can't send either); `batch` and droplets never send. A refusal sends
nothing and is the error kind `notAllowed`.

Errors add `notAllowed` to the kinds above. Timeouts: images and chat the settings' `timeoutSecs`
(300 s by default, 10 to 600), model lists 30 s.

## The command line

`pigment-cli ai` is the command line's AI Accounts (`apps/photocraft-cli/src/ai.rs`):

| Subcommand | Does |
|---|---|
| `ai status [--json]` | the providers, key hints (never a key), models, consent, `allowAgents`, where keys are kept |
| `ai set-key <openai\|gemini> [--no-check]` | reads the key from standard input (without echo at a Unix terminal), checks it with the provider, stores it; a key given on the command line is refused |
| `ai clear-key <provider>` | removes the key |
| `ai test [<provider>] [--json]` | lists the models with the stored key |
| `ai consent [--revoke]` | the one-time agreement, with its wording |
| `ai agents <on\|off>` | `allowAgents` |
| `ai use <provider> [--chat-model ID] [--image-model ID]` | the preferred provider and its models (`""` for automatic) |

`pigment-cli run --new '{"width":64,"height":32}' --cmd select.rect --params '{"x":8,"y":8,"width":16,"height":8}' --cmd ai.generativeFill --params '{"prompt":"a green box"}' --out out.pigment --allow-ai`
runs Generative Fill from the command line.

## Differences from Pigment 0.4, and follow-ups

- **Remove Background masks the layer in place**, as Photoshop and PhotoCraft do, instead of hiding
  the layer behind a masked copy. The default is the local method, which needs no key. It takes a
  pixel layer (rasterize a type or shape layer first); Pigment 0.4 rasterized those itself.
- **Generate Background** (Pigment 0.4's Replace Background) takes the subject locally (the layer's
  mask or transparency, else Select Subject) instead of a first provider request, so it sends one
  request, not two.
- **Sky Replacement** takes Select › Sky's sky instead of 0.4's flood fill from the top edge.
- **Fill layers** hold the answer's colour with alpha = answer × mask; over the untouched document
  that equals 0.4's `compositeThroughMask` for opaque pixels without blending the original into the
  layer twice at the feathered edge.
- **Follow-up: editing during a request.** Pigment 0.4 let people keep editing, saving and undoing
  the same document while a request waited (`gate: false`). v1 locks that document until the answer
  lands or is cancelled. The alternative, an unlocked job applied to the document by id with Nib-style
  re-checks of the layer and selection, is the refinement if people miss it.
- **Follow-up: colour.** The composite goes out as the compositor's 8-bit RGB (the document's RGB
  profile, sRGB for CMYK and Lab) and the answer comes back through `Surface::convert`, as Paste
  does. Converting through the document's profile (`color_cmds::convert_surface`) is a refinement.
- **Transparency on models without alpha.** Pigment 0.4 asked only Gemini's new images for a white
  background. Pigment asks every model without alpha (Gemini, gpt-image-2, DALL·E), for new images
  and for Remove Background's edit, and keys the white out, so "transparent" means the same
  whichever model is chosen.
- **Consent and agents are new.** Pigment 0.4 had no agreement step (connecting an account was the
  consent) and no agents. The agreement is asked once in AI Accounts (or `pigment-cli ai consent`);
  agents and the command line opt in separately.
- **Follow-up: variations.** Photoshop keeps variations in one generative layer chosen in
  Properties; Pigment makes one layer per variation, as 0.4 did.
