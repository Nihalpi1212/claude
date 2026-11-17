# Generative AI in Pigment

Pigment 0.2 to 0.4 (the JavaScript app) had Generative Fill, Generative Expand, Generate Image,
AI Remove Background, Replace Background, Replace Sky, Describe Image, an Assistant that edits the
document, and AI Accounts with OpenAI and Gemini keys. Pigment 0.5 rebuilds them on PhotoCraft. This
page is the contract for that work: the engine seam, the commands and the rules they keep, the
provider crate, the interface, the Assistant and the command line. It grows with each part (Sign in
with ChatGPT is next).

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

All in `crates/engine/src/cmd/ai_cmds/`. None has a menu path or a shortcut of its own: the
interface places them (see "The interface" below; Window › Assistant comes with the Assistant), and
every one is in the command palette.

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
- **Never from an action.** A command that may send is not recorded into an action
  (`ai_cmds::unrecorded`), and one that is in an action all the same (built with `actions.insert`,
  loaded from a file) is refused at that step, whoever plays it: the engine refuses a command that
  sends while an action plays (also a batch's or a droplet's) or while an event's script runs
  (Script Events Manager), with the error kind `notAllowed` and before the backend is asked. So
  playing an action never calls a provider. The local Remove Background sends nothing: it is
  recorded and plays, like PhotoCraft's own `layer.removeBackground`.
- **The backend admits the caller.** Before a command that sends starts its job, the engine asks
  `GenerativeBackend::admit(automated)` on the calling thread, `automated` being whether the
  session runs under an automation gate (`Session::authorize`). This also covers a command reached
  through another one (a step of a script an agent runs), which no gate in front of the engine sees.
- **Agents and the command line opt in.** `ai_cmds::may_send(id, params)` says whether a call may be
  billed (everything but `ai.status` and the local Remove Background). Headless agent sessions (MCP,
  `pigment-cli serve`) refuse those unless Pigment's `allowAgents` setting is on, and
  `pigment-cli run` unless `--allow-ai` is given (see "Who may send" below; the running app's MCP
  bridge and control channel ask the same setting, see "The interface"). The in-app Assistant may run only
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
 "lastBackgroundPrompt":null,"lastSkyPrompt":null,"assistantAttach":true}
```

`assistantAttach` is the Assistant's Attach image. A `null` model is automatic. Choosing the preferred provider resets `imageProvider` and
`chatProvider` with it (0.4). The backend re-reads the file before each request and status, so a
long-running MCP server follows what the person changes in AI Accounts.
`PIGMENT_AI_BASE_URL_OPENAI` and `PIGMENT_AI_BASE_URL_GEMINI` replace a provider's address with a
loopback one (the end-to-end tests' mock server); any other address is ignored.

**Who may send** (`Caller`). The person in the app: after the one-time consent. An agent (MCP and
`pigment-cli serve` sessions; `photocraft_automation::genai` installs the backend on every headless
session and opens the accounts only when an `ai.*` command first needs them): also needs
`allowAgents`. The command line: `pigment-cli run --allow-ai`; without it `run` refuses an `ai.*`
step before any work; an action it plays never sends, with or without the flag; `batch` and droplets never send. A refusal sends
nothing and is the error kind `notAllowed`.

Errors add `notAllowed` to the kinds above. Timeouts: images and chat the settings' `timeoutSecs`
(300 s by default, 10 to 600), model lists 30 s.

## The interface (`crates/ui-egui/src/ai_ui*`)

The desktop app installs the backend at start-up (`ai_ui::install(app, config_dir)`: the person's
accounts in Pigment's settings folder, `Caller::Person`), and AI Accounts edits the same accounts
the backend reads. The browser build has none of it: `ai_ui` keeps its signatures there and does
nothing, and no AI item shows.

**Where the features are** (Photoshop's places; there is no AI menu, and every item is also in the
command palette):

| Item | Command | Place |
|---|---|---|
| Edit › Generative Fill… | `ai.generativeFill` | after Content-Aware Fill; also the selection context menu and the task bar under a selection |
| Edit › Generate Image… | `ai.generateImage` | after Generative Fill |
| Edit › Sky Replacement… | `ai.replaceSky` | after Generate Image |
| Edit › AI Accounts… | `ai.accounts` (the shell's) | after Toolbar…, above Preferences; also Preferences › AI Integrations' AI Accounts… button |
| Layer › Remove Background | `ai.removeBackground` (`local`) | after Mask All Objects; nothing is sent |
| Layer › Remove Background with AI Provider | `ai.removeBackground` (`provider`) | next to it (the shell's `ai.removeBackgroundWithProvider`) |
| Layer › Generate Background… | `ai.replaceBackground` | next to them; also the task bar after Remove Background |
| Image › Describe Image… | `ai.describe` | after Calculations… |
| Generative Expand… | `ai.generativeExpand` | the Crop tool's task bar slot and the palette |
| Window › Assistant | `window.panel.aiAssistant` (the shell's) | after Adjustments, in the Window menu's alphabetical list; checked while its window is open |

Menu items are dimmed for the document (no selection, a layer without pixels, no backend) and never
for a missing key: the window says how to add one.

**The Generate window** (`ai_ui/generate.rs`) is one non-modal window for Fill, Expand, Generate
Image, Generate Background and Sky Replacement. It holds the prompt (the feature's last one from
`ai.json`, or Sky Replacement's "A dramatic sunset sky with warm clouds"), the feature's options
(variations 1 to 3; Expand's new width, height and anchor; Generate Image's layer or new document,
its size and transparency), the provider (shown when two have keys) and a model for this request
(empty: the one AI Accounts sets), and a line saying what this feature sends. **Nothing is sent
before Generate.** Generate is dimmed, with the reason as its tooltip, while a request runs, without
a key or the agreement (with a link to AI Accounts), when the document doesn't suit, or without a
prompt. Generate runs the engine command as a background job: the status bar shows it with Cancel
(never the modal progress window: `ai.*` is exempt), the window shows **Stop** and the elapsed
time, and the result lands as one undo step. A failure shows in the window with Open AI Accounts…
(missing or refused key, no agreement, not allowed) or Try Again (network, timeout, server, quota,
bad answer); Stop says a request already sent may still be billed. Closing the window leaves a
running request alone.

**Describe Image** asks at once (after checking a chat provider and the agreement; AI Accounts opens
when one is missing) and shows the answer with Copy, Use as Document Description (`file.fileInfo
{"description"}`, one undo step) and Close.

**Remove Background with AI Provider** checks the provider and the agreement the same way first.

**The task bars** (`ai_ui/task_bar.rs`, on `widgets::task_bar`) show only once a provider has a
key, so the bar stays as it was for people who don't use AI: under a selection, a prompt field and
Generate (Generative Fill at once; the window opens when something stops it); after Remove
Background, while the document is as it left it, Generate Background…; in the Crop tool's bar,
Generative Expand, which takes the crop frame's size and the sides it reaches past as the new
canvas and anchor, and lets the frame go.

**AI Accounts** (`ai_ui/accounts.rs`) is a modal: what is sent and who bills (a request stopped
after it was sent is still billed), OpenAI and Google Gemini tabs, the key state ("ends in …WXYZ",
and where it is kept), the masked key field with **Connect** (checks the key with one model list on a
worker thread and stores it only when the provider accepts it), Test Connection, Remove Key, Get a
key…, Preferred provider, Chat and Image model (empty: automatic, with Use Suggested from the last
list), the request timeout, **the one-time agreement**, and **Allow agents to run AI commands**. The
typed key lives only in the dialog's own form: never in `UiState`, a dialog's fields, the
preferences or `ui.inspect`; it is wiped when sent to be checked and when the dialog closes, and its
egui text state is dropped whenever the field is empty.

**Agents in the running app.** A control request (MCP through the open window, `--control`) and
synthetic input run a command that may send only while "Allow agents to run AI commands" is on;
the person's own clicks and keys always may. Two checks hold this: `ai_ui::gate` (from
`PhotocraftApp::run`) refuses the agent's own request before it starts, and the backend the app
installs (`ai_ui`'s `AppBackend`, around the provider backend) refuses in `admit` a command that
sends when it starts for an agent or under the session's automation gate, which catches what the
first never sees (a step of a script the agent runs). In AI Accounts, synthetic input can switch
tabs and close the dialog, nothing else: keys, the agreement and the agents' permission are the
person's.

## The Assistant (`crates/ui-egui/src/ai_ui/assistant.rs`, `assistant_tools.rs`)

Window › Assistant is a chat about the active document whose model can also edit it. It is the
JavaScript app's Assistant panel, as a floating window.

**The window.** The provider (the connected ones; the choice is saved as `chatProvider`, which AI
Accounts' Preferred provider resets) and the chat model (Automatic, or one of the provider's chat
models; saved as that provider's `chatModel`, the same choice AI Accounts shows). The model list is
the one AI Accounts read in the last ten minutes, or **List models** asks for it (one request with
the key, as Test Connection); it is never fetched unasked. **Attach image** (on by default, saved
as `assistantAttach`), AI Accounts…, Clear. Then the conversation, the message field (Enter sends,
Shift+Enter is a new line), a status line, and Send, which is Stop while a turn runs. A line at the
bottom says what a message sends and that a stopped request may still be billed.

**A conversation per document**, in memory only: never in the document, `UiState`, the
preferences or `ai.json`. At most 40 messages are kept, the oldest dropped first. It goes when the
document closes or with Clear. One turn runs at a time, app-wide.

**A turn.** Send stores the message, with the composite scaled to at most 1024 px on its longer
side when Attach image is on, and sends: the instructions, the fifteen tools, and every stored
message that isn't a failure, as text; only the latest message carries its image. Each request is
a background job (`ai.chat`, a job and not a command): the status bar shows it with Cancel,
nothing is modal, and the document is not locked. The model's tool calls then run on the interface
thread, one a frame, each shown as a step in the conversation; their results go back with the
model's own turn (as the provider gave it: OpenAI's output items, Gemini's parts with their thought
signatures), and the model answers again. After twelve rounds of tools a model that still wants
more ends the turn with "Stopped after 12 tool steps; say “continue” to go on." A model that only
called tools gets "Done."; one that said nothing, "(no answer)". A failed request shows its reason
in the conversation, with Open AI Accounts… when that fixes it, and is not sent again with later
messages.

**Stop** ends the turn. A request in flight is dropped at once (its answer never runs a tool; the
provider may still bill it) and tools not yet run never run. A step that is running as a background
job, or waiting on a dialog, is let finish first ("Stopping after the current step…"). The status
bar's Cancel on the request is the same Stop.

**The tools** are the JavaScript app's fourteen, aimed at the engine's commands, and
`list_commands`:

| Tool | Runs | Notes |
|---|---|---|
| `get_document` | reads the document | name, size, dpi, mode, depth, the layers top to bottom (id, name, type, visible, opacity 0-100, blend, active, parent, mask, locked, background, text), the selection's bounds, the description: the short form, not `document.inspect` |
| `set_active_layer {id}` | `layer.select` | the id as a number, as text, or the one layer of that name |
| `apply_adjustment {kind, params}` | `image.adjustments.<kind>` | the kind however it is spelt (`brightnessContrast`, `brightness-contrast`, "Brightness/Contrast") |
| `apply_filter {kind, params}` | `filter.<kind>` | `blur.gaussianBlur`, or `gaussianBlur` where no other filter ends the same |
| `list_commands {filter}` | reads the registry | the commands the Assistant may run whose id, name or keywords hold every word of the filter, 30 at most, each with its params and why it can't run now; without words, how many commands each family has |
| `run_command {id, params}` | the command, as the command palette runs it | see below |
| `new_layer {name}` | `layer.new.layer` | |
| `set_layer_props {id, opacity, blend, visible, name}` | `layer.setProps` | opacity 0-100; `null` leaves a property as it is |
| `select {kind, rect}` | `select.all`, `select.deselect`, `select.inverse`, `select.rect` | the inverse of nothing selects everything |
| `crop {rect}` | `image.crop` | |
| `resize_image {width, height}` | `image.imageSize` (bicubic, styles scaled) | 1 to 30000 px |
| `canvas_size {width, height, anchor}` | `image.canvasSize` | `nw` … `se`; a Background is extended with the background colour, like the dialog, else the new area is transparent |
| `fill_selection {color}` | `edit.fill`, or `edit.clear` for a transparent colour | hex, `rgb()`, `rgba()` or a CSS colour name; the colour's alpha is the fill's opacity |
| `add_text {text, x, y, size, color}` | `type.create` | pixels (the size becomes points at the document's resolution); defaults from the canvas as in the JavaScript app |
| `generative_fill {prompt}` | `ai.generativeFill` | needs a selection; the preferred image provider, one variation, no window |

Every tool goes through `PhotocraftApp::run` (`run_command` through the menus' `invoke`), so each
is an ordinary command: **one undo step**, recorded into an action that is being recorded, held to
the same gates as the person's own. A tool's failure is returned to the model as `{"error": …}` and
shown on its step; it is not put in the status bar.

**What a model is not trusted with** (`assistant_tools.rs`):

- *Ids.* A layer id must exist ("No layer with id … (call get_document for the ids)"). An unknown
  command, adjustment or filter is an error the model reads.
- *Ranges.* Numbers in `apply_adjustment`, `apply_filter` and `run_command` params are clamped to
  the range the command's own params spec documents for that key (the ranges its dialog is built
  from, in place of the JavaScript app's two fixed tables); numeric text is converted where the
  key takes a number; NaN, `null` and anything that isn't a number, a boolean, text, a list or an
  object is dropped; text is cut (200 characters, 4000 for `run_command`); nesting stops at four
  levels. `run_command`'s params then pass the engine's `Session::precheck`.
- *Rectangles* are cut to the canvas; an empty intersection or a size that isn't positive is an
  error, not a 1 px rectangle.
- *JSON text.* An object that arrives as JSON text (Gemini's schemas carry open objects as
  strings) is parsed; text that looks like JSON and can't be read is an error.
- *The active document.* A tool refuses once its document is no longer the active one ("The
  document is no longer active"). A step never runs behind a dialog the person has open.
- *Results* go back cut to 12000 characters.

**What the Assistant may not run** (`assistant_tools::blocked`, the shape of the automation gate;
the JavaScript app's `BLOCKED_COMMANDS` for this registry). `run_command` refuses, with "Command
"<id>" cannot be run by the assistant", and `list_commands` never offers:

- `file.*` (open, save, export, place, print, close, quit, scripts, batch) except `file.fileInfo`
  and the three `file.scripts.*` that only tidy the open document;
- `ai.*` except `ai.generativeFill`: **the Assistant reaches a provider only through its own chat
  and Generative Fill**;
- `window.*`, `help.*`, `ui.*`, `tool.*` and `tools.*` (except the three colour commands),
  `edit.preferences*`, `prefs.*` (except `prefs.get`), Keyboard Shortcuts, Menus, Toolbar, Color
  Settings, the command palette, `updates.*`, `plugin.*`;
- `actions.*` (except `actions.list` and `actions.get`): an action could hold what the Assistant
  may not run; `jobs.*` except `jobs.list`; `document.*` and `session.*` except their read-only
  queries (`document.activate` would take the turn's document away);
- what can't be undone (`edit.purge.*`, `history.clear`), and what imports or exports (a command
  whose last part starts with `import`, `export` or `quickExport`, the contour and smart-object
  file commands, `edit.presets.*`);
- any command with a param that names a file, a folder or a script (`path`, `paths`, `file`,
  `folder`, `directory`, `output`, `destination`, `mapPath`, `script`, `steps`), or a colour
  `profile` given as a path: the Assistant works on the open document only.

**A command that opens a dialog.** `run_command` without params runs the command as its menu item
does, so one with a dialog opens it. The turn then waits for the person to finish the dialog (the
step says so), and the model is told "The command opened a dialog; the user has closed it
(completed or cancelled). Call get_document to see the current state." The specific tools never
open a dialog: they always give params.

**The instructions** are the JavaScript app's, with the lists read from this registry: the
adjustment and filter kinds with their params as the registry documents them (name, range and
default; a spec longer than 160 characters is left as `{…}` for `list_commands`), the blend modes,
and, in place of the whole command list (about a thousand commands here), how many there are, a
short list of common ones and `list_commands`.

**Who may send.** A message is a request that is billed, so it is held like a command that sends:
nothing goes before the one-time agreement or without a connected chat provider (AI Accounts opens
and what was typed stays in the field); an agent (a control request, synthetic input) sends a
message only while "Allow agents to run AI commands" is on, and the app's backend is asked
(`admit`) before the first request. The tools of a turn then run as the person's commands.

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
- **Actions never send.** Pigment 0.4 recorded the AI dialogs' values, and playing the action
  called the provider (and billed) again. Here a command that sends is neither recorded nor run
  from an action, a batch, a droplet or a script event. Layer › Remove Background (the local
  method) is recorded and plays, as it sends nothing.
- **Consent and agents are new.** Pigment 0.4 had no agreement step (connecting an account was the
  consent) and no agents. The agreement is asked once in AI Accounts (or `pigment-cli ai consent`);
  agents and the command line opt in separately.
- **Generative Expand from the Crop tool.** The task bar's Generative Expand grows the canvas to
  take in the crop frame on the sides it reaches past (one anchor of nine; a frame reaching past
  both sides of an axis centres it). The Crop options bar's Fill: list keeps its two entries
  (its choice is a saved yes/no); Generative Expand is the task bar's.
- **Model per request.** The Generate window's Model field is for that request; the saved choice is
  AI Accounts' (Pigment 0.4 saved the window's choice). The provider chosen is saved as 0.4 did
  (`imageProvider`).
- **Keys are checked before they are stored** (Connect), as in 0.4. `pigment-cli ai set-key
  --no-check` stores one without asking the provider.
- **Follow-up: variations.** Photoshop keeps variations in one generative layer chosen in
  Properties; Pigment makes one layer per variation, as 0.4 did.
- **The Assistant is a window, not a docked panel**, opened from Window › Assistant (0.4: Window ›
  AI Assistant and the AI menu). Its conversations, limits (40 messages, 12 tool rounds, a
  1024 px image), tools, Stop and wording are 0.4's.
- **The Assistant finds commands with `list_commands`.** 0.4 listed every command id in its
  instructions; this registry has about a thousand, each with a params spec, so the instructions
  name a few and the model looks the rest up. `run_command` takes `params` (an object); 0.4's
  `arg` is still read.
- **The Assistant's ranges come from the commands.** 0.4 clamped by two fixed tables of parameter
  names; here each command's own params spec gives the range, so every adjustment and filter is
  covered, and the kinds and their params are PhotoCraft's (`brightnessContrast`,
  `blur.gaussianBlur`).
- **The Assistant's model list is asked for.** 0.4 fetched a provider's models when the panel
  showed them. Here nothing is sent unasked: the list is AI Accounts' recent one, or List models.
  Automatic needs no list.
- **A document locked by a running step.** Generative Fill as an Assistant step locks the document
  until it lands, as it does from its window (see "editing during a request").
- **Follow-up: the Assistant's attached image** is composed on the interface thread when Send is
  pressed. A very large document that can't use a proxy takes a moment there; composing it on the
  request's worker is the refinement.
- **Layer ids are numbers** in PhotoCraft; 0.4's were strings. The tools take either.
