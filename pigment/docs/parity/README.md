# Pigment 0.5.0 and Photoshop

Where Pigment 0.5.0 stands against Adobe Photoshop, entry by entry of the same list of 1,432
Photoshop features that Pigment 0.1 to 0.4 measured themselves against (November 2026).

**In short.** Pigment 0.5.0 is PhotoCraft's editor (PhotoCraft 0.23.1, revision `abb30df`) plus
Pigment's generative AI and an importer for the documents Pigment 0.1 to 0.4 wrote. Of the 1,432
entries, about **907 are done (63%)**, 304 are partial or approximate, 153 are missing and 68 cannot
be built faithfully without Adobe's servers, licensed data or Adobe's own models. The JavaScript
Pigment had about 545 done, counting its unfinished 0.5 work. "Done" means the feature and its options are in the code; it does not mean
bug-free or as fast as Photoshop. PhotoCraft calls itself an early alpha, and so is Pigment 0.5.0:
by PhotoCraft's own measure it is about 45% of the way to being ready for professional work
([`target-app-parity.md`](../target-app-parity.md)).

Pigment 0.4 was still ahead on **93 entries**. The 10 generative-AI entries are in 0.5.0. The other
83 (adjustment presets and options, paragraph typography, presets, a few formats and filter
workspaces) are not in 0.5.0 yet: each is assigned to a work package planned for 0.6
([below](#the-93-entries-where-pigment-04-was-ahead)).

The [method](#how-this-was-measured) says where these numbers come from and how far to trust them.
For the detail behind each area, read PhotoCraft's own measured documents, which describe Pigment
0.5.0's editor too ([below](#upstreams-documents)).

## By area

Statuses as in Pigment 0.4's parity pages: **Done** (present, with the options a Photoshop user
expects), **Partial or approximate** (present, with options missing or a different method),
**Missing**, **Not feasible** (needs Adobe's servers, licensed data or Adobe's models).

| Area | Entries | Done | Partial or approximate | Missing | Not feasible | Different from PhotoCraft 0.23.1 |
|---|---:|---:|---:|---:|---:|---|
| File and Edit menus, Preferences | 202 | 119 | 59 | 18 | 6 | Generative Fill and Sky Replacement (AI) |
| Image and Layer menus; layer, channel and adjustment panels | 203 | 166 | 23 | 11 | 3 | — |
| Type | 153 | 101 | 29 | 19 | 4 | — |
| Select, Filter and View menus | 222 | 128 | 53 | 24 | 17 | — |
| Tools and the brush engine | 175 | 133 | 30 | 10 | 2 | — |
| Panels, workspaces and the app frame | 209 | 130 | 47 | 24 | 8 | Automatic updates: removed (Pigment makes no network request on its own) |
| Formats, colour, printing, automation, video, AI | 224 | 97 | 60 | 40 | 27 | Eight AI entries, and the contextual task bar's generative entries |
| Further features (completeness pass) | 44 | 33 | 3 | 7 | 1 | — |
| **All** | **1,432** | **907** | **304** | **153** | **68** | |

The same totals for the three apps:

| | Done | Partial or approximate | Missing | Not feasible |
|---|---:|---:|---:|---:|
| Pigment 0.4 (the JavaScript app, with its unfinished 0.5 work) | 545 | 330 | 482 | 75 |
| PhotoCraft 0.23.1 (`abb30df`) | 905 | 297 | 162 | 68 |
| **Pigment 0.5.0** | **907** | **304** | **153** | **68** |

What moved from PhotoCraft's column to Pigment 0.5.0's:

- **Generative AI, ten entries.** Generative Fill (counted in two areas), Generative Expand,
  Generate Image, Generate Background, Sky Replacement (in two areas), Describe Image, the AI
  Assistant and model choice. Each has the status Pigment 0.4 had (Generate Image partial, Describe
  Image and the Assistant done, the others approximate: Photoshop uses Adobe's own models, Pigment
  your OpenAI or Google Gemini account). [`../generative-ai.md`](../generative-ai.md) compares them
  with Pigment 0.4 one by one.
- **The contextual task bar's generative entries**: missing in both earlier apps, partial now (a
  prompt in the bar under a selection, Generative Expand in the Crop tool's bar, Generate
  Background after Remove Background).
- **Automatic updates**: PhotoCraft checks once per launch; Pigment makes no network request on its
  own, so Help › Check for Updates opens the releases page instead (missing, by choice;
  [`../FORK.md`](../FORK.md#updates-and-the-network)).
- **Not a Photoshop entry, but new:** Pigment 0.5.0 opens the `.pigment` documents of Pigment 0.1
  to 0.4, every layer kind
  ([user guide](../user/guides/open-pigment-0-4-documents.md)).

If the 49 "Done" entries whose note names a missing option are counted as partial instead, done is
858 and partial 353.

## The 93 entries where Pigment 0.4 was ahead

These are the entries where the JavaScript app had more than PhotoCraft. The ten AI entries came
with the AI port. The other 83 are planned for 0.6 as the packages below; a package name links
each entry to its specification (`PORTS-A` and `PORTS-B` in the release plan). Until then, a
document from Pigment 0.4 that uses one of them still opens: the
[import notes](../user/guides/open-pigment-0-4-documents.md#what-is-not-converted) say what was
kept without effect or left out.

Eleven of the 83, marked †, were in the JavaScript app's unfinished 0.5 work and were never in a
released Pigment: people who used Pigment 0.4 did not have them either.

**Status columns:** Pigment 0.4 and PhotoCraft as the audit rated them; "Pigment 0.5.0" is where
the entry is now. Where Pigment 0.5.0 has PhotoCraft's status, the column names the 0.6 package.

### Generative AI (10, in 0.5.0)

| Area | Entry | Pigment 0.4 | PhotoCraft | Pigment 0.5.0 |
|---|---|---|---|---|
| File and Edit | Generative Fill | Approximate | Missing | Approximate (ported) |
| File and Edit | Sky Replacement | Approximate | Missing | Approximate (ported) |
| Formats and AI | Generative Fill | Approximate | Missing | Approximate (ported) |
| Formats and AI | Generative Expand | Approximate | Missing | Approximate (ported) |
| Formats and AI | Generate Image | Partial | Missing | Partial (ported) |
| Formats and AI | Generate Background | Approximate | Missing | Approximate (ported) |
| Formats and AI | Sky Replacement dialog | Approximate | Missing | Approximate (ported) |
| Formats and AI | Model choice and partner models | Approximate | Missing | Approximate (ported; model names are typed or picked automatically, not chosen from a list) |
| Formats and AI | Describe Image (alt text into File Info) | Done | Missing | Done (ported) |
| Formats and AI | AI assistant (chat that edits the document) | Done | Approximate (an external MCP client) | Done (ported) |

### Image and Layer: adjustments (20)

| Entry | Pigment 0.4 | PhotoCraft and Pigment 0.5.0 | 0.6 package |
|---|---|---|---|
| Curves: display options and Show Clipping | Done | Missing | A4 |
| Curves: eyedroppers and on-image adjustment tool | Done | Partial: no on-image drag tool | A5 |
| Curves: presets and Auto | Done | Missing | A1, A3 |
| Hue/Saturation: range sliders and range eyedroppers | Done | Partial: no add/subtract range eyedroppers | A5 |
| Hue/Saturation: on-image tool and presets | Done | Missing | A1, A5 |
| Newer adjustments: Color and Vibrance, Clarity and Dehaze, Grain | Approximate | Missing (Clarity, Dehaze and Grain only inside Camera Raw) | A6 |
| Levels: black, grey and white point eyedroppers | Done | Done, without target-colour editing | A3 |
| Levels: Auto and Auto Options | Done | Partial: no Auto Options | A3 |
| Auto Color Correction Options | Done | Missing | A3 |
| Black & White | Done | Partial: no on-image tool, no presets | A1, A5 |
| Brightness/Contrast | Done | Partial: no Auto, no presets | A1, A3 |
| Channel Mixer | Done | Partial: no presets | A1 |
| Exposure | Done | Partial: no eyedroppers, no presets | A1, A5 |
| Threshold | Done | Done, without presets | A1 |
| HDR Toning | Done | Partial: no Method menu, no presets | A7 |
| Match Color | Done | Partial: no Save/Load Statistics | A7 |
| Replace Color | Done | Partial: no Selection/Image preview in the dialog | A7 |
| Properties: fill layer | Done | Partial: a solid colour fill is edited only in its dialog | A7 |
| Adjustment presets: save, load, built-in lists | Done | Missing | A1, A2 |
| Adjustments panel: adjustment presets | Partial | Missing | A2 |

### Type (19)

| Entry | Pigment 0.4 | PhotoCraft and Pigment 0.5.0 | 0.6 package |
|---|---|---|---|
| Subscript | Done | Partial: in the model and PSD, no panel button or menu item | B1, B2 |
| Superscript | Done | Partial: the same | B1, B2 |
| Fractional Widths | Done | Missing | B1, B2 |
| No Break | Done | Missing | B1, B2 |
| Reset Character | Partial | Missing | B1, B2 |
| System Layout | Done | Missing | B1, B2 |
| Character language (dictionary for hyphenation and spelling) | Done | Partial: stored, no way to set it; English spelling only | B1, B2, B3, B8 |
| Font menu preview with a choice of sample text † | Done | Partial: fixed sample text | B7 |
| Font Preview Size † | Done | Partial: the Type menu's sizes change nothing (Preferences › Type works) | B7 |
| Manage, Replace All and Resolve Missing Fonts † | Done | Partial: no Resolve Missing Fonts dialog | B7 |
| Cut, copy and paste with formatting kept between type layers | Done | Partial: plain text only | B6 |
| Bulleted and numbered lists | Done | Missing | B1, B5 |
| Hyphenate, and the Hyphenation settings dialog | Done | Missing: the flag is stored, nothing hyphenates | B1, B3, B5 |
| Reset Paragraph | Done | Missing | B1, B5 |
| Roman Hanging Punctuation | Done | Missing | B1, B4, B5 |
| Justification settings (word, letter and glyph spacing, auto leading) | Done | Missing | B1, B4, B5 |
| Paragraph panel | Done | Partial: no hyphenation, justification, composer or hanging punctuation | B5 |
| Single-line and Every-line Composer | Approximate | Missing | B1, B3, B5 |
| Alt-click to enter a paragraph box's width and height | Done | Missing | B6 |

### File and Edit (10 besides the AI)

| Entry | Pigment 0.4 | PhotoCraft and Pigment 0.5.0 | 0.6 package |
|---|---|---|---|
| Cursors: brush leash colour † | Done | Partial: Other Cursors and Brush Preview colour, no leash colour | B17 |
| Color Lookup Tables (export) | Partial | Done in 0.6: `.cube`, `.3dl`, `.csp` and ICC (RGB documents) at once, Description, Copyright, Quality up to 256 points, lowercase extensions | F2 |
| Export As: GIF | Done | Done in 0.6: GIF in Export As, with Transparency | F2 |
| Open: AVIF | Done | Done in 0.6: AVIF opens (8, 10 and 12-bit, alpha, grids, rotation, ICC, Exif and XMP), read only | F3 |
| Fill: Scripted Patterns | Approximate | Missing | B18 |
| Presets › Export/Import Presets and Migrate Presets † | Done | Done in 0.6: every kind, `.pigment-bundle`, Migrate Presets from Pigment 0.4's folder | P1b, P4 |
| Presets › Preset Manager † | Done | Partial: three kinds, rename and delete | P1a |
| File Info: Origin, IPTC, IPTC Extension, GPS Data | Partial | Done in 0.6: Origin, IPTC, IPTC Extension (a list's first entry), GPS Data and Raw Data tabs, Audio/Video, DICOM and history read-only; IPTC-IIM kept in step | F1 |
| File Info: Basic (rating) | Done | Done in 0.6: Rating stars, Description Writer, created, modified, application and format | F1 |
| Paste Special › Paste Without Formatting | Done | Missing | B6 |

### Select, Filter and View (10)

| Entry | Pigment 0.4 | PhotoCraft and Pigment 0.5.0 | 0.6 package |
|---|---|---|---|
| Show › Smart Guides: equal spacing | Done | Partial: alignment and distances, no equal-spacing guides | B9 |
| Blur Gallery: Effects (Bokeh), Motion Effects, Noise | Partial | Missing | B10 |
| Blur Gallery: Path Blur | Partial | Partial: a parameter dialog, no path editing on the canvas | B11 |
| Lens Correction: tools | Partial | Missing | B12 |
| Lens Correction: Custom tab (Fix Green/Magenta Fringe) | Done | Partial | B12 |
| Lens Correction: Preview, Show Grid, grid size and colour | Done | Partial: no grid | B12 |
| Sharpen: Shake Reduction | Approximate | Missing | B13 |
| Focus Area: View modes | Partial | Missing | B14 |
| Focus Area: parameters and output | Approximate | Partial: In-Focus Range and Image Noise Level only | B14 |
| Select and Mask: Object Aware | Approximate | Partial: Color Aware only | B14 |

### Formats, colour and automation (6 besides the AI)

| Entry | Pigment 0.4 | PhotoCraft and Pigment 0.5.0 | 0.6 package |
|---|---|---|---|
| AVIF | Partial | Done in 0.6: opens, read only (more than Pigment 0.4, which opened 8-bit sRGB only) | F3 |
| Targa: 15 and 16-bit and colour-mapped | Done | Done in 0.6: 16-bit files keep their alpha bit, colour maps with 16-bit indices open; writing stays 24 and 32-bit | F2 |
| Export Color Lookup Tables: `.3dl` and the others | Partial | Done in 0.6: `.3dl`, `.csp` and ICC besides `.cube` | F2 |
| File Info: Origin, IPTC and IPTC Extension tabs | Partial | Done in 0.6: in XMP, and in IPTC-IIM (resource 1028, JPEG APP13) for the fields IIM holds | F1 |
| EXIF reading (Camera Data) | Partial | Done in 0.6: Pigment 0.4's 17 tags, serial number, pixel size, orientation and GPS | F1 |
| Actions: Default Actions and bundled sets | Partial | Done in 0.6: the Default Actions set (12 of Photoshop's 13: all but Save As Photoshop PDF) on first launch and from Reset Actions; Adobe's other sets are not included (Photoshop `.atn` sets you own load and play) | U2 |

### Tools (9)

| Entry | Pigment 0.4 | PhotoCraft and Pigment 0.5.0 | 0.6 package |
|---|---|---|---|
| Pen tilt, barrel rotation and stylus wheel input † | Done | Done in 0.6, not yet confirmed on hardware: tilt and rotation through Windows Ink, the tip turns the way the pen turns (#1301), the stylus wheel on macOS and WinTab; no native Wayland pen | U3 |
| Shape fill: none, solid, gradient, pattern | Done | Partial: no pattern fill for shapes | B15 |
| Polygon tool: Smooth Corners, Smooth Star Indents | Done | Partial | B15 |
| Preset management † | Done | Partial | P1a |
| Tool Presets: `.tpl` files † | Done | Partial: no `.tpl` | P2 |
| Object Selection: Lasso mode, Object Subtract, Hard Edge | Approximate | Approximate: rectangle only | B16 |
| Smart guides and measurement labels | Done | Partial: no spacing labels | B9 |
| Noise gradients | Done | Missing | P3 |
| Adjustment Brush tool | Done | Missing | B17 |

### Panels and workspace (7) and further features (2)

| Entry | Pigment 0.4 | PhotoCraft and Pigment 0.5.0 | 0.6 package |
|---|---|---|---|
| Info panel: second colour readout modes | Partial | Done in 0.6: two readouts in ten modes each, a mode per Color Sampler, Panel Options | U1 |
| Info panel: 16-bit and 32-bit values | Done | Done in 0.6: 0–32768 or 0–65535, 32-bit floats, deep sampler values | U1 |
| Actions: Default Actions set | Approximate | Done in 0.6: Pigment 0.4's ten actions plus Make Clip Path and Mixer Brush Cloning Paint Setup | U2 |
| Actions: Clear All Actions, Reset Actions | Done | Done (PhotoCraft built them, with Replace Actions and an undo) | U2 |
| Actions: Insert Conditional | Done | Done in 0.6: Insert Conditional… in the panel menu; Record Again edits a conditional | U2 |
| Pen tablet: tilt, rotation, barrel wheel, eraser end, side buttons † | Done | Done in 0.6 (as above), not yet confirmed on hardware | U3 |
| Tool presets: load, save, replace, reset, `.tpl` † | Done | Partial: no `.tpl` | P2 |
| Select Similar Layers | Done | Done in 0.6: Select › Similar Layers, after Deselect Layers; adjustment and fill layers of any kind match | U4 |
| Operating-system recent documents | Done | Done in 0.6: Windows Recent (`SHAddToRecentDocs`), macOS Recent Items, Linux `recently-used.xbel` | U4 |

### The 0.6 packages

| Package | What | Entries |
|---|---|---:|
| A1 to A7 | Adjustment presets (A1, A2); Auto Color Correction Options and Auto (A3); Curves display options (A4); on-image tools and eyedroppers (A5); Color and Vibrance, Clarity and Dehaze, Grain (A6); HDR Toning methods, Match Color statistics, Replace Color preview, solid fill in Properties (A7) | 20 |
| P1a, P1b, P2, P3, P4 | Preset Manager for every kind; Export/Import Presets; `.tpl` tool presets; noise gradients; Migrate Presets from Pigment 0.4 | 6 |
| F1, F2, F3 | File Info sections and camera data; Targa, GIF in Export As, lookup-table formats; opening AVIF | 10 |
| U1 to U4 | Info panel; Actions; pen tablets; Select Similar Layers and recent documents | 10 |
| B1 to B8 | Typography: model and PSD, Character panel, composers and hyphenation, justification and hanging punctuation, Paragraph panel and lists, editing, fonts, spelling languages | 20 |
| B9 to B18 | Smart guide spacing, Blur Gallery effects, Path Blur, the Lens Correction workspace, Shake Reduction, Focus Area and Object Aware, shapes, Object Selection modes, Adjustment Brush and leash colour, scripted patterns | 17 |

The specifications drop a few parts on purpose: native Wayland pen input, Adobe's own action sets
other than Default Actions, Photoshop's `.sta` and `.hdt` files, AVIF writing (Pigment 0.4 could
not write AVIF either), and an Object Aware mode with a learned model (a classical approximation
is planned, labelled as such).

## How this was measured

**The audit.** On 15 November 2026 seven reviewers took one area each of Pigment's list of 1,432
Photoshop entries (every menu, tool, panel, dialog, preference and file format; Pigment 0.4's
pages: [`PARITY.md`](https://github.com/Nihalpi1212/claude/blob/claude/fervent-newton-263lz3/pigment/docs/PARITY.md)
and [`parity/`](https://github.com/Nihalpi1212/claude/tree/claude/fervent-newton-263lz3/pigment/docs/parity)
on the JavaScript app's branch). For every entry they read PhotoCraft's code at `abb30df` and gave
it a status on the scale above. PhotoCraft's own documents were used only to find code; where code
and documents disagreed, the code won. Neither app was built or run for the audit, so a status
says what the code holds, not how well it works. Pigment 0.4's column includes the eight parts of
the JavaScript app's unfinished 0.5 that were built by then (mostly why it shows 545 done where
Pigment 0.4's own pages show 477). A checker then re-judged 84 entries in both codebases: 4
PhotoCraft statuses were too high (Done where Partial was right), 1 Pigment status was wrong, 1
"who is ahead" call under-counted PhotoCraft, and no entry where PhotoCraft looked ahead was wrong.

**Pigment 0.5.0's column** is PhotoCraft's, with the entries listed under [By area](#by-area)
changed. Pigment's base is still `abb30df`: nothing has been merged from upstream since (upstream
has moved a long way; [`../FORK.md`](../FORK.md#upstream-after-the-import) says what is planned).

**The row-by-row map was lost** with a container on 16 November; only its summaries were kept.
For this page the map was rebuilt from the reviewers' working files, which survived for seven of
the eight areas (1,229 entries; the 203 Image and Layer entries survive only as counts and as the
20 entries of the table above). In all seven, the rebuilt statuses give exactly the counts the
audit reported. The "who is ahead" counts match too, except for three judgement calls between
"equal" and "PhotoCraft ahead" in Type and Formats, which change no status.

**Checked again on the Rust tree (18 November).** 48 entries, six per area: in each of the seven
areas, two PhotoCraft rated Done, two Partial or Approximate, one Missing and one where Pigment 0.4
was ahead, picked at random; in Image and Layer, six of the twenty entries above. Each was checked
against the code Pigment 0.5.0 builds from. **47 of 48 agreed.** The one that did not: the Direct
Selection tool, rated Partial for lacking arrow-key nudges, has them (one history step per press),
so PhotoCraft and Pigment 0.5.0 are a little better there than the count says. All 13 sampled
entries where Pigment 0.4 was ahead are still missing or partial, as the 0.6 table says. With 1
error in 48, expect the counts to be right to within a few percent; the larger uncertainty is
what "Done" hides, which upstream's documents measure.

Not measured here: speed, how closely renders match Photoshop's, and how the generative features
behave with live OpenAI and Gemini accounts (the port was tested against local stand-ins only).

## Upstream's documents

PhotoCraft measures itself in more depth than this list does. These describe Pigment 0.5.0's
editor as of `abb30df`; read "PhotoCraft" there as "Pigment":

- [`target-app-parity.md`](../target-app-parity.md): the headline numbers (feature breadth about
  76%, ready for real work about 45%) and the detail by feature area.
- [`gaps.md`](../gaps.md): every known shortfall against Photoshop 2026, ranked, with estimates.
  The biggest: PSD files Photoshop does not yet reliably accept, interactive performance, the
  open bug backlog, brush feel, and workspaces still shown as parameter dialogs.
- [`scorecard.md`](../scorecard.md): measured checklists for performance (90 scenarios, 3 within budget at the last baseline, 52 not run yet),
  file compatibility, tools, workspace, type, automation, reliability and distribution.
- [`parity-checklist.md`](../parity-checklist.md): Photoshop's menu tree against the live command
  registry (every menu item runs a command; that shows the menus are wired, not that each command
  matches Photoshop).
- [`ROADMAP.md`](../../ROADMAP.md), and the parity documents by dimension:
  [UI](../ui-parity.md), [brushes](../brush-parity.md), [file formats](../file-format-parity.md),
  [hardware](../hardware-parity.md), [localization](../localization-parity.md).
