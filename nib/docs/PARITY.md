# Nib vs Illustrator

> **Last updated:** 2026-11-14, for Nib 0.1.0 (VectorCraft 0.24.1, revision
> `a47d7eec9120e6487a0049600aa34e22a530013b`).

**Verification note.** Adobe's online user guide (helpx.adobe.com) could not be fetched from the
container this page was written in, so **nothing on this page was re-checked against Adobe's guide
here**. The comparisons below rest on VectorCraft's documents (themselves written from Adobe's public
documentation) and on Nib's own code. Feature names of Illustrator are used only to say what is being
compared.

## The detailed parity tables are VectorCraft's

Nib 0.1.0 is VectorCraft at the imported revision plus the changes listed in [FORK.md](FORK.md).
Everything about how far the editor matches Illustrator (tools, menus, effects, type, formats,
interface, hardware) is therefore VectorCraft's assessment, and lives in its documents:

| Document | What it holds |
|---|---|
| [target-app-parity.md](target-app-parity.md) | The full assessment: headline numbers, how they were measured, the score of each feature area, readiness by audience, and the evidence |
| [gaps.md](gaps.md) | The ranked list of what's missing (G1–G19), with estimates and the beta list |
| [../ROADMAP.md](../ROADMAP.md) | The summary: stage, numbers by dimension and area, what's next |
| [ui-parity.md](ui-parity.md), [file-format-parity.md](file-format-parity.md), [type-parity.md](type-parity.md), [effects-parity.md](effects-parity.md), [hardware-parity.md](hardware-parity.md), [localization-parity.md](localization-parity.md) | Each dimension in detail |

**Read their figures as upstream's self-assessment.** They were set by the agents that built the
features, from VectorCraft's code against Adobe's public documentation and release announcements,
without inspecting an installed Illustrator (the clean-room rule forbids it), and they are dated
(most headline numbers: 2026-10-10). VectorCraft calls them upper bounds. At that date it put
Illustrator 2026 (30.x) parity at:

- feature breadth about 88% (menu items, tools, effects and formats that exist),
- feature depth about 75% (weighted by use, scored by behaviour),
- ready for real work about 62% for a full Illustrator user, about 65% for a mainstream illustrator,
  about 75% for an essentials user,
- generative AI 0% (gap G18).

Nib has not re-measured any of these. The only area where Nib changes the picture is generative AI,
below.

## Nib's changes: G18 generative features

VectorCraft listed generative AI as gap G18 ([gaps.md](gaps.md#g18-generative-ai-features)), waiting
for a decision on models and providers. Nib decided: **the user's own OpenAI or Google Gemini API
key**, called directly from the user's machine, with no Nib server. Illustrator's equivalents run on
Adobe's Firefly models in Adobe's cloud; Nib's are its own design on general-purpose models, so the
results differ in kind and quality from Firefly's and are not a faithful copy.

Implemented in Nib 0.1.0 (code in `crates/genai` and `crates/ui-egui/src/ai`; full contract in
[generative-ai.md](generative-ai.md); how to use them in [USER-GUIDE.md](USER-GUIDE.md#the-generative-features)):

| Illustrator feature | Nib | Method | Limits |
|---|---|---|---|
| Text to Vector Graphic (Subject, Scene, Icon, Pattern) | **Text to Vector Graphic** (Object › Generative) | **Vector:** the text model writes an SVG, which is sanitized (allowlisted elements only) and imported by Nib's SVG importer. **Image + Trace:** the image model paints a flat-colour PNG, traced with Image Trace with a preset chosen by type and detail. Fitted into the selection or the artboard; one undo step | Quality depends on the model; the Vector method gives simple shapes and gradients only; 1–4 variations; style reference only with OpenAI `gpt-image` models; SVGs over 2 MiB, 20,000 elements or depth 32 are refused |
| Generative Recolor | **Generative Recolor** (Edit › Edit Colors) | The text model returns palettes as strict JSON; the art's colours are mapped to a palette by lightness through Recolor Artwork | Only the colour list is sent, so the model can't see the art; mapping by lightness only; no sample prompts and no Generate field inside Recolor Artwork |
| Generative Shape Fill | **Generative Shape Fill** (Object › Generative) | Art generated for the shape's proportions (optionally its colours), scaled to cover the shape and clipped by it | One closed path or compound path; the art doesn't follow the shape's contours, it is only clipped |
| Generative Patterns¹ | **Generative Pattern** (Object › Generative) | One seamless tile generated, made a pattern swatch `AI Pattern: …`, optionally applied to the selection | Seams depend on the model; the tile is a plain rectangular repeat |
| Generative Expand¹ | **Generative Expand** (Object › Generative) | The image on a larger canvas with a mask goes to the provider's image-edit endpoint; the result replaces the image, original pixels kept exactly, appearance and name kept | One placed raster image; "fill the artboard" only for unrotated images; OpenAI needs a `gpt-image` model |
| Rewrite Text | **Rewrite Text** (Type) | The text model rewrites the selected text in a tone (shorter, longer, formal, casual, fix spelling, custom), one segment per styled run so runs keep their style | One type object; when the run count changes the whole text takes the first run's style |
| Concept to Vector, Prompt to Edit, Mockup¹ | **Not in Nib 0.1.0** | — | Candidates for 0.2 ([ROADMAP.md › Nib roadmap](../ROADMAP.md#nib-roadmap)) |

¹ Not on VectorCraft's G18 list; named here from Adobe's announcements as remembered, and not
re-checked (see the verification note above).

Common to all of them:

- Nothing is sent before the person agrees once in AI Accounts, and only what the feature needs
  goes (the prompt; the colour list, the shape's colours, the selected text or image, or a rendering
  of the selection as a style reference only when asked).
- The provider bills the person's own account. **Stop** stops Nib waiting, but the provider still
  finishes and bills a request already sent.
- Keys are kept in the macOS Keychain or Windows Credential Manager; on Linux and BSD in a file only
  the user can read (no Secret Service yet). They are never in documents, settings, logs or
  automation output.
- Each result is placed as one undo step of ordinary engine commands; Undo restores the document
  exactly.
- Desktop only: the web build has no AI commands. The interface strings are English only so far.
- Not reachable from automation yet: the control-protocol methods, MCP tools and `nib-cli ai`
  commands are specified in [generative-ai.md](generative-ai.md#control-protocol-and-mcp-next-step)
  but not built.

## Cannot be built faithfully

These Illustrator features depend on Adobe's online services, accounts or licences. Nib cannot
offer them and does not imitate them. Its substitutes:

| Illustrator | Why it can't be built | Nib's substitute |
|---|---|---|
| **Creative Cloud Libraries** (synced, shared libraries) | Adobe's sync service and accounts | The local **Libraries** panel (graphics, colours, text styles), with export and import as `.vclibrary` files; keep them in any synced folder |
| **Adobe Fonts** (activation and sync) | Adobe's font service and licences | Fonts installed on the system, plus Nib's own Fonts folder (**Add Fonts** in the Missing Fonts dialog); **Type › Find Font** to replace missing fonts; **File › Package** collects a document's fonts; openly licensed fonts from any source |
| **Adobe Stock** (search, licensing, placing) | Adobe's store and licences | **File › Place** of your own or openly licensed images and SVGs |
| **Firefly** models (and the features built on them) | Adobe's proprietary models, run in Adobe's cloud | Nib's generative features with the person's own OpenAI or Gemini key ([above](#nibs-changes-g18-generative-features)); different models, so different results |
| **Cloud documents** (saving to Creative Cloud, version history, offline sync) | Adobe's storage service | Ordinary files (`.nibart`, `.ai`, PDF, SVG) in any folder, including one synced by another service; Data Recovery for unsaved work |
| **Share for Review** and invite to edit | Adobe's review service and accounts | Export a PDF, SVG or PNG and share it with any review tool; `.nibart` is a documented JSON format, friendly to version control |
| **Adobe Express** and Projects integration, Express templates | Adobe's services | Nib's templates (`.ait` and Nib Template files) and New Document presets |
| **Adobe's bundled content** (swatch, brush, symbol and style libraries, presets) | Adobe's copyrighted assets | VectorCraft's original libraries generated in code (fewer than Illustrator ships), listed in [ASSETS.md](../ASSETS.md) |
| **Illustrator's private editing data** in `.ai` beyond its structure | Undocumented and Adobe's | `.ai` is read through its PDF page and the structure of the editing data, and saved as PDF-compatible `.ai`; see [file-format-parity.md](file-format-parity.md#illustrators-private-editing-data) |

VectorCraft states the same boundary in
[target-app-parity.md › Out of scope](target-app-parity.md#out-of-scope-by-design-or-by-law).
