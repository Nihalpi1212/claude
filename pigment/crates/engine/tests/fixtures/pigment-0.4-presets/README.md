# Pigment 0.4 presets (Migrate Presets fixture)

A JavaScript Pigment settings folder as Pigment 0.4 left it, written by hand from the JS formats
(`claude/fervent-newton-263lz3`):

- `presets/<kind>.json` is the preset store's file (`renderer/lib/presets.js`, `src/main/preset-files.js`):
  `{format: 'pigment-presets', version: 1, kind, kindVersion, groups, items, hidden}`; built-ins as shipped
  are `{ref: id}`; `:` in a kind is written `__` (`adjustment__curves.json`).
- `presets/<kind>/<name>` are side files: `patterns/p1.png` (a 4 × 4 red/blue checker), `brushes/tip-….png` (a 5 × 3
  grey sampled tip, the coverage as grey, as `brush/abr.js` `greyPng` writes them). `patterns.json`'s "Lost" names a
  side file that is not there.
- `settings.json` (`shared/defaults.js`): Pigment 0.4's own `brushPresets` and `swatches`, `adjust.autoOptions`,
  `adjust.curvesDisplay` (the JS keys) and an Actions panel set (reported, not converted).
- `stroke-styles.json` and `adjustment__shadows-highlights.json` are kinds Pigment has no presets of.

The PNGs were written by a few lines of Python (zlib), not by the JS app. Used by `tests/it/migrate_pigment_04.rs`.
