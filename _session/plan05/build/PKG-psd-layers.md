# PKG psd-layers (package 5, sequence B 2/7, port 8855) — landed

`psdFeatures()` now reports `effects`, `advancedBlending`, `vectorMasks`, `shapes`, `fills`, `tags`, `globalLight` all
true (`textRuns` stays psd-text's). `fixesPatched.layers === true`. S14.2's three gated PSD specs pass their landed
branch (hunt5-styles:106, adjustment-blending:350, masks-vector-masks:232), and skeleton-05 "psd" passes (with `tags`
true no golden is compared exactly any more; my own spec checks that the `adjustments` and `guides` goldens are still
0.4's byte for byte, and `text` / `grayscale` are identical too while psd-text is a stub).

## Files (all mine)

- `src/renderer/lib/psd/effects.js` — aspects `effects` 400 and `advanced-blending` 210; notices `psd-effects` (open),
  `psd-effects-save` (save). `PSD_FEATURES = { effects: true, advancedBlending: true }`.
- `src/renderer/lib/psd/vector.js` — kind `shape` 350, aspects `vector-mask` 290 and `raster-mask` 300 (re-registered,
  not builtin); notices `shape-vector-mask`, `psd-shape-pattern` (save), `psd-vector-dropped` (open).
  `PSD_FEATURES = { vectorMasks: true, shapes: true }`.
- `src/renderer/lib/psd/adjustments.js` — kind `adjustment` 200 (no longer `{ builtin: true }`), kind `fill` 300, aspect
  `adjustment-placeholder` 110; notices `psd-adjustment-unread`, `psd-fill-dropped` (open). `PSD_FEATURES = { fills: true }`.
- `src/renderer/lib/psd/tags.js` — aspect `tags` 500, resources `global-light` 250 and `link-groups` 510 (extra);
  `install(app)` → file-handling.js. `PSD_FEATURES = { tags: true, globalLight: true }`.
- new `src/renderer/lib/psd/paints.js` — shared paint conversions (Node-safe).
- new `src/renderer/lib/psd/file-handling.js` — the save option and the Preferences section (Node-safe at import;
  loads `documents.js` / `form.js` dynamically).
- `scripts/vendor-entries/ag-psd-layers.js` — the ag-psd fixes (below). **Rebuild the bundle after checkout**:
  `node scripts/build-vendor.mjs` (I rebuilt only the ag-psd bundle, with the same esbuild options).
- Tests: `tests/unit/psd-layers.test.mjs` (11), `tests/e2e/psd-layers.spec.mjs` (12), `tests/electron/psd-layers.spec.mjs` (1).
- Docs: `docs/0.5/psd-layers.md`.

## API as built (for preset-files-manager and later packages)

All Node-safe; import from `/lib/psd/effects.js`, `/lib/psd/vector.js`, `/lib/psd/paints.js`.

- `stylesFromPsd(effectsInfo, { patterns = new Map(), descriptor = null, profile = null }) → { styles | null, report: string[] }`
  - `effectsInfo`: ag-psd's `LayerEffectsInfo` (a layer's `effects`; for an .asl style: ag-psd's `parseEffects(desc)` of
    the style's `Lefx` descriptor, '#ag-psd' internal).
  - `patterns`: `Map` of PSD pattern id → ag-psd PatternInfo (for .asl: the file's patterns section read with
    `readPattern`). Pattern effects get a PatternRef `{ presetId: null, name, dataUrl }` (renderer only: Node has no
    canvas, so there a pattern effect reads as disabled with `pattern: null` and a report line).
  - `descriptor`: the raw lfx2 / lmfx descriptor (`pl.effectsDescriptor`, kept by the fix; for .asl pass the same
    `Lefx` descriptor) — needed for what ag-psd does not parse (Bevel Contour vs gloss contour, texture depth and
    invert, contour corner points, Stroke Shape Burst, stroke pattern scale / angle). Without it those fall back.
  - `report`: one line per approximated or dropped setting, by name ("Bevel & Emboss (Stroke Emboss, read as Emboss)",
    "Stroke (Overprint)", "Pattern Overlay (pattern Gone)"…). The layer aspect adds them to the open notice `psd-effects`.
  - The effects scale (`effectsInfo.scale`) is applied (`scaleEffects`); `disabled` gives `styles.hidden = true`.
- `stylesToPsd(styles, { resolvePattern?(ref), app? }) → { effects | null, patterns: PatternInfo[], report: string[], extra }`
  - `effects`: ag-psd `LayerEffectsInfo` (`scale: 1`, `disabled` for hidden); multi-instance keys are arrays.
  - `patterns`: every PatternInfo the effects reference (ids are a hash of the pixels, convert.js), for `psd.patterns`
    or an .asl patterns section. A pattern whose pixels are not at hand (a data URL not decoded yet) leaves that effect
    out with a report line ("Pattern Overlay (pattern not loaded)"). `resolvePattern(ref)` defaults to
    `app.patterns.resolve`.
  - `extra`: `{ [agPsdEffectName]: patch[] }`, raw descriptor keys per instance that ag-psd does not serialise
    (contours with corners `TrnS` / `MpgS`, Bevel `useShape` / `MpgS` / `Inpr` / `AntA` / `textureDepth` / `InvT`, Pattern
    Overlay `Angl` / `Scl `, Stroke `Type` (shape burst) / `Scl ` / `Angl` / `Lnkd`, gradient `Scl ` / `Ofst` floats). A
    layer record carries it as `effectsExtra`; ag-psd-layers.js merges it. Values `{ $type: 'UntF' | 'bool', … }` are
    keys ag-psd's descriptor writer cannot type (it would throw); only the fix writes them.
- `effectsDescriptor(serializeEffects, effects, extra, { typed = false })` → the raw `Lefx` descriptor object for an
  .asl writer: pass '#ag-psd''s `serializeEffects`. With `typed: false` the `$type` values (texture depth / invert,
  the Stroke effect's pattern link) are left out, so `writeVersionAndDescriptor` can write it; see "Integrator".
- `pathFromPsd(paths, w, h) → Path | null`: `paths` are ag-psd BezierPath records; knot points are pixels as ag-psd
  scales them (`readCsh` gives a shape's paths in pixels of its `width` × `height`; `vectorMask.paths` in document
  pixels). `w`, `h` are accepted for symmetry and unused. Subpath `op` from `operation` (combine left implicit),
  `closed` from `!open`; handles equal to the anchor are left out; values within 2e-5 of a thousandth snap to it.
- `pathToPsd(path, w, h) → BezierPath[] | null` (ag-psd divides by the document size itself; `w`, `h` unused).
  `operation` always written, `linked` true for smooth points, `fillRule: 'non-zero'`.
- `advancedBlendingToPsd(blending) → ag-psd fields | null`, `advancedBlendingFromPsd(pl) → partial blending` (effects.js).
- paints.js: `hexFromPsd`, `colorToPsd`, `unitsToPx`, `px`, `gradientDefFromPsd(g, { interpolation, profile, report })`,
  `gradientDefToPsd(gradient, { report }) → { gradient, interpolation }`, `legacyStops`, `fillPlacement(g, w, h)`,
  `fillEnds(placement, w, h)`, `patternPixels`, `patternInfoFor`, `patternRefForId`, `addPatterns(psd, list)`,
  `paintFromContent(content, { place: 'document' | 'box', width, height, patterns, profile, report })`,
  `paintToContent(paint, { place, width, height, resolve, report }) → { content, patterns }`, `paintColors(paint)`.
- file-handling.js: `MAXIMIZE_CHOICES`, `maximizePreference(settings)`, `askMaximizeCompatibility(app, doc, path,
  { ask })`, `fileHandlingSection()`, `installFileHandling(app)`.
- Read ctx / records: `pl.effectsDescriptor` (raw lfx2 / lmfx), `pl.knockoutMode` ('none' | 'shallow' | 'deep'),
  `pl.vectorMaskAsGlobalMask`, `vectorFill.scale` / `.angle` on pattern contents.

## ag-psd fixes (scripts/vendor-entries/ag-psd-layers.js)

knko keeps Shallow / Deep (`knockoutMode`); brst reads one or two restricted channels (its loop wanted > 4 bytes per
entry); a `vmgm` handler (Vector Mask Hides Effects) is added after `lmgm`; lfx2 / lmfx keep the raw descriptor and
merge `effectsExtra` on write (typed placeholders for keys ag-psd cannot type); the GrdT enum reads Photoshop's Shape
Burst as Linear instead of throwing (which dropped every effect of such a layer); PtFl / vscg keep pattern Scale and
Angle and write `Lnkd` as a boolean (ag-psd's own writer throws on it); GdFl / vscg write gradient Scale and Offset as
floats (ag-psd rounds them to whole percents).

## Deviations from the contract

1. Spread / Choke: Photoshop's are percentages of Size, Pigment's pixels of hard edge before a Size blur; mapped as
   size_ps = spread + size, spread% = spread / size_ps (same picture both ways).
2. Live shapes: rectangles (radii, rotation) and ellipses through `vogk` (keyOriginType 1 / 2 / 5); triangles,
   polygons, lines and custom shapes are written and read as path shapes (exact outline).
3. Raster mask link: not mapped (the PSD flag's meaning is unclear); vector mask link is (`notLink`).
4. A mask record with density / feather parameters also carries a `realMask` block (a copy of the user mask, or an
   empty one for a vector-only mask): ag-psd reads parameters after that block, so without it the parameters were
   read as a real mask ("Invalid realMask size").
5. An inverted vector mask (Photoshop's flag) reads as its path plus a document rectangle with op `exclude`.
6. Extra registrations: resource `link-groups` 510 (turns the link groups read into link sets of two or more after
   the layers), the notices listed above. `stylesToPsd` returns `extra` beside S4.6's fields.
7. A raster mask without a vector mask is written with its own pixels and its density / feather as parameters (0.4
   baked them); identical bytes to 0.4 when density 1 and feather 0.
8. The global light resource writes `globalAngle` / `globalAltitude` when `doc.globalLight` is set or any layer has
   styles; reading sets `doc.globalLight` only when it differs from 120° / 30°.
9. `adjustments.js` reports `'colorized'` no more (Colorize is written); `'other-space'` stays.
10. Two new files under my package name (`paints.js`, `file-handling.js`), imported by the mapper files.
11. The save option is registered from `install(app)` through a dynamic import of `documents.js` (a Node-safe file
    cannot import it).

## Tests that wait for another package

None skip. Node tests read pattern effects as `pattern: null` (no canvas in Node); the e2e spec covers patterns.

## For the integrator

- **tests/unit/psd-registry.test.mjs pins the stub's registry lists without a gate (rule 11)**: line 24
  (`psdLayerKinds()` exactly `[group, adjustment, text, raster]`), lines 25-26 (`psdAspects()` exactly `[common,
  adjustment-placeholder, blend-if, raster-mask, notices]`), and line 47 (`slice(0, 4)` with `test-kind` at 340, now
  preceded by `fill` 300). Gate them on `psdFeatures()`; with psd-layers the lists are kinds `group 100, adjustment
  200, fill 300, shape 350, text 400, raster 900`, aspects `common, adjustment-placeholder, blend-if,
  advanced-blending, vector-mask, raster-mask, effects, tags, notices`, resources `resolution, guides, global-light,
  link-groups, composite`. These are the only two unit failures of the suite (998/1000).
- Not mine, seen in my runs: skeleton-05.spec.mjs:858 / :906 and :989 / :993, text-color.spec.mjs:264 (icc-engine's
  ungated lines, PKG-icc-engine.md).
- If preset-files-manager wants the Bevel texture depth / invert in .asl files it writes, '#ag-psd' needs one more
  export of the typed descriptor writer (`writeTypedDescriptor` in ag-psd-layers.js, through ag-psd-fixes.js /
  ag-psd.js, both skeleton files).
- `docs/0.5/psd-layers.md`: user guide, release notes (new preference File Handling › Maximize PSD and PSB File
  Compatibility, default Always; masks no longer baked; notices that disappear), known gaps.
