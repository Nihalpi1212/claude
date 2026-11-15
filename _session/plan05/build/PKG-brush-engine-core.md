# PKG brush-engine-core (package 1, sequence A, port 8851) — landed

ENGINE.id is now `'pigment-0.5'` (version 2), every `ENGINE.features` flag true, `modifiersFor:
['shapeDynamics', 'scattering', 'colorDynamics', 'transfer']`. The skeleton's gated tests now run their landed branch.

## Files (all mine)

- `src/renderer/lib/brush/engine.js` — BrushStroke, traceDabs, the modifier chain, strokeReach, renderStrokePreview,
  normalizeSample, ENGINE, runBufferModifiers (unchanged names and signatures from the stub).
- `src/renderer/lib/brush/stroke.js` (new, pure) — `Placement` (placement, smoothing modes, smoothCurves, spacing off,
  build-up ticks), `effectiveSize`, `dabFlow`, `accumulateCeiling(dst, src, o, f)`, `dissolveNoise(x, y, seed)`,
  `BUILD_UP_INTERVAL` (1000/30 ms), `LEASH_PX` (120), `CATCH_UP_RATE` (0.25).
- `src/renderer/lib/brush/dynamics.js` (new, pure) — `controlFactor(control, { index, sample })`,
  `controlAngle(control, { index, sample, direction, initial })`, `tiltAmount(sample)`, `rgbToHsb`, `hsbToRgb`, the four
  modifiers `shapeDynamics` (id 'shape-dynamics', order 100), `scattering` ('scattering', 200, with `reach`),
  `colorDynamics` ('color-dynamics', 300), `transfer` ('transfer', 400); `ENGINE_MODIFIERS`, `ENGINE_SECTIONS`.
  engine.js registers them at import with `registerDabModifier` (so a later registration with the same id replaces one).
- `src/renderer/lib/brush/tips.js` (new) — `registerTipKind(kind, { render, outline })` (returns unregister),
  `tipKind(tip)`, `tipOutline`, `renderTip`, `tipImage(tip, size, color, { hardness, aliased, cache })`,
  `sampleDab(tip, size, color)`, `atDrawSide`, `traceContours(values, w, h, level)` (marching squares). Kinds
  'computed' (0.4's dab raster, analytic ellipse outline) and 'sampled' (sampleCanvas, traced contour outline; the
  sample's box until decoded) are registered. engine.js re-exports registerTipKind / tipOutline / renderTip, so
  `lib/brush.js` still has them.
- `src/renderer/lib/brush/options.js` — `PAINT_BLEND_OPTIONS` is now Normal, Dissolve, Behind, Clear, then the rest.
- `src/renderer/lib/brush/define.js` — MODULES entry: `edit:define-brush` (arg `{ name }` or a string; `{ dialog: true }`
  or menu/key source asks), `tool:airbrush-toggle` (arg: tool id; enabled for 'full' brush tools except the Pencil;
  `checked`), two options-bar slots: `brush-engine:airbrush` (order 10, `.opt[data-key="airbrush"] button`,
  aria-pressed) and `brush-engine:smoothing-options` (order 11, `.opt[data-key="smoothingOptions"] button`, a popover
  writing `settings.tools[id].smoothingOptions` through `app.tools.setOptions`). Exports `coverageOf`,
  `coverageBounds`, `MAX_TIP`. Icons `airbrush`, `smoothing-options` via registerIcons.
- Tests: `tests/unit/brush-engine-core.test.mjs` (17), `tests/e2e/brush-engine-core.spec.mjs` (8),
  `tests/electron/brush-engine-core.spec.mjs` (1). Docs: `docs/0.5/brush-engine-core.md`.

## The API as built (what the next packages use)

- Dab fields: `x, y, size, angle, roundness, flipX, flipY, opacity, flow, color ([r,g,b] 0..255), tip, index (placed dab
  number; scattered copies share it), t, sample, direction (degrees of travel; 0 for a path's first dab), seed,
  pressure`. Geometry modifiers may change any of them; `dab.opacity < 1` sends the dab through the per-pixel ceiling
  path (cost: one getImageData/putImageData of the dab box).
- `coverage` modifiers get `{ data: Float32Array, width, height, x, y, scale }` over dab box ∩ canvas ∩ selection
  bounds; `scale < 1` (one mask px per 1/scale canvas px) when the box is over 1024 px. The masked dab is accumulated
  at the dab's flow (or toward its opacity ceiling).
- `buffer` modifiers: as the stub (straight RGBA8 copy per flushed rect, scale A only). With a buffer modifier the
  stroke's end composites the whole stroke once more; without one the end composites only what is still pending.
- `traceDabs(samples, settings, { seed, finish, modifiers, zoom })`: samples may include `{ break: true }` (sub-path)
  and `{ tick: ms }` (time passing at rest: build-up and Stroke Catch-up). `zoom` is for Pulled String's Adjust for Zoom.
- `BrushStroke.tick(now)` returns the dabs placed (`now` in the samples' clock); the stroke's own rAF loop runs while
  `preset.buildUp` or `smoothingOptions.catchUp` is on and passes performance.now() shifted to the samples' clock (set
  at begin), so partial samples without `time` (1 ms per px from 0) do not owe build-up dabs for the time since load. `stroke.leash` is `{ from, to }` in document px (Pulled String, while the pointer
  is away from the brush) or null.
- Painting modes in `paint.blend`: `'behind'` (destination-over), `'clear'` (destination-out), `'dissolve'` (per pixel,
  noise by document pixel and stroke seed). Both Behind and Clear paint nothing with `lockTransparency`.
- Pressure overrides: `paint.pressureSize` true makes Shape Dynamics ignore a `pen-pressure` size control (0.4's
  placement already scales by pressure); `paint.pressureOpacity` true makes Transfer ignore a `pen-pressure` flow
  control (0.4's flow scaling stays). Transfer's opacity control always acts on `dab.opacity`.
- Smoothing: `smoothingOptions.mode 'average'` is 0.4's (the release always catches up); `'pulled-string'` uses a leash
  of `smoothing × 120` screen px (÷ view zoom with adjustForZoom); its release reaches the release point only with
  `catchUpOnEnd`.
- Large dabs (size > 128 px) are placed at whole pixels and, when the same size repeats, drawn from an exact-size copy
  of the 1 % step cache (no scaled draw per dab).

## Deviations from the contract

1. Computed tips keep 0.4's dab raster (dabCanvas) rather than an analytic per-pixel tip: S2.3's tolerance (3 levels)
   rules out a different soft falloff. Every golden case is still **pixel-equal** in the legacy and preset forms (max
   difference 0, checked case by case), and the tools form passes brush-golden.spec. The outline is analytic.
2. `traceDabs` accepts `{ tick: ms }` entries and a `zoom` option (extras), so build-up and Pulled String are pure and
   Node-tested.
3. Define Brush Preset samples what the document shows (all visible layers) inside the selection, like Define Pattern,
   not the active layer alone. Spacing of a defined tip is 25 % (Photoshop's default for sampled tips), hardness 1.
4. `end()` flushes only the pending rect (the whole dirty rect again only when a buffer modifier runs), so a large
   stroke's release does not composite its whole box twice. Pixels are identical (every flushed rect already holds the
   buffer over the backup).
5. `renderStrokePreview` drives a pressure that rises and falls along the path (min 0.05) and turns build-up off; with
   `paint.pressureSize` true the preview tapers (the Brushes panel's stroke view will show that).
6. The sampler path (Clone Stamp and friends) now turns and squashes its mask with the dab's angle and roundness (the
   stub drew it unrotated). The clone golden (angle 0, roundness 1) is unchanged.
7. The S2.8 gated case in `repaint-speed.spec.mjs` fails on this machine (see "Integrator").

## Tests that wait for another package

None of mine skip. brush-settings-panel's modifiers (Texture, Dual Brush, Noise, Wet Edges, Brush Pose) join the
chain when they register; until then those sections paint as off. The S2.8 case in repaint-speed.spec measures a
stroke with Texture enabled, which paints as off until brush-settings-panel registers its modifier.

## Integrator

- **repaint-speed.spec.mjs:421 (S2.8 gated case) fails**: `full` runs = 1 to 2 (expects 0) and ~70 ms per dab (expects
  < 25). Measured: the engine's own work is ~13 ms per 2500 px dab including its flushes (no view); each frame of the
  test (one per pointer move) costs ~45 ms of stroke flush plus ~65 ms of `Compositor.composite` region repaint plus
  ~30 ms of the view's display draw, for 3 to 4 dabs. A frame whose dabs cover more than `REGION_MAX` (0.45) of the
  4000 × 4000 document becomes a full composite (2500 px dabs 125 px apart: 4 dabs ≈ 47 %). Both limits are in
  canvas-view.js / compositor.js (skeleton). Options: raise the budget or the region limit for this case, make the
  region path not copy the whole 16 MP back buffer per frame, or have the view preview during large strokes.
- No stylesheet for brush-engine-core exists in `index.html`; the two options-bar buttons reuse `.opt` / `.seg-button`
  (no styles needed). If a sheet is wanted later, `styles/brush-engine.css` needs a link in index.html.
- `docs/0.5/brush-engine-core.md` has the user guide, release notes (Shift+Alt+P, the Mode menu, Transfer's ceiling,
  whole-pixel large dabs, the end-of-stroke repaint, the tapering preview) and known gaps.
