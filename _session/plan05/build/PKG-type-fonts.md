# PKG type-fonts (package 12, port 8862, entry `lib/type/font-library.js`)

Built in two sittings: a first engineer (stopped by the usage limit at 08:25 UTC, its log in
`type-fonts-stopped-actions.md`) wrote nearly all of it; the second checked every file against the package section
and S11, kept it, added the Preferences section, the 16-bit Grayscale and Preferences e2e cases and the asar Electron
case, wrote the docs' PSD gap, and ran the suites. Flag of S15: `fontCatalog().real === true`.

## Files (all type-fonts')

- `src/renderer/lib/type/font-library.js` (replaces the stub; keeps `createStubCatalog`, `parsePostScriptStyle`,
  `install`), new `font-tables.js` (pure: Node-tested), `font-picker.js`, `missing-fonts.js`
- `src/renderer/lib/type/fonts.js`, `shaper.js`, `layout.js` (0.4 files, type-fonts' in 0.5)
- `src/renderer/fonts/` (Source Sans 3 VF upright + italic, `SourceSans3-LICENSE.md`, `index.json`)
- `src/renderer/styles/type-fonts.css`
- `tests/fixtures/fonts/` additions: Liberation Sans Regular / Bold, Serif Regular, Mono Regular 2.1.5 (OFL 1.1) and
  `Liberation-LICENSE.txt` (the directory had only Carlito)
- `tests/unit/type-fonts.test.mjs`, `tests/e2e/type-fonts.spec.mjs`, `tests/electron/type-fonts.spec.mjs`,
  `docs/0.5/type-fonts.md`

## API as built

**Catalog** (`fontCatalog()` is a `FontLibrary` instance, `font-library.js`): every S11.1 member, plus
- `defaultFamily` (getter: the bundled default, `'SourceSans3VF'`), `known(family)`, `similar(family, { limit })`,
  `changed()` (rebuilds and emits `'type:catalog-changed'` `{ catalog }`), `records` (Map PostScript name ->
  `{ family, style, fullName, data }` from `queryLocalFonts`), `favourites.has(family)`.
- Style keys: a family whose faces Pigment knows (bundled, added, loaded, installed with records) answers PostScript
  names, a variable family's custom axis values after a bar: `'SourceSans3VF-Bold|wght=650'`. Families from 0.4's
  `fontFamilies()` with no faces (the browser build without the local-fonts permission: every Chromium e2e run) keep
  0.4's keys `'400'`, `'700i'` and `stylePatch` gives 0.4's patch with `postScriptName: null`. `stylePatch(family,
  '700i')` on a family with real styles maps the 0.4 key to its nearest style (so `type/target.js typeDefaults` keeps
  working). A key of another family (the family changed) gives that style's weight and slant with `postScriptName:
  null, axes: {}` (S11.1's "new family" rule).
- `resolve(st).substitute` is the bundled default family when missing; `missing(doc)` groups by PostScript name then
  family, `layers` included.
- `addFiles(files, { report })` (report: an array the caller passes, filled with lines for files that are not fonts).
- Exports also `FontLibrary`, `textLayersOf(doc)`, `styleListOf(layer)`, `FONT_CLASSES`, `parseStyleName`,
  `nearestStyle`, `axesSuffix`, `parseStyleKey`.

**fonts.js** (0.4 exports kept: `faceFor`, `unitOutline`, `addFontData`, `loadedFaces`, `requestFamily`, ...):
- `faceFor(st)` returns, for a variable face, an instance rec (`Object.create(base)`: own `id`, `font` with
  `setVariations`, `coords`, `weight`, `postScriptName` of the matching named instance, own glyph caches). Axis values:
  the named instance `st.postScriptName` names (its coords; then `st.axes` win), else the axis defaults with `wght =
  st.fontWeight`, then `st.axes`; clamped. `LayoutRun.face` is that instance: type-menu-commands' `outlines.js` gets the
  instance's outlines through `unitOutline(run.face, unit)` with no change.
- `facesOf(family)`, `axisValuesFor(rec, st, coords)`, `instanceFor(rec, coords)`, `registerFaceSource({ has, load })`
  (asked by `requestFamily` before the installed fonts), `setFallbackFamilies(list, { enabled })`,
  `fallbackFaceFor(str, st, primary)`.
- `loadedFaces()` entries gained `style, classification, metrics, variable, axes, instances, cssFamily`.

**Missing glyph protection**: `shapePiece` env takes `fallbackFace(str, st, rec)`; a `.notdef` cluster is shaped with
that face and its unit carries `face`. `layout.js splitByFace(run)` (exported) splits such runs: every `LayoutRun` has
one `face`; a fallback run has `fallback: { family, postScriptName }`. `unitOutline(rec, unit)` and the provider's
`outline()` use `unit.face` when present. Emoji keep the Canvas fallback.

**font-picker.js**: `installPicker(app, catalog)` registers widgets `font-family` (a `.fp-field` button,
`data-value` = family) and `font-style` (`select.fp-style` of style keys), the Character sections
`type-fonts-family` (replaces `family`), `type-fonts-style` (replaces `style`; keeps `select[data-k="style"]`; the
hidden built-in one is renamed `data-k="style-04"`), `type-fonts-axes` (order 5, variable families: a range and a
number per axis; a change applies `{ axes, fontWeight? }` in one "Character" entry), and the hover-preview stage
`type-fonts-hover` (order 0, `whileEditing: 'apply'`, `extensions: true`). `app.fontPicker = { preview, open(anchor,
opts), close }`; `preview.start(family)` / `.stop()` / `.family` / `.layers`; event `'type:font-preview'` `{ family }`.
Menu DOM: `.fp-menu` with `.fp-search`, `.fp-class`, `.fp-fav-filter`, `.fp-similar-filter`, `.fp-list` (virtual:
only rows in view), rows `.fp-row[data-family]` with `.fp-star`, `.fp-sample`; headings `.fp-heading` ("Recent",
"All Fonts"); footer `.fp-sample-text`, `.fp-preview-size`, `.fp-count`.

**missing-fonts.js**: open hook (order 600; interactive: one toast per document with a "Manage…" button; not
interactive: `info.notice(...)`); commands `type:manage-missing-fonts` (arg `{ replacements: [{ family,
postScriptName, to: { fontFamily, style? } }] }` replaces without the dialog; the dialog's choice is recorded with
`setReplayArg`; entry "Resolve Missing Fonts") and `type:replace-missing-fonts` (entry "Replace All Missing Fonts",
the bundled default, runs keep weight and slant). Exports `replaceFonts`, `manageDialog`, `missingNotice`,
`defaultReplacement`, `missingKey`, `missingLabel`.

**Commands**: `type:add-fonts` (`record: false`; arg `{ paths }` or `{ files: [{ name, bytes }] }` skips the dialog;
returns `{ added, report }`), `type:font-preview-size` (`record: false`, writes `settings.typeFonts.previewSize`).

**Settings** `typeFonts`: `previewSize`, `favourites`, `recent` (10 kept, 5 shown), `sample`, and the undeclared
`glyphProtection` (absent = on). Preferences section `type-fonts` "Fonts" (order 36): glyph protection, preview size.
IndexedDB `pigment-fonts` (store `info`) caches the classification of installed fonts.

## Deviations from the contract

- An extra Preferences section (`type-fonts`, "Fonts", order 36) and settings sub-key `typeFonts.glyphProtection`,
  not in S14.1: Photoshop's "Enable Missing Glyph Protection" needs a switch.
- New fixture fonts in `tests/fixtures/fonts/` (a shared directory, not in the new-files table) for the e2e spec.
- Bundled family name is the font's own, `SourceSans3VF` (the name table's family), not "Source Sans 3".

## Waiting on other packages / for the integrator

- **psd-text**: until it lands, text whose runs carry a `postScriptName` or `axes` is not `psdExpressible` (0.4's
  `PSD_TEXT_KEYS` has neither key) and is saved to PSD as pixels with the pixel-text notice. Only families with real
  styles produce such runs (bundled, added, installed with permission); 0.4's synthesised families do not, so the
  existing PSD specs are unchanged. psd-text: call `fontCatalog().fromPostScriptName(name)` on read and
  `fontCatalog().resolve(style)` on write (named instance PostScript names come back from `resolve`).
- No skeleton test gates on type-fonts beyond skeleton-05's stub block (`if (!done['type-fonts'])`), which now skips
  as designed; the fake-catalog test passes with the real catalog underneath.
- `tests/unit/psd-registry.test.mjs` 2 failures are psd-layers' (PKG-psd-layers.md).

## Test results at hand-off

- Unit: `type-fonts.test.mjs` 8/8; whole suite 1033/1035 (the 2 psd-registry lines above).
- e2e: `type-fonts.spec.mjs` 8/8. app, skeleton-04, skeleton-05, brush-golden,
  the type specs, hunt5-type, text-color: 111/114, the 3 failures icc-engine's ungated lines (skeleton-05:906, :993,
  text-color:274). Whole suite on 8862: 716 passed, 2 skipped, 5 failed: those 3, `repaint-speed.spec.mjs:421`
  (brush-engine-core, reported by icc-engine before this package) and `brush-settings-panel.spec.mjs:223` (Dual
  Brush pixel sum; fails 3/3 alone; brush code, not this package's).
- Electron: whole suite 16/16 (type-fonts: source tree and asar).
