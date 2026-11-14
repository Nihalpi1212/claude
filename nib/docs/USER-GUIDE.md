# Nib user guide

This guide covers getting Nib running, the generative AI features Nib adds, and Nib's file formats.
Everything else in the app (tools, panels, effects, type, printing) is inherited from
[VectorCraft](https://github.com/storytold/vectorcraft) and works as described in its documentation;
see [Everything else](#everything-else) at the end.

Nib 0.1.0 is an **alpha**: save often, and keep copies of files that matter.

- [Install](#install)
- [First launch](#first-launch)
- [Where Nib keeps its files](#where-nib-keeps-its-files)
- [Setting up AI Accounts](#setting-up-ai-accounts)
- [The generative features](#the-generative-features)
- [Troubleshooting](#troubleshooting)
- [File formats](#file-formats)
- [Everything else](#everything-else)

## Install

Download Nib from the [releases page](https://github.com/Nihalpi1212/claude/releases): the releases
named "Nib", tags `nib-vX.Y.Z`.

| System | Download | How to install |
|---|---|---|
| Windows 10/11 (x64) | `nib-<ver>-windows-x64.msi` | Run the installer. Nib goes to `Program Files\Nib` and appears in the Start menu. |
| Windows, no install | `nib-<ver>-windows-x64-portable.zip` | Unzip anywhere (a USB drive works) and run `nib.exe`. It runs in [portable mode](#where-nib-keeps-its-files). |
| macOS 11 or later | `nib-<ver>-macos-universal.dmg` | Open the disk image and drag **Nib** to **Applications**. One app for Apple silicon and Intel. |
| Linux x86_64, any distribution | `nib-<ver>-linux-x86_64.AppImage` | `chmod +x` the file and run it. |
| Debian, Ubuntu and derivatives | `nib-<ver>-linux-x86_64.deb` | `sudo apt install ./nib-<ver>-linux-x86_64.deb` |
| Linux, unpack anywhere | `nib-<ver>-linux-x86_64.tar.gz` | Unpack and run `bin/nib`. |

The command-line tool `nib-cli` (batch conversion, automation, an MCP server for AI agents) comes
with every Windows and Linux package (on Linux in `/usr/bin` for the `.deb`, in `bin/` of the
tarball); for macOS it is a separate zip (`nib-cli-<ver>-macos-universal.zip`).

To check a download, compare it with `SHA256SUMS.txt` from the same release:
`sha256sum -c SHA256SUMS.txt --ignore-missing` (on macOS, `shasum -a 256 -c`).

**Updates.** Nib never updates itself and never checks for updates in the background.
**Help › Check for Updates…** opens the releases page; download the new version and install it over
the old one. Your settings are kept.

## First launch

Nib's builds are not code-signed, so the first start needs one extra step:

- **macOS:** right-click (or Control-click) **Nib** in Applications, choose **Open**, then **Open**
  again in the dialog. macOS remembers this. Alternatively run
  `xattr -dr com.apple.quarantine /Applications/Nib.app` once in Terminal.
- **Windows:** if SmartScreen says "Windows protected your PC", choose **More info**, then
  **Run anyway**.
- **Linux:** nothing extra; an AppImage only needs to be executable (`chmod +x`).

Nib opens on its **Welcome** screen. From there:

- **New…** (Ctrl+N, ⌘N on macOS) opens the New Document dialog, with presets for print, web,
  mobile and video.
- **Open…** (Ctrl+O) opens `.nibart`, `.vectorcraft`, `.ai`, PDF, SVG, EPS and many other files
  (see [File formats](#file-formats)).
- To try things out, open one of the example files that ship with the source,
  [`examples/`](../examples) (for instance `examples/neon-drive.vectorcraft`).

Nib's interface follows your system's language when it has a translation for it; you can pick
another interface language in **Edit › Preferences** (type "language" in its search field).

If the window doesn't appear or the app stops at start-up, see
[The app doesn't start](#the-app-doesnt-start).

## Where Nib keeps its files

| | Windows | macOS | Linux |
|---|---|---|---|
| Settings (`ui.json`), AI settings (`ai.json`) | `%APPDATA%\Nib` | `~/Library/Application Support/Nib` | `~/.config/nib` (or `$XDG_CONFIG_HOME/nib`) |
| Logs (`nib.log`) | `logs` in the settings folder | same | same |
| Fonts you add to Nib | `Fonts` in the settings folder | same | same |
| AI keys | Windows Credential Manager | macOS Keychain | `ai-keys.json` in the settings folder, readable only by you |

**Portable mode:** when a file named `portable.txt` (or `Nib.portable`) is next to the app, Nib
keeps all its settings in a `NibData` folder beside it instead. The Windows portable zip comes with
`portable.txt`. See
[AI keys in portable mode](#ai-keys-in-portable-mode).

Nib starts fresh: it doesn't read VectorCraft's settings folder. To bring your VectorCraft workspaces
or libraries over, copy the files you want from VectorCraft's folder into Nib's.

## Setting up AI Accounts

Nib's generative features need an API key from **OpenAI** or **Google Gemini**. The key is yours:
requests go from your computer straight to that provider, which bills your account. Nib has no
server, no account of its own and no telemetry.

### 1. Get a key

- **OpenAI:** sign in at [platform.openai.com](https://platform.openai.com/api-keys), open
  **API keys** and create a new secret key. API use is billed separately from a ChatGPT subscription:
  the account needs a payment method or credit. Some image models need the organisation to be
  verified in OpenAI's settings first.
- **Google Gemini:** sign in at [Google AI Studio](https://aistudio.google.com/apikey) and choose
  **Create API key**. Gemini has a free tier with lower limits; image generation and higher limits
  may need billing enabled on the Google Cloud project behind the key.

AI Accounts has a **Get a key…** link for each provider that opens these pages (only when you click it).

Treat the key like a password. Anyone who has it can spend money on your account. You can delete it
on the provider's site at any time, and setting a monthly spending limit there is a good idea.

### 2. Save it in Nib

1. Open **Edit › AI Accounts…** (also the **AI Accounts…** button in Preferences, and the
   **Open AI Accounts…** link in the Generate window).
2. Pick the **OpenAI** or **Google Gemini** tab.
3. Paste the key into **API key** and press **Save Key**. The field is cleared at once; afterwards
   the dialog only shows "Key saved (ends in …abcd)" with the last four characters.
4. Press **Test Connection**. Nib asks the provider for its list of models; "Connected to OpenAI:
   57 models available." (or similar) means the key works. Testing costs nothing.
5. Read the note about what is sent, then tick the agreement checkbox ("I agree that the AI
   commands send my prompt and, where a feature needs it, the selected artwork, image or text to the
   provider I chose."). Nothing is ever sent before you have ticked it.

Other settings in the dialog:

- **Use this provider for the AI commands:** which provider the features use when both have a key
  (the Generate window then also shows a **Provider** choice).
- **Text model** and **Image model:** the defaults are `gpt-5.1` and `gpt-image-1` for OpenAI, and
  `gemini-2.5-flash` and `gemini-2.5-flash-image` for Gemini. After a connection test, **Use
  Suggested** picks good models from those your key can use; **Default** goes back.
- **Request timeout:** how long Nib waits for an answer, 10 to 600 seconds (default 300). Image
  generation can take a minute or more.
- **Remove Key** deletes the key from your computer.

### Where the key is stored

- **macOS:** in your Keychain. **Windows:** in Credential Manager. Both under
  `io.github.nihalpi1212.nib.ai`.
- **Linux and BSD:** in `ai-keys.json` in Nib's settings folder, with permissions that let only your
  user read it (0600). Nib tightens the permissions if they were loosened. Your system keyring is not
  used yet.
- The key is never written into documents, exports, `ai.json`, the preferences, logs, Data Recovery,
  crash reports, the command line, MCP output or the control channel.

#### AI keys in portable mode

The first start in portable mode copies your settings into `NibData`, but **not** your AI keys. A key
you save in a portable copy is stored in `NibData/ai-keys.json` on that drive. FAT and exFAT drives
(most USB sticks) can't restrict who reads a file, so anyone with the drive can read the key. Prefer
not to save keys on shared drives.

### What is sent, and when

Nothing is sent until you press **Generate** (or **Test Connection**). Nothing runs at start-up or
in the background. Each request carries only what its feature needs:

| Feature | Sent to the provider |
|---|---|
| Text to Vector Graphic | your prompt and options; with **Use the selection as a style reference**, a PNG rendering of the selection |
| Generative Shape Fill | your prompt, the shape's proportions, and its colours with **Use the shape's colours** |
| Generative Pattern | your prompt and options |
| Generative Expand | the selected image (as PNG), a mask of the area to fill, and your prompt |
| Generative Recolor | your prompt and the list of the artwork's colours (not the artwork) |
| Rewrite Text | the selected text and the tone you chose |

Your document files and your key are never sent (the key goes only in the request's authentication
header, to the provider it belongs to). OpenAI requests are sent with `store: false`, asking OpenAI
not to keep them for its own use. What each provider does with requests is set by its own terms and
privacy policy, not by Nib.

### What it costs

The provider bills your account for each request, at its current prices; Nib adds nothing. As a rule
of thumb:

- **Text** requests (Vector method of the vector features, Recolor, Rewrite Text) are cheap: usually
  a fraction of a cent to a few cents each.
- **Image** requests (the **Image + Trace** method, Generative Expand) cost more: typically several
  cents per image, more at higher sizes.
- **Variations** multiply the cost: four variations can be up to four requests.
- **Stop** doesn't refund a request: once a request is sent, the provider finishes and bills it even
  if Nib discards the answer.

Check the provider's pricing page and your usage dashboard for exact figures.

## The generative features

All six work the same way:

1. Select what the feature works on (or nothing, for Text to Vector Graphic and Generative Pattern).
2. Choose the command. The **Generate** window opens on that feature. It floats over the canvas and
   you can keep working while it runs. **Window › Generate** shows or hides it.
3. Type a prompt and set the options, then press **Generate**. While it runs you see a spinner, the
   seconds elapsed and **Stop**.
4. The results appear as thumbnails named "Result 1", "Result 2"… **Click one to place it.** Each
   placement is one undo step, named after the feature, so **Edit › Undo** takes it back completely.

A dimmed menu command tells you why in its tooltip ("Select one closed path (a shape) to fill.").
A dimmed **Generate** button also says why: no key yet, no agreement yet, a selection that doesn't
suit, or an empty prompt.

Results stay available until you generate again, close the window or close the document. Closing
the window or the document while a request runs stops waiting for it.

### Text to Vector Graphic

**Object › Generative › Text to Vector Graphic…** (also **Generate Vectors** in the Contextual Task
Bar on an empty canvas, once a key is saved).

1. Optionally select something: the result is fitted into the selection's bounds. With nothing
   selected it is fitted into the active artboard, less a 10% margin.
2. Describe what to make: "a red fox sitting, flat style".
3. Choose the **Type**: **Subject** (one subject, no background), **Scene**, **Icon** or **Pattern**.
4. Choose **Detail** (Low, Medium, High), **Method** and **Variations** (1–4).
   - **Vector** (default): the text model writes an SVG, which Nib checks and imports as editable
     paths and gradients. Fast and cheap; best for icons, simple subjects and flat illustration.
   - **Image + Trace**: the image model paints a picture, which Nib traces with **Image Trace** (more
     colours for higher detail). Richer, more painterly results; costs an image request; more paths.
5. Optionally tick **Use the selection as a style reference** (a rendering of the selection goes with
   the request; with OpenAI this needs a `gpt-image` model).
6. Press **Generate** and click a result to place it. The art comes in as a group. Every click
   places another copy, so you can place several results.

### Generative Shape Fill

**Object › Generative › Generative Shape Fill…** (also in the task bar on a closed shape).

1. Select **one closed path or compound path**. An open path is refused ("The selected path is
   open. Close it to fill it.").
2. Describe the fill: "autumn leaves, overlapping".
3. Set **Detail**, **Method** and **Variations**; tick **Use the shape's colours** to have the art use
   the shape's own colours (when it has two or more).
4. Generate and click a result. The art is scaled to cover the shape, put in the shape's place in the
   stacking order and clipped by the shape, as a clip group.
5. Click another result to try it instead: while the placed result is still the last thing you did,
   Nib swaps it for the new one. One Undo then goes back to the original shape.

### Generative Pattern

**Object › Generative › Generative Pattern…**

1. Optionally select objects to fill with the pattern.
2. Describe the pattern: "small blue anchors on cream".
3. Set **Detail**, **Method**, **Variations** and **Tile size** (in points, 4–4000, default 100).
4. Tick **Fill the selection with the pattern** to apply it to the selection's fill.
5. Generate and click a result. It becomes a new swatch named "AI Pattern: …" in the Swatches panel,
   which you can edit in Pattern Options like any other pattern. Each click adds another swatch.

### Generative Expand

**Object › Generative › Generative Expand…** (also in the task bar on a placed image).

1. Select **one placed raster image**.
2. Choose how much to add: **Add on each side** (points to add on the left, top, right and bottom),
   or **Expand to fill the artboard** (grows the image to cover the artboard it is on; only for
   images that aren't rotated).
3. Optionally describe what should appear in the new area; without a prompt the model continues the
   picture.
4. Generate and click a result. The image is replaced by the larger one in the same place in the
   stacking order, with its name, opacity, blending mode and effects. The original pixels are kept
   exactly; only the new border is generated. Clicking another result swaps it in.

Expand needs an image-editing model: with OpenAI a `gpt-image` model (not `dall-e-3`).

### Generative Recolor

**Edit › Edit Colors › Generative Recolor…**

1. Select the artwork to recolour (it needs colours of its own).
2. Describe a mood or theme ("sunset over the sea", "muted Scandinavian").
3. Choose how many palettes (**Variations**, 1–4) and press **Generate**.
4. The palettes show as colour strips. Click one to apply it: Nib maps the artwork's colours to the
   palette by lightness, through Recolor Artwork. Click another palette to swap it in.

Only the list of colours is sent, never the artwork. For fine control afterwards, use
**Edit › Edit Colors › Recolor Artwork…**.

### Rewrite Text

**Type › Rewrite Text…**

1. Select **one type object**.
2. Choose a tone: **Shorter**, **Longer**, **More Formal**, **More Casual**, **Fix Spelling**, or
   **Custom** with your own instruction ("in French", "as a headline").
3. Choose **Variations** (1–4) and press **Generate**.
4. The rewrites show as text. Click one to apply it. Each styled run (bold word, coloured phrase)
   keeps its style when the model keeps the same number of runs; otherwise the whole text takes the
   style of its first run. Click another rewrite to swap it in.

If you edit the text while the request runs, Nib refuses to overwrite your edit ("The text changed
while it was being rewritten. Run Rewrite Text again.").

## Troubleshooting

### Messages from the generative features

The message appears in the Generate window. **Open AI Accounts…** appears for key problems, **Try
Again** for problems that may go away.

| Message (beginning) | What it means | What to do |
|---|---|---|
| "No OpenAI API key is set…", "No AI provider is set up…" | No key is saved for the provider | Add one in **Edit › AI Accounts…** |
| "The AI commands send your prompt… Agree to this…" | The one-time agreement isn't ticked | Tick it in AI Accounts |
| "… rejected the API key. Check it in AI Accounts." | The key is wrong, revoked or for another provider | Paste the key again, or create a new one |
| "… refused this request for the API key (permission denied)." | The key isn't allowed to use this model or API | Check the key's project and permissions; for OpenAI image models, organisation verification |
| "The … account has no quota left. Check its plan and billing." | No credit or billing on the account | Add credit or enable billing on the provider's site |
| "… is limiting requests (rate limit or quota)…" | Too many requests in a short time, or the free tier's limit | Wait a minute and press **Try Again** |
| "… refused the request for safety reasons. Try a different prompt." | The provider's content filter blocked the prompt or the result | Rephrase the prompt |
| "… doesn't know the model or endpoint. Pick another model in AI Accounts." | The model name is wrong or not available to your key | **Test Connection**, then **Use Suggested** or **Default** |
| "… is having trouble (error 5xx). Try again later." | The provider's servers failed | Try again later |
| "The provider took too long to answer…" | Over the request timeout | Try again, use fewer variations, or raise the timeout in AI Accounts |
| "Nib could not connect to the provider…", "The provider's server could not be found…" | No internet, a firewall or a proxy in the way | Check the connection; Nib uses the proxy from the `HTTPS_PROXY` environment variable |
| "The model's answer has no SVG in it.", "The model's SVG has nothing to draw.", "…too many elements", "…nested too deeply" | The model's answer couldn't be used, or broke Nib's safety limits | **Try Again**; a simpler prompt or **Image + Trace** often helps |
| "dall-e-3 can't edit images…", "A style reference needs a gpt-image model…", "OpenAI returned a link instead of the image…" | The image model can't do what the feature needs | Pick a `gpt-image` model in AI Accounts |
| "Select one closed path to fill.", "Select one placed image to expand.", "Select one type object to rewrite." | The selection doesn't suit the feature | Change the selection |
| "The artwork changed while the palettes were made…", "The image changed while it was being expanded.", "The shape to fill is gone." | You changed or deleted the target while the request ran | Run the feature again |
| "The result belongs to another document…" | You switched documents | Switch back to place the result |
| "That result is no longer available. Generate again." | The result was discarded | Generate again |
| "Stopped." | You pressed **Stop** | (The provider may still bill the request.) |

Notes:

- Nib's log (`nib.log`, see [Where Nib keeps its files](#where-nib-keeps-its-files)) records which
  feature ran with which provider and how it ended, never the prompt, the key or the answer.
  **Help › Copy Troubleshooting Info** copies details about your system for a bug report.
- An answer is always checked before anything is placed: SVGs are rebuilt from a list of safe
  elements (scripts, links, embedded images and CSS are dropped), images are decoded with size
  limits, and very large answers are refused.

### The app doesn't start

- **Graphics problems** (a blank or black window, a crash at start): Nib starts again on the next
  graphics processor if one fails. You can choose one in **Edit › Preferences › Performance ›
  Graphics Processor**, or start Nib with `WGPU_POWER_PREF=low` (or `high`).
- **Linux on Wayland:** dropped files and drawing-tablet pens work through XWayland. Set
  **Preferences › Performance › Linux Display Server** to **X11 (XWayland)**, or start with
  `WAYLAND_DISPLAY= nib`.
- **A plug-in misbehaves:** **Help › Safe Mode…** restarts Nib without plug-ins.
- **After a crash**, Nib offers the unsaved documents from Data Recovery at the next start.

More detail: [development.md](development.md#desktop-graphics-processor) and
[development.md › Linux](development.md#linux-wayland-and-x11).

Please report problems with **Help › Report an Issue**, which opens
[the issue tracker](https://github.com/Nihalpi1212/claude/issues). Never paste an API key into an
issue.

## File formats

### `.nibart`: Nib's own format

**File › Save** saves a `.nibart` file ("Nib Artwork"). It keeps everything editable: layers,
artboards, live effects, type, symbols, swatches, styles. It is a documented JSON format, the same
as VectorCraft's (the file says `"format": "vectorcraft"` inside), so tools that read VectorCraft
files can read it. **File › Save As** › Save Options can save for older VectorCraft versions.

### Opening VectorCraft files

`.vectorcraft` (and the older `.drawcraft`) files open, place and work as templates exactly as
`.nibart` files do. Saving them offers `.nibart`. Generated art and AI pattern swatches are ordinary
paths, groups and swatches, so they open in VectorCraft too.

### Illustrator `.ai`

- **Opening:** a `.ai` file from Illustrator (version 9 and later) is a PDF with Illustrator's own
  editing data inside. Nib reads the PDF page (vectors, text, images, colour, transparency, layers)
  and the structure of the editing data; old PostScript `.ai` files (versions 3 to 8) open through
  Nib's PostScript interpreter. Real files can come in with a different layer structure or with
  some live effects expanded; check the import warning.
- **Saving:** **File › Save As** › Illustrator writes a **PDF-compatible `.ai`**, which Illustrator
  and PDF readers open, with an editing copy of the art (layers, groups, paths, colours, gradients,
  patterns, images, type, symbols, artboards, transparency, masks). Live effects survive only in
  simple cases; others are saved as their result. Version 7 `.ai` is also available for old tools.
- Details and limits: [file-format-parity.md](file-format-parity.md).

### SVG, PDF and EPS

- **SVG** (and compressed **SVGZ**) open as editable art and save with live effects written as SVG
  where possible. **File › Export** › SVG offers styling, font and image options.
- **PDF** opens as editable art and saves with options such as PDF/X, compression, marks and
  bleeds; a PDF saved by Nib with its editing data reopens fully editable.
- **EPS** opens through Nib's own PostScript interpreter, and **File › Save As** writes EPS.

### Other formats

Nib also opens and places DXF, EMF/WMF, PSD/PSB (as their merged image), Affinity documents, and
PNG, JPEG, WebP, GIF, TIFF, BMP and other images; it exports PNG, JPEG, WebP, GIF, TIFF, BMP, PSD,
DXF, EMF/WMF and more, plus **File › Export › Export for Screens**. The full table is in
[file-format-parity.md](file-format-parity.md).

## Everything else

The rest of Nib is VectorCraft's, and its documentation applies (read "VectorCraft" there as "Nib"):

- what's there and how complete it is: [PARITY.md](PARITY.md), [target-app-parity.md](target-app-parity.md);
- type and lettering: [typography-lettering.md](typography-lettering.md), [type-parity.md](type-parity.md);
- effects: [effects-parity.md](effects-parity.md), [three-d.md](three-d.md), [revolve.md](revolve.md);
- dimensions: [dimensions.md](dimensions.md); printing large posters on several pages:
  [print-tiling.md](print-tiling.md);
- Image Trace: [image-trace-adjustments.md](image-trace-adjustments.md);
- plug-ins: [plugins.md](plugins.md);
- automation and agents: [mcp.md](mcp.md), [control-protocol.md](control-protocol.md), and
  `nib-cli --help`;
- interface languages: [localization-parity.md](localization-parity.md);
- **Help › Search Commands…** finds any command by name.

How Nib differs from VectorCraft is listed in [FORK.md](FORK.md); how the generative features work
inside is in [generative-ai.md](generative-ai.md).
