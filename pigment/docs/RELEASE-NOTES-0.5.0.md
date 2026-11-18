## Pigment 0.5.0: Pigment on PhotoCraft

Pigment 0.5.0 is a new Pigment. Versions 0.1 to 0.4 were an Electron app written in JavaScript;
0.5.0 is built on [PhotoCraft](https://github.com/storytold/photocraft) 0.23.1, the open-source,
clean-room Photoshop reimplementation in pure Rust by the ArtCraft team and the PhotoCraft
contributors (MIT OR Apache-2.0). It keeps the name Pigment and its icon, and takes PhotoCraft's
editor almost unchanged: a native app with layers, masks, adjustment layers, layer styles, smart
objects and filters, type, vectors, brushes, real PSD/PSB files and a GPU compositor.

`pigment --version` prints `Pigment 0.5.0 (based on PhotoCraft 0.23.1)`.

### What changed from PhotoCraft

- **Pigment's name, icon and ids everywhere:** the binaries are `pigment` and `pigment-cli`, the
  application id is `io.github.nihalpi1212.pigment`, and settings, logs and crash recovery live in
  a `Pigment` folder (`~/.config/pigment` on Linux). Nothing is read from PhotoCraft's or ArtCraft's
  folders.
- **`.pigment` is the native extension.** It holds PhotoCraft's native format, so `.pcraft` files
  open too.
- **No network request on its own.** There is no update check at launch; Help › Check for Updates
  opens the releases page. The AppImage carries no update information.
- **AI agents:** Preferences › AI Integrations › **Let AI apps use this window** is Pigment's own
  switch (off by default; `pigment-cli mcp` then serves a session without a window, as before).
- Help, About and the start screen link to Pigment's issues, repository and releases, and to the
  upstream project.

The full list is in [`pigment/docs/FORK.md`](https://github.com/Nihalpi1212/claude/blob/pigment-v0.5.0/pigment/docs/FORK.md).

### Generative AI

Pigment 0.5.0 has the generative AI of Pigment 0.4, rebuilt for the new app. It is optional and
uses your own OpenAI or Google Gemini account.

- **Generative Fill:** Edit › Generative Fill…, the bar under a selection, or right-click a
  selection. Fills the selection from a description, 1 to 3 variations, each on a new layer.
- **Generative Expand:** the Crop tool's bar (drag the crop frame past the canvas) and the command
  palette. Enlarges the canvas and fills the new area.
- **Generate Image:** Edit › Generate Image…. A new layer or a new document from a description,
  with a transparent background if you like.
- **Remove Background:** Layer › Remove Background works on your computer and needs no account.
  Layer › Remove Background with AI Provider asks the provider's image model for the subject.
- **Generate Background:** Layer › Generate Background…, and the bar that appears after Remove
  Background. Keeps the subject and generates new surroundings.
- **Sky Replacement:** Edit › Sky Replacement…. A new sky from a description; the sky is your
  selection, or the one Select › Sky finds.
- **Describe Image:** Image › Describe Image…. Describes the picture, to copy or to keep as the
  document's description.
- **Assistant:** Window › Assistant. A chat about the open document that can edit it: adjustments,
  filters, layers, selections, text and Generative Fill, each an ordinary undo step.
- **AI Accounts:** Edit › AI Accounts… (also a button in Preferences › AI Integrations). OpenAI and
  Google Gemini API keys, the models, and **Sign in with ChatGPT (experimental)**, which uses a
  ChatGPT Plus or Pro plan for the Assistant and Describe Image; the image features always need an
  API key.
- **`pigment-cli ai`** does what AI Accounts does from the command line (`status`, `set-key`,
  `sign-in`, `consent`, `test`, …), and `pigment-cli run --allow-ai` runs the features in a script.

Every feature is also in the command palette. There is no AI menu: the features sit where
Photoshop puts them.

**Keys and the sign-in are entered again.** Nothing migrates from Pigment 0.4: its API keys and
its ChatGPT sign-in were sealed by the old app and are not read. Open Edit › AI Accounts…, paste
your key and press Connect (or sign in again). Keys are kept in the macOS Keychain or the Windows
Credential Manager; on Linux in `ai-keys.json` in Pigment's settings folder, readable only by you
and not encrypted.

**Nothing is sent before the one-time agreement.** AI Accounts asks you once to agree to what the
AI commands send (your prompt and, where a feature needs it, the image, the layer or the
selection) and that the provider bills your account for every request, including one you stop
after it was sent. Until you agree, no prompt and no picture leaves your computer, and afterwards
only when you run a feature. The one request before that is yours too: Connect and Test
Connection ask the provider for its list of models, to check the key you entered.

What differs from Pigment 0.4:

- **The agreement is new.** In 0.4, connecting an account was the consent.
- **No AI menu.** The items moved to the Edit, Layer, Image and Window menus, and to the bars and
  the right-click menu named above.
- **Remove Background masks the layer itself** instead of hiding it behind a masked copy
  (duplicate the layer first to keep an untouched one). The menu's default now runs on your
  computer; the provider's method is the item next to it. Both need a pixel layer: rasterize a
  type or shape layer first.
- **Replace Background is now Generate Background, and Replace Sky is Sky Replacement.** The
  subject and the sky are found on your computer (Select Subject, Select › Sky), so Generate
  Background sends one request, not two.
- **Generative Expand is one undo step** (0.4 made a Canvas Size step and then the fill).
- **The document is locked while its request runs.** 0.4 let you keep editing it; here you can
  work in other documents, and the status bar shows the request with Cancel.
- **Actions never replay AI.** 0.4 recorded the AI dialogs, and playing the action called the
  provider (and billed) again. Now a command that sends is neither recorded nor run from an
  action, a batch or a droplet. Layer › Remove Background, which sends nothing, is recorded.
- **The Assistant is a floating window**, not a docked panel. It looks commands up instead of
  carrying the whole command list, and its model list is fetched when you press List models, not
  on its own.
- **Models are picked automatically** from the provider's list unless you type one in AI Accounts
  (Use Suggested fills it in) or, for one request, in the feature's window. 0.4 had drop-down
  lists there.
- **Sign in with ChatGPT is marked experimental** and can be switched off (`"chatgptSignIn":
  false` in `ai.json`).
- **New:** `pigment-cli ai`; a prompt field in the bar under a selection; and AI agents (MCP, the
  control channel) may run these features only while **Allow agents to run AI commands** is on in
  AI Accounts (off by default).

[`pigment/docs/generative-ai.md`](https://github.com/Nihalpi1212/claude/blob/pigment-v0.5.0/pigment/docs/generative-ai.md)
has the details and a feature-by-feature comparison with Pigment 0.4.

### Documents from Pigment 0.1 to 0.4

**Your old `.pigment` documents open, with every kind of layer.** Pigment recognises a file saved
by Pigment 0.1 to 0.4 by its content, whatever it is called, and converts it.

- **Converted exactly:** the document (size, resolution, the Bitmap, Grayscale, Duotone, Indexed
  Color and RGB modes, 8, 16 and 32 bits per channel); pixel, group, adjustment, fill, shape, type
  and smart-object layers with their opacity, fill opacity, blend mode, locks and clipping; layer
  masks with density and feather, and vector masks; the settings of every adjustment and layer
  style; advanced blending (Blend If, knockout, channels); type as editable type, with its text,
  fonts and character and paragraph settings (point type, paragraph boxes, type on a path,
  vertical type); smart objects with their contents (a nested document or an image), shared
  between duplicated instances, and their transform; the smart filters Pigment has (the blurs,
  sharpening, noise, Mosaic, Emboss, Find Edges, Maximum, Minimum, Offset, Twirl, Pinch, Spherize,
  Ripple, Polar Coordinates and the adjustments); colour labels and links, the selection, saved
  channels, guides, paths, the global light and File Info.
- **Approximated**, converted but drawn a little differently: adjustments and effects PhotoCraft
  computes as Photoshop does (Brightness/Contrast, Photo Filter, Color Balance, Vibrance, Selective
  Color, Exposure, the Curves spline, some shadows, glows and strokes); type, which Pigment's type
  engine lays out (lines can break and glyphs sit slightly differently, and a stroke on the
  characters becomes a Stroke layer effect); turned or scaled smart objects (resampled bicubic) and
  smart filters (Pigment's own filters); CMYK and Lab documents, which open in RGB (Pigment 0.4
  kept RGB pixels for them), and Multichannel ones, in RGB with their inks as spot channels.
- **Reported as not converted:** the notes shown after opening list, one line each, what has no
  place in Pigment yet: Color and Vibrance, Clarity and Dehaze and Grain adjustment layers (their
  settings are kept, they change nothing), smart filters Pigment does not have (Filter Gallery
  effects, Glowing Edges, Oil Paint and others), type settings it does not have (lists, hanging
  punctuation, justification spacing, hyphenation settings, tab stops, No Break), a stroke on a
  pattern-filled shape, smart objects nested more than 8 deep, and anything missing from a damaged
  file. The document's import report keeps the same list when you save it.

**Saving goes to the new format.** The document keeps its file, and the first File › Save asks
"Save in the new Pigment format? Pigment 0.4 will no longer be able to open this file.": Save
writes the new format over it, Save As… keeps the old file and saves a new one, Cancel does
neither ("Don't show again" stops the question). Scripts, AI agents and actions that save do not ask. A file
that cannot be read at all says "This Pigment 0.4 file is damaged:" and why.

On Windows and macOS, 0.5 installs where 0.4 was (`%LOCALAPPDATA%\Programs\Pigment` or
`C:\Program Files\Pigment`, and `Pigment.app` in Applications) and replaces it; your documents stay
where they are. To keep 0.4 as well, choose another folder on the installer's folder page
(Windows) or move `Pigment.app` out of Applications first (macOS).

### Known issues

- **The generative AI was tested against local stand-ins for OpenAI and Google Gemini, not with
  live accounts** (none was available). If a real account behaves differently, please report it.
  **Sign in with ChatGPT** in particular uses a route OpenAI has not documented as a stable
  service and was never tried against the real one: it may not work, or may stop working. API
  keys do not depend on it.
- The other additions of Pigment 0.2 to 0.4 (those besides the generative AI) are not in 0.5.0
  yet.
- Interface strings Pigment added (the new links, the credit line in About, the agents switch, the
  AI windows) are in English in every language.
- The builds are not code-signed (see the first-launch steps below).
- Everything PhotoCraft 0.23.1 lists as missing or in progress applies (its `ROADMAP.md`).
