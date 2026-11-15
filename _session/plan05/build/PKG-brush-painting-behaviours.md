# PKG brush-painting-behaviours (package 3, sequence A, port 8853) — landed

S15 flag: `PaintGesture.real === true` (`lib/tools/paint-gesture.js`). skeleton-05 "brush: claimed presses…" now skips
its stub branch (the stub assertions are gated, not deleted). The 49 paint key commands of S13.3 are registered (none
left in `app.stubbed`).

## Files (all mine)

- `src/renderer/lib/tools/paint-gesture.js` — `PaintGesture` (replaces the stub, same methods) plus pure helpers.
- `src/renderer/lib/tools/paint-keys.js` — MODULES entry: the paint key commands, held-key tracking, the cursor filter,
  the Preferences section `cursors`, the HUD platform.
- `src/renderer/lib/brush-cursor.js` — the cursor (replaces the stub, keeps `paintingCursorStyle`, `brushCursorCss`,
  `drawBrushCursor`).
- `src/renderer/lib/brush-hud.js` (new) — drawing of the resize HUD.
- `src/renderer/lib/tools/paint.js` — StrokeTool: `strokeDown(p, { erase })`, `onKeyDown` (gesture keys, arrow
  rotation), `cancel()` asks the gesture first, `drawOverlay` draws the HUD while it runs; Brush and Pencil
  `tildeErases = true` and pass `opts` on; EraserTool `cursorTip()` for Block mode; exported `wrapAngle`. Every
  skeleton marker (`// brush (lib/brush/tool-brush.js)`, `// brush (lib/brush.js)`) and call stays.
- `src/renderer/styles/painting.css` — comment only (everything is drawn on the canvas overlay).
- Tests: `tests/unit/brush-painting-behaviours.test.mjs` (14), `tests/e2e/brush-painting-behaviours.spec.mjs` (7),
  `tests/electron/brush-painting-behaviours.spec.mjs` (1). Docs: `docs/0.5/brush-painting-behaviours.md`.

## The API as built

**`lib/tools/paint-gesture.js`** (Node-safe at import):
- `class PaintGesture { static real = true; static mac = false; constructor(tool); claims(p); down(p); move(p,
  dragging); up(p); contextDown(p); cancel(); key(e); drawOverlay(ctx, view) → bool; lastPoint(doc = tool.doc) →
  {x, y} | null; hud /* null | { kind: 'resize' | 'color', … } */ }`. `PaintGesture.mac` is set by paint-keys.js
  `install` from `window.pigment.platform === 'darwin'` (the browser build answers like Windows/Linux); tests set it.
- `pressGesture(p, { mac })` → `'resize' | 'color' | null`: Windows/Linux Alt+button 2 (Shift: color); macOS Ctrl+Alt
  with button 0 (Cmd: color). `claims(p)` is exactly `pressGesture(p) !== null`.
- `AxisLock(anchor, { threshold })` with `apply(p)`; `hudValues(start, dx, dy, { zoom, maxSize, minSize, vertical,
  minOpacity })`; `AXIS_THRESHOLD` (4 screen px), `HUD_VERTICAL_SPAN` (200 px).
- `paintKeyState = { tilde, capsLock, shift }` (kept current by paint-keys.js; read by the gesture and the cursor).
- Routing: a press with `p.eraser` (pen eraser end) on a tool other than the Eraser goes to
  `app.tools.get('eraser').strokeDown/Move/Up` for that stroke (the toolbox keeps the active tool). The held tilde
  passes `{ erase: true }` to tools with `tildeErases` (Brush, Pencil). Shift-click: `strokeDown(last point)`,
  `strokeMove(p, true)`, then the drag goes on held to an axis; `stroke.s.smoothing = 0` for straight strokes. The
  last point is per gesture (tool) and document (WeakMap), set on every release that is not an Alt-click or a cancel.
- HUD colour picker: `app.colorPicker.hud({ at: { x: clientX, y: clientY } /* page px of the press */, tool, initial:
  settings.foreground /* hex string */ })`; every move → `session.move(p)`, release → `session.up(p)`, Escape /
  pointercancel → `session.cancel()`. Nothing else (review decision 2).
- Resize HUD: writes `size` and `hardness` (or `opacity` when `settings.painting.hud.vertical === 'opacity'`) through
  `tool.setOpt` as it moves; Escape / pointercancel restores the press's values. No history entry, no command.

**`lib/brush-cursor.js`** (Node-safe at import): `paintingCursorStyle(app)`, `cursorPrefs(app)`,
`effectiveCursorStyle(app, { capsLock })`, `brushCursorCss(tool)`, `normalTipScale(tip)` ((1 + hardness) / 2 for
computed tips: 0.4's dab crosses half strength there), `cursorTip(tool)` (the tool's `cursorTip()` if it returns one,
else `toolBrush(app, id).preset.tip`, cached per `settings.tools[id]` object), `cursorPolygons(tip, style)`,
`tracePolygons(ctx, polys, at, matrix6)`, `drawBrushCursor(ctx, view, tool)` (leash from `tool.stroke.leash`, Shift
line preview, crosshair options), `drawsBrushCursor(tool)`, `cursorFilter(app, css, { tool })`.

**`lib/brush-hud.js`**: `hudLabel(values, vertical)`, `drawResizeHud(ctx, view, tool, hud)`.

**`lib/tools/paint-keys.js`** (Node-safe at import): `install(app)`, `PAINT_BLEND_MODES`, `PAINT_KEY_COMMANDS` (both
kept from the stub), `DigitPair` (`press(key, digit, now, pairMs)` → `{ percent, paired }`, reusing
`layer-menu-model.js digitPercent`), `digitOption(tool, 'opacity' | 'flow', { airbrush })`, `digitValue(option,
percent)`, `clampTo(option, v)`, `blendTarget(tool, mode)` → `{ key, value } | null`, `stepPreset(ids, current,
step)`, `shownOption(tool, key)`, `cursorsPreferences` (section `cursors`, order 21; field keys `painting*`, no
`cursorStyle`).

Commands (all enabled only while `paints(app.tools.active)` and the command applies to it, so a disabled one lets the
key fall to the global table):
- `tool:opacity-digit-N` / `tool:flow-digit-N`: arg optional `{ tool, key, value }` (replay); records that as its
  replay arg. Order of options for the opacity digit: opacity, strength, exposure, flow; the flow digit: flow. With
  the airbrush (`preset.buildUp`) the two swap.
- `tool:blend-mode-<mode>`: the tool's `blend` option (or `mode` when the value is listed there: Color Replacement);
  Dodge/Burn `range` (screen → shadows, multiply → midtones, hard-light → highlights), Sponge `mode` (color-dodge →
  desaturate, screen → saturate). Replay arg `{ tool }`.
- `tool:brush-prev/-next/-first/-last`: runs `tool:brush-preset { id, tool }` (source 'api', nested) and records
  itself with `setReplayCommand('tool:brush-preset', { id, tool })`. Wraps around `app.presets.list('brushes')`.
- None is recorded by the actions recorder (the `tool:` group is ignored there, like `[` `]`).

## Deviations from the contract

1. The pen's eraser end strokes with the Eraser tool's handlers and brush but does not activate the Eraser in the
   toolbox (S3.1 says "the Eraser tool's strokeDown with its own brush for this stroke, back on up"; the split table
   calls it "the tool switch").
2. `hud({ at })` gets the press's page (client) coordinates, which is what a popup in the window needs; S7.1 says
   "screen". `initial` is the foreground hex string (S7.1 allows `ColorValue | string`).
3. Extras beyond the brief: Dodge/Burn/Sponge/Color Replacement mode keys, the airbrush digit swap, the Shift line
   preview, the HUD vertical-axis preference (`settings.painting.hud.vertical`, already a declared sub-key).
4. Normal Brush Tip (`'outline'`, the default) now draws the half-strength outline of a soft computed tip (smaller
   than 0.4's full circle). Full Size Brush Tip draws the whole tip. Release-noted.

## Tests that wait for another package

- HUD colour picker: my e2e tests wrap the stub's session to observe the forwarding; the assertion that the
  foreground is unchanged runs only while `app.colorPicker.real` is false. Once color-picker-swatches lands, its own
  spec should drive the real session through this gesture.

## Integrator

- Nothing needed in files I do not own.
- Seen while running the specs (not caused by this package): `brush-settings-panel.spec.mjs:223` ("Dual Brush…")
  fails about two runs in three on `r.dual.sum < r.plain.sum * 0.9` (received ~0.91–0.97 of plain): each stroke takes
  a fresh seed (S2.4), so the dual brush's coverage varies; it fails the same way with the strokes driven straight
  through `strokeDown/Move/Up` (no gesture). `skeleton-05.spec.mjs:858` and `:989` (icc-engine), `:1795` (.ase swatches)
  and `psd-registry.test.mjs` (psd-layers' new `fill` kind) failed on the tree while other packages were in progress.

## Test results at hand-off

- Unit: `brush-painting-behaviours.test.mjs` 14/14; whole unit suite 1012/1014 (the 2 failures are
  `psd-registry.test.mjs`, psd-layers' new `fill` kind, in progress).
- e2e: `brush-painting-behaviours.spec.mjs` 7/7; app, skeleton-04, brush-golden green; skeleton-05 green except :858
  and :989 (icc-engine). Whole suite on 8853: 688 passed, 2 skipped, 15 failed — 11 in one burst (finish-layer-menu:512,
  gallery-b ×5, gradients ×5) that all pass on re-run (another package's files were mid-edit), repaint-speed:421 (S2.8,
  brush-engine-core's known case), skeleton-05:858, :989 and text-color:264 (icc-engine).
- Electron: 14/14 (with `tests/electron/brush-painting-behaviours.spec.mjs`).

## Cost on the repaint and stroke paths (Chromium, this machine)

- Cursor draw per repaint: 0.03 ms (Normal, 300 px soft elliptical tip turned 30°), 0.02 ms (Full Size); 0.4's two
  arcs 0.004 ms. After a `setOpt` the tip is rebuilt once (`toolBrush`, ~0.14 ms).
- Gesture per pointer move: 0.04 µs (plain), 0.12 µs (Shift axis lock). Nothing per dab.
