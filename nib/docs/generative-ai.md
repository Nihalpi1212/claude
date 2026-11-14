# Generative AI

> **Last updated:** 2026-11-14 · **Change:** major (first version: the `nib-genai` crate, its providers, key storage, the six operations and their tests; the UI, control-protocol and MCP surface specified for the next step).

Nib's generative features run with **the user's own OpenAI or Google Gemini API key**, called
directly from the user's machine. Nib has no server, no account, no proxy and no telemetry in
between: a request goes from the app to the provider the person chose, and nowhere else.

The reference app's equivalents (gap G18 in [gaps.md](gaps.md#g18-generative-ai-features)) run on
its vendor's cloud models; Nib's are a pluggable provider layer. Everything here is Nib's own design
and wording.

Code: [`crates/genai`](../crates/genai) (package `nib-genai`, layer L6 beside `ui-egui` and `mcp`,
native only). Tests: `crates/genai/tests/genai/` (one test binary, a local mock HTTP server, no real
network).

## Features

| Feature | Works on | Asks the provider for | Places, as one undo step |
|---|---|---|---|
| **Text to Vector Graphic** | nothing, or a selection (its bounds are the area) | an SVG (Vector method) or a PNG to trace (Image + Trace) | a group, fitted (contain) into the selection's bounds, else the active artboard less a 10% margin |
| **Generative Recolor** | the selected art | palettes as strict JSON | `recolor.apply` with the art's colour rows mapped to the chosen palette |
| **Generative Shape Fill** | one selected closed path or compound path | full-bleed art with the shape's aspect (and colours) | a clip group: the art, fitted to cover the shape, clipped by it, in the shape's place |
| **Generative Pattern** | nothing, or objects to fill | one seamless tile | a new pattern swatch (`AI Pattern: …`); with *apply to selection*, the selection filled with it |
| **Generative Expand** | one selected placed raster image | an image edit through a mask | the image replaced by a larger one, same stacking position, original pixels kept exactly |
| **Rewrite Text** | one selected type object | the text rewritten in a tone, as JSON | `text.editRange` with the new text, each styled run kept where the run count allows |

Options per feature (all are fields of the request, see [Requests](#requests)):

* **Text to Vector Graphic**: `prompt`; `kind` = `subject` (one subject, no background) | `scene` |
  `icon` | `pattern`; `detail` = `low` | `medium` | `high`; `method` = `svg` | `imageTrace`;
  `variations` 1–4; `palette` (`#rrggbb` list); `styleReference` (the selection rendered to PNG goes
  with the request; the selection must exist).
* **Generative Recolor**: `prompt`; `samples` (sample prompts the person picked); `variations` 1–4
  (palettes).
* **Generative Shape Fill**: `prompt`, `detail`, `method`, `variations`, `useShapeColors` (the
  shape's colours go as the palette when it has two or more), `palette`.
* **Generative Pattern**: `prompt`, `detail`, `method`, `variations`, `palette`, `tileSize` (points,
  4–4000, default 100), `applyToSelection`.
* **Generative Expand**: `prompt` (what goes in the new area, optional); `margins` = points to add
  `[left, top, right, bottom]`; or `fillArtboard` (grow to cover the artboard the image lies on;
  unrotated images only).
* **Rewrite Text**: `tone` = `shorter` | `longer` | `formal` | `casual` | `fixSpelling` |
  `{"custom": "instruction"}`; `variations` 1–4.

### Methods for vector art

* **Vector (SVG)** (default): the text model is told to answer with one standalone SVG of a given
  viewBox, using only basic shapes, paths and gradients. The answer is extracted (models add prose
  or Markdown fences), **sanitized** ([below](#svg-sanitizer)) and imported through Nib's own SVG
  importer (`clipboard.importSvg` + `edit.pasteInPlace`; the person's clipboard is put back).
* **Image + Trace**: the image model paints a flat-colour PNG (transparent or plain white
  background for subjects and icons); it is placed and traced with **Image Trace**
  (`imageTrace.makeAndExpand`), preset by kind and detail:

  | | low | medium | high |
  |---|---|---|---|
  | icon, pattern | 3 Colors | 6 Colors | 16 Colors |
  | subject | 6 Colors | 16 Colors | Low Fidelity Photo |
  | scene | 16 Colors | Low Fidelity Photo | High Fidelity Photo |

  Subjects and icons trace with `ignoreWhite`. Images over 1024 px a side are scaled down first.

## Architecture

```
UI thread                                    worker thread (one per job)
─────────                                    ───────────────────────────
dialog ─▶ GenAi::start(session, request)
            ├─ consent? key? (fail fast)
            ├─ ops::prepare(session) ─▶ Prepared (owns its data: bounds, PNGs, runs, colour rows)
            └─ Jobs::spawn ───────────────────▶ ops::run(prepared, provider, cancel)
                                                  ├─ build request(s)
each frame: GenAi::poll() ◀── mpsc + waker ─────  ├─ Provider::{generate_text, generate_image, edit_image}
  └─ JobEvent { info, result }                    └─ sanitize / parse / compose ─▶ Generated (1–4 variations)
show variations (Generated::preview)
person picks one ─▶ GenAi::apply(session, job, i)
                      └─ ops::apply: one undo step of ordinary engine commands
```

* **prepare** reads the document on the UI thread and changes nothing in it (a style reference is
  rendered through `edit.copy` and `Session::clipboard_png`, with the clipboard restored).
* **run** has no `Session`: it only sees the `Prepared` data, so the document can change while it
  runs. `apply` re-checks what it relies on (the shape still exists, the image still has the same
  pixels, the text is still the original) and refuses rather than overwrite a newer edit.
* **apply** runs inside `Session::begin_named_undo_group(feature label)` … `end_undo_group(failed)`
  (or joins an open undo group through `begin_undo_scope`), so the result is **one undo step** named
  after the feature, every edit is an ordinary journaled command, and a failure part-way rolls the
  step back. A result may be applied again (another variation, after Undo): each apply is its own
  step. Results belong to the document they were prepared in.

### Provider abstraction

```rust
pub trait Provider: Send + Sync {
    fn kind(&self) -> ProviderKind;                 // OpenAi | Gemini
    fn config(&self) -> &ProviderConfig;            // base URL, models, timeout, size cap
    fn generate_text(&self, &TextRequest, &CancelToken) -> Result<String>;     // text or strict JSON
    fn generate_image(&self, &ImageRequest, &CancelToken) -> Result<ImageData>; // prompt (+ reference images)
    fn edit_image(&self, &EditRequest, &CancelToken) -> Result<ImageData>;      // image + mask
    fn list_models(&self, &CancelToken) -> Result<Vec<ModelInfo>>;            // also the connection test
}
```

| | OpenAI | Google Gemini |
|---|---|---|
| Base URL | `https://api.openai.com/v1` | `https://generativelanguage.googleapis.com/v1beta` |
| Auth | `Authorization: Bearer <key>` | `x-goog-api-key: <key>` (never `?key=` in the URL) |
| Text / JSON | `POST /responses` (`store: false`; JSON as `text.format = json_object`) | `POST /models/{model}:generateContent` (JSON as `responseMimeType: application/json`) |
| Image | `POST /images/generations` (`gpt-image-*`: `output_format png`, `quality auto`, `background transparent/auto`; `dall-e-*`: `response_format b64_json`); with style references `POST /images/edits` with `image[]` | generateContent with `responseModalities` (`TEXT, IMAGE`; `IMAGE` for gemini-3) and `imageConfig.aspectRatio`; references as `inline_data` parts |
| Edit with mask | `POST /images/edits` multipart: `image[]`, `mask` (alpha 0 = may change), `input_fidelity high` | generateContent with the image, a white-on-black mask image and an instruction to change only the white area |
| Sizes | gpt-image: 1024², 1536×1024, 1024×1536 (nearest in shape); dall-e-3: 1792 shapes | aspect ratios 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9 |
| Models | `GET /models` | `GET /models?pageSize=200` |
| Default text model | `gpt-5.1` | `gemini-2.5-flash` |
| Default image model | `gpt-image-1` | `gemini-2.5-flash-image` |

Models are configurable per provider (`AiAccounts::set_models`); after a connection test the UI can
offer the catalog and preselect with `provider::pick_model` (preference lists in
`ProviderKind::preferred_models`, the same ones Pigment uses). Request shapes, model choices and
error translation follow the proven ones in the sibling app Pigment (`pigment/src/main/ai.js`,
`pigment/src/renderer/lib/ai/providers.js`).

### HTTP

`ureq` 3 on rustls (ring) with the OS trust store (`rustls-platform-verifier`), the same feature
set craft-update used, so nothing new enters `Cargo.lock` for it. Per request:

* **Timeout**: the whole request, default 300 s (AI Accounts setting, 10–600 s); connect at most 20 s.
* **Size cap**: answers over 64 MiB (`max_response_bytes`) are refused while reading.
* **Cancellation**: checked before sending and between 64 KiB chunks of the answer, and between
  variations; a job reports *cancelled* at once and its late result is dropped.
* **HTTPS only**, no redirects (a redirect would carry the key elsewhere), the proxy from the
  environment. Loopback URLs (`127.0.0.1`, `localhost`, `[::1]`) are the one exception: plain HTTP,
  no proxy. They exist for the tests and a local gateway, and can only be set with
  `AiAccounts::set_base_url` or `NIB_AI_BASE_URL_OPENAI` / `NIB_AI_BASE_URL_GEMINI`, which refuse any
  non-loopback address.
* `User-Agent: Nib/<version>`, nothing about the person.

### Errors

Every failure is an `AiError { kind, message, status }` with a message a person can act on. Kinds
(`ErrorKind::id()` is the wire id):

| Kind | When | UI action |
|---|---|---|
| `missingKey` | no key for the provider | open AI Accounts |
| `invalidKey` | 401, `invalid_api_key`, `API_KEY_INVALID`, 403 | open AI Accounts |
| `quota` | 429, `insufficient_quota`, `RESOURCE_EXHAUSTED`, rate limits | retry later |
| `safety` | moderation/safety refusals, blocked prompts, safety finish reasons | edit the prompt |
| `network` | DNS, connection, TLS failures | retry |
| `timeout` | over the timeout | retry |
| `badResponse` | not JSON, no image, no SVG, nothing drawable, over the size cap | retry |
| `cancelled` | stopped by the person | — |
| `badRequest` | 400, invalid options | fix the input |
| `notFound` | 404 model or endpoint | pick another model |
| `server` | 5xx | retry later |
| `document` | the selection doesn't suit the feature, the target changed | — |
| `keyStore` | the credential store or key file failed | — |
| `needsConsent` | the person hasn't agreed yet | show the consent text |

The provider's own message is appended (clipped to 300 characters) except for key errors, which may
quote the key; any message that contains the key in use has it replaced by `[redacted]`.

## Key storage

* **macOS**: Keychain; **Windows**: Credential Manager. Through the `keyring` crate 3.6
  (MIT OR Apache-2.0; features `apple-native` / `windows-native`, which use the OS APIs through
  `security-framework` / `windows-sys`, both MIT OR Apache-2.0). Service
  `io.github.nihalpi1212.nib.ai`, account `openai` / `gemini`.
* **Linux, BSD**: `ai-keys.json` in Nib's config folder (`~/.config/nib/`), created 0600 and
  replaced atomically (temporary 0600 file, then rename); the file is removed with the last key.
  keyring's Secret Service backends need the D-Bus C library or an async runtime, which this
  pure-Rust build doesn't take; a Secret Service store can replace the file later behind the same
  `SecretStore` trait.
* `ApiKey` is the only type that holds a key: `Debug` prints `ApiKey([redacted])`, it has no
  `Display` or `Serialize`, and only the providers read it (to set the header).
* Keys are **never** in documents, `ai.json`, the app preferences, logs, crash reports, the journal,
  MCP output or the control protocol. Status reports say *connected* and the last four characters.
* Settings (`ai.json` beside the preferences): default provider, models, timeout, consent. No keys
  and no base URL, so editing the settings file can't redirect a key.

## Privacy rules

1. Nothing is sent before the person has agreed, once, in AI Accounts, that the AI commands send
   their prompt, and for some features the selected artwork or image, to the provider they chose
   (`AiSettings::consented`; `GenAi::start` returns `needsConsent` otherwise).
2. A request carries only what its feature needs: the prompt; Recolor the art's colour list; Shape
   Fill the shape's colours; Rewrite the selected text; Expand the selected image; a style
   reference only when asked for.
3. OpenAI requests are sent with `store: false`. Nib keeps nothing of a request after the job:
   results live in memory until applied or discarded (at most 16).
4. No background requests: nothing runs at start-up, and the connection test runs only when the
   person presses it.
5. Logs say which feature ran with which provider and how it ended (kind and status), never the
   prompt, the key or the answer.
6. Hostile answers are expected: SVG is sanitized, JSON is parsed strictly with bounded counts,
   images decode with size and allocation limits, and every value is checked before use.

### SVG sanitizer

`sanitize::sanitize_svg` parses the answer with roxmltree (no DTD, no entities, node limit) and
writes a new SVG from an allowlist: `svg g defs path rect circle ellipse line polyline polygon
linearGradient radialGradient stop clipPath use symbol text tspan`, `a`/`switch` unwrapped, with
presentation attributes only. Dropped: `script`, `foreignObject`, `image`, `style`, animation, event
handlers, every `href` other than `use href="#id"`, every `url()` other than `url(#id)`, values with
control characters or `javascript:`. Limits: 2 MiB of text, 20,000 elements, depth 32, root
`width`/`height`/`viewBox` finite and within 100,000. An SVG with nothing to draw is refused.

## Public API (for the UI, control protocol and MCP)

```rust
use nib_genai::{GenAi, AiAccounts, FeatureRequest, ProviderKind, JobEvent, jobs::Outcome};

// At start-up (desktop): accounts in Nib's config folder.
let mut genai = GenAi::new(AiAccounts::new(&config_dir));
genai.jobs.set_waker(move || ctx.request_repaint());      // egui wakes when a job ends

// AI Accounts dialog
genai.accounts.status();                       // Vec<AccountStatus>: provider, label, connected, hint, backend, isDefault, models
genai.accounts.set_key(ProviderKind::OpenAi, &pasted)?;   // validates the shape, stores it
genai.accounts.clear_key(ProviderKind::Gemini)?;
genai.accounts.has_key(kind);
genai.accounts.set_default_provider(kind)?;
genai.accounts.set_models(kind, Some("gpt-5.1"), Some("gpt-image-1"))?;
genai.accounts.set_consented(true)?;
let job = genai.test_connection(kind)?;        // event outcome: Outcome::Models(Vec<ModelInfo>)

// A feature dialog's Generate button
let job = genai.start(&mut app.session, &FeatureRequest::TextToVector(spec), None /* default provider */)?;
genai.jobs.running();                          // Vec<JobInfo>: id, kind, provider, docUid, started (progress UI)
genai.cancel(job);                             // reported cancelled by the next poll

// Every frame
for e in genai.poll() {                        // JobEvent { info, result: Result<Outcome, AiError> }
    match e.result {
        Ok(Outcome::Generated(g)) => { /* g.variations(), g.preview(i): Svg | Png | Palette | Text */ }
        Ok(Outcome::Models(models)) => { /* AI Accounts: models, provider::pick_model */ }
        Err(err) => { /* err.kind, err.message (see Errors) */ }
    }
}

// The person picks variation i (Place / Apply)
let applied = genai.apply(&mut app.session, job, i)?;     // Applied { ids, swatch }; one undo step
genai.discard(job);                            // dialog closed
```

* Live preview of a recolour variation: `ops::recolor::recolor_params(result, i)` gives the
  `recolor.apply` parameters for `Session::preview` inside an interaction.
* Thumbnails: `Preview::Svg` can be rendered through `vectorcraft-svg` + `vectorcraft-render`;
  `Preview::Png` decoded with `image_util::decode`.
* Blocking callers (CLI, MCP, tests): `genai.wait(job, timeout)`.
* Lower level: `ops::prepare` / `ops::run` / `ops::apply` and `provider::build(config, key)`.
* Wire form of a request (serde): `{"feature": "textToVector", "prompt": "…", "kind": "icon",
  "detail": "medium", "method": "svg", "variations": 2, "palette": ["#112233"],
  "styleReference": false}`; other features as listed in [Features](#features). Results:
  `Generated::summary()` → `{feature, variations, previews: [...]}`; errors: `AiError::to_json()`.

## UI surface (next step)

Built in `ui-egui` (depending on `nib-genai` as a **native-only** dependency:
`[target.'cfg(not(target_arch = "wasm32"))'.dependencies]`, and the code that uses it under
`#[cfg(not(target_arch = "wasm32"))]`; the web build has no AI menu). The layering rule that lets
`ui-egui` and `mcp` use it is already in `xtask/src/layers.rs`. The app owns one `GenAi`, created
with Nib's config folder.

* **Menu `AI`** (between Effect and View, or under Object › Generative in a narrow layout), as
  `UI_COMMANDS` in `crates/ui-egui/src/menus.rs`:
  `ai.textToVector` (Text to Vector Graphic…), `ai.recolor` (Generative Recolor…),
  `ai.shapeFill` (Generative Shape Fill…), `ai.pattern` (Generative Pattern…),
  `ai.expand` (Generative Expand…), `ai.rewrite` (Rewrite Text…), separator, `ai.accounts`
  (AI Accounts…). Each feature's `enabled` mirrors its prepare check (one closed path, one image,
  one type object, any art) so the menu greys out with a reason, and every item is disabled with
  "Add an API key in AI Accounts" when no provider has a key.
  Context menu: Rewrite Text on type, Generative Expand on an image, Generative Shape Fill on a
  closed path. Recolor Artwork dialog: a "Generate" field that runs Generative Recolor.
* **Generative panel / dialog** (one floating panel, its feature chosen by the command): prompt
  field (multi-line), the feature's options (kind segmented control, detail slider with three stops,
  method, variations 1–4, palette chips from swatches, style reference toggle, tone, margins with
  a preset row "to artboard"), provider picker (defaults to the default provider), **Generate** /
  **Stop** (spinner and elapsed time from `JobInfo::started`), a grid of variation thumbnails,
  **Place** (apply the selected one; may be pressed again after Undo for another), error line with
  the action for its kind (Open AI Accounts / Try Again).
* **AI Accounts** dialog: per provider a row with status (connected …abcd / not connected, where
  keys are kept: `AccountStatus::backend`), a password field (masked, never prefilled), Save,
  Remove, **Test Connection** (job; shows model count or the error), text and image model pickers
  (filled from the test's catalog), default provider radio, request timeout, and the one-time
  consent text with an "I agree" checkbox. Links: where to get a key (OpenAI and Google AI Studio
  key pages, opened only on click).
* Strings go into all 28 catalogues like the rest of the UI.

## Control protocol and MCP (next step)

No method ever takes or returns a key: keys are entered only in the AI Accounts dialog (or by a
person at a terminal, see below).

* **Control channel** (`crates/ui-egui/src/control.rs`), on the app's `GenAi`:
  `ai.status` → `{accounts: [AccountStatus], jobs: [JobInfo]}`;
  `ai.generate {request, provider?, wait?: seconds}` → `{job}` or, with `wait`, the finished
  `{job, result: Generated::summary() | error: AiError::to_json()}`;
  `ai.apply {job, variation}` → `Applied`; `ai.cancel {job}`; `ai.discard {job}`.
  Consent and keys can't be given over the channel.
* **MCP** (`crates/mcp`): tools `ai_status`, `ai_generate` (blocks up to 300 s, then returns the job
  id and summary), `ai_apply`, `ai_cancel`. Connected to a running app they forward to the control
  methods; headless they use a `GenAi` over `AiAccounts::new(config_dir)`, i.e. the key stored on
  this machine, and need consent recorded in `ai.json`. Tool output carries summaries (palettes,
  text, SVG and PNG sizes) and never a key.
* **CLI**: `nib-cli ai status`, `nib-cli ai set-key openai` (reads the key from standard input with
  echo off; refuses a key on the command line, which would land in shell history),
  `nib-cli ai clear-key openai`, `nib-cli ai test openai`, and `nib-cli run … --cmd`-style steps
  `ai.generate`/`ai.apply` for batch use.

## Tests

`cargo test -p nib-genai` (the suite is the one test target `tests/genai/`):

* `providers`: request bodies of both providers, answer parsing from recorded JSON (text, refusals,
  content filters, thoughts, images, link-only images, catalogs), error translation (401, quota, rate
  limit, safety, Gemini `API_KEY_INVALID`/`RESOURCE_EXHAUSTED`, 404, 5xx, other 400), the key in a
  header and never in the URL, multipart edits with the mask, redaction of an echoed key, timeout,
  cancellation before sending, the size cap, an unreachable host, base URL rules.
* `sanitize`: scripts, handlers, `foreignObject`, external and `javascript:` references, CSS,
  animation, images, DTDs and entities, impossible sizes, nesting and element limits, escaping,
  namespaces, extraction from prose and fences, the result importing.
* `units`: hex colours, palette JSON (wrapped, bare, single, invalid, bounded), lightness mapping,
  fitting (contain, cover, degenerate), pixel sizes and aspect words, the Expand canvas and mask and
  composition keeping original pixels, image limits, prompts, request JSON.
* `keys`: key validation and redacted `Debug`, the 0600 atomic key file, accounts status without
  keys, the default provider rule, settings without keys surviving a reload, the platform store.
* `ops` (end to end with the mock server): each feature changes the document as described, takes one
  undo step named after the feature, and Undo restores the document exactly; the clipboard
  survives; selections that don't suit send nothing; results refuse another document and a text
  edited meanwhile; a bad answer changes nothing; cancel answers at once and drops the late result;
  nothing is sent without consent or a key; the connection test.

## Platforms

Native only. The crate root is `#![cfg(not(target_arch = "wasm32"))]` and `ureq` is a native-only
dependency, so building the workspace for wasm32 compiles an empty crate; the web app doesn't
depend on it and shows no AI commands. The Linux key file applies to Linux and the BSDs; macOS and
Windows use the OS credential store (built for those targets only; not exercised in this
environment).

## Revision history

| Date | Change | Summary |
|---|---|---|
| 2026-11-14 | major | First version: `nib-genai` (providers, HTTP, key storage, the six operations, jobs, `GenAi`), tests, and the UI, control-protocol, MCP and CLI contract. |
