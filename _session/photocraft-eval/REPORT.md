# PhotoCraft and Pigment: which has more of Photoshop

15 November 2026. PhotoCraft at main abb30df (github.com/storytold/photocraft). Pigment is 0.4.0 plus the eight 0.5 parts built so far in the working tree.

## How this was measured

Pigment's feature list has 1,432 Photoshop features, covering every menu, tool, panel, dialog, preference and file format. Seven reviewers each took one area of the list. For every feature they read PhotoCraft's code (and the shared libraries it uses, craft-libs, at the version it pins) and gave PhotoCraft a status on the same scale as Pigment's:

- **Done:** present, with the options a Photoshop user expects.
- **Partial or approximate:** present, but options are missing or it works differently.
- **Missing:** not there.
- **Not feasible:** needs Adobe's servers, licensed data or Adobe's own AI models.

PhotoCraft's own docs were used only to find code. Where the docs and the code disagreed, the code won; this happened in both directions. A checker then re-judged 84 rows from scratch in both codebases:

- 4 PhotoCraft statuses were wrong, all rated Done where Partial was right;
- 1 Pigment status was wrong;
- 1 "who is ahead" call was wrong, and it under-counted PhotoCraft;
- none of the rows where PhotoCraft looked ahead turned out to be wrong.

Neither app was built or run. "Done" means the code and its options are there, not that the feature is bug-free. Building and running PhotoCraft here was refused by the permission check (see "Not measured").

The data, one line per feature:
- per area: `/tmp/claude-0/-home-user-claude/02aa60de-818c-5d38-b2f3-33055ac112a1/scratchpad/photocraft-eval/map/<area>.jsonl`;
- PhotoCraft extras and its limits in each area: `/tmp/claude-0/-home-user-claude/02aa60de-818c-5d38-b2f3-33055ac112a1/scratchpad/photocraft-eval/map/<area>-beyond.md`;
- the checker's results: `/tmp/claude-0/-home-user-claude/02aa60de-818c-5d38-b2f3-33055ac112a1/scratchpad/photocraft-eval/verify/sample.jsonl`.

## Result

| | Pigment | PhotoCraft |
|---|---:|---:|
| Done | 545 (38%) | 905 (63%); 856 if the 49 Done rows whose note names a missing option count as Partial |
| Partial or approximate | 330 | 297 |
| Missing | 482 (34%) | 162 (11%) |
| Not feasible | 75 | 68 |

Feature by feature:
- **PhotoCraft is ahead** on 617 features.
- **Pigment is ahead** on 93.
- **The two are equal** on 538.
- **Neither has it** on 184.

By area (done / partial / missing):

| Area | Rows | Pigment | PhotoCraft | PhotoCraft ahead | Pigment ahead | Equal | Neither has it |
|---|---:|---|---|---:|---:|---:|---:|
| File and Edit menus, Preferences | 202 | 58 / 52 / 85 | 119 / 57 / 20 | 111 | 12 | 58 | 21 |
| Image and Layer menus; layer, channel and adjustment panels | 203 | 144 / 24 / 31 | 166 / 23 / 11 | 48 | 20 | 128 | 7 |
| Type | 153 | 85 / 18 / 46 | 101 / 29 / 19 | 51 | 19 | 71 | 12 |
| Select, Filter and View menus | 222 | 78 / 65 / 62 | 128 / 53 / 24 | 84 | 10 | 91 | 37 |
| Tools and the brush engine | 175 | 77 / 57 / 37 | 133 / 30 / 10 | 80 | 9 | 76 | 10 |
| Panels, workspaces and the app frame | 209 | 51 / 51 / 99 | 130 / 48 / 23 | 115 | 7 | 59 | 28 |
| Formats, colour, printing, automation, video, AI | 224 | 30 / 57 / 107 | 95 / 54 / 48 | 113 | 14 | 34 | 63 |
| Further features (completeness pass) | 44 | 22 / 6 / 15 | 33 / 3 / 7 | 15 | 2 | 21 | 6 |
| **All** | **1,432** | **545 / 330 / 482** | **905 / 297 / 162** | **617** | **93** | **538** | **184** |

## Where PhotoCraft is ahead

- **Colour and depth.**
  - It stores real CMYK, Lab, Grayscale, Duotone and Multichannel pixels, and works at 8, 16 and 32 bits throughout.
  - Its own ICC colour engine handles Convert to Profile, Color Settings, Proof Setup and Gamut Warning.
  - It can edit single channels, alpha channels and spot channels.
  - Pigment shows CMYK and Lab as a view of RGB pixels, and paints and filters at 8 bits.
- **PSD.**
  - It reads and writes every colour mode and depth, smart objects and smart filters, comps, notes, slices, paths, guides and artboards.
  - It reports that re-saving keeps the render of 307 of the 309 psd-tools test files.
  - Pigment's PSD support is 8-bit RGB, with no smart objects.
- **Other files.**
  - Opens camera RAW (DNG, CR2, NEF, ARW, RW2, PEF, ORF, RAF), PDF, EXR, HDR, HEIF, PSB and layered TIFF.
  - Writes PDF with spot plates.
  - Reads Affinity, GIMP, Krita, Paint.NET and OpenRaster files.
  - Pigment has none of these.
- **Workspace.**
  - Panels dock and float, and Arrange gives several documents side by side.
  - Workspaces, Layer Comps, non-linear history and autosave with crash recovery.
  - 18 preference sections with about 195 working settings.
  - Editors for keyboard shortcuts, menus and the toolbar.
  - Pigment has none of these, or only a small part.
- **Tools.**
  - Nearly every retouching option.
  - Content-Aware Move, the Content-Aware Fill workspace and a classical Remove tool.
  - Mixer Brush, Art History Brush and the Clone Source panel.
  - Symmetry painting, the full set of Crop options, and the Measurement, Count and Note tools.
- **Type.**
  - Warp Text, real vertical type and the OpenType feature buttons.
  - Text inside a shape, Character and Paragraph Styles, and Type Mask tools.
  - Editable text in PSD files.
- **Filters and photography.**
  - Smart filter masks and per-filter blending.
  - Full Liquify, Vanishing Point and Adaptive Wide Angle.
  - Fuller Camera Raw panels, and Color Range with all its modes.
- **Beyond Photoshop.**
  - A command line, an MCP server and a control channel that drive every command.
  - Photoshop .atn actions and .kys shortcut files.
  - A web (WebAssembly) build and 20 interface languages.
  - Signed installers for Windows, macOS, Linux and FreeBSD.

## Where Pigment is ahead (93 features)

The full list, with notes for each feature, is in `/tmp/claude-0/-home-user-claude/02aa60de-818c-5d38-b2f3-33055ac112a1/scratchpad/photocraft-eval/pigment-ahead.md`. The main groups:

- **Generative AI** (PhotoCraft has none: no model runtime, no provider):
  - Generative Fill and Generative Expand;
  - Generate Image and Generate Background;
  - Sky Replacement;
  - Describe Image;
  - the Assistant chat that edits the document;
  - model choice, with sign-in to ChatGPT and OpenAI or Gemini keys.
- **Adjustment details:**
  - adjustment presets (.acv, .alv, .ahu and the others);
  - on-image adjustment tools;
  - Curves display options and Show Clipping;
  - Auto Color Correction Options and Levels Auto Options;
  - the Hue/Saturation range eyedroppers;
  - Clarity, Dehaze and Grain as adjustments.
- **Paragraph typography:**
  - hyphenation and justification settings;
  - the single-line and every-line composers;
  - bulleted and numbered lists;
  - Roman hanging punctuation;
  - Reset Character and Reset Paragraph;
  - Fractional Widths, No Break and System Layout;
  - formatting kept when text is copied between layers.
- **Presets** (from the 0.5 work):
  - a Preset Manager and import/export for every kind of preset;
  - .tpl tool preset files;
  - noise gradients.
- **Smaller items:**
  - AVIF open and GIF in Export As;
  - File Info IPTC and GPS sections;
  - scripted pattern fills;
  - the Adjustment Brush;
  - Info panel 16 and 32-bit readouts;
  - a few Lens Correction, Blur Gallery and Focus Area options.

## PhotoCraft's own limits

PhotoCraft calls itself an early alpha. By its own account (ROADMAP.md, docs/gaps.md):

- It is about 45% ready for real work. Feature breadth is about 76%, and depth is about 55%.
- There were 953 open issues on 13 October.
- It misses 22 of its 25 performance targets.
- Photoshop does not yet reliably accept the PSD files it writes.
- It crashes on the GPU with 150 layers.
- Several Photoshop workspaces are still parameter dialogs.

A Done in the table above therefore means "built", not "dependable". These are known, listed and being worked on. Upstream is very active: it reports 1,004 merged pull requests in its first ten days (30 September to 10 October), and its latest commit is from today.

## What combining means

PhotoCraft is about 1 million lines of Rust, with an egui interface and a wgpu GPU compositor. Pigment is about 139,000 lines of JavaScript in Electron. The code cannot be merged directly. The practical options:

1. **Build on PhotoCraft (recommended).** Fork it and rebuild Pigment's 93 extras in Rust, as Nib did with VectorCraft.
   - **The AI work is smaller than it looks.** The ArtCraft team's shared AI layer (craft-ai-integrations) already has OpenAI image generate, edit and inpaint, Gemini generative fill, FLUX Fill, secret storage, consent, a model picker, and local SAM segmentation and background-removal engines. PhotoCraft does not use it for any generative feature yet; it is the planned route ("one AI connection for every Craft app"). Pigment's JavaScript stays useful as the reference for each feature.
   - **Licences fit.** PhotoCraft is MIT OR Apache-2.0, and Pigment is MIT. The fork keeps PhotoCraft's licence and credits, and our additions can use the same terms.
   - **Upstream keeps improving the base.** Merging it in regularly is ongoing work. Our additions could also be offered upstream.
   - **One legal question.** PhotoCraft reads HEIF with its own HEVC decoder. Pigment avoided this because of HEVC patents.
2. **Stay on Pigment.** Building the 482 missing and 330 partial features would take an estimated 5 or more releases just to reach where PhotoCraft is today, while PhotoCraft keeps moving.

## Not measured

- **Speed and accuracy on real files.** I planned to build PhotoCraft and open the same public PSD test files in both apps, to compare speed and how closely each matches Photoshop's own render. The permission check refused this step, because it builds and runs outside code and downloads test files.
- **Your go-ahead is needed.** Building on PhotoCraft means building and running it here in any case, so that needs your go-ahead.
- **Build times.** This machine has 4 CPUs. The first full build of a 1-million-line Rust app will take a long time, and so will later rebuilds of its large interface crate.
