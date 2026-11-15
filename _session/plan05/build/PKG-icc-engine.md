# PKG icc-engine (package 4, sequence B 1/7, port 8854)

Landed: `colorEngine().available === true` (S15 flag) once `lib/color/cmm.js` installs. `edit:assign-profile` is real
(no longer in `app.stubbed`). LittleCMS 2.16 through the npm package **lcms-wasm 1.0.5** (MIT, mattdesl), vendored by
`scripts/vendor/lcms2.mjs` into `src/renderer/vendor/lcms2/` (`lcms.js`, `lcms.wasm`, `LICENSE-lcms-wasm.md`,
`LICENSE-littlecms.txt`, `VERSION`); devDependency in package.json/package-lock.json (it pulls `tape` as a declared
runtime dependency: ~100 dev-only packages in the lock, nothing shipped).

## Files (all mine)

- `lib/color/cmm.js` — `install(app)`, `createEngine({ app, library })`; Preferences section `color-management` (46).
- `lib/color/profiles.js` — pure, Node-safe: `parseIcc(bytes)`, `writeIcc(def)` (v4 'para'; `legacy: true` writes v2
  'desc'/'curv'), `profileRecord(bytes, source, { name })` → ColorProfile (id = SHA-1 of the profile's own bytes),
  `wellKnownOf(parsed)`, `BUILTIN_DEFS`, `builtinIcc(id)`, `sha1Hex`, `evalCurve`, `invertCurve`, `xyzToLab`,
  `labToXyz`, `rgbToXyzD50`, `bradford`, `invert3`, `D50`.
- `lib/color/transforms.js` — `makeTransform(from, to, { intent, bpc, format: 'rgba8' | 'rgba16' | 'rgbaf32' })` →
  `{ identity, kind: 'js' | 'lcms' | 'js-float' | 'unsupported', apply(src, dst, n) }` (alpha copied, in place OK);
  `sameSpace(a, b)`, `convertRgb(rgb, from, to)`, `rgbToLab(rgb, profile)`, `labToRgb(lab, profile)`,
  `inGamut(rgb, from, to)`, `modelFor(profile)`.
- `lib/color/lcms.js` — `loadLcms()`, `setLcms(mod)` (Node tests), `lcms()`, `profileHandle`, `lcmsTransform`,
  `runTransform`, `TYPE`.
- `lib/color/display.js` — the display stage `'icc'` (order 900); `stageActive(view, isLive)`, `displayStats()`,
  `resetDisplayStats()`, `keptCanvas(view)` (tests / measurement).
- `lib/color/doc-profile.js` — Node-safe policy: `decodeConversion(chunks)`, `adoptOnOpen(doc, info, { resolve })`,
  `embeddedPolicy`, `embeddedBytes(doc, opts)`, `installChunkProvider()` (id `'icc'`, order 100),
  `describeProfile(doc)`, `assignable(list, doc)`, `assignProfileCommand(...)`.
- `lib/color/library.js` — `ProfileLibrary` (user profiles in the `color-profiles` preset kind, OS profiles through
  `bridge.listColorProfiles` + `readFile`, every embedded profile seen).

## API as built (for color-picker-swatches, Camera Raw, later packages)

Use the pipeline (`lib/color/pipeline.js`), never these files directly, except where noted:
- `convertColor(rgb, from, to)`, `toLab(rgb, doc.profile)` (D50), `fromLab(lab, doc.profile)`,
  `cssColor(rgb, doc)` → `'#rrggbb'`, or `'color(display-p3 r g b)'` for a colour outside sRGB when the display is P3.
- `describe(doc)`: `'Untagged RGB'` | profile name, `' (16bpc)'` / `' (32bpc)'` appended for deep documents; `''` for
  Bitmap.
- `profileById(id)`: built-in ids `'srgb'` (bytes null), `'display-p3'`, `'adobe-rgb'`, `'prophoto'`,
  `'gray-gamma-2.2'`; SHA-1 ids for embedded, user and OS profiles. Built-in bytes reopened from a file come back as
  the built-in record (not a SHA-1).
- `displayCanvas(canvas, doc)` works (JS kernel); the engine's `transform` is synchronous and exact (LittleCMS's own
  numbers) for matrix/TRC RGB and Gray profiles even before the wasm loads; LUT profiles need the wasm (`ready()`).
- `engine.displaySpace(view)`: `'display-p3'` only for a wide-gamut RGB document on a P3 screen (or setting
  `colorManagement.display === 'display-p3'`); sRGB, untagged and Gray documents always `'srgb'`.
- Events: the engine emits `'color:display-changed'` on the app when a document's profile changes (Assign, undo,
  New Document with a profile), when `settings.colorManagement` changes, and on a `(color-gamut: p3)` change.

## Deviations from the contract

1. sRGB-tagged files (any RGB profile whose colorants and curves equal sRGB's) decode with `'default'` (0.4's numbers)
   and get `doc.profile = SRGB` (the built-in, bytes null): they save byte-identical to 0.4 (no profile written).
2. A Gray-tagged document saves an RGB equivalent profile (sRGB primaries, the Gray TRC, named "<name> (RGB)"): every
   file Pigment writes holds RGB numbers, which cannot carry a Gray profile. It reopens as an RGB profile.
3. `profiles()` resolves to the library's live array (built-ins first); the pipeline caches that array, so profiles
   added later appear in `profilesList()`. Relies on pipeline.js storing the resolved array as is.
4. `settings.colorManagement.userProfiles` is unused (kept `[]`): user profiles live in the `color-profiles` kind.
5. The display transform is a JS matrix-shaper kernel (equal to LittleCMS 8-bit output, unit-tested on 2^18 random
   pixels for five pairs), not a 3D LUT: a 33³ LUT was slower in JS and up to 6 levels off at gamut edges. LUT-based
   profiles go through LittleCMS directly (exact, ~2x slower).
6. No worker: everything on the main thread.
7. Engine extras beyond S6.1: `isReady`, `toLab`, `fromLab`, `cssColor`, `describe`, `convertCanvas`, `profileById`.

## Tests

- `tests/unit/icc-engine.test.mjs` (12; LittleCMS from node_modules when present, else 4 skip).
- `tests/e2e/icc-engine.spec.mjs` (11, port 8854). Prints the display-stage timing.
- `tests/electron/icc-engine.spec.mjs` (2): from source and from an asar packed with electron-builder's file list.

## For the integrator

- **skeleton-05.spec.mjs pins the stub without a gate (rule 11) in two places; both fail once icc-engine lands:**
  - line 906 `expect(r.providers).toBe(0)` → with the engine the `'icc'` provider exists: gate as
    `toBe(landed['icc-engine'] ? 1 : 0)` (the byte-identity assertions after it pass either way).
  - line 993 `expect(before).toEqual({ status: false, info: true })` → with the engine an untagged document shows
    "Untagged RGB" in the status bar (S6.5/S6.6): gate as `{ status: landed['icc-engine'], info: true }`.
  With those two lines commented out every skeleton-05 "colour" test passes with icc-engine landed (checked).
- **tests/e2e/text-color.spec.mjs:274** pins 0.4's D65 Lab in the Info panel (`/L53a80b67/`). With the engine the
  Info row reads D50 Lab through `toLab` (S6.5, as Photoshop: `L54a81b70`). Gate it on `colorEngine().available`.
- Not mine, seen in my full run: `repaint-speed.spec.mjs:421` (gated on brush-engine-core; a full repaint during the
  textured stroke) fails with my engine disabled as well — brush-engine-core's work in progress.
- Packaged app (not mine): `build/icon.png` is not in electron-builder's `files`, so inside the asar the welcome
  screen's and About's `<img src="/build/icon.png" onerror=…>` 404 and the inline `onerror` is refused by the CSP
  (console error + CSP violation in the packaged app). My electron asar test ignores exactly these two messages.
- Release notes / notices: `docs/0.5/icc-engine.md` (LittleCMS 2.16 MIT, lcms-wasm 1.0.5 MIT).
