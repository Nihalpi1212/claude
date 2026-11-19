## Pigment 0.5.0: Pigment on PhotoCraft

Pigment 0.5.0 is a new Pigment. Versions 0.1 to 0.4 were an Electron app written in JavaScript;
0.5.0 is built on [PhotoCraft](https://github.com/storytold/photocraft) 0.23.1, the open-source,
clean-room Photoshop reimplementation in pure Rust by the ArtCraft team and the PhotoCraft
contributors (MIT OR Apache-2.0). It keeps the name Pigment and its icon, and takes PhotoCraft's
editor almost unchanged: a native app with layers, masks, adjustment layers, layer styles, smart
objects and filters, type, vectors, brushes, real PSD/PSB files and a GPU compositor.

`pigment --version` prints `Pigment 0.5.0 (based on PhotoCraft 0.23.1)`.

In short, 0.5.0 has:

- **PhotoCraft's editor**, almost unchanged. Measured against 1,432 Photoshop features, about 907
  are done, 304 partial or approximate and 153 missing (the JavaScript Pigment had about 545 done, counting its unfinished 0.5 work).
  It is an alpha: "done" means the feature is there, not that it is as fast or dependable as Photoshop's.
  [The parity page](https://github.com/Nihalpi1212/claude/blob/pigment-v0.5.0/pigment/docs/parity/README.md) has the numbers by area and how they were measured.
- **The generative AI of Pigment 0.4**, rebuilt for the new app, with your own OpenAI or Google
  Gemini account ([below](#generative-ai)).
- **Your Pigment 0.1 to 0.4 documents open**, every kind of layer
  ([below](#documents-from-pigment-01-to-04)).
- **Not yet:** 83 smaller features Pigment 0.4 had, such as adjustment presets and paragraph
  typography ([below](#not-in-050-yet)).

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

### Not in 0.5.0 yet

Pigment 0.4 was ahead of PhotoCraft on 93 Photoshop features. The 10 generative-AI ones are in
0.5.0. The other 83 are not, and are planned for 0.6:

- **Adjustments:** adjustment presets (`.acv`, `.alv`, `.ahu` and the others) and the Adjustments
  panel's presets; Auto Color Correction Options and Auto in Curves and Brightness/Contrast; Curves
  display options and Show Clipping; the on-image tools and the Hue/Saturation range eyedroppers;
  Color and Vibrance, Clarity and Dehaze and Grain as adjustments; HDR Toning's methods, Match
  Color's statistics, Replace Color's preview, a solid fill edited in Properties.
- **Type:** hyphenation and its settings, justification spacing, the single-line and every-line
  composers, bulleted and numbered lists, Roman hanging punctuation, Fractional Widths, No Break,
  System Layout, Reset Character and Reset Paragraph, Superscript and Subscript buttons, the
  character language, formatting kept when text is pasted between layers, Paste Without
  Formatting, the font menu's sample text, Font Preview Size and the Resolve Missing Fonts dialog.
- **Presets:** the Preset Manager and Export/Import Presets for every kind, Migrate Presets from
  Pigment 0.4, `.tpl` tool presets, noise gradients.
- **Files and panels:** opening AVIF, GIF in Export As, 15 and 16-bit Targa, `.3dl` and the other
  lookup-table formats, File Info's rating, IPTC, Origin and GPS sections, more camera data; the
  Info panel's readout modes and 16 and 32-bit values; the Default Actions set, Clear All and
  Reset Actions, Insert Conditional; pen tilt and rotation through Windows Ink; Select Similar
  Layers and the system's recent documents.
- **Filters, tools and selection:** Blur Gallery effects and Path Blur editing, the Lens Correction
  workspace, Shake Reduction, Focus Area's views and options, Object Aware in Select and Mask,
  Object Selection's lasso mode, pattern-filled shapes and smooth polygon corners, smart guides'
  spacing labels, the Adjustment Brush, the brush leash colour and scripted pattern fills.

Eleven of these (the Preset Manager, Export/Import Presets, `.tpl` files, the pen input, the brush
leash colour and the font menu items) were only in Pigment 0.4's unfinished successor and never in
a release. A Pigment 0.4 document that uses one of them still opens; the notes after opening say
what was kept without effect. [The parity page](https://github.com/Nihalpi1212/claude/blob/pigment-v0.5.0/pigment/docs/parity/README.md#the-93-entries-where-pigment-04-was-ahead)
lists each feature with its status.

If you need one of them now, Pigment 0.4.0, the JavaScript app, stays downloadable from
[its own release page](https://github.com/Nihalpi1212/claude/releases/tag/pigment-v0.4.0). 0.5.0 is
Pigment's latest release; 0.4.0 gets no more updates.

### Known issues

**Generative AI**

- **It was tested against local stand-ins for OpenAI and Google Gemini, not with live accounts**
  (none was available). If a real account behaves differently, please report it. The preferred
  model names are Pigment 0.4's; if one no longer exists, the next one or the provider's first
  model of the kind is used.
- **Sign in with ChatGPT** uses a route OpenAI has not documented as a stable service and was never
  tried against the real one: it may not work, or may stop working. API keys do not depend on it.
- **The macOS Keychain and the Windows Credential Manager** were never tried on a real Mac or PC
  while this was built; the key store was tested on Linux only. On Linux the key file is readable only
  by you but not encrypted.
- **A document is locked while its AI request runs** (other documents are not). Pigment 0.4 let you
  keep editing it.
- **Stop does not take back a request already sent.** Nothing lands in the document, but the
  provider may still bill it.
- **Remove Background with AI Provider needs a pixel layer**: rasterize a type or shape layer
  first (Pigment 0.4 did it for you).
- **Models are typed or picked automatically**, not chosen from a list, in AI Accounts and the
  feature windows; the Assistant lists the chat models when you press List models.
- **The Assistant can run several Generative Fill steps in one turn**, each billed; Stop ends the
  turn. Turning off "Allow agents to run AI commands" does not stop an AI app's turn already
  running.
- **On Windows, `pigment-cli ai set-key` shows the key as you type it.** Pipe it in instead, or
  use AI Accounts.
- **Very large canvases:** Generate Image or Generative Expand at document size on a 48-megapixel
  document can use about 1.2 GB of memory.

**Documents from Pigment 0.1 to 0.4**

- Some adjustments look visibly different from 0.4 once opened (Brightness/Contrast, Photo Filter,
  Colorize, Levels in CMYK): Pigment computes them as Photoshop does. Their settings are kept.
- Closing an unsaved old document and choosing Save asks "Save in the new Pigment format?" too;
  after that question, the close prompt needs Save a second time. Nothing is lost.
- A type layer with tens of thousands of style runs, or a shape with over a thousand subpaths,
  takes seconds to minutes to open. No real Pigment document is known to come near this.

**The app**

- **The builds are not code-signed** (see the first-launch steps below). Only Windows x64, macOS
  (universal) and Linux x86_64 builds are published.
- **It is PhotoCraft as of `abb30df`** (0.23.1). Upstream has changed a great deal since; none of
  it is in 0.5.0, and merging it is planned as the next step. Everything PhotoCraft lists as
  missing or unreliable at that revision applies: Photoshop does not yet reliably accept the PSD
  files it writes, most performance targets are not met, and there are many open bugs (its
  [`gaps.md`](https://github.com/Nihalpi1212/claude/blob/pigment-v0.5.0/pigment/docs/gaps.md) and [`ROADMAP.md`](https://github.com/Nihalpi1212/claude/blob/pigment-v0.5.0/pigment/ROADMAP.md)).
- **Interface strings Pigment added** (the AI windows, the new links, the credit line in About, the
  agents switch) are in English in every language.
