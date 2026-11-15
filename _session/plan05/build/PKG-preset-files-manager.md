# PKG preset-files-manager (package 10, sequence B 3/7, port 8860) — landed

S15 flags: `app.stubbed` lacks `edit:preset-manager` (and the other two Presets ids); `ACO_ASE_REAL === true`
(`lib/preset-files/aco-ase.js`). skeleton-05 "presets" now reads .ase through the real format (its stand-in is not
registered), and passes.

## Files (all mine)

- `src/renderer/lib/preset-manager.js` — MODULES entry (replaces the stub). `install(app)` registers every format below
  and the three commands.
- `src/renderer/lib/preset-files/aco-ase.js` (replaces the stub, keeps its exports), new `bytes.js`, `descriptor.js`,
  `pat.js`, `grd.js`, `csh.js`, `asl.js`, `tpl.js`, `bundle.js`, `migrate.js`.
- `src/renderer/presets/` — `index.json` and eight Pigment-made `.pigment-presets` libraries (swatches ×3, gradients,
  shapes, patterns, styles, Dry Media brushes). Generated once by a script kept in
  `scratchpad/plan05/build/smoke-preset-files-manager/make-libraries.mjs` (not in the repo).
- `src/renderer/styles/preset-manager.css` (link already in index.html).
- Tests: `tests/unit/preset-files-manager.test.mjs` (13), `tests/e2e/preset-files-manager.spec.mjs` (10),
  `tests/electron/preset-files-manager.spec.mjs` (1).
- Docs: `docs/0.5/preset-files-manager.md`.

## Formats as registered (ids for presets-panels and color-picker-swatches)

| id | ext | registry | kinds | read / write |
|---|---|---|---|---|
| `pat` | pat | `registerPresetFormat('patterns')` | patterns | both |
| `grd` | grd | `registerPresetFormat('gradients')` | gradients | both |
| `ase` | ase | `registerPresetFormat('swatches')` | swatches | both (groups kept) |
| `aco` | aco | `registerPresetFormat('swatches')` | swatches | both (v1 + v2) |
| `csh` | csh | `registerPresetFormat('shapes')` | shapes | both |
| `asl` | asl | `registerPresetFileFormat` | styles, patterns | both |
| `tpl` | tpl | `registerPresetFileFormat` | tool-presets, brushes, patterns | both |
| `pigment-bundle` | pigment-bundle | `registerPresetFileFormat` | `*` | both (write = the selection, no settings) |

Every read puts a file's presets in a group named after the file (`.ase` groups nest inside it). Every reader returns
report lines and never throws; files over 64 MB are refused with a report line (`bytes.js MAX_PRESET_FILE`, `tooLarge`).

## API as built

- `aco-ase.js` (pure): `ACO_ASE_REAL`, `parseAse(bytes)` → `{ groups: [{ name, colors }], colors /* ungrouped only */,
  all /* every colour, file order (extra) */, report }`, `parseAco(bytes)` (same shape, no groups), `writeAse({ groups,
  colors })` / `writeAco({ colors })` → `{ bytes, report }`, `registerSwatchFormats()`. A colour entry is `{ name,
  color: S7.2 color, type: 'global' | 'spot' | 'process' }`. **Grey is ink** (0 = white) in both formats, as
  `color-picker.js swatchHex` reads it. A swatch preset's data is `{ color }` plus `type` when not `'process'`
  (color-picker-swatches: keep `type` in your normalize if you want spot colours to round trip).
- `pat.js`: `readPatternRecord(reader)`, `writePatternRecord(writer, { name, id, width, height, data })`,
  `readPatternList(bytes, start, end)` / `writePatternList(writer, patterns)` (length-prefixed, as .asl/.abr/.tpl),
  `readPatFile`, `writePatFile(presets, { readBlob })`, `patternRgba(data, readBlob)` (a `patterns` preset's pixels,
  built-ins included), `patternItem(pixels, ref)`, `patternIdFor`, `registerPatFormat()`. Decodes RGB, Grayscale,
  Indexed with alpha (ag-psd's readPattern drops alpha).
- `grd.js`: `readGrdFile`, `writeGrdFile(presets)`, `gradientFromDescriptor(grad)`, `gradientNode(def, name)`,
  `registerGrdFormat()`.
- `csh.js`: `readCshFile`, `writeCshFile(presets)`, `registerCshFormat()`. Data `{ path /* 0..1 */, width, height }`
  (width / height = the shape's proportions, extra keys; presets-panels: keep them in your `shapes` normalize if you want
  Defined Proportions).
- `asl.js`: `readAslFile`, `writeAslFile(presets, { patternPixels(ref) })`, `dataUrlPixels(url)`,
  `appPatternPixels(app, readBlob)`, `registerAslFormat(app)`. Styles arrive as `{ styles, blending? }` with
  PatternRefs through `$presetRef` → `{ presetId, name }` (S10.5). `blending` holds only the advanced options.
- `tpl.js`: `readTplFile`, `writeTplFile(presets, { readBlob, patternPixels })`, `TOOL_CLASSES`, `appPresetPixels`,
  `registerTplFormat(app)`. Data is S10.5's `{ tool, options, brush?, type?, color? }`; a sampled tip's blob goes to
  `brushes` through the skeleton's blob refs.
- `bundle.js`: `writeBundle(source, { kinds, settings })`, `readBundle(bytes)`, `bundleItems(parsed, { kinds,
  existing })`, `bundleSettingsPatch(settings)`, `withBundleKinds(kinds, fn)`, `registerBundleFormat(app)`,
  `BUNDLE_FORMAT`, `BUNDLE_EXTENSION`. A ZIP: `bundle.json` + `blobs/<kind>/<name>`. Carries user presets and modified
  built-ins; on import skips presets the library holds (same kind, name, normalized data), renames non-hashed side files.
- `migrate.js`: `folderBundle(bridge, dir, kinds)` → `{ bytes, report, found }`.
- `preset-manager.js`: `install`, `managerKinds()`, `presetManagerDialog(app, { kind })`, `exportImportDialog(app)`,
  `migrateDialog(app)`, `migrateFrom(app, path)`, `exportBundleBytes(app, { kinds, settings })`,
  `exportPresetsBundle(app, { path, kinds, settings })`, `importPresetsBundle(app, { path | bytes, kinds, settings })`,
  `movePresets`, `renamePreset`, `deletePresets`, `resetKind`, `replaceKind`, **`pigmentLibraries(kind)`** →
  `[{ id, file, kind, name }]` and **`loadPigmentLibrary(app, id)`** (for the Swatches / Styles / Shapes / Tool
  Presets / Brushes panel menus).
- Commands (all `record: false`): `edit:preset-manager` (arg `{ kind }` or a kind string), `edit:export-import-presets`
  (arg `{ mode: 'export' | 'import', path, kinds?, settings? }` runs without the dialog and resolves `{ added, report,
  settings }` / the path), `edit:migrate-presets` (arg a path or `{ path }`: a bundle or a folder).
- Settings: `settings.presetManager = { kind, view }`.

## Deviations from the contract

1. `.tpl` layout is Pigment's reading of the format (the .abr 6.2 section layout under an `8BTP` header, presets in
   `desc.Prst`, Pigment's own options as JSON in `pigmentData`); not checked against Photoshop files (none usable).
2. `.asl` blending options use Photoshop's scripting key names in `blendOptions` (unverified placement); blend mode,
   opacity and fill are reported, not kept. Bevel texture depth/invert and a pattern Stroke's link are not written to
   .asl (ag-psd's writer cannot type them; `effectsDescriptor(…, { typed: false })`).
3. `.grd` writes `gradientsInterpolationMethod` inside each gradient so Pigment's files keep the method; a file
   without it reads as Classic. Version 3 .grd is refused with a message.
4. `parseAse` adds `all`; `colors` holds only ungrouped colours.
5. Bundle import never applies settings on open/drop (only Export/Import Presets and Migrate with a bundle do), and
   reports that the file holds settings.
6. New helper files under my names: `bytes.js`, `descriptor.js`, `migrate.js` (beside the listed ones).
7. The Preset Manager's menu popover gets class `pm-popover` (z-index above dialogs) — popovers sit under dialogs
   otherwise (app.css 1000 vs dialogs 1500). Other dialogs that open popovers will hit the same; the integrator may
   want a general fix in app.css.

## Tests that skip or gate

- unit `.csh` content on `psdFeatures().vectorMasks`; `.asl` content on `psdFeatures().effects`; `.tpl` dynamics on
  `ABR_REAL` — all three landed, so the landed branches run. e2e the same gates. None skip.

## For the integrator

- `tests/unit/psd-registry.test.mjs` 2 failures are psd-layers' (its PKG notes); `skeleton-05.spec.mjs:858` and `:989`
  are icc-engine's ungated lines. Not mine.
- If presets-panels wants the .asl Bevel texture depth in files Pigment writes, `#ag-psd` needs the typed descriptor
  writer exported (psd-layers' note).
- presets-panels / color-picker-swatches: add "Pigment libraries" to your panel menus with `pigmentLibraries(kind)` /
  `loadPigmentLibrary(app, id)`; Import / Export already list these formats with no edit (`presetFileMenuItems`).
