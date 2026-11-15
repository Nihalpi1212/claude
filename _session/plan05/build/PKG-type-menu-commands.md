# PKG type-menu-commands (package 13, port 8863, entry `lib/type/commands.js`)

Flag of S15: `app.stubbed` lacks `type:warp-text` (every one of the ten ids is real now).

## Files (all type-menu-commands')

- `src/renderer/lib/type/commands.js` (replaces the stub; `install(app)` is async: it imports `../warp.js` for
  `presetControls`), new `outlines.js`, `antialias.js`, `warp-text.js`, `src/renderer/lib/tools/type-mask.js`
- `src/renderer/styles/type-commands.css` (the skeleton's file for this package: still empty, no styles needed)
- `tests/unit/type-menu-commands.test.mjs`, `tests/e2e/type-menu-commands.spec.mjs`, `docs/0.5/type-menu-commands.md`

## API as built

**Render stages** (S11.3, registered at install):
- `warp` (order 100, `bypass` while editing, `extensions` false, `test`: `typeOptions.warp` and not a text extension).
  `geometry(layer)` = the warp's point map in base space; `bounds` = the warped glyphs' box (cached per layer version),
  else the grid-mapped box of `next()`; `render` draws the warped outlines with Canvas 2D (smooth) when every
  character has an outline, else mesh-warps `next()` (`shared/pixels/warp.js meshWarp`).
- `anti-alias` (order 200, `transformed`, **`whileEditing: 'apply'`**, `extensions` false, `test`: method in
  `none | sharp | crisp | strong | windows`; Smooth and Windows LCD are the engine's drawing, the stage is off).
  Draws outlines mapped by `stageGeometry(layer, 200)` and `opts.matrix` with its own area-coverage rasteriser; runs
  with a text stroke or faux bold are drawn by Canvas 2D from the same mapped outlines and their alpha shaped; text
  without outlines (Canvas engine, colour glyphs) shapes `next()` (resampled through the matrix first). While
  type-fonts' hover preview shows a layer (`app.fontPicker.preview.layers`), it shapes `next()` so the preview shows.

**outlines.js** (Node-safe): `layerOutlines(layer)` → `{ complete, runs: [{ style, subpaths, decorations, stroke,
bold }] }` in base space or null (Canvas engine, stacked text); text on a path supported. `layoutOutlines(lay)`,
`outlinePath(layer, { geometry })` → `{ path: PathData (document space, warp then transform), complete }`,
`flattenSubpathPoints(sp, tol, maxSeg)`, `mappedPolygons(subpaths, map, { tol, maxSeg })`, `mapSubpath(sp, map,
{ affine, maxSeg })`, `polygonsBounds`, `signedArea`, `paintOutlines(ctx, ol, map, { scale, tol, maxSeg, colorOf })`.

**antialias.js**: `rasterizeCoverage(polys, w, h)` (exact area, nonzero-like), `coverageCurve(method)`,
`alphaTable(method)`, `shapeAlpha(rgba, method)`, `compositeCoverage(...)`, `drawWithMethod(ol, method, { geometry,
matrix })`, `installAntiAlias(app)`, `STAGE_METHODS`.

**warp-text.js**: `warpBox(layer, lay)` (paragraph frame, else the union of the visible lines),
`warpGeometry(box, warp, controlsFor)` (Vertical transposes the box and swaps the distortions),
`mappedRectBounds`, `installWarpStage(controlsFor)`, `dialogFields()`, `dialogValues(warp)`, `warpFromValues(v)`,
`WARP_STYLE_LABELS`.

**tools/type-mask.js**: `TypeMaskTool` (TypeTool with `mask: true`; ids `type-mask-horizontal`,
`type-mask-vertical`; icons `type-mask`, `type-mask-vertical` via `registerIcons`), `installTypeMaskTools(app)`.
Slot order: Horizontal Type, Vertical Type, Vertical Type Mask, Horizontal Type Mask (Photoshop's). The session's
layer is drawn at opacity 0 and the overlay shows quick-mask red with the letters cut out; `commitSession` makes the
selection from `layer.render()`'s alpha, drops the layer and its creation entry, then `app.applySelection(sel,
maskMode, 'Type Mask')` (one entry; actions record it as Set Selection). `maskMode` 'add' when Shift was held at the
first click. No placeholder text; never edits existing text layers; no type on a path.

**Commands** (labels are the history entries):
- `type:anti-alias` (method) — "Anti-Alias", via `type/target.js applyTypeOptions` (a session step while editing);
  also sets every type tool's `antiAlias` option; no entry when nothing changes. Enabled with a text target.
- `type:warp-text` (warp object, `{ style: 'none' }` / null / `'none'` removes; no argument: the dialog with live
  preview) — "Warp Text"; synchronous with an argument (so an action's next step does not nest under it); replay arg
  is the normalised warp. Commits a type session first; refuses text on a path / stacked text with a message.
- `type:create-work-path` — "Create Work Path" (`tools/vector.js recordPaths`), all selected text layers combined.
- `type:convert-to-shape` — "Convert to Shape" (structural; keeps name, opacity, fill opacity, blend, visibility,
  clip, styles, blending, masks, locks, colour label, link; fill = first character's colour).
- `type:convert-text-kind` ('point' | 'paragraph', else the other) — "Convert to Point Text" / "Convert to Paragraph
  Text"; label function follows the active layer.
- `type:update-all` — no entry; touches text layers, `fontsChanged()`; returns the count.
- `type:paste-lorem-ipsum` — enabled only while a type session edits; a session step.
- `type:toggle-orientation` — "Text Orientation" through `text-path.js setOrientation` (grouped for several layers),
  then the active type tool switches to its `sibling`.
Commands that need outlines on Canvas-engine text toast "…has no glyph outlines: its font is drawn by the browser…"
and add no entry.

## Deviations from the contract

- `anti-alias` stage uses `whileEditing: 'apply'` (S11.3 leaves it open; the default would show Smooth while typing).
- Windows is drawn like Sharp and Windows LCD like Smooth (as S11.3 says); the four curves are approximations.
- The `warp` stage draws from outlines when it can (S11.3 only says it resamples `next()` for text without outlines).
- Convert to Paragraph Text gives a box that grows (`height: null`), not a fixed one.
- `type:warp-text` with a session open commits the session first (Photoshop warps in edit mode too).

## Waiting on other packages / for the integrator

- **psd-text**: until it maps `typeOptions.warp` and `antiAlias` (S11.4), warped text is written to PSD as unwarped
  editable text (warp lost) and the method is not written. My PSD e2e case only checks the text survives.
- No skeleton test is gated on this package beyond `STUB_OWNERS` and the TypeTool sibling test (both pass landed).
- Known failures not mine: `skeleton-05.spec.mjs:858` and `:989` (icc-engine), `tests/unit/psd-registry.test.mjs`
  2 cases (psd-layers).
