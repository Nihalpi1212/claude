# PKG port L2: legacy `.pigment`, adjustments, fills, shapes, vector masks, styles, blending

Package L2 of `planpc/ports/PORTS-A.md` (section 7). Branch `claude/pigment-photocraft`.

## Commits

| Commit | Subject |
|---|---|
| `c2243fb` | Pigment: adjustment, fill and shape layers of Pigment 0.1 to 0.4 open, with vector masks, layer styles and blending |

Pushed. CI was **not** waited for on `c2243fb`: check it first. (CI on `ee0c526`, L1's head, was green when I started.)

## What opens now

`crates/io/src/legacy_pigment/` (all Pigment's own files):

| File | Holds |
|---|---|
| `adjust.rs` (new) | `to_adjustment(kind, params, notes)`: every JS kind, defaults and clamps as the app read them, 0.3 shapes (`perChannel: false`, a single `range`), Levels/Curves in rgb/gray/cmyk/lab, drawn curves (one table makes the whole adjustment `pencil`, every channel the map the app evaluated), Hue/Sat ranges with bounds, Colorize, B&W tint `{hue, sat}`, Channel Mixer constant /100, Color Lookup tables (3D, 1D, domains resampled onto 33³) and **the app's 31 built-in looks ported from `lut.js` `PRESET_FNS`**, Gradient Map through `gradient.rs` with a `GradientSource`. `color-vibrance`, `clarity-dehaze`, `grain` and unknown kinds → `Adjustment::Unsupported { psd_key: "pcJS", raw: {"kind","params"} JSON }` with a warning. |
| `gradient.rs` (new) | The app's gradient model (`gradient-model.js`): v2 defs and every 0.3 shape, midpoints (power bend), Smoothness, classic/perceptual/linear/smooth/stripes, seeded noise (mulberry32, checked against Node). `fill_stops` gives exact stops when classic and unbent, else 128 samples plus both sides of every stop (and of stripes' mid edges). `source()`/`interpolation()` for the editor (not stripes/noise). |
| `paint.rs` (new) | `Patterns` (tiles from `patterns/<id>.png` and `data:` URLs, deduplicated, own 256 MiB budget, base64 decoder), `fill_of` (solid, gradient geometry → PhotoCraft angle/scale/offset over the same frame, pattern placement), `area`/`mask_area` (path operations as the app drew them), `vector_mask`, `shape` (fill, stroke, live shapes). |
| `styles.rs` (new) | `StyleReader::effects`: all ten effects, arrays (top first), `hidden`, contours, glow technique/range/jitter/gradient fill, bevel gloss contour, contour and texture, gradient/pattern overlays and strokes, unknown keys warned. |
| `layers.rs` | `adjustment`, `fill`, `shape` arms; vector mask, styles and `blending` in `common`; shape caches rendered (`photocraft_vector::CompiledShape`, charged to the pixel budget); colours put in the document's mode (`in_mode`). |
| `container.rs` | `decode_png` factored out of `Container::png` (patterns use it); `MAX_PATTERN_BYTES`. |
| `mod.rs` | the new modules; `document.patterns`; `background()` (below). |
| `layer_kinds_tests.rs` (new) | the L2 tests. |

## Where the spec was wrong, or where I chose

1. **Layer masks are the PNG's alpha, not its red channel (L1 bug, fixed here).** The app's masks are white with the mask in alpha (`Selection.toCanvas`, `solidMask`), and its compositor masks with `destination-in`. L1's generator made opaque grey masks, which the app would not mask with at all. Fixed `layers.rs` `mask()`, the generator's `maskCanvas`, and regenerated `v1/v2/v3-masks.pigment` (L1's test values are unchanged: the ramp is now in alpha).
2. **The bottom raster layer named "Background" becomes PhotoCraft's Background** (transparency and position locked) when it has no mask, vector mask or clip: Pigment 0.4 treated it as one (`isBackgroundLayer`), and knockouts reveal it. L1's raster test now expects those locks.
3. **Color Lookup looks are the app's own tables**, not "the nearest PhotoCraft built-in with a warning" as the spec said: the app generated them in code (`PRESET_FNS`), so porting them keeps the look exactly. No warning.
4. **Gradients are sampled from the app's model**, not handed to PhotoCraft's Photoshop-fitted baker (`gradient_bake`): the app's midpoint curve and methods differ from Photoshop's. A Gradient Map keeps a `GradientSource` for the editor; overlays keep a `GradientInterpolation` when not classic.
5. **Fill layer gradients have Align with Layer off** (laid out over the canvas): the app measured them against the document whatever the masks showed. Shape paints align with the layer (frame = the path's control bounds, which is what both the app and `photocraft_vector` use).
6. **The app's box Angle gradient turns counter-clockwise, PhotoCraft's clockwise**: such gradients (effects, shape paints without `from`/`to`) get their stops reversed.
7. **Paths**: without operations the app filled the whole path non-zero, so later subpaths become `PathOp::Join` (holes cut by winding). With operations, leading subtract/intersect subpaths (which act on nothing) are dropped. Vector masks with `initialFill: 'reveal'` follow the PSD importer's convention (leading subtract → `inverted`, later combine ↔ subtract); an intersect after Reveal All warns. An empty hide mask is an empty inverted path.
8. **`fill: null` on a shape is no fill.** The app's `ShapeLayer` constructor turns `null` into its default blue, so a no-fill shape came back blue when 0.4 reopened its own file; I took the intent. The generator now sets `fill = null` after construction, as the app's UI did.
9. **Dashes**: version ≤ 2 files are in pixels (0.3 drew them so), version 3 in stroke widths. The miter limit defaults to 4 (the canvas's), not PhotoCraft's 100.
10. **A pattern-filled shape opens as a pattern fill layer with a vector mask** (PhotoCraft cannot render pattern fills in a shape cache, and its PSD importer does the same). A stroke on such a shape is left out, with a warning.
11. **Live shapes**: rect (radius or radii), ellipse, triangle, polygon/star (starRatio % → ratio, 0.3's `star`/`inset`), line, arrow (head size % of weight → px). Turned or smoothed ones open as paths with a warning; custom shapes are paths (no warning).
12. **Spread and choke** in px become fractions of the size; colour alpha multiplies an effect's opacity; Bevel depth % → /100; effect angles normalized to -180..180.
13. **Effects reference point**: for raster layers `effects.reference = (x, y)` of the layer, where the app tiled linked patterns from.
14. **v1 fixtures for L2 are not committed**: the 0.2 writer (`3731508`) describes these layers byte for byte as 0.3 does (only `version` and the 0.3 document mode fields differ), and its pictures were identical. The generator still writes them for a `v1` run.
15. **The WIP generator** (`make-fixtures-layers.mjs`, from the cut-off engineer) was sound; I added the 0.4 gradient and pattern paint renderers (it drew 0.4 paints as 0.3 did), the alpha masks and `fill = null`.

## Fixtures

`crates/io/tests/fixtures/pigment-0.4/`: 230 v3 and 125 v2 L2 files (`.pigment` + `.png`), about 490 KB; README updated. Run the generator as L1's notes say (the worktrees `js-v1/v2/v3` and `fixgen` are still in the scratchpad, for L3): copy both `make-fixtures*.mjs` next to each other, `node make-fixtures.mjs <checkout>/pigment v3 <out>` from `fixgen`. For `v3` the script stubs `window`/`matchMedia`/`localStorage` and calls `installGradientPaint({})`, `installPatternPaint({})`.

## Tests and results

| Where | Tests | Result |
|---|---|---|
| `cargo test -p photocraft-io --lib legacy_pigment` | 52 (+2 ignored diagnostics) | pass |
| `cargo test -p photocraft-io` (all) | lib 733, integration 595 | pass, except the 3 `svg::` tests in `upstream-test-failures.txt` |
| `cargo test -p photocraft-ui-egui --test it legacy_pigment` | 2 | pass |

New tests (`layer_kinds_tests.rs`): `every_fixture_draws_as_the_app_drew_it` (all 177 pictures; default bound 3 levels max, 0.5 mean; `DIFFERENT_BY_DESIGN` lists 104 fixtures with their own bounds, grouped with the reason: adjustments PhotoCraft computes as Photoshop does, the three unsupported kinds, 0.3's Normal-only adjustment blend, PhotoCraft's half-pixel gradient sampling, anti-aliasing, the app's approximated effects), `tonal_/colour_/other_adjustment_layers_keep_their_settings`, `adjustments_pigment_0_4_added`, `fill_layers`, `shape_layers`, `vector_masks`, `layer_styles`, `layer_styles_of_0_3_and_0_4`, `layer_styles_pigment_0_4_added`, `layer_style_options_patterns_and_where_styles_go`, `advanced_blending`, `opened_documents_save_in_the_new_format_and_open_again`, `hostile_descriptions_of_the_new_kinds`, `colours_follow_the_document_mode`; unit tests in `adjust.rs` (6) and `gradient.rs` (5). Ignored: `print_differences` (prints every fixture's max/mean) and `dump_pictures` (`PIGMENT_DUMP=<dir>` writes our pictures as raw RGBA; `scratchpad/l2/side.py <dir> <fixtures> <names>` makes JS | ours | diff PNGs). L1's fuzz loop now also runs over the L2 fixtures (about 3.5 s for the whole module).

Pixel-exact (≤ 3 levels): channel mixer, invert, threshold, posterize, levels, gradient maps, curves pencil, color lookups, B&W, selective color relative, most shapes and fills, vector masks within the feather, Blend If, channels, knockout, colour overlay, drop shadows, patterns.

Checks: `cargo fmt --all -- --check` clean; `cargo clippy -p photocraft-io --all-targets -- -D warnings` clean; `python3 scripts/pigment-rebrand.py --check` clean (it changed "PhotoCraft" to "Pigment" in five warning strings; tests follow). Not run: workspace clippy/tests (CI does), panic hunt and xtask checks (no command, crate, preference or panel command added).

## Hooks into upstream files

None new. Every file L2 touched is Pigment's own (`crates/io/src/legacy_pigment/`, the fixtures, `README.md`, `docs/RELEASE-NOTES-0.5.0.md`, `docs/FORK.md`). `docs/FORK.md` "Opening documents from Pigment 0.1–0.4" lists the new files and what converts; its rebrand table row no longer says "refused".

## For L3

- The `other =>` arm of `LayerReader::layers` still has `text` and `smart`; `LayerReader` now has `version`, `mode`, `canvas` and `patterns` you can use. `ids` (file id → `LayerId`) is still filled and unused (for `sourceRef`).
- Smart filters `adjust:<kind>` can call `adjust::to_adjustment(kind, params, &mut notes)`; its params are the app's.
- Effects on text and smart layers come through `common` already; the effects reference is set only for raster layers (the app anchored at the layer's rendered box; for text and smart objects that is `render().x/y`).
- README, release notes and FORK.md now say only text layers, smart objects and their filters are left: finish those lines.
- Known gaps: a stroke on a pattern-filled shape is dropped; FxPaint::Pattern has no angle/link/phase (pattern strokes anchor at the effects reference); effect gradients' box geometry is mapped directly (the app's radial reach is half the larger side, PhotoCraft's an ellipse norm: equal for square boxes); noise gradients are sampled at 128 points plus stops (fine for roughness up to 1: 64 knots).
- Disk: 14 GB free at the end.
