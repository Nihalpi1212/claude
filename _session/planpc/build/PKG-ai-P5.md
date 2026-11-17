# PKG ai-P5: Sign in with ChatGPT (experimental, chat models only)

Branch `claude/pigment-photocraft`. Four commits, all pushed:

- `8a526b7` Pigment: Sign in with ChatGPT in pigment-genai (experimental, chat models only)
- `9811c96` Pigment: Sign in with ChatGPT in AI Accounts and pigment-cli, marked experimental
- `fe3e942` Pigment: document Sign in with ChatGPT (experimental) and how to turn it off
- `3a4f755` Pigment: pigment-cli ai clear-key says when a ChatGPT sign-in remains

The contract is `pigment/docs/generative-ai.md` › "Sign in with ChatGPT (experimental)". Read that
first; this note is what the next engineer needs beyond it. With P5 the AI port's five packages
(INTEGRATION.md §7) are all built.

## What was built

### `crates/genai/src/chatgpt.rs` (new): the port of the JavaScript `src/main/ai.js`

- **Pure functions**, with the JavaScript unit tests as vectors: `base64url`, `pkce_challenge`,
  `create_pkce`, `random_token`, `new_host_id`, `build_authorize_url`, `redirect_uri_for`,
  `parse_callback`, `decode_jwt`, `validate_id_token`, `account_info`, `parse_refresh_at`,
  `reshape_for_plan_route`, `aggregate_sse`, `looks_like_sse`, `translate_error` (JS
  `translateError`, as `Translated {message, code, status}` with `into_error` for the kind) and
  `callback_page`. The constants are JS's `CHATGPT_AUTH`, `FATAL_TOKEN_ERRORS`,
  `PLAN_ROUTE_DROPPED_PARAMS` and `PLAN_ROUTE_DROPPED_TOOLS`.
- **`ChatGpt`** (shared as `Arc`): the attempt in progress, the stored tokens, their refresh.
  - `start(port, host_id) -> SignInStatus {pending, url, warning}`: binds 127.0.0.1 (the first
    free of 1455 to 1460; all busy: no listener and a warning), spawns the listener thread. One
    attempt at a time; it expires after five minutes (checked lazily, and by the listener).
  - `complete(&Callback)` and `complete_manual(pasted)`: the state check first (a mismatch leaves
    the attempt alive), then the code exchange (one at a time per attempt), the ID token checks,
    the store. `cancel()`, `status()`, `take_outcome()` (how the last attempt ended, once).
  - `access_token(stale, cancelled)`: the stored token, or a refresh. `stale` is a token the
    provider just refused (the 401 retry); a request that finds another already refreshed takes
    the new token. One refresh at a time (`refreshing` mutex).
  - `sign_out()`, `signed_in() -> Option<SignedIn {email, plan}>`, `generation()`,
    `enabled()`/`set_enabled`, `set_auth_base` (loopback only).
  - Test seams, `#[doc(hidden)]`: `set_ports`, `set_sign_in_timeout`, `advance_clock`.
- **The switch**: `chatgpt::ENABLED` (a constant), and `"chatgptSignIn": false` in `ai.json`
  (applied by `AiAccounts` on load and `reload`). Off: no row in AI Accounts, `start` and
  `access_token` refuse, a stored sign-in is ignored and kept.

### Other changes in `pigment-genai`

- `keys.rs`: `SecretStore` gains `get_secret`, `set_secret`, `clear_secret(account)` for one
  longer secret beside the keys (the tokens, account `openai-chatgpt`). `MemoryStore` and
  `FileStore` implement them (the file's `MAX_FILE` is now 384 KiB); the OS store goes through the
  new `keys::chunked` (pieces of 600 characters on Windows, one piece on macOS).
- `accounts.rs`: `Method {ApiKey, Chatgpt}`; `AccountStatus` gains `method`, `email`, `plan`;
  `AiAccounts::method`, `connected`, `sign_in(port)` (makes and saves `hostId`), `sign_out`,
  `chatgpt()`. `set_key(OpenAi)` drops the sign-in; `default_provider` counts a sign-in as
  connected; `provider(OpenAi)` builds the signed-in provider when there is no key; the catalog
  cache is tied to the credential (`ChatGpt::generation`). The store is now an `Arc`.
- `settings.rs`: `chatgpt_sign_in` (default true) and `host_id`.
- `provider/openai.rs`: `Auth {Key, SignIn}`. `plan_call` sends with the access token, retries
  once after a 401 with a refreshed token, folds an event stream; `chat` reshapes the body for
  the plan route; image requests are refused unsent with a sign-in.
- `provider.rs`: `build_signed_in`, `subscription_hint`, `translate_error_for(.., sign_in)` (a
  rejected credential is "the ChatGPT sign-in", not "the API key"), and **`scrub`**: an answer's
  body has the credential taken out before anything reads it. `check` now does this for API keys
  too (a key cut in two by a message clipped to 300 characters would have slipped past
  `redact`).
- `http.rs`: `Body::Form`, `Response::content_type`, `Body: Clone`.
- `backend.rs`: `image_capable` is true only for an API key.
- `Cargo.toml`: `sha2`, `getrandom`, `chrono` (all in `Cargo.lock` already).

### Interface: `crates/ui-egui/src/ai_ui/accounts.rs` (and two fields in `ai_ui.rs`)

- OpenAI's tab: **Sign in with ChatGPT** with an "Experimental" label and a line saying what it
  covers and that it may stop working; the waiting card (Copy Link, Cancel, the paste field with
  Use, the ports warning); signed in: "Signed in with ChatGPT · e-mail · plan access not
  granted", Sign Out, "Needs an API key" in the Image model field.
- Public functions (the tests drive them): `sign_in_offered`, `sign_in_status`, `start_sign_in`,
  `cancel_sign_in`, `set_pasted_address`, `use_pasted_address`, `sign_out`.
- `poll_sign_in` (from `accounts::poll`, every frame, also with the dialog closed, only while an
  attempt started here is unheard of: `AiUi::sign_in_watch`) takes the outcome, re-reads the
  status (so the Assistant and Describe see the account at once) and says it in the dialog or
  the status bar.
- The acts `SignIn`, `SignInCopy`, `SignInUse`, `SignInCancel`, `SignOut` are dropped for
  synthetic input by the existing default-deny filter.
- The sign-in address is opened with `services.open_url` (else `ctx.open_url`), not through
  `links::open`, which would write it to the status bar.
- Nothing else in the interface changed: the Assistant, Describe and the Generate window already
  asked by kind of model (P4's "For P5" held).

### Command line: `apps/photocraft-cli/src/ai.rs`

`ai sign-in [--port N]` (prints the address, waits for the callback or an address pasted on
standard input), `ai sign-out`; `ai status` and `ai test` name the sign-in; `ai clear-key openai`
says when a sign-in remains.

## Hooks into upstream files

**None new.** The one upstream file touched is `apps/photocraft-cli/tests/it/man_and_completions.rs`,
whose existing Pigment line (the `ai*` man pages) gains `ai-sign-in` and `ai-sign-out`; FORK.md's
row for it already says "the man pages `ai` and its subcommands add". FORK.md › Generative AI now
also says that the sign-in added no hook, and how to turn it off at a merge.

## Decisions taken here (all in docs/generative-ai.md)

- **Tokens in the key store**, account `openai-chatgpt`, one JSON text; chunked on Windows.
  The ID token is kept (JS kept it; nothing reads it afterwards).
- **A key and a sign-in exclude each other** (JS). The key field stays visible while signed in;
  Connect replaces the sign-in. With a key connected the sign-in button is hidden (JS).
- **Two switches**: the constant, and `chatgptSignIn` in `ai.json`, so the off path is tested at
  run time and the owner can ship a fix by a settings change or a one-line build.
- **`hostId` in `ai.json`** (JS `aiHostId` in the settings).
- **Kinds for the interface**: an expired or refused sign-in is `invalidKey`, a removed one
  `missingKey`; both make the windows offer Open AI Accounts….
- **`ai.status` does not report the e-mail address** (agents don't need whose account it is);
  `pigment-cli ai status` does (`method`, `email`, `plan`).
- **Cross-process**: a refresh also yields when the stored record changed under it (another
  Pigment process), not only on the in-process generation count.
- **CLI sign-in is new** (JS had no command line); it keeps `pigment-cli ai` complete as the
  command line's AI Accounts.
- **Not ported**: JS's generic `request` proxy and its path checks (only the providers build
  requests here), safeStorage sealing and re-sealing (the OS store or the 0600 file instead), and
  `serializeAiError` (no IPC).

## Tests

All against a mock on 127.0.0.1; nothing reaches auth.openai.com or api.openai.com.

- `crates/genai/tests/genai/chatgpt.rs` (new), 33 tests:
  - the JavaScript `ai.test.mjs` test for test (13 JS tests as 22 here: the long flow tests
    are split per case): PKCE; the authorize URL; callback parsing; ID token claims; account info
    and `earliest_refresh_at`; plan-route reshaping; SSE aggregation; error translation; model
    catalogs and the callback page; the loopback sign-in; the plan route with the 401 retry,
    rotation and a fatal refresh; the pasted address and Cancel; API keys beside a sign-in; the
    private key file; a refresh after Sign Out; rotated tokens with a bad refreshed ID token;
    busy ports; a stray error; Cancel during the exchange; a missing ID token; a fatal refresh
    after a new key; a cancelled attempt and the next sign-in.
  - added: the off switch; images never; key and sign-in exclude each other; a refused token is
    refreshed once; requests at once share one refresh; `earliest_refresh_at`; secrets never in
    messages (errors, and a successful answer that quotes the token); the attempt's timeout; the
    Assistant's tool rounds on the plan route; the chunked store.
  - `tests/genai/common.rs`: `Reply::sse`, `Reply.content_type`, `Got::fields`, `query`, `http_get`.
- `crates/ui-egui/tests/it/ai.rs`, 3 new kittest tests: the sign-in from AI Accounts (the test
  plays the browser; the e-mail shows, the tokens and the address show nowhere, `ai.status`
  says chat only, Sign Out); the pasted address, and an agent's clicks that neither start, cancel
  nor sign out; the Assistant and Describe on the plan route with image features asking for a
  key, and a sign-in that completes with the dialog closed. `PIGMENT_AI_EVIDENCE_DIR=<folder>`
  makes the first save three PNGs of the dialog.
- `apps/photocraft-cli/tests/it/ai.rs`, 1 new: `ai sign-in` through the callback and through a
  pasted address, status, test, clear-key, sign-out.

Results on the final tree (`3a4f755`), unless noted:

- `cargo test -p pigment-genai`: 2 unit and 75 integration pass, 1 ignored (the real OS keychain).
  `cargo nextest run --profile ci -p pigment-genai`, three times: 77 pass each.
- `cargo test -p photocraft-ui-egui --test it`: 357 pass, 1 ignored (80 match `ai`).
- `cargo test -p photocraft-ui-egui --lib -- ai_ui menus canvas_tool_menu parity shortcut palette
  agents jobs_ui control::tests native_menu`: 629 pass.
- `cargo test -p photocraft-cli --lib --test it`: 7 and 88 pass (on `9811c96`; after the
  clear-key hint, `--test it -- ai`: 10 pass).
- `cargo test -p photocraft-automation --lib -- genai`: 1 pass.
- `cargo clippy -p pigment-genai -p photocraft-ui-egui -p photocraft-cli -p photocraft-automation
  --all-targets -- -D warnings`: clean. `cargo fmt --all -- --check`: clean.
- `cargo check --target wasm32-unknown-unknown -p photocraft-ui-egui -p pigment-genai`: compiles
  (upstream's own warnings only).
- `cargo xtask layers`, `panel-commands`, `scorecard --check`: pass. `scripts/pigment-rebrand.py
  --check` and `cargo metadata --locked`: clean.
- With `chatgpt::ENABLED = false`: `cargo test -p pigment-genai` and clippy still pass (the flow
  tests return early). The interface and CLI tests return early too (by reading; not run with
  the constant off).
- The OS credential store module (`keys::os`, macOS and Windows only) was type-checked and
  linted here against a stub `keyring` with the same four calls. Not compiled against the real
  crate: no cross toolchain.
- Mutations, each caught: `image_capable` back to `connected`; no state check; no "replaced
  while refreshing" check; no scrub; no nonce check; no re-check after waiting for the refresh
  lock; synthetic input allowed to sign in and out; the sign-in address in the status bar.
- Not run: the whole workspace suite, the engine's `panic_hunt` (no engine command added or
  changed), `cargo test -p xtask` (no crate, preference or panel command added). CI runs them.

## CI

Pigment CI is green on both heads it ran: run 44187841757 on `8a526b7` (the crate) and run
44193673928 on `3a4f755` (the final head: fmt, workspace clippy, every test under nextest, the
panic hunt, doctests, the repository checks, packaging tests, the CLI smoke test). The run on
`fe3e942` was superseded by the next push (cancelled while pending). The "exit code 100"
annotation on each run is the non-gating "Known upstream test failures" step. If a later run is
red on `bridge_token::the_bridge_authenticates_to_the_headless_server_by_challenge`, that is the
known flaky upstream test (PKG-ai-review123.md): re-run the job.

## Not done

- **Never checked against the live service** (no account, no keys here; decision 10). The
  browser hand-off, the page in a real browser, OpenAI's real answers and whether the flow still
  exists are unverified. This is why it is marked experimental.
- **macOS Keychain and Windows Credential Manager**: the chunked sign-in store was not run with
  a real store, nor compiled against the real `keyring` here (see above). The Pigment CI job is
  Linux only; the release workflow's macOS and Windows builds are the first real compile.
- **The release notes and the README still say the generative AI is not in 0.5.0**
  (`docs/RELEASE-NOTES-0.5.0.md` lines 37 and 233). Decision 9 wants them to say that keys and
  the ChatGPT sign-in are entered again. Left for the docs and release task, as P1 to P4 did.
- **No i18n rows**: the new strings are English through `tl!` (as P3 and P4).
- **No revocation at OpenAI on Sign Out** (as in JS).
- **`pigment-cli ai sign-in` does not open the browser** (it prints the address), and on
  Windows a blocked standard-input read keeps its reader thread until the process exits (it
  exits right after).
- **The model fields are still text fields** (the review's note); with a sign-in, Use Suggested
  works after Test Connection, which lists the plan's models.
- **Stop does not abort a request in flight** (the review's note, unchanged). On the plan route
  the answer is a stream, so Stop is noticed at the next chunk.
- **A sign-in with `plan: false`** is stored and shown ("plan access not granted"); requests
  then fail with the plan route's own message. JS did the same.

## For the next package (review, docs, release)

- **To turn the feature off**: `pub const ENABLED: bool = false;` in
  `crates/genai/src/chatgpt.rs`, or `"chatgptSignIn": false` in a user's `ai.json`.
- **Release notes**: say that AI is in 0.5.0, that keys and the ChatGPT sign-in are not migrated
  from the Electron app, that Sign in with ChatGPT is experimental and for chat models only, and
  where the tokens are kept (the OS credential store; on Linux the 0600 `ai-keys.json`, not
  encrypted).
- **A manual check worth doing before release**, with a real ChatGPT Plus or Pro account: Edit ›
  AI Accounts › Sign in with ChatGPT, then Window › Assistant and Image › Describe Image; then
  the same with ports 1455 to 1460 busy (the paste field); then `pigment-cli ai sign-in`.
  `PIGMENT_AI_AUTH_URL_CHATGPT` and `PIGMENT_AI_BASE_URL_OPENAI` point both at a local mock.
- **For a review**: the riskiest parts are (1) `ChatGpt::refresh` and `complete` (locks: `inner`
  is never held across HTTP; the order is `exchanging` → `inner` → `result`, `refreshing` →
  `inner`); (2) `keys::chunked` on Windows (untested there); (3) `provider::scrub`, which now
  runs on every provider answer, API keys included (a `String::from_utf8` and a `contains` per
  secret over the body).
- **`AccountStatus` gained three fields** and `SecretStore` three methods: anything outside the
  tree that implements `SecretStore` must add them.
- The engine was not touched, so the interface did not need the ten-minute engine rebuild. A
  `cargo check` without `CRAFT_FONTS_DIR` set re-runs `photocraft-text`'s build script and makes
  the next test build rebuild everything above it: keep the variables set for every cargo call.
