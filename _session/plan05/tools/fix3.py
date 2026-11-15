import json, sys
P = []
def r(a, b): P.append((a, b))
r("its own 16-bit PNG save applies the chunk providers (S5.4) | E42 |", "its own 16-bit PNG save applies the chunk providers (S5) | E42 |")
r("| `lib/form.js`, `lib/fields.js` | skeleton | field type `color` through a widget; stub widgets `color`, `font-family`, `font-style` | E7, E46, E51 |",
  "| `lib/form.js`, `lib/fields.js` | skeleton | field type `color` through a widget; the stub `color` widget (S7.3) | E7, E46 |")
r("skeleton lands first: deletes `installTipHook` (a prototype patch, a no-op since `baseSettings` passes angle and roundness); `BUILTIN_BRUSHES` kept |",
  "skeleton lands first: deletes `installTipHook` (a prototype patch, a no-op since `baseSettings` passes angle and roundness); `drawStroke` moves to the engine as `renderStrokePreview`; `BUILTIN_BRUSHES` kept |")
r("| `lib/panels/info.js` | skeleton | document profile row (S6.6) | E43 |",
  "| `lib/panels/info.js` | skeleton | document profile row (S6.6) | E43 |\n| `lib/smart-object.js` | skeleton | `cloneDocument` copies `doc.profile` (S6.2) | |")
r("| camera-raw-workspace | `lib/develop/workspace.js` (stub), new `lib/develop/presets.js`, `white-balance.js`, `src/shared/pixels/develop-profile.js` | `lib/develop/workspace.js` |",
  "| camera-raw-workspace | `lib/develop/workspace.js` (stub), `src/shared/pixels/develop-profile.js` (stub, imported by `develop.js`), new `lib/develop/presets.js`, `white-balance.js` | `lib/develop/workspace.js` |")
r("| type-fonts | `lib/type/font-library.js` (stub), new `lib/type/font-picker.js`, `missing-fonts.js`, `src/renderer/fonts/` | `lib/type/font-library.js` |",
  "| type-fonts | `lib/type/font-library.js` (stub: 0.4's family list as a catalog, the two font widgets as 0.4's selects), new `lib/type/font-picker.js`, `missing-fonts.js`, `src/renderer/fonts/` | `lib/type/font-library.js` |")
r("| E51 | Font catalog and font widgets | `lib/type/api.js fontCatalog`, `fields.js` (S11.1–2) |",
  "| E51 | Font catalog and font widgets | `lib/type/api.js fontCatalog`, widget kinds `font-family` / `font-style` (S11.1–2) |")
r("""Stub catalog: families are 0.4's `tools/text.js` list (the static list plus `queryLocalFonts` names when granted);
`styles()` are 0.4's synthesised Regular / Italic / Bold / Bold Italic; `resolve` uses `fonts.js faceFor` and 0.4's
`cssFamilyFromPsFont`, `missing: !hasFamily(family)`; `missing(doc)` returns `[]`; `addFiles` calls
`fonts.addFontData`.""",
"""`api.js`'s default catalog is empty; the stub `lib/type/font-library.js` registers 0.4's equivalent: families from
`tools/text.js fontFamilies()` (its static list plus `queryLocalFonts` names; `onFontsChanged` → the event), styles from
its `STYLES` (Regular … Black and their italics, synthesised), `resolve` through `fonts.js faceFor` / `hasFamily`
(`missing: !hasFamily(family)`), `missing(doc)` → `[]`, `addFiles` → `fonts.addFontData`; `real: false`. (The catalog
and widgets live in that file, not in `api.js` or `fields.js`, which `tools/text.js` must not be imported into.)""")
r("""**S11.2 Font widgets** (fields.js, stubs by the skeleton): option kinds `font-family` and `font-style` with value the
family name and the style key (`'400'`, `'700i'`, or a PostScript name once type-fonts lands); stubs are 0.4's selects
(`.opt[data-key="family"] select`, `.opt[data-key="style"] select`, which `tools/text.js` used).""",
"""**S11.2 Font widgets** (registered by the `font-library.js` stub, E7): option kinds `font-family` and `font-style`,
value the family name and the style key (`'400'`, `'700i'`, or a PostScript name once type-fonts lands); the stubs are
0.4's selects (`.opt[data-key="family"] select`, `.opt[data-key="style"] select`; options from `spec.options`, which
`tools/text.js` keeps filling through `setFamilyOptions`).""")
r("""imports `develop-more.js` (camera-raw-panels' stub, empty) after the registry module and before registering the builtins,""",
  """imports `develop-more.js` (camera-raw-panels' stub) and `develop-profile.js` (camera-raw-workspace's stub), both empty,
after the registry module and before registering the builtins,""")
r("""**Step 9. Type** (S11): `model.js`, `type-model.test.mjs:26`, `api.js`, the font widgets, `tools/text.js`.""",
  """**Step 9. Type** (S11): `model.js`, `type-model.test.mjs:26`, `api.js`, the `font-library.js` stub (catalog and
widgets), `tools/text.js`.""")
json.dump(P, open(sys.argv[1], 'w'))
