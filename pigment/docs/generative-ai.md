# Generative AI in Pigment

Pigment 0.2 to 0.4 (the JavaScript app) had Generative Fill, Generative Expand, Generate Image,
AI Remove Background, Replace Background, Replace Sky, Describe Image, an Assistant that edits the
document, and AI Accounts with OpenAI and Gemini keys. Pigment 0.5 rebuilds them on PhotoCraft. This
page is the contract for that work: the engine seam, the commands and the rules they keep, the
provider crate, Sign in with ChatGPT (experimental), the interface, the Assistant, the command
line, and, feature by feature, what Pigment 0.4 had and where it is now.

No live key or account existed while this was built: every test runs against the engine's mock
backend or a mock provider on 127.0.0.1, and nothing was tried against OpenAI or Google.

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
| `ai.describe` | Describe Image… | a document | the composite, at most 1024 px a side, and an optional question | `{text}`, at most 20,000 characters (cut with an ellipsis; control characters other than line breaks and tabs dropped); changes nothing (the interface offers Copy and "Use as document description", which runs `file.fileInfo`) |
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
| `keys.rs`, `settings.rs`, `accounts.rs` | where keys and settings live (below); `AiAccounts` (status, connect, models, consent, agents, how OpenAI is connected: a key or a ChatGPT sign-in) |
| `chatgpt.rs` | Sign in with ChatGPT (experimental; its own section below): the sign-in, the tokens and their refresh, the plan route's request shape |
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
they are entered again. A provider's answer has the key taken out before anything reads it
(`provider::scrub`), so a message that quotes part of an answer, cut to a few hundred characters,
can't hold half a key the redaction would no longer find.

**Settings.** `ai.json` in the settings folder, never a key and never a base URL:

```json
{"defaultProvider":"openai","imageProvider":null,"chatProvider":null,
 "openai":{"chatModel":null,"imageModel":null},"gemini":{"chatModel":null,"imageModel":null},
 "timeoutSecs":300,"consented":false,"allowAgents":false,
 "lastFillPrompt":null,"lastExpandPrompt":null,"lastGeneratePrompt":null,
 "lastBackgroundPrompt":null,"lastSkyPrompt":null,"assistantAttach":true,
 "chatgptSignIn":true,"hostId":null}
```

`assistantAttach` is the Assistant's Attach image. `chatgptSignIn` and `hostId` belong to Sign in
with ChatGPT (below). A `null` model is automatic. Choosing the preferred provider resets `imageProvider` and
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

## Sign in with ChatGPT (experimental): `crates/genai/src/chatgpt.rs`

Pigment 0.2 to 0.4 let people use their ChatGPT Plus or Pro plan instead of an OpenAI API key, for
**chat models only** (the Assistant, Describe Image). Pigment 0.5 keeps it, ported from 0.4's
`src/main/ai.js` with its unit tests as the vectors.

**Why experimental.** The flow is OpenAI's open "Sign in with ChatGPT" token-sharing flow for
third-party apps: a public PKCE client with no secret, registered as a dynamic agent client on the
first sign-in. It is not a documented, stable API, and it **was never checked against the live
service**: 0.4's tests drove a fake token endpoint and so do these. OpenAI may change or end it.
So AI Accounts marks it Experimental, and it is isolated:

- **One switch turns it off.** `pigment_genai::chatgpt::ENABLED` (a constant: flip it and build),
  or `"chatgptSignIn": false` in `ai.json`. Off, AI Accounts and `pigment-cli ai status` show no
  sign-in, starting one is refused, a stored one is ignored (not deleted: on again, it is back),
  and nothing changes for API keys. The test suite passes either way.
- **Nothing an API key uses goes through it.** The OpenAI provider holds a key or a sign-in
  (`provider/openai.rs` `Auth`); the key's path is the code it was.

**The sign-in** (`ChatGpt::start`, `complete`, `complete_manual`, `cancel`):

1. PKCE S256 (a 48-byte verifier), a random `state` and `nonce`, and the installation id
   (`hostId` in `ai.json`: a random `urn:uuid:`, made at the first sign-in and kept, as 0.4's
   `aiHostId`).
2. A listener on 127.0.0.1, the first free port of 1455 to 1460. With all six taken the attempt
   goes on without one, and AI Accounts says to paste the address the browser lands on.
3. The authorize address (`https://auth.openai.com/api/accounts/authorize`: `response_type=code`,
   `client_id=dynamic_agent_client`, `redirect_uri=http://127.0.0.1:<port>/auth/callback`,
   `scope=openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`,
   `resource=https://api.openai.com/v1`, `state`, `nonce`, `code_challenge`, `S256`,
   `agent_name_hint=Pigment`, `ext_agent_host_id`) is handed to the caller, which opens it in the
   system browser. Pigment itself sends nothing yet.
4. The callback (the listener's, or the pasted address: a URL, a path with a query, or a bare
   query). **Its `state` is checked before anything else**: a callback without this attempt's
   state is a stray request whatever it carries, it is refused, and the attempt goes on. An
   `error` with the right state ends the attempt with the provider's description. Any other path
   on the listener is 404.
5. The code exchange (`POST https://auth.openai.com/api/accounts/oauth/token`, form-encoded,
   30 s: `grant_type=authorization_code`, `code`, `code_verifier`, `redirect_uri`, the client id
   the callback issued (else the dynamic one), `resource`). The answer must hold an access token
   and, this first time, an ID token whose issuer is `https://auth.openai.com`, whose audience
   holds the client id, which has not expired and carries the attempt's nonce. (Its signature is
   not checked: it came over TLS from the token endpoint and is never used as a credential.)
6. The tokens are stored and the browser gets a small page ("Signed in", "You can return to
   Pigment."; a failure page says why, HTML-escaped).

One attempt at a time; it ends after five minutes, on Cancel, when an OpenAI key is stored or
removed, or on Sign Out. A Cancel while the code is being exchanged stores nothing, and an ended
attempt never ends the next one.

**The tokens** are kept in the key store under the account `openai-chatgpt`, as one JSON text
(`clientId`, `accessToken`, `refreshToken`, `idToken`, `expiresAt`, `earliestRefreshAt`, `email`,
`plan`, `signedInAt`): the macOS Keychain, the Windows Credential Manager (in pieces of 600
characters, `openai-chatgpt`, `openai-chatgpt.1`, …, because one credential there holds 2560
bytes), or the 0600 `ai-keys.json` on Linux and the BSDs (not encrypted, as AI Accounts says; 0.4
sealed them with Electron's safeStorage where the system had a keychain). Never in `ai.json`, a
document, a log, a message, `ai.status`, `ui.inspect` or the control protocol. The interface holds
the address to open and, afterwards, the account's e-mail address; `ai.status` reports neither.
**An OpenAI API key and a sign-in exclude each other**, as in 0.4: storing a key drops the
sign-in, signing in drops the key. Sign Out removes the tokens here; nothing is revoked at OpenAI
(as in 0.4).

**Using it** (`ChatGpt::access_token`). The stored access token is used until five minutes before
it expires, and past that while `earliest_refresh_at` is not reached and it has not expired. Then
it is refreshed (`grant_type=refresh_token`, the stored client id, `resource`), **one refresh at a
time** (refresh tokens rotate, and one used twice ends the sign-in), with what the answer leaves
out kept (a refreshed ID token that does not validate is dropped, the old one stays). A refresh
the server refuses for good (`invalid_grant`, `invalid_client`, `invalid_refresh_token`,
`refresh_token_expired`, `refresh_token_invalidated`, `refresh_token_reused`, `token_expired`), or
a sign-in without a refresh token, clears the sign-in: "Your ChatGPT sign-in has expired. Sign in
again in Edit › AI Accounts…". A refresh that lands after the sign-in was replaced or removed
(Sign Out, a new key, another sign-in, also by another Pigment process) is dropped and changes
nothing.

**The plan route.** With a sign-in, OpenAI's requests go to the same API root with
`Authorization: Bearer <access token>`:

- `POST /responses` (the Assistant, Describe) is reshaped (`reshape_for_plan_route`): `store:
  false`, `stream: true`, the parameters the route refuses dropped (`temperature`, `top_p`,
  `max_output_tokens`, `metadata`, `user` and the rest of 0.4's list), `system` and `developer`
  input messages moved into `instructions`, hosted tools other than `web_search` dropped, an
  object `tool_choice` dropped. The answer is an event stream, folded into the response of its
  `response.completed` or `response.incomplete` event (`aggregate_sse`); a `response.failed` or
  `error` event is the failure; without a final event the text deltas are the answer.
- `GET /models` answers `{models: [{slug}]}`, which the catalog reads like a key's `{data: [{id}]}`.
- A 401 refreshes the token once and tries again, then gives up ("OpenAI rejected the ChatGPT
  sign-in. Sign out and sign in again in Edit › AI Accounts…", kind `invalidKey`).
- The route's own error codes get their explanation (`subscription_sharing_user_not_eligible`:
  "Your ChatGPT plan does not include use in third-party apps…", `…_usage_limit_exceeded`,
  `…_usage_unavailable`, `…_route_not_supported`, `…_unsupported_capability`, `…_invalid_user`).
- **Never an image model.** The status says `imageCapable: false` for a sign-in, so an image
  request goes to a provider with a key (Gemini, when it has one) or is refused before anything
  is sent ("OpenAI is not connected for image models. Add an API key in Edit › AI Accounts…"); the
  provider refuses an image request too.

The code, the verifier and the tokens are taken out of the answers they were sent with before
anything reads them, and out of every message; after a 401 that is both access tokens, the one
the provider refused and the one that replaced it. The one-time agreement, "Allow agents to run AI
commands" and `--allow-ai` apply to a sign-in's requests as to a key's.

`PIGMENT_AI_AUTH_URL_CHATGPT` replaces `https://auth.openai.com` with a loopback address (the
tests' mock, a check against a local one); any other address is ignored.

**Not checked here** (it needs a real ChatGPT account and a browser): the hand-off to the system
browser, the page the browser shows, and the live service's answers.

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
(empty: the one AI Accounts sets), and a line saying what this feature sends. Each opening starts at
one variation, and a model typed for one feature is not kept for another: the selection bar's
Generate runs Generative Fill through this window without showing it. **Nothing is sent
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
list; each is saved on its own, and one that is not a model id keeps the dialog open with why), the
request timeout, **the one-time agreement**, and **Allow agents to run AI commands**. The
typed key lives only in the dialog's own form: never in `UiState`, a dialog's fields, the
preferences or `ui.inspect`; it is wiped when sent to be checked and when the dialog closes, and its
egui text state is dropped whenever the field is empty.

OpenAI's tab also has **Sign in with ChatGPT**, marked Experimental (when the feature is on). The
button starts the attempt and opens the browser; while it waits the tab shows "Waiting for your
browser…", Copy Link, Cancel, and a field for the address the browser landed on with Use (a
browser on another computer, or the warning that every port is taken). Signed in, the tab reads
"Signed in with ChatGPT · <e-mail>" (and "plan access not granted" when the sign-in did not grant
the plan), offers Sign Out, says that image models need an API key, and the Image model field
reads "Needs an API key". Connecting a key replaces the sign-in; with a key connected the button
is not shown (Remove Key first), as in 0.4. The sign-in address is never written to the status bar
or the interface state (it names the attempt); a sign-in that completes while the dialog is closed
is said in the status bar and reaches the menus and windows at once.

**Agents in the running app.** A control request (MCP through the open window, `--control`) and
synthetic input run a command that may send only while "Allow agents to run AI commands" is on;
the person's own clicks and keys always may. Two checks hold this: `ai_ui::gate` (from
`PhotocraftApp::run`) refuses the agent's own request before it starts, and the backend the app
installs (`ai_ui`'s `AppBackend`, around the provider backend) refuses in `admit` a command that
sends when it starts for an agent or under the session's automation gate, which catches what the
first never sees (a step of a script the agent runs). In AI Accounts, synthetic input can switch
tabs and close the dialog, nothing else: keys, the ChatGPT sign-in (starting, cancelling, pasting
an address, signing out), the agreement and the agents' permission are the person's.

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
document closes or with Clear. One turn runs at a time, app-wide. Only the latest message keeps
the image it was sent with; earlier ones keep a 96 px preview for the conversation.

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
- *Answers.* The model's text is kept to 20000 characters. An answer that asks for more than 32
  tool calls at once fails the turn, and none of them runs. So does one with a step whose
  arguments are over 64 KiB of JSON or whose tool name is over 64 characters ("The model asked
  for a step too large to run"): such a step would be drawn in the conversation and sent back to
  the provider with every later round.

**What the Assistant may not run** (`assistant_tools::blocked`, the shape of the automation gate;
the JavaScript app's `BLOCKED_COMMANDS` for this registry). Every tool that runs a command by its
id asks it: `run_command`, and `apply_adjustment` and `apply_filter` for the params they pass on.
`run_command` refuses with "Command "<id>" cannot be run by the assistant", and `list_commands`
never offers:

- `file.*` (open, save, export, place, print, close, quit, scripts, batch) except `file.fileInfo`
  and the three `file.scripts.*` that only tidy the open document;
- `ai.*` except `ai.generativeFill`: **the Assistant reaches a provider only through its own chat
  and Generative Fill**;
- `window.*`, `help.*`, `ui.*`, `tool.*` and `tools.*` (except the three colour commands),
  `edit.preferences*`, `prefs.*` (except `prefs.get`), Keyboard Shortcuts, Menus, Toolbar, Color
  Settings, History Options, the command palette, `updates.*`, `plugin.*`;
- `actions.*` (except `actions.list` and `actions.get`): an action could hold what the Assistant
  may not run; `jobs.*` except `jobs.list`; `document.*` and `session.*` except their read-only
  queries (`document.activate` would take the turn's document away), and
  `layer.copyToDocument`, which changes another document;
- what can't be undone: `edit.purge.*`, `history.clear`, `history.deleteState`,
  `history.deleteSnapshot`, and whatever deletes, resets, renames, moves or overwrites entries of
  the person's preset libraries (`brush.presets.*`, `swatches.*`, `pattern.*`,
  `gradient.presets.*`, `style.presets.*`, `shape.presets.*`, `layer.layerStyle.contours.*` with
  a last part that starts with `delete`, `reset`, `edit`, `rename`, `move` or `update`). Reading
  a library, using a preset and adding one stay the Assistant's. Nor does it change the person's
  spelling dictionary (`edit.checkSpelling` with `action` `addToDictionary`, `add` or
  `removeFromDictionary`; checking and correcting the document stay its own) or favourite fonts
  (`type.font.favorite`);
- what imports or exports (a command whose last part starts with `import`, `export` or
  `quickExport`, the contour and smart-object file commands, `edit.presets.*`), what reads a file
  or asks for one (`layer.videoLayers.newVideoLayerFromFile`, `layer.videoLayers.replaceFootage`,
  and `image.variables.*` and `image.applyDataSet`, whose data sets name image files), and
  `layer.smartObjects.revealInFinder`, which starts the file manager;
- any command with a param that names a script (`script`, `steps`), a file or a folder (`path`,
  `paths`, `file`, `folder`, `directory`, `output`, `destination`, `mapPath`), at any depth the
  params are kept to, or a colour `profile` given as a path or an `.icc` or `.icm` file: the
  Assistant works on the open document only. So `apply_adjustment` takes Color Lookup's built-in
  looks and not its `file`, and `apply_filter` runs Displace only with a map that is an open
  document. A param that shares one of those names and is no file passes: text that is one of the
  values the command's own params spec lists for that key (`"output":"current|new|duplicate"`),
  and geometry (an object, or a list without text, as a shape's `path`).

**A command that opens a dialog.** `run_command` without params runs the command as its menu item
does, so one with a dialog opens it. The turn then waits for the person to finish the dialog (the
step says so), and the model is told "The command opened a dialog; the user has closed it
(completed or cancelled). Call get_document to see the current state." The specific tools never
open a dialog: they always give params.

**The instructions** are the JavaScript app's, with the lists read from this registry: the
adjustment and filter kinds with their params as the registry documents them (name, range and
default; every adjustment is spelt out, and a filter's spec longer than 160 characters is left as
`{…}` for `list_commands`), the blend modes, and, in place of the whole command list (about a
thousand commands here), how many there are, a short list of common ones and `list_commands`.
They come to about 15,000 characters.

**Who may send.** A message is a request that is billed, so it is held like a command that sends:
nothing goes before the one-time agreement or without a connected chat provider (AI Accounts opens
and what was typed stays in the field); an agent (a control request, synthetic input) sends a
message only while "Allow agents to run AI commands" is on, and the app's backend is asked
(`admit`) before the first request. The tools of a turn then run as the person's commands.
Without that permission an agent's clicks in the window do nothing but Send (refused), Stop and
AI Accounts…: the provider, the chat model, Attach image, List models and Clear are the person's,
as the settings in AI Accounts are.

## The command line

`pigment-cli ai` is the command line's AI Accounts (`apps/photocraft-cli/src/ai.rs`):

| Subcommand | Does |
|---|---|
| `ai status [--json]` | the providers, how each is connected (a key's hint, never a key; a ChatGPT sign-in's e-mail address, never a token), models, consent, `allowAgents`, where keys are kept |
| `ai set-key <openai\|gemini> [--no-check]` | reads the key from standard input (without echo at a Unix terminal), checks it with the provider, stores it; a key given on the command line is refused |
| `ai clear-key <provider>` | removes the key |
| `ai sign-in [--port N]` | Sign in with ChatGPT (experimental): prints the address to open in a browser and waits (five minutes at most) for the browser's callback, or for the address it landed on pasted on standard input. With an OpenAI key stored it says first that signing in replaces the key (AI Accounts does not offer the sign-in then) |
| `ai sign-out` | removes the ChatGPT sign-in from this computer |
| `ai test [<provider>] [--json]` | lists the models with the stored key |
| `ai consent [--revoke]` | the one-time agreement, with its wording |
| `ai agents <on\|off>` | `allowAgents` |
| `ai use <provider> [--chat-model ID] [--image-model ID]` | the preferred provider and its models (`""` for automatic) |

`pigment-cli run --new '{"width":64,"height":32}' --cmd select.rect --params '{"x":8,"y":8,"width":16,"height":8}' --cmd ai.generativeFill --params '{"prompt":"a green box"}' --out out.pigment --allow-ai`
runs Generative Fill from the command line. A step refused because the agreement or a key is
missing fails with the engine's message, which names the app's Edit › AI Accounts…, and a second
line naming the command line's way: `pigment-cli ai consent`, or `pigment-cli ai set-key`.

## Pigment 0.4's features in Pigment 0.5, one by one

Every AI feature of the JavaScript app (0.2 to 0.4), with the command and the place it has now.
**Has it**: the same behaviour. **Differs**: there, changed on purpose; the letter names the
decision below, and "Differences from Pigment 0.4, and follow-ups" says more. **Missing**: not in
0.5.0 (the list after the tables gathers these). Checked against the code at the end of the port.

The decisions the port was built on:

- **A. Photoshop's places.** No AI menu: Edit, Layer, Image and Window, the task bars, the
  selection's context menu, and the command palette for everything.
- **B. Remove Background masks the layer in place**, as Photoshop and PhotoCraft do, and the
  menu's default is the local method, which needs no key.
- **C. A one-time agreement** in AI Accounts; nothing is sent before it.
- **D. A request locks its document** until the answer lands or is cancelled (first version).
- **E. Actions never send; agents and the command line opt in.** The Assistant may run only
  Generative Fill among the `ai.*` commands.
- **F. Local masks.** The sky comes from Select › Sky, the subject from the layer or Select
  Subject; only the new pixels come from the provider.
- **G. No migration** from the Electron app: keys and the ChatGPT sign-in are entered again.
- **H. Sign in with ChatGPT is experimental** and can be turned off; images always need an API key.
- **I. Pigment's own provider crate, in the desktop app and `pigment-cli` only.** The browser build
  has no AI.

**Accounts and settings**

| Pigment 0.4 | Pigment 0.5 | |
|---|---|---|
| AI › AI Accounts… (`ai:accounts`), a modal with a card per provider; also opened by a feature that finds nothing connected | `ai.accounts`: Edit › AI Accounts…, the AI Accounts… button in Preferences › AI Integrations, and Open AI Accounts… in every AI window; a modal with a tab per provider | Has it (A) |
| OpenAI and Gemini API keys: a masked field, Connect checks the key with the provider and stores it only when accepted, Enter connects, a link to the provider's key page, Sign out | The same: Connect (one model list), "ends in …WXYZ", Get a key…, Remove Key; plus Test Connection. `pigment-cli ai set-key`, `clear-key`, `test` | Has it |
| Keys sealed through the system keychain (Electron safeStorage); without one, a plain file and a warning | The macOS Keychain and the Windows Credential Manager; on Linux and the BSDs the 0600 `ai-keys.json`, not encrypted, and the dialog says so | Differs (I): no keychain on Linux |
| Chat model and Image model per provider: drop-down lists of the provider's catalog, the default by a preference list | The same two choices and the same preference lists; the fields are text: empty is automatic, Use Suggested fills in the pick from the last list read | Differs: no drop-down list in AI Accounts |
| Preferred provider; choosing it resets the providers the dialogs last used | Preferred provider, with the same reset (`defaultProvider`, `imageProvider`, `chatProvider`) | Has it |
| The provider a feature uses: the preferred one when it fits the kind of model, else the first connected one that does; a dialog opens on the provider it last used | The same order (the request's own, the preferred, OpenAI, Gemini); the Generate window opens on `imageProvider`, the Assistant on `chatProvider` | Has it |
| The status: which provider is connected and how, never a key | `ai.status` (never a key; a hint of four characters at most), `pigment-cli ai status` | Has it |
| Sign in with ChatGPT: a ChatGPT Plus or Pro plan for chat models; the browser, ports 1455 to 1460, Copy link, Cancel, the pasted callback address; the e-mail and "plan access not granted"; token refresh; the plan route's messages | The same flow, checks, addresses and messages, on OpenAI's tab; `pigment-cli ai sign-in`, `sign-out` | Differs (H): marked Experimental, one switch turns it off, tokens in the key store. Never tried against the live service (nor was 0.4's) |
| A key and a sign-in exclude each other; images need an API key | The same | Has it |
| No consent step: connecting an account was the consent | The one-time agreement in AI Accounts (`pigment-cli ai consent`) | Differs (C) |
| Timeouts: chat 180 s, images 300 s, model lists 30 s | One Request timeout in AI Accounts for chat and images (300 s, 10 to 600); model lists 30 s | Differs: one setting |
| Remembered in the settings: models, providers, the last prompt of each feature, Attach image, the installation id | The same, in `ai.json` | Has it |
| Keys, sign-in and choices kept from one version to the next | Nothing is read from 0.4 | Differs (G) |
| The browser build: keys in the browser's storage, requests straight to the providers | None | Missing (I) |

**The features**

| Pigment 0.4 | Pigment 0.5 | |
|---|---|---|
| AI › Generative Fill… (`ai:generative-fill`): a selection, a prompt, 1 to 3 variations, each a new layer holding the answer inside the selection | `ai.generativeFill`: Edit › Generative Fill… (after Content-Aware Fill), the selection's context menu, the task bar under a selection | Has it (A). The region, the feather, the layer names, the kept selection and "Make a selection first" are 0.4's |
| AI › Generative Expand… (`ai:generative-expand`): new width, height and where the image stays; fills transparency the canvas already has; a default prompt; "Nothing to expand" | `ai.generativeExpand`: the Crop tool's task bar and the command palette (no menu item) | Has it (A). Differs: the canvas growth and the fill are one undo step (0.4: a Canvas Size step, taken back when the request failed) |
| AI › Generate Image… (`ai:generate-image`): a new layer of the document's size or a new document of 16 to 8192 px; Transparent background | `ai.generateImage`: Edit › Generate Image… | Has it (A). Differs: Transparent background is offered for every model (0.4 hid it for DALL·E), since every model without alpha is keyed |
| AI › Remove Background (`ai:remove-background`): the image model returns the subject; a masked copy of the layer, the original hidden | `ai.removeBackground` `{"method":"provider"}`: Layer › Remove Background with AI Provider (`ai.removeBackgroundWithProvider`) | Differs (B): the mask goes on the layer itself. Missing: a type, shape or smart object layer is not rasterized for it |
| (none: 0.4's only Remove Background called the provider) | `ai.removeBackground` (`local`): Layer › Remove Background, on the computer, nothing sent | New (B) |
| AI › Replace Background… (`ai:replace-background`): a first request finds the subject, a second fills around it | `ai.replaceBackground`, Generate Background…: Layer › Generate Background…, and the task bar after Remove Background | Differs (F): the subject is the layer's mask or transparency, else Select Subject's, so one request. Run Remove Background with AI Provider first for 0.4's two |
| AI › Replace Sky… (`ai:replace-sky`): the selection, else a bright area found from the top edge; "A dramatic sunset sky with warm clouds" | `ai.replaceSky`, Sky Replacement…: Edit › Sky Replacement… | Differs (F): without a selection the sky is Select › Sky's. The default prompt is 0.4's |
| AI › Describe Image (`ai:describe`): the composite at 1024 px; Copy, Use as document description | `ai.describe`: Image › Describe Image…; Copy, Use as Document Description (`file.fileInfo`, one undo step) | Has it (A) |
| The feature dialog: the prompt (the feature's last one, cut to 4000 characters), provider, a model list, Generate | The Generate window, not modal: the prompt, the options, the provider when two fit, a Model field for this request, what the feature sends | Has it. Differs: the model is a text field (empty: AI Accounts' choice) and the window does not save it |
| While a request runs: a notice with Cancel, and the document stays editable; Cancel drops the late answer | The status bar shows the job with Cancel, the window shows Stop; the document is locked, other documents are not | Differs (D) |
| A failure: a notice with AI Accounts… when that fixes it | In the window, with Open AI Accounts… or Try Again | Has it |
| A result: new layers above the active one, the last active, one undo step, the original pixels untouched | The same, in RGB, Grayscale, CMYK and Lab at 8, 16 and 32 bits (0.4: 8-bit RGB) | Has it |
| Actions record the AI dialogs' values, and playing one calls the provider again | A command that sends is neither recorded nor played; the local Remove Background is | Differs (E) |
| No shortcut on any AI command; all in the command search | No default shortcut; all in the command palette. The `ai.*` commands can be given one in Edit › Keyboard Shortcuts; AI Accounts, Remove Background with AI Provider and Assistant cannot | Has it |
| Calling the features from code (`app.aiFeatures`) | Every feature is a command: `pigment-cli run --allow-ai`, MCP and the control channel with "Allow agents to run AI commands" | Has it (E) |

**The Assistant**

| Pigment 0.4 | Pigment 0.5 | |
|---|---|---|
| The Assistant panel, docked at the bottom: Window › AI Assistant, AI › AI Assistant (`ai:assistant`, which focuses the input) | `window.panel.aiAssistant`: Window › Assistant, a floating window; opening it focuses the message field | Differs (A): a window, not a docked panel |
| Provider and Chat model lists, Attach image, AI Accounts, Clear the conversation | The same; the chat models are listed when List models is pressed (or from AI Accounts' recent list), Automatic needs none | Has it. Differs: the list is not fetched unasked |
| A conversation per document, in memory; 40 messages; only the latest message carries its image, at most 1024 px | The same | Has it |
| Enter sends, Shift+Enter is a new line; Stop; "Thinking…", "Working…", the steps with their labels; a command that opens a dialog makes the turn wait | The same | Has it |
| Twelve tool rounds a turn; "Stopped after 12 tool steps…", "Done.", "(no answer)", "Stopped." | The same; also at most 32 calls in one answer and 64 KiB a call | Has it |
| Fourteen tools: `get_document`, `set_active_layer`, `apply_adjustment`, `apply_filter`, `run_command`, `new_layer`, `set_layer_props`, `select`, `crop`, `resize_image`, `canvas_size`, `fill_selection`, `add_text`, `generative_fill` | The same fourteen on PhotoCraft's commands, and `list_commands` | Has it |
| The instructions list every adjustment and filter kind, the blend modes and every command id | The same paragraphs from this registry; the command ids are looked up with `list_commands` (about a thousand commands) | Differs: looked up, not listed |
| Blocked commands (files, quit, preferences, windows, tools, help, `ai:`) | The same families and more (other documents, preset libraries, anything that names a file) | Has it, stricter |
| Arguments checked: ids, ranges from two tables, rectangles cut to the canvas, JSON given as text | The same checks; the ranges come from each command's own params | Has it |
| `generative_fill` is the one AI feature the Assistant runs | The same | Has it (E) |

**The providers**

| Pigment 0.4 | Pigment 0.5 | |
|---|---|---|
| OpenAI: `/images/edits`, `/images/generations`, `/responses`, `/models`; Gemini: `generateContent`, `/models`; the sizes, ratios, masks, padding and white keying | The same requests (see "The provider crate") | Has it |
| Errors in plain words, with the ChatGPT plan's hints; a provider's message passed on as it came | The same, and a key or token is taken out of every message | Has it |
| No request on its own; model lists fetched when a dialog shows them, kept ten minutes | No request on its own; a model list is fetched only by Connect, Test Connection, List models or a request that needs the automatic model, kept ten minutes | Has it |

**New in 0.5:** the local Remove Background in the Layer menu; the task bars (a prompt under a
selection, Generate Background… after Remove Background, Generative Expand in the Crop tool's);
Generative Fill in the selection's context menu; Test Connection; the agreement; "Allow agents to
run AI commands"; `pigment-cli ai` and `run --allow-ai`; every colour mode and depth.

**Missing in 0.5.0**, each small or decided:

- AI in the browser build (I). No browser build of Pigment 0.5 is published.
- Drop-down model lists in AI Accounts and the Generate window. The fields are text with an
  automatic default and Use Suggested; the Assistant lists the chat models on request.
- Editing a document while its request runs (D): see "Follow-up: editing during a request".
- Remove Background with AI Provider on a type, shape or smart object layer: rasterize it first.
- Playing AI steps from an action (E), and reading 0.4's keys, sign-in, model choices and last
  prompts (G).
- The Assistant as a docked panel.
- A keyboard shortcut for AI Accounts, Remove Background with AI Provider and Assistant.
- A Generative Expand entry in the Crop options bar's Fill: list (it is in the Crop tool's task
  bar and the palette).
- Translations: the AI windows are in English in every language.

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
- **Sign in with ChatGPT is marked experimental and can be turned off** (one constant, or
  `"chatgptSignIn": false`). Otherwise it is 0.4's: chat models only, the same addresses, ports,
  scopes, checks and messages. What differs: the tokens are in the key store (the OS credential
  store, or the 0600 key file where 0.4 used Electron's safeStorage); the one-time agreement
  applies to its requests; the key field stays on OpenAI's tab while signed in (connecting a key
  replaces the sign-in); a refresh also yields to a sign-in changed by another Pigment process;
  0.4's generic request proxy (and its path checks) has no counterpart, since only the providers
  build requests here; and `pigment-cli ai sign-in` is new.
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
- **One request timeout.** 0.4 gave chat 180 s and images 300 s; AI Accounts' Request timeout
  (300 s by default) is for both.
- **Model fields are text.** 0.4 filled drop-down lists from the provider's catalog in AI Accounts
  and in each dialog. Here a field left empty is automatic (the same preference lists), Use
  Suggested fills in the pick from the last list read, and only the Assistant lists models, on
  request. Lists in AI Accounts and the Generate window are a follow-up.
- **Transparent background is offered for DALL·E too** (0.4 hid it): those answers are keyed off
  white like Gemini's.
- **Nothing is read from Pigment 0.4**: not the keys or the sign-in (sealed by Electron), nor the
  model choices, the last prompts and the installation id, which start afresh in `ai.json`.
