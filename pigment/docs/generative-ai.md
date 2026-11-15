# Generative AI in Pigment

Pigment 0.2 to 0.4 (the JavaScript app) had Generative Fill, Generative Expand, Generate Image,
AI Remove Background, Replace Background, Replace Sky, Describe Image, an Assistant that edits the
document, and AI Accounts with OpenAI and Gemini keys. Pigment 0.5 rebuilds them on PhotoCraft. This
page is the contract for that work: the engine seam, the commands and the rules they keep. It grows
with each part (the provider crate, the interface, the Assistant, Sign in with ChatGPT).

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
  billed (everything but `ai.status` and the local Remove Background). The MCP and control gates
  refuse those unless Pigment's `allowAgents` setting is on, and `pigment-cli run` unless
  `--allow-ai` is given (provider crate and interface parts). The in-app Assistant may run only
  `ai.generativeFill` among the `ai.*` commands.
- **Locking.** v1 locks the document for the length of a request (`lock_document`), as PhotoCraft's
  long filters do: other documents stay editable, and the job shows in the status bar with Cancel.

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
- **Follow-up: variations.** Photoshop keeps variations in one generative layer chosen in
  Properties; Pigment makes one layer per variation, as 0.4 did.
