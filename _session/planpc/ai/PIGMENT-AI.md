# Pigment's generative AI (JavaScript 0.2 to 0.4): an inventory for the Rust rebuild

This is a reading of the JavaScript Pigment's AI code, written so that each feature can be rebuilt in
Rust on PhotoCraft without opening the JavaScript. Everything below was read from source, not run.

Sources and revisions:

| Source | Where | Revision |
|---|---|---|
| JavaScript Pigment 0.4.0 | `/home/user/claude`, branch `claude/fervent-newton-263lz3`, directory `pigment/` | `5305a81` |
| Rust tree (PhotoCraft 0.23.1) | `/home/user/claude/pigment` | upstream `abb30dff`, local head `15b8ea5` |
| Nib (VectorCraft fork with its own AI crate) | branch `origin/claude/nib-vector-editor`, `nib/` | `1fbbfc3` |
| ArtCraft shared AI layer | `/home/user/storytold/craft-ai-integrations` | `db30646` |

JavaScript files with AI code (all paths below are under `pigment/`):

| File | Lines | What it holds |
|---|---|---|
| `src/main/ai.js` | 889 | Main process: credential store, Sign in with ChatGPT, the request proxy, plan-route reshaping, SSE folding, error translation, model catalogs |
| `src/main/ipc.js` (lines 275-277) | | `createAi({ electron, getWindow, settings })`, IPC handler `pigment:ai` |
| `src/main/main.js` (line 400) | | passes `safeStorage` to `createAi` |
| `src/preload.cjs` (line 56) | | `window.pigment.ai(method, payload)` = `ipcRenderer.invoke('pigment:ai', method, payload)` |
| `src/renderer/lib/ai/client.js` | 186 | Renderer transport: Electron bridge, browser build (keys in `localStorage`), test transport |
| `src/renderer/lib/ai/providers.js` | 654 | Request builders and pixel helpers: chat with a tool loop, generate, edit, describe, sizes, masks |
| `src/renderer/lib/ai/accounts.js` | 414 | AI Accounts dialog and `app.ai` (status, prefs, model choice, `ensureConnected`) |
| `src/renderer/lib/ai/features.js` | 719 | The seven AI menu commands |
| `src/renderer/lib/ai/assistant.js` | 572 | The Assistant: instructions, 14 tools, turns, Stop |
| `src/renderer/lib/panels/assistant.js` | 239 | The Assistant panel |
| `src/shared/menu-template.js` (lines 625-639) | | the AI menu |
| `src/shared/defaults.js` (lines 35-37) | | `settings.ai`, `settings.aiHostId` |
| `src/renderer/index.html` (line 6) | | CSP `connect-src` for the browser build |
| `src/renderer/styles/ai.css` | 66 | styles only |
| `tests/unit/ai.test.mjs`, `tests/e2e/ai-*.spec.mjs` | | tests (section 12) |

Contract text for the same code: `ARCHITECTURE.md` "0.2 features: AI" (lines 384-492). User text:
`docs/USER-GUIDE.md` "AI" (lines 715-773) and troubleshooting (lines 2244-2253).

Naming: "JS" means the JavaScript Pigment; "Rust" means the tree in `/home/user/claude/pigment`.
Quoted UI strings are exact.

---

## 1. Architecture in one page

```
renderer (no secrets)                                 main process (secrets)
features.js / assistant.js                            src/main/ai.js  createAi().dispatch(method, payload)
  └ providers.js: builds provider bodies (JSON or multipart)
      └ client.js aiCall(method, payload) ── IPC 'pigment:ai' ──▶ status | setApiKey | signOut |
                                                                   chatgptSignIn | chatgptSignInStatus |
                                                                   chatgptSignInManual | chatgptSignInCancel |
                                                                   models | request
                                                                   └ adds Authorization / x-goog-api-key,
                                                                     refreshes ChatGPT tokens, reshapes
                                                                     /responses for the plan route,
                                                                     folds SSE, translates errors
```

- The renderer builds every provider body itself and hands it to `request({ provider, path, method,
  json | multipart, stream, timeoutMs })`; the main process only authenticates, validates the path and
  sends it. The renderer never receives a key or a token, only a status object and response bodies.
- Errors cross IPC as `Error(message + '\u001f' + JSON.stringify({ code, status }))`
  (`AI_ERROR_SEPARATOR`, because Electron keeps only `message`); `client.js parseBridgeError` strips
  Electron's prefix `Error invoking remote method '…': Error: ` and restores `{ message, code, status }`.
- Three transports in `client.js aiCall`, chosen in this order: a test transport
  `window.__pigmentTest.ai` (`{ request(payload) -> body, status?(), models?(), … }`), the Electron
  bridge, and the browser build (`browserCall`: keys in `localStorage['pigment.ai.keys']` as plain
  JSON `{ openai?: key, gemini?: key }`, `fetch` straight to the providers; no ChatGPT sign-in).
- `aiRequest(payload)` returns `r.body` (the main process answers `{ status, body }`).

Provider bases (`BASES`): `openai` = `https://api.openai.com/v1`, `gemini` =
`https://generativelanguage.googleapis.com/v1beta`. Provider labels (`PROVIDERS`): `openai` "OpenAI",
`maxEdge` 1536; `gemini` "Google Gemini", `maxEdge` 2048. (`ai.js PROVIDER_NAMES` uses "OpenAI" and
"Gemini" in its own messages.)

---

## 2. Where AI sits in the interface

### 2.1 The AI menu (`src/shared/menu-template.js` 625-639)

Top-level menu `A&I`, between Filter and View. Items, in order (`&` = mnemonic):

| Item | Command | Enabled when |
|---|---|---|
| AI &Accounts… | `ai:accounts` | always |
| — | | |
| Generative &Fill… | `ai:generative-fill` | a document, an active non-group layer and a non-empty selection |
| Generative &Expand… | `ai:generative-expand` | an active non-group layer |
| Generate &Image… | `ai:generate-image` | a document is open (menu); the command itself runs without one (it then makes a new document) |
| — | | |
| Remove &Background | `ai:remove-background` | an active non-group layer |
| Replace Background… | `ai:replace-background` | an active non-group layer |
| Replace &Sky… | `ai:replace-sky` | an active non-group layer |
| — | | |
| &Describe Image | `ai:describe` | a document |
| — | | |
| AI A&ssistant | `window:panel-assistant` | always |

Window menu: last group, "AI Assistant" (`window:panel-assistant`). There is also a command
`ai:assistant` ("AI Assistant"): shows the panel (`app.panels.show('assistant', { reveal: true })`)
and focuses its input. No AI command has a keyboard shortcut (`src/shared/keymap.js` has none). There
is no contextual task bar, no Edit-menu entry and no canvas context-menu entry for any AI feature.
Items reach Edit › Search (command search) like every menu item.

Being "connected" never disables a menu item: the command runs and opens AI Accounts when nothing fits
(section 3.6).

### 2.2 Actions (recording and playback)

`lib/actions/model.js` ignores `ai:accounts` and `ai:describe` when recording. The dialog commands
(`ai:generative-fill`, `-expand`, `generate-image`, `replace-background`, `replace-sky`) record the
dialog's values with `ctx.setReplayArg(values)` (a JSON copy: `prompt`, `provider`, `model` and the
dialog's own fields). A recorded step with an argument that has a string `prompt`, a `provider` and a
`model` (`recordedValues`) runs without the dialog, so **playing an action calls the provider again**.
`ai:remove-background` records with no argument. A cancelled or failed run calls `ctx.cancel()` so
nothing is recorded.

### 2.3 Settings keys (renderer `app.settings`, file managed by `src/main/settings-store.js`)

```js
ai: {
  openaiChat: null, openaiImage: null, geminiChat: null, geminiImage: null,   // model per provider and kind
  defaultProvider: 'openai',          // "Preferred provider"
  chatProvider, imageProvider,        // the provider the last dialog chose, per kind (added on use)
  lastFillPrompt, lastExpandPrompt, lastGeneratePrompt, lastBackgroundPrompt, lastSkyPrompt,  // prompts, plain text
}
aiHostId: null | 'urn:uuid:…'          // written by the main process on first sign-in
assistantAttach: true | false          // the panel's "Attach image" (absent = true)
```

Prefs are written through `app.saveSettingsSoon({ ai: { ...prefs, ...patch } })`.

---

## 3. AI Accounts

### 3.1 The dialog (`lib/ai/accounts.js accountsDialog`)

Modal, title "AI Accounts", width 640, one button "Close" (primary). Opened by `ai:accounts`, by the
Assistant panel's person icon (tooltip "AI Accounts…"), by the "AI Accounts…" action on error toasts and
Assistant errors, and automatically by `ensureConnected` with a reason.

Top of the dialog, when opened for a reason:
- kind `image`: "This feature needs an image model: connect OpenAI or Gemini with an API key."
- otherwise: "This feature needs an AI provider: sign in or add an API key."
- if `status.available` is false: "AI is not available in this build."

**OpenAI card** (heading "OpenAI", a check badge when connected, state text):
- state: "Not connected"; "Signed in with ChatGPT" + " · <email>" when known + " · plan access not
  granted" when `plan === false`; or "Connected with an API key" + " (kept in this browser)" in the
  browser build.
- Not connected, no sign-in pending:
  - button "Sign in with ChatGPT" (primary; disabled in the browser build) and beside it "Uses your
    ChatGPT Plus or Pro plan for chat models" (browser build: "Desktop app only");
  - "or", "Use an API key";
  - a password field (placeholder "sk-…", no spellcheck, autocomplete off) and "Connect" (primary).
    Enter in the field presses Connect and does not close the dialog. Under it a link "Get a key at
    platform.openai.com" → `https://platform.openai.com/api-keys` (opened in the system browser);
  - note: "Image models (generative fill, generate image, remove background) need an API key; a ChatGPT
    plan covers chat and the assistant."
- Sign-in pending: the pending box (section 4.6).
- Connected: "Chat model" select and "Image model" select (with ChatGPT the image select is disabled
  and reads "Needs an API key"), "Sign out", and with ChatGPT the note "Add an API key after signing
  out to use image models."

**Google Gemini card** (heading "Google Gemini"):
- always: "Google offers no plan-based sign-in for third-party apps, so Gemini always uses an API key
  from Google AI Studio."
- not connected: password field (placeholder "AIza…") + "Connect", link "Get a key at
  aistudio.google.com" → `https://aistudio.google.com/apikey`;
- connected: "Chat model", "Image model", "Sign out".

**Footer**: "Preferred provider" select (OpenAI / Google Gemini). Changing it saves `defaultProvider`
**and** resets `imageProvider` and `chatProvider` to the same value. Warnings:
- desktop without keychain (`status.encryption === false`): "This system offers no secure storage:
  keys and tokens are kept unencrypted in ai-credentials.json in the app data folder."
- browser build: "Browser build: keys are kept in this browser and requests go straight to the
  providers."

Model selects: show "Loading…" while `app.ai.models(provider)` runs, then the chat or image ids
(alphabetical), preselecting the saved pref when still listed, else the catalog default; "No chat
models available" / "No image models available" when empty; "Could not list models: <message>" on
error. A change saves `<provider>Chat` / `<provider>Image` (`null` for the empty option).

Connect flow: empty field → focus it, nothing sent. Otherwise the button reads "Checking…" and is
disabled; `setApiKey({ provider, key: key.trim() })`; success clears the field, drops the renderer's
model cache, toasts "<OpenAI|Google Gemini> connected" (success, 2.5 s) and re-renders; failure
restores "Connect" and toasts the error message (or "The key was not accepted"), 7 s.

Sign out: `signOut({ provider })`, drop the model cache, re-render; error toast "Could not sign out".

On close the dialog re-reads the status (`ai.status()`), which emits `ai:status` when it changed.

### 3.2 The status object

```ts
{ available: true, encryption: boolean, browser?: true,
  openai: { method: 'chatgpt' | 'api_key' | null, email?: string, plan?: boolean },
  gemini: { method: 'api_key' | null },
  signInPending?: true }
```

`app.ai.status()` fetches it (an error gives the empty status `{ available: false, encryption: false,
openai: { method: null }, gemini: { method: null } }` and a `console.warn('ai status', err)`), stores it
in `app.ai.current`, and when it changed emits `ai:status` and `app.commands.invalidate()`. It is read
once at `app:ready`.

`providerFits(status, provider, kind)`: false without a method; for `image` only `api_key` fits (a
ChatGPT sign-in never runs image models); for `chat` any method fits.

### 3.3 Keys: validation and storage (main process, `ai.js`)

`setApiKey({ provider, key })`:
1. `provider` must be `openai` or `gemini` ("Unknown AI provider", code `bad_request`).
2. `key.trim()`; empty → "Enter an API key"; contains whitespace → "An API key contains no spaces;
   check what you pasted" (both `bad_request`).
3. Validation request with the new key: OpenAI `GET /models`, Gemini `GET /models?pageSize=200`
   (timeout 30 s). A failure rejects with the provider's translated error; nothing is stored.
4. For OpenAI, a pending ChatGPT sign-in is cancelled and the OpenAI generation counter bumped (so an
   in-flight token refresh cannot overwrite the new entry).
5. Store `{ method: 'api_key', key: seal(k), addedAt: <epoch s> }` under the provider (an OpenAI key
   replaces a ChatGPT sign-in), cache the parsed catalog for `provider:api_key`, save, return status.

The browser build validates with `GET /models` (OpenAI) or `GET /models?pageSize=1` (Gemini) and stores
the key in `localStorage` only after success.

**Credential file**: `<userData>/ai-credentials.json` (Electron `app.getPath('userData')`), written as
`JSON.stringify({ version: 1, ...creds }, null, 2)` to `<path>.<pid>.<random>.tmp` with mode `0o600`,
then renamed over the file (temp removed on failure; error "Could not save the AI credentials:
<message>", code `storage`). Shape:

```js
{ version: 1,
  openai: { method: 'api_key', key: SEALED, addedAt }
        | { method: 'chatgpt', clientId, accessToken: SEALED, refreshToken: SEALED|null, idToken: SEALED|null,
            expiresAt /* epoch s */, earliestRefreshAt /* epoch s, 0 = none */, email, plan /* bool */, signedInAt },
  gemini: { method: 'api_key', key: SEALED, addedAt } }
```

`SEALED` is `enc:<base64 of safeStorage.encryptString(value)>` when `safeStorage.isEncryptionAvailable()`,
else `plain:<value>`. `unseal`: `plain:` → the value; `enc:` → `safeStorage.decryptString`, and if
decryption fails (the OS key changed) the value counts as missing, so the account shows as not
connected. On load, if a keychain is now available, every `plain:` value of `key`, `accessToken`,
`refreshToken`, `idToken` is re-sealed and saved. A missing or unreadable file is an empty store.
Without `safeStorage` at all the module logs `ai: electron.safeStorage was not provided; credentials
will be stored unencrypted`. Status reports a provider as connected only when its secret unseals.

`signOut({ provider })`: for OpenAI cancels a pending sign-in and bumps the generation; deletes the
entry; drops both model caches of the provider; saves; returns status. There is no server-side token
revocation.

### 3.4 Model catalogs and model choice

Main `models({ provider })`: the provider must be connected; cache key `<provider>:<method>`, 10 minutes;
request OpenAI `GET /models`, Gemini `GET /models?pageSize=200` (30 s), through `request()` (so with a
ChatGPT sign-in it goes to the plan route with the access token). `parseModelCatalog` returns
`[{ id, kind, label? }]` sorted by id, without duplicates:
- OpenAI API key answers `{ data: [{ id }] }`; the ChatGPT plan route answers `{ models: [{ slug }] }`;
  strings are accepted too; label from `display_name` or `title`.
- Gemini answers `{ models: [{ name: 'models/x', displayName, supportedGenerationMethods }] }`; id is
  `name` without `models/`.

Kinds:
- OpenAI (`openaiModelKind`): `/image|dall-e/` → `image`; `/embed|tts|whisper|transcri|audio|realtime|
  moderation|search|babbage|davinci|instruct|computer-use|sora|codex-mini/` → `other`;
  `/^(gpt|o\d|chatgpt)/` → `chat`; else `other` (lower-cased id).
- Gemini (`geminiModelKind`): `/image|imagen/` in the name → `image`; else if
  `supportedGenerationMethods` includes `generateContent`: `/embedding|aqa|tts|audio|veo|live/` →
  `other`, else `chat`; else `other`.

Renderer `listModels(provider)` → `{ chat: id[], image: id[], default: { chat, image }, all }`, cached
per provider until the accounts change (`invalidateModels`). Defaults (`PREFERRED_MODELS`, first match
wins: an exact id first, then the first id that starts with a preferred id, else the first listed):

| | chat | image |
|---|---|---|
| OpenAI | `gpt-5.5`, `gpt-5.1`, `gpt-5`, `gpt-4.1`, `gpt-4o` | `gpt-image-1.5`, `gpt-image-1`, `gpt-image-2` |
| Gemini | `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.0-flash` | `gemini-3.1-flash-image`, `gemini-3.1-flash-image-preview`, `gemini-3-pro-image-preview`, `gemini-2.5-flash-image` |

`app.ai.model(provider, kind)`: the saved pref (`openaiChat` …) if the catalog still lists it, else
the catalog default, else the saved pref; if listing fails, the saved pref or `null`.

### 3.5 Which provider a feature uses

`ensureConnected(kind)`: read the status; candidates in order `[defaultProvider, 'openai', 'gemini']`
(deduplicated); the first that fits `kind` wins. If none fits, open AI Accounts with `reason: kind`,
re-read, and pick again; still none → `null` (the feature silently stops; the dialog was the message).

`connected(kind, { dialog })` in `features.js`:
- dialog-less features (Remove Background, Describe, and a Generative Fill called with arguments): the
  Preferred provider if it fits, else the kind's last dialog choice if it fits, else the
  `ensureConnected` pick;
- a dialog starts from the kind's last dialog choice (`imageProvider` / `chatProvider`) if it fits,
  else the Preferred provider, else the pick.

The provider select of a dialog lists, for `image`, only providers connected with an API key; for
`chat`, every connected provider.

### 3.6 The feature dialog fields (`providerFields`, `optionsDialog`)

Every feature dialog (`formDialog`, width 480, class `ai-dialog`, OK button "Generate"):
1. "Prompt" textarea (rows 3; its label varies per feature), prefilled from the last prompt of that
   feature;
2. "Provider" select (see 3.5);
3. "Model" select, refilled whenever the provider changes ("Loading…", the kind's model ids with the
   saved pref or default preselected, "No image models for <label>" / "No chat models for <label>",
   "Could not list models: <message>"); a stale fill is dropped by a token;
4. the feature's own fields.

Validation on OK: an empty prompt toasts "Enter a prompt"; no model toasts "Choose a model (connect a
provider with image models in AI Accounts)"; the dialog stays open. On OK: the provider and model are
saved (`imageProvider|chatProvider`, `<provider>Image|Chat`), and the prompt is trimmed and cut to
**4000 characters** (`PROMPT_LIMIT`).

---

## 4. Sign in with ChatGPT

Desktop only (browser build: "Sign in with ChatGPT needs the desktop app; use an API key here", code
`desktop_only`). It uses the user's ChatGPT Plus or Pro plan for **chat requests only** (Describe Image,
the Assistant); image features always need an API key. No client secret exists anywhere: the client is
a public PKCE client.

### 4.1 Constants (`CHATGPT_AUTH`)

| | |
|---|---|
| authorize URL | `https://auth.openai.com/api/accounts/authorize` |
| token URL | `https://auth.openai.com/api/accounts/oauth/token` |
| issuer | `https://auth.openai.com` |
| resource | `https://api.openai.com/v1` (sent on authorize, code exchange and refresh) |
| scope | `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct` |
| plan scope | `chatgpt.tokens.use.direct` (granted = plan access) |
| first client id | `dynamic_agent_client` |
| agent name hint | `Pigment` |
| callback path | `/auth/callback` |
| loopback ports | 1455, 1456, 1457, 1458, 1459, 1460 (127.0.0.1 only) |
| sign-in timeout | 5 minutes |
| refresh lead | 5 minutes before expiry |

### 4.2 Start (`chatgptSignIn({ port? })`)

1. If an attempt is pending, return its promise (one attempt at a time).
2. PKCE: verifier = base64url(48 random bytes) (no padding, `+`→`-`, `/`→`_`); challenge =
   base64url(SHA-256(verifier)); method `S256`. `state` and `nonce` = base64url(24 random bytes) each.
3. Bind an HTTP server on 127.0.0.1, trying the ports in order (a given `port` first). `EADDRINUSE` or
   `EACCES` tries the next. When all are taken the attempt continues without a listener, the redirect
   URI uses the first port, and the warning "Ports 1455–1460 are all in use; close the program using
   them, or finish the sign-in by pasting the address the browser lands on" is shown in the card
   (code `port_in_use`). Any other listen error fails the attempt ("Could not start the sign-in
   listener: <message>").
4. `redirect_uri = http://127.0.0.1:<port>/auth/callback`.
5. Host id: `settings.aiHostId` if it starts with `urn:uuid:`, else a new `urn:uuid:<randomUUID>`
   saved to settings (a failure only logs `ai: could not persist the host id`). It identifies the
   installation across sign-ins.
6. Authorize URL query (in this order): `response_type=code`, `client_id=dynamic_agent_client`,
   `redirect_uri`, `scope`, `resource`, `state`, `nonce`, `code_challenge`,
   `code_challenge_method=S256`, and, because the client id is the dynamic one,
   `agent_name_hint=Pigment` and `ext_agent_host_id=<host id>`.
7. 5-minute timer → "The sign-in timed out after 5 minutes; try again" (code `timeout`).
8. Open the URL in the system browser (`shell.openExternal`; a failure only logs `ai: could not open
   the browser`; the user can still Copy link).
9. The IPC call resolves with the status when the sign-in completes, or rejects.

### 4.3 The callback

The loopback server answers any path other than `/auth/callback` with 404 "Not found". For the callback
it parses the query (`parseCallback` also accepts a full URL, a path with a query, or a bare query
string, for the pasted address):
- `code`, `state`, `client_id` (the issued client id, `oaiapp_…`), `error`, `error_description`;
- empty input → "Paste the full address of the page the browser landed on"; unparsable → "That does
  not look like a callback address"; neither `code` nor `error` → "The callback address carries no
  authorization code" (all code `bad_callback`; the loopback answers 400 with the failure page).

`completeSignIn(parsed)`:
1. No attempt → "No sign-in is in progress" (`no_sign_in`).
2. `state` must equal the attempt's, **checked before anything else, error included** → "The callback
   belongs to another sign-in attempt; start again" (`state_mismatch`). A mismatch does not end the
   attempt (it may be a stray request).
3. `error` present → `error_description` or "Sign-in refused (<error>)", code = the error.
4. Exchange (single-flight per attempt): `POST https://auth.openai.com/api/accounts/oauth/token`,
   `Content-Type: application/x-www-form-urlencoded`, `Accept: application/json`, timeout 30 s, body
   `grant_type=authorization_code`, `code`, `code_verifier`, `redirect_uri`, `client_id=<issued client id,
   else dynamic_agent_client>`, `resource=https://api.openai.com/v1`. A non-2xx answer is translated
   (section 5.4; code defaults to `token_error`); an answer without `access_token` → "The token endpoint
   answered without an access token".
5. If the attempt was cancelled or timed out meanwhile → "Sign-in cancelled" (`cancelled`), nothing
   stored.
6. Store (`storeTokens`): the first exchange must carry an `id_token` ("The sign-in answer carried no ID
   token"); validate it (4.5); `expiresAt = now + expires_in` (default 3600 s);
   `earliestRefreshAt = parseRefreshAt(earliest_refresh_at)` (seconds, milliseconds when > 1e11, or an
   ISO date; 0 = none); `email` from the ID token, else the access token's claims; `plan` = the scopes
   (`tokens.scope`, else the access token's `scp` array or `scope` string) contain
   `chatgpt.tokens.use.direct`; `signedInAt`. The OpenAI entry is replaced (an API key is dropped).
7. Save, drop the `openai:chatgpt` model cache, resolve the attempt with the status, close the server.

The browser is answered with a small HTML page (`callbackPage`, `Cache-Control: no-store`): title
"Pigment — Signed in" / "Pigment — Sign-in failed"; heading "Signed in" / "Sign-in failed"; body
"Pigment is now connected to your ChatGPT account." or "Pigment could not finish the sign-in: <reason
HTML-escaped>."; then "You can return to Pigment.". A failure other than `state_mismatch` ends the
attempt.

### 4.4 Manual completion, status, cancel

- `chatgptSignInStatus()` → `{ pending: true, url, warning? }` or `{ pending: false }`.
- `chatgptSignInManual({ callbackUrl })`: without an attempt → "Start "Sign in with ChatGPT" first, then
  paste the address the browser landed on" (`no_sign_in`); else the same `completeSignIn`. For a browser
  on another computer, where 127.0.0.1 is that other machine.
- `chatgptSignInCancel()` → ends the attempt with "Sign-in cancelled" (`cancelled`).
- Setting an OpenAI key or signing out of OpenAI also cancels the attempt.

### 4.5 ID token checks (`validateIdToken`)

Decode the JWT payload (no signature check: the token came over TLS from the token endpoint and is
never used as a credential). Errors (code `invalid_id_token`): unreadable → "The sign-in answer carried
no readable ID token"; `iss` ≠ `https://auth.openai.com` → "The ID token was not issued by
auth.openai.com"; `aud` (string or array) lacks the client id → "The ID token was issued for another
application"; `exp` missing or past → "The ID token has already expired"; nonce given and different →
"The ID token does not match this sign-in attempt".

### 4.6 The pending card (renderer)

While pending, the OpenAI card shows "Waiting for your browser… finish signing in to ChatGPT there, then
come back.", the port warning when there is one, buttons "Copy link" (copies the authorize URL; toasts
"Link copied; open it in any browser", or "The sign-in link is not ready yet") and "Cancel", then "Browser
on another computer? Paste the callback address here:", a field (placeholder "Paste the address of the
page the browser landed on") and "Use" (Enter presses it; an error toasts its message or "That address
did not work"). The card polls `chatgptSignInStatus` every 1.5 s and re-renders when the attempt ends.
On success: toast "Signed in with ChatGPT"; on failure other than cancel: the message or "Sign-in failed".

### 4.7 Token use and refresh

`accessToken({ force })`: the stored access token is used while `now < expiresAt − 300 s`. When stale:
if `earliestRefreshAt` is not reached and the token has not expired, keep using it; otherwise refresh.
`force` (after a 401) always refreshes.

Refresh (single-flight): no refresh token → clear the sign-in, "Your ChatGPT sign-in is no longer usable.
Sign in again." (`signed_out`). Otherwise `POST` the token URL with `grant_type=refresh_token`,
`refresh_token`, `client_id=<stored issued client id>`, `resource=https://api.openai.com/v1` (30 s).
- Fatal codes clear the sign-in and say "Your ChatGPT sign-in has expired. Sign in again.":
  `invalid_grant`, `invalid_client`, `invalid_refresh_token`, `refresh_token_expired`,
  `refresh_token_invalidated`, `refresh_token_reused`, `token_expired`.
- If the OpenAI entry was replaced or removed during the refresh (generation counter), the rotated tokens
  are dropped: "The ChatGPT sign-in was removed while its token was being refreshed" (`not_connected`).
- Tokens rotate: a new refresh token replaces the old; absent fields keep the previous values. A
  refreshed ID token is checked without a nonce; if it fails, it is dropped (the previous one is kept)
  and `ai: the refreshed ID token did not validate; keeping the previous one` is logged.

### 4.8 Which requests use the sign-in (the "plan route")

Every OpenAI `request()` while the method is `chatgpt` goes to the **same base**
`https://api.openai.com/v1` with `Authorization: Bearer <ChatGPT access token>`. For `POST /responses`
with a JSON body the body is reshaped (`reshapeForPlanRoute`):
- delete `background, conversation, max_output_tokens, max_tool_calls, metadata, moderation,
  multi_agent, prompt, prompt_cache_key, prompt_cache_options, prompt_cache_retention,
  safety_identifier, service_tier, temperature, top_logprobs, top_p, truncation, user`;
- `store: false`, `stream: true`;
- `input` items with role `system` or `developer` (type `message` or none) are removed and their text
  joined (blank line between) into `instructions` after any existing `instructions`;
- hosted tools `code_interpreter, file_search, image_generation, mcp, tool_search` are removed
  (function tools and `web_search` stay);
- an object `tool_choice` is deleted (strings stay).

The answer is SSE and is folded into the final `response` object (section 5.3). On a 401 the token is
refreshed once (`force`) and the request retried once. The model catalog on this route answers
`{ models: [{ slug }] }`. Image endpoints are never used with a sign-in (the features refuse first),
but if they were, the plan route answers `subscription_sharing_unsupported_capability`.

Nothing in the sources shows this flow verified against the live service; the unit tests drive it
against a fake token endpoint.

---

## 5. The request proxy (`ai.js request`)

### 5.1 Validation

- `provider` ∈ {`openai`, `gemini`}.
- `path` must start with `/` and not `//`; `BASES[provider] + path` must resolve under
  `BASES[provider] + '/'`; dot segments (`/./`, `/../`, also before `?#`), `%2e`, `%2f` and backslashes
  are refused: "The request path must stay inside the provider API" (`bad_request`). Without a leading
  slash: "The request path must start with /".
- `method` `GET` or `POST` (default `POST`), else "Only GET and POST requests are allowed".
- `json` object or `multipart` `{ fields: Record<string,string>, files: [{ field, name, type, base64 }] }`.
- `stream` boolean, `timeoutMs`.

### 5.2 Sending

Headers: `Accept: application/json, text/event-stream`; OpenAI `Authorization: Bearer <key or token>`;
Gemini `x-goog-api-key: <key>` (never in the URL). JSON bodies add `Content-Type: application/json` and
`stream: true` when streaming; multipart builds `FormData` (each file a `Blob` of the decoded base64 with
its type and name). Not connected → "<OpenAI|Gemini> is not connected. Open AI › AI Accounts… to sign in
or add an API key." (`not_connected`).

Timeouts: `timeoutMs` clamped to 1 s … 600 s (default 120 s), enforced with an `AbortController`;
expiry → "The <OpenAI|Gemini> request timed out" (`timeout`); network failure → "Could not reach
<OpenAI|Gemini>: <message>" (`network`). Callers pass: chat 180 s, image generate/edit 300 s, models and
key checks 30 s, token requests 30 s. **No retries** except the one 401 retry on the ChatGPT route.
**No cancellation** reaches the request: the IPC call cannot be aborted (section 7.1).

Result: `{ status, body }`; body = parsed JSON, `{ raw: text }` when not JSON, or the folded SSE
response when the content type is `text/event-stream` (or `stream` was asked and the text looks like
SSE: a line starting `data:`, `event:`, `id:` or `retry:` in the first 2000 characters).

### 5.3 SSE folding (`aggregateSse`)

Split on blank lines; join each block's `data:` lines; skip empty and `[DONE]`; parse JSON (skip
failures). `response.completed` or `response.incomplete` → keep `ev.response`; `response.failed` →
failure `ev.response.error`; `error` → failure `ev.error`; `response.output_text.delta` → append
`ev.delta`. A failure throws the translated error; otherwise the completed response; otherwise a
synthetic `{ object: 'response', output: [{ type: 'message', role: 'assistant', content: [{ type:
'output_text', text: <deltas> }] }], partial: true }`. (The renderer copy for the browser build is
simpler: it keeps `response.failed`'s `response` as the result.)

### 5.4 Error translation (`translateError(status, body)`)

- The error object is `body.error` when it is an object, else `body`. The code is the first string among
  `code`, `error`, `type`, `status`, `reason`.
- The message is `message` or `error_description` (or the body when it is a string).
- Plan-route codes replace the message:

| Code | Message |
|---|---|
| `subscription_sharing_user_not_eligible` | Your ChatGPT plan does not include use in third-party apps (a Plus or Pro plan is required). You can use an OpenAI API key instead. |
| `subscription_sharing_usage_limit_exceeded` | You have reached the usage limit of your ChatGPT plan. Try again later or use an OpenAI API key. |
| `subscription_sharing_usage_unavailable` | ChatGPT could not check the usage of your plan right now. Try again in a moment. |
| `subscription_sharing_route_not_supported` | This kind of request is not available through a ChatGPT plan. Use an OpenAI API key for it. |
| `subscription_sharing_unsupported_capability` | This capability (for example image generation) is not available through a ChatGPT plan. Use an OpenAI API key for it. |
| `subscription_sharing_invalid_user` | ChatGPT rejected this sign-in. Sign out and sign in with ChatGPT again. |

- Without a provider message, by status: 401 "The provider rejected the credentials (sign in again or
  check the API key)"; 403 "The provider refused this request"; 404 "The model or endpoint was not
  found"; 429 "Too many requests or the quota is exhausted; try again later"; ≥ 500 "The provider is
  having trouble; try again later"; else "Request failed (<status>)" or "Request failed".
- 429 without a code gets `rate_limited`.

The provider's own message is passed through unchanged (OpenAI's "Incorrect API key provided: sk-…abcd"
includes a masked fragment of the key; nothing is redacted).

---

## 6. Provider request builders (`providers.js`)

Images cross as base64 PNG (`canvas.toDataURL('image/png')`); answers decode from base64 (PNG, JPEG or
WebP; "The model returned an image that could not be decoded"). Resampling uses
`src/shared/pixels/transform.js resize` (bicubic by default, `area` for downscales, `bilinear` for masks).

Helpers used throughout:
- `downscale(canvas, maxEdge)`: long edge at most `maxEdge`, never up (area filter).
- `coverTo(canvas, w, h)`: scale to cover, centre-crop, never stretch.
- `padToAspect(image, mask, aspect, { fill })`: pad to the provider's aspect, centred
  (`x = floor((pw − w)/2)`); the image's padding is transparent (or `fill`); the mask's padding is
  transparent (= keep). Returns where the original sits.
- Masks in Pigment's convention: an alpha canvas, **alpha 255 = may change**.
  - `openaiMask`: RGB 0, alpha `255 − a` (OpenAI: alpha 0 = may change).
  - `whiteMask` (Gemini): opaque, grey = `a` (white = change, black = keep).
- `compositeThroughMask(original, answer, mask)`: per pixel `t = mask alpha / 255`; `t = 0` original,
  `t = 1` answer, else premultiplied blend (`oa = pa + (qa − pa)t`, colour `(p·pa(1−t) + q·qa·t)/oa`).
- `isOpaque(img)`: every alpha is 255.
- `keyWhiteBorder(img, { threshold: 232 })`: flood fill from all four borders over pixels whose R, G and B
  are all ≥ 232 (4-connected), set their alpha to 0; then every unkeyed pixel 4-adjacent to a keyed one
  whose `min(R,G,B) > 200` gets `alpha = alpha × (255 − min)/55` (fringe softening).

Sizes:
- OpenAI sizes: `gpt-image-*` (and anything not dall-e) `1024x1024`, `1536x1024`, `1024x1536`; `dall-e-3`
  `1024x1024`, `1792x1024`, `1024x1792`; `dall-e-2` `256x256`, `512x512`, `1024x1024`.
  `nearestOpenaiSize(w, h)`: smallest |log(aspect) − log(size aspect)|; among equal aspects (dall-e-2's
  squares) the smallest size whose long edge holds the image, else the largest.
- Gemini aspect ratios: `1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9`, nearest in log aspect.
- Gemini `imageSize` only for `gemini-3*` models: long edge > 2048 → `4K`, > 1024 → `2K`, else `1K`.
- Gemini `responseModalities`: `['IMAGE']` for `gemini-3*`, `['TEXT', 'IMAGE']` for older models.
- `gpt-image-1` and `gpt-image-1.5` (`/^gpt-image-1(\.5)?(-|$)/`) are the only models that get
  `background` and `input_fidelity`.

### 6.1 `generateImage({ provider, model, prompt, width, height, transparent })`

"No <label> image model is selected" without a model; "Enter a prompt" for an empty prompt. One image
per call (variations loop in the caller). Timeout 300 s.

OpenAI: `POST /images/generations`, JSON
```json
{ "model": "<model>", "prompt": "<prompt>", "n": 1, "size": "<nearest size>",
  "quality": "auto", "output_format": "png", "background": "transparent|auto" }
```
(`quality` and `output_format` for `gpt-image*`; `background` for gpt-image-1/1.5 only; any other model,
i.e. dall-e, gets `response_format: "b64_json"` instead). Answer: `data[0].b64_json`; a `data[0].url`
only → "The model returned a link instead of image data; choose a gpt-image model"; nothing → "The model
returned no image". Result: `coverTo(answer, width, height)`.

Gemini: `POST /models/{encodeURIComponent(model)}:generateContent`, JSON
```json
{ "contents": [{ "role": "user", "parts": [{ "text": "<prompt>" }] }],
  "generationConfig": { "responseModalities": ["IMAGE"] | ["TEXT","IMAGE"],
                        "imageConfig": { "aspectRatio": "<nearest>", "imageSize": "1K|2K|4K" } } }
```
With `transparent`, the text is the prompt + `\n\nRender the subject alone on a plain, pure white
(#ffffff) background with nothing else: no shadow, no floor, no frame.`; an opaque answer is then keyed
(`keyWhiteBorder`). The image is the first part with `inlineData` (or `inline_data`) `{ mimeType|mime_type,
data }`. Failure messages (`geminiImageFailure`): `promptFeedback.blockReason` → "Gemini blocked the
request (<reason>)"; text parts → "The model answered with text instead of an image: <first 300
chars>"; `finishReason` other than `STOP` → "The model returned no image (<reason>)"; else "The model
returned no image". Result: `coverTo`.

### 6.2 `editImage({ provider, model, image, mask?, prompt, transparent })`

Returns a canvas of the image's size. Steps:
1. `small = downscale(image, maxEdge)` (OpenAI 1536, Gemini 2048); the mask resampled bilinear to the
   same size.
2. OpenAI: `dall-e-3` refused ("dall-e-3 cannot edit images; choose a gpt-image model (or dall-e-2) for
   this feature"). `size = nearestOpenaiSize(small)`; pad image and mask to the size's aspect
   (transparent padding). `POST /images/edits`, multipart:
   - fields: `model`, `prompt`, `n: "1"`, `size`; for `gpt-image*` `output_format: png`,
     `quality: auto`; for gpt-image-1/1.5 also `input_fidelity: high` and `background:
     transparent|auto`; others `response_format: b64_json`;
   - files: `image[]` (`dall-e-2`: `image`) = `image.png` `image/png`; with a mask, `mask` = `mask.png`
     `image/png` (`openaiMask` of the padded mask).
   Answer as 6.1; resample to the padded size, crop the original's rectangle.
3. Gemini: nearest aspect; pad with **white** fill (mask padding transparent). Text: with a mask,
   `<prompt>\n\nEdit the first image. The second image is a mask: change only the white area of the first
   image and keep everything outside it exactly as it is. Answer with the whole edited image, same framing
   and size.`; without, the prompt. Parts: `[{ text }, { inline_data: { mime_type: 'image/png', data:
   <padded image> } }, { inline_data: { mime_type: 'image/png', data: <whiteMask> } }?]`;
   `generationConfig` as 6.1 with `imageSize` from the padded long edge. Same answer handling; resample
   to the padded size, crop.
4. Resample the answer to the original W × H; with a mask return
   `compositeThroughMask(image, answer, mask)` (untouched pixels stay exact), else the answer.

### 6.3 `chat({ provider, model, instructions, messages, tools, onToolCall, maxRounds = 8, shouldStop })`

`messages`: `{ role: 'user'|'assistant', text?, images?: dataUrl[] }[]`; `tools`: `{ name, description,
parameters }[]`; returns `{ text, calls: [{ name, args, result }], truncated }`. "No <label> chat model is
selected" without a model. Each round is one request (timeout 180 s). A tool error becomes `{ error:
message }` returned to the model, except code `stopped`, which aborts the loop. `shouldStop()` is checked
before every follow-up request ("Stopped by the user", code `stopped`). When the model still calls tools
after `maxRounds` rounds the loop ends with `truncated: true`.

OpenAI (`POST /responses`):
```json
{ "model": "<model>", "store": false, "instructions": "<instructions>",
  "input": [
    { "role": "user", "content": [ { "type": "input_text", "text": "…" },
                                    { "type": "input_image", "image_url": "data:image/png;base64,…", "detail": "auto" } ] },
    { "role": "assistant", "content": [ { "type": "output_text", "text": "…" } ] } ],
  "tools": [ { "type": "function", "name": "…", "description": "…", "parameters": { JSON schema }, "strict": false } ],
  "tool_choice": "auto" }
```
(an empty user message sends one empty `input_text`). Reading: `output[]`; the text is the concatenated
`output_text` parts of `message` items (else `output_text`); `function_call` items carry `call_id`,
`name`, `arguments` (JSON text; unparsable → `{ _raw }`). Next round: append the output items (messages
reduced to their `output_text`, function calls as `{ type: 'function_call', call_id, name, arguments }`,
reasoning items only if they have `encrypted_content`, which is never requested, so in practice they are
dropped), then one `{ type: 'function_call_output', call_id, output: <result as text: strings as is,
anything else JSON> }` per call. The whole history is resent each round. `res.error` → its message or "The
model request failed".

Gemini (`POST /models/{model}:generateContent`):
```json
{ "contents": [ { "role": "user", "parts": [ { "text": "…" }, { "inline_data": { "mime_type": "image/png", "data": "<base64>" } } ] },
                { "role": "model", "parts": [ { "text": "…" } ] } ],
  "systemInstruction": { "parts": [ { "text": "<instructions>" } ] },
  "tools": [ { "functionDeclarations": [ { "name": "…", "description": "…", "parameters": { … } } ] } ] }
```
Declarations go through `geminiDeclaration`: `cleanSchema` drops `$schema`, `additionalProperties`,
`default`, `examples`, `$id`, `strict`; `geminiSchema` gives every schema a `type`; an object without
properties and an untyped value become `{ type: 'string', description: '<desc> (an object, as a JSON
string)' }` / `'(any value, as a JSON string)'`; arrays get `items` (default string); a type array takes
its first non-null type; `required` is filtered to existing properties; a tool without properties
declares no `parameters`. Reading: `candidates[0].content.parts`; text = text parts that are not
`thought`; calls = parts with `functionCall { name, args }`. `promptFeedback.blockReason` → "Gemini
blocked the request (<reason>)". Next round: push the model turn verbatim (`{ role: 'model', parts }`,
thought signatures included), then `{ role: 'user', parts: [{ functionResponse: { name, response: {
result } } }…] }`.

### 6.4 `describeImage({ provider, model, image, prompt })`

`chat` with no tools and one user message: text = `prompt` or `Describe this image in detail: subject,
composition, colours, lighting, mood and any text it contains. Answer in plain prose.`, image =
`downscale(composite, min(maxEdge, 1024))` (so 1024 for both). Returns the trimmed text.

---

## 7. Shared feature plumbing (`features.js`)

### 7.1 Running a request: `aiTask(app, label, fn)`

- Shows a persistent info toast `<label>` with an action **Cancel**; status bar busy text and busy cursor
  through `app.busy(label, …, { gate: false })`. `gate: false` means **commands are not blocked**: the
  user can keep editing, saving and undoing while the request waits (test: hunt4-review-sessions).
- Cancel rejects at once with `{ code: 'cancelled' }`; the request keeps running (the bridge cannot abort
  it) and its late result is dropped. `fn` gets `state.cancelled` to stop between steps (between
  variations; after the subject request).
- The toast is removed when the task settles.

Labels: "Generative Fill…", "Generating <n> fills…", "Generative Expand…", "Generating image…",
"Removing background…", "Replacing background…", "Replacing sky…", "Describing image…".

### 7.2 Reporting: `reportAiError(app, err, context)`

Cancel says nothing. A connection problem (`code === 'not_connected'` or the message matches `/not
connected|sign in|api key/i`) toasts `<context>: <message>` (error, 8 s) with the action **AI
Accounts…**; anything else logs `console.error(context, err)` and toasts `<context>: <message>` (8 s).
Contexts: "Generative Fill failed", "Generative Expand failed", "Generate Image failed", "Remove Background
failed", "Replace Background failed", "Replace Sky failed", "Describe Image failed". Without `app.ai`:
"AI is not available in this build".

### 7.3 What is sent: the composite

`composite(d) = flattenDocument(d, d.view.compositor)`: the whole visible document (all visible layers,
effects, adjustments), 8-bit RGBA, document size. Fill, Expand, Replace Background and Replace Sky edit
the composite; Remove Background and the subject step of Replace Background send only the active layer
(`activePixels`: a raster layer's canvas with its enabled layer mask applied (`maskCanvasFor`,
destination-in), so masked-away pixels go out transparent; text, shape and smart layers rasterized).

### 7.4 Selection masks

`selectionMaskCanvas(doc, fullDocRect, feather = 1)`: the selection's coverage feathered with radius 1
(`selection-ops.js feather`: Gaussian sigma = radius/2 = 0.5, three extended-box passes) **as if the canvas
continued beyond its border** (`featherKeepingBorder`: pad by `ceil(r)·3 + 2` px replicating the edge, blur,
crop), so a selection touching the border keeps full coverage there. White, alpha = coverage, document
size.

### 7.5 Landing results: `addLayers(d, layers, label)`

One undoable `structural(app, label, …)` entry: the layers are inserted above the active layer (inside it
at the top when the active layer is a group; at the top of the root when there is no active layer), in
order, and the **last one becomes active**; then `app.setEditingMask(false)` (the target is the layer's
pixels, not a mask). The selection is left as it was.

`fillThroughMask(d, mask, region, { provider, model, prompt, variations, name }, state)`: crops the
composite and the mask to `region`; per variation (stopping early when cancelled) `editImage(src,
regionMask, prompt)`, then keeps only the masked pixels (destination-in with the region mask: answer
alpha × mask alpha) in a raster layer of the region's size at `(region.x, region.y)`, named `<name>` or,
with several variations, `<name> 1`, `<name> 2`, `<name> 3`.

---

## 8. The features

### 8.1 Generative Fill (`ai:generative-fill`)

Flow:
1. No document or empty selection → toast "Make a selection first" (error).
2. Dialog "Generative Fill", intro "Fills the selection with what you describe, taking the surrounding
   image into account.", prompt label "Describe what to generate" (prefill `lastFillPrompt`, default empty),
   provider/model (image), "Variations" slider 1-3 (default 1). OK "Generate". Saves `lastFillPrompt`.
   With arguments (actions replay, the Assistant): no dialog; provider by the dialog-less rule, model =
   `app.ai.model(provider, 'image')` ("No <label> image model is available" when none), variations 1.
3. Region (`fillRegion(selection bounds, docW, docH, 1536)`):
   ```
   side = max(bw, bh); size = ceil(side × 1.5)              // 25 % padding each side
   if size > 1536: size = max(side, 1536)
   w = max(bw, min(size, docW)); h = max(bh, min(size, docH))
   w = min(docW, max(w, min(h, docW))); h = min(docH, max(h, min(w, docH)))   // square-ish
   x = round(bx + bw/2 − w/2), y = round(by + bh/2 − h/2), clamped to [0, docW − w] / [0, docH − h]
   ```
   The region can exceed 1536 when the selection itself is larger; `editImage` downscales to the
   provider's edge anyway.
4. Mask = the feathered selection (7.4). `n = clamp(round(variations), 1, 3)`; one `editImage` per
   variation, sequential.
5. Result: `n` raster layers of the region size at the region's position, names "Generative Fill" or
   "Generative Fill 1…3", above the active layer, last one active; history entry **"Generative Fill"**.
   Returns the layer ids (used by the Assistant). The selection stays.

Request sent (OpenAI): `POST /images/edits` with the region crop of the composite (≤ 1536 px), the mask,
the prompt, `n 1`, the nearest size. Gemini: `generateContent` with the crop (≤ 2048 px, white-padded),
the white-on-black mask and the mask instruction. No reference images.

### 8.2 Generative Expand (`ai:generative-expand`)

1. Dialog "Generative Expand"; intro, when the composite already has transparent pixels: "Fills the
   transparent area around the image (enlarge the canvas further here if you like). Describe what should
   appear there, or leave a short hint such as "continue the scene"."; otherwise "Enlarges the canvas and
   fills the new area so the picture continues. Describe what should appear there, or leave a short hint
   such as "continue the scene"."
   Prompt label "Describe the expansion", prefill `lastExpandPrompt` or "Continue the image naturally into
   the empty area, matching its style, lighting and perspective.". Fields: "New width" (px, default and
   minimum = document width, max 30000), "New height" (same with height), "Keep the image" (anchor: Top
   left, Top, Top right, Left, Centre, Right, Bottom left, Bottom, Bottom right; default Centre).
2. If the size grew: run `image:canvas-size { width: W, height: H, anchor, color: null }` (a separate
   history entry "Canvas size", transparent extension even on an opaque Background).
3. Mask = the transparent area of the composite (alpha = 255 − composite alpha). None → undo the resize and
   toast "Nothing to expand: enter a larger size, or enlarge the canvas with a transparent extension (Image ›
   Canvas Size)" (6 s).
4. Region = the whole document; one variation; `editImage` downscales the whole canvas to 1536/2048.
5. Result: one document-size layer "Generative Expand" at 0,0, history **"Generative Expand"**.
6. Cancel, failure or no result → the resize is undone **if it is still the newest history entry**.

### 8.3 Generate Image (`ai:generate-image`)

1. Dialog "Generate Image", prompt "Describe the image" (prefill `lastGeneratePrompt`). Fields: "Place in"
   ("New layer (document size)" offered only with a document, default then; "New document" otherwise);
   "Width"/"Height" (px, 16-8192, default the document's size or the New Document preset or 1024; shown
   only for a new document); "Transparent background" checkbox (default off; hidden for `dall-e*` models;
   help "gpt-image models return real transparency; Gemini models are asked for a plain white background,
   which is keyed out afterwards.").
2. `generateImage` at the target size (document size for a layer).
3. Layer: a document-size raster layer named `Generated 1` (`nextLayerName(d, 'Generated')`: "Generated N"
   with the first free N) at 0,0, above the active layer, active; history **"Generate Image"**.
4. New document: `createDocument({ width, height, dpi: current document's dpi or 72, name: first 40
   characters of the prompt or "Generated image", background: 'transparent' })`, its first layer renamed
   "Generated", `meta.description = prompt`, added to the open documents, and the pixels drawn through a
   history entry **"Generate Image"** so the document is unsaved and the generation undoable.

### 8.4 AI Remove Background (`ai:remove-background`)

No dialog. Provider by the dialog-less rule, model `app.ai.model(provider, 'image')`; none → "Remove
Background failed: No <label> image model is available" with AI Accounts….
1. `activePixels` (7.3); none → "Select a layer with pixels".
2. `editImage(layer pixels, no mask, prompt "Remove the background. Keep the subject exactly as it is, with
   its edges intact, on a fully transparent background.", transparent: true)`. OpenAI gpt-image-1/1.5 send
   `background: transparent`; Gemini and other models answer opaque → `keyWhiteBorder`.
3. The answer's alpha placed at the layer's position becomes a document-size mask (white, alpha =
   subject alpha), intersected with the layer's existing enabled mask.
4. A copy of the layer named `<name> (no background)` gets `mask = { canvas, enabled: true, linked: true }`
   and is inserted directly above the original and made active; the original is **hidden, not removed**.
   One history group **"Remove Background"** (a structural "Remove Background" plus "Hide layer").
   Mask editing off.

Note: the Rust tree already has a classical `layer.removeBackground` (section 13.3).

### 8.5 Replace Background, which is Pigment's "Generate Background" (`ai:replace-background`)

1. Dialog "Replace Background", intro "The subject of the active layer is kept; everything around it is
   regenerated from your description.", prompt "Describe the new background" (prefill
   `lastBackgroundPrompt`). No extra fields.
2. Inside one task "Replacing background…": the subject mask exactly as Remove Background steps 1-3
   (first request), then its inverse (alpha 255 − a) as the mask over the whole document, one
   `fillThroughMask` (second request) on the composite.
3. Result: a document-size layer "Replace Background" holding only the regenerated surroundings, above the
   active layer; history **"Replace Background"**. The subject layer is untouched.

`docs/PARITY.md` lists this as Pigment's "Generate Background" (accepted approximation: no lighting or
shadow matching beyond the model's). There is no separate Generate Background command.

### 8.6 Replace Sky, which is Pigment's "Sky Replacement" (`ai:replace-sky`)

1. Dialog "Replace Sky", intro "The selection marks the sky." with a selection, else "The bright area at
   the top of the image is treated as the sky (make a selection to mark it yourself).", prompt "Describe the
   new sky" (prefill `lastSkyPrompt` or "A dramatic sunset sky with warm clouds").
2. Mask: the feathered selection, or `skyMask(composite)`:
   - sky pixel: alpha ≥ 8 and (blueish: `b ≥ r && b ≥ 0.92 g && lum > 90`, or bright: `lum > 190 &&
     max − min < 60`), `lum = 0.299 r + 0.587 g + 0.114 b`;
   - flood fill (4-connected) from every pixel of the top row;
   - fewer than 1 % of the pixels → none → toast "No sky was found at the top of the image; select the sky
     area and try again" (6 s);
   - the binary mask is padded by 8 px replicating its border, blurred with a 2 px CSS blur, cropped back
     (fully opaque at the canvas border).
3. Whole-document `fillThroughMask`, one layer "Replace Sky"; history **"Replace Sky"**.

None of Photoshop's Sky Replacement controls (sky presets, Shift Edge, Fade Edge, lighting) exist.

### 8.7 Describe Image (`ai:describe`)

No dialog. Provider by the dialog-less rule for `chat` (a ChatGPT sign-in works), model
`app.ai.model(provider, 'chat')`. `describeImage(composite)` under "Describing image…". Empty answer → "The
model returned no description". The result dialog "Describe Image" (width 560) has a read-only textarea
(10 rows, the text) and buttons "Copy", "Use as document description", "Close" (primary):
- Copy: clipboard text, toast "Description copied";
- Use: `doc.meta.description = text` with a history entry **"Document description"** (undo restores the
  previous one), toast "Saved as the document description (File › Document Properties)".

### 8.8 Anything else AI

- `app.aiFeatures.task(label, fn)` (the cancellable wrapper, used by tests) and `app.aiFeatures.*` as
  programmatic entry points.
- No other AI: Select Subject, Select Sky, Focus Area, Object Selection and Content-Aware Fill in the JS
  app are classical heuristics with no provider calls. Identify Font, Generative Upscale, generative
  layers, reference images and Content Credentials were only planned (`docs/PARITY.md`, package
  `generative-features`).

---

## 9. The Assistant

### 9.1 The panel (`lib/panels/assistant.js`)

Panel id `assistant`, title "Assistant", icon `sparkle`, bottom group, order 99. Opened from Window › AI
Assistant, AI › AI Assistant, or `ai:assistant` (which also focuses the input).

Layout, top to bottom:
- toolbar 1: "Provider" select (connected providers; preselects `chatProvider` if connected, else the
  Preferred provider, else the first; none → disabled "Not connected", and the model select disabled
  "Sign in or add an API key") and "Chat model" select (the provider's chat models, preselecting
  `<provider>Chat` or the default; "Loading…", "No chat models", "Could not list models: <message>").
  Changing them saves `chatProvider` / `<provider>Chat`.
- toolbar 2: checkbox "Attach image" (tooltip "Send a downscaled copy of the image with each message",
  default on, saved as `assistantAttach`), a person button ("AI Accounts…"), a trash button ("Clear the
  conversation").
- the message list (`role="log"`, `aria-live="polite"`), scrolled to the end on every render;
- the input: textarea (2 rows, auto-grows to 160 px), placeholder "Ask about the image or tell the
  assistant what to change… (Enter sends, Shift+Enter for a new line)"; Enter sends (not while composing
  IME text), Shift+Enter inserts a newline, Escape blurs, and no key reaches the app's shortcuts; a status
  line; "Stop" (hidden unless running) and "Send" (primary, tooltip "Send (Enter)").

Empty states: no document "Open a document to chat about it."; empty conversation "Ask about the image or
describe an edit, for example "make it black and white with more contrast" or "add a title at the top".".

Each message row: user messages show the attached image thumbnail (alt "Attached image", tooltip "The
image sent with this message"); assistant messages show one line per tool call (spinner while running,
warning icon on failure, check otherwise) with `describeCall` text, plus " — waiting for you to finish the
dialog" while a dialog the tool opened is up, and a tooltip with the error or the arguments as JSON (cut to
400 characters); then the text, or a spinner "Thinking…" while nothing has arrived; and an "AI Accounts…"
button when the failure was a connection problem.

Running: Send hidden, Stop shown, status "Working…"; pressing Stop disables it and shows "Stopping after
the current step…". Send with an empty input, no document or a running turn does nothing. If the send
returns `null` (nothing connected and the accounts dialog was closed) the typed text is put back. A thrown
error toasts its message (6 s), with "AI Accounts…" when it matches `/not connected|not available|model/i`.

The panel re-renders on `assistant:changed`, `doc:activated`, `doc:closed`; refills the provider select
on `ai:status`; re-reads the status when shown.

### 9.2 A turn (`app.assistant.send(text, { provider, model, attach })`)

1. Errors before sending: "Open a document first"; "The assistant is still working" (one turn at a time,
   app-wide); "AI is not available in this build"; no provider → `ensureConnected('chat')` (may open AI
   Accounts; still none → returns `null`); no model → "No <label> chat model is available"
   (`not_connected`).
2. Conversations are **per document, in memory only** (a `Map` by document id, dropped when the document
   closes, cleared by the trash button). At most **40 messages** are kept (older ones dropped).
3. The user message is stored with, when Attach image is on, `image = PNG data URL of the composite
   downscaled to a long edge of 1024`. A pending assistant message is added.
4. History sent: every stored message that is not pending and not an error, as `{ role, text }`; only the
   **last** message carries its image (earlier images are not resent).
5. `providers.chat({ provider, model, instructions: instructions(), messages, tools: TOOLS, maxRounds:
   12, shouldStop, onToolCall })`. Each tool call is recorded on the pending message (`{ name, args,
   result, pending }`) and the panel notified before and after.
6. Outcome text: stopped → "Stopped."; truncated → `<text>\n\n` (if any) + "Stopped after 12 tool steps;
   say "continue" to go on."; otherwise the model's text, or "Done." when it only called tools, or "(no
   answer)". An error sets `error` and shows the message; `not_connected` or "not connected" adds the AI
   Accounts button.

Stop: ends the turn at once (the in-flight request is raced against the stop signal and its answer dropped
when it comes; its tools never run); no further tool runs or requests (`shouldStop` and `onToolCall`
throw `stopped`). A request already sent is not withdrawn.

### 9.3 System prompt (`instructions()`), exactly

Paragraphs joined by a blank line:

1. `You are the assistant inside Pigment, a layer-based raster image editor (Photoshop-like). The user is
   editing the active document; a downscaled copy of its composite may be attached to the message.`
2. `Help with the image: answer questions about it and perform edits with the tools. Prefer the specific
   tools (apply_adjustment, apply_filter, select, crop, add_text, ...) over run_command. Every tool changes
   the document immediately and is undoable; call get_document when you need layer ids or the selection.
   Act without asking for confirmation unless the request is ambiguous. Keep answers short and say what you
   changed.`
3. `Edits apply to the active layer (image adjustments and filters are destructive on it); add a new layer
   first when the user wants a separate layer. Coordinates are document pixels with the origin at the top
   left.`
4. `Adjustment kinds (params with defaults): <list>.` where the list is, for every implemented adjustment
   kind, `kind (name=JSON default, …)` or `kind`, joined by `; ` (null defaults left out).
5. `Filter kinds (params with defaults): <list>.` the same for filter kinds.
6. `color-lookup presets: <LUT preset names, comma-separated>. match-color needs statistics of another image
   and is best left to its dialog.`
7. `Blend modes: <blend mode ids, comma-separated>.`
8. `Commands for run_command (ids; most take no argument): <ids>. Also image:adjust-<kind> (params object)
   and filter:<kind> (params object), which apply_adjustment and apply_filter wrap.` where ids are all
   registered command ids, sorted, without the blocked ones (9.5) and without `image:adjust-*` and
   `filter:*`.

The lists are generated from the JS registries (`pixels/adjust.js ADJUSTMENTS`, `pixels/filters.js
FILTERS`, `pixels/lut.js LUT_PRESET_NAMES`, `document.js BLEND_LABELS`, the command registry); in Rust
they must be generated from PhotoCraft's own registries (section 14).

### 9.4 Tools (`TOOLS`), parameters, and what each does

Same JSON schemas for both providers (Gemini's are converted, 6.3). A tool result is a string or JSON;
thrown errors go back as `{ error: message }`. Before each call: the document must still be the active one
("The document is no longer active"), the active tool's pending edit is committed, string arguments that
look like JSON are parsed.

| Tool | Description sent to the model | Parameters (required in bold) | Implementation | Result |
|---|---|---|---|---|
| `get_document` | Current document: size, layers (id, name, type, visible, opacity, blend, active) and the selection bounds. Call it before acting when unsure of ids. | none | reads the document | `{ name, width, height, dpi, activeLayer, layers: [{ id, name, type, visible, opacity (0-100), blend, active, parent (group id or null), mask?: true, text? (text layers) }], selection: bounds or null, description? }` |
| `set_active_layer` | Makes a layer active (the target of adjustments, filters and fills). | **`id`** string | `d.setActive` | `Active layer: <name> (<id>)` |
| `apply_adjustment` | Applies an image adjustment to the active layer pixels (destructive, undoable). kind is one of the adjustment kinds; params uses the listed parameter names. | **`kind`** string, `params` object | checks the kind and a raster/smart, unlocked active layer; params sanitized and clamped (9.5), merged over the kind's defaults; command `image:adjust-<kind>` with the params | `Applied <name> to "<layer>"` |
| `apply_filter` | Applies a filter to the active layer pixels. kind is one of the filter kinds; params uses the listed parameter names. | **`kind`** string, `params` object | as above with `filter:<kind>`; ranges = the shared filter table overridden by the filter dialog's own field ranges for that kind; defaults = the advertised defaults (not the last dialog run) | `Applied <name> to "<layer>"` |
| `run_command` | Runs a registered Pigment command by id with an optional argument (see the command list). | **`id`** string, `arg` (any: string, number, or object, may be JSON text) | refuses blocked ids; `valueArg` decodes JSON scalars/objects (unreadable JSON-looking text is an error); objects sanitized without ranges; `app.commands.run(id, arg, 'assistant')` | the command's result, or `ok` |
| `new_layer` | Adds an empty raster layer above the active one and makes it active. Returns its id. | `name` string | document-size raster layer, name trimmed to 80 or the next "Layer N"; structural entry "New layer" | `{ id, name }` |
| `set_layer_props` | Changes layer properties: opacity (0-100), blend mode, visible, name. | **`id`**, `opacity` number, `blend` string, `visible` boolean, `name` string | `null` means unchanged; opacity clamped 0-100 → 0-1; blend must be a known mode (`pass-through` only for groups); `visible` strings `false/0/no/off` are false; name trimmed to 80, empty refused; nothing to change refused; `setLayerProps` entry "Layer properties" | `Updated <name>: <keys>` |
| `select` | Changes the selection: kind 'all', 'none', 'inverse' or 'rect' (with rect in pixels). | **`kind`** enum `all, none, inverse, rect`; `rect` `{ x, y, width, height }` (all required) | `applySelection(…, 'replace', label)` with labels "Select all", "Deselect", "Inverse" (inverse of nothing selects all), "Rectangular selection" | `{ selection: bounds }` or `No selection` |
| `crop` | Crops the document to a rectangle (pixels). | **`rect`** | `image:crop-rect { rect, deletePixels: true, label: 'Crop' }` | `Cropped to W × H` |
| `resize_image` | Resamples the whole image to width × height pixels. | **`width`**, **`height`** | clamped 1-30000, rounded; `image:size { width, height, method: 'bicubic', scaleStyles: true }` | `Image is now W × H` |
| `canvas_size` | Changes the canvas size without scaling; anchor is one of nw, n, ne, w, c, e, sw, s, se (where the existing image stays). | **`width`**, **`height`**, `anchor` | clamped 1-30000; unknown anchor = `c`; an opaque Background extends with the background colour (like the dialog), else transparent; `image:canvas-size` | `Canvas is now W × H; the added area is filled with <colour>` / `… transparent` |
| `fill_selection` | Fills the selection (or the whole active layer when nothing is selected) with a colour (hex such as #ff8800 or a CSS colour name). | **`color`** | colour parsed (hex, rgb(a), any CSS name; unknown → "Unknown colour "<c>""); raster layer only ("Fill needs a raster layer"); alpha 0 clears (`edit:clear` inside a selection, else a pixels entry "Clear" on the whole layer; refused with locked transparency); else `edit:fill { use: 'color', color, opacity: alpha × 100, blend: 'normal', preserve: false }` | `Filled the selection with #rrggbb[ at N % opacity]` / `Cleared … to transparent` |
| `add_text` | Adds a text layer at (x, y) in pixels with a font size and colour. | **`text`**, `x`, `y`, `size`, `color` | text cut to 2000 (empty refused); defaults: size `max(12, round(H/12))`, x `round(W·0.1)`, y `round(H·0.1 + size)`, colour = foreground; clamps size 4-2000, x −W…2W, y −H…2H; structural "Add text" | `{ id, name }` |
| `generative_fill` | Fills the current selection with generated content from a prompt (needs a selection and an image model). | **`prompt`** | needs a selection ("Generative fill needs a selection: call select first"); `app.aiFeatures.generativeFill({ prompt })` (dialog-less, 1 variation, its own Cancel toast) | `{ layers: [ids] }`, or "Generative fill produced no layer (an image model may not be connected)" |

`describeCall` labels in the panel: "Read the document", "Selected layer <id>", "Applied <adjustment
name>", "Applied <filter name>", "Ran <id>", "New layer "<name>"", "Changed layer properties", "Selection:
<kind>", "Cropped", "Resized to W × H", "Canvas size W × H", "Filled with <colour>", "Added text "<first 30
chars>"", "Generative fill"; prefixed "Failed: " when the result is an error.

### 9.5 Guards and limits

- **Blocked commands** (`BLOCKED_COMMANDS`): `file:quit|close|close-all|revert|open|open-paths|open-recent|
  clear-recent|save|save-as|save-copy|export|export-quick|export-layers|place|import-image|print|reveal|
  new`, every `help:`, `ai:`, `window:`, `tool:`, `app:` command and `edit:preferences`. Error "Command
  "<id>" cannot be run by the assistant". Unknown → "Unknown command "<id>""; disabled → "Command "<id>" is
  not available right now".
- `needRaster`: no active pixel layer → "No active pixel layer: call set_active_layer or new_layer first";
  adjustment layer → "The active layer is an adjustment layer; activate a pixel layer"; other types → "The
  active layer is a <type> layer; run_command layer:rasterize first or activate a raster layer"; locked →
  "Layer "<name>" is locked".
- `findLayer`: "id must be a layer id string"; "No layer with id "<id>" (call get_document for the ids)".
- Numbers: "<name> must be a number". Rectangles are intersected with the canvas: non-positive size → "rect.width
  and rect.height must be positive"; outside → "rect lies outside the canvas (W × H)"; not an object →
  "rect must be { x, y, width, height }".
- `params`: an object or JSON text of one; unreadable text → "params must be a JSON object such as {"radius":
  4}; could not read: <first 80>"; arrays → "params must be an object".
- `sanitizeParams`: finite numbers (numeric strings converted when a range exists), clamped by the range
  table; booleans; strings cut to 200; nested objects/arrays to depth 4; anything else dropped.
- Adjustment ranges: brightness −150…150, contrast −100…100, exposure −20…20, offset −0.5…0.5, gamma
  0.01…9.99, vibrance/saturation/lightness/shadows/highlights −100…100, hue −180…180, colorizeHue 0…360,
  colorizeSat 0…100, colorizeLight −100…100, reds…magentas −200…300, density 0…100, levels 2…255, level
  1…255, radius 0…250, inBlack/inWhite/outBlack/outWhite 0…255. Filter fallbacks: radius 0.1…500, amount and
  angle −999…999, distance 1…2000, threshold 0…255, strength 0…10, amplitude 1…999, wavelength 2…999, ridges
  1…20, dx/dy −4000…4000, height 1…100, width 1…14, brightness 0…300, scale 1…9999, levels 2…256. (These are
  JS parameter names; section 14.)
- **A command that opens a dialog**: after starting it, wait 60 ms; if a dialog opened, mark the call
  "waiting" and wait for the user to finish it; result "The command opened a dialog; the user has closed it
  (completed or cancelled). Call get_document to see the current state." when the command returned nothing.
- Commands run with source `'assistant'` (the session/gesture layer treats this like code: e.g. `file:close
  { save: false }` from the assistant still asks).
- Rounds per turn 12; messages kept 40; attached image long edge 1024.

---

## 10. Consent, privacy and logging

- **No consent step.** There is no agreement checkbox or first-run prompt. The user guide's statement is the
  whole policy: "They are optional and off until you connect an account: nothing leaves your computer unless
  you run one of them, and then only the pixels and text that feature needs." Connecting an account is the
  implied consent.
- No background requests: the only automatic call is `status` (local). Model lists are fetched when a
  dialog, the accounts card or the panel shows them.
- What leaves the computer per feature: Fill the composite crop, mask and prompt; Expand the whole composite,
  its transparency mask and prompt; Generate the prompt; Remove Background the active layer's pixels;
  Replace Background the active layer then the composite; Replace Sky the composite and mask; Describe the
  composite (1024 px); Assistant the conversation text, the instructions, the tool results and, with Attach
  image, the composite (1024 px) with the latest message. OpenAI chat requests carry `store: false`; image
  requests carry no storage flag.
- Keys: only in the main process and the credential file (sealed with `safeStorage` where available); never
  sent to the renderer, never in URLs, documents or settings. The browser build keeps them plain in
  `localStorage`.
- Stored in plain text in settings: the last prompt of each feature (`lastFillPrompt` …), the model and
  provider choices, the host id. The new-document generation stores the prompt in the document's description.
- Logged (console): `ai status` warnings; `console.error(<context>, err)` for feature failures (the error
  message, never a key; provider messages can contain a masked key fragment); main-process warnings named in
  sections 3-4. Prompts, images and answers are never logged. The dispatch wrapper's rule: "no secrets ever
  appear in messages".

---

## 11. Error messages users see (by origin)

Main process (`ai.js`): "Unknown AI provider"; "Enter an API key"; "An API key contains no spaces; check what
you pasted"; "<OpenAI|Gemini> is not connected. Open AI › AI Accounts… to sign in or add an API key."; "The
request path must start with /"; "The request path must stay inside the provider API"; "Only GET and POST
requests are allowed"; "Bad request"; "Unknown AI method <m>"; "The <provider> request timed out"; "Could not
reach <provider>: <message>"; "Could not save the AI credentials: <message>"; all of 4.3-4.7; the 5.4 table
and status fallbacks.

Renderer providers: "No <label> chat model is selected"; "No <label> image model is selected"; "Enter a
prompt"; "No image to edit"; "dall-e-3 cannot edit images; choose a gpt-image model (or dall-e-2) for this
feature"; "The model returned a link instead of image data; choose a gpt-image model"; "The model returned no
image"; "The model returned no image (<reason>)"; "The model answered with text instead of an image: <text>";
"Gemini blocked the request (<reason>)"; "The model request failed"; "The model returned an image that could
not be decoded"; "Unknown AI provider "<p>"".

Features: "Make a selection first"; "Nothing to expand: …"; "No sky was found at the top of the image; select
the sky area and try again"; "Select a layer with pixels"; "No <label> image model is available"; "No <label>
chat model is available"; "The model returned no description"; "Choose a model (connect a provider with image
models in AI Accounts)"; "AI is not available in this build"; each prefixed by its context (7.2).

Accounts and panel: the strings of 3.1, 4.6 and 9.1. Browser build: "Sign in with ChatGPT needs the desktop
app; use an API key here"; "<OpenAI|Gemini> is not connected".

Assistant tools: section 9.5 and the table in 9.4.

---

## 12. Tests

Unit (`node --test`), `tests/unit/ai.test.mjs` (main process, fake `fetch`, fake `safeStorage` that seals
as `sealed:<value>`):

| Test | Covers |
|---|---|
| PKCE: S256 challenge of the verifier, URL-safe and unpadded | 4.2 |
| authorize URL carries the open flow parameters, the dynamic client and the host id | 4.2 step 6 |
| callback parsing accepts a URL, a path or a bare query and reads the issued client id | 4.3 |
| ID token claims: issuer, audience, expiry and nonce are checked | 4.5 |
| plan-route reshaping: store false, stream true, instructions from system messages, dropped params and tools | 4.8 |
| SSE aggregation returns the completed response and raises stream errors | 5.3 |
| error translation: provider bodies, subscription hints and HTTP fallbacks | 5.4 |
| model catalogs: API keys ({ data }), the plan route ({ models[].slug }) and Gemini | 3.4 |
| createAi: API keys are validated, sealed on disk, used for requests and listed in status; errors carry codes | 3.3, 5.1, 5.2 (incl. the path-escape cases and "keys never appear in URLs") |
| createAi: ChatGPT sign-in through the loopback callback, plan-route reshaping, SSE, refresh rotation and fatal errors | 4 |
| createAi: without safeStorage the status warns and values are stored plain | 3.3 |
| createAi: bug hunt 3 — safeStorage wiring, re-sealing, refresh races, rotated tokens, busy ports, stray errors, cancel during exchange, missing ID token | 3.3, 4 |
| createAi: review fixes — a fatal refresh after a new API key keeps the key; a cancelled attempt never ends the next sign-in | 4.7, 4.4 |

End to end (Playwright on the browser build, fake transport `window.__pigmentTest.ai` recording every payload
and returning canned bodies; no provider is ever called):

| File | Test | Feature |
|---|---|---|
| `tests/e2e/ai-core.spec.mjs` | OpenAI chat runs the tool loop: input items and function_call_output round trip | 6.3 |
| | Gemini chat runs the tool loop: parts, functionDeclarations and functionResponse | 6.3 |
| | editImage composites the answer only inside the mask (OpenAI multipart and Gemini parts) | 6.2 |
| | generateImage picks the nearest size and resamples the answer to the requested size | 6.1 |
| | the AI Accounts dialog opens from ai:accounts, shows both providers and app.ai reports what fits | 3 |
| `tests/e2e/ai-features.spec.mjs` | generative fill: a new layer holds the answer inside the selection, the request carried the mask and the prompt | 8.1 |
| | generative expand fills only the transparent band added by Canvas Size | 8.2 |
| | remove background turns a subject-on-white answer into a layer mask on a copy of the layer | 8.4 |
| | the assistant panel sends the image, runs a function call through history and shows the final text | 9 |
| | describe shows the text in a dialog and can store it as the document description | 8.7 |
| | not connected: the feature opens the AI Accounts dialog instead of failing | 3.5 |
| `tests/e2e/ai-features2.spec.mjs` | generative expand grows the canvas itself with a transparent extension when a larger size is entered | 8.2 |
| | a generated new document counts as unsaved, closing asks, and the generation is one undo step | 8.3 |
| | generate image keeps the proportions of the answer: cover and crop, never stretch | 6.1 |
| | generative fill keeps full coverage where the selection touches the canvas border | 7.4 |
| | DALL·E models get sizes and fields they accept; dall-e-3 is refused for edits | 6 |
| | the preferred provider decides for dialog-less features, whatever the last dialog used | 3.5 |
| | generate image with a transparent background on Gemini asks for white and keys it out | 6.1 |
| | Enter in an API key field connects and keeps the AI Accounts dialog open | 3.1 |
| | browser build: a rejected API key is not stored | 3.3 |
| | remove background keeps what an existing layer mask already hid | 8.4 |
| `tests/e2e/ai-assistant.spec.mjs` | Gemini gets typed declarations without empty objects, and JSON-string arguments are understood | 6.3, 9.4 |
| | Stop ends the turn: no further provider requests after the current step | 9.2 |
| | rectangles are intersected with the canvas; empty intersections are errors, not 1 px crops | 9.5 |
| | apply_filter uses the filter dialog ranges per kind (vignette size 0..1 darkens the corners) | 9.4 |
| | canvas_size extends an opaque Background with the background colour, like the dialog | 9.4 |
| | set_layer_props: null leaves a property unchanged; an empty name is refused | 9.4 |
| | fill_selection honours alpha: transparent clears, half alpha fills at 50 % | 9.4 |
| | the tool-round limit is reported instead of a silent "Done." | 9.2 |
| | a command that opens a dialog makes the tool wait for the user instead of running on behind it | 9.5 |
| | a message typed while nothing is connected survives a cancelled accounts dialog | 9.1 |
| `tests/e2e/ai-review.spec.mjs` | a failed Generative Expand takes its canvas resize back | 8.2 |
| | a feature dialog opens on the provider it was last used with | 3.5 |
| | assistant arguments: unreadable JSON params are an error, JSON scalars are decoded, null text fields use the defaults | 9.5 |
| | Stop ends the turn at once while a model request is still in flight | 9.2 |
| | the sky mask is fully opaque at the canvas border | 8.6 |
| | apply_filter starts from the advertised defaults, not the last dialog run | 9.4 |
| `tests/e2e/hunt4-review-sessions.spec.mjs` | Save, Undo and the panels keep working while an AI request is on its way | 7.1 |
| `tests/unit/hunt4-layers-automation.test.mjs` | (uses `ai:accounts` as an ignored step in recording) | 2.2 |

Not tested anywhere: the live providers, the live ChatGPT sign-in, Replace Background and Replace Sky end to
end (only the sky mask), Describe's Copy button, the Electron credential path in the packaged app.

---

## 13. Where each piece lands in the Rust tree (read-only survey)

### 13.1 What PhotoCraft already has

- **No HTTP client and no model runtime** in the workspace (`Cargo.toml`; `tokio` only in automation, CLI).
  No secret store. No AI command. `docs/gaps.md` G15 "AI and generative features" lists them missing.
- **Hooks waiting for generative fill**: `crates/ui-egui/src/tools/crop_task_bar.rs` ("Generative Expand goes
  here … (#41, #1199)"), `crates/ui-egui/src/panels/options_bar.rs` 654 (the Crop tool's Fill dropdown: "Generative
  Expand is not offered"), `crates/ui-egui/src/canvas/canvas_tool_menu.rs` 498 (the selection context menu: "Its
  Generative Fill row has no PhotoCraft command and is left out"). A reusable contextual task bar exists
  (`widgets::task_bar`, Window › Contextual Task Bar `window.panel.contextualTaskBar`).
- **Commands to build on** (engine ids, dotted): `select.all`, `select.deselect`, `select.inverse`,
  `select.rect`, `select.subject`, `select.sky` (classical, params `mode`, `sampleAllLayers`, `threshold`,
  `softness`), `image.canvasSize`, `image.imageSize`, `image.crop`, `edit.fill`, `edit.clear`,
  `layer.new.layer`, `layer.setProps`, `layer.select`, `layer.duplicate`, `layer.layerMask.*`,
  `layer.rasterize.*`, `type.create { x, y, text, size, … }`, `file.fileInfo { description, … }` (the
  document description; Pigment's "Document Properties"), and **`layer.removeBackground`** (classical: Select
  Subject plus edge refinement turned into a mask on the same layer, history "Remove Background", no menu item,
  in Properties › Quick Actions next to Select Subject; `crates/engine/src/cmd/cutout_cmds.rs`).
- **Engine patterns**: `CommandSpec { id, label, menu, shortcut, params (a human/agent-readable parameter
  string), enabled, run, journal }` in `crates/engine/src/cmd.rs`; `Session::edit(label, |doc, active| …)`
  is one undo step; `Layer::raster(doc.next_layer_name("…"), fmt)`, `layer_place::insert_new(doc,
  Some(anchor), layer, Place::Above)` and `*active = Some(id)` (see `apply_content_aware_fill` in
  `cmd/edit_menu_cmds/content_aware.rs`); `jobs::run(s, label, true, work, apply)` runs work on a worker
  against a document snapshot with progress and cancel and applies on the UI thread as one step, **but
  disables commands that edit that document while the job runs** (`crates/engine/src/jobs.rs` header).
- **Agents**: PhotoCraft already serves MCP (`photocraft-cli mcp`; tools `command_list`, `command_run`,
  `command_batch`, `doc_inspect`, `render_preview` …, `docs/mcp.md`) behind the suite's `AI-MCP` flag and the
  launcher's consent switch, via `craft-ai-agents`. The Assistant's tool layer can reuse the same command
  catalogue and inspection.
- Menus: `crates/ui-egui/src/menu_catalog.rs` is Photoshop's menu tree (Edit has Fill, Stroke, Content-Aware
  Fill; there is no AI menu). Opening URLs: the `open` crate (`apps/photocraft`); clipboard: `arboard`.

### 13.2 Reusable from Nib (`nib/crates/genai`, MIT OR Apache-2.0, same family)

Not a dependency (it depends on `vectorcraft-*` crates and its `ops` are vector features), but its
feature-independent modules are a near-direct template, written to follow Pigment's request shapes:
`provider.rs` + `provider/openai.rs` + `provider/gemini.rs` (OpenAI `/responses` text with `store: false`,
`/images/generations`, `/images/edits` multipart with `mask`; Gemini `generateContent` with
`responseModalities` and `imageConfig.aspectRatio`; the same preferred-model lists), `http.rs` (`ureq` 3 on
rustls/ring with the platform verifier, already in `Cargo.lock` through craft-update; 300 s default timeout, 20
s connect, 64 MiB cap, HTTPS only, no redirects, loopback HTTP only for tests), `error.rs` (`AiError { kind,
message, status }`, 14 kinds, key redaction), `keys.rs` (`keyring` 3.6 on macOS/Windows, a 0600 atomic
`ai-keys.json` on Linux; `ApiKey` with a redacted `Debug`), `cancel.rs`, `jobs.rs` (worker per job, mpsc,
waker), `image_util.rs` (bounded decode), `settings.rs` (consent flag, default provider, models, timeout;
no keys). Its UI (`crates/ui-egui/src/ai.rs`, `ai/accounts.rs`, `ai/generate.rs`) shows an egui AI Accounts
dialog with consent text and a non-modal Generate window. Its tests run a local `TcpListener` mock provider.
Nib has **no** ChatGPT sign-in, no chat with tools, no multi-turn conversation and no Assistant.

### 13.3 Reusable from the ArtCraft shared layer (`craft-ai-integrations`)

- `craft-ai-native`: secret stores (`KeychainStore` Windows/macOS/Secret Service, `EncryptedFileStore`
  Argon2id + XChaCha20-Poly1305, `EnvStore`, `LayeredStore`, `standard_store`), consent and history files.
- `craft-ai-core`: connections (`Auth::ApiKey`, `Auth::Subscription { route, secret }` "for example the Codex
  app-server"), capabilities (`image.generate`, `image.edit`, `image.inpaint`, `image.outpaint`,
  `image.matte`, `image.segment`, `text.complete` …), consent per capability with terms (this job, an hour, a
  day, until revoked) and a `Disclosure` naming destination and payload kinds.
- `craft-ai-openai`: `/chat/completions` (streaming, tools, structured output), `/images/generations`,
  `/images/edits` (edit/inpaint with mask and references). **Not** the Responses API, **no image input to
  chat** ("Not yet: … image input to chat (vision)"), no ChatGPT plan route.
- `craft-ai-gemini`: only `image.inpaint` through the **Interactions** endpoint (`/v1beta/interactions`), with
  its own fill instruction; no chat, no generate, no describe, no `generateContent`.
- `craft-ai-engine-rten`: local Remove background (BEN2 + ViTMatte) and SAM 2.1 on the processor, no key.
- `craft-ai-features`: feature ids `generative-fill`, `generative-expand`, `generate-image`,
  `remove-background`, `remove-object`, `select-subject`.
- `craft-ai-egui`: theme-neutral consent, picker, progress, connection-panel widgets (egui 0.37; an adopting
  app repeats a `[patch.crates-io]` recipe).
- `docs/LAYOUT.md`: "PhotoCraft's Select subject panel, Generate bar, `ai_cmds`, hover session" belong in
  `storytold/photocraft` (an upstream PR, `#10903`, used it for one Omni fill; not in this tree at `abb30df`).

---

## 14. What cannot be carried over as is, and why

1. **Electron `safeStorage` and the existing `ai-credentials.json`.** The file's `enc:` values are sealed by
   Chromium's OS-crypt through Electron (per-platform: macOS Keychain item, Windows DPAPI, Linux
   libsecret/kwallet or a fixed fallback). A Rust app cannot open them without reimplementing that per
   platform. Users re-enter their API keys and sign in with ChatGPT again; keys go to `keyring` /
   `craft-ai-native` (macOS, Windows) and a 0600 file or Secret Service on Linux. The non-secret `aiHostId`
   (Electron settings) can be carried over so the ChatGPT installation identity stays the same.
2. **The two-process split and IPC.** There is no renderer/main boundary; the "renderer never sees a secret"
   rule becomes a type rule (an `ApiKey`/`SecretString` that only the HTTP layer reads, redacted `Debug`, never
   serialized). The generic `request({ path, json })` proxy with path-escape checks is unnecessary when the
   provider code itself builds URLs; keep the base-URL rule (HTTPS, no redirects).
3. **Canvas 2D operations.** `toDataURL`, `drawImage` resampling, `destination-in`/`source-in` compositing,
   `ctx.filter = 'blur(2px)'`, and colour parsing through `fillStyle` (any CSS colour name) must be rewritten
   on PhotoCraft's surfaces, `image`/PNG encoding and its resampler; CSS colour names need a table.
4. **Pixel formats and colour modes.** JS sent 8-bit sRGB RGBA. PhotoCraft documents can be 16/32-bit,
   CMYK, Lab, Grayscale, indexed, with f32 surfaces; the composite must be converted to 8-bit sRGB for
   sending and the answer converted back to the document's mode and depth (and the layer's format with alpha).
5. **Non-blocking requests.** JS deliberately let the user keep editing, saving and undoing during a request
   (`app.busy(…, { gate: false })`). PhotoCraft's `jobs::run` disables editing commands on that document while
   a job runs. The network wait must run outside `jobs::run` (Nib's prepare / run on a worker / apply pattern),
   with the apply step deciding what to do if the document changed (JS simply added the layer to whatever the
   document then was).
6. **Cancellation.** JS could not abort an in-flight request either; Rust with a blocking `ureq` call has the
   same limit (Nib documents it). The behaviour carries over; the provider may still bill a cancelled request.
7. **History.** JS `structural` snapshots and `history.group` become `Session::edit(label)`; Remove
   Background's "copy + mask + hide original" (a group of two entries) must be one edit. History labels can be
   kept: "Generative Fill", "Generative Expand", "Generate Image", "Remove Background", "Replace Background",
   "Replace Sky", "Document description" (or the File Info edit's own label).
8. **Command ids and the name clash.** JS ids are `ai:*` (colon style). PhotoCraft uses dotted ids, and
   **`layer.removeBackground` already exists** with different behaviour (classical subject mask on the same
   layer, no provider). The AI version needs its own id (for example `ai.removeBackground`) and a decision on
   which one Properties › Quick Actions offers.
9. **The Assistant's tool layer.** Every tool maps to JS commands that do not exist in PhotoCraft
   (`image:adjust-<kind>`, `filter:<kind>`, `image:crop-rect`, `image:size`, `image:canvas-size`,
   `edit:fill`, `edit:clear`); the adjustment and filter kinds, their parameter names, defaults and the
   `ADJUST_RANGES`/`FILTER_RANGES` clamping tables are JS-specific. The system prompt's generated lists, the
   blocked-command regex and `run_command` must be rebuilt from PhotoCraft's `CommandSpec` registry (its `params`
   strings already document each command for agents, and `enabled` gives the "not available right now"
   reason). The "a command opened a dialog, wait 60 ms" trick depends on the JS dialog stack; PhotoCraft
   commands run with explicit params and should not open dialogs from the Assistant.
10. **Chat with tools and vision.** Neither shared crate covers it: `craft-ai-openai` has no Responses API and no
    image input to chat; `craft-ai-gemini` has no chat at all; Nib's text request has images but no tools and no
    turns. The OpenAI `/responses` and Gemini `generateContent` tool loops (6.3) must be written for Pigment (or
    contributed upstream).
11. **Sign in with ChatGPT.** Not in Nib and not in the shared layer (its `Auth::Subscription` is meant for an
    official route such as the Codex app-server, a different mechanism). The flow ports to Rust directly (PKCE,
    `std::net::TcpListener` on 127.0.0.1:1455-1460, the token endpoint, refresh rotation, plan-route reshaping,
    SSE folding), but it has never been verified against the live service in any source, depends on OpenAI
    accepting `dynamic_agent_client` with `agent_name_hint=Pigment`, and its access token goes to the Responses
    API on `api.openai.com/v1`, which the shared OpenAI adapter does not speak.
12. **Gemini through the shared layer differs.** Its fill uses the Interactions endpoint and its own instruction,
    not `generateContent` with Pigment's mask instruction; Generate Image, Describe and chat on Gemini have no
    shared adapter. Results from the two routes are not interchangeable without re-testing.
13. **Consent.** JS had none beyond connecting an account. Nib requires a one-time agreement; the shared layer
    asks per capability with terms. Adopting either adds a consent step (a visible behaviour change, and the
    right one for the PhotoCraft family). The consent text has to be written; Nib's is "I agree that the AI
    commands send my prompt and, where a feature needs it, the selected artwork, image or text to the provider I
    chose."
14. **The browser build path.** `localStorage` keys, direct `fetch` and the CSP `connect-src` have no place in a
    native app; Nib's crate is native-only and the PhotoCraft web (wasm) build would show no AI commands.
15. **Tests.** Playwright specs, DOM selectors and the `window.__pigmentTest.ai` fake transport do not port. The
    behaviours in section 12 need Rust tests: engine-level tests through a fake `Provider`, a local `TcpListener`
    mock server for request shapes (Nib's approach), and `egui_kittest` UI tests for the dialogs and the panel.
16. **The menu.** JS had its own top-level AI menu. PhotoCraft follows Photoshop's menu tree (Generative Fill
    under Edit and in the contextual task bar, Generative Expand in the Crop tool, Remove Background in Quick
    Actions, Sky Replacement under Edit). Nib dropped its AI menu for the same reason. Where each item goes is a
    product decision; the JS commands and their dialogs carry over, their placement does not.
17. **Actions and the journal.** JS recorded the dialog values and replays called the provider again (with cost).
    PhotoCraft's journal and actions record engine commands; whether AI commands are journaled, replayable, or
    refused in batch/MCP runs needs deciding.
18. **Prompts in settings.** JS kept the last prompt of every feature in plain text in settings; the Nib rule
    ("no prompt in logs", results kept in memory only) suggests not persisting them, or saying so.
19. **Model defaults.** The preference lists name models that may be renamed or retired (`gpt-5.5`,
    `gemini-3.1-flash-image` …); they are data to keep current, not behaviour.
20. **Heuristics with Rust equivalents.** The JS sky mask (`skyMask`) and white keying are small and portable,
    but PhotoCraft's classical `select.sky` (and the shared layer's local matting for Remove Background) are
    better candidates; changing the mask source changes results, so it is a choice, not a port.
