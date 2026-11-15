# PKG brush-settings-panel (package 2, sequence A, port 8852) — landed

S15 flags: `app.stubbed` lacks `window:panel-brush-settings` (the panel registers it) and `ABR_REAL === true`
(`lib/brush/abr.js`). preset-files-manager's .tpl dynamics assertions run their landed branch now.

## Files (all mine)

- `src/renderer/lib/panels/brush-settings.js` — MODULES entry. Importing it registers the five modifiers (it imports
  `lib/brush/extras.js`, `texture.js`, `dual.js`); `install(app)` registers .abr (`registerAbrFormat(app)`) and the
  panel `brush-settings` (group 'top'; panels.js registers `window:panel-brush-settings`). Exports `install`,
  `sectionOn(preset, id)`, `clearedBrush(app, toolId)`, `copySection(app, fromTool, toTool, id)`.
- `src/renderer/lib/panels/brushes.js` — the Brushes panel (id 'brushes', unchanged) and `app.brushPicker`.
- `src/renderer/lib/brush/abr.js` — .abr both ways (replaces the stub, keeps its exports).
- `src/renderer/lib/brush/texture.js`, `dual.js`, `extras.js` (new) — the modifiers.
- `src/renderer/styles/brush-settings.css` (the stylesheet link was already in index.html).
- Tests: `tests/unit/brush-settings-panel.test.mjs` (11), `tests/e2e/brush-settings-panel.spec.mjs` (9).
- Docs: `docs/0.5/brush-settings-panel.md`.

## The API as built

**Dab modifiers** (registered at import with `registerDabModifier`; none adds reach, each has `reach: () => 0`):

| id | order | stage | enabled when |
|---|---|---|---|
| `brush-pose` | 50 | `sample` | `brushPose.enabled` |
| `texture-tip` | 500 | `coverage` | `texture.enabled && texture.eachTip` |
| `texture` | 510 | `buffer` | `texture.enabled && !texture.eachTip` |
| `dual-brush` | 600 | `coverage` | `dualBrush.enabled` |
| `noise` | 700 | `coverage` | `noise` |
| `wet-edges` | 800 | `buffer` | `wetEdges` |

Pure helpers (Node-tested): `extras.js` `tiltToAngles`, `posedSample(sample, pose)`, `pixelNoise(x, y)`,
`noisyCoverage(c, n)`, `applyNoise(mask, ox, oy)`, `erode(plane, w, h, r)`, `applyWetEdges(img, radius, inside)`,
`wetRadius(size)`, `WET_INSIDE` (0.5), `WET_FULL_PIXELS`, `EXTRA_MODIFIERS`; `texture.js` `contrastFactor`,
`patternHeights(img, { invert, brightness, contrast })`, `textureBlend(mode, c, h, depth)`, `applyTextureToMask(mask,
heights, { ox, oy, scale, mode, depth })`, `applyTextureToBuffer(img, rect, heights, …)`, `tipDepth(texture, dab, rnd)`,
`strokeHeights(texture, app.patterns)`, `TEXTURE_MODIFIERS`; `dual.js` `computedTipRaster(size, hardness)`,
`dualCombine(mode, c, d)`, `DualTrail`, `dualCoverage(mask, dabs, raster, { ox, oy, size, angle, roundness })`.

- Texture's pattern: `texture.pattern` (`{ presetId, name }`, or with `dataUrl` when it has no preset), else the current
  pattern (`app.patterns.currentId()`); pixels at stroke start through `app.patterns.resolve`; a missing pattern turns
  the texture off for that stroke with one toast (none in previews) and asks `app.patterns.get` for next time. The
  pattern is anchored at the document origin (document px = stroke-canvas px + `ctx.stroke.target.x/y`).
- Brush Pose: for a non-pen sample the pose's tilt (±1 → ±90°, at most 89), rotation and pressure replace the sample's;
  for a pen only where `override*` is set.

**Brushes panel / picker** (`lib/panels/brushes.js` exports): `BUILTIN_BRUSHES` (kept), `BUILTIN_BRUSH_GROUPS`
(`general`, `airbrushes`, `special`, `media`), `MEDIA_BRUSHES` (6 built-ins `media-*` using the new sections and
built-in patterns `noise`, `burlap`), `registerBrushKind()` (re-registers `brushes` with groups, the media brushes and
`thumbnail(preset, size)`), `brushPrefs(app)`, `saveBrushPrefs(app, patch)`, `paintTarget(app)`, `editToolBrush(app,
toolId, mutate)` (setToolBrush with respectLocks and includeTool off), `sourcePreset(app, toolId)`, `isModified(app,
toolId)`, `pickPreset(app, preset, tool)` (runs `tool:brush-preset` `{ id, tool }` from source 'panel'),
`tipThumb(data, px, { app, onReady })`, `strokeThumb(app, data, { width, height, paint, maxSize })`,
`angleRoundnessControl({ size, onChange })` → `{ element, set(angle, roundness) }`, `sliderRow(spec)`,
`presetBrowser(app, opts)`, `newBrushPresetDialog(app, tool)`, `BRUSH_PRESET_MIME` ('application/x-pigment-brush-preset',
in-panel drags), `install`.

`app.brushPicker = { show(anchor, tool), renderButton(el, tool), applyPreset(presetOrId, tool), presets() }`.
`applyPreset` of a stored preset runs `tool:brush-preset`; any other (0.4 flat) preset goes straight to `setToolBrush`.

Settings (`settings.brushes`, rule 5): `locks`, `recent` (preset ids, newest first, at most 12, filled on every
`command:done` of `tool:brush-preset` whose id is stored), `view` ('thumbs' | 'list' | 'strokes'), plus undeclared
sub-keys `collapsed` ({ groupId: true }), `section` (the selected Brush Settings section) and `mediaPlaced` (see
deviations).

**.abr** (`lib/brush/abr.js`): `ABR_REAL = true`; `brushFromAgPsd(brush, samples, { patternRef } = {})` (the third
argument is new and optional: `patternRef(id, name)` returns what goes into `texture.pattern`, e.g. a `$presetRef`;
without it a textured brush keeps `pattern: null` and reports it); `readAbrFile(bytes, { name })` → `{ items, groups,
report }`; `writeAbrFile(presets, { readBlob, patternPixels })` → `{ bytes, report }`; `brushDescriptor(preset, ids)`;
`registerAbrFormat(app)`. The format: `{ id: 'abr', name: 'Photoshop Brushes', extensions: ['abr'], kinds: ['brushes',
'patterns'] }` through `registerPresetFileFormat`.

For preset-files-manager's .tpl: `parseBrushDescriptor(raw)` does not read build-up or the Smoothing box; pass
`{ ...parseBrushDescriptor(raw), buildUp: raw['Rpt '] === true, smoothCurves: raw.Smoo === true }` to
`brushFromAgPsd` to get them, as `readAbrFile` does.

## Deviations from the contract

1. **Every modifier's reach is 0**: none puts paint beyond the brush's own dabs (Dual Brush only masks them; the pose
   never raises pressure above 1). The contract's "Dual Brush, Pose" reach examples do not apply to this design.
2. **Texture is two modifiers** ('texture-tip' 500 coverage, 'texture' 510 buffer): the engine picks stages by the
   presence of a hook, so one modifier cannot be a coverage modifier for Texture Each Tip and a buffer one otherwise.
3. **Wet Edges is a `buffer` modifier** (the contract lists it among the coverage examples): the edge of the stroke is
   a property of the accumulated stroke, which tight spacing would otherwise fill in. The engine re-composites the
   whole stroke at the end when a buffer modifier runs, so frame-rect edges never show in the result.
4. **Media brushes**: six new built-ins of `brushes`. Re-registering the kind after the store read the user's file
   appends them after the user's presets; once per profile (`settings.brushes.mediaPlaced`) they are moved up through
   `app.presets.state('brushes').order`, as tool-brush.js's migration does (skeleton-05 "migrate once" needs 0.4's
   presets after every built-in).
5. **Panel edits are not commands**: Brush Settings and the Brushes panel's Size write the tool's settings directly
   (as 0.4's Brushes panel did with `setOpt`); preset picks go through `tool:brush-preset`. Library actions (new,
   rename, duplicate, delete, groups, reorder) are panel actions on the preset store, not commands (S13.1).
6. "Reset All Locked Settings" is **Unlock All Settings** (it clears the locks).
7. **Engine gap worked around**: without a geometry modifier the engine hands `coverage` dabs without `index` and
   `sample` (BrushStroke.dab's fast path). 'texture-tip' counts dabs itself and reads `ctx.stroke.current` for the pen
   controls of its depth; 'dual-brush' treats each index-less dab as its own placed dab. brush-engine-core could pass
   `index` and `sample` there (one object; no cost) — then the workaround is unused.

## Tests that wait for another package

None skip. `tests/e2e/repaint-speed.spec.mjs:421` (S2.8's gated case) now paints its texture (it painted as off before
this package) and still fails on `full` runs = 1 as brush-engine-core reported (the compositor's region limit, skeleton
code); its time per dab is now the engine's coverage path plus Texture (see the cost below).

## Cost on the stroke path (measured in Chromium on this machine, one flush per dab, 4 CPUs under load)

| case | 2500 px soft dab, 4000 × 4000 canvas | 100 px dab, 1500 px canvas |
|---|---|---|
| plain | 45–53 ms per dab | 0.5 ms |
| Texture Each Tip | 130–138 ms (the engine's coverage stage ~80, the texture loop on the 1024² reduced mask ~12) | 1–1.4 ms |
| Texture (whole stroke) | 176 ms per frame of 6.25 MP (the engine's buffer copy ~120, the texture ~20 with its lookup table) | 0.3 ms |
| Dual Brush | 158–164 ms (dual coverage 60–80) | 1.5–2.7 ms |
| Noise | 130 ms (noise loop ~18) | 1 ms |
| Wet Edges | 235 ms per frame of 6.25 MP (erosion on 3 × 3 blocks above 1 MP; ~90 ms of it mine) | 0.3 ms |
| Brush Pose | no measurable cost | no measurable cost |

A stroke with none of these sections enabled costs nothing extra (`enabled` false: the modifier never runs).

## Integrator

- Nothing outside my files was needed. Optional for brush-engine-core: pass `index` and `sample` on the fast-path dab
  (deviation 7).
- The panel's group is 'top' (with Brushes, Color, Swatches…); a short dock scrolls it.
- Window > Brush Settings: F5 shows the panel (0.4's meaning of the panel commands; Photoshop toggles — recorded in S13.3).
