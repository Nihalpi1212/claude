# REL-docs: the documentation for Pigment 0.5.0

Commit `1fc64f3` on `claude/pigment-photocraft`, pushed (documentation only; no Rust touched, no
cargo run). CI on it was not waited for. Before committing: `python3 pigment/scripts/pigment-rebrand.py --check`
clean, `bash pigment/packaging/linux/package-docs-test.sh` passed, and a relative-link and anchor
check over every changed page (`reldocs/links.py`) clean apart from an upstream example in
`docs/user/AGENTS.md`.

## What changed

- **`pigment/docs/parity/README.md` (new).** Pigment 0.5.0 against the 1,432 Photoshop entries:
  907 done, 304 partial or approximate, 153 missing, 68 not feasible, per area, with the three apps'
  totals. Pigment 0.5.0 = PhotoCraft's audited column plus: the 10 AI entries at Pigment 0.4's
  statuses (Generate Image Partial, Describe and Assistant Done, the rest Approximate), the
  contextual task bar's generative entries Missing -> Partial, Automatic updates Partial -> Missing
  (Pigment makes no update check). The 93 Pigment-ahead entries: 10 AI in 0.5.0, 83 each with its
  0.6 package (A1–A7, P1a–P4, F1–F3, U1–U4, B1–B18 from PORTS-A/B); 11 marked † were only in the
  JavaScript app's unfinished 0.5 (from the audit's pigmentNote overrides). Method section, and
  links to upstream's target-app-parity, gaps, scorecard, parity-checklist and ROADMAP.
- **`docs/user/` rewritten for Pigment** (every page; file names kept for merges): install
  (Pigment's releases, three platforms, unsigned first-launch steps, 0.4 replaced by the
  installers), getting started, guides (Pigment file type, Export As's seven formats incl. ICO and
  JPEG XL, open list from `OPEN_FILTERS`), FAQ (free, PSD, replace Photoshop with the numbers),
  troubleshooting (Pigment's log paths `pigment.log`, issue tracker instead of Discord; the
  PhotoCraft-version pages say the fixes are included). New `guides/use-generative-ai.md`; the
  old-documents page gained "Pigment 0.4 features not in 0.5 yet". `docs/user/AGENTS.md` has a
  Pigment paragraph. Every page `verified: 0.5.0`.
- **README:** "Compared with Photoshop" link, the importer in "What Pigment adds", the 83 features
  still to come in "Pigment 0.4 and earlier", Status rewritten with the numbers and the upstream
  note; JPEG XL corrected (it is written, not read: checked with `target/debug/pigment-cli convert`,
  AVIF neither read nor written).
- **Release notes:** an "In short" list, "Not in 0.5.0 yet" (the 83, grouped), Known issues
  rebuilt from PKG-ai-final.md §1–3 and PKG-port-review-L.md findings 4–8 (AI untested live, the
  ChatGPT sign-in, key stores never run on real macOS/Windows, document lock, Stop and billing,
  provider Remove Background needs pixels, typed model names, Assistant fills and the agents
  switch, Windows `ai set-key` echo, memory on 48 MP; importer: different adjustments, the
  double Save on close, slow huge type/shapes; unsigned builds, three platforms, abb30df and
  PhotoCraft's own limits, English-only strings). No "## Downloads" section (the workflow adds it).
- **FORK.md:** new "Upstream after the import" (main at 6dbe43e on Nov 18, 1,760 files, +127k
  −278k since abb30df, 172 commits since Nov 15; not merged for 0.5.0; merge planned as its own
  step right after the release, before group A), "The user guide" section, the hook row for
  `docs/user/`, and three anchors that never worked fixed (`…-pigment-0104`).

## The audit's map, rebuilt

The row-by-row map was lost, but the reviewers' working data survived for seven of eight areas:
`photocraft-eval/pc_rows.py` (File/Edit), `work/tools_pc.py`, `type_pc.py`,
`scripts/fca_data.py` (Formats), `work/ev_*.json` (Select/Filter/View), `work/pw_data.py`
(Panels and More), with the JS rows from `*_rows.json` and the JS parity pages. `reldocs/rebuild.py`
rebuilds them into `reldocs/map/*.jsonl` (1,229 rows). Status counts match area-table.md exactly
in all seven areas; Pigment-ahead counts match everywhere; "who is ahead" differs only by 2 depth
calls in Type and 1 in Formats (Select/Filter/View matches once both-not-feasible rows count as
"neither"). Image and Layer's per-row PhotoCraft statuses (`work/il_*.tsv`) are gone.

## The sample (48 entries; 47 agreed)

Seven areas: 2 Done, 2 Partial/Approximate, 1 Missing, 1 Pigment-ahead, drawn at random
(seed 20261118, `reldocs/sample.json`); Image and Layer: 6 of its 20 Pigment-ahead rows. Each
checked by reading or grepping the Rust tree (and craft-libs for IFF).

| # | Area | Entry | Audit's PhotoCraft status | Result |
|---|---|---|---|---|
| 1 | file-edit | Define Custom Shape | Done | agrees |
| 2 | file-edit | Content-Aware Fill: Output To (Current Layer, New Layer, Duplicate Layer) and li | Done | agrees |
| 3 | file-edit | Export As: preview with zoom and 2-up comparison | Partial | agrees |
| 4 | file-edit | Save As: format list | Partial | agrees |
| 5 | file-edit | Technology Previews | Missing | agrees |
| 6 | file-edit | Cursors: Other Cursors (Standard / Precise), Brush Preview colour, brush leash c | Partial | agrees |
| 7 | formats-color-automation | IFF (Amiga / Maya) | Done | agrees |
| 8 | formats-color-automation | PSD: slices | Done | agrees |
| 9 | formats-color-automation | File Info: Basic tab | Partial | agrees |
| 10 | formats-color-automation | Display profile handling | Partial | agrees |
| 11 | formats-color-automation | Keyframe animation (position, opacity, style, transform, text warp, masks), tran | Missing | agrees |
| 12 | formats-color-automation | Actions: default and bundled action sets | Missing | agrees |
| 13 | more | Photoshop template files (.psdt) | Done | agrees |
| 14 | more | Brush Settings: attribute locks and Clear Brush Controls | Done | agrees |
| 15 | more | Camera Raw: filmstrip, settings sync across images, ratings and Save Image | Partial | agrees |
| 16 | more | Delete and Fill Selection | Approximate | agrees |
| 17 | more | Camera Raw: Photo Merge (HDR, Panorama, HDR Panorama) | Missing | agrees |
| 18 | more | Select Similar Layers | Missing | agrees |
| 19 | panels-workspace | Actions: Playback Options (Accelerated / Step by Step / Pause For) | Done | agrees |
| 20 | panels-workspace | Floating panels and floating panel stacks | Done | agrees |
| 21 | panels-workspace | Automatic updates | Partial | agrees |
| 22 | panels-workspace | Status bar menu: Scratch Sizes, Efficiency, Timing, Current Tool | Approximate | agrees |
| 23 | panels-workspace | Video timeline: transitions (Fade, Cross Fade, Fade with Black / White / Color) | Missing | agrees |
| 24 | panels-workspace | Pen tablet: tilt, rotation, barrel wheel, eraser end, side buttons | Partial | agrees |
| 25 | select-filter-view | Zoom In / Zoom Out | Done | agrees |
| 26 | select-filter-view | Color Range inside an existing selection | Done | agrees |
| 27 | select-filter-view | Color Range: Skin Tones and Detect Faces | Partial | agrees |
| 28 | select-filter-view | Blur: Lens Blur | Partial | agrees |
| 29 | select-filter-view | Camera Raw: Color Mixer 'Color' view, Targeted Adjustment tool, Point Color | Missing | agrees |
| 30 | select-filter-view | Select and Mask: Refine Mode (Color Aware / Object Aware) | Partial | agrees |
| 31 | tools | Patterns panel and pattern picker | Done | agrees |
| 32 | tools | Clone Source panel | Done | agrees |
| 33 | tools | Color Picker: sample from the image or anywhere on screen while open | Partial | agrees |
| 34 | tools | Direct Selection tool | Partial | DISAGREES: arrow-key nudge exists (direct_select.rs:10, :915), so Done, not Partial |
| 35 | tools | Path alignment and path arrangement | Missing | agrees |
| 36 | tools | Pen tilt, barrel rotation and stylus wheel input | Partial | agrees |
| 37 | type | Paragraph text in a bounding box (width and height) | Done | agrees |
| 38 | type | OpenType: Contextual Alternates toggle | Done | agrees |
| 39 | type | PSD export: text stays editable in Photoshop | Partial | agrees |
| 40 | type | Load Default Type Styles / Save Default Type Styles | Partial | agrees |
| 41 | type | East Asian typography: Tsume, Aki, Mojikumi, Kinsoku Shori, Burasagari, characte | Missing | agrees |
| 42 | type | Hyphenate, and the Hyphenation settings dialog | Missing | agrees |
| 43 | image-layer (ahead row) | Curves: display options and Show Clipping | Missing | agrees (nothing in adjust_editors) |
| 44 | image-layer (ahead row) | Hue/Saturation: range sliders and range eyedroppers | Partial | agrees (range bar, no range eyedroppers) |
| 45 | image-layer (ahead row) | Auto Color Correction Options | Missing | agrees |
| 46 | image-layer (ahead row) | HDR Toning | Partial | agrees (HdrToning has no method) |
| 47 | image-layer (ahead row) | Match Color (Save/Load Statistics) | Partial | agrees |
| 48 | image-layer (ahead row) | Properties: fill layer (solid colour) | Partial | agrees (gradient only in layer_props_ui.rs) |

## For the review step

- **Help › Learn opens a page that does not exist.** `crates/ui-egui/src/links.rs` `TUTORIALS` is
  `https://github.com/Nihalpi1212/claude/tree/HEAD/pigment/docs/user`; `HEAD` is the repository's
  default branch, `claude/fervent-newton-263lz3` (the JS app's), which has no `pigment/docs/user`.
  Point it at `tree/claude/pigment-photocraft/pigment/docs/user` (or the release tag), or change
  the default branch. Code change, not made here.
- If the fix step leaves any hunt finding unfixed that a user would notice, add it to the release
  notes' Known issues (they list only the AI and importer reviews' open items).
- The user guide pages carry `verified: 0.5.0`; claims were checked against the code for labels,
  menus, formats, folders and preferences touched by the rewrite, not every sentence of the
  upstream pages kept as they were (adjustments, selections, type, canvas size).
- The parity page's 0.5.0 counts carry the audit's known biases: 4 PhotoCraft Done that the checker
  rated Partial, the 49 Done rows naming a missing option, and the Direct Selection under-count
  found here; none is applied to the counts, all are stated on the page.
