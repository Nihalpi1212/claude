# Pigment — architecture and module contracts

Pigment is a free, open-source raster and vector image editor (a Photoshop-class tool) for Windows
and macOS. It is an Electron app with the same platform layer as Folio PDF (its sibling in this
repository): an ES-module main process, a sandboxed renderer behind a small preload bridge, no
bundler for the app's own code, and a browser-only test mode. This document is the contract every
module is written against. When a module and this document disagree, fix one of them.

## Directory layout

```
pigment/
  package.json                 electron, electron-builder, playwright, ag-psd (bundled by esbuild at install)
  scripts/build-vendor.mjs     bundles ag-psd -> src/renderer/vendor/ag-psd.js (git-ignored)
  scripts/csp-hash.mjs         recomputes the CSP hash of the inline import map in index.html
  src/main/                    Electron main process: main.js (window, lifecycle, protocol, permissions), ipc.js,
                               menu.js (re-exports src/shared/menu-template.js), clipboard.js (Electron 44 async
                               clipboard), protocol.js, settings-store.js, recent.js, watch.js, startup-files.js,
                               preset-files.js (the preset store's files, 0.4)
  src/preload.cjs              contextBridge -> window.pigment (see "The preload bridge")
  src/shared/                  code shared by main, renderer and Node tests (no DOM, no Electron):
    defaults.js                settings defaults
    formats.js                 file extensions Pigment opens, dialog filters
    keymap.js                  shortcuts (MENU_KEYS / RENDERER_KEYS / TYPE_KEYS), labels, accelerator parsing
    menu-template.js           the native menu's template (0.4: shared so the renderer can read labels and paths)
    zip.js                     minimal ZIP (store + deflate) reader/writer used by the .pigment format
    pixels/core.js             ImageDataLike helpers used by every pixel module (see "Pixel modules")
    pixels/color.js            colour conversions (rgb/hsl/hsv/hex/lab), luminance, hex parsing
    pixels/blend.js            all Photoshop blend modes per pixel (used when Canvas 2D has no equivalent)
    pixels/adjust.js           adjustments (levels, curves, hue/saturation, ...) as LUTs or per-pixel ops
    pixels/filters.js          filters (blur, sharpen, noise, pixelate, distort, stylize, render, other)
    pixels/selection-ops.js    flood fill, colour range, outline, feather/expand/contract/border/smooth, rasterizing
    pixels/transform.js        resampling: affine and perspective warps, high-quality resize, exact rotations
    pixels/styles.js           layer effects on ImageData (shadows, glows, stroke, bevel, satin, overlays)
    pixels/retouch.js          dab-sized pixel ops for dodge/burn/sponge/blur/sharpen/smudge/heal/colour replacement
    pixels/inpaint.js          content-aware fill (multi-scale PatchMatch + voting)
  src/renderer/
    index.html                 CSP, import map (ag-psd), layout skeleton
    app.js                     App object: settings, commands, core commands, module loading, startup
    lib/bridge.js              window.pigment or an in-browser stand-in (tests, npm run dev:web)
    lib/commands.js            command registry (ids below), de-duplication across sources
    lib/dialogs.js             modal dialogs, prompts, confirm, toasts, popovers
    lib/form.js                declarative form fields and formDialog() (preview thumbnail or live canvas preview)
    lib/toolbar.js, statusbar.js, shortcuts.js, icons.js, panels.js (dock), welcome.js
    lib/document.js            Document and Layer classes (raster, group, text, shape, fill, adjustment)
    lib/compositor.js          renders a Document (or a region of it) to a canvas
    lib/history.js             per-document undo/redo with pixel patches
    lib/canvas-view.js         viewport: zoom/pan/rotate, rulers, guides, grid, checkerboard, overlays, pointer routing
    lib/documents.js           open documents and tabs, open/save/close flows
    lib/io.js                  open/save/export: images, PSD (ag-psd), .pigment container
    lib/layer-ops.js           Layer menu commands, structural undo snapshots
    lib/layer-move.js          undoable layer offsets (move tool, align, distribute, properties)
    lib/edit-ops.js            Edit and Select menu commands, clipboard, fill/stroke, quick mask
    lib/image-ops.js           Image menu (size, canvas, rotate, crop, trim, duplicate) and Free Transform
    lib/file-ops.js            Export As, quick export, export layers, document properties
    lib/adjust-ui.js           adjustment dialogs and editors, pixel-edit sessions, Fade, fill layer editing
    lib/filter-ui.js           Filter menu dialogs, Last Filter;  lib/liquify.js: Liquify;  lib/content-aware.js
    lib/style-ui.js            Layer Style dialog, global light;  lib/patterns.js: pattern cache for styles
    lib/extras.js              New Document dialog, colour picker, Preferences
    lib/tools.js               tool registry, toolbox, options bar binding, cursor handling
    lib/tools/*.js             tool families (see "Tools")
    lib/brush.js               brush engine (dabs, dynamics, stroke buffer, mask painting, samplers)
    lib/selection.js           Selection object (mask + outline cache) wrapping pixels/selection-ops.js
    lib/panels/*.js            layers, properties, adjustments, color, swatches, brushes, history, navigator, channels, paths, info, character
    styles/*.css
    vendor/                    git-ignored, produced by scripts/build-vendor.mjs
  tests/unit/*.test.mjs        node:test; pixel modules, zip, menu
  tests/e2e/*.spec.mjs         Playwright (Chromium) against tests/e2e/server.mjs + the browser bridge
  tests/electron/*.spec.mjs    Playwright _electron against the real app (xvfb on Linux)
  tests/fixtures/              make-fixtures.mjs writes PNG and PSD test images to tests/fixtures/out
  docs/                        USER-GUIDE.md, PARITY.md; docs/0.4/ (the 0.4 round's package notes, rule 7)
```

## Runtime model

- One window, several documents in tabs. `app.doc` is the active `Document`; `app.view` its `CanvasView`.
- **Pixels are the source of truth.** A document is a tree of layers; raster layers own an
  RGBA canvas; everything else (text, shapes, fills, adjustments) is described by parameters and
  rendered to a cached canvas on demand. The compositor never mutates layers.
- **Every change goes through the history.** Tools and commands call `doc.history.run(label, mutation)`
  or the stroke API (`beginStroke` / `endStroke`) so undo/redo and the dirty flag are always right.
  Nothing else writes layer pixels or tree structure.
- **Pixel maths is shared and pure.** Anything that computes over pixels lives in `src/shared/pixels/`
  and works on `ImageDataLike` objects so it runs identically in the renderer, in `pixel-worker.js`
  and in Node unit tests. Renderer code converts canvases to/from ImageData at the edges.
- Colour: 8-bit RGBA, sRGB, straight (non-premultiplied) alpha in ImageData; Canvas 2D handles premultiplication for compositing.
- Resolution (dpi) is metadata only (image size dialog, rulers in inches/cm, export).

## The preload bridge: `window.pigment` (src/preload.cjs ↔ src/main/ipc.js)

Identical to Folio's bridge (file dialogs, readFile/writeFile with atomic rename, pathInfo,
showMessage, settings, recent files, startup files, ui state, close flow with `closeAck` /
`respondClose`, theme, nativeEdit, clipboard text/image, file watching), with these additions:

```ts
readClipboardImage(): Promise<Uint8Array | null>;   // PNG bytes of the system clipboard image, if any
```

Channel names are `pigment:<method>` and events `pigment:event:<channel>`. The browser bridge
(`lib/bridge.js`) keeps `window.__pigmentTest = { files, written, nextOpenFiles, nextSavePath,
nextDirectory, autoRespond, clipboardImage, uiState, ... }` for tests.

### Settings (`src/shared/defaults.js`)

theme, language of units (`rulerUnit`: px|in|cm|mm|pt|pica|percent), `recentLimit`, `restoreSession`,
`lastSession`, `windowBounds`, foreground/background colours, brush defaults (size, hardness, opacity,
flow, spacing, smoothing), `swatches` (user palette), `brushPresets`, `panelLayout` (dock state),
`showRulers`, `showGrid`, `gridSize`, `snap`, `pixelGrid`, `checkerboard` (size, colours),
`newDocPreset` (last new-document settings), `exportDefaults`, `historyLimit` (entries), `historyMemoryMB`,
`cursorStyle` (brush: outline|precise|dot), `autoSelectLayer`, `customSheet`... Add keys here, never
read raw stored objects without `withDefaults()`.

## Commands

Every user action is a command: `app.commands.run(id, arg, source)`. Menus (main), the toolbox,
options bar, panels, context menus and shortcuts all run commands. Ids (arg in parentheses):

| Group | Ids |
|---|---|
| file | `file:new`, `file:open`, `file:open-paths` (string[]), `file:open-recent` (path), `file:clear-recent`, `file:save`, `file:save-as`, `file:save-copy`, `file:export` (opens Export As), `file:export-quick` (PNG next to the file), `file:import-image` (as a new layer), `file:place` (as a transformable layer), `file:close`, `file:close-all`, `file:revert`, `file:reveal`, `file:properties` (document info), `file:quit` |
| edit | `edit:undo`, `edit:redo`, `edit:step-forward`, `edit:step-backward`, `edit:cut`, `edit:copy`, `edit:copy-merged`, `edit:paste`, `edit:paste-in-place`, `edit:paste-into`, `edit:clear`, `edit:fill` ({color?: 'fg'|'bg'|hex, mode?, opacity?} or dialog), `edit:stroke` (dialog), `edit:free-transform`, `edit:transform` ('scale'|'rotate'|'skew'|'distort'|'perspective'|'rotate-180'|'rotate-90'|'rotate--90'|'flip-h'|'flip-v'), `edit:select-all`, `edit:preferences`, `edit:define-pattern`, `edit:fade` (last adjustment/filter opacity) |
| image | `image:adjust` (kind, see Adjustments), `image:auto-tone`, `image:auto-contrast`, `image:auto-color`, `image:size`, `image:canvas-size`, `image:rotate` (180|90|-90|'arbitrary'|'flip-h'|'flip-v'), `image:crop` (to selection), `image:trim`, `image:reveal-all`, `image:duplicate`, `image:flatten` |
| layer | `layer:new`, `layer:new-group`, `layer:via-copy`, `layer:via-cut`, `layer:duplicate`, `layer:delete`, `layer:rename`, `layer:properties`, `layer:style` (kind or 'dialog'), `layer:clear-style`, `layer:copy-style`, `layer:paste-style`, `layer:new-fill` ('solid'|'gradient'|'pattern'), `layer:new-adjustment` (kind), `layer:mask` ('reveal-all'|'hide-all'|'reveal-selection'|'hide-selection'|'from-transparency'|'delete'|'apply'|'toggle'|'link'|'select'), `layer:clip` (toggle clipping mask), `layer:group`, `layer:ungroup`, `layer:arrange` ('front'|'forward'|'backward'|'back'), `layer:align` ('left'|'hcenter'|'right'|'top'|'vcenter'|'bottom'), `layer:distribute` (axis), `layer:merge-down`, `layer:merge-visible`, `layer:merge-selected`, `layer:rasterize`, `layer:convert-to-smart`? (not supported), `layer:lock` (kind), `layer:visibility` (toggle), `layer:opacity` (0..100), `layer:blend` (mode), `layer:select` (id | 'next' | 'prev' | 'all' | 'none'), `layer:edit-text` |
| select | `select:all`, `select:none`, `select:reselect`, `select:inverse`, `select:color-range`, `select:modify` ('border'|'smooth'|'expand'|'contract'|'feather'), `select:grow`, `select:similar`, `select:transform`, `select:save` (as channel), `select:load` (channel), `select:from-layer` (layer alpha) |
| filter | `filter:last`, `filter:apply` (kind + params or dialog), `filter:<kind>` convenience ids registered from the filter catalogue |
| view | `view:zoom-in`, `view:zoom-out`, `view:zoom-fit`, `view:zoom-fill`, `view:zoom-100`, `view:zoom-200`, `view:set-zoom` (number), `view:rotate` (deg | 'reset'), `view:rulers`, `view:grid`, `view:guides`, `view:pixel-grid`, `view:snap`, `view:extras` (selection edges, guides, grid), `view:new-guide` ({axis, pos}), `view:clear-guides`, `view:lock-guides`, `view:fullscreen`, `view:theme`, `view:next-tab`, `view:prev-tab`, `view:screen-mode` |
| tool | `tool:select` (toolId) and one `tool:<id>` per tool, `tool:swap-colors`, `tool:default-colors`, `tool:brush-size` (delta), `tool:brush-hardness` (delta), `tool:fg-color` (hex), `tool:bg-color` (hex) |
| window | `window:panel` (panelId toggles), `window:reset-workspace`, `window:toggle-panels` (Tab) |
| help | `help:shortcuts`, `help:guide`, `help:about`, `help:website`, `help:devtools` |

Commands registered with `{ run(arg), enabled?(), checked?(), label? }` as in Folio.

## Documents, layers, selection (`lib/document.js`)

```ts
type BlendMode = 'normal'|'dissolve'|'darken'|'multiply'|'color-burn'|'linear-burn'|'darker-color'|
  'lighten'|'screen'|'color-dodge'|'linear-dodge'|'lighter-color'|'overlay'|'soft-light'|'hard-light'|
  'vivid-light'|'linear-light'|'pin-light'|'hard-mix'|'difference'|'exclusion'|'subtract'|'divide'|
  'hue'|'saturation'|'color'|'luminosity'|'pass-through' /* groups only */;

interface LayerBase {
  id: string; type: 'raster'|'group'|'text'|'shape'|'fill'|'adjustment';
  name: string; visible: boolean; opacity: number /* 0..1 */; fillOpacity: number /* 0..1, raster only, excludes styles */;
  blend: BlendMode; locked: { pixels: boolean; position: boolean; transparency: boolean; all: boolean };
  clip: boolean;                      // clipping mask: composited only where the layer below it is opaque
  mask: LayerMask | null;             // { canvas: HTMLCanvasElement (alpha = mask value, RGB white), enabled, linked, density: 1, feather: 0 }
  styles: LayerStyles | null;         // see pixels/styles.js
  parent: GroupLayer | null;
  version: number;                    // bumped by every mutation; compositor caches key on it
}
interface RasterLayer extends LayerBase { type: 'raster'; x: number; y: number; canvas: HTMLCanvasElement; } // canvas may be any size; (x, y) is its document position
interface GroupLayer extends LayerBase { type: 'group'; children: Layer[] /* bottom -> top */; expanded: boolean; }
interface TextLayer extends LayerBase { type: 'text'; x: number; y: number; width: number|null /* null = point text */; text: string; font: TextStyle; render(): HTMLCanvasElement; }
interface ShapeLayer extends LayerBase { type: 'shape'; path: PathData; fill: Paint|null; stroke: StrokeStyle|null; render(): HTMLCanvasElement; }
interface FillLayer extends LayerBase { type: 'fill'; paint: Paint; render(): HTMLCanvasElement; }
interface AdjustmentLayer extends LayerBase { type: 'adjustment'; kind: AdjustmentKind; params: object; }
type Paint = { type: 'solid', color: RGBA } | { type: 'gradient', gradient: Gradient } | { type: 'pattern', pattern: PatternRef };
type Gradient = { kind: 'linear'|'radial'|'angle'|'reflected'|'diamond', stops: {pos: 0..1, color: RGBA}[], from: [x,y], to: [x,y], reverse?: boolean };
type RGBA = [r, g, b, a] with 0..255 channels and a 0..1; hex strings are accepted by helpers.

class Document {
  id, name, path, width, height, dpi; root: GroupLayer (blend 'pass-through'); layers(): Layer[] (flattened, bottom -> top)
  active: Layer | null; selected: Set<Layer>; selection: Selection | null; savedSelection: Selection | null
  guides: { axis: 'x'|'y', pos: number }[]; channels: { name, mask: Uint8ClampedArray }[]; paths: SavedPath[]
  history: History; dirty: boolean; version: number
  // tree ops (all used through history.run): add(layer, parent?, index?), remove(layer), move(layer, parent, index), find(id), indexOf(layer)
  // raster ops helpers: ensureRaster(layer) (rasterizes text/shape/fill in place), layerBounds(layer), contentBounds(layer)
  // events: emits 'change' ({ kind: 'pixels'|'tree'|'props'|'selection'|'guides'|'canvas', layer?, rect? }) through app.emit('doc:change', ...)
}
```

Layer canvases are `HTMLCanvasElement` (not Offscreen) so `drawImage` and the brush engine work on
the main thread; heavy pixel work goes through `pixel-worker.js` on ImageData copies.

`Selection` (`lib/selection.js`): `{ mask: Uint8ClampedArray(width*height) /* 0..255 */, bounds: Rect | null, outline(): Path2D (marching squares, cached), toCanvas(): HTMLCanvasElement (alpha canvas for destination-in), isEmpty, clone() }` plus static constructors `fromRect`, `fromEllipse`, `fromPolygon`, `fromMask`; combine modes `'replace'|'add'|'subtract'|'intersect'`; `transform(matrix)`; `feather/expand/contract/border/smooth` delegate to `pixels/selection-ops.js`.

## Compositor (`lib/compositor.js`)

`composite(doc, { rect?: Rect, scale?: 1, skipLayer?: Layer, until?: Layer, forExport?: boolean }) -> HTMLCanvasElement`
renders the tree bottom-up:

1. A group renders into its own canvas unless it is the root or `blend === 'pass-through'` with
   opacity 1 and no mask (then its children are drawn straight into the parent).
2. For each layer (visible only): `source = layerCanvas(layer)` (raster canvas; cached render for
   text/shape/fill keyed by `layer.version`), then the clipping-mask group (a base layer plus the
   consecutive `clip` layers above it) is flattened into one canvas limited to the base's alpha, then
   layer styles (`pixels/styles.js`, cached per version) are applied producing a possibly larger
   canvas with an offset, then the mask (`destination-in` with `mask.canvas` at the layer offset)
   and finally the result is drawn into the target with `globalAlpha = opacity` and the blend mode
   (0.4: a layer whose exterior effects or own mode are not Normal draws its effects apart, each in
   its own mode: see "Effect blend modes" at the end of this file):
   Canvas 2D `globalCompositeOperation` when it exists (normal→source-over, multiply, screen,
   overlay, darken, lighten, color-dodge, color-burn, hard-light, soft-light, difference,
   exclusion, hue, saturation, color, luminosity, linear-dodge→lighter), otherwise the per-pixel
   fallback in `pixels/blend.js` on the affected rect.
3. An adjustment layer takes the current target pixels (its "below"), runs
   `pixels/adjust.js` on a copy, and blends the result back through its mask and opacity
   (0.4: with its blend mode, Fill, channels and Blend If when it has them: see "Blending Options
   on adjustment layers" at the end of this file).
   `dissolve` is implemented as per-pixel random alpha in the fallback.
4. Caches: `layerCanvas` per layer version; group results per (group version, child versions); the
   full composite per document version. `rect` limits all work to that document rectangle (brush
   strokes repaint only the dirty rect). (0.4: a full composite goes through the repaint caches, which
   reuse it, repaint the edit's box, or start above a cached composite of the layers below the edit;
   consecutive adjustment layers share one pass: see "Repaint caches" at the end of this file.)

`flatten(doc)` = composite with `forExport: true` (no selection, no guides).

## History (`lib/history.js`)

```ts
class History {
  entries: { label: string, undo(): void, redo(): void, bytes: number, thumbnail?: string }[]; index: number
  run(label, mutate: () => void | Patch[]): void      // structural/property change: mutate() runs, must return inverse patches or use capture helpers below
  capture(layer, rect): Patch                         // snapshot layer pixels in rect before a change; returns a patch with before/after filled at commit()
  beginStroke(layer, label): StrokeHandle            // copies the layer canvas; endStroke(dirtyRect) diffs and records one entry
  undo(); redo(); canUndo; canRedo; goTo(index)
  memory limit: settings.historyMemoryMB, entries: settings.historyLimit; oldest entries are dropped first
  snapshots: [{ name, docState }]                     // History panel "new snapshot"
}
```

Entries bump `doc.version` and emit `doc:change`. `doc.dirty = history.index !== history.savedIndex`.

## Canvas view (`lib/canvas-view.js`)

Owns the `<canvas id="view">` sized to the host (devicePixelRatio aware), `zoom` (0.01..64), `pan`,
`rotation` (view-only, degrees), rulers (`<canvas>` strips with the unit from settings), guides
(draggable from rulers), grid, pixel grid at zoom ≥ 8, checkerboard, the document composite
(`imageSmoothingEnabled = zoom < 4`), the selection marching ants (dash offset animated while a
selection exists), and tool overlays (`tool.drawOverlay(ctx, view)` in screen space).
`toDoc(screenX, screenY)` / `toScreen(x, y)` / `visibleRect()`. Pointer events are normalised to
`{ x, y, screenX, screenY, pressure, tiltX, tiltY, buttons, button, shift, alt, ctrl, meta, pointerType }`
and routed to the active tool (`onPointerDown/Move/Up`, `onDoubleClick`, `onWheel`, `onKeyDown`);
Space temporarily switches to the hand tool, Ctrl/Alt+wheel zooms around the cursor, pinch zooms.
`invalidate(rect?)` schedules a repaint on the next animation frame.

## Tools (`lib/tools.js`, `lib/tools/*.js`)

```ts
interface Tool {
  id: string; name: string; icon: string; key?: string /* single letter, Photoshop's */; group: string /* toolbox slot */;
  cursor: string | (() => string); options?: OptionSpec[] /* rendered in the options bar, values stored in settings.tools[id] */;
  activate(app), deactivate(app), onPointerDown(e), onPointerMove(e), onPointerUp(e), onKeyDown(e), drawOverlay(ctx, view);
  // 0.4 traits (lib/tool-traits.js, L.12), read through paints(tool) / claimsModifier(tool, mod), never directly:
  paints?: boolean;                                  // a painting tool: digits set its opacity, not the layer's (finish-layer-menu)
  claimsModifiers?: Set<'ctrl' | 'alt' | 'space'>;   // modifiers the tool uses itself: no spring-loaded tool on them (conventions)
}
```

A tool that does not declare the two traits is classified by the fallback tables of `lib/tool-traits.js` (by tool id):
the painting tools are the brush, pencil, colour replacement, eraser family, clone and pattern stamp, history brush,
gradient, paint bucket, dodge, burn, sponge, blur, sharpen and smudge; the type tools claim Ctrl, the pen, path and
shape tools Ctrl and Alt, the Move tool Ctrl. An owner that adds a tool sets the traits on it in its own file.

Tool families and files (toolbox slot in brackets): `move.js` (move [move], crop [crop]),
`select.js` (rectangular/elliptical/row/column marquee [marquee], lasso/polygonal/magnetic [lasso],
quick selection and magic wand [wand]), `nav.js` (eyedropper, color sampler, ruler [eyedropper]; hand and rotate
view [hand]; zoom [zoom]), `paint.js` (brush, pencil [brush]; eraser [eraser]), `retouch.js` (spot healing, healing,
patch, red eye [heal]; color replacement [brush]; clone and pattern stamp [clone]; history brush [history]; background
and magic eraser [eraser]; blur, sharpen, smudge [blur]; dodge, burn, sponge [retouch]), `fill.js` (gradient, paint
bucket [fill]), `text.js` (horizontal and vertical type [text]), `vector.js` (shapes [shape], pen family [pen], path and
direct selection [path-select]). Free Transform (`image-ops.js`) is a tool without a toolbox slot.

The options bar is built from `OptionSpec`s (`{ kind: 'number'|'slider'|'select'|'checkbox'|'color'|'button'|'segment'|'brush', key, label, min, max, step, options, default }`)
by `ToolManager.renderOptions` in `lib/tools.js`; tools read `this.opt(key)` and may add custom controls in `renderOptions(bar)`.

### Brush engine (`lib/brush.js`)

`new BrushStroke(target: { layer, mask?: boolean }, settings: { size, hardness, opacity, flow, spacing, angle, roundness, scatter, pressureSize, pressureOpacity, smoothing, blend, color, eraser?: boolean })`
accumulates dabs into a stroke buffer (one canvas the size of the layer) with `globalAlpha = flow`,
spacing along the smoothed path, radial-gradient dabs (hardness = inner solid radius), and
composites the buffer onto the layer with `opacity` and `blend` on every frame for preview
(restoring the pre-stroke layer copy first) and finally on `end()`; the selection (if any) clips the
buffer. Painting a mask uses white (reveal) / black (hide) with the mask's alpha. Clone/heal/pattern
sources plug in through `settings.sampler(x, y, dabCanvas)`.

## Pixel modules (`src/shared/pixels/*.js`) — contracts for Node-testable pure code

```ts
// core.js
interface ImageDataLike { width: number; height: number; data: Uint8ClampedArray /* RGBA, straight alpha, length = w*h*4 */ }
createImage(width, height, fill?: RGBA): ImageDataLike; cloneImage(img); cropImage(img, rect); pasteImage(dst, src, x, y)
type Rect = { x: number, y: number, width: number, height: number }; intersectRect, unionRect, clampRect(rect, w, h), emptyRect
clamp255(n), lerp(a, b, t), mix(c1, c2, t)
getPixel(img, x, y): RGBA; setPixel(img, x, y, rgba); forEachPixel(img, rect|null, fn(i, x, y))
makeLut(fn: (v: 0..255) => 0..255): Uint8ClampedArray; applyLut(img, lutR, lutG?, lutB?, rect?)   // never touches alpha
luminance(r, g, b) /* Rec.601, 0..255 */; premultiply/unpremultiply helpers
randomSeeded(seed): () => number  // deterministic noise for tests

// color.js
rgbToHsl, hslToRgb, rgbToHsv, hsvToRgb, rgbToLab, labToRgb (D65), hexToRgba('#rrggbb[aa]' | 'rgb(...)'), rgbaToHex, contrastColor, parseColor

// blend.js
blendPixel(mode: BlendMode, sr, sg, sb, br, bg, bb): [r, g, b]           // separable + non-separable modes, 0..255
blendImages(mode, src: ImageDataLike, dst: ImageDataLike, opacity: 0..1, rect?: Rect): void  // dst = dst blended with src (same size), honours src alpha, straight alpha
CANVAS_BLEND: Record<BlendMode, string | null>   // Canvas 2D equivalent or null when blendImages is needed

// adjust.js — every function: (img: ImageDataLike, params, rect?: Rect) => void (in place); LUT-based where possible
ADJUSTMENTS: Record<AdjustmentKind, { name, defaults, apply(img, params, rect?), lut?(params) -> [lutR, lutG, lutB] }>
kinds: 'brightness-contrast' {brightness -150..150, contrast -100..100, legacy?}, 'levels' {perChannel? , rgb: {inBlack, inWhite, gamma, outBlack, outWhite}, r?, g?, b?},
'curves' {rgb: [[x,y]...], r?, g?, b? /* monotone cubic through points, 0..255 */}, 'exposure' {exposure -20..20, offset -0.5..0.5, gamma 0.01..9.99},
'vibrance' {vibrance, saturation}, 'hue-saturation' {hue -180..180, saturation -100..100, lightness -100..100, colorize?, colorizeHue, colorizeSat, colorizeLight, range?: 'master'|'reds'|...},
'color-balance' {shadows: [c,m,y], midtones: [...], highlights: [...], preserveLuminosity}, 'black-white' {reds, yellows, greens, cyans, blues, magentas, tint?: {hue, sat}},
'photo-filter' {color, density, preserveLuminosity}, 'channel-mixer' {r: {r,g,b,constant}, g, b, monochrome}, 'invert' {}, 'posterize' {levels 2..255}, 'threshold' {level 1..255},
'gradient-map' {stops, reverse}, 'selective-color' {reds: {c,m,y,k}, ..., relative}, 'desaturate' {}, 'equalize' {}, 'shadows-highlights' {shadows, highlights, radius}, 'color-lookup'? (no)
autoLevels(img, {clip}), autoContrast(img), autoColor(img), histogram(img, rect?) -> { r, g, b, l: Uint32Array(256) }

// filters.js — same shape: FILTERS: Record<kind, { name, category, defaults, apply(img, params, rect?) }>; distortions use inverse mapping with bilinear sampling and edge mode 'transparent'|'repeat'|'wrap'
blur: 'gaussian-blur' {radius 0.1..250}, 'box-blur' {radius}, 'motion-blur' {angle, distance}, 'radial-blur' {amount, method: 'spin'|'zoom', center}, 'surface-blur' {radius, threshold}, 'lens-blur'? (no)
sharpen: 'sharpen' {amount}, 'unsharp-mask' {amount, radius, threshold}, 'smart-sharpen' ≈ unsharp with edge weighting, 'high-pass' {radius}
noise: 'add-noise' {amount, distribution: 'uniform'|'gaussian', monochromatic, seed}, 'median' {radius}, 'despeckle' {}, 'dust-scratches' {radius, threshold}, 'reduce-noise' {strength}
pixelate: 'mosaic' {size}, 'crystallize' {size, seed}, 'pointillize' {size}, 'fragment' {}
distort: 'twirl' {angle}, 'pinch' {amount}, 'spherize' {amount}, 'ripple' {amount, size}, 'wave' {amplitude, wavelength, type}, 'zigzag' {amount, ridges}, 'polar' {toPolar}, 'shear' {points}, 'offset' {dx, dy, wrap}
stylize: 'emboss' {angle, height, amount}, 'find-edges' {}, 'solarize' {}, 'diffuse' {mode}, 'extrude'? (no), 'oil-paint' {radius, levels}, 'wind'? (no), 'glowing-edges' {width, brightness}
render: 'clouds' {seed, scale, colors}, 'difference-clouds', 'lens-flare' {center, brightness}, 'vignette' {amount, size, roundness}, 'gradient-fill'? (no — use fill layers)
other: 'maximum' {radius}, 'minimum' {radius}, 'custom' {kernel 3x3|5x5, scale, offset}, 'invert-alpha'

// selection-ops.js — masks are Uint8ClampedArray(width*height), 0..255
floodFill(img, x, y, { tolerance 0..255, contiguous, antialias?, sampleMerged? }) -> mask
colorRange(img, colors: RGBA[], { fuzziness }) -> mask
maskFromAlpha(img) -> mask; maskBounds(mask, w, h) -> Rect|null; combineMasks(a, b, mode) -> mask; invertMask
feather(mask, w, h, radius); expand(mask, w, h, px); contract(mask, w, h, px); border(mask, w, h, px); smooth(mask, w, h, radius); grow/similar helpers
outline(mask, w, h) -> Array<[x, y][]> (closed polygons in pixel corner coordinates, marching squares; holes included)
rasterizePolygon(points, w, h, { antialias }) -> mask; rasterizeEllipse(rect, w, h) -> mask

// transform.js
resample(img, matrix: [a, b, c, d, e, f], outRect, { quality: 'nearest'|'bilinear'|'bicubic' }) -> ImageDataLike (inverse-mapped)
perspective(img, srcQuad, dstQuad, outRect, { quality }) -> ImageDataLike (homography)
resize(img, newW, newH, { method: 'nearest'|'bilinear'|'bicubic'|'lanczos'|'area' }) -> ImageDataLike
rotate90/180/flip helpers; contentBounds(img) -> Rect|null (non-transparent bbox)

// styles.js
interface LayerStyles { dropShadow?, innerShadow?, outerGlow?, innerGlow?, bevel?, satin?, colorOverlay?, gradientOverlay?, patternOverlay?, stroke? } (each { enabled, blend, opacity, color/gradient, size, spread/choke, distance, angle, useGlobalLight, softness, position:'outside'|'inside'|'center' (stroke), style:'inner-bevel'|'outer-bevel'|... (bevel), depth, direction, highlight/shadow colours })
applyStyles(img: ImageDataLike, styles, { pad }) -> { image: ImageDataLike, offsetX, offsetY }   // output grows by pad on each side (callers compute pad with stylePadding(styles))
stylePadding(styles) -> number

// retouch.js — dab operations on a rect of an image, used by the retouch tools (all in place, strength 0..1, dab mask: Float32Array or alpha ImageData)
dodge(img, rect, dabMask, { range: 'shadows'|'midtones'|'highlights', exposure }), burn(...), sponge(img, rect, dabMask, { mode: 'saturate'|'desaturate', flow }),
blurDab(img, rect, dabMask, { strength }), sharpenDab(...), smudge(img, rect, dabMask, carried: ImageDataLike, { strength }) -> updates carried, heal(img, rect, dabMask, source: ImageDataLike, { }) (texture from source, colour matched to destination mean)
```

Every pixel function must: accept an optional `rect` (default whole image), never read outside the
image, leave alpha untouched unless it is the point of the operation, be deterministic given a seed,
and have a unit test in `tests/unit/<module>.test.mjs` that checks numbers (not just "does not throw").

## File formats (`lib/io.js`)

- **Open**: PNG (all colour types and depths through `pixels/png.js`; 16-bit files open at depth 16, palette files as Indexed Color), JPEG, WebP, GIF (first frame, as Indexed Color with its colour table and transparent index), TIFF (`pixels/tiff.js`: strips and tiles, 1–32-bit integer and float, bilevel / grey / palette / RGB / CMYK, none / PackBits / LZW / Deflate; first page), Targa (`pixels/tga.js`), BMP, AVIF, SVG (rasterised at document size), PSD/PSB (via ag-psd: layers, groups, masks, opacity, blend modes, visibility, clipping, text layers (rasterised + text data kept when available), adjustment layers mapped where kinds exist), `.pigment`.
- **Format registries** (0.3): `registerOpenFormat` and `registerExportFormat` in `lib/io.js` (see "0.3 features"). Registered readers: GIF and palette PNG (`lib/modes/formats.js`), 16-bit PNG, TIFF and TGA (`lib/depth.js`). Registered writers: `gif`, `png8` (`lib/modes/formats.js`), `png16`, `tiff`, `tga` (`lib/depth.js`); each adds its extensions to `WRITE_EXTENSIONS` and its option fields to Export As.
- **`.pigment`**: a ZIP (store or deflate) with `document.json` (version 2: size, dpi, mode, depth, colour table, duotone inks, tree with layer parameters, selection/channels/paths/guides, `meta` with File Info, image-mode state and layer tags) and `layers/<id>.png` (raster pixels), `layers/<id>.u16|f32` (deep pixels, raw little-endian, deflated), `masks/<id>.png`, `thumbnail.png`. Written and read by `src/shared/zip.js` + the renderer's PNG encoding (canvas `toBlob`).
- **Export As**: PNG (8-bit, transparency), PNG-8 (palette, dither, transparency, matte), PNG 16-bit, JPEG (quality, background), WebP (quality / lossless), GIF (single frame), TIFF (8 / 16 / 32-bit float or the document's depth; LZW, Deflate, PackBits, none), Targa (24/32-bit, optional RLE), PSD (ag-psd `writePsd`: raster layers, groups (with masks), masks, opacity/fill opacity/blend/visibility/locks, text layers as text, adjustment layers as PSD adjustments where a type exists), scale/resample, metadata strip, "quick export" PNG.
- **Save for Web (Legacy)** (`lib/modes/save-for-web.js`): 2-up dialog for GIF, JPEG, PNG-8, PNG-24 and WebP; Save writes the previewed bytes.
- **Depth on save**: a 16/32-bit document saved to `.png` is written as 16-bit PNG and `.pigment` keeps the deep planes; PSD, JPEG, WebP and TGA are written from the 8-bit composite with a one-time toast. An Indexed Color document saved to `.png` is written as PNG-8. PSD saves get an XMP packet (File Info) added after the write (`lib/file-info.js`); EXIF and XMP are read on open for JPEG, TIFF, PSD, PNG and WebP.
- **Save safety**: `WRITE_EXTENSIONS` (pigment, psd, png, jpg, jpeg, webp, plus gif, tif, tiff and tga from the registered export formats) are the only formats `encodeForPath` writes; `Documents.save` sends read-only formats (bmp, svg, avif, ico) to Save As, and a typed-in read-only extension becomes `.png`. JPEG/WebP quality is asked once per document (`doc.saveOpts`, remembered as `settings.saveQuality`) and never taken from the Export As dialog.
- **Clipboard**: copy/paste images with the system clipboard (PNG) through the bridge; copy merged.

## Panels (`lib/panels/*.js`) and layout

The right dock holds tabbed panel groups (`app.panels.register({ id, title, icon, element, group: 'top'|'middle'|'bottom', onShow })`);
the layout (which panels, order, heights) is persisted in `settings.panelLayout`. Default groups:
**top** Color · Swatches · Brushes; **middle** Properties · Adjustments · Character · Paths; **bottom** Layers · Channels · History · Navigator · Info.
The left toolbox lists tool slots; a long press or right click on a slot shows its flyout.
The options bar (top) shows the active tool's `OptionSpec`s. The status bar shows zoom, document size, memory and a one-line hint.

## Events on `app`

`doc:opened` (doc), `doc:activated` (doc|null), `doc:closed` (id), `doc:change` ({ doc, kind, layer?, rect? }), `doc:saved` (doc), `doc:dirty` ({ doc, dirty }),
`selection:changed` (doc), `layer:activated` ({ doc, layer }), `tool:changed` ({ tool, previous }), `tool:options` ({ tool, key, value }), `color:changed` ({ fg, bg }),
`view:changed` ({ zoom, pan, rotation }), `settings:changed` (patch), `history:changed` (doc), `panel:changed`.

## Theme

Same tokens as Folio (`styles/theme.css`): `--bg`, `--bg-elevated`, `--bg-sunken`, `--fg`, `--fg-muted`, `--border`, `--accent`, `--accent-soft`, `--danger`, `--mono`; light/dark via `[data-theme]`. The canvas area background is `--canvas-bg`.

## Tests

- `npm test` — node:test over `tests/unit/*.test.mjs`: every pixel module, zip, keymap, menu template, protocol, startup files, the actions model, and the 0.4 skeleton's pure modules (gradient model, rich-text model, document store, preset store and files, sessions, snap, styles instances, commands, keymap and menu of 0.4). No DOM, no Electron. 517 tests in 31 files at 0.3, 531 at 0.3.1, 647 in 47 files with the 0.4 skeleton.
- `npm run test:e2e` — Playwright (Chromium) against `tests/e2e/server.mjs` serving `src/renderer` with the browser bridge; specs drive the real UI (`window.pigmentApp`, `window.__pigmentTest`). 304 tests in 35 spec files at 0.3, 361 at 0.3.1, 377 in 42 files with the 0.4 skeleton (`skeleton-04.spec.mjs`, port 8800, holds its smoke tests); each 0.3 feature group has its own spec (`filters-a`, `filters-b`, `filter-gallery`, `gallery-b`, `blur-gallery`, `adjust-more`, `modes`, `depth`, `select-mask`, `actions`, `align-blend`, `content-aware-lens`, `extras3`). `app.spec.mjs` checks that every menu command and panel is registered; the group specs assert that their commands are not in `app.stubbed`. Commits made by a dialog land after it closes (under `app.busy`), so specs poll history rather than reading it at once.
- `npm run test:electron` — launches the real app (xvfb on Linux): bridge, menu, open/save through the main process, packaged build; with the 0.4 skeleton also the preset store's files (`presets.spec.mjs`) and Shift+Alt+letter and the menu command source (`keys-04.spec.mjs`): 3 tests.
- CI: `.github/workflows/pigment-ci.yml`; releases: `pigment-release.yml` (tags `pigment-v*` or a manual run with a `tag` input) build installers on windows-latest, macos-latest and ubuntu-latest.

## 0.2 features

This section was written as the contract between the 0.2 builders and is kept as the reference for
those modules; everything below is implemented. Known gaps: text on a path follows the first
subpath with two or more anchors; smart filters have no individual masks; `filter:last` does not
repeat the Camera Raw filter; the browser build has no Sign in with ChatGPT (keys only, kept in
`localStorage`).

Pigment 0.2 adds AI (Sign in with ChatGPT, OpenAI and Gemini API keys), smart objects with smart
filters, Warp / Perspective Warp / Puppet Warp, the Camera Raw filter, printing, shape path
operations, text on a path, stacked vertical text, and Lab/CMYK readouts with proof colours. Each
feature is a module listed in `app.js` `MODULES` that registers the commands the menu already names
(`src/main/menu.js`, `src/shared/keymap.js`); until a module lands, a stub registers the same ids
disabled. **Ownership** (one builder per group of files, nobody else edits them):

| Feature | Files owned |
|---|---|
| AI core | `src/main/ai.js`, `src/renderer/lib/ai/client.js`, `lib/ai/providers.js`, `lib/ai/accounts.js`, `styles/ai.css` (accounts part), `tests/unit/ai.test.mjs`, `tests/e2e/ai-core.spec.mjs` |
| AI features | `lib/ai/features.js`, `lib/ai/assistant.js`, `lib/panels/assistant.js`, `tests/e2e/ai-features.spec.mjs` (uses a fake provider through `window.__pigmentTest.ai`) |
| Smart objects | `lib/smart-object.js`, `lib/io.js` (smart entries in `.pigment`, rasterised in PSD), `lib/panels/layers.js` (type icon, smart filter rows), `styles/smart.css`, `tests/e2e/smart.spec.mjs` |
| Warp | `src/shared/pixels/warp.js`, `lib/warp.js`, `lib/image-ops.js` (only the `TransformTool` warp mode hooks named below), `styles/warp.css`, `tests/unit/warp.test.mjs`, `tests/e2e/warp.spec.mjs` |
| Camera Raw, print, path ops | `src/shared/pixels/develop.js`, `lib/develop-ui.js`, `lib/print.js`, `src/main/print.js`, `lib/path-ops.js`, `lib/tools/vector.js` (path-operation option and commands), `tests/unit/develop.test.mjs`, `tests/e2e/extras.spec.mjs` |
| Text and colour | `lib/text-path.js`, `lib/tools/text.js` (type-on-path entry), `lib/panels/character.js` (orientation control), `lib/color-modes.js`, `src/shared/pixels/color.js` (Lab/CMYK), `lib/panels/info.js`, `lib/canvas-view.js` (proof/gamut overlay hook named below), `tests/unit/color.test.mjs`, `tests/e2e/text-color.spec.mjs` |

Shared integration points that already exist (do not re-implement them):

- `document.js`: `registerLayerType(type, cls, { describe })` + `LAYER_TYPES` (used by `layerFromDescription` and `Document.describe`), `textExtensions` (`{ test(layer), layout(layer, ctx), baseBounds(layer), renderBase(layer) }`), `TextLayer.pathText`, `ShapeLayer.render()` delegating to `lib/path-ops.js renderShapeLayer(layer, canvas, bounds)`.
- `image-ops.js`: any layer with `usesMatrixTransform === true` is transformed exactly like a text layer (a `transform` matrix, set through `setLayerProps`, kept editable); distort/perspective are refused for it.
- `preload.cjs` `pigment.ai(method, payload)` ↔ `ipc.js` `createAi({ electron, getWindow, settings }).dispatch(method, payload)`; `pigment.printImage(opts)` ↔ `src/main/print.js printImage({ electron, getWindow }, opts)`. The browser bridge has `ai: null` and `printImage()` → `window.print()`.
- `index.html` CSP `connect-src` allows `https://api.openai.com`, `https://auth.openai.com`, `https://generativelanguage.googleapis.com` (browser build only; the desktop app calls from the main process). Stylesheets `styles/ai.css`, `warp.css`, `smart.css`, `extras2.css` are linked and empty.
- UI state for the menu (`app.syncUiState`): `layerType` (`'smart'` enables the Smart Objects items), `textOrientation`, `proofColors`, `gamutWarning` (the last two mirror `settings.proofColors` / `settings.gamutWarning`).
- Icons: `sparkle`, `smart`, `warp`, `print` exist in `lib/icons.js`.

### AI

**Accounts.** Two providers, each with one of two sign-in methods:

- OpenAI: *Sign in with ChatGPT* (the open-source token-sharing flow, uses the user's ChatGPT Plus/Pro plan for Responses API requests) or an *API key* (platform.openai.com, billed to the key; the only way to use image models).
- Google Gemini: an *API key* from Google AI Studio (Google offers no plan-based sign-in for third-party apps; the accounts dialog says so).

All secrets live in the main process: `<userData>/ai-credentials.json`, every value encrypted with `safeStorage.encryptString` (base64) when `safeStorage.isEncryptionAvailable()`, otherwise stored plain and `status.encryption === false` so the dialog can warn. The renderer only ever receives a status object.

```ts
// pigment.ai(method, payload) -> Promise<result>; errors reject with { message, code? }
status(): { available: true, encryption: boolean,
            openai: { method: 'chatgpt'|'api_key'|null, email?: string, plan?: boolean /* chatgpt.tokens.use.direct granted */ },
            gemini: { method: 'api_key'|null } }
setApiKey({ provider: 'openai'|'gemini', key: string }): status   // validates with a models request first
signOut({ provider }): status
chatgptSignIn({ port?: number }): status      // opens the system browser; resolves when the loopback callback arrives (5 min timeout)
chatgptSignInStatus(): { pending: boolean, url?: string }   // the authorization URL, for a "copy link" button
chatgptSignInManual({ callbackUrl: string }): status        // paste the address bar of the callback page (browser on another machine)
chatgptSignInCancel(): void
models({ provider }): { id: string, kind: 'chat'|'image'|'other', label?: string }[]   // cached 10 minutes
request({ provider, path, method?: 'GET'|'POST', json?: object, multipart?: { fields: Record<string,string>, files: { field, name, type, base64 }[] },
          stream?: boolean, timeoutMs?: number }): { status: number, body: any }
// `path` is relative to the provider base: OpenAI https://api.openai.com/v1, Gemini https://generativelanguage.googleapis.com/v1beta.
// main adds Authorization: Bearer <api key | ChatGPT access token> or x-goog-api-key, refreshes ChatGPT tokens,
// and for the ChatGPT plan route reshapes a /responses body (below). stream: true means the SSE events of
// /responses are aggregated and the `response.completed` payload's `response` object is returned as body.
```

Sign in with ChatGPT (from OpenAI's open-source flow): authorize URL `https://auth.openai.com/api/accounts/authorize`, token URL `https://auth.openai.com/api/accounts/oauth/token`, issuer `https://auth.openai.com`, `resource=https://api.openai.com/v1` in both requests, scope `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`, PKCE S256, `state` + `nonce`, loopback `redirect_uri=http://127.0.0.1:1455/auth/callback` (the port may vary, nothing else). First sign-in sends `client_id=dynamic_agent_client`, `agent_name_hint=Pigment` and a stable `ext_agent_host_id=urn:uuid:<generated once per installation, stored in settings>`; the callback query carries the issued `client_id` (`oaiapp_…`) which is stored and used for the code exchange (`grant_type=authorization_code`, `code_verifier`, `redirect_uri`, `resource`) and for refreshes (`grant_type=refresh_token`, tokens rotate; honour `earliest_refresh_at`; refresh 5 minutes before `expires_in`). Validate the ID token claims (`iss`, `aud` contains the client id, `exp`, `nonce`). Fatal token errors (`invalid_grant`, `invalid_client`, `invalid_refresh_token`, `refresh_token_expired`, `refresh_token_invalidated`, `refresh_token_reused`, `token_expired`) clear the sign-in. Plan-route request shaping for `POST /responses`: `store: false`, `stream: true`, system/developer messages moved into `instructions`, drop `background, conversation, max_output_tokens, max_tool_calls, metadata, moderation, multi_agent, prompt, prompt_cache_key, prompt_cache_options, prompt_cache_retention, safety_identifier, service_tier, temperature, top_logprobs, top_p, truncation, user`, drop hosted tools `code_interpreter, file_search, image_generation, mcp, tool_search` (function tools and `web_search` stay), no object `tool_choice`. The plan model catalog is `GET /v1/models` answering `{ models: [{ slug }] }` (API keys answer `{ data: [{ id }] }`). Error codes to translate: `subscription_sharing_user_not_eligible`, `subscription_sharing_usage_limit_exceeded` (HTTP 429), `subscription_sharing_usage_unavailable`, `subscription_sharing_route_not_supported`, `subscription_sharing_unsupported_capability`, `subscription_sharing_invalid_user`.

**Providers (`lib/ai/providers.js`).** Pure request builders over `aiRequest` from `lib/ai/client.js` (which calls `bridge.ai` in Electron and, in the browser build, fetches the providers directly with keys from `localStorage['pigment.ai.keys']`; tests inject `window.__pigmentTest.ai = { request(payload) -> body }` and the client prefers it).

```ts
listModels(provider): Promise<{ chat: string[], image: string[], default: { chat, image } }>
  // OpenAI defaults: chat = first of [gpt-5.5, gpt-5.1, gpt-5, gpt-4.1, gpt-4o] present, image = first of [gpt-image-1.5, gpt-image-1, gpt-image-2] present
  // Gemini: chat = first of [gemini-2.5-pro, gemini-2.5-flash, gemini-2.0-flash] present, image = first of [gemini-3.1-flash-image(-preview), gemini-3-pro-image-preview, gemini-2.5-flash-image] present
chat({ provider, model, instructions, messages: { role: 'user'|'assistant', text?: string, images?: string[] /* data URLs */ }[],
       tools?: { name, description, parameters /* JSON schema */ }[], onToolCall?: (name, args) => Promise<any>, maxRounds?: number,
       shouldStop?: () => boolean /* checked before every follow-up request; an onToolCall error with code 'stopped' aborts the loop */ })
  : Promise<{ text: string, calls: { name, args, result }[], truncated: boolean /* the model wanted more rounds than maxRounds */ }>
  // OpenAI: POST /responses (input items input_text / input_image; function tools; function_call -> function_call_output loop, the whole
  // history resent each round). Gemini: POST /models/{model}:generateContent (parts text / inline_data; tools.functionDeclarations built by
  // geminiDeclaration(): a tool without properties declares no parameters, open objects and untyped values become JSON strings that the
  // tool implementations parse back (assistant.js parseMaybeJson); functionCall -> functionResponse parts).
generateImage({ provider, model, prompt, width, height, transparent?: boolean, n?: 1 }): Promise<HTMLCanvasElement>
  // OpenAI POST /images/generations { model, prompt, n, size, quality: 'auto', background: transparent ? 'transparent' : 'auto', output_format: 'png' }
  //   (size from the nearest the model accepts: gpt-image 1024x1024 / 1536x1024 / 1024x1536, dall-e-3 1024x1024 / 1792x1024 / 1024x1792, dall-e-2 squares;
  //   the result is scaled to cover width × height and centre-cropped, never stretched; `background` only for gpt-image-1/1.5; dall-e-3 cannot edit)
  //   Gemini with `transparent`: the prompt asks for a plain white background and the near-white border is keyed out (keyWhiteBorder).
  // Gemini POST /models/{model}:generateContent with generationConfig.responseModalities ['IMAGE'] (+ 'TEXT' when the model needs it),
  //   imageConfig.aspectRatio from the nearest supported ratio, imageSize only for gemini-3.x; the first inlineData part is the image.
editImage({ provider, model, image: HTMLCanvasElement, mask?: HTMLCanvasElement /* alpha 255 = pixels to change */, prompt, transparent?: boolean })
  : Promise<HTMLCanvasElement /* same size as image */>
  // OpenAI POST /images/edits multipart: image[] (PNG), mask (PNG whose alpha is 0 where the image may change), prompt, model, size, output_format png,
  //   input_fidelity 'high' (gpt-image-1/1.5 only), background. Gemini: the image (and, when a mask is given, the mask as a second image with the
  //   instruction to change only the white area) plus the prompt; the result is composited back through the mask so untouched pixels stay exact.
describeImage({ provider, model, image, prompt? }): Promise<string>
```

Images sent to a provider are downscaled so the long edge is at most 1536 px (OpenAI) or 2048 px (Gemini); results are resampled back (`pixels/transform.js resize`).

**Features (`lib/ai/features.js`, AI menu).** Every command checks `status` first and opens the accounts dialog when nothing is connected; long requests run under `app.busy` with a cancel button and a toast on error. Results land as new layers above the active one (undoable through `structural`) except where noted:

- `ai:generative-fill` (needs a selection): crops a square-ish region around the selection bounds padded by 25 % (clamped to the canvas, at most 1536 px), `editImage` with the selection as mask, composites the answer through the selection (feathered 1 px) into a new layer "Generative Fill". Prompt dialog with provider/model selects (remembered in `settings.ai`) and a "Variations: 1–3" count (one layer each).
- `ai:generative-expand`: the dialog takes the new canvas size and anchor; the canvas grows with a transparent extension (`image:canvas-size` with `color: null`) and the transparent area of the composite is the mask (a transparent band added earlier by Canvas Size counts too); same flow, layer "Generative Expand".
- `ai:generate-image`: prompt + size (document size by default, or a new document of W × H) → new layer or new document (recorded as a "Generate Image" history entry, so the document counts as unsaved).
- `ai:remove-background`: `editImage` with prompt "remove the background, keep the subject, transparent background" and `transparent: true`; the result's alpha becomes a layer mask on a copy of the layer (so it stays editable), intersected with the layer's existing enabled mask (whose hidden pixels are also not sent); Gemini (no alpha output) returns the subject on white, the near-white border is keyed out.

Provider choice: `settings.ai.defaultProvider` ("Preferred provider" in AI Accounts) wins whenever it serves the request kind; otherwise the provider the last dialog chose for that kind (`imageProvider` / `chatProvider`); changing the preferred provider resets both. Masks built from the selection are feathered as if the canvas continued beyond its border (`featherKeepingBorder`), so a fill touching the border stays opaque there.
- `ai:replace-background` / `ai:replace-sky`: prompt dialog; mask = inverse of the subject (from `remove-background`) or the top sky region prompt; new layer.
- `ai:describe`: `describeImage` → dialog with the text, "Copy", "Use as document description" (`doc.meta.description`).

**Assistant (`lib/ai/assistant.js`, panel `assistant`).** A chat panel: provider/model selects, "attach the current image" toggle (downscaled composite, default on), message list, input. The model gets `instructions` describing Pigment and these tools (JSON schema, same for both providers); each call runs through the normal command/history path so it is undoable, and its result (text) is returned to the model:

`get_document` (size, layers with id/name/type/visible/opacity/blend, selection bounds), `set_active_layer(id)`, `apply_adjustment(kind, params)` (`image:adjust-*` with params, see `pixels/adjust.js`), `apply_filter(kind, params)` (`filter:*`), `run_command(id, arg)` (any registered command id; the assistant sees the command list in its instructions), `new_layer(name)`, `set_layer_props(id, { opacity, blend, visible, name })`, `select(kind: 'all'|'none'|'inverse'|'rect', rect?)`, `crop(rect)`, `resize_image(width, height)`, `canvas_size(width, height, anchor)`, `fill_selection(color)`, `add_text(text, x, y, size, color)`, `generative_fill(prompt)` (when a selection exists and an image model is connected). The panel shows the calls it made ("Applied Levels…") and a final message. The conversation is per document and kept in memory only.

### Smart objects (`lib/smart-object.js`)

```ts
class SmartLayer extends Layer {            // type 'smart', registered with registerLayerType('smart', SmartLayer, { describe })
  source: { kind: 'document', doc: Document } | { kind: 'image', canvas: HTMLCanvasElement, name?: string };
  transform: Matrix | null;                 // base space (0,0 .. source width/height) -> document space; usesMatrixTransform = true
  filters: { kind: string, params: object, enabled: boolean, mask?: null }[];   // smart filters, applied in order at render time
  filtersEnabled: boolean;
  bounds(): Rect; render(): { canvas, x, y }  // cached on (source version, transform, filters); the document source is composited with a Compositor
}
```

Commands: `layer:smart-convert` (selected layers → one smart object whose source is a new Document of the canvas size holding copies of those layers; the originals are removed, undoable), `layer:smart-via-copy` (duplicate with a deep-copied source), `layer:smart-edit` (opens the source document in a new tab titled "<layer name> (smart object)"; File › Save in that tab writes back into the layer (`doc.smartHost = { hostDoc, layerId }`) and re-renders the host; closing asks to apply unsaved changes), `layer:smart-replace` (file dialog → new source image, transform kept), `layer:smart-export` (writes the source as `.pigment` or PNG), `layer:smart-reset` (transform = null), `layer:smart-rasterize` (replaces by a raster layer of the render), `layer:smart-filters-toggle`, `layer:smart-filters-clear`. `file:place` places images as smart objects when `settings.placeAsSmart !== false` (Preferences). Filters run on a smart layer (any `filter:*` dialog, Camera Raw included) append a smart filter instead of editing pixels; adjustments too (`kind: 'adjust:<kind>'`). The Layers panel shows a `smart` badge and, below the layer, one row per smart filter with a visibility eye and double-click to re-open the dialog with its params. Save: `.pigment` entries `smart/<layerId>.pigment` (nested document written with `writePigment`) or `smart/<layerId>.png`; PSD export rasterises. Free Transform works through `usesMatrixTransform` (the render stays sharp because it resamples the source at the final size: `render()` must rasterise the source through the matrix, not scale a cached bitmap).

### Warp (`src/shared/pixels/warp.js`, `lib/warp.js`)

Pure engine (Node-tested): `meshWarp(img, src: Grid, dst: Grid, { interp: 'bilinear'|'bicubic' })` where a Grid is `{ cols, rows, points: [x, y][] }` ((cols+1)·(rows+1) points, row-major; the inverse mapping of each destination quad uses two triangles with affine maps); `bezierWarp(img, rect, controls: [x, y][16], { subdivisions })` (a bicubic Bézier patch over `rect`, sampled into a mesh then `meshWarp`); `mlsWarp(img, pins: { from: [x,y], to: [x,y] }[], { kind: 'rigid'|'similarity'|'affine', alpha: 1, step: 4 })` (moving least squares on a step-px grid, then `meshWarp`); `perspectiveMesh(quads: { src: Quad, dst: Quad }[])` helper building a Grid from adjoining quads for Perspective Warp. Every function returns `{ image: ImageDataLike, x, y }` with the bounding box of the warped pixels (transparent outside).

UI: Free Transform gains a **Warp** mode (`edit:transform-warp`, or the Warp button in the options bar while transforming): the box shows a 4×4 Bézier control net (corner anchors with handles, 4 inner points), draggable; presets (None, Arc, Arc Lower, Arc Upper, Arch, Bulge, Shell Lower, Shell Upper, Flag, Wave, Fish, Rise, Fisheye, Inflate, Squeeze, Twist) with a Bend slider and horizontal/vertical distortion fields; Enter commits through `history.replaceCanvas` (raster) or a toast for text/shape (rasterise first). The hooks in `image-ops.js` for this are `TransformTool.warp = { active, controls, render(canvas, x, y) }`, read by `update()` / `commit()` / `drawOverlay()`; the warp builder owns those three hook sites and nothing else in the file. `edit:perspective-warp`: layout mode (drag quads on the image, edges snap together), warp mode (drag corners; shift-click an edge makes it vertical/horizontal), Enter commits. `edit:puppet-warp`: shows a triangle mesh over the layer's opaque pixels (density: fewer/normal/more), click adds pins, drag moves them (Alt-drag rotates around a pin), Delete removes the selected pin, modes rigid/normal/distort, Enter commits. All three run as a session of the `transform` tool (`app.tools.activate('transform')` style) with the same Enter/Escape handling as Free Transform.

### Camera Raw filter (`src/shared/pixels/develop.js`, `lib/develop-ui.js`)

`develop(img, params)` applies in order: white balance (`temperature` −100..100 as a blue/yellow shift, `tint` −100..100 green/magenta), `exposure` −5..5 EV, `contrast` −100..100, `highlights`/`shadows`/`whites`/`blacks` −100..100 (luminance-masked curves), `texture` −100..100 (mid-frequency), `clarity` −100..100 (local contrast, radius ≈ 1 % of the long edge), `dehaze` −100..100, `vibrance`/`saturation` −100..100, HSL per range (reds, oranges, yellows, greens, aquas, blues, purples, magentas: hue/saturation/luminance −100..100), `sharpen: { amount 0..150, radius 0.5..3, detail }`, `noise: { luminance 0..100, color 0..100 }`, `vignette` −100..100, `grain` 0..100. `DEVELOP_DEFAULTS` holds the neutral values. The dialog (Filter › Camera Raw Filter…, `pixelEditDialog` with tabs Basic / Detail / HSL / Effects, live preview, Auto button = auto tone, Reset) applies with history label "Camera Raw"; on a smart layer it becomes a smart filter.

### Printing (`lib/print.js`, `src/main/print.js`)

File › Print… (`file:print`): a dialog with printer (from `bridge.getPrinters()`), paper size (A4, Letter, Legal, A3, Tabloid, custom mm), orientation, margins, scale (Fit to page / 100 % / custom %), position (centre or offset), copies, and a preview of the page. OK renders the flattened document to a PNG data URL and calls `bridge.printImage({ dataUrl, widthMm, heightMm, paper, landscape, marginsMm, offsetMm, printer, copies, silent: false })`. `src/main/print.js printImage()` opens a hidden `BrowserWindow`, loads an inline HTML page (`@page { size, margin }`, the image positioned in mm) and calls `webContents.print(...)`, resolving `{ ok, reason? }`; it also offers `pdf: true` to return PDF bytes (`printToPDF`) for a "Save as PDF…" button.

### Path operations (`lib/path-ops.js`, `lib/tools/vector.js`)

`PathData.subpaths[i].op` ∈ `'combine' | 'subtract' | 'intersect' | 'exclude'` (missing = combine). `renderShapeLayer` builds the shape area in subpath order on an alpha canvas (combine = source-over, subtract = destination-out, intersect = destination-in with the subpath, exclude = xor), paints the fill through it (destination-in) and strokes every subpath outline (inside/outside alignment clip against the combined area). Also exported: `pathAreaCanvas(path, width, height)` (used by Make Selection, `select:from-layer`, hit testing) and `combinePaths`. Shape tools get a "Path operations" select in the options bar (new shape / combine / subtract / intersect / exclude) that sets the op of the subpath they draw (new shape = a new layer); `path:op` (arg) changes the op of the selected subpaths (path selection tool) or of the whole active shape layer, undoable; `path:merge-components` rasterises the area into a single-subpath outline (marching squares → simplified path).

### Text on a path and stacked vertical text (`lib/text-path.js`, `lib/tools/text.js`, `lib/panels/character.js`)

A text layer with `pathText = { path: PathData, startOffset: 0..1, flip: boolean, align: 'left'|'center'|'right' }` lays its glyphs along the path: the text extension's `layout()` returns glyph positions (`glyphs: { ch, x, y, angle, width }[]`) and `renderBase()` draws each glyph rotated at its position; `baseBounds()` is the union of the glyph boxes (+ padding). The Type tool starts text on a path when the pointer is over a path of the active shape layer, the work path or a saved path (the cursor changes); `text:on-path` attaches the active text layer to the active path, `text:release-path` detaches (keeping the text), `text:flip-path` toggles `flip`; dragging the small I-beam handle on the path moves `startOffset`. `font.orientation = 'vertical-stacked'` lays glyphs top to bottom, one per line box (upright CJK), with lines running right to left; `text:orientation` (arg) switches between horizontal, vertical (rotated, the existing behaviour) and vertical-stacked, and the Character panel exposes the same three. Serialisation is generic (`pathText`, `font.orientation`).

### Colour modes (`lib/color-modes.js`, `src/shared/pixels/color.js`)

`color.js` gains `rgbToLab`, `labToRgb` (D65, sRGB), `rgbToCmyk`, `cmykToRgb` (naive GCR: k = 1 − max(r,g,b)), `isOutOfCmykGamut(rgb)` (true when the round trip through CMYK moves a channel by more than 24/255). Info panel: a second readout in Lab or CMYK (setting `settings.infoSecondary`: `'cmyk'|'lab'|'hsb'`); Color Picker dialog: Lab and CMYK fields next to RGB/HSB/Hex. View › Proof Colors (`view:proof`, `settings.proofColors`) renders the composite through the CMYK round trip; View › Gamut Warning (`view:gamut`, `settings.gamutWarning`, Ctrl+Shift+Y) overlays mid-grey on out-of-gamut pixels. Both are applied in `canvas-view.js` through one hook: `view.postProcess = (canvas) => canvas | null` set by the colour module (the view calls it on the composite before drawing when set). The document stays 8-bit RGB; this is a preview only.

### Tests expected from every builder

Unit tests for pure modules under `tests/unit/*.test.mjs` (node:test, no DOM); e2e specs under `tests/e2e/*.spec.mjs` using `helpers.mjs` (`openApp`, `newDoc`, `run`, `runAwait`, `pixel`, `drag`, `confirmDialog`). AI specs never call a real provider: they set `window.__pigmentTest.ai = { request: async (payload) => fakeBody }` before the feature runs and assert the request payload and the pixels produced from the fake answer. `npm test`, `npm run test:e2e` and the app spec (every menu command registered, every panel registered) must pass.

## 0.3 features (contracts)

This section was written as the contract between the 0.3 builders and is kept as the reference for
those modules. Everything in it is implemented: no registry kind is a placeholder and nothing calls
`stubCommands` any more, so `app.stubbed` stays empty. Where the text below still says "placeholder", "stub" or "the builder", read it as how
the module came to be. The user-facing description is in `docs/USER-GUIDE.md`.

**Known gaps and departures** (from the builders' reports, checked against the code):

- *Modal sessions*: Blur Gallery, Select and Mask and Content-Aware Scale each wrap `app.commands.run` on the instance to refuse other commands while they are open; there is no shared session registry in `lib/commands.js`, and a module that wraps `run` later sits outside those guards.
- *Runtime wraps instead of hooks*: `app.docs.writeTo` is wrapped twice (`lib/depth.js` flushes deep pixels and writes 16-bit PNG; `lib/file-info.js` adds XMP to a saved PSD); `image:flatten` and `image:adjust-hdr-toning` are re-registered as wrappers; `SAVE_FILTERS` is extended at install. PSDs written through `encodeForPath` directly (Batch, Image Processor) carry no XMP.
- *Lens Blur*: the depth map is document state, never stored in params. A direct run re-derives it through the opener's `prepare`; `FILTERS['lens-blur'].apply` called without it blurs uniformly.
- *Displace, Texturizer, Conté Crayon, Glass*: an in-memory map or texture image has `toJSON → null`. Displace declares `incomplete` so a replay re-opens the chooser; the texture kinds fall back to the procedural texture named in params. Neither survives a `.pigment` round trip of a smart filter.
- *Lighting Effects*: the dialog edits `lights[0]` only; `apply()` honours up to 16 lights when params supply them.
- *Shake Reduction*: one straight trace estimated from the cepstrum, Wiener deconvolution; no curved-kernel refinement. Non-directional blur returns the image unchanged.
- *Average*: averages the whole image it is given, so a non-rectangular selection includes its bounding box.
- *Filter Gallery*: the editing preview is a copy reduced to 720 px with unscaled parameters; the composite kind uses a fixed 64 px margin instead of the sum of its stack's margins; Rough Pastels and Underpainting accept `textureImage` but have no file loader.
- *Blur Gallery*: Spin Blur treats the ellipse as the outer limit; the pyramid ladder is √2-spaced; kinds declare `margin: 0` (a selection runs on its bounding box, edges replicate); paths are splines without tangent handles; Path and Spin take 4–13 s at 12 MP.
- *Lens Correction*: radial model `g(r) = r(1 + k1 r² + k2 r⁴) / (1 + k1 + k2)` (corners fixed, exact ± round trip) instead of the contract's literal formula; edge modes are transparent / repeat / wrap / background; no lens profiles, so the Auto Correction checkboxes gate the Custom groups; the dialog opens neutral and uses inline styles (no stylesheet).
- *Content-Aware Scale*: W and H are pixels (the replay argument is percent); limits 40 MP per piece, 16384 px per side; above 6 MP seams come from a reduced map (bands of 2–3 px); not deep-pixel aware (its preview canvas swaps make `lib/depth.js` rebuild deep data from the proxy); refuses non-raster layers.
- *Color Lookup*: the 31 presets are generated transforms under Photoshop's names; loaded tables above 65 grid points are resampled to 65; adjustment-layer dither is keyed to the composited rect (a partial repaint may differ by one level).
- *HDR*: Merge to HDR is exposure fusion (display-referred), not a radiance map; `hdrToningFloat` and `app.deep.toFloat` / `setPixels` exist but HDR Toning is not wired to 32-bit layers; Remove Ghosts lives in the Merge to HDR dialog and needs three or more exposures.
- *adjust-more.js* restates the master Hue/Saturation shift and the monotone curve from `adjust.js` (importing it broke module initialisation order); a unit test keeps the copies identical. Replace Color uses its own colour-range coverage, not alpha-weighted.
- *Export Color Lookup Tables*: 8-bit lattice precision; layer opacity honoured, masks and blend modes ignored.
- *Modes*: pixels are always RGBA; CMYK, Lab and Multichannel are channel views. The mode is enforced in the compositor pass, `app.colorConstraint`, `app.pixelConstraint` and a bake on leaving the mode; tools that write pixels directly (paste, explicit fills, clone from another document) can store colour in a grey or indexed document. Text, shape, fill and adjustment layers are not converted. The mode renderer is skipped for `opts.skip` composites (merges, Export Layers to Files).
- *Modes, smaller*: flattening happens inside the conversion (one history entry), not through `image:flatten`; indirect conversions chain through Grayscale; multichannel spot channels are not regenerated after edits; Bitmap is stored as 8-bit black/white RGBA and its output resolution does not rescale saved paths; PNG-8 always writes 8-bit indices; state that `document.js` does not carry lives in `doc.meta.imageMode`.
- *Save for Web*: 2-up only, no slices, metadata options or animation. GIF read and write are single-frame.
- *Deep pixels*: `layer.deep` is rebuilt from the 8-bit proxy (precision lost on the touched pixels) for filters, painting, Image Size, arbitrary rotation, Free Transform, warps, merges, the Auto commands and Fade; adjustment kinds without float maths run at 8 bits and add their delta. Masks stay 8-bit. 32-bit is display-referred sRGB float, not linear light.
- *Deep flatten*: `flattenDeep` falls back to the 8-bit composite for layer effects, blend modes other than Normal / Multiply / Screen, advanced blending options other than Blend Clipped Layers as Group, pass-through groups with opacity or a mask, layers clipped to an adjustment layer and constrained modes. Clipping masks (as a group: the clipped layers on the base made opaque, cut to its alpha once, `deep.js clipGroupDeep`; not as a group: each clipped layer cut to the base's shape, `cutToAlpha`, `adjustLayerDeep`) and isolated groups (a group base, a clipped group, a group in Normal / Multiply / Screen) composite in float, as `compositor.js clipGroup` / `finishAdvanced` draw them. The merges (Merge Down, Merge Layers, Merge Visible, Merge Clipping Mask), Stamp Visible / Stamp Layers and Flatten Image hand the float composite to their result. Deep stash and history memory (128 MB per canvas, 384 MB for history-only layers) are not counted in `historyMemoryMB`.
- *TIFF / TGA / PNG*: the TIFF reader rejects JPEG-in-TIFF, CCITT, YCbCr, Lab, BigTIFF and half-float, ignores Orientation, and opens the first page; grey TIFF and 16-bit grey PNG open as RGB. PNG-16 above 1 MP uses one fixed row filter. `tga.js` is its own module. The Info panel's deep readout is a DOM block appended by `lib/depth.js`.
- *Select Subject / Sky / Focus Area*: graph-cut and saliency heuristics, no learned model. Focus Area has no Add / Subtract brushes. The workspace has no reduced preview (refinement runs at full size in the worker, on the main thread when no worker starts), its Quick Selection is the flood-in-a-window of the existing tool, and replaying `select:select-mask` re-applies settings without the strokes. The module worker has not been verified in a packaged (asar) build.
- *Actions*: `edit:fade` is not replayable (it is in `UNREPLAYABLE` in `lib/actions/model.js`); tool strokes, Move drags, `layer:move-to`, the three warp sessions and in-place edits of adjustment, fill and smart-filter layers are not recorded. A step with its dialog toggle on opens the dialog with the command's own start values. `.atn` files are refused. Engine API names are `loadFile` / `saveFile` and `engine.playback`; steps may carry `optional: true`. Whether an action's function key beats a native menu accelerator under Electron is unverified.
- *Automate*: Contact Sheet offers RGB and Grayscale; Image Processor's "Convert Profile to sRGB" is a no-op; Flatten All Masks records through `history.push`.
- *Align / blend*: Vignette Removal and Geometric Distortion are estimated from matched points (one amount, one radial coefficient); sets of more than 12 images only try pairs within four positions; a smart object's stack statistic is computed synchronously in the render path (no busy cursor on the first paint after opening); Load Files into Stack wraps the stack document directly instead of running `layer:smart-convert`.
- *Layer extras*: the Background layer is locked for position and transparency, not `locked.all`; colour labels and links live in `doc.meta.layerTags` (`.pigment` only; `cloneLayer` and Image › Duplicate drop them); links are honoured by the Move tool only; isolation hides layers through a `view.postProcess` wrapper, so sample-all-layers tools and auto-select still see them; `styles/layers-extras.css` is loaded by a `<link>` the module creates.
- *Perspective Crop*: a true perspective crop rasterizes text and smart layers and drops the selection and guides. *Open as Smart Object* from the menu always makes new documents (`{ into: 'active' }` only by argument).
- *Tests*: specs that read history or `settings.lastFilter` straight after `confirmDialog` race the commit, which `pixelEditDialog` runs under `app.busy` after the dialog closes; poll instead. The builders saw `editing.spec.mjs` (Liquify, lastFilter), `extras.spec.mjs:56` and `hunt2-layers.spec.mjs:193` fail intermittently under load.

Pigment 0.3 is "Photoshop parity, stage 1": every remaining Filter menu kind and the Filter Gallery,
the Blur Gallery, Lens Correction, the missing adjustments (Color Lookup, HDR Toning, Match Color,
Replace Color), Apply Image / Calculations, Matting, image modes (Bitmap, Grayscale, Duotone,
Indexed Color, RGB, CMYK, Lab, Multichannel) with 8/16/32 bits per channel, GIF / PNG-8 / 16-bit PNG /
TIFF, Select Subject / Sky / Focus Area and the Select and Mask workspace with an Object Selection
tool, Actions with Batch and the File > Automate / Scripts commands, Auto-Align / Auto-Blend /
Photomerge / stacks, Content-Aware Scale, and the smaller Layer / Select / File items Photoshop has.
Type, vector, layout (0.4) and brushes, animation, presets, colour management, RAW (0.5) follow.

The skeleton is in place: the menu (`src/main/menu.js`) and keymap name every command; the
registries carry **placeholder kinds** (identity apply, `placeholder: true`: menus and dialogs disable
them); **stub modules** (`lib/stub.js`) register the other command ids disabled and list them in
`app.stubbed`, which `app.syncUiState` sends as `state.stubs` so the native menu greys them out. A
builder replaces its placeholder entries / stub file with the real thing at the same paths and ids;
nothing else needs editing. **Ownership** (one builder per row; nobody else edits those files):

| Builder | Files owned | Delivers |
|---|---|---|
| filters-a | `src/shared/pixels/filters-more-a.js`, `tests/unit/filters-more-a.test.mjs`, `tests/e2e/filters-a.spec.mjs` | Average, Blur, Blur More, Lens Blur, Shape Blur, Smart Blur; Sharpen Edges, Sharpen More, Shake Reduction; Color Halftone, Facet, Mezzotint; De-Interlace, NTSC Colors; HSB/HSL |
| filters-b | `src/shared/pixels/filters-more-b.js`, `tests/unit/filters-more-b.test.mjs`, `tests/e2e/filters-b.spec.mjs` | Displace; Fibers, Lighting Effects, Tree, Flame, Picture Frame; Extrude, Tiles, Trace Contour, Wind |
| blur-gallery | `src/shared/pixels/blur-gallery.js`, `lib/blur-gallery-ui.js`, `styles/gallery.css` (blur part), `tests/unit/blur-gallery.test.mjs`, `tests/e2e/blur-gallery.spec.mjs` | Field Blur, Iris Blur, Tilt-Shift, Path Blur, Spin Blur engines and the on-canvas pin session with Effects (bokeh) and Noise |
| gallery-a | `src/shared/pixels/gallery-artistic.js`, `lib/filter-gallery.js`, `styles/gallery.css` (gallery part), `tests/unit/gallery-artistic.test.mjs`, `tests/e2e/filter-gallery.spec.mjs` | the 15 Artistic and 8 Brush Strokes effects, the Filter Gallery dialog (effect stack) |
| gallery-b | `src/shared/pixels/gallery-sketch.js`, `src/shared/pixels/textures.js`, `tests/unit/gallery-sketch.test.mjs`, `tests/e2e/gallery-b.spec.mjs` | the 14 Sketch, 6 Texture and 3 gallery Distort effects, the procedural textures (canvas, brick, burlap, sandstone, frosted, blocks, tiny lens) and Texturizer's file textures |
| adjust-more | `src/shared/pixels/adjust-more.js`, `src/shared/pixels/lut.js`, `src/shared/pixels/matting.js`, `src/shared/pixels/channel-math.js`, `src/shared/pixels/hdr.js`, `lib/adjust-more-ui.js`, `tests/unit/adjust-more.test.mjs`, `tests/e2e/adjust-more.spec.mjs` | Color Lookup (+ layer, .cube/.3dl/.look import, Export Color Lookup Tables), HDR Toning, Match Color, Replace Color, Apply Image, Calculations, Matting, Merge to HDR |
| modes | `src/shared/pixels/modes.js`, `src/shared/pixels/quantize.js`, `src/shared/pixels/gif.js`, `lib/modes.js`, `lib/panels/channels.js` (mode-aware channels), `styles/modes.css`, `tests/unit/modes.test.mjs`, `tests/e2e/modes.spec.mjs` | Image > Mode (all eight), Color Table, Trap, Conditional Mode Change, Save for Web (Legacy), GIF and PNG-8 export, GIF colour-table import |
| depth16 | `src/shared/pixels/deep.js`, `src/shared/pixels/tiff.js`, `lib/depth.js`, `styles/depth.css`, `tests/unit/deep.test.mjs`, `tests/e2e/depth.spec.mjs` | 16 and 32 Bits/Channel (`RasterLayer.deep`), high-precision adjustments, 16-bit PNG and TIFF open/save, TGA |
| select-mask | `src/shared/pixels/segment.js`, `src/shared/pixels/matte.js`, `lib/select-mask.js`, `lib/tools/object-select.js`, `styles/select-mask.css`, `tests/unit/segment.test.mjs`, `tests/e2e/select-mask.spec.mjs` | Select Subject, Select Sky, Focus Area, Select and Mask workspace, Object Selection tool |
| actions | `lib/actions.js`, `lib/panels/actions.js`, `lib/automate.js`, `styles/actions.css`, `styles/automate.css`, `tests/unit/actions.test.mjs`, `tests/e2e/actions.spec.mjs` | Actions panel and engine, Batch, Image Processor, Fit Image, Crop and Straighten, Contact Sheet, Delete Empty Layers, Flatten Effects / Masks, replayability audit of dialog commands |
| align-blend | `src/shared/pixels/register.js`, `src/shared/pixels/stack.js`, `lib/align-blend.js`, `tests/unit/register.test.mjs`, `tests/e2e/align-blend.spec.mjs` | Auto-Align Layers, Auto-Blend Layers, Photomerge, Load Files into Stack, Statistics, Stack Mode |
| content-aware-lens | `src/shared/pixels/seam-carve.js`, `src/shared/pixels/lens.js`, `lib/content-aware-scale.js`, `lib/lens-correction.js`, `tests/unit/seam-carve.test.mjs`, `tests/unit/lens.test.mjs`, `tests/e2e/content-aware-lens.spec.mjs` | Content-Aware Scale, Lens Correction |
| extras3 | `lib/layers-extras.js`, `lib/tools/perspective-crop.js`, `lib/file-ops.js` (only `properties()`), `tests/e2e/extras3.spec.mjs` | Background from Layer / Layer from Background, Group from Layers, Delete Hidden Layers, per-layer Quick Export / Export As, Link / Select Linked, Rasterize All, Convert to Layers, Deselect / Find / Isolate Layers (Layers panel filter bar), Open as Smart Object, Close Others, Purge, File Info, Perspective Crop tool |

Shared integration points that already exist (use them, do not re-implement):

- **Filter registry** (`src/shared/pixels/filter-def.js`, `filters.js`): `defineFilter(name, category, defaults, fn, extra)`; `extra` is pure data the renderer reads: `fields` (lib/form.js field specs, keys are parameter paths; `type: 'slider'|'number'|'select'|'segment'|'checkbox'|'color'|'text'`), `margin` (px read around a pixel, number or `(params) => px`), `direct: true` (no dialog), `ui: 'custom'` (a renderer module opens its own session), `gallery: 'Artistic'|...` with category `'gallery'`, `smart: false` (never a smart filter), `placeholder: true`. Categories in menu order: blur, blur-gallery, distort, noise, pixelate, render, sharpen, stylize, video, other; `'gallery'` kinds are reached through `GALLERY_GROUPS`, `'special'` kinds (Filter Gallery, Lens Correction) sit at the top of the Filter menu. Tables merge with `mergeTables` (a kind defined twice throws). `FILTERS` may be imported by a table module **only for use inside apply()** (the modules form a cycle that is safe at call time). Conventions from the top of `filters.js` hold for every kind: rect limits writes only, straight alpha, alpha-weighted averaging, deterministic noise per `seed`, no reads outside the image, typed arrays and plain loops.
- **Filter dialogs** (`lib/filter-ui.js`): a registered `prepare(params, session) -> params` runs before a direct (dialog-less) run so document state the params only name is re-derived (Lens Blur reads its depth map from the layer, mask or channel the params name); a kind may declare `incomplete(params) -> boolean` so a replay (Last Filter, actions) whose params lack what only the opener can supply re-opens the opener with those params instead of running a no-op. `filter:<kind>` commands exist for every registry kind (label from `name`, "…" when the kind has fields or a custom UI; disabled while `placeholder`). `app.filterEditor.register(kind, { fields?, margin?, open? })` adds dialog fields or a custom opener `open(kind, { params, def, ctx }) -> Promise<params | null>`; a custom opener owns its session (`app.beginPixelEdit` / `app.pixelEditDialog`, or a `TransformTool`-like on-canvas session) and resolves with the params it committed (they are remembered for Last Filter and recorded for actions). `app.filterEditor.fields(kind)`, `defaults(kind)`, `ranges(kind)`, `toRun`, `remember(kind, params)`, `run(kind, params, { dialog, ctx })` are available. Smart filters (`lib/smart-object.js`) re-run any kind from `{ kind, params }` with `FILTERS[kind].apply`, so custom-UI kinds must be fully described by their params (pins in image fractions, paths as point lists, never DOM state). On a smart object a custom opener runs on a temporary raster copy of the object (`customFilterDialog`: the copy is the active layer while the opener works, the selection is lifted, and `history.mark()` / `rollback()` drop the copy's undo entries), and the params it resolves with become the smart filter; so an opener must take its pixels from `beginPixelEdit` / `app.pixelTarget()` and never assume the active layer is the one the command started on. `app.smartFilters.intercept(layer, kind, params, label)` answers `false` or `{ done: Promise<params | null> }`.
- **Adjustment registry** (`src/shared/pixels/adjust-def.js`, `adjust.js`): `lutKind(name, defaults, build, extra)`, `pixelKind(name, defaults, fn, extra)`; `extra`: `fields`, `layer: true` (offered as an adjustment layer; `LAYER_KINDS` in `lib/adjust-ui.js` picks it up), `smart: false`, `placeholder`. `app.adjustEditors.register(kind, { editor(kind, params, onChange, { source }) -> { element }, width?, start?(app) -> params })` supplies custom dialogs (`buildAdjustmentEditor` consults it, so adjustment layers get the same editor in Properties). `image:adjust-<kind>` commands exist for every kind.
- **Pixel edit sessions** (`lib/adjust-ui.js`): `beginPixelEdit(app, { label, margin })` → `{ base, rect, local, show(img), commit(label, img, meta), cancel() }`; `show()` runs `app.pixelConstraint(doc, img, layer)` when a module installed one (image modes); `commit()` emits `app` event `'pixels:committed'` `{ doc, layer, rect, local, isMask, original, after, entry, meta }` with `meta.adjustment = { kind, params }` or `meta.filter = { kind, params }` for registry edits (lib/depth.js re-runs those on deep pixels). `pixelEditDialog(app, { title, params, editor, run, width, margin, meta })`.
- **Commands** (`lib/commands.js`): `run(id, arg, source)` passes a context as the second argument of `def.run(arg, ctx)`: `ctx.setReplayArg(params)` names the argument that re-runs the command without a dialog, `ctx.cancel()` marks a dismissed dialog. After every run the app emits `'command:done'` `{ id, arg, source, result, cancelled, replayable }` (the actions recorder listens; playback runs with `source: 'action'`). Register dialog commands with `dialog: true`. `filter:*`, `image:adjust-*` already do this; other dialog commands (`image:size`, `image:canvas-size`, `edit:fill`, `edit:stroke`, `layer:new`, `layer:style`, `select:feather`…) are audited by the actions builder, who may add the two `ctx` calls inside them (the only edits allowed outside ownership, each commented `// actions (lib/actions.js)`).
- **Document** (`lib/document.js`): `doc.mode` ('rgb' default), `doc.depth` (8|16|32), `doc.colorTable` (indexed: `[[r,g,b],…]`), `doc.duotone` (`{ type, inks: [{ name, color, curve }] }`); `RasterLayer.deep` (`{ type: 'u16'|'f32', data }`, straight RGBA, same size as the canvas, the canvas is the 8-bit proxy); `createDocument({ mode, depth })`. `describe()` is version 2 with these fields; `.pigment` stores deep pixels as `layers/<id>.u16|f32` (raw little-endian, deflated) and reads them back; `cloneLayer` copies `deep`. `app.syncUiState` sends `mode`, `depth`, `isolated` (`app.ui.isolated`), `backgroundLayer` (`app.isBackgroundLayer?.(layer)`), `stackMode` (`layer.stackMode`), `showGalleryInMenu` (`settings.showGalleryInMenu`) and `stubs`.
- **Compositor** (`lib/compositor.js`): `registerModeRenderer(mode, fn(doc, canvas, rect, opts))` post-processes every composite (view, export, thumbnails) in place; `composite(doc, { rawMode: true })` skips it. Mode changes must `doc.changed('props')` so the full-composite cache refreshes.
- **Colours**: `app.colorConstraint = (hex, doc) => hex` snaps picked foreground/background colours (`app.setColors`).
- **IO** (`lib/io.js`): `registerOpenFormat({ id, name, extensions, test?(bytes, name), read(bytes, { name, path }) -> Promise<Document> })` (consulted before the built-ins; extends the Open dialog filters); `registerExportFormat(id, { name, ext, extensions?, mime?, lossy?, layered?, opaque?, encode(doc, opts, compositor) -> Promise<Uint8Array>, options?: field specs })` (Export As lists it, shows its option fields when chosen and passes their values in `opts`; `encodeForPath` routes by extension; `WRITE_EXTENSIONS` grows); `exportFormatForPath(path)`. **PNG codec** `src/shared/pixels/png.js`: `decodePng(bytes) -> { width, height, channels, depth, data, palette, transparency, dpi, colorType, bitDepth, text }`, `toRgba8`, `toRgba16`, `fromRgba8(img, channels)`, `encodePng(planes, { dpi, text, interlace, indexed })`, `encodeRgba8`, `isPng`, `pngInfo` (all colour types, 1–16 bits, Adam7).
- **Bridge**: `bridge.listDir(path) -> [{ name, path, isDir, size, mtimeMs }]`, `bridge.makeDir(path)`, `bridge.openDirectoryDialog({ title })`, `readFile`, `writeFile`, `pathInfo`. The browser bridge lists the synthetic folders of `window.__pigmentTest.files` (keys like `browser:/batch/a.png`), so Batch tests work headless.
- **Documents**: `app.docs.add(doc)` (emits `'doc:opened'`), `openDocument(bytes, { name, path })`, `app.docs.openPaths`, `save`, `saveAs`, `writeTo(doc, path)`, `close(doc, { force })`; `flattenDocument(doc, compositor)`; `renderLayersFlat(doc, layers)` (lib/layer-ops.js); `structural(app, label, mutate)` for undoable tree edits, `setLayerProps(app, layer, patch, label)`; `app.busy(label, fn)`, `app.reportError(err, context)`, `app.dialogs.open/confirm/prompt/toast`, `formDialog(app, { title, fields, values, onChange, validate, okLabel, width })`.
- **Tools**: `Tool` base and `ToolManager.register(tool, slot)` (`lib/tools.js`); existing slots: move, crop, marquee, lasso, wand, eyedropper, heal, brush, clone, history, eraser, fill, retouch, pen, text, path-select, shape, hand, zoom, blur. Colour Sampler, Ruler and Red Eye tools already exist (`lib/tools/nav.js`, `retouch.js`).
- **Renderer stubs for filter openers**: `lib/filters-a-ui.js`, `lib/filters-b-ui.js`, `lib/gallery-b-ui.js` exist (empty `install`) and are listed in `app.js` MODULES, so the filters-a, filters-b and gallery-b builders register their openers there without touching app.js.
- **Styles**: `styles/modes.css`, `select-mask.css`, `actions.css`, `gallery.css`, `depth.css`, `automate.css` are linked and empty. Icons: `play`, `record`, `stop`, `folder`, `filter`, `channels`, `mask`, `crop`, `transform`, `grid-add`, `eye`, `eye-off`, `link`, `lock`, `trash`, `plus`, `minus`, `more`, `chevron-*` exist in `lib/icons.js`.

### Filters, part A (`filters-more-a.js`)

Replace each placeholder with a real `defineFilter` (same ids; keep the `direct` flags). Parameters and semantics (Photoshop's names):

- `average` {}: fills the region with the alpha-weighted mean colour. `blur` {}: 3×3 blur weighted 1-2-1. `blur-more` {}: Blur applied three times (Photoshop's "3–4× Blur").
- `lens-blur` { radius 0..100, shape 'triangle'|'square'|'pentagon'|'hexagon'|'heptagon'|'octagon', bladeCurvature 0..100, rotation 0..360, brightness 0..100 (specular highlights), threshold 0..255, noise 0..100, distribution 'uniform'|'gaussian', monochromatic, source 'none'|'transparency'|'mask'|'alpha', depthMap: Uint8ClampedArray|null (supplied by the dialog from the chosen source: layer transparency, layer mask or a saved channel), focalDistance 0..255, invert }: polygonal-aperture convolution (a disc/polygon kernel, curved blades round the corners) whose radius per pixel follows |depth − focalDistance|; brightness/threshold boost pixels above the threshold before blurring (bokeh highlights); noise added after. Fields: dialog with a Depth Map "Source" select listing the channels of the active document (the dialog passes depthMap) and the rest as sliders.
- `shape-blur` { radius 1..1000, shape: name of a built-in shape ('circle', 'square', 'triangle', 'diamond', 'star', 'heart', 'arrow', 'cross', 'hexagon', 'ring') }: convolution with the shape rasterised at 2·radius as the kernel (normalised). Export `SHAPE_BLUR_SHAPES` for the dialog's shape picker.
- `smart-blur` { radius 0.1..100, threshold 0.1..100, quality 'low'|'medium'|'high', mode 'normal'|'edge-only'|'overlay-edge' }: bilateral blur (spatial radius, colour threshold); quality sets the sampling step (3/2/1 px); 'edge-only' outputs white edges on black, 'overlay-edge' overlays the white edges on the blurred image.
- `sharpen-edges` {}: unsharp mask applied only where the local gradient exceeds a threshold (edges), smooth areas untouched. `sharpen-more` {}: Sharpen with a stronger amount (Photoshop ≈ 2–3× Sharpen).
- `shake-reduction` { traceBounds 10..199 px, sourceNoise 'auto'|'low'|'medium'|'high', smoothing 0..100, artifactSuppression 0..100 }: blind deconvolution of camera shake: estimate a linear/curvy motion kernel of at most traceBounds px from the image's autocorrelation / cepstrum inside the sharpest region, then Richardson–Lucy (or Wiener) deconvolution with the estimated kernel; smoothing damps ringing (bilateral pass), artifactSuppression blends the result with the original where local variance is low. Must finish in a few seconds on a 2000×1500 layer (work on a downscaled copy to estimate the kernel, deconvolve in tiles).
- `color-halftone` { radius 4..127 px (max dot radius), angles [c, m, y, k] degrees }: Photoshop's CMYK halftone screens: convert to CMYK (color.js `rgbToCmyk`), for each channel rotate a grid of cells by its angle and draw dots whose area equals the channel's mean coverage in the cell, composite the four inks back to RGB. `facet` {}: each pixel takes the most common colour (after 5-level quantisation per channel) of its 3×3 neighbourhood, producing flat facets. `mezzotint` { type (10 Photoshop types: '<fine|medium|grainy|coarse>-dots', '<short|medium|long>-lines', '<short|medium|long>-strokes'), seed }: random black/white (per channel, saturated colours) patterns of dots / lines / strokes keyed to luminance.
- `de-interlace` { eliminate 'odd'|'even', method 'duplication'|'interpolation' }: replaces the eliminated field's rows with the other field's rows (duplication) or the average of the neighbouring rows (interpolation). `ntsc-colors` {}: clamps colours to the NTSC-safe gamut (max saturation/luma limits: per pixel reduce saturation until Y ∈ [16, 235] and chroma within broadcast limits, in YIQ).
- `hsb-hsl` { from 'rgb'|'hsb'|'hsl', to 'rgb'|'hsb'|'hsl' }: reinterprets channels: converts the RGB triple as if it were the `from` space into the `to` space and stores the result in the RGB channels (so RGB→HSB stores H,S,B as R,G,B; HSB→RGB converts back). color.js has `rgbToHsl/hslToRgb/rgbToHsv/hsvToRgb`.

Unit tests must check numbers (an impulse through `blur` gives the 1-2-1 kernel weights; `average` equals the mean; `color-halftone` of a flat 50% grey has about half black coverage; `de-interlace` duplication copies rows; `hsb-hsl` round trip is identity within 1; `shake-reduction` on a synthetic image blurred by a known 9 px horizontal motion recovers an estimate within ±2 px and raises edge contrast). E2E: a filter from each group opens its dialog, previews and commits one history entry; direct kinds apply at once; a placeholder-free menu (every `filter:*` of this table enabled).

### Filters, part B (`filters-more-b.js`)

- `displace` { horizontalScale −999..999, verticalScale −999..999, mapMode 'stretch'|'tile', edge 'wrap'|'repeat', map: ImageDataLike|null }: Photoshop's displacement: red channel displaces x and green displaces y by (v − 128) / 128 · scale px (a grey map uses its single channel for both); `stretch` resamples the map to the image, `tile` repeats it. The dialog (owned here through `app.filterEditor.register('displace', { open })`) asks for the map: another open document, a layer of this document, or a file (`bridge.openFileDialog` + `openDocument` + `flattenDocument`); store `map` in params as `{ width, height, data }` (plain arrays are too big: keep the typed array; smart filters keep it in memory and `.pigment` saving of a smart filter with a map is allowed to drop it with a toast — say so in the report).
- `fibers` { variance 1..64, strength 1..64, seed, colors [fg, bg] }: vertical fibres from 1-D noise per column modulated by variance, strength sharpening the streaks; fills the region opaque (Photoshop replaces the pixels).
- `lighting-effects` { lights: [{ type 'spot'|'point'|'infinite', x, y (0..1), intensity −100..100, hotspot 0..100, color, angle, radius (0..1 of the diagonal), focus 0..1, exposure −100..100 }], ambient −100..100, ambientColor, exposure, gloss −100..100, metallic −100..100, texture 'none'|'red'|'green'|'blue'|'alpha'|'luminance', height 0..100, whiteIsHigh }: Phong shading of the image treated as a flat surface (texture channel as a bump map, height scales it): diffuse from each light (spot = elliptical cone with hotspot falloff, point = inverse-square falloff with radius, infinite = directional), specular from gloss/metallic, ambient term, exposure gain. At most 16 lights. Fields: a dialog editing the first light's controls is acceptable; report if a multi-light on-canvas editor is not done.
- `tree` { type: one of at least 8 species ('oak', 'pine', 'willow', 'palm', 'birch', 'maple', 'cherry-blossom', 'bare'), lightDirection 0..180, cameraTilt 0..?, leavesAmount 0..100, leavesSize 0..200, branchesHeight 70..300, branchesThickness 0..200, defaultLeaves, seed, arrangement 1..?, leafColor, branchColor }: a procedural L-system/recursive branching tree rendered with lit branches (cylinders shaded by lightDirection) and leaf sprites; drawn into the layer's region over transparency (Photoshop renders onto the layer; filling a new empty layer is the common use).
- `flame` { flameType 'one-flame'|'multiple-flames-along-path'|'multiple-flames-one-direction'|'multiple-flames-path-directed'|'multiple-flames-various-angle'|'candle-light', length 5..300, width 1..100, angle 0..360, interval 0..?, randomizeLength, randomizeInterval, quality 'draft'|'low'|'medium'|'high'|'fine', turbulence 0..100, jag 0..100, opacity 0..100, color, useCustomColor, seed, path: PathData|null }: flames rendered along the given path (the dialog passes the document's work path or the active shape layer's path; without a path the command toasts "Draw a path first" like Photoshop). Flame = turbulent noise-displaced gradient (yellow core, orange, red, transparent) with `jag` tearing the edge.
- `picture-frame` { frame: one of at least 10 procedural frames ('vines', 'leaves', 'flowers', 'geometric', 'bamboo', 'rope', 'wood', 'film', 'stars', 'circles'), size 0..100 (border width % of the shorter side), color, secondaryColor, seed }: draws a decorative border inside the image edges (repeat/scale the frame motif along the four edges, corners mitred).
- `extrude` { type 'blocks'|'pyramids', size 2..255, depth 1..255, depthMode 'random'|'level-based', solidFront, maskIncomplete, seed }: Photoshop's 3-D blocks/pyramids rising towards the viewer from the image centre: each `size` cell becomes a block whose height is random or follows luminance; faces shaded by orientation; `solidFront` paints the front face in the cell's mean colour; `maskIncomplete` skips cells not fully inside the selection/image.
- `tiles` { count 1..99 (tiles per shorter side), offset 1..99 (% of a tile), fill 'background'|'foreground'|'inverse'|'unaltered', seed, colors [fg, bg] }: cuts the image into count×count tiles offset randomly by up to offset%, gaps filled with the background/foreground colour, the inverted image or the unaltered image.
- `trace-contour` { level 0..255, edge 'lower'|'upper' }: for each channel, draws a 1 px line where the channel crosses `level` (lower: from below), coloured in the channel's colour on white (Photoshop's thin coloured contours).
- `wind` { method 'wind'|'blast'|'stagger', direction 'left'|'right', seed }: horizontal streaks from bright pixels: wind = short streaks (≈ 8 px decaying), blast = long streaks, stagger = streaks with randomly offset rows.

Unit tests with numbers (displace by a flat 255-red map moves pixels by exactly horizontalScale; tiles leaves at least (1 − offset)² of pixels in place; trace-contour of a hard vertical edge gives one 1 px column; wind leaves the dark side untouched; tree/flame/frame are deterministic for a seed, draw inside the region and leave alpha 0 where nothing is drawn). E2E: Displace with a map from a second document; Tree renders onto an empty layer (non-transparent pixels appear, undo clears); Flame refuses without a path and renders along a drawn path; Lighting Effects darkens the far side of a spot light.

### Blur Gallery (`blur-gallery.js`, `lib/blur-gallery-ui.js`)

Engines (pure, params in image fractions; `blur` values in px of the full image, scaled when the dialog previews at lower resolution):

- `field-blur` { pins: [{ x, y, blur 0..500 }], bokeh, noise }: per-pixel blur radius = inverse-distance-weighted interpolation of the pins' blur (one pin: uniform); variable-radius Gaussian via a blur pyramid (blur at 0, 1, 2, 4, 8… px, interpolate between levels) so a 4000×3000 layer finishes in a few seconds.
- `iris-blur` { pins: [{ x, y, blur, rx, ry, rotation, roundness −100..100 (squircle), feather 0..1 (fraction of the radius where the blur starts) }] }: sharp inside the inner ring, full blur outside the ellipse, smooth ramp between; several pins take the minimum blur.
- `tilt-shift` { pins: [{ x, y, blur, rotation, focus (half height of the sharp band, fraction), fade (fraction over which blur ramps to full) }], distortion −100..100, symmetricDistortion }: a sharp band with linear blur ramps; distortion stretches the bokeh along the blur direction on one (or both) side(s).
- `path-blur` { paths: [{ points: [{ x, y }], endSpeeds: [a, b] }], speed 0..100 %, taper 0..100, centeredBlur, strobe, strobeStrength, strobeFlashes 1..100, noise }: motion blur along a Bézier/polyline path: each pixel's blur direction and length come from the nearest path point's tangent and speed (interpolated along the path), `centeredBlur` centres the kernel on the pixel; strobe adds `strobeFlashes` sharp copies.
- `spin-blur` { pins: [{ x, y, angle 0..360, rx, ry, rotation, feather }], strobe, strobeStrength, strobeFlashes, noise }: rotational blur about the pin over ±angle/2 inside the ellipse, feathered outside.
- Shared effects: `bokeh { lightBokeh 0..100, bokehColor 0..100, lightRange [lo, hi] }` boosts pixels within the light range before blurring (specular highlights), `noise { amount, size, roughness, color, highlights, distribution }` adds grain after (uniform/gaussian, mono when color 0).

`lib/blur-gallery-ui.js`: one on-canvas session for the five kinds (`app.filterEditor.register(kind, { open })`): the layer is previewed through `beginPixelEdit` at a reduced resolution while dragging (full quality on release and on OK), pins are drawn on the view (`view.overlays` or the tool-overlay pattern of `lib/warp.js`), click adds a pin, drag moves it, the blur ring around the selected pin sets its blur, handles on the iris/spin ellipse set radii/rotation/feather, Delete removes the selected pin, Escape cancels; a side panel (dialog docked right, `app.dialogs.open` with `modal: false` or the warp session's options bar) shows the selected pin's sliders, the Effects and Noise tabs, and OK / Cancel. The committed params re-run through `FILTERS[kind].apply`, so a smart filter shows the same result. Unit tests: one field pin equals a Gaussian of that radius within tolerance; a tilt-shift band keeps its centre row unchanged and blurs the edges; spin blur of a radial pattern is unchanged, of a tangential pattern is smoothed; path blur of an impulse smears along the path tangent only. E2E: open Field Blur, drag the pin, change blur, OK → one history entry and blurred pixels; Cancel restores; the result is reproduced by `filter:field-blur` with the committed params.

### Filter Gallery (`gallery-artistic.js`, `gallery-sketch.js`, `textures.js`, `lib/filter-gallery.js`)

Every gallery effect takes Photoshop's parameters (the placeholder defaults list them) and reproduces the recognisable look; the tests pin down measurable properties rather than exact pixels. Effects are built from a small toolkit each table module keeps private (edge detection, posterisation, local min/max, oriented stroke rendering, paper texture noise, relief lighting). Sketch kinds paint with `params.colors` = [foreground, background] (the dialog fills them from the current colours). Textures (`textures.js`, owned by gallery-b — a working seed with all seven textures and `relief()` already exists, refine it rather than replacing its exports — imported by both tables and by `rough-pastels`/`underpainting`/`texturizer`/`conte-crayon`/`glass`): `texture(name, width, height, { scaling, seed })` returns a grey height map for 'canvas', 'brick', 'burlap', 'sandstone', 'frosted', 'blocks', 'tiny-lens'; `relief(img, height, { relief, lightDirection, invert })` lights an image by a height map; `textureImage` in params (an ImageDataLike loaded from a file) replaces the procedural one.

`lib/filter-gallery.js`: Filter > Filter Gallery… (`filter:filter-gallery`, registered as a custom opener): a large dialog with the preview (zoomable, pan, fit) on the left, the six group accordions with thumbnail buttons (each thumbnail is the effect applied to a built-in 80×60 sample image) in the middle, the selected effect's fields on the right and the **effect layer stack** below them (list of applied effects in order, eye toggles, drag to reorder, "new effect layer" and "delete" buttons; the stack is `params.effects`). Preview runs the stack on a downscaled copy while editing and at full size on OK; OK commits once through `pixelEditDialog`-style sessions (use `beginPixelEdit` + `commit(label, img, { filter: { kind: 'filter-gallery', params } })`). `settings.showGalleryInMenu` (a checkbox in the dialog's menu or Preferences) adds the groups to the Filter menu (the menu already honours `state.showGalleryInMenu`). Unit tests per effect (not only "does not throw"): e.g. `cutout` leaves at most `levels` distinct colours per channel, `poster-edges` darkens edges, `stamp` is two-tone, `halftone-pattern` 'line' has horizontal periodicity, `chrome` is grey, `grain` adds noise with the requested intensity, `mosaic-tiles` grout is lighter, `glass` displaces by at most distortion·k px, `ocean-ripple` moves pixels, `diffuse-glow` lightens highlights only. E2E: the gallery opens, applying two effects shows both in the stack, reorder changes the result, OK commits one entry and `filter:filter-gallery` with the params reproduces it; a Sketch effect uses the current foreground colour.

### Adjustments (`adjust-more.js`, `lut.js`, `matting.js`, `channel-math.js`, `hdr.js`, `lib/adjust-more-ui.js`)

- `color-lookup` { preset: string ('none' or a built-in name), lut: parsed table | null, dither }: `lut.js` parses `.cube` (1D and 3D, DOMAIN_MIN/MAX, TITLE), `.3dl` (Autodesk, with the input ramp line), `.look` (Adobe SpeedGrade XML wrapping a .cube), `.csp` (Rising Sun), and writes `.cube` and `.3dl`; `applyLut3d(img, lut, { dither }, rect)` with trilinear (3D) or linear (1D) interpolation; built-in presets generated in code (Photoshop's names, approximated: '3Strip', 'Candlelight', 'Crisp Warm', 'Crisp Winter', 'Drop Blues', 'Edgy Amber', 'Foggy Night', 'Futuristic Bleak', 'Horror Blue', 'Kodak 5205', 'Late Sunset', 'Moonlight', 'Night from Day', 'Soft Warming', 'Teal Orange', 'Bleach Bypass', 'Sepia', 'Black & White' …, at least 20) exported as `LUT_PRESETS`. Editor: preset select, "Load 3D LUT…" (file dialog), dither checkbox; it is an adjustment layer (`layer: true`) so Properties shows the same editor. File > Export > Color Lookup Tables… (`file:export-luts`): bakes the document's adjustment layers above the background (or the whole adjustment stack of the active layer) into `.cube` and/or `.3dl` at a chosen grid size (16/32/64) by pushing a lattice through `applyAdjustment` for each layer.
- `hdr-toning` (`hdr.js`) { method 'local-adaptation'|'equalize-histogram'|'exposure-gamma'|'highlight-compression', radius 1..500, strength 0..100, gamma 0.1..10, exposure −20..20, detail −300..300, shadow −100..100, highlight −100..100, vibrance −100..100, saturation −100..100, curve: [[x, y]…]|null }: local adaptation = tone mapping with a bilateral/guided base layer (radius, strength) and detail amplification, then exposure/gamma/shadow/highlight/vibrance/saturation and an optional curve; the other methods as named. Works on 8-bit input here (Photoshop flattens; the command flattens too after a confirm, like Photoshop, via `image:flatten`) and on 32-bit float deep layers when `lib/depth.js` is present (`app.deep?.toFloat(layer)` → operate → back; optional, report if skipped). `smart: false`.
- `match-color` { luminance 0..200, colorIntensity 0..200, fade 0..100, neutralize, source: { mean: [L, a, b], std: [L, a, b] } }: Reinhard-style statistics transfer in Lab (color.js `rgbToLab/labToRgb`): each channel scaled by std ratio and shifted by the means, luminance/colorIntensity scale the L and ab adjustments, fade blends with the original, neutralize removes the target's mean cast. Editor: Source document select (open documents), Layer select (layers of the source, or Merged), "Use selection in source to calculate colors" / "Use selection in target to calculate adjustment" checkboxes; the editor computes `source` statistics and shows "Save Statistics… / Load Statistics…" as JSON files. `smart: false`.
- `replace-color` { colors: [[r, g, b], …], fuzziness 0..200, localized, hue, saturation, lightness }: selection mask from `colorRange`-like fuzziness around the sampled colours (localized = also weighted by distance to the sampled positions, pass `positions` in params when on), then Hue/Saturation applied through the mask. Editor: eyedropper buttons (sample, add, subtract) that pick from the dialog's preview canvas (the session base), a mask/image preview toggle, fuzziness slider, the three HSL sliders and a result swatch.
- Apply Image (`image:apply-image`, `channel-math.js applyImage(target, source, { channel 'rgb'|'r'|'g'|'b'|'a'|'selection'|'mask'|'gray', invert, blend (any BlendMode plus 'add'|'subtract' with scale/offset), opacity, preserveTransparency, mask?: { data, invert } }, rect)`): dialog with Source (open documents of the same size), Layer (Merged or one layer), Channel, Invert, Blending, Opacity, Preserve Transparency, Mask; applies to the active layer (or mask when editing a mask) through a pixel-edit session.
- Calculations (`image:calculations`, `calculations(a, b, { blend, opacity, invertA, invertB, mask })` → grey mask): Source 1 and Source 2 (document, layer, channel each), Blending, Opacity, Mask, Result 'new-channel'|'new-document'|'selection'; result channels go to `doc.channels` (undoable), a new document opens as greyscale.
- Matting (`matting.js`, `layer:matting` arg 'defringe'|'remove-black'|'remove-white'|'decontaminate'): `defringe(img, width)` replaces edge pixel colours with the nearest interior opaque colour within width px; `removeMatte(img, 'black'|'white')` un-premultiplies against the matte colour; `decontaminate(img, amount 0..100)` pushes edge colours towards the inside colours. Defringe asks for the width (`formDialog`, remember it), Decontaminate for the amount. All through `history.replaceCanvas`/pixel sessions on the active raster layer.
- Merge to HDR (`file:automate-merge-hdr`): choose files or use open documents; aligns with `app.alignBlend?.alignImages(images)` when present (align-blend builder; optional), estimates exposure ratios from image statistics (or EXIF-less: median ratio of corresponding luminances), fuses by Mertens exposure fusion into an 8-bit (or 16-bit when `app.deep` exists) document, then opens HDR Toning on it with "Remove ghosts" as a median-based option. Report honestly what the fusion does and does not do (no true 32-bit radiance map unless depth16 is present).
Unit tests: a .cube string round-trips through parse/write; an identity 3D LUT leaves pixels unchanged and a channel-swap LUT swaps them; match-color maps the source statistics onto the target within 2 Lab units; replace-color changes only colours within fuzziness; apply-image 'multiply' at opacity 100 equals blendImages; calculations 'difference' of a channel with itself is black; defringe removes a 1 px coloured halo; HDR toning's local adaptation compresses a 0..255 gradient's dynamic range while keeping local contrast. E2E: Color Lookup layer with a preset changes pixels and is undoable; Replace Color with a sampled red turns it green; Apply Image multiplies with another document; Calculations adds a channel; Defringe on a hard edge.

### Image modes (`modes.js`, `quantize.js`, `gif.js`, `lib/modes.js`, `lib/panels/channels.js`)

`modes.js`: `MODES` (id, name, bit depths, channel names: RGB → Red/Green/Blue, CMYK → Cyan/Magenta/Yellow/Black, Lab → Lightness/a/b, grayscale/bitmap/duotone/indexed → Gray (Index), multichannel → the saved channels), `convertPixels(img, from, to, options)` for every pair Photoshop allows (grayscale ← rgb by Rec. 601 luma (Photoshop uses a gamma-aware mix; document which), bitmap ← grayscale with `method '50-threshold'|'pattern-dither'|'diffusion-dither' (Floyd–Steinberg)|'halftone-screen' { frequency, angle, shape }|'custom-pattern'`, duotone ← grayscale (pixels stay grey; `duotoneLut(duotone)` → 256 RGB entries from the ink curves, overprinted multiplicatively), indexed ← rgb via `quantize.js`, rgb ← anything (expand), cmyk/lab ↔ rgb are identity on stored pixels (the document stays RGBA; channels are derived: `channelPlanes(img, mode)` → named grey planes computed with color.js `rgbToCmyk` / `rgbToLab`), multichannel ← cmyk/rgb splits into spot channels (`doc.channels`), `constrainColor(mode, rgb, colorTable)` (grey / nearest table entry / black-white), `constrainImage(mode, img, colorTable, rect)`.
`quantize.js`: `quantize(img, { colors 2..256, palette 'exact'|'system-mac'|'system-win'|'web'|'uniform'|'perceptual'|'selective'|'adaptive'|'custom', forced 'none'|'black-white'|'primaries'|'web', transparency, matte: hex|null, dither 'none'|'diffusion'|'pattern'|'noise', ditherAmount 0..100, preserveExactColors })` → `{ palette: [[r,g,b]…], indices: Uint8Array, transparentIndex }` using median cut (adaptive) / popularity-weighted median cut in a perceptual space (perceptual/selective) with Floyd–Steinberg dithering; `remap(img, palette, { dither })`.
`gif.js`: `encodeGif(frames: [{ indices, palette, transparentIndex, delay }], width, height, { loop })` with LZW (one frame for 0.3; the animation builder of 0.5 adds more), `decodeGif(bytes)` → frames (first frame used; keeps the colour table so Indexed Color documents open as indexed).
`lib/modes.js`: `image:mode` (arg id): conversions that need options open a dialog (Bitmap: output resolution and method; Duotone: type, inks (name, colour picker, curve editor reusing `buildAdjustmentEditor('curves')`-style points or a small curve widget), presets (a few Pantone-free built-ins), Overprint Colors ignored; Indexed Color: palette, colours, forced, transparency, matte, dither, amount, preview), conversions that flatten (bitmap, indexed, multichannel) confirm first like Photoshop and flatten via `image:flatten`; every conversion is one history entry (snapshot the tree with `snapshotTree/restoreTree` from lib/layer-ops.js plus the document fields). Sets `doc.mode`, `doc.colorTable`, `doc.duotone`, installs `registerModeRenderer` for duotone (grey → ink LUT), indexed (nearest table colour; Photoshop shows the quantised image), bitmap (threshold, pure black/white display), grayscale (desaturate the composite so coloured adjustment layers cannot leak colour), and `app.colorConstraint` / `app.pixelConstraint` for grayscale, bitmap, indexed, duotone. Color Table… (`image:color-table`): the 256-swatch grid editor (click to change a colour, drag-select a range to fill with a gradient between two picked colours, transparency index, Load/Save `.act`). Trap… (`image:trap`, CMYK only): spreads lighter inks under darker ones by N px at colour boundaries (pixel implementation on the derived CMYK planes; convert back). Conditional Mode Change… (`file:automate-conditional-mode`): source modes checkboxes → target mode (used by actions/Batch). Save for Web (Legacy)… (`file:save-for-web`): a 2-up dialog (original | optimised preview with size and estimated time at 56k/DSL) with format GIF / JPEG / PNG-8 / PNG-24 / WebP, the quantize options for GIF/PNG-8, quality for JPEG/WebP, image size fields, "Convert to sRGB" (no-op, labelled), then Save…; registers export formats `gif` (`{ name: 'GIF image', ext: 'gif', options: [colors, dither, transparency, matte] }`) and `png8` (`ext: 'png'`, same options; `extensions: []` so `.png` still routes to PNG-24 by default) through `registerExportFormat`, and an open reader for GIF through `registerOpenFormat` that keeps the colour table (document opens in indexed mode; browsers' GIF decoding is replaced by `decodeGif`). Channels panel: list channels by `MODES[doc.mode].channels` (derived planes for CMYK/Lab, Gray for grey modes, the table for indexed) and keep Ctrl-click load working. Unit tests: every mode pair converts a known pixel to known values (red → CMYK 0/100/100/0; mid grey bitmap threshold; Floyd–Steinberg on a 50% grey block gives ~50% black; median cut of a 4-colour image returns those 4 colours exactly; GIF round trip restores indices and palette; duotone LUT of black is the darkest ink mix). E2E: Image > Mode > Grayscale makes a red pixel grey and undo restores; Indexed Color with 4 colours leaves 4 distinct colours and Color Table lists them; Bitmap 50% threshold; Duotone shows ink colours in the composite and saves/reopens as duotone; Save for Web GIF writes bytes that `decodeGif` reads back; the New Document dialog's Grayscale mode creates a grayscale document whose picked colours are grey.

### 16 and 32 bits per channel (`deep.js`, `tiff.js`, `lib/depth.js`)

`deep.js`: planes `{ type: 'u16'|'f32', data }` for RGBA straight alpha; `fromCanvasData(img, type)`, `toCanvasData(deep, { dither: boolean })` (8-bit proxy; f32 is clamped 0..1 → 0..255 for display), `applyLutDeep(deep, lut8triple, rect)` (65536-entry tables interpolated from the kind's 8-bit `lut(params)` so LUT adjustments keep 16-bit smoothness), `applyAdjustmentDeep(deep, kind, params, rect)`: exact float implementations of brightness-contrast, levels, curves (monotone cubic through the points, evaluated in float), exposure, vibrance, hue-saturation, color-balance, black-white, photo-filter, channel-mixer, invert, posterize, threshold, gradient-map, desaturate (the others fall back to the 8-bit result upsampled, flagged in the return value `{ exact: boolean }`), `convertDepth(deep, type)`, `blendDeep(dst, src, { alpha })` for the flatten below, `statistics`.
`tiff.js`: baseline TIFF reader/writer: 8/16-bit (and 32-bit float) grey/RGB/RGBA, strips or tiles, uncompressed, PackBits, LZW and Deflate (zlib) compression, Predictor 2, planar configurations 1 and 2, little or big endian, the resolution tags; export writes 8 or 16-bit RGB(A) with LZW (option `compression`). `tga.js` may be a part of tiff.js or its own small file (read/write 24/32-bit uncompressed and RLE).
`lib/depth.js`: `image:depth` (arg 8|16|32): converts every raster layer (`deep` allocated or dropped; 16→8 dithers optionally; 32 is f32 linear 0..1 with HDR headroom allowed above 1 — the proxy clamps), one history entry; masks stay 8-bit (Photoshop keeps 16-bit masks; say so). Keeps deep pixels in step: on `'pixels:committed'` with `meta.adjustment` re-runs the adjustment on `deep` (exact when `applyAdjustmentDeep` supports it) and regenerates the proxy for the rect; with `meta.filter` or without meta (brush strokes, transforms, fills, anything 8-bit) the rect of `deep` is refreshed from the 8-bit proxy (precision lost there; the Info panel shows 16-bit values where the proxy still matches). Hooks the `doc:change` event for `'pixels'` changes made by tools (strokes) the same way. Export: `registerExportFormat('png16', { name: 'PNG 16-bit', ext: 'png', extensions: [], encode })` writing `encodePng` 16-bit RGBA from `flattenDeep(doc)` (deep layers composited in float for normal/multiply/screen blend modes with opacity and masks; anything else falls back to the 8-bit composite scaled up and the export dialog says "8-bit composite"), `tiff` (8/16-bit by document depth), `tga`; `registerOpenFormat` for PNG with `bitDepth === 16` (sniff with `pngInfo`; 8-bit PNGs keep the browser path), TIFF (`49 49 2A 00` / `4D 4D 00 2A`), TGA by extension; opened 16-bit files create 16-bit documents. Info panel: 16-bit readouts (0..32768 like Photoshop, or 0..65535 with a setting; pick one and document) when `doc.depth === 16`. Menu "16 Bits/Channel" is already there; the New Document dialog passes `depth`, so allocate `deep` for new layers of deep documents on `'doc:opened'` and when layers are added (`doc:change` kind 'tree'). PSD: ag-psd cannot write 16-bit; `writePsdDocument` stays 8-bit and `lib/documents.js` warns once when saving a deep document as PSD (toast; you may add the toast through `app.on('doc:saved')`). Unit tests: 16-bit levels on a 16-bit ramp has no 8-bit banding (adjacent output values differ by ≤ 2/65535·range); curves exact vs float reference; TIFF round trips 8 and 16-bit with LZW and PackBits, big and little endian; PNG 16 export → decode equals the planes. E2E: new 16-bit document → Levels → the layer's deep data changes and the proxy matches; Image > Mode > 8 Bits drops `deep`; open a 16-bit PNG fixture (write it in the spec with `encodePng`) → `doc.depth === 16`; Export As "PNG 16-bit" writes a 16-bit file.

### Select Subject, Sky, Focus Area, Select and Mask (`segment.js`, `matte.js`, `lib/select-mask.js`, `lib/tools/object-select.js`)

`segment.js` (pure): `saliency(img, { size })` (spectral residual or frequency-tuned saliency at ≤ 320 px), `grabCut(img, initMask, { iterations, gmmComponents, scale, lambda })` (GMM colour models with k-means init, 8-connected graph, Boykov–Kolmogorov or push-relabel max-flow, run at ≤ 640 px then upsampled), `selectSubject(img)` = saliency → trimap → grabCut → cleaned mask (largest components, hole filling), `selectSky(img)` = sky prior (colour + position + smoothness + top-connected) → grabCut refinement, `focusArea(img, { range 0..100 (in-focus threshold), noise 'auto'|'low'|'medium'|'high', autoRange })` = local Laplacian variance / high-frequency energy → threshold → grabCut cleanup, `objectSelect(img, rect|polygon)` = grabCut initialised with the region as probable foreground and the outside as background. `matte.js`: `refineEdge(img, mask, { radius, smartRadius, smooth, feather, contrast, shift })` (guided-filter alpha matting inside an unknown band of `radius` px around the mask edge, then Global Refinements: smooth = morphological open/close + blur, feather, contrast = sigmoid on alpha, shift edge = erode/dilate by percentage of the band), `decontaminate(img, alpha, amount)` (colour decontamination: replace edge colours by inward colours weighted by 1 − alpha).
`lib/select-mask.js`: `select:subject`, `select:sky`, `select:focus-area` (dialog: In-Focus Range slider with Auto, Image Noise Level, Add/Subtract brushes optional, Output To: Selection / Layer Mask / New Layer / New Layer with Layer Mask / New Document; "Select and Mask…" button hands over), all through `app.applySelection(selection, mode, label)` (undoable). Select and Mask… (`select:select-mask`): a modal workspace that hides the panels (`window:toggle-panels` style) and shows: left tools (Quick Selection, Refine Edge Brush, Brush, Object Selection, Lasso, Polygonal Lasso, Hand, Zoom), a right Properties panel with View Mode (Onion Skin with transparency slider, Marching Ants, Overlay with colour/opacity, On Black, On White, Black & White, On Layers), Show Edge, Show Original, Refine Mode (Color Aware / Object Aware → the grabCut vs guided matting weights), Edge Detection (Radius, Smart Radius), Global Refinements (Smooth, Feather, Contrast, Shift Edge, "Clear Selection", "Invert"), Output Settings (Decontaminate Colors + Amount, Output To), OK / Cancel / Reset; the view shows the preview mode over the real composite (a `view.postProcess`-style overlay is fine while the session runs; restore after). The result is a selection or a mask/layer as chosen, one history entry. `lib/tools/object-select.js`: the Object Selection tool in the `wand` slot (`tool:object-select`): Mode Rectangle / Lasso, Sample All Layers, Object Subtract (Alt), Hard Edge; drag a region → `objectSelect` → selection (combine modes from Shift/Alt like the marquee). Keep the whole pipeline inside a web worker when a single step exceeds ~300 ms (optional; report the timings you measured on a 2000×1500 image). Unit tests on synthetic images: a saturated disc on a plain background is selected with IoU > 0.9 by selectSubject; a blue gradient top half is selected by selectSky; the sharp half of a half-blurred texture by focusArea; refineEdge of a hard-edged mask against a soft-edged image produces fractional alpha in the band only; decontaminate removes halo colour. E2E: Select Subject on a red circle fixture selects the circle (selection bounds within a few px) and undo clears; Select and Mask opens, changing Feather alters the selection softness, Output to Layer Mask creates a mask; Object Selection drag selects the object only.

### Actions and automation (`lib/actions.js`, `lib/panels/actions.js`, `lib/automate.js`)

Actions engine: `app.actions = { sets: [{ id, name, actions: [{ id, name, functionKey?: { key: 'F2'…'F12', shift, ctrl }, color?, steps: [{ id, command, arg, label, enabled, dialog (show the dialog on playback), stop?: { message, allowContinue }, conditional?: { test, thenAction, elseAction }, menuItem?: command }] }] }], recording: { set, action } | null, record(), stop(), play(action, { from }), insertStop(), insertMenuItem(), insertConditional(), new/rename/delete/duplicate set and action, load/save sets (JSON files `*.pigment-actions`, plus reading Photoshop `.atn` is **not** required: say so in the dialog), playback options { mode 'accelerated'|'step'|'pause', pauseSeconds } }` persisted in `settings.actions` (a few KB) with a built-in "Default Actions" set re-created when empty (Vignette (selection), Frame Channel – 50 pixel, Wood Frame – 50 pixel, Cast Shadow (type), Water Reflection (type), Custom RGB to Grayscale, Molten Lead, Sepia Toning (layer), Quadrant Colors, Gradient Map — implemented with existing commands and the new filters). Recording listens to `'command:done'`: skip `cancelled`, skip `source === 'action'`, skip view/window/help/tool-switch commands (`/^(view|window|help|tool):/`) and commands whose `replayable` is false (toast "X could not be recorded: it has no replayable form" once), store `{ command: id, arg }` with the label from `COMMAND_LABELS`/the command's `label`. Playback runs `app.commands.run(step.command, step.arg, 'action')` and awaits the returned promise; a step with `dialog: true` runs the command without arg (its dialog opens) and continues on OK, stops on Cancel; Insert Stop shows the message with Stop / Continue; conditionals test document state (`'document-is-landscape'`, `'layer-is-background'`, `'layer-has-mask'`, `'layer-is-pixel'`, `'selection-exists'`, `'document-mode-is-rgb'`, `'layer-is-visible'`, `'layer-is-text'` …). Panel (`lib/panels/actions.js`, id 'actions', group 'bottom', icon 'play'): tree of sets › actions › steps with checkboxes (include) and dialog toggles, selection, record/stop/play/new set/new action/delete buttons, double-click a step to edit its arg as JSON (small dialog), Button Mode (coloured buttons that play), context menu (Playback Options…, Insert Menu Item…, Insert Stop…, Insert Conditional…, Action Options… (name, function key, colour), Load Actions…, Save Actions…, Reset Actions, Clear All Actions). Function keys: register the chosen F-keys in the renderer key handler (`app.shortcuts?.register` if present; else a `keydown` listener that defers to text fields).
Audit of dialog commands for replayability: every command the menu offers that opens a dialog must either accept its parameters as `arg` (so a recorded step replays silently) or call `ctx.setReplayArg(params)` / `ctx.cancel()`; add those calls where missing (`image:size`, `image:canvas-size`, `image:rotate-arbitrary`, `image:trim`, `edit:fill`, `edit:stroke`, `edit:fade`, `layer:new`, `layer:rename`, `layer:style*`, `layer:new-fill`, `layer:new-adjustment`, `layer:global-light`, `select:border/smooth/expand/contract/feather`, `select:color-range`, `view:new-guide`, `file:new`, `file:place`, `file:export`, `image:duplicate`, the AI dialogs, Camera Raw, Liquify …) — each edit is the two lines commented `// actions (lib/actions.js)`; list every command you changed in the report.
`lib/automate.js`: Batch… (`file:automate-batch`): Set + Action selects, Source (Folder with Include Subfolders / Opened Files), Destination (None / Save and Close / Folder with file naming tokens: document name, serial number (digits), extension, date, lower/upper case; Override "Save As" commands), Errors (Stop / Log to file), progress with cancel through `app.busy`; opens each file (`openDocument`), plays the action, saves with `app.docs.writeTo` to the destination path (`encodeForPath` chooses the format from the extension; keep the source extension unless the action saved), closes. Image Processor… (`file:script-image-processor`): source folder / opened, destination, Save as JPEG (quality, convert to sRGB no-op) / PSD / PNG / TIFF (when registered) with Resize to Fit W×H, optional action to run, copyright metadata into `doc.meta`. Fit Image… (`file:automate-fit-image`): width/height constraints → `image:size` with the fitting scale (don't enlarge option). Crop and Straighten Photos (`file:automate-crop-straighten`): finds the rectangular photos on a scanner background (flood the border colour with tolerance, connected components, minimum-area rectangle per component by rotating-calipers on the hull), rotates and crops each into a new document. Contact Sheet… (`file:automate-contact-sheet`): source folder/opened files, document size/resolution/mode, columns/rows, spacing, rotate for best fit, caption with the file name (font size) → one or more new documents of thumbnails (text via `TextLayer`). Delete All Empty Layers (`file:script-delete-empty-layers`: raster layers whose canvas is blank, `canvasIsBlank`), Flatten All Layer Effects (`file:script-flatten-effects`: `rasterizeLayer(layer, doc, { bakeStyles: true })` for every styled layer), Flatten All Masks (`file:script-flatten-masks`: `layer:mask` 'apply' for every masked raster layer) — each one `structural()` entry. Unit tests for the pure parts (file naming tokens, conditional tests, action JSON round trip, step filtering rules). E2E: record Levels + Gaussian Blur + Invert into a new action, play it on another document → the same pixels as running the three commands with those params and three history entries; Insert Stop pauses; Batch over `browser:/batch/` with two PNGs writes two files in the destination with the serial-number naming; Image Processor resizes to fit; Fit Image; Delete All Empty Layers removes only empty ones.

### Auto-Align, Auto-Blend, Photomerge, stacks (`register.js`, `stack.js`, `lib/align-blend.js`)

`register.js`: `fastCorners(gray, { threshold, nonmax })`, `briefDescriptors`/`orbDescriptors(gray, corners)` (rotated BRIEF), `matchDescriptors(a, b, { ratio })` (Hamming, Lowe ratio, cross-check), `ransacHomography(matches, { threshold, iterations })` → `{ H, inliers }`, also `ransacAffine`, `ransacTranslation`; `alignImages(images, { projection 'auto'|'perspective'|'cylindrical'|'spherical'|'collage'|'reposition', reference })` → per image `{ matrix | homography, bounds }` registered against the reference (the middle image for panoramas), pairwise chaining when a pair has too few matches; cylindrical/spherical: estimate a focal length from the homographies (or assume 0.8× the width) and warp onto the cylinder before translation alignment. `stack.js`: `stackImages(images, mode)` for the twelve Stack Modes (entropy, kurtosis, maximum, mean, median, minimum, range, skewness, standard deviation, summation, variance; none) per channel with alpha-aware sampling (transparent samples skipped).
`lib/align-blend.js`: Edit > Auto-Align Layers… (`edit:auto-align`, needs ≥ 2 selected raster layers): dialog Projection (Auto, Perspective, Collage, Cylindrical, Spherical, Reposition), Vignette Removal and Geometric Distortion checkboxes (accepted; apply a vignette gain estimate when on; report if skipped); transforms each layer by its matrix (`history.replaceCanvas` with `affineCanvas`/`perspectiveCanvas` from lib/image-ops.js), grows the canvas (`image:canvas-size`-like) to hold everything when "Reposition" is off. Edit > Auto-Blend Layers… (`edit:auto-blend`): Panorama / Stack Images, Seamless Tones and Colors (gain compensation per layer from overlap means), Content Aware Fill Transparent Areas (uses `contentAwareFill` from lib/content-aware.js on the merged result when checked); creates layer masks that choose each pixel from the layer whose seam cost is lowest (graph-cut lite: distance-transform/feathered seams through the overlap, or a Voronoi-of-centres seam with a feather of 10% of the overlap width); output stays layered with masks (Photoshop behaviour). File > Automate > Photomerge… (`file:automate-photomerge`): choose files (or open documents), Layout (Auto, Perspective, Cylindrical, Spherical, Collage, Reposition), Blend Images Together, Vignette Removal, Geometric Distortion Correction, Content Aware Fill Transparent Areas → a new document with aligned layers, masks, and the fill. Load Files into Stack… (`file:script-load-stack`): files or open documents → one document with a layer per file, "Attempt to Automatically Align Source Images", "Create Smart Object after Loading Layers" (`layer:smart-convert` on all). Statistics… (`file:script-statistics`): choose stack mode + files → a smart object with the stack mode applied (below). Layer > Smart Objects > Stack Mode (`layer:stack-mode` arg): sets `layer.stackMode` on a smart object whose source document has several layers; the smart object renders `stackImages(sourceLayers, mode)` instead of the composite (hook: `app.smartObjects?.setRenderOverride(layer, fn)` if lib/smart-object.js exposes one, else read `layer.stackMode` inside `render()` through a minimal commented hook in smart-object.js listed in your report); persisted in `.pigment` (describe hook: `registerLayerType` describe already serialises `stackMode` if you add it to the SmartLayer description via the existing `describe` callback). Unit tests: FAST finds the corners of a synthetic checkerboard; ORB matches a translated copy with > 90% inliers; RANSAC recovers a known homography within 0.5 px at the corners; alignImages of three shifted crops of one image returns the shifts within 1 px; stack median of noisy copies removes the noise (error vs clean < noise/3); mean/max/min exact on small inputs. E2E: Auto-Align two layers that are shifted copies brings them into register (pixel difference in the overlap near zero); Photomerge of two overlapping fixtures gives a wider document with two masked layers; Load Files into Stack with Statistics median.

### Content-Aware Scale and Lens Correction (`seam-carve.js`, `lens.js`, `lib/content-aware-scale.js`, `lib/lens-correction.js`)

`seam-carve.js`: `energy(img, { protect: Uint8ClampedArray|null, remove: Uint8ClampedArray|null, skin: boolean })` (gradient magnitude + protection weights; skin = YCbCr skin-tone detector adds protection), `findSeam(energy, 'vertical'|'horizontal')` (dynamic programming), `removeSeams(img, count, dir, opts)`, `insertSeams(img, count, dir, opts)` (duplicate the lowest seams averaged with neighbours, computed on a copy so seams spread), `contentAwareScale(img, { width, height, amount 0..100 (blend between seam carving and plain scaling), protect, skin })` → ImageDataLike; incremental seams in ≤ 200 ms steps for a 2000×1500 layer (precompute the seam order once per axis: "seam map", then scaling to any size is a lookup — do this, it is what makes the drag interactive). `lens.js`: `lensCorrect(img, params, { background })` implementing the placeholder's parameters: radial distortion `r' = r (1 + k1 r² + k2 r⁴)` with k from `distortion`, chromatic aberration as per-channel radial scale, vignette as `1 + v·(r/rmax)²` gain (midpoint shifts the curve), transform = rotate by `angle`, perspective (vertical/horizontal keystone as a homography), scale; edges per `edge`; `autoScale` picks the scale that hides transparent edges; also `detectHorizon(img)` (Hough lines on edges, dominant near-horizontal angle) for Auto straighten, and a grid overlay helper for the dialog.
`lib/content-aware-scale.js`: Edit > Content-Aware Scale (`edit:content-aware-scale`): a `TransformTool`-style session (study lib/image-ops.js TransformTool: start/update/commit/end, overlay, options bar) with corner/edge handles that resize the layer by seam carving (preview on a reduced copy while dragging, full on commit), options bar: Amount %, Protect (select a saved alpha channel: `doc.channels`), Protect skin tones toggle, W/H fields, Enter commits (`history.replaceCanvas`), Escape cancels; selection limits the scaled region (pixels outside the selection stay, like Photoshop). `lib/lens-correction.js`: Filter > Lens Correction… (`filter:lens-correction`, custom opener): dialog with a large preview (zoom, pan, grid toggle with size/colour), Auto Correction tab (Correction: Geometric Distortion, Chromatic Aberration, Vignette checkboxes; Auto Scale Image; Edge; "Search Criteria / lens profiles" replaced by a note that Pigment has no lens profile database and offers "Straighten horizon" (detectHorizon) instead) and Custom tab (Remove Distortion slider with the on-image distortion tool, Chromatic Aberration three sliders, Vignette amount/midpoint, Transform vertical/horizontal perspective, angle with the straighten tool (drag a line → angle), scale), Preview checkbox, Reset. Commits through `beginPixelEdit` with `{ filter: { kind: 'lens-correction', params } }` and returns the params. Unit tests: removing N seams from an image with a flat low-energy band removes pixels only inside the band; inserting then removing is near-identity; protect keeps a marked column; lens: distortion 0 is identity, barrel then pincushion of the same magnitude is near-identity, vignette darkens corners by the expected gain, angle 90° equals rotate90, detectHorizon finds a drawn 3° horizon within 0.5°. E2E: Content-Aware Scale shrinks a layer with a protected circle (circle diameter unchanged, background narrower); Lens Correction dialog previews, OK commits one entry, straighten tool sets the angle.

### Layer, Select and File extras (`lib/layers-extras.js`, `lib/tools/perspective-crop.js`, `lib/file-ops.js properties()`)

- `layer:from-background`: toggles between a Photoshop "Background" (the bottom raster layer, named Background, `locked.all` true, no transparency: transparent pixels filled with the background colour) and a normal layer (Photoshop asks for the name in a dialog: `formDialog` with name, colour label, blend, opacity); install `app.isBackgroundLayer = (layer) => …` (bottom raster layer, locked, named Background) so the menu label switches. New documents from `createDocument` have an unlocked Background layer today; do **not** change createDocument, but treat a bottom raster layer named "Background" as background for the label.
- `layer:group-from-layers` (name dialog, groups the selected layers), `layer:delete-hidden` (all hidden layers, confirm with the count), `layer:export-quick` / `layer:export-as` (the selected layers each rendered alone through `renderLayersFlat` and trimmed to content, Quick Export writes PNG next to the document or asks for a folder; Export As reuses the Export As dialog fields then a folder), `layer:link` (toggles `layer.linked` group ids: linked layers move together — hook the Move tool through `app.linkedLayers(layer) -> layer[]`, which `lib/tools/move.js` consults if present; add that one-line hook to move.js, commented, and list it), `layer:select-linked`, `layer:rasterize-all` (every non-raster layer via `rasterizeLayer`), `layer:smart-to-layers` (a smart object with a document source: replace it with its source layers transformed by the smart matrix; image sources become one raster layer), `select:deselect-layers`, `select:find-layers` (shows a filter bar at the top of the Layers panel: Kind (pixel, adjustment, type, shape, smart) toggles, Name text, Effect, Mode, Attribute (visible, locked, empty, linked, clipped, mask), Color label; the panel renders only matching layers while filtering is on; a toggle switch turns filtering off — extend `lib/panels/layers.js` through a hook: `app.layerFilter = (layer) => boolean | null` consulted in its `render()` (add that one commented line; list it)), `select:isolate-layers` (checkbox: shows only the selected layers in the panel and the canvas — `app.ui.isolated`, `app.layerFilter`; the compositor hides others via `opts.skip` set from `view.hiddenByIsolation` or by toggling `visible` undoably — choose the non-destructive panel/skip approach), `file:open-smart` (open files as smart objects into the active document or a new one), `file:close-others`, `edit:purge` (arg: undo = clear the active document's history except the current state, clipboard = `app.clipboard = null`, histories = all documents, all), colour labels for layers (`layer.color`, shown as a tint in the Layers panel row via `layer.color` if the panel supports it — it does not yet: add the tint through a data attribute in `lib/panels/layers.js` row(); one commented hook).
- File Info (`file:properties`, rename the dialog "File Info"): the existing fields plus Keywords, Rating (0–5), Credit, Source, Copyright status and URL, Camera data read-only when `doc.meta.exif` exists; stores into `doc.meta` (saved in `.pigment`; PSD export writes title/author/description/copyright/keywords into the XMP/IPTC resources ag-psd supports — `imageResources.xmpMetadata` as an XMP packet string; verify ag-psd 31 keeps it).
- Perspective Crop tool (`lib/tools/perspective-crop.js`, `crop` slot, `tool:perspective-crop`): drag a quad (four corner handles, grid overlay), Enter crops the document to the quad corrected to a rectangle (`perspectiveCanvas`), options bar: W, H, resolution, Front Image, Clear, Show Grid; undo restores.
E2E for every command (`tests/e2e/extras3.spec.mjs`), including Find Layers filtering by kind and name, Isolate Layers hiding others on the canvas, Link Layers moving together, Perspective Crop of a drawn trapezoid producing a rectangle of the chosen size.

### Tests expected from every 0.3 builder

As for 0.2: unit tests for pure modules under `tests/unit/*.test.mjs` (node:test, no DOM) that check numbers, e2e specs under `tests/e2e/*.spec.mjs` using `helpers.mjs` (`openApp`, `newDoc`, `run`, `runAwait`, `pixel`, `layerPixel`, `drag`, `confirmDialog`), and `tests/e2e/app.spec.mjs` green (every menu command registered, panels registered, no console errors). Placeholder kinds you replace must lose the `placeholder` flag; a stub module you replace must register every id it listed (the app spec checks the menu's commands exist). Report what the contract asked for that you did not or could not do.

## 0.4 features (contracts)

Pigment 0.4 is "Photoshop parity, stage 2": a type engine with several character and paragraph formats in one
layer, the Character and Paragraph panels, layer-style depth (Blending Options, contours, effect instances),
adjustment-dialog depth (Levels, Curves, Hue/Saturation and the newer kinds, presets, eyedroppers), gradients
(editor, noise, interpolation methods, live gradients), a pattern library, guides and snapping, vector masks and
mask density/feather, live shapes, Layers panel and Layer menu depth, and Photoshop's default shortcuts and
conventions. It is built like 0.3: a **skeleton** lands first (shared stores, models, registries, every menu item
and key binding of the release, stub modules), then **sixteen packages** are built at the same time in one
checkout, then everything is integrated and hunted for cross-feature bugs.

### Rules for the parallel round

1. **One owner per existing file.** The table below gives every existing file that 0.4 changes, with its single
   owner. Nobody else edits it. "skeleton" means the skeleton makes all of the 0.4 changes to that file and no
   package edits it afterwards. Where a package owns a file, the skeleton may land listed changes in it first (column
   "Plug in"), then hands it over. A package that finds it needs a change in a file it does not own does not make it:
   it works through the extension point named in the table, and if none fits it writes the need into its report for
   the integrator.
2. **New files** are owned by the package that the "New files" table names. Where the skeleton creates a stub file at a
   package's path, the package replaces it at the same path and keeps every export the stub API lists (it may add
   more).
3. **Register, do not patch.** No module replaces another module's function at runtime: no `app.commands.run = …`,
   no wrapping of `app.docs.writeTo`, no re-registering or wrapping a command id it does not own (0.3's HDR Toning
   wrapper in `adjust-more-ui.js` moves to the `prepare` hook of I.2), no `Object.assign` onto another module's
   export. Every registry below has the rule "the same id registered twice: the later registration wins", and only
   the owner of an id registers it (the stubs and the working placeholders registered by the skeleton excepted).
4. **Stubs.** `lib/stub.js stubCommands(app, ids)` registers each id as a disabled command marked `stub: true` and
   adds it to `app.stubbed`. From 0.4, `CommandRegistry.register(id, def)` with a def that is not marked `stub` removes
   `id` from `app.stubbed` (and emits `commands:changed`), so a real command replaces its stub whatever the module order.
   Every new 0.4 command id is stubbed by the skeleton or registered working by it (M.7 lists each id with its menu
   place, key and stub); the app spec checks that every menu command exists, and the skeleton smoke spec that every
   stubbed id is disabled.
5. **Settings.** All 0.4 setting keys are declared by the skeleton in `src/shared/defaults.js`. Each package has one
   namespace object (table J.7); it may add sub-keys inside its own object without editing defaults.js (`withDefaults`
   merges objects one level deep, so a package reads `settings.<ns>.<key> ?? <its default>`).
6. **Stylesheets and icons.** Each package with UI has an empty stylesheet linked in `index.html` by the skeleton
   (`styles/<package>.css`). Icons are added with `registerIcons({ name: svgBody })` (`lib/icons.js`) from the
   package's own files; a name that already exists is not replaced.
7. **Documentation.** A package writes its user-guide text, release-note lines (every changed default or key) and known
   gaps into `docs/0.4/<package>.md`. The integrator merges them into `docs/USER-GUIDE.md`, the release notes and this
   file. Nobody edits USER-GUIDE.md, README.md or ARCHITECTURE.md during the parallel round.
8. **Tests.** Each package adds `tests/unit/<package>.test.mjs` (when it has pure code) and
   `tests/e2e/<package>.spec.mjs`, and runs its e2e spec with `PIGMENT_E2E_PORT=<its port>` and
   `PIGMENT_E2E_OUT=.artifacts-<package>` (ports in the package table) so sixteen runs share the checkout. Existing
   spec files are not edited by packages; the skeleton edits exactly the nine lines listed in M.8 (six that press
   Ctrl+F for Last Filter, three that compare or mutate `doc.guides`). `tests/e2e/helpers.mjs` is the skeleton's; a
   package that needs helpers adds `tests/e2e/helpers-<package>.mjs`. A package test that needs a feature of another
   0.4 package that has not landed checks the capability flag that feature sets (`STYLE_FEATURES`, `app.stubbed`,
   `currentEngine()`) and skips with a message naming the package; the integrator removes such skips. The skeleton's
   own specs (`skeleton-04.spec.mjs`, `tests/electron/keys-04.spec.mjs`) are written to stay green before and after
   each package lands: an id of M.7 passes as a disabled stub in `app.stubbed` or as a real registration; an assertion
   about a stub's own behaviour (the marquee not snapping, Distribute's "Not available yet", the textarea editor, the
   stub widgets' controls, exact section and page lists) runs only while the owner has not landed (its first M.7 id
   still in `app.stubbed`, or `fields.js isStubWidget(type)`). A package that still finds one of their assertions
   failing because it replaced what the assertion pins does not edit the spec: it names the test and line in its
   report and the integrator gates it.
9. **The whole existing suite stays green** for every package: `npm test`, `npm run test:e2e` and the Electron test.
   A package that changes a behaviour an existing spec asserts (a default, a key) says so in its report and in
   `docs/0.4/<package>.md`; it does not edit the spec unless its contract names it.
10. **Call sites placed for others.** Where the skeleton places a call to another package's hook in a file a third
    package owns, the line carries a marker comment (`// snap (lib/snap.js)`, `// mask (K.1)`,
    `// sample (lib/sample.js)`, `// links (layers-extras/tags.js)`, `// drop (E25)`, `// ruler (lib/rulers.js)`). The
    owner of the file keeps every marked call when it rewrites the code around it, and adds the same call for a new
    gesture of the same kind (a new pointer drag snaps, a new merged sample goes through `sampleMerged`).

### Ownership of existing files

Every existing file 0.4 changes. Column "Plug in" says what the skeleton lands in a package-owned file before handing
it over, and how the other packages get what they need there without editing it.

| File | Owner | What the owner changes | Plug in (extension points, see "Extension points") |
|---|---|---|---|
| `src/renderer/app.js` | skeleton | MODULES; App services (`sessions`, `presets`, `snap`, `rulers`, `canvasCapture`, `patterns`, `backgroundRules` slot, layer double-click, drop handlers, view underlays); `historyStep()` and Edit > Undo / Redo through it; `changesDocument` on its `view:new-guide` / `view:clear-guides` (guides-snapping replaces both registrations, M.7); `isTextTarget()` honouring `ownsFocus`; menu commands arrive as `'menu'` or `'menu-key'`; `busy()` as a session; before-close order; settings-write report; ui state keys; `currentPattern` getter | E3, E4, E12, E14, E16, E22, E24, E25, E27 |
| `src/renderer/lib/commands.js` | skeleton | run order with session guards and observers; definition flags `changesDocument`, `record`, `undoLike`; `ctx.setReplayCommand`; `dialogs.passesMenu`; `'menu-key'` source; stub replacement | E3, E4, E31 |
| `src/renderer/lib/stub.js` | skeleton | `stub: true` marker | rule 4 |
| `src/renderer/lib/document.js` | skeleton | TextLayer on the rich-text model (`content`, `typeOptions`, `height`, flat `text`/`font` accessors); `vectorMask`, `blending`; mask `density`/`feather`; `Document.store` and the `guides` accessor; describe version 3; text, paint and shape-bounds backends | E1, E2, E6, E9, E33 |
| `src/renderer/lib/compositor.js` | layer-style-blending | `finishLayer` (channels, knockout, Blend If, the five check boxes, group effects) | skeleton lands first: K.1 calls with `parts` and `hasEffectiveMask` at every mask read, K.2 call, `hasEnabledStyles`, adjustment `ctx` and the margin growth of `composite()` (I.4). The owner keeps them (K.3) |
| `src/renderer/lib/io.js` | skeleton | `.pigment` version 3 and the version 2 upgrade; PSD: the effective mask, `psdExpressible` text, `textToPsd` new fields, baseline from the layout | none in 0.4 (PSD mapping is 0.5) |
| `src/renderer/lib/history.js` | nobody | unchanged | |
| `src/renderer/lib/form.js` | conventions-shortcuts-fields | numeric fields, Alt = Reset in `formDialog` | E7 (widget routing landed by the skeleton) |
| `src/renderer/lib/dialogs.js` | conventions-shortcuts-fields | movable dialogs, navigation under them, Alt = Reset (`onReset`), `passesMenu` | E15 (`setCanvasThrough`, `onReset`, `passesMenu` stub landed by the skeleton) |
| `src/renderer/lib/tools.js` | conventions-shortcuts-fields | numeric option fields, flyouts and shortcut cycling | E7 (option kinds through the widget registry, landed by the skeleton), E29 |
| `src/renderer/lib/shortcuts.js` | conventions-shortcuts-fields | temporary and spring-loaded tools (`view.tempTool`, `view.tempToolVia`), Ctrl/Alt+Space zoom, keys while a dialog is open | `src/shared/keymap.js` tables, E29 |
| `src/shared/keymap.js` | skeleton | every 0.4 binding (MENU_KEYS, RENDERER_KEYS, TYPE_KEYS), `typeKeyFor`, the physical-key fallback for Alt combos, labels, groups | none: all keys land in the skeleton |
| `src/main/menu.js` | skeleton | becomes a re-export of `src/shared/menu-template.js` (new) | none: all items land in the skeleton |
| `src/main/main.js` | skeleton | menu clicks report `triggeredByAccelerator`; `before-input-event` forwards Shift+Alt+letter on Windows and Linux (O) | none |
| `src/main/ipc.js`, `src/main/clipboard.js`, `src/preload.cjs` | skeleton | preset-store channels, settings write errors, `readClipboardText`, the menu command source | E5, O |
| `src/renderer/lib/bridge.js` | skeleton | browser preset backend (IndexedDB), failed settings write report, `readClipboardText`, menu command source | E5, N, O |
| `src/shared/defaults.js` | skeleton | every 0.4 key and namespace object | rule 5 |
| `src/renderer/index.html` | skeleton | stylesheet links | rule 6 |
| `src/renderer/lib/icons.js` | skeleton | `registerIcons` | rule 6 |
| `scripts/build-vendor.mjs` | skeleton | runs every `scripts/vendor/*.mjs` step | E23 |
| `package.json`, `package-lock.json` | type-engine-core | the HarfBuzz dependency | |
| `src/shared/pixels/adjust-def.js` | skeleton | registry fields `apply(img, params, rect, ctx)`, `margin`, `deepExact` (I.4); helpers moved there by the colour split | kinds declare the fields in their own files |
| `src/shared/pixels/adjust.js` | adjust-tonal | levels, curves (drawn curves, `space`), exposure, threshold, equalize, brightness/contrast, auto algorithms, clipping masks | the colour kinds move to `adjust-color.js` (skeleton split); `applyAdjustment(img, kind, params, rect, ctx)` lands with the skeleton |
| `src/shared/pixels/deep.js` | skeleton | `deepExact` asked before both float branches; `isExactKind(kind, params)`; Gradient Map through the gradient model; `ctx` passed to the 8-bit fallback | kinds declare `deepExact` (adjust-tonal, adjust-color) |
| `src/renderer/lib/adjust-ui.js` | adjust-tonal | Levels/Curves editors through `app.adjustEditors`, last-used values, `-last` commands, Auto | skeleton lands first: the frame in `pixelEditDialog` and the Properties section, `prepare` (I.2), `ctx` for destructive adjustments, `editFillLayer` moved out (E21) |
| `src/renderer/lib/adjust-more-ui.js` | adjust-color | HDR Toning additions; its 0.3 command wrapper becomes a `prepare` hook | E17 |
| `src/shared/pixels/styles.js` | layer-style-effects | effect instances, contours, noise, texture, the new effect fields, `interiorAsGroup`, `transparencyShapes`, `split`, `splitEffects` | skeleton lands first (J.6): instance helpers, `hasEnabledStyles` with arrays and `hidden`, `mergeStyles` keeping `hidden` and arrays, `scaleEffects`, the `applyStyles` option names, `STYLE_FEATURES`, the `splitEffects` stub |
| `src/renderer/lib/style-ui.js` | layer-style-effects | effect list (+, reorder, delete), EFFECT_FIELDS, contour and drag-on-canvas | E13; skeleton lands first: pages, the dialog snapshotting, restoring and committing `blending` (L.3), the pattern overlay reading `app.patterns.current()` |
| `src/renderer/lib/patterns.js` | patterns | the pattern library behind `app.patterns` | E16 (the stub API and `installPatterns`, landed by the skeleton) |
| `src/renderer/lib/edit-ops.js` | patterns | Define Pattern dialog, Fill dialog pattern row, Scripted Patterns | skeleton lands first: Fill reads `app.patterns.current()`, Define Pattern calls `app.patterns.define()`, the unused `app.patterns` array is deleted (L.6). The type session answers the clipboard commands through its `handle` (B.8): no type edit here |
| `src/renderer/lib/modes/dialogs.js` | patterns | Bitmap > Custom Pattern uses the pattern widget | E7 |
| `src/renderer/lib/layer-ops.js` | finish-layer-menu | New Layer/Group/Duplicate dialogs, arrange, distribute, lock, visibility, merge, rasterize, Background rules, layer property commands on every selected layer | skeleton lands first: `structural()` through `store.snapshot()`, `layer:move-to` with several ids, `setLayersProps`, the text snapshot in `setLayerProps`, `cloneLayer` of the new fields, `rasterizeLayer` keeping `vectorMask`, mask baking through K.1 (`parts: 'raster'`), `createPaint`, `app.patterns`, the working `layer:merge` (M.6), `layer:distribute` answering edge arguments with "Not available yet" |
| `src/renderer/lib/layers-extras/structure.js`, `layers-extras/tags.js` | finish-layer-menu | Background rules (`app.backgroundRules`), Layer from Background, links honoured by Align and Distribute | skeleton lands first: `mapLayerAffine` through `mapShapeGeometry` and `scaleEffects`, the vector-mask path in `mapLayerAffine`, the `backgroundRules` stub (L.13). Free Transform's links: call placed by the skeleton in `image-ops.js` |
| `src/renderer/lib/layers-extras/find.js` | layers-panel-depth | more filter types; isolation honoured by sampling (`app.sampleSkip`) and auto-select | E28; skeleton replaces the style tests first |
| `src/renderer/lib/panels/layers.js` | layers-panel-depth | rows, effect rows, footer, drags, eye column, panel menu | skeleton lands first: `hasEnabledStyles`, the vector-mask thumbnail and link icon (L.15), the drop-handler call on rows (E25) |
| `src/renderer/lib/panels/character.js` | type-character-panel | rewritten on the range model; renders `typeSections('character')` | E1, E2, E26 |
| `src/renderer/lib/panels/properties.js` | skeleton | becomes a section host; today's sections move to `lib/properties/*.js` | E18 |
| `src/renderer/lib/panels/paths.js` | masks-vector-masks | vector mask row, create vector mask from path | E19 (listing the rows of registered kinds is landed by the skeleton) |
| `src/renderer/lib/panels/adjustments.js` | adjust-color | preset groups | E5 |
| `src/renderer/lib/panels/info.js` | skeleton | coordinates through `app.rulers.format` (E27), colour through `sampleMerged` (E28) | |
| `src/renderer/lib/extras.js` | skeleton | Preferences become a section registry | E20 |
| `src/renderer/lib/canvas-view.js` | guides-snapping | guide drawing and dragging, ruler origin, ruler context menu, grid styles | skeleton lands first: canvas capture (E14), view underlays (E22), mask view through `lib/mask-view.js` (E10b), the drop-handler call (E25), `p.temporary` from `view.tempToolVia` and `app.snap.end()` after every routed pointer gesture (F) |
| `src/renderer/lib/tools/move.js` | guides-snapping | guides picked, moved and deleted with the Move tool; `app.snap` answers | E12 (snap calls placed by the skeleton), E24 (double-click call placed by the skeleton) |
| `src/renderer/lib/tools/text.js` | type-editing | the Type tool session on the new editor (box handles, Ctrl transform and move, Alt-click size, placeholder text) | B.7 (stable surface), E7 option kind `font-size` (type-character-panel); skeleton lands first: the `'type'` session, `textBox()` on `layout.frame`, `type:toggle-panels`, the `font-size` option kind, the snap call of the box drag (F) |
| `src/renderer/lib/tools/fill.js` | gradients | gradient tool picker, Gradient vs Classic mode, live gradients | skeleton lands first: the Paint Bucket moves to `lib/tools/bucket.js` (owned by patterns), snap calls |
| `src/renderer/lib/tools/vector.js` | shapes-live | shape tools (Triangle, polygon and line options, Create dialog, geometry menu) | E19 (path target kinds with `remove`/`rename`/`toSaved`, path buttons and the `createShapeLayer` export, landed by the skeleton), snap calls |
| `src/renderer/lib/path-ops.js` | shapes-live | `renderShapeLayer` (stroke alignment, caps, joins, dashes, paints), `shapeBounds`, `mapShapeGeometry`, `normalizeShapeProps` | E9, E33 (stubs landed by the skeleton) |
| `src/renderer/lib/text-path.js` | type-engine-core | glyph runs from the engine through `shapeText()` / `glyphRuns()` | E2 |
| `src/renderer/lib/layer-move.js` | skeleton | linked vector masks and shapes (`mapShapeGeometry`) move with the layer | |
| `src/renderer/lib/image-ops.js` | skeleton | snap calls in Free Transform; vector masks, shapes (`mapShapeGeometry`) and the doc store in `remapDocument` and Free Transform; text scaling through the model; `shallow()` of text content; Free Transform as a session; `linkedLayers` in `collectTargets`; options-bar X/Y through `app.rulers`; `scaleStyles` through `scaleEffects` | |
| `src/renderer/lib/tools/select.js`, `tools/perspective-crop.js`, `tools/retouch.js`, `tools/nav.js`, `tools/object-select.js` | skeleton | snap calls (marquee, Perspective Crop); merged sampling through `sampleMerged` (Magic Wand, retouch tools, Eyedropper, Object Selection); Pattern Stamp reads `app.patterns.current()`; Perspective Crop maps shapes through `mapShapeGeometry` | |
| `src/renderer/lib/smart-object.js` | skeleton | shapes through `mapShapeGeometry`; adjustment smart filters pass the adjustment `ctx` | |
| `src/renderer/lib/blur-gallery-ui.js`, `content-aware-scale.js`, `select-mask/workspace.js` | skeleton | run wrappers and before-close listeners replaced by the session registry; their number-field Enter/Escape checks also match `input[data-numeric]` | E3 |
| `src/renderer/lib/actions.js`, `actions/model.js` | skeleton | the wrapper becomes an observer; definition flags `record`, `undoLike`, `changesDocument`; `setReplayCommand`; commands a session answered are dropped; New Guide records its colour; `hasEnabledStyles` (line 135) | E4, E31 |
| `src/renderer/lib/modes.js`, `automate.js`, `depth.js`, `ai/features.js` | skeleton | `hasEnabledStyles`; render and bake reads of masks through K.1 (automate's Apply All Masks with `parts: 'raster'`, depth's `planFlatten` and `maskOf`, ai's `activePixels`); depth's exactness test with the params | K.1, J.6 |
| `tests/e2e/helpers.mjs` | skeleton | helpers for the new APIs (`app.spec.mjs` needs no change: it reads the template through `src/main/menu.js`, which re-exports it) | |
| `tests/e2e/editing.spec.mjs` (line 144), `filters-b.spec.mjs` (173), `hunt4-sessions.spec.mjs` (364, 421, 426, 441), `actions.spec.mjs` (570, 1081), `files.spec.mjs` (44) | skeleton | the nine lines of M.8 | |

Files no 0.4 package edits (for the avoidance of doubt): `history.js`, `panels.js` (panels register themselves; the
Window menu is the template's), `selection.js`, `brush.js`, `warp.js`, `layers-extras.js`, `documents.js`,
`file-ops.js`, `filter-ui.js`, `align-blend.js`, `select-mask.js`, `tools/paint.js`, `ai/*` other than `ai/features.js`,
and the `src/shared/pixels/*` modules the table does not name.

### New files

| Package | New files (owned) | MODULES entry (stub by the skeleton until the package lands) |
|---|---|---|
| skeleton | `lib/type/model.js`, `lib/type/api.js`, `lib/type/target.js`, `lib/type/sections.js`, `lib/presets.js`, `lib/doc-store.js`, `lib/sessions.js`, `lib/canvas-capture.js`, `lib/fields.js`, `lib/paint.js`, `lib/paint-editors.js`, `lib/sample.js`, `lib/tool-traits.js`, `lib/stubs-later.js`, `src/shared/pixels/gradient-model.js`, `src/shared/menu-template.js`, `lib/properties/transform.js`, `lib/properties/ui.js` (the sections' shared DOM helpers), `lib/preset-kinds.js` (the 0.4 preset kinds and their built-ins); the stub files listed in the right-hand column and in the next table | `lib/stubs-later.js` (ids of 0.5 items shown in 0.4 menus) |
| type-engine-core | `lib/type/fonts.js`, `shaper.js`, `layout.js`, `render.js`, `scripts/vendor/harfbuzz.mjs`, `src/renderer/vendor/harfbuzz/` (built), an OFL test font in `tests/fixtures/fonts/` | `lib/type/layout.js` |
| type-editing | `lib/type/editor.js`, `clipboard.js`, `edit-keys.js` | `lib/type/editor.js` |
| type-character-panel | `lib/type/char-format.js`, `optical-kerning.js`, `lib/properties/text.js` (stub moved there by the skeleton) | `lib/type/char-format.js` |
| type-paragraph-panel | `lib/panels/paragraph.js`, `lib/type/paragraph.js`, `hyphenation.js`, `lib/type/patterns/`, `lib/properties/paragraph.js` | `lib/panels/paragraph.js` |
| layer-style-blending | `src/shared/pixels/blend-if.js`, `lib/blending-options.js` (stub by the skeleton) | `lib/blending-options.js` |
| layer-style-effects | `src/shared/pixels/contour.js`, `styles-more.js`, `lib/contour-editor.js`, `lib/style-canvas-drag.js`, `lib/style-prepare.js` (stub by the skeleton) | `lib/contour-editor.js` |
| adjust-tonal | `lib/adjust/tonal.js`, `levels-editor.js`, `curves-editor.js`, `auto-options.js`, `eyedroppers.js`, `presets.js` (stub), `frame.js` (stub) | `lib/adjust/tonal.js` |
| adjust-color | `lib/adjust/color.js`, `hue-sat-editor.js`, `shadows-highlights.js`, `src/shared/pixels/adjust-color.js` (the brief's `adjust-new.js`; created by the skeleton split), `lib/tools/adjustment-brush.js`, `lib/panels/adjustment-presets.js`, `lib/properties/adjustment.js` (stub moved there) | `lib/adjust/color.js` |
| gradients | `lib/gradient-editor.js`, `src/shared/pixels/gradient-render.js`, `lib/panels/gradients.js`, `lib/gradient-widget.js`, `lib/properties/fill.js` (stub moved there); owns `gradient-model.js` after the skeleton | `lib/panels/gradients.js` |
| patterns | `lib/panels/patterns.js`, `lib/pattern-picker.js`, `lib/scripted-patterns.js`, `lib/pattern-preview.js`, `lib/tools/bucket.js` (skeleton split) | `lib/panels/patterns.js`, `lib/tools/bucket.js` |
| guides-snapping | `lib/guides.js`, `lib/smart-guides.js`, `lib/guide-layout.js`, `lib/snap.js` (stub), `lib/rulers.js` (stub) | `lib/guides.js` |
| masks-vector-masks | `lib/vector-mask.js`, `lib/mask-view.js` (stub), `lib/mask-render.js` (stub), `lib/properties/mask.js` (stub moved there) | `lib/vector-mask.js` |
| shapes-live | `lib/shape-props.js`, `lib/shape-paint-ui.js`, `lib/tools/shape-widgets.js`, `lib/properties/shape.js` (stub moved there) | `lib/shape-props.js` |
| layers-panel-depth | `lib/panels/layers-effects.js`, `layers-menu.js`, `lib/blend-preview.js` | `lib/panels/layers-menu.js` |
| finish-layer-menu | `lib/layer-dialogs.js`, `lib/layers-extras/stamp.js` | `lib/layer-dialogs.js` |
| conventions-shortcuts-fields | `lib/conventions.js`, `lib/command-search.js`, `lib/numeric-field.js` (stub), `lib/temp-tools.js` | `lib/conventions.js` |

MODULES order (app.js): the 0.4 entries are inserted after `lib/panels/actions.js` and before `lib/panels/color.js`,
except the four panel modules (`panels/paragraph.js`, `panels/gradients.js`, `panels/patterns.js`,
`panels/layers-menu.js`), which come after `lib/panels/info.js` so that their tabs follow the existing ones, and
`lib/tools/bucket.js`, which comes right after `lib/tools/fill.js` (the gradient tool stays first in the slot).
`lib/type/api.js` is not a MODULES entry: app.js imports it statically so that the text backend is set before any
document opens. `lib/patterns.js`, `lib/snap.js`, `lib/rulers.js` and `lib/sample.js` are installed by `start()`
before MODULES (`installPatterns`, `installSnap`, `installRulers`, `installSample`; the owners keep these exports).

### Extension points

Thirty-three extension points; the letter is the section of "Shared integration points" that specifies it.

| # | Extension point | Where | Used in 0.4 by | Later users |
|---|---|---|---|---|
| E1 | Rich-text model and `TextLayer` compatibility | `lib/type/model.js` (A) | the four type packages | psd-text, type-styles-prefs, type-international |
| E2 | Type facade (engines, composers, breakers, hyphenators, kerners, list formatters, font provider) and type target | `lib/type/api.js`, `lib/type/target.js` (B) | type packages | type-fonts, type-opentype-glyphs, type-menu-commands, type-on-path-area |
| E3 | Session registry | `lib/sessions.js` (E) | migrated 0.3 sessions, Type tool, Free Transform, busy | every on-canvas workspace |
| E4 | Command observers | `CommandRegistry.observe` (E) | actions engine | scripting-api, history-panel-depth |
| E5 | Preset store, kinds and file formats | `lib/presets.js` (C) | gradients, patterns, contours, adjustment presets, stroke styles | presets-panels, preset-files-manager, brush engine, swatches, tool presets |
| E6 | Document store collections | `lib/doc-store.js` (D) | guides, ruler origin | comps, slices, notes, counts, samplers, styles, variables, document patterns |
| E7 | Field widgets and options-bar kinds | `lib/fields.js` (H) | gradient, pattern, contour, preset, numeric, paint, font-size | every later dialog and panel |
| E8 | Adjustment dialog frame slots; adjustment registry fields `ctx`, `margin`, `deepExact` | `lib/adjust/frame.js`, `adjust-def.js` (I.1, I.4) | adjust-tonal, adjust-color | camera-raw-panels (eyedroppers) |
| E9 | Paint renderers and gradient model | `lib/paint.js`, `gradient-model.js` (G) | gradients, patterns, shapes-live | frames, artboard backgrounds |
| E10 | Mask render hook (+ E10b mask view hook) | `lib/mask-render.js`, `lib/mask-view.js` (K) | masks-vector-masks | artboards (clipping), frames |
| E11 | Style preparation hook and `applyStyles` options | `lib/style-prepare.js`, `styles.js` (K.2, J.6) | layer-style-effects, layer-style-blending | psd-layers |
| E12 | Snap hook and snap targets | `lib/snap.js` (F) | guides-snapping (all tools) | artboards, slices, move-tool-depth |
| E13 | Layer Style dialog pages | `app.layerStyle.registerPage` (L.3) | layer-style-blending | presets-panels (Styles page) |
| E14 | Canvas capture (canvas input while a dialog is open) | `lib/canvas-capture.js` (I.3) | adjust eyedroppers and on-image tools, style drag on canvas, guide picking | color-picker-swatches, camera-raw |
| E15 | Dialog pass-through, Reset and menu pass-through | `app.dialogs.setCanvasThrough`, `onReset`, `passesMenu` (I.3, E) | adjust frame, conventions | |
| E16 | Pattern library API `app.patterns` | `lib/patterns.js` (L.6) | patterns, effects, bucket, stamp, fill | brush texture |
| E17 | Adjustment editors with capabilities and `prepare` | `app.adjustEditors` (I.2) | adjust-tonal, adjust-color | |
| E18 | Properties panel sections | `app.properties.registerSection` (L.1) | type, adjust-color, masks, shapes, gradients/patterns | info-histogram-properties, artboards |
| E19 | Path target kinds and path buttons | `tools/vector.js` exports (L.4) | masks-vector-masks | pen-paths, type-on-path-area, artboards |
| E20 | Preferences sections | `app.preferences.registerSection` (L.2) | guides-snapping, type-editing, masks, conventions | preferences-dialog re-homes them |
| E21 | Paint editors (fill layers, shape paints) | `lib/paint-editors.js` (G.5) | gradients, patterns, shapes-live, finish-layer-menu | |
| E22 | View underlays | `app.viewUnderlays` (L.5) | Pattern Preview | slices, artboards |
| E23 | Vendor build steps | `scripts/vendor/*.mjs` (L.8) | HarfBuzz | lcms2, pdf.js, onnxruntime |
| E24 | Layer double-click actions | `app.registerLayerDoubleClick` (L.7) | type-editing (Move tool double-click) | smart objects, artboards |
| E25 | Drop handlers for in-app drags (canvas, layer rows) | `app.registerDropHandler` (L.9) | gradients, patterns | styles, swatches, brushes, libraries |
| E26 | Type panel sections | `lib/type/sections.js` (L.14) | type-character-panel, type-paragraph-panel | type-opentype-glyphs, type-international, type-fonts |
| E27 | Ruler units and origin | `app.rulers` (`lib/rulers.js`, L.10) | guides-snapping (origin, units), Info, Properties, Free Transform | artboards, measurement |
| E28 | Merged sampling | `lib/sample.js sampleMerged`, `app.sampleSkip` (L.11) | layers-panel-depth (isolation) | color-sampler, brush engine |
| E29 | Tool traits | `lib/tool-traits.js` (L.12) | conventions (spring-loaded tools), finish-layer-menu (opacity digits) | brush-painting-behaviours |
| E30 | Background rules | `app.backgroundRules` (L.13) | finish-layer-menu, layers-panel-depth, masks-vector-masks, layer-style-blending | psd-layers |
| E31 | Command definition flags and replay command | `CommandRegistry.register` (E) | guides-snapping, conventions, layers-panel-depth, finish-layer-menu | scripting-api |
| E32 | Vector mask in the Layers panel row | `lib/mask-view.js vectorMaskThumb` and `layer:vector-mask` (L.15) | masks-vector-masks | |
| E33 | Shape geometry mapping | `path-ops.js mapShapeGeometry`, `normalizeShapeProps` (J.5) | shapes-live | psd-layers, artboards |

### Shared integration points

Each point gives the API, the default (stub) behaviour the skeleton ships so that every package can be built and
tested before the others land, and who completes it.

#### A. Rich-text model (`lib/type/model.js`, skeleton; owned by type-engine-core afterwards)

Pure JavaScript, no DOM, importable by Node unit tests. Content is immutable: every operation returns a new object
(callers keep the old one for undo). Indices are UTF-16 code units; operations snap a boundary that falls inside a
surrogate pair to the pair's start (the editor snaps to grapheme clusters itself with `Intl.Segmenter`).

```ts
interface TextContent {
  v: 1;
  text: string;            // paragraphs are separated by '\n'; U+2028 is a forced line break inside a paragraph; '\t' a tab
  runs: { len: number, style: CharStyle }[];   // cover [0, text.length) in order; no zero-length run, except exactly
                                               // one run of len 0 when text is '' (it holds the insertion style)
  paras: { style: ParaStyle }[];               // one per paragraph: paras.length === count('\n') + 1
}
// CharStyle and ParaStyle are sparse: only attributes that differ from CHAR_DEFAULTS / PARA_DEFAULTS are stored.
// resolveChar(style) = { ...CHAR_DEFAULTS, ...style }. A key set to undefined in a patch resets it to the default.
```

**Nested values** (`features`, `stroke`, `hyphenation`, `justification`, `list`) are values: a patch replaces one
whole (a caller that changes one field spreads the resolved value: `{ justification: { ...cur.justification,
autoLeading: 150 } }`), equality is deep, and `normalize` drops a nested value only when it deep-equals the default.

**Character attributes** (`CHAR_DEFAULTS`, frozen; units are document pixels unless stated, the UI converts to pt or
mm with the document resolution):

| Key | Default | Meaning |
|---|---|---|
| `fontFamily` | `'Arial'` | CSS family name |
| `fontWeight` | `400` | 100..900, the face asked for |
| `fontItalic` | `false` | real italic face asked for |
| `postScriptName` | `null` | the exact face when chosen from font data (type-engine-core, type-fonts); wins over weight/italic when the font is present |
| `size` | `48` | px |
| `leading` | `'auto'` | `'auto'` or px; auto = `PARA justification.autoLeading` % of the largest size on the line |
| `tracking` | `0` | 1/1000 em, added between characters of the run (never after the last character of a line) |
| `autoKern` | `'metrics'` | `'metrics'`, `'optical'`, `'none'` |
| `kern` | `0` | manual kerning after this character, 1/1000 em (a run boundary is made around a character that has it) |
| `scaleX`, `scaleY` | `100` | percent |
| `baselineShift` | `0` | px, positive up |
| `color` | `'#000000'` | `#rrggbb` |
| `fauxBold`, `fauxItalic` | `false` | synthesised, independent of the face |
| `caps` | `'normal'` | `'normal'`, `'all'`, `'small'` |
| `position` | `'normal'` | `'normal'`, `'super'`, `'sub'` (size 58.3 %, shift ±33.3 % of the size, Photoshop's values) |
| `underline`, `strike` | `false` | |
| `language` | `'en-US'` | BCP 47; read by hyphenation (and spelling in 0.7) |
| `features` | `{}` | OpenType feature overrides `{ tag: 0 \| 1 \| n }`; empty = the font's defaults (liga, calt on) |
| `fractionalWidths` | `true` | |
| `noBreak` | `false` | the run is not broken across lines |
| `stroke` | `null` | `{ color, width }`: Pigment's text stroke of 0.2, kept per run |

**Paragraph attributes** (`PARA_DEFAULTS`):

| Key | Default | Meaning |
|---|---|---|
| `align` | `'left'` | `'left'`, `'center'`, `'right'`, `'justify-left'`, `'justify-center'`, `'justify-right'`, `'justify-all'` |
| `indentLeft`, `indentRight`, `indentFirst` | `0` | px (`indentFirst` may be negative) |
| `spaceBefore`, `spaceAfter` | `0` | px |
| `hyphenate` | `false` | |
| `hyphenation` | `{ minWord: 7, after: 2, before: 2, limit: 2, zone: 36, capitalized: true, lastWord: true, acrossColumn: true }` | Photoshop's Hyphenation dialog; `zone` px, `limit` 0 = no limit |
| `justification` | `{ word: [80, 100, 133], letter: [0, 0, 0], glyph: [100, 100, 100], autoLeading: 120, singleWord: 'justify-all' }` | min / desired / max percent; `singleWord`: how a line with one word is set |
| `composer` | `'every'` | `'single'` or `'every'` (Adobe Every-line Composer is Photoshop's default) |
| `breakRules` | `'standard'` | `'standard'`: line-break opportunities by UAX 14 for the paragraph's language; `'legacy'`: 0.3's, after U+0020 only (written by the version 2 upgrade so old paragraphs keep their lines) |
| `hangingPunctuation` | `false` | Roman Hanging Punctuation |
| `list` | `null` | `{ type: 'bullet' \| 'number', marker: '•' \| 'decimal' \| 'lower-alpha' \| 'upper-alpha' \| 'lower-roman' \| 'upper-roman', start: 1, level: 0 }` |
| `tabStop` | `36` | px between default tab stops |

**Ranges.** `normalize` clamps to these and never rounds (0.3 spacings such as 0.5 px at 7 px size survive):

| Attribute | Range | Attribute | Range |
|---|---|---|---|
| `size` | 0.1 .. 10000 px | `leading` | `'auto'` or 0.1 .. 20000 px |
| `tracking`, `kern` | −1000 .. 10000 | `scaleX`, `scaleY` | 1 .. 1000 % |
| `baselineShift` | −10000 .. 10000 px | `stroke.width` | 0 .. 1000 px |
| `indentLeft`, `indentRight`, `indentFirst`, `spaceBefore`, `spaceAfter` | −10000 .. 10000 px | `tabStop` | 1 .. 10000 px |
| `justification.word` | 0 .. 1000 %, min ≤ desired ≤ max | `justification.letter` | −100 .. 500 %, ordered |
| `justification.glyph` | 50 .. 200 %, ordered | `justification.autoLeading` | 0 .. 500 % |
| `hyphenation.minWord` | 2 .. 25 | `hyphenation.after`, `.before` | 1 .. 15 |
| `hyphenation.limit` | 0 .. 25 | `hyphenation.zone` | 0 .. 10000 px |
| `list.start` | 0 .. 9999 | `list.level` | 0 .. 8 |

**Layer-level type options** (`TextLayer.typeOptions`, `TYPE_OPTION_DEFAULTS`): `orientation: 'horizontal' |
'vertical' | 'vertical-stacked'` (moved out of `font.orientation`), `antiAlias: 'smooth'` (read from 0.5),
`systemLayout: false`. **Box**: `TextLayer.width` (null = point text) and the new `TextLayer.height` (null = the box
grows with the text, which is what every 0.3 layer is; a number = fixed box, text beyond it is not drawn and
`layout.overflow` is true).

**Operations** (all pure; `content` in, new content out):

```ts
CHAR_DEFAULTS, PARA_DEFAULTS, TYPE_OPTION_DEFAULTS, CHAR_KEYS, PARA_KEYS, RANGES   // frozen
MIXED: unique symbol                                           // "several values" in attribute queries
resolveChar(style): CharStyle; resolvePara(style): ParaStyle   // defaults filled in
fromPlain(text: string, char?: CharStyle, para?: ParaStyle): TextContent
fromLegacy({ text, font }): { content, typeOptions }           // 0.3 TextLayer -> model (see "Compatibility")
legacyFont(content, typeOptions): TextStyleV1                  // the flat 0.3 font object of the first character
plainText(content): string; contentLength(content): number
insertText(content, at, str, style?): TextContent              // style: sparse CharStyle; default = the style at `at`
                                                               // (the character before it; at 0 the first one);
                                                               // '\n' in str splits paragraphs, both halves keep the style
deleteRange(content, from, to): TextContent                    // deleting a '\n' joins paragraphs: the first's style wins
replaceRange(content, from, to, str, style?): TextContent
replacePlain(content, next: string): TextContent               // the minimal replaceRange that turns plainText into next
                                                               // (common prefix and suffix kept, with their formatting)
sliceContent(content, from, to): TextContent                   // formatted clipboard
insertContent(content, at, piece: TextContent): TextContent    // formatted paste; piece paragraphs keep their styles
applyChar(content, from, to, patch: Partial<CharStyle>): TextContent       // from === to: no change (the editor keeps
                                                                           // an insertion style for a caret)
applyPara(content, from, to, patch: Partial<ParaStyle>): TextContent       // every paragraph that [from, to] touches
                                                                           // (a caret touches its paragraph)
charAttrs(content, from, to, { deep = false }?): { [k]: value | MIXED }    // resolved values; caret = style at caret;
paraAttrs(content, from, to, { deep = false }?): { [k]: value | MIXED }    // deep: nested values report MIXED per sub-key
                                                                           // ({ justification: { word: [80, MIXED, 133], … } })
charStyleAt(content, index): CharStyle (resolved); paraIndexAt(content, index): number
paragraphs(content): { index, from, to, text, style (resolved) }[]
runsIn(content, from, to): { from, to, style (resolved) }[]
splitAt(content, index): TextContent                           // forces a run boundary (no visible change)
normalize(content): TextContent                               // merges equal neighbours, drops empty runs, fixes the
                                                               // paragraph count, clamps to RANGES, strips default keys
mapChar(content, fn(style) -> style), mapPara(content, fn)     // e.g. replace a missing font
scaleContent(content, s): TextContent                          // size, px leading, baselineShift, stroke width,
                                                               // indents, spaces, tabStop, hyphenation zone x s
isUniform(content): boolean                                    // one run and one paragraph style
nonDefaultKeys(content): { char: string[], para: string[] }    // attributes any run / paragraph sets (PSD export, J.8)
equalStyle(a, b), cloneContent(c), validate(c): string[]      // validate: problems, [] when sound
```

Unit tests (`tests/unit/type-model.test.mjs`, skeleton): every operation on plain, multi-run and multi-paragraph
content, surrogate pairs, `MIXED` reporting (flat and `deep`), clamping to `RANGES` without rounding, normalise
idempotence, `fromLegacy` / `legacyFont` round trip of every 0.3 font field bit for bit (including `letterSpacing: 0.5`
at `size: 7` and `lineHeight: 1.5`), `replacePlain` (two-run content, one character inserted inside run 2: both runs
survive with their styles), `scaleContent`, `nonDefaultKeys`, nested patches replacing whole values.

**Compatibility for the code that reads the flat 0.3 fields.** `TextLayer.content` (own property) is the truth.
`TextLayer` keeps two accessors on its prototype:

- `get text()` = `plainText(content)`; `set text(s)` = `content = replacePlain(content, s)`. A writer that assigns the
  whole text (the 0.3 textarea session, `ai/assistant.js`, the `doc:change` resync in `tools/text.js`) therefore keeps
  the formatting outside the span it changed; inserted characters take the style of the character before them.
- `get font()` returns a new plain object in the 0.3 `TextStyle` shape built from the first character, paragraph 0 and
  `typeOptions`: `family ← fontFamily`, `weight ← fontWeight`, `italic ← fontItalic`, `size ← size`, `color ← color`,
  `underline ← underline`, `stroke ← stroke`, `align ← para.align` (justify variants report their last-line
  alignment), `lineHeight ← leading === 'auto' ? para.justification.autoLeading / 100 : leading / size`,
  `letterSpacing ← tracking × size / 1000`, `orientation ← typeOptions.orientation` (only when not horizontal).
  Mutating the returned object changes nothing.
- `fromLegacy({ text, font })` is the exact inverse for every 0.3 layer: char `fontFamily ← family`, `fontWeight ←
  weight`, `fontItalic ← italic`, `size`, `color`, `underline`, `stroke`, `leading: 'auto'`, `tracking ←
  letterSpacing × 1000 / size` (unrounded); para `align`, `justification.autoLeading ← lineHeight × 100` (lossless:
  0.3's line height is `size × lineHeight` and stays proportional when the size changes, which auto leading does too),
  `composer: 'single'`, `breakRules: 'legacy'`; `typeOptions.orientation ← font.orientation`. Defaults are left out.
- `set font(f)` compares `f` with the current `font` and applies only the fields that differ, to the whole text
  (character fields with `applyChar(0, length)`, `align` and `lineHeight` with `applyPara`, `orientation` to
  `typeOptions`); `letterSpacing` and `lineHeight` are converted with the size being set (`f.size`). This is lossless
  for single-style layers and for `orientation`; on a mixed layer it flattens the changed attribute, so new code
  changes formatting through the model, never through `font`.
- The constructor accepts `{ content, typeOptions, height }` or the 0.3 props `{ text, font }` (through
  `fromLegacy`), so `contact-sheet.js`, `ai/assistant.js add_text`, `io.js textLayerFromPsd` and the Type tool keep
  working unchanged. `DEFAULT_TEXT_STYLE` stays exported.
- `setLayerProps(app, layer, patch)` on a text layer whose patch has `font`, `text` or `content` snapshots
  `content`, `typeOptions` and `height` before and after, so undo restores formatting exactly whatever the patch was
  (skeleton change in `layer-ops.js`). `cloneLayer`'s default branch copies own properties through JSON, so
  `content`, `typeOptions` and `height` are copied as they are.
- `image-ops.js shallow()` copies `content` by reference (it is immutable) and no longer assigns `font`;
  Image Size on a text layer uses `scaleContent` instead of building a scaled `font`.
- **First baseline.** Every engine puts the first baseline of horizontal text at `y + 0.8 × (the largest size on the
  first line)` (0.3's `ascent`) and steps by each line's leading after it; font metrics (provider) place underline,
  strikethrough, caps, super- and subscript, never the first line. So 0.3 documents, `tools/text.js beginNew`,
  `text-path.js` and the PSD writer keep their geometry whatever engine draws; code that needs a baseline reads
  `layout.lines[i].baseline` (the skeleton changes `textToPsd` to do so).
- Callers that stay on the flat fields in 0.4 and what they see: `io.js` PSD text import (one run, as 0.3) and export
  (J.8), `text-path.js` (until type-engine-core moves it to `glyphRuns`), `ai/assistant.js` (plain text), the Layers
  panel title, `actions` (none).

**Serialisation.** `Document.describe()` writes `version: 3`. A text layer is described as
`{ …common, x, y, width, height, rotation, transform, pathText, content, typeOptions, text, font }`: `text` and `font`
are the flat compatibility fields, written so that Pigment 0.3 opens a 0.4 file with the first run's style.
`readPigment` takes `content` when present, else upgrades `{ text, font }` through `fromLegacy`. A version 2 file
opens with every text layer as one run and one paragraph, `height: null`, `typeOptions.orientation` from
`font.orientation`, `composer: 'single'` and `breakRules: 'legacy'` in the paragraph style (0.3 broke lines greedily
at spaces only; the Every-line composer and UAX 14 would re-wrap old paragraphs); nothing else is rewritten until the
user edits it. History stores content objects (immutable, shared between entries).

#### B. Type facade (`lib/type/api.js`, skeleton; owned by type-engine-core afterwards) and type target (`lib/type/target.js`, skeleton; owned by type-editing afterwards)

**B.1 Structure.** `api.js` imports `document.js` and, when evaluated, sets the text backend of `document.js`
(`setTextBackend({ layout, bounds, render })`); `app.js` imports it statically and calls `attachApp(app)`.
`TextLayer.layout()`, `baseBounds()` and `renderBase()` go to the facade's displayed-layout queries, which ask
`textExtensionFor(layer)` first (text on a path and stacked text, as in 0.3), then the engine. All coordinates of the
facade are in the layer's **base space**: document coordinates before `layer.transform`, the same space as
`layer.x / y` (top-left of the box).

**B.2 API.**

```ts
// engines and plug-ins
registerEngine(engine: TextEngine): void          // engines are tried newest first; the first whose supports(layer) is true draws
setEngine(id: string | null): void                // pins one engine for every layer (tests, the smoke spec); null = automatic
engines(): string[]; currentEngine(layer?): TextEngine
registerComposer(c: Composer): void; composer(id: 'single' | 'every' | string): Composer   // unknown id: 'single'
registerBreaker(fn: (text: string, lang: string, { rules: 'standard' | 'legacy' }) => Break[]): void   // UAX 14
registerHyphenator(fn: (word: string, lang: string) => number[] | null, { languages: string[] }): void // raw positions
hyphenationLanguages(): string[]                  // BCP 47 tags some hyphenator covers (the Character panel's Language list)
registerFontProvider(p: FontProvider): void
registerKerner(mode: 'optical' | string, fn: (style, text: string, outlines: PathData[] | null) => number[] | null): void
                                             // extra advance (1/1000 em) after each cluster; null = fall back to metrics
registerListFormatter(fn: (paras: { style: ParaStyle }[], index: number) => string | null): void   // list marker text
fontsChanged(): void                         // bumps the font epoch and emits 'type:fonts-changed' (see B.4)
attachApp(app): void                         // called by app.js: app events, and the relayout of B.4

// displayed layout: a textExtensions entry first (text on a path, stacked text), then the engine
layoutText(layer): TextLayout
renderText(layer): { canvas, x, y }          // base render (no transform), used by TextLayer.renderBase
textBounds(layer): Rect                      // base bounds incl. stroke/italic/shift padding, used by TextLayer.baseBounds
hitTest(layer, x, y): { index, affinity: 'leading' | 'trailing', line: number, inside: boolean }
caretRect(layer, index, affinity = 'leading'): { x, y, height, angle, line }
                                             // (x, y) is the caret's top end; it runs `height` px in the direction
                                             // `angle` radians clockwise from straight down (0 for straight text)
selectionRects(layer, from, to): Quad[]      // Quad = { points: [[x, y], [x, y], [x, y], [x, y]] } clockwise from the top
                                             // left of the range; an axis-aligned rectangle per line for straight text

// straight layout by the engine alone: never consults an extension, so extensions consume it without recursion
shapeText(layer, { width?: number | null, height?: number | null }?): TextLayout   // default: the layer's own box
glyphRuns(layer, opts?): LayoutRun[]         // the runs of shapeText(layer, opts), every line in order (text-path, outlines)
fonts: FontProvider                          // the registered provider
```

Results are cached in a WeakMap keyed by layer on (layer.version, engine id, font epoch, options); they are never
stored on the layer object, whose own properties `cloneLayer` copies through JSON.

**B.3 Shapes.**

```ts
interface TextLayout {
  engine: string;
  frame: { width: number | null, height: number | null };   // the box: layer.width, layer.height (null: point / grows)
  width: number;                             // point text: measured; box text: the box width
  height: number;                            // a fixed box: its height; otherwise contentHeight
  contentHeight: number;                     // all lines, first top to last bottom
  overflow: boolean;                         // contentHeight > frame.height (fixed boxes only)
  ascent: number; lineHeight: number;        // of the first line (0.3 callers of layout() read these); ascent = 0.8 × size
  lines: LayoutLine[];
  // set only by textExtensions layouts, with their 0.3 meaning (tools/text.js tests `box` as a flag):
  box?: Rect; glyphs?: Glyph[]; anchor?: { x, y, angle };
}
interface Glyph { ch: string; index: number; x: number; y: number; angle: number; width: number; hidden?: boolean }
                                             // (x, y): the glyph's centre on its baseline; angle in radians (0.3)
interface LayoutLine {
  index: number; para: number;
  from: number; to: number;                  // content indices; [from, to) includes the spaces that end the line,
                                             // `to` excludes the '\n'. A line starts at a Break.at
  x: number; top: number; baseline: number;  // base space; x after alignment and indents
  width: number;                             // advance without trailing spaces (they hang); the stub: 0.3's width (below)
  height: number; ascent: number; descent: number;
  visible: boolean;                          // false beyond a fixed box height
  hyphen: boolean; last: boolean;            // ends with an inserted hyphen; last line of its paragraph
  text: string;                              // 0.3 compatibility (line.text, line.width)
  runs: LayoutRun[];
}
interface LayoutRun {
  from: number; to: number; x: number; baseline: number;   // baseline includes baseline shift and super/subscript
  advance: number; style: CharStyle /* resolved */; css: string /* CSS font */; scaleX: number; scaleY: number;
  clusters: { index: number, x: number, advance: number }[];   // one per grapheme cluster start, base space
}
type Break = { at: number, kind: 'mandatory' | 'space' | 'hyphen' | 'other' };   // a line may start at index `at`
interface TextEngine {
  id: string;
  supports(layer): boolean;                  // false: the facade tries the next engine, finally 'canvas'
  layout(layer, env: {
    composerFor(id: string): Composer;
    breaker(text: string, lang: string, { rules }): Break[];
    hyphenate(from: number, to: number): number[] | null;   // below
    width: number | null; height: number | null;           // the box to lay out in (shapeText may override the layer's)
  }): TextLayout;
  render(layer, layout): { canvas, x, y };
  hitTest?(layout, x, y); caretRect?(layout, index, affinity); selectionRects?(layout, from, to);
  // optional: the facade derives them from LayoutRun.clusters when an engine leaves them out
}
interface Composer {
  id: string; name: string;
  compose(input: {
    from: number; to: number;                      // the paragraph's content range (no '\n')
    text: string;                                  // the whole content text (index with from/to)
    lineWidth(line: number): number;               // available width of the n-th line (indents applied)
    measure(from: number, to: number): number;     // natural advance of a range set on one line (shaped, tracked, kerned)
    spaceWidth(at: number): number;                // natural width of the space at `at` (justification stretch and shrink)
    hyphenWidth(at: number): number;               // width of the hyphen a break at `at` would draw (the style at at − 1)
    breaks: Break[];                               // opportunities inside the paragraph
    hyphenate: ((from: number, to: number) => number[]) | null;   // null when the paragraph does not hyphenate
    style: ParaStyle;                              // resolved
  }): { from: number, to: number, hyphen: boolean,
        justify?: { wordSpace: number, letterSpace: number, glyphScale: number },   // extra px per space / per glyph gap, glyph scale (1 = 100 %)
        hang?: { start: number, end: number } }[];                                  // px the line extends into its margins (hanging punctuation)
}
interface FontProvider {
  available: boolean;                              // false in the stub
  metrics(style): { ascent, descent, capHeight, xHeight, underlinePosition, underlineThickness, strikePosition, strikeThickness };
  hasFeature(style, tag): boolean;
  outline(style, text): PathData | null;           // glyph outlines of a run (optical kerning, Create Work Path in 0.5)
  advances?(style, text): number[];
  addFontData?(bytes: Uint8Array, { family, postScriptName }): Promise<void>;   // a font file (tests, later type-fonts)
}
```

`hyphenate(from, to)` (the facade builds it per paragraph): the positions inside the word `[from, to)` returned by
the hyphenator for the `language` of the character at `from`, filtered by `minWord`, `before`, `after` and
`capitalized` of the paragraph's `hyphenation`; the composer applies `limit`, `zone` and `lastWord`, which need the
lines around. The engine owns measurement, applies the composer's `justify` and `hang`, places alignment, indents,
spaces, tabs (to the next multiple of `tabStop` from the line start), lists (markers from the list formatter, drawn in
the indent, not part of `text`), applies the kerner for `autoKern` modes other than `'metrics'` and `'none'`, draws a
hyphen at `hyphen` line ends, and sets `overflow`. A run whose face has no font data is the engine's business (the
HarfBuzz engine measures and draws it with Canvas). Stub kerner: none registered (optical falls back to metrics);
stub list formatter: `'•'` for bullets, `"1."` style numbering per level.

**B.4 Fonts arriving.** Font data loads asynchronously (`queryLocalFonts().blob()`, `FontFace`, the HarfBuzz wasm),
layout is synchronous. `attachApp` listens to `'type:fonts-changed'` and then calls `layer.touch()` on every text
layer of every open document (no history entry, the dirty flag unchanged) and `doc.changed('canvas')` once per
document, so `TextLayer._cache` and the compositor caches redraw with the faces that arrived. `tools/text.js
onFontsChanged` calls `fontsChanged()` (skeleton).

**B.5 Extensions and the derived queries.** A `textExtensions` entry (document.js, 0.3: `{ test, layout, baseBounds,
renderBase }`) may also implement `hitTest(layer, layout, x, y)`, `caretRect(layer, layout, index, affinity)` and
`selectionRects(layer, layout, from, to)`. When it does not, the facade derives them from `layout.glyphs`: the caret
before glyph `i` stands at its leading edge (centre − width/2 along `angle`), `font.size` tall, rotated by `angle`;
`hitTest` takes the nearest glyph centre and the side of it; `selectionRects` gives one quad per selected glyph. The
skeleton's facade implements this derivation, so type-editing's editor passes `text-color.spec.mjs:140` (click glyph 5,
caret at 4 or later) and `extras2.spec.mjs:186-194` (Home, End, Shift+End on path text) before type-engine-core lands.
`text-path.js`'s extension consumes `shapeText()` / `glyphRuns()` (type-engine-core), never `layoutText()`.

**B.6 Stub (skeleton).** The stub engine `'canvas'`, registered first, `supports()` always true, is the 0.3 fillText
path extended to runs and paragraphs: per run it sets `ctx.font` from the resolved style (weight, italic, size; caps
`'all'` upper-cases, `'small'` draws lower-case letters upper-cased at 80 %; `'super'`/`'sub'` scale and shift), draws
with `fillText` (per code point when tracking or kern is non-zero, as 0.3's `drawSpaced`), applies `scaleX`/`scaleY`
with a transform, `fauxItalic` as a −0.2 skew, `fauxBold` as a stroke of size/30, underline at 0.12 em below the
baseline with 0.3's thickness `max(1, size / 16)`, strike at 0.3 em above, the text stroke as 0.3 did. Line height is
the largest run leading on the line. It honours alignment (justify variants spread the extra width over the spaces of
every line but the last, `justify-all` over the last too), indents, space before and after, tabs, the box width
(wrapping) and height (`overflow`, hidden lines). Hit testing, carets and selection rectangles come from per-cluster
`measureText`, and the extension derivation of B.5. **Stub breaker:** exactly 0.3's: an opportunity after every
U+0020 and nowhere else (mandatory at U+2028; paragraphs end at '\n'); hyphens and CJK do not break, whatever
`breakRules` says (type-paragraph-panel's breaker adds them for `'standard'`). **Stub composer**, registered as both
`'single'` and `'every'`: 0.3's greedy first fit (a word that does not fit starts a new line; the one space at the
break is consumed; double spaces stay in the line) and no `justify`. A line's `width` and `text` are 0.3's: the line
without the one space it broke at, measured as `measureText(s) + (s.length − 1) × spacing` over UTF-16 units (no
tracking after the last character). **Stub font provider:** `available: false`, metrics from `measureText`
(`fontBoundingBoxAscent/Descent`, cap height 0.7 em, x-height 0.5 em), `hasFeature` false, `outline` null, no
`addFontData`. **Requirement:** for content with one run and one paragraph style (every 0.3 layer), the stub draws
exactly what 0.3 drew (same `ctx.font`, calls, positions and underline rectangle); the skeleton's smoke spec pins
`setEngine('canvas')` and compares it with 0.3's algorithm copied into the spec. `tools/text.js textBox()`,
`hitBoxHandle()` and `caretIndex()` keep working on the stub layout (they read `box` only from extension layouts, and
`lines[i].text`, `width`, `lineHeight`, `height`).

**B.7 Type target (`lib/type/target.js`).** What the Character and Paragraph panels, the Properties type sections, the
options bar and the type commands act on:

```ts
setSelectionProvider(p: { active(app): null | TypeSession }): void   // installed by the Type tool's editor (type-editing)
interface TypeSession {
  layer: TextLayer; from: number; to: number; insertionStyle: CharStyle;
  edit(fn: (content, from, to) => { content, from, to, typeOptions?, width?, height? }, { label, merge }): void;
  setInsertionStyle(patch): void;
}
selectionChanged(app): void                 // the provider calls it whenever the selection or the insertion style changes:
                                            // emits 'type:selection' { layer, from, to } (panels and Properties re-read,
                                            // the Properties host at most once per frame)
typeTargets(app): { editing: boolean, layers: TextLayer[], layer: TextLayer | null, from: number | null, to: number | null }
                                            // editing: the session's layer and selection; else every selected,
                                            // unlocked text layer, whole text (from/to null)
readChar(app, { deep }?): { [k]: value | MIXED }   // the selection, the caret's insertion style, or the targeted layers
readPara(app, { deep }?): { [k]: value | MIXED }
applyChar(app, patch, { label = 'Character', merge = false })   // caret: insertion style; range: session edit;
applyPara(app, patch, { label = 'Paragraph', merge = false })   // layers: below
applyTypeOptions(app, patch: Partial<TypeOptions>, { label = 'Type Options' })   // orientation, antiAlias, systemLayout
applyBox(app, { width?, height? }, { label = 'Text Box' })      // point <-> paragraph text, box size
typeDefaults(app): { char: CharStyle, para: ParaStyle }          // what new text starts with (below)
setTypeDefaults(app, { char?, para? })
```

While editing, all four apply functions go through the session's `edit` (one session undo step; the commit is one
history entry). Otherwise, on one layer, `applyChar` / `applyPara` call `setLayerProps(…, { content }, label, { merge })`
and `applyTypeOptions` / `applyBox` `setLayerProps` with `typeOptions` or `width`/`height`; on several layers they push
one history entry whose `mergeKey` is 0.3's `text:${ids.join('+')}:${keys}` and merge with the previous entry within
1.5 s when `merge` is set (as 0.3's `TypeTool.applyFont`: `hunt2.spec.mjs` "font changes on several text layers merge"
keeps passing).

**Defaults for new text.** The type tools' options are the store for what the options bar shows: family, style, size,
align and colour (colour follows the foreground colour, as in 0.3). `settings.type.char` / `.para` store only the
attributes the options bar does not have. `typeDefaults` merges model defaults ← `settings.type` ← tool options;
`setTypeDefaults` writes the options-bar attributes through `app.tools.setOpt` on both type tools and the rest into
`settings.type`.

**Stub (skeleton).** The skeleton's provider wraps today's textarea session: `from`/`to` are the textarea selection,
`edit` replaces the content (and `typeOptions`, `width`, `height` when returned) and re-syncs the textarea value,
`insertionStyle` is the style at the caret, and `selectionChanged` runs on the textarea's `select`, `keyup`,
`pointerup` and `input` events. So the panels can be built against `target.js` before the new editor lands.

**B.8 The stable `tools/text.js` surface and the type session (type-editing).** Through 0.4 `tools/text.js` keeps
exporting `FALLBACK_FONTS`, `fontFamilies`, `onFontsChanged`, `loadSystemFonts`, `STYLES`, `styleOf`, `styleToFont`,
`textTargets`, `typeSession` and `applyTypeStyle` (`character.js` and `app.js` import them). `typeSession(app)` returns
the type tool whose `session` is `{ layer, doc, isNew, textarea }`, where `textarea` is the editor's hidden
`<textarea>`: its `value` is the plain text and its `selectionStart`, `selectionEnd` and `selectionDirection` mirror the
editor selection in content indices (`extras2.spec.mjs` and `text-color.spec.mjs` read them). `applyTypeStyle(app,
patch, opts)` maps the 0.3 font patch to `target.applyChar` / `applyPara` with the same merge rule.

type-editing replaces the skeleton's `'type'` session entry (E) with:

```ts
app.sessions.register({ id: 'type', policy: 'commit', label: 'Type', active: () => !!editor.session,
  ownsFocus: (el) => el === editor.input,          // app.isTextTarget() is false for it: Edit > Undo reaches the session
  allow: /^(view:|window:|help:|app:|type:|text:orientation$)/,
  handle, commit: () => editor.commit(), cancel: () => editor.cancel(), onClose: 'commit' })
```

`handle(id, arg, source)` answers, in this order: (1) `UNDO_LIKE` ids with the session's undo / redo, and `edit:cut`,
`edit:copy`, `edit:paste`, `edit:paste-without-formatting`, `select:all`, `edit:clear` with the editor's own
operations (so neither `app.js` nor `edit-ops.js` changes for type); (2) for source `'key'` or `'menu-key'`, an id with
`typeKeyFor(id)` (M.4: Shift+Ctrl+L Auto Tone, Shift+Ctrl+C Copy Merged, Shift+Ctrl+R Lens Correction, Shift+Ctrl+J
Layer via Cut, Shift+Ctrl+B Auto Color, Shift+Ctrl+I Inverse, Shift+Ctrl+U Desaturate, Shift+Ctrl+X Liquify, Ctrl+H
Extras) runs that type command instead; (3) any id the editor's own key handler already ran within the last 40 ms is
swallowed (Windows and Linux deliver an accelerator to the page and to the menu). A mouse click in the menu (source
`'menu'`) is not answered: the commit policy commits the text as one entry and the command runs (Photoshop greys most
items while text is edited; Pigment commits instead). Observers learn that the session answered (`after(…, {
handledBy: 'type' })`), so the actions recorder does not record Auto Tone for Shift+Ctrl+L.

`edit:paste-without-formatting` from the menu has no DOM paste event: it reads the system clipboard with
`bridge.readClipboardText()` (O).

#### C. Preset store (`lib/presets.js`, skeleton; owned by the skeleton, no package edits it)

Named presets per kind, in groups, kept as files under `<userData>/presets/`, never in settings.json. The store core
is pure (a backend object is injected), so it is unit-tested in Node with a memory backend.

```ts
interface Preset { id: string; name: string; group: string | null; data: any; builtin: boolean; modified?: boolean }
interface PresetGroup { id: string; name: string; parent: string | null; builtin: boolean }
registerPresetKind(kind: string, def: {
  title: string; version: number;
  builtins(): { groups?: PresetGroup[], presets: { id, name, group?, data }[] };   // ids stable across releases
  normalize(data, { version }): any | null;       // upgrade older data, null drops an invalid entry
  thumbnail?(preset, size: number): HTMLCanvasElement;
  blobs?(data): string[];                          // names of the binary side files the data refers to
}): void
registerPresetFormat(kind | '*', fmt: { id, name, extensions: string[],
  read(bytes: Uint8Array, { name }): Promise<{ presets: { name, group?, data }[], groups?: PresetGroup[], report: string[] }>,
  write?(presets: Preset[], { kind }): Promise<Uint8Array> }): void

class PresetStore extends EventTarget {
  constructor({ backend, onWriteError })
  ready(kind): Promise<void>                      // loads the kind's file once
  list(kind, { group? }): Preset[]                // synchronous: built-ins until ready() resolved
  groups(kind): PresetGroup[]
  get(kind, id): Preset | null
  add(kind, { name, data, group? }): Preset       // id 'u-' + random
  update(kind, id, { name?, data?, group? }): Preset    // updating a built-in stores a modified copy under its id
  remove(kind, ids: string | string[]): void            // removing a built-in hides it
  move(kind, id, { group, index }): void
  addGroup(kind, { name, parent? }): PresetGroup; renameGroup(kind, id, name); removeGroup(kind, id, { keepPresets })
  reset(kind): void                               // back to the built-ins (the user file is deleted)
  readBlob(kind, name): Promise<Uint8Array | null>; writeBlob(kind, name, bytes): Promise<void>
  importFile(kind, bytes, { name }): Promise<{ added: Preset[], report: string[] }>   // format chosen by extension
  exportFile(kind, ids, formatId): Promise<{ bytes: Uint8Array, ext: string }>
  flush(): Promise<void>                          // writes pending changes (before-close)
  // events (also re-emitted on app as 'presets:changed'): 'change' { kind, reason: 'load'|'add'|'update'|'remove'|'move'|'group'|'reset'|'import', ids }
}
app.presets: PresetStore                          // created in start() before MODULES
```

File format (`<userData>/presets/<kind>.json`, `:` in a kind becomes `__`): `{ format: 'pigment-presets', version: 1,
kind, kindVersion, groups: PresetGroup[] (user groups, and built-in groups that were renamed), items: ({ ref: builtinId }
| Preset)[] (order), hidden: builtinId[] }`. Built-ins not mentioned and not hidden are appended to their group on load,
so later releases can add built-ins. Built-ins are never written until something changes. Binary data (pattern
pixels) goes in side files `<userData>/presets/<kind>/<name>` through `writeBlob`. Writes are debounced 300 ms per
kind; `app.presets.flush()` runs in the before-close handler. A failed write calls `app.reportWriteFailure('presets',
err)` (see N) and keeps the in-memory state. The built-in format `pigment-presets` (`.pigment-presets`, JSON, blobs as
base64) is registered for every kind (`'*'`). `.grd`, `.pat`, `.asl`, `.abr` and the others are registered by later
packages (preset-files-manager in 0.5); in 0.4 adjust-tonal and adjust-color register the adjustment formats.

Kinds and their `data` in 0.4 (the skeleton registers every kind with the built-ins that exist today; the owner
re-registers its kind with the full definition):

| Kind | `data` | Built-ins from the skeleton | Owner |
|---|---|---|---|
| `gradients` | `GradientDef` (G.1; the only stored data besides tool options where `{ ref }` stops are allowed) | the eight `GRADIENT_PRESETS` of `tools/fill.js`, upgraded (`'fgbg'`/`'fgt'` become stops with `{ ref: 'fg' }`/`{ ref: 'bg' }`) | gradients |
| `patterns` | `{ width, height, blob: '<id>.png', mode: 'rgb' }` | none | patterns |
| `contours` | `Contour` (J.6) | `Linear` | layer-style-effects |
| `styles` | `{ styles: LayerStyles, blending?: { opacity, fillOpacity, blend, blending } }` | none (Styles panel in 0.5) | presets-panels (0.5) |
| `adjustment:<kind>` | the kind's params | none | adjust-tonal (Levels, Curves, Exposure, Brightness/Contrast, Threshold), adjust-color (the others) |
| `shapes` | `{ path: PathData in a 0..1 box }` | `CUSTOM_SHAPES` of `tools/vector.js` | presets-panels (0.5); shapes-live reads |
| `stroke-styles` | `{ dash: number[] (in stroke widths), cap, join, align }` | Photoshop's three (solid, dashed, dotted) | shapes-live |
| `tool-presets` | `{ tool, options }` | none | presets-panels (0.5) |

IPC (`src/main/ipc.js`, `src/preload.cjs` as `pigment.presets.*`, channels `pigment:presets<Method>`):
`read(kind) -> json | null` (a corrupt file is renamed `.corrupt-<time>` and null returned), `write(kind, json)`
(atomic, as `JsonStore`), `readBlob(kind, name) -> Uint8Array | null`, `writeBlob(kind, name, bytes)`,
`removeBlob(kind, name)`. `kind` must match `/^[a-z][a-z0-9-]*(:[a-z0-9-]+)?$/` and `name`
`/^[A-Za-z0-9._-]{1,128}$/`; anything else rejects. The browser bridge implements the same five methods on IndexedDB
(database `pigment-presets`, stores `files` and `blobs`); when `window.__pigmentTest.presets` is an object the browser
backend reads and writes it instead (specs seed and assert it), and `__pigmentTest.failPresetWrite = 'quota'` makes
writes fail.

#### D. Document store (`lib/doc-store.js`, skeleton; owned by the skeleton)

History-aware document-level collections saved in `.pigment`. Pure (it reaches history through `doc.history.push`).

```ts
registerCollection(name: string, spec: {
  kind: 'list' | 'value';
  version: number;
  initial(): any;                                  // [] or the default value
  normalize(item | value): item | value | null;    // list items get `id` (newId('S')) when missing; null drops
  transform?(current, m: Matrix /* old -> new document */, spec: { width, height, mode }): any;   // Image Size,
                                                   // Canvas Size, Rotate/Flip Canvas, Crop, Perspective Crop
  save?: boolean;                                  // default true; false = never written to .pigment
  read?(json, { version }): any; write?(value): any;   // default: JSON clone
  label?: string;                                  // default history label prefix
}): void
class DocStore {
  get(name): readonly item[] | value               // frozen: a mutation throws instead of corrupting the store
  set(name, next, { label, merge = false }): void  // one undoable entry; merge folds consecutive sets of the same
                                                   // collection within 1.5 s into one entry (guide drags)
  setRaw(name, next): void                         // no history: for use inside another entry (structural, remap)
  add(name, item, { label }): item; update(name, id, patch, { label, merge }); remove(name, ids, { label })
  snapshot(): object; restore(snapshot): void      // structural() records the whole store
  transformAll(m, spec): void                      // remapDocument calls it inside its own entry
  clone(doc: Document): DocStore                   // Image > Duplicate
  toJSON(): { [name]: { v: number, data: any } }
  static fromJSON(doc, json | undefined, legacy: { guides? }): DocStore
}
```

Every change emits `doc.changed('store', { collection: name })`; the `guides` collection also emits the 0.3 kind
`'guides'`. `Document` gets `store` in its constructor and a `guides` accessor: `get guides()` returns
`store.get('guides')` (a frozen array), `set guides(list)` calls `store.setRaw('guides', list)` (normalised: ids
added). So the 0.3 code that reads and assigns `doc.guides` (app.js `addGuide` and `view:clear-guides`, image-ops
`remapDocument` and Image > Duplicate, modes.js, perspective-crop.js, smart-object.js, layer-ops `structural`,
actions.js frames, canvas-view, move.js) keeps working unchanged; nothing in `src` mutates the array in place (checked), and the one spec line that does,
`files.spec.mjs:44`, changes (M.8). The skeleton moves `structural()` to
`store.snapshot()/restore()` and `remapDocument` to `transformAll`.

**Collections nobody registered** (a 0.5 file with `comps` or `slices` opened in 0.4): `fromJSON` keeps their JSON
verbatim, `toJSON` writes it back unchanged, `transformAll`, `snapshot` and `clone` carry it as it is, and a later
`registerCollection` of that name takes it over through its `read`. So saving a newer file in 0.4 loses nothing.

**Guides** (registered by the skeleton): list of `{ id, axis: 'x' | 'y', pos: number (document px, fractional
allowed), color?: '#rrggbb' (absent = the preference colour), artboard?: string (layer id, 0.9) }`: optional fields
are stored only when set, so a 0.3 guide stays `{ id, axis, pos }`. `transform` is 0.3's `mapGuide` (guides that
become oblique are dropped). Selected guides are view state (`view.selectedGuides`, guides-snapping), not stored.
Migration: a version 2 file's top-level `guides` array is normalised into the collection (ids added); version 3 writes
`store` and also the top-level `guides` array (`{ axis, pos }` only) for 0.3 readers. **`rulerOrigin`** (registered
by the skeleton so the stub period depends on no rule above): `kind: 'value'`, `{ x: 0, y: 0 }` (document px),
`transform` maps the point; guides-snapping writes it. Names reserved for later collections: `colorSamplers` (0.7),
`comps` (0.8), `notes`, `counts`, `measurementScale`, `variables`, `dataSets` (0.9), `slices` (0.10), `charStyles`,
`paraStyles` (0.7), `patterns` (document patterns deduplicated by hash, when a later release stops embedding a data URL
per use, L.6).

#### E. Session registry (`lib/sessions.js`), command observers and definition flags (`lib/commands.js`) (skeleton; owned by the skeleton)

In 0.3 four modules replace `app.commands.run` on the instance: `blur-gallery-ui.js install()`,
`content-aware-scale.js install()` and `select-mask/workspace.js installWorkspace()` to guard their on-canvas
sessions, and `actions.js wrapCommands()` to know which commands are running. `commands.js` itself holds two more
session rules (the Free Transform commit and the `app.busy` gate), the three session modules each register a
`bridge.on('before-close')` listener to cancel themselves, and each throttles its own "Finish … first" toast. The
registry replaces all of it; after the skeleton nothing assigns `app.commands.run`.

```ts
app.sessions: SessionRegistry                       // created in the App constructor
interface SessionSpec {
  id: string;                                       // 'blur-gallery', 'content-aware-scale', 'select-mask', 'transform', 'type', 'busy', …
  label: string | (() => string);                   // used in the hint
  policy: 'modal' | 'commit' | 'busy' | 'observe';
  active?: () => boolean;                           // the session counts only while true (default: while registered/begun)
  allow?: RegExp | ((id, arg, source) => boolean);  // commands that run normally while it is active; a RegExp never admits
                                                    // a command defined with changesDocument (a function decides itself)
  handle?: (id, arg, source) => undefined | { result?: any };   // commands it answers itself (return an object = handled)
  hint?: string | false;                            // default `Finish ${label} first: Enter applies it, Esc cancels`
  sources?: Set<string>;                            // 'busy' only: sources it refuses (default: GESTURE_SOURCES)
  commit?(): void;                                  // 'commit' only: what another command triggers first
  cancel?(reason: 'close' | 'undo' | 'api'): void | Promise<void>;
  undo?(): boolean; redo?(): boolean;               // 'observe' sessions: claim Edit > Undo / Redo (true = handled)
  ownsFocus?(el: Element): boolean;                 // the session's own input (app.isTextTarget() answers false for it)
  onClose?: 'cancel' | 'commit' | 'keep';           // window close (default 'cancel' for modal and commit, 'keep' otherwise)
}
register(spec): () => void        // permanent entry gated by spec.active (0.3 sessions are migrated this way)
begin(spec): { end(): void }      // temporary entry (busy, new 0.4 sessions)
list(): SessionSpec[]             // active entries, newest last
guardModal(id, arg, source): { refused } | { handled, by, result } | null
guardBusy(id, source): { refused } | null
commitBefore(id): { cancelled } | null     // 'commit' sessions: undo-like ids cancel, others commit
undo(): boolean; redo(): boolean           // 'observe' sessions, newest first
ownsFocus(el): boolean                     // some active session owns el
cancelAll(reason = 'close'): Promise<void> // every active session: onClose 'cancel' cancels, 'commit' commits
UNDO_LIKE = /^edit:(undo|redo|step-backward|step-forward|toggle-last-state)$/   // exported; a def with undoLike counts too
app.busyDepth                              // getter: number of active 'busy' sessions (0.3 compatibility)

app.commands.observe({ before(id, arg, source): token,
                       after(token, result, { handledBy: string | null, refused: boolean }) }): () => void
```

**Definition flags (E31).** `CommandRegistry.register(id, def)` accepts, besides 0.3's `run`, `enabled`, `checked`,
`label` and `dialog`:

- `changesDocument: true`: the command changes the document although its group says otherwise (`view:` guide
  commands). It is refused while a busy session runs (`SAFE_WHILE_BUSY` does not admit it), a modal session's RegExp
  `allow` does not admit it, and the actions recorder records it with its argument (as `RECORDED_ANYWAY` does today).
- `record: false`: actions never record it (`edit:search`, `layer:collapse-all-groups`, `layer:panel-options`);
  `record: true` always (the flag wins over `IGNORED_GROUPS` and `IGNORED_COMMANDS`, which stay for the 0.3 ids).
- `undoLike: true`: treated like Edit > Undo: a 'commit' session cancels instead of committing, the recorder follows it
  like an undo (`followUndo`) and never records it.

`ctx.setReplayCommand(id, arg)` (next to 0.3's `setReplayArg`): the command did what `id` with `arg` does, and
`command:done` carries `{ replayId, replayArg }`; the recorder stores that step instead (`layer:merge` records
`layer:merge-down`, `layer:merge-selected` or `layer:merge-group`).

**Sources.** `'menu'` (a mouse click in the native menu), `'menu-key'` (a native menu accelerator:
`triggeredByAccelerator`, O), `'key'` (shortcuts.js), `'toolbar'`, `'panel'`, `'drop'`, `'api'`, `'action'`,
`'assistant'`. `GESTURE_SOURCES` is `menu`, `menu-key`, `key`, `toolbar`, `panel`.

**Order inside `CommandRegistry.run(id, arg, source)`** (the 0.3 order of wrappers and checks, kept exactly):
1. every observer's `before` (in 0.3 the actions wrapper was the outermost); `after(token, result, info)` is called with
   whatever `run` returns (a promise or a value; the observer waits for a promise itself) and also when run returns
   early (`info.handledBy` names the session that answered, `info.refused` is true when a guard refused);
2. `sessions.guardModal`: active sessions, newest first: an id the session's `handle` answers (any policy) returns
   the handler's result; for a modal session an allowed id passes to the next session, anything else is refused
   (returns `undefined`) and the hint is shown when `source !== 'api'`, at most once every 2.5 s across all sessions;
3. unknown id → warning; de-duplication (unchanged); a `'menu'` or `'menu-key'` command while a dialog is open is
   ignored unless `app.dialogs.passesMenu?.(id)` answers true (stub: false, 0.3's rule; conventions-shortcuts-fields
   lets view navigation through under its movable dialogs, so Cmd+= works on macOS where the menu takes the key);
4. `sessions.guardBusy` (the 0.3 busy rule: gesture sources refused while a busy session is active and no dialog is
   open, `SAFE_WHILE_BUSY` allowed unless the def has `changesDocument`, toast "Pigment is still working: try again
   when it has finished" at most every 2.5 s);
5. `sessions.commitBefore` (the 0.3 Free Transform rule; `UNDO_LIKE` ids and `undoLike` defs cancel);
6. `isEnabled`, then the command, then `command:done` (unchanged, plus `replayId` / `replayArg`).

**Edit > Undo.** `app.isTextTarget(el = document.activeElement)` is 0.3's `isTextTarget` test and false for an element
some active session owns. `app.historyStep(dir: 'undo' | 'redo' | { goTo: number })`: a text target → native undo or
redo (`bridge.nativeEdit`); else `app.sessions.undo()` / `redo()`; else, for undo, `app.tools.active.cancel()` when it
returns true; else the document history. `edit:undo` and `edit:redo` are `app.historyStep('undo' | 'redo')`;
conventions' `edit:toggle-last-state` calls it with the direction that toggles.

**Migration, one by one** (behaviour identical; the existing specs `blur-gallery`, `content-aware-lens`,
`select-mask`, `actions`, `hunt4-sessions` and `hunt4-review-sessions` must pass after each step):

| 0.3 code | Becomes |
|---|---|
| `blur-gallery-ui.js`: wrapper refusing all but `SAFE_COMMANDS` (`/^(view:(?!next-tab\|prev-tab)\|help:\|app:escape$\|app:enter$)/`) while `tool.session && !tool.ending`, hint "Finish {def.name} first…"; `bridge.on('before-close', () => tool.cancel())` | `app.sessions.register({ id: 'blur-gallery', policy: 'modal', label: () => tool.session.def.name, active: () => !!tool.session && !tool.ending, allow: SAFE_COMMANDS, cancel: () => tool.cancel() })`; wrapper and listener deleted |
| `content-aware-scale.js`: wrapper with `SAFE_COMMANDS` including `window:`, active while `tool.session && !tool.ending && !tool.committing`, undo/redo/step ids cancel the scale; listener | `register({ id: 'content-aware-scale', policy: 'modal', label: LABEL, active, allow: SAFE_COMMANDS, handle: (id) => UNDO_LIKE.test(id) ? (tool.cancel(), {}) : undefined, cancel: () => tool.cancel() })` |
| `select-mask/workspace.js`: wrapper: undo/step-backward → `tool.undo()`, redo/step-forward → `tool.redo()`, `select:all/none/inverse` → `selectAll/clear/invert`, others refused; listener cancels with `{ force: true }` | `register({ id: 'select-mask', policy: 'modal', label: LABEL, active: () => !!tool.session && !tool.ending, allow: SAFE_COMMANDS, handle: <the same five mappings, plus edit:toggle-last-state → tool.undo()>, cancel: () => tool.cancel({ force: true }) })` |
| `actions.js wrapCommands()`: frames pushed before `base(id, arg, source)` (skipping `TRANSPARENT` ids and unknown ids), `hadTransform` read before the run, released when the result settles | `app.commands.observe({ before, after })` with the same body; `before` returns the frame (or null for skipped ids); `after` releases it and drops it when `handledBy` is set or `refused` |
| `commands.js`: `SAFE_DURING_TRANSFORM` and `tt.commit()` / `tt.cancel()` | `image-ops.js` install: `register({ id: 'transform', policy: 'commit', label: 'Free Transform', active: () => !!tt.session && !tt.committing, allow: SAFE_DURING_TRANSFORM, commit: () => tt.commit(), cancel: () => tt.cancel() })`; undo-like ids cancel instead of committing |
| `app.busy(label, fn, { gate })` and `busyDepth` | with `gate`, `const s = this.sessions.begin({ id: 'busy', policy: 'busy', label, allow: SAFE_WHILE_BUSY, onClose: 'keep' })`, `s.end()` in `finally`; `busyDepth` a getter |
| `app.js edit:undo/redo` asking `typeSession(app)` for the textarea | `tools/text.js` install: `register({ id: 'type', policy: 'observe', label: 'Type', active: () => !!typeSession(app), undo: () => { focus the textarea; bridge.nativeEdit('undo'); return true }, redo: …, onClose: 'keep' })`; `edit:undo` / `edit:redo` become `app.historyStep()` (0.3 order: text field native, session, tool cancel, history). type-editing replaces this entry (B.8) |
| `app.js` before-close: dialogs dismissed (0.3.1: before the first save), the three module listeners cancel their sessions | the handler calls `await app.sessions.cancelAll('close')` first (where the module listeners acted in 0.3), then `await app.presets.flush()`, then the 0.3.1 dialog and save logic unchanged |

New 0.4 sessions (the Type tool editor, the gradient widget on canvas, guide drags, style drag on canvas, the adjust
frame's armed eyedroppers) use `begin()` or `register()` as they need.

#### F. Snap hook (`lib/snap.js`, stub by the skeleton; owned by guides-snapping)

```ts
app.snap.point(p: { x, y }, opts: SnapOpts): { x, y, snapped: { x: SnapTarget | null, y: SnapTarget | null } }
app.snap.box(rect: Rect, opts: SnapOpts): { dx, dy, snapped }   // the offset to add so an edge or centre of rect meets a target
app.snap.end(): void                                            // a gesture ended: smart-guide overlays go away
app.snap.registerTargets(id, provider: (doc, query: { source, exclude, excludeGuides, axis }) => { x: SnapTarget[], y: SnapTarget[] }): void
type SnapOpts = {
  source: SnapSource;
  pointer?: PointerInfo;        // the tool's normalised pointer event (x, y, shift, alt, ctrl, meta, temporary, …)
  exclude?: Layer[];            // layers whose own bounds are not targets (the layers being moved, transformed or drawn)
  excludeGuides?: string[];     // guide ids that are not targets (the guide being dragged)
  axis?: 'x' | 'y';             // snap along one axis only (Shift-constrained drags, a guide's own axis)
  view?: CanvasView;
}
type SnapTarget = { pos: number, kind: 'document' | 'guide' | 'grid' | 'layer' | 'artboard' | 'slice' | 'pixel', id?: string }
type SnapSource = 'move' | 'marquee' | 'crop' | 'perspective-crop' | 'shape' | 'pen' | 'path' | 'transform' | 'guide' | 'type-box' | 'gradient' | 'slice'
```

Tolerance is 6 screen pixels (`6 / view.zoom` document px). Nothing snaps when `settings.snap === false`, or when
`pointer.ctrl || pointer.meta` (Ctrl/Cmd held during a drag disables snapping), except that the modifier which summoned
a temporary tool does not count (`pointer.temporary === 'ctrl'` ignores Ctrl/Cmd). `snap.js` derives this from
`pointer`; no call site computes it. `canvas-view.js` (guides-snapping) sets `p.temporary` on every pointer event it
routes to `view.tempTool`: `view.tempToolVia` (`'ctrl' | 'alt' | 'space' | 'key'`, set by conventions' temp-tools.js
with `tempTool`), else null; it calls `app.snap.end()` after every pointerup or pointercancel it routes and on
`'tool:changed'`. No call site calls `end()`.

**Call sites** (one call each, placed by the skeleton and marked `// snap (lib/snap.js)`; rule 10):

| File (owner) | Gesture | `source` | `exclude` / `excludeGuides` | `axis` |
|---|---|---|---|---|
| `tools/move.js` MoveTool (guides-snapping) | layer drag (replaces `snapDelta`/`snapDelta2`, deleted) | `'move'` | the layers being moved | the constrained axis with Shift |
| `tools/move.js` CropTool (guides-snapping) | box handles and box move | `'crop'` | | |
| `tools/select.js` (skeleton) | marquee start and current corner | `'marquee'` | | |
| `tools/perspective-crop.js` (skeleton) | corners | `'perspective-crop'` | | |
| `tools/vector.js` (shapes-live) | shape drag start and end; pen anchor placement; path-selection drags | `'shape'`, `'pen'`, `'path'` | the shape layer being drawn or edited | the constrained axis with Shift |
| `image-ops.js` TransformTool (skeleton) | handle drags, box move | `'transform'` | the transformed layers | |
| `canvas-view.js` (guides-snapping) | guide drag from a ruler, moving a guide | `'guide'` | the dragged guide | the guide's axis |
| `tools/text.js` (type-editing) | paragraph box drag and box handles | `'type-box'` | the text layer | |
| `tools/fill.js` (gradients) | gradient end points, the live-gradient widget | `'gradient'` | | |

**Stub (skeleton):** `box()` with `source: 'move'` is exactly 0.3's `MoveTool.snapDelta` (targets: document left /
centre / right and top / middle / bottom, and the guides; x first, then y; deltas rounded); every other call returns
its input unchanged (`point` → same point, `box` → `{ dx: 0, dy: 0 }`), so no 0.3 behaviour changes. Built-in target
providers `'document'` and `'guides'`. guides-snapping implements the real answers for every source with the View >
Snap To settings, Smart Guides and measurement overlays, and adds the `'grid'` and `'layer'` providers; later packages
add `'artboard'` and `'slice'`.

#### G. Gradient model, paints and paint editors

**G.1 Model (`src/shared/pixels/gradient-model.js`, skeleton; owned by gradients afterwards).** Pure, shared by
the renderer, `styles.js` (Gradient Overlay, stroke and glow gradients), `adjust-color.js` and `deep.js` (Gradient
Map) and Node tests.

```ts
interface GradientDef {
  gradientVersion: 2;
  type: 'solid' | 'noise';
  interpolation: 'classic' | 'perceptual' | 'linear' | 'smooth' | 'stripes';
  smoothness: number;                                        // 0..1
  stops: { pos: number, mid: number /* 0.05..0.95, default 0.5 */, color: '#rrggbb' | { ref: 'fg' | 'bg' } }[];
  opacityStops: { pos: number, mid: number, opacity: number /* 0..1 */ }[];
  noise?: { roughness: number /* 0..1 */, model: 'rgb' | 'hsb' | 'lab', min: [number, number, number], max: [number, number, number] /* 0..1 */, restrict: boolean, transparency: boolean, seed: number };
}
interface GradientPlacement {        // one shape for every use
  kind: 'linear' | 'radial' | 'angle' | 'reflected' | 'diamond' | 'shape-burst' /* the Stroke effect only */;
  angle?: number;                    // degrees, default 90
  scale?: number;                    // a fraction, 1 = 100 % (0.3's Gradient Overlay and PatternPaint convention)
  offset?: [number, number];         // percent of the box, default [0, 0]
  align?: boolean;                   // Align with Layer, default true
  reverse?: boolean; dither?: boolean;
  from?: [x, y]; to?: [x, y];        // document coordinates, fill layers and the Gradient tool only; when present they
                                     // win over angle / scale / offset
}
GRADIENT_DEFAULTS: GradientDef                         // black to white, perceptual, smoothness 1 (Photoshop's new gradient)
normalizeGradient(any, { fg?, bg? }?): GradientDef     // accepts every 0.3 shape (below) and v2; never throws; with fg/bg
                                                       // it resolves every { ref } to #rrggbb; without, fg -> #000000 and
                                                       // bg -> #ffffff
isGradientV2(g): boolean
gradientLut(def, { fg, bg, reverse = false, size = 1024 }): Uint8ClampedArray   // straight RGBA, size entries
sampleGradient(def, t, { fg, bg }): [r, g, b, a]       // the reference sampler; a 0..1
gradientT(placement, x, y, box: Rect): number          // the parameter t of a point for the five kinds (reference)
```

**Where placement lives.** Fill layers and the tool: `Paint.gradient` is `GradientDef & GradientPlacement` (0.3's
flat shape, from/to included). Gradient Overlay and the Stroke effect's gradient fill: the placement fields sit flat on
the effect object under exactly these names, next to `gradient: GradientDef` (0.3's `kind`, `angle`, `scale: 1`,
`reverse` are already there). Glow gradients and Gradient Map: the def only (plus `reverse`, `dither` for Gradient Map).

**Colour references** (`{ ref: 'fg' | 'bg' }`) are allowed only in presets and tool options. Every writer of layer or
document data resolves them first with `normalizeGradient(def, { fg, bg })`: the `gradient` widget's `onInput` and
`onChange`, `createPaint`, the Gradient tool's drag, the Gradient Map and Gradient Overlay forms. Stored data therefore
renders the same when the foreground colour changes later, and in pure modules that have no colours to resolve with.

0.3 shapes and their upgrade (`normalizeGradient`): the tool's `{ kind, stops: [{ pos, color (#rrggbb or
#rrggbbaa) }], from, to, reverse }`, fill layers' `paint.gradient` (same), Gradient Map params `{ stops: [{ offset,
color }], reverse }` (also `position`, `[offset, color]` pairs, as `adjust.js gradientLuts` accepts today) and
Gradient Overlay `{ stops: [{ pos, color, opacity? }], kind, angle, scale, reverse }`. Each old stop gives a colour
stop (`#rrggbb`, `mid 0.5`) and an opacity stop at the same position (`alpha × (opacity ?? 1)`), with `interpolation:
'classic'` and `smoothness: 0`, which is exactly 0.3's linear interpolation. Placement fields stay where they are.
Upgrades are lazy: readers normalise on use (renderers, `adjust.js`, `styles.js`, `deep.js`, `io.js` PSD adjustment
export), and writers write v2 only when the user edits. So 0.3 files render identically and the v2 stops keep `pos` and
`color` (Pigment 0.3 still reads colours from a 0.4 file).

**Reference sampler (skeleton):** `'classic'`: colour and opacity interpolated separately and linearly in sRGB
between stops, the midpoint bending the local parameter `u` to `u' = u ^ (ln 0.5 / ln mid)`, smoothness `s` blending
`u'` with `u' * u' * (3 − 2u')` by `s`; `{ ref }` resolved as above. The other interpolations fall back to
`'classic'`, and `type: 'noise'` to a classic ramp from `min` to `max` (in the given model), until the gradients
package defines them (perceptual = Oklab, linear = linear-light sRGB, smooth, stripes = no blend) in this file. Unit
tests (`tests/unit/gradient-model.test.mjs`): every 0.3 shape upgrades and its LUT equals 0.3's (`gradientLuts` and the
styles `gradientLut`) within ±1; midpoints, opacity stops, `gradientT` for the five kinds at known points; a preset with
refs resolved with `{ fg, bg }` holds only hex colours, and without them maps fg to black and bg to white.

**G.2 Paint** (shared type; fill layers, shape fill and stroke, Fill dialog):

```ts
type Paint = null                                          // shapes: no fill / no stroke
  | { type: 'solid', color: '#rrggbb' }
  | { type: 'gradient', gradient: GradientDef & GradientPlacement }
  | { type: 'pattern', pattern: PatternPaint };
interface PatternPaint {
  canvas: HTMLCanvasElement;      // runtime; fill layers save it as patterns/<layerId>.png (as 0.3)
  scale: number;                  // 1 = 100 %
  angle?: number;                 // degrees, default 0 (patterns)
  link?: boolean;                 // Link with Layer, default true
  origin?: [number, number];      // Snap to Origin offset, default [0, 0]
  presetId?: string; name?: string;   // provenance only
}
```

**G.3 Paint renderers (`lib/paint.js`, skeleton).**

```ts
registerPaintRenderer(type, fn: (ctx, paint, box: Rect, opts: { origin: [number, number], layer?, doc? }) => CanvasGradient | CanvasPattern | string)
paintStyle(ctx, paint, box, opts)                     // dispatches
```

`box` is the rectangle placement is measured against (angle, scale, offset, Align with Layer), given in ctx space;
`origin` is the document position of ctx's (0, 0). Document-space `from` / `to` are mapped into ctx space by
subtracting `origin`. Fill layers: `box` = the document, `origin` = `[0, 0]` (0.3). Shapes: `box` = the path bounds
without stroke padding, in the render canvas, and `origin` = that canvas's document position; **shape paints store no
`from` / `to`** (their placement is relative to the box), so a wider stroke or a moved shape keeps its gradient where
it was on the shape. `document.js makePaint(ctx, paint, rect)` and `makeGradient` stay exported as 0.3-compatible
delegates (`paintStyle(ctx, paint, rect, { origin: [0, 0] })`) for FillLayer, `path-ops.js renderShapeLayer` and the
gradient tool. Defaults are 0.3's `makeGradient` / diamond / pattern / solid code, moved into `paint.js`. gradients
registers `'gradient'` (per pixel through `gradient-render.js`, Canvas gradients kept for `'classic'`), patterns
registers `'pattern'` (angle, link, origin).

**G.4 Gradient Map and Gradient Overlay** read `normalizeGradient(params)` and `gradientLut` (skeleton changes in
`adjust.js` (before the split), `styles.js` and `deep.js`), so a v2 def from the gradient widget renders, at 8 and
16/32 bits, before gradients lands.

**G.5 Paint editors (`lib/paint-editors.js`, skeleton).**

```ts
registerPaintEditor(type: 'solid' | 'gradient' | 'pattern', ed: {
  label: string;
  create(app, { doc }): Promise<Paint | null>;                     // Layer > New Fill Layer: the first dialog
  edit(app, layer, paint, { live(paint) }): Promise<Paint | null>; // Layer Content Options / double-click the fill thumbnail
  section?(app, layer, paint, onChange): HTMLElement;              // the Properties fill section body
}): void
editPaint(app, layer): Promise<void>       // 'layer:edit-fill' runs this (moved out of adjust-ui.js editFillLayer)
createPaint(app, type, { doc }): Promise<Paint | null>   // 'layer:new-fill' runs this (layer-ops.js keeps the layer creation)
```

Defaults: 0.3's code (solid: `app.pickColor`; gradient: the Gradient Fill form of `editFillLayer`, writing a v2 def with
refs resolved; pattern: the Scale form, `app.patterns.current()` for a new layer). gradients registers `'gradient'`,
patterns `'pattern'`; finish-layer-menu's New Layer dialog runs before `createPaint` for every type.

#### H. Field widgets (`lib/fields.js`, skeleton; owned by the skeleton) and option kinds

One widget API for dialog forms, panels and the options bar:

```ts
registerWidget(type: string, factory: (spec, { value, onInput(v), onChange(v), app }) => Widget): void   // later wins
createWidget(type, spec, opts): Widget; hasWidget(type): boolean
interface Widget { element: HTMLElement; get(): any; set(value, { silent }?): void; setDisabled?(b: boolean): void; destroy?(): void }
```

- `form.js buildField`: a field `type` that is not one of the built-in switch cases and `hasWidget(type)` is built
  with `createWidget`; the label, `when`, `disabled`, `help` and `values[key]` handling stay the form's. `onInput`
  sets `values[key]` and calls the form's change callback. The `slider` and `number` field types build their number
  input with `numericField()` from `lib/numeric-field.js` (the range input stays the form's).
- `tools.js buildControl`: an `OptionSpec.kind` that is not built in and `hasWidget(kind)` is built the same way;
  `updateControl(key, v)` calls `widget.set(v, { silent: true })`. `number` and `slider` option kinds use
  `numericField()`.
- Panels call `createWidget` or `numericField` directly.

| Type | Value | Stub (skeleton) | Completed by |
|---|---|---|---|
| `numeric` (and `numericField(spec)`) | number | `<input class="input" type="number" data-key=… data-numeric>` with `min`, `max`, `step`, `unit` label, as 0.3; `spec.scrubby` gives a minimal drag on the label (value += Δx × step) | conventions-shortcuts-fields: arithmetic (`100+50`, `50%`), typed units (spec `units: ['px','pt','mm','in','cm','%']` with a `dpi` provider and `base` for %), Shift+arrow ×10, wheel, the scrubby label's feel, popup slider |
| `gradient` | `GradientDef & GradientPlacement`, or `GradientDef` when `spec.placement === false` (glows, Gradient Map); `spec.kinds` adds styles (`'shape-burst'` for Stroke) | a bar showing the gradient (CSS `linear-gradient` of `gradientLut`) and a popover with two colour inputs (first and last stop) and Reverse | gradients: picker over the `gradients` presets, Gradient Editor dialog, style/angle/scale fields when `placement` |
| `pattern` | `PatternRef = { dataUrl: string, presetId?, name? }` | a swatch and "Use current pattern" (`app.patterns.current()`) | patterns: picker over the `patterns` presets, Define, import |
| `contour` | `Contour` | a select of the `contours` presets (Linear) with a 32 px curve preview | layer-style-effects: picker and the Contour Editor |
| `preset` | preset id or null (`spec.kind`: preset kind, `spec.onPick(preset)`, `spec.getData()` for Save) | a select of `app.presets.list(spec.kind)` plus "Save Preset…" (name prompt, `add`) | adjust-tonal: groups, Load / Save files through the kind's formats, Delete, built-in lists |
| `paint` | `Paint` (`spec.allow: ['none','solid','gradient','pattern']`) | a segment for the type and the matching widget (colour, `gradient`, `pattern`) | shapes-live (`lib/shape-paint-ui.js`): Photoshop's fill / stroke popups, recent colours |
| `font-size` (options bar kind) | px | today's number field in px | type-character-panel: units (pt, px, mm through `settings.type.unit`), preset list 6..72 pt, scrubby |

**The numeric field never changes its type on focus.** At rest and while focused the input is `type="number"` with
its `data-key` and `data-numeric` (43 spec lines locate `input[type="number"]`, 40 of them with a `data-key`, and
`fill()` it, then press Enter or dispatch `change` on the same locator). conventions' field turns it into `type="text"` only when a keydown
would insert a character a number input cannot hold (an operator other than a leading minus, `%`, or a unit letter);
it inserts that character itself. Its own keydown listener on the input evaluates the expression on Enter (Escape
restores the old value) and on blur, and turns the input back to `type="number"` before the event bubbles to any
panel or dialog handler. Playwright's `fill()` sends no keydown, so the specs keep a number input throughout. Code that
asks "is this a number field" tests `el.matches('input[type=number], input[data-numeric]')`: the skeleton changes the
two such checks (`blur-gallery-ui.js` Enter/Escape hand-back, `select-mask/workspace.js` the same).

**Every other number input.** About 35 hand-built `<input type=number>` live in files conventions does not own
(`extras.js`, `panels/color.js`, `panels/character.js`, `properties.js`, `panels/layers.js`, `panels/brushes.js`,
`liquify.js`, `warp.js`, `lens-correction.js`, `image-ops.js`, `content-aware-scale.js`, `adjust-ui.js`).
`lib/conventions.js` installs a document-level enhancer: delegated `focusin`, `keydown` and `wheel` listeners give every
`input[type=number]` that is not already a numeric field the arithmetic, Shift+arrow ×10 and the lazy type switch
above, and its wrapping `<label>` scrubbing. Owners convert to `numericField()` only where they want units or popup
sliders; conventions' report lists the fields that stay plain.

#### I. Adjustment dialog frame, editor capabilities, canvas capture, registry fields

**I.1 Frame (`lib/adjust/frame.js`, stub by the skeleton; owned by adjust-tonal).** `pixelEditDialog` and the
Properties adjustment section both wrap an adjustment editor in the frame:

```ts
buildAdjustmentFrame(app, kind, editor: AdjustmentEditor, {
  mode: 'dialog' | 'panel',
  sample(x, y): [r, g, b, a] | null,        // pre-adjustment pixel at a document point: the session base (dialog) or
                                            // sampleBelow(app, layer) (panel)
  getParams(): params, setParams(params): void,
  onReset(): void,                           // Alt+Cancel (dialog) / the panel's Reset button
}): { element: HTMLElement, dispose(): void }
sampleBelow(app, layer): (x, y) => [r, g, b, a] | null   // full-resolution composite below the adjustment layer, cached
                                                         // until the document version changes (adjustmentSource stays
                                                         // for histograms: it is downscaled to 512 px)
```

Rows, top to bottom, each shown only when the editor offers it: the preset menu (`preset` widget of kind
`adjustment:<kind>`; picking a preset calls `editor.setParams`), the editor element, the eyedropper buttons and the
on-image tool button (when one is armed it pushes a canvas-capture handler, I.3), the Auto button (Alt-click calls
`editor.auto.options()`), and the Preview checkbox in dialog mode. In panel mode the frame releases an armed capture
handler on `'tool:changed'`, `'doc:closed'` and in `dispose()` (the Properties host calls the section's `dispose`,
L.1). Last-used values stay in `settings.adjustLast` (adjust-ui.js). The stub frame implements all of it, with the
plain `preset` widget. `pixelEditDialog` gains an optional `frame: { kind }`; `adjust()` and the `-last` commands pass
it, the filter dialogs (`filter-ui.js`) do not and look exactly as in 0.3.

**I.2 Editors with capabilities (`app.adjustEditors`, 0.3 API extended).** `app.adjustEditors.register(kind, { editor,
width, prepare? })`. `prepare(app, arg, ctx): Promise<boolean>` runs before the dialog opens (and before a replayed
step applies); false cancels (`ctx.cancel()`). `adjust()` in adjust-ui.js awaits it (skeleton change). adjust-color
moves HDR Toning's "flatten first?" confirmation there and deletes its 0.3 command wrapper (rule 3).
`editor(kind, params, onChange, { source, app })` may return, besides `element`:

```ts
{ setParams?(params): void,                             // presets, Auto, Reset without rebuilding the editor
  presetKind?: string,                                  // default `adjustment:${kind}` when the kind has presets
  eyedroppers?: { id: string, label: string, icon: string, pick(rgba, { x, y }): void }[],   // Levels black / grey / white, Hue/Sat + / −
  onImage?: { label, icon, cursor, down(rgba, p, e), move(rgba, p, e), up(rgba, p, e) },     // Curves, Hue/Saturation
  auto?: { run(source: ImageDataLike): params, options?(): Promise<boolean> },
  dispose?(): void }
```

`buildAdjustmentEditor` keeps its 0.3 signature and returns the editor object unchanged; Levels and Curves move to
`app.adjustEditors` registrations from `lib/adjust/levels-editor.js` and `curves-editor.js` (adjust-tonal), Hue/Sat and
Shadows/Highlights from adjust-color's files.

**I.3 Canvas capture (`lib/canvas-capture.js`, skeleton) and dialog pass-through (`dialogs.js`, landed by the
skeleton).**

```ts
app.canvasCapture.push(h: { id, cursor?: string, down(p, view), move?(p, view, dragging), up?(p, view),
                           overlay?(ctx, view), key?(e): boolean }): () => void    // returns release
app.canvasCapture.top(): handler | null
app.dialogs.setCanvasThrough(dialogEl, on: boolean)   // the backdrop stops catching pointer events, so the canvas gets
                                                      // them; while on, a dialog-level capture swallows canvas clicks
                                                      // that no armed handler takes (the active tool never sees them)
app.dialogs.open({ …, onReset })                       // reserved: Alt turns Cancel into Reset (conventions-shortcuts-fields)
app.dialogs.passesMenu(id): boolean                    // E step 3; stub false
```

`CanvasView` routes pointer events to `canvasCapture.top()` before the active tool (Space / middle-button panning
still first). The frame arms an eyedropper by calling `setCanvasThrough(dialog, true)` and pushing a handler whose
`down` samples with `frame.sample` (the view's pointer point converted with `view.toDoc`); releasing restores both.
Without an armed handler a dialog behaves as in 0.3 (backdrop click = Cancel), until conventions-shortcuts-fields
makes dialogs movable and the canvas navigable under them.

**I.4 Adjustment registry fields (`src/shared/pixels/adjust-def.js`, skeleton).** A kind may declare:

```ts
apply(img, params, rect = null, ctx = null): void   // ctx = { origin: { x, y } /* document position of img(0, 0) */,
                                                    //         docWidth, docHeight, scale: 1 }; null = origin (0, 0),
                                                    //         img is the whole document
margin?(params): number    // px of neighbourhood the kind reads around each pixel (Clarity, Dehaze, Shadows/Highlights)
deepExact?(params): boolean   // false: deep.js uses its 8-bit fallback for these params (see K and J.9)
```

`applyAdjustment(img, kind, params, rect, ctx)` passes `ctx` on. Callers pass it (skeleton): the compositor's
`drawAdjustment` (origin = the target rect's document position; a clipped adjustment gets the base layer's sub-rect),
`pixelEditDialog` (the layer's position), `smart-object.js` adjustment smart filters (the smart object's position),
`deep.js applyAdjustmentDeep(deep, kind, params, rect, ctx)` and its 8-bit fallback. Grain seeds its noise from
document coordinates, so it stays put. **Margin:** `Compositor.composite(doc, { rect })` grows the work rect by the sum
of `margin(params)` of the visible adjustment layers whose kind declares one (none of the 0.3 kinds does: no cost
today), clamped to the document, composites that, and returns the requested rect; a full composite needs no growth. So
a partial repaint (a brush dab) gives the same pixels as a full one. The skeleton smoke spec registers a test kind
whose `apply` writes a pattern keyed on `ctx.origin`, with `margin` 4, and compares a full composite with a sub-rect
composite. layer-style-blending keeps both (K.3).

#### J. Document model fields

**J.1 Summary.**

| Field | Type and default | Clone (`cloneLayer`, `shallow`) | `.pigment` (describe v3) | PSD in 0.4 | History |
|---|---|---|---|---|---|
| `TextLayer.content`, `typeOptions`, `height` | A; `height: null` | by value (JSON / immutable ref) | `content`, `typeOptions`, `height` + compat `text`, `font` | import: one run (0.3); export: J.8 | `setLayerProps` snapshots them |
| `layer.vectorMask` | `null` or `{ path: PathData (document space), enabled: true, linked: true, density: 1, feather: 0, initialFill: 'hide' }` | deep copy | `vectorMask` | ignored on import (as 0.3); export: baked into the raster mask (J.8) | `setLayerProps({ vectorMask })` |
| `layer.blending` | `null` = all defaults, else `{ channels: { r, g, b } (true), knockout: 'none' \| 'shallow' \| 'deep', interiorAsGroup: false, clippedAsGroup: true, transparencyShapes: true, maskHidesEffects: false, vectorMaskHidesEffects: false, blendIf: { gray, r, g, b: { this: [b0, b1, w0, w1], under: [b0, b1, w0, w1] } } }` (ranges 0..255, default `[0, 0, 255, 255]`) | deep copy | `blending` (null when default) | ignored both ways (psd-layers, 0.5) | `setLayerProps({ blending })` |
| `layer.mask.density`, `.feather` | `1`, `0` (px) | copied with the mask | `maskDensity`, `maskFeather` | export: baked (J.8) | `setLayerProps({ mask: { …mask, density } })` |
| Gradients | G.1 | as before | lazily v2 | adjustment export normalises | as before |
| `layer.styles` | J.6 | JSON (as before) | as before (lists allowed) | as 0.3 | as before |
| `ShapeLayer` fields | J.5 | as before | as before | as 0.3 (rasterised) | as before |
| `PatternPaint` fields | G.2 | as before | `angle`, `link`, `origin`, `presetId`, `name` next to `scale` | rasterised | as before |
| `doc.store` | D | `store.clone` (Image > Duplicate) | `store` + compat top-level `guides` | guides not written (as 0.3) | D |

`vectorMask.initialFill` is the fill the mask starts from before the path is combined into it: `'hide'` (everything
hidden, the path's components with their operations add visible area: a mask made from a path shows its inside) or
`'reveal'` (everything visible, combine adds nothing, subtract hides). Reveal All makes an empty path with `'reveal'`
(the layer shows), Hide All an empty path with `'hide'` (nothing shows); Photoshop's PSD "initial fill rule" is the
same flag (psd-layers, 0.5). `describe`, `cloneLayer` and the J.8 baking copy and honour it; the K.1 stub ignores the
whole vector mask.

`DEFAULT_BLENDING`, `isDefaultBlending(b)`, `effectiveBlending(layer)`, `DEFAULT_VECTOR_MASK` are exported by
`document.js`. `Layer` constructor props accept `vectorMask` and `blending`; `layerFromDescription` passes them;
`readPigment` puts `maskDensity`/`maskFeather` into `layer.mask`.

**J.2 Geometry of vector masks and shapes.** Every operation that moves or transforms a layer also maps (a) a linked
`vectorMask.path` through `mapPath` (exported by `image-ops.js`; an unlinked vector mask stays in place) and (b) a
shape layer's geometry through `mapShapeGeometry` (J.5), never `mapPath(layer.path)` alone. The sites (all landed by
the skeleton): `layer-move.js` offsets (Move, nudge, Align/Distribute through `offsetLayers`; its snapshot keeps
`shapeKind` and `shapeProps` too), `image-ops.js` `remapDocument` (Image Size, Canvas Size, Rotate / Flip Canvas,
Crop) and Free Transform (preview, commit and restore; the vector mask follows the same matrix; warps rasterise the
vector mask into the raster mask with a toast, as they rasterise text), `layers-extras/structure.js mapLayerAffine`
(Convert to Layers), `smart-object.js` (the offset of placed contents), `tools/perspective-crop.js` (shapes through a
homography; vector masks rasterise, as text does).

**J.3 Mask density and feather** are non-destructive: they change what the mask hook (K.1) produces, never
`mask.canvas`. Applying, merging and rasterising use the effective mask (K.1).

**J.4 Text.** A.

**J.5 Shapes (owned by shapes-live; listed here because PSD (0.5) and the Layers panel read them).** `shapeKind:
'rect' | 'ellipse' | 'triangle' | 'polygon' | 'line' | 'custom' | 'path'` and `shapeProps`, the live parameters (the
path is regenerated from them while `shapeKind !== 'path'`). Closed shapes use a box, like 0.3 and like Photoshop's
W/H/X/Y: rect `{ x, y, width, height, angle, radii: [tl, tr, br, bl] }` (a rounded rectangle is a rect with non-zero
radii; there is no `'rrect'` kind), ellipse `{ x, y, width, height, angle }`, triangle `{ x, y, width, height, angle,
radius }`, polygon `{ x, y, width, height, angle, sides, starRatio /* % of the outer radius, 100 = no star */,
smoothCorners, smoothIndents, cornerRadius }`, custom `{ x, y, width, height, angle, shape /* 'shapes' preset id */ }`;
line `{ x1, y1, x2, y2, weight, arrowStart, arrowEnd }` with each arrow `null | { width, length, concavity }` (percent
of the weight, concavity −50..50). `angle` is degrees about the box centre. `fill: Paint`; `stroke: null | { paint:
Paint, width, align: 'inside' | 'center' | 'outside', cap: 'butt' | 'round' | 'square', join: 'miter' | 'round' |
'bevel', miterLimit: 4, dash: number[] (in stroke widths, [] = solid), dashOffset: 0 }`, with 0.3's `stroke.color`
still read (`paint` wins when both exist). `ShapeLayer.bounds()` delegates to `path-ops.js shapeBounds(layer)`
(skeleton moves the 0.3 padding there) so outside strokes, miters and arrowheads are padded by their owner.

What 0.3 stores and how it reads (`normalizeShapeProps(layer) -> { kind, props }` in `path-ops.js`, applied lazily by
every reader; stored values are rewritten only when the user edits the shape, so 0.3 files stay byte-stable):

| 0.3 `shapeKind` / `shapeProps` | 0.4 reading |
|---|---|
| `'rect'`, `{ x, y, width, height, radius }` (Rectangle and Rounded Rectangle tools) | rect, `radii: [radius × 4]`, `angle: 0` |
| `'ellipse'`, `{ x, y, width, height }` | ellipse, `angle: 0` |
| `'polygon'`, `{ x, y, width, height, sides, star, inset }` | polygon, `starRatio: star ? 100 − inset : 100`, `angle: 0`, no smoothing, `cornerRadius: 0` |
| `'line'`, `{ x1, y1, x2, y2, weight, arrowStart: bool, arrowEnd: bool }` | line, `true` → `{ width: 500, length: 500, concavity: 0 }` (0.3's head: `max(6 px, 5 × weight)`), `false` → null |
| `'path'` (custom shapes, with or without `props.custom`, and every reshaped shape) | path: not live (0.3 cannot tell an edited custom shape from a fresh one) |

`mapShapeGeometry(layer, pointFn, { matrix = null, homography = null } = {}) -> { path, shapeKind, shapeProps, fill?,
stroke? }` (`path-ops.js`) is what J.2's sites assign. Stub (skeleton): maps the path as 0.3 did, shifts the numeric
props for a pure translation (0.3's `offsetShapeProps` keys `x, x1, x2, cx` / `y, y1, y2, cy`), otherwise keeps the
props as they are (0.3 behaviour: they are display only), and maps `from` / `to` if a shape paint carries them.
shapes-live replaces it: rotation goes into `angle`, scale into the size fields and radii, skew or perspective turns
the shape into `shapeKind: 'path'`. `isLiveShape(layer)` (shapes-live) is true when `normalizeShapeProps` gives a kind
other than `'path'`.

**J.6 Layer styles: instances, hidden effects, new fields.** Compatible superset of 0.3:

- An effect key holds either one effect object (0.3) or an **array** of effect objects for the keys Photoshop allows
  several of: `dropShadow`, `innerShadow`, `colorOverlay`, `gradientOverlay`, `stroke` (at most 10). Array order is
  the dialog's list order, top first; the bottom one is drawn first. Writers write an array only when there is more
  than one instance.
- `styles.hidden: true` hides every effect without removing them (Layer > Layer Style > Hide All Effects, the fx eye
  in the Layers panel).
- Helpers in `styles.js` (skeleton): `hasEnabledStyles(styles)` (exists; extended to honour `hidden` and arrays; it
  replaces every `Object.values(l.styles).some((s) => s?.enabled)` in compositor.js, modes.js, automate.js, depth.js,
  actions.js, panels/layers.js, layers-extras/find.js), `effectInstances(styles, key): fx[]`, `effectEntries(styles):
  { key, index, name, fx }[]` (in dialog order, for the Layers panel's effect rows), `setEffect(styles, key, index,
  patch | null): styles`, `mapEffects(styles, fn): styles`, and **`scaleEffects(styles, k): styles`**, which knows the
  fields Scale Effects scales (size, distance, spread, choke, soften, the stroke's size, the texture and pattern
  scale) and scales every instance of an array; layer-style-effects extends it when it adds pixel fields. Image Size's
  `scaleStyles` (`image-ops.js`), `structure.js scaleStyles` (`mapLayerAffine`) and `layer:style-scale` all call it.
- **`mergeStyles`** (0.3: copies only the ten effect keys, spreads each with `Object.keys`) keeps `hidden`, merges each
  element of an array with its key's defaults and returns an array for an array, so `style-ui.js`, the fx menu and
  `actions/defaults.js` no longer drop Hide All Effects or turn two shadows into an object with keys '0' and '1'. Unit
  test: `hidden` and a two-instance `dropShadow` survive `mergeStyles`, and `scaleEffects` scales both shadows.
- `stylePadding` and `applyStyles` accept arrays (stub: the first enabled instance of an array is rendered) and return
  the input unchanged when `hidden`.
- **`applyStyles` options** (names fixed now): `applyStyles(img, styles, { pad, rect, fillOpacity, globalAngle,
  globalAltitude, interiorAsGroup = false, transparencyShapes = true, split = false })`. `interiorAsGroup` fades inner
  glow, satin and the three overlays together with Fill opacity (Blend Interior Effects as Group); `transparencyShapes
  = false` lets the interior effects and the knockout cover the whole layer box instead of its alpha; `split: true`
  returns `{ below, layer, above, offsetX, offsetY }` (exterior effects drawn under the layer, the layer with its
  interior effects, effects drawn over it) for knockout and channel restriction. The skeleton documents them and the
  stub ignores the first two and returns `{ below: null, layer: <the merged image>, above: null }` for `split`;
  `export const STYLE_FEATURES = { instances: false, interiorAsGroup: false, transparencyShapes: false, split: false }`
  says what is real. layer-style-effects implements all three (unit test each) and sets the flags; layer-style-blending's
  e2e for the two check boxes and for knockout with exterior effects skips while a flag is false (rule 8).
- New effect fields (defaults keep 0.3 output): shadows `contour: Contour | null` (null = Linear), `antiAlias: false`,
  `noise: 0` (0..1), `knocksOut: true` (drop shadow); glows `technique: 'softer' | 'precise'`, `contour`, `antiAlias`,
  `range: 0.5`, `jitter: 0`, `noise: 0`, `fill: 'color' | 'gradient'`, `gradient: GradientDef | null`; bevel
  `glossContour`, `antiAlias`, `contourSub: { enabled: false, contour, antiAlias, range }`, `texture: { enabled: false,
  pattern: PatternRef, scale, depth, invert, link }`; satin `contour`, `antiAlias`; gradient overlay `gradient:
  GradientDef` (0.3's `stops` still read) and the placement fields of G.1 flat on the effect (`kind`, `angle`, `scale`
  as a fraction, `offset`, `align: true`, `reverse`, `dither`); pattern overlay `pattern: PatternRef` (0.3's data URL
  string still read) plus `angle`, `link`, `origin`; stroke `fill: 'color' | 'gradient' | 'pattern'`, `gradient` with
  the placement fields flat (`kind` may be `'shape-burst'`), `pattern`. `Contour = { name?: string, points: { x: number,
  y: number, corner: boolean }[] }` with `x, y ∈ 0..1`, sorted by `x`, first `x = 0`, last `x = 1`. A `PatternRef`
  stored in a style always carries `dataUrl` (L.6).
- **Create Layers** needs `splitEffects(img, styles, opts): { key, index, image, x, y, blend, opacity, clip: boolean }[]`
  in `styles.js`, in stacking order, bottom first: exterior effects (drop shadow, outer glow, an outside stroke) become
  layers below the layer (`clip: false`), interior effects (inner shadow, inner glow, satin, the overlays, bevel, an
  inside stroke) clipped layers above it (`clip: true`). Stub (skeleton): for each enabled instance, `applyStyles` with
  only that effect and `fillOpacity: 0`, exact for exterior effects and close for interior ones; layer-style-effects
  makes it exact.

**J.7 Settings (`src/shared/defaults.js`).** New flat keys: none. New namespace objects (one per package; sub-keys
listed are declared by the skeleton, owners may add more):

| Key | Owner | Declared sub-keys |
|---|---|---|
| `type` | shared by the three type UI packages, each writing only its own sub-keys: type-character-panel `unit`, `char`; type-paragraph-panel `para`; type-editing `placeholder` | `unit: 'px'`, `char: {}`, `para: {}`, `placeholder: true` (`char` and `para` hold only attributes the options bar does not have, B.7) |
| `guides` | guides-snapping | `color: '#1ec8ff'`, `style: 'lines'`, `smartColor: '#ff00ff'`, `gridColor: '#508cff'`, `gridStyle: 'lines'`, `gridUnit: 'px'`, `snapTo: { guides: true, grid: true, layers: true, bounds: true, artboards: true, slices: true }`, `smartGuides: true`, `lock: false` |
| `masks` | masks-vector-masks | `overlayColor: '#ff0000'`, `overlayOpacity: 0.5` |
| `adjust` | adjust-tonal (adjust-color reads) | `autoOptions: null` (0.3's `adjustLast` key is kept as it is) |
| `gradients` | gradients | `{}` |
| `patterns` | patterns | `current: null` (preset id) |
| `styles` | layer-style-effects | `{}` |
| `shapes` | shapes-live | `{}` |
| `layersPanel` | layers-panel-depth | `thumbSize: 'medium'`, `thumbBounds: 'layer'`, `showEffects: true`, `expandEffects: true`, `fillDefaultMasks: true`, `addCopy: true` |
| `layerMenu` | finish-layer-menu | `{}` |
| `conventions` | conventions-shortcuts-fields | `toolSwitchWithShift: true`, `springLoaded: true`, `dialogPositions: {}` |

`gridSize`, `gridSubdivisions`, `snap`, `showGuides`, `showGrid`, `rulerUnit` stay flat (0.3 keys).

**J.8 PSD in 0.4.** PSD mapping of the new fields is psd-layers and psd-text (0.5). Until then:

- **Masks.** The writer writes `maskCanvasFor(layer, doc, { purpose: 'bake', parts: 'all' })` when the raster mask is
  enabled or the layer has an enabled vector mask (density, feather and a linked vector mask baked into one raster
  mask; a layer with only a vector mask gets a raster mask), so Photoshop shows what Pigment shows; a disabled raster
  mask without a vector mask is written as in 0.3 (disabled).
- **Blending options** are not written (the merged image is right, the layer is not: listed in the release notes).
- **Text.** `textToPsd` (io.js, skeleton) writes, besides 0.3's family, size, colour, underline, leading and tracking:
  `fauxBold = fauxBold || weight >= 600`, `fauxItalic = fauxItalic || italic`, strikethrough, caps, baseline shift,
  horizontal and vertical scale, auto kerning (metrics or not), the seven justifications, `boxBounds` from
  `layer.height` when it is a number (else the content height), and the first baseline from `layout.lines[0].baseline`.
  The keys it writes, checked against the vendored ag-psd typings, are listed next to it as `PSD_TEXT_KEYS`.
  `psdExpressible(layer)` (io.js) is true when `isUniform(layer.content)` and every attribute in
  `nonDefaultKeys(layer.content)` is in `PSD_TEXT_KEYS` or does not change the look (`language`, `noBreak`,
  `fractionalWidths`, the hyphenation and justification settings of a paragraph that neither hyphenates nor justifies,
  `composer`, `breakRules`). A text layer that is not expressible is written as pixels, like text on a path, with a
  once-per-save toast ("N text layers with formatting PSD text cannot hold yet were saved as pixels").
- **Adjustments.** `adjustmentToPsd` writes what 0.3 wrote: Hue/Saturation's Master only, Levels and Curves for
  `space: 'rgb'` only (J.9); the rest is release-noted. The PSD reader is unchanged.

**J.9 Adjustment parameters that change shape in 0.4** (written here because readers the packages do not own depend on
them: `deep.js`, `io.js`, `adjust-more-ui.js` Replace Color's swatch):

- **Hue/Saturation** (adjust-color): the top-level `hue`, `saturation`, `lightness`, `colorize`, `colorizeHue`,
  `colorizeSat`, `colorizeLight` stay and are the Master; `ranges: [{ base: 'reds' | 'yellows' | 'greens' | 'cyans' |
  'blues' | 'magentas', bounds: [a, b, c, d] /* degrees */, hue, saturation, lightness }]` (at most six) adds the colour
  ranges. 0.3's single-range params (`range` other than master, with the three values) read as Master 0 and one entry
  for that range with Photoshop's default bounds. `deepExact` is false when `ranges` is not empty.
- **Levels and Curves** (adjust-tonal): `space: 'rgb' | 'gray' | 'cmyk' | 'lab'` (default `'rgb'`, 0.3's keys `rgb, r,
  g, b`); `'gray'` uses `gray`, `'cmyk'` uses `cmyk, c, m, y, k`, `'lab'` uses `l, a, b`, each converted from and to the
  stored RGB pixels. A Curves channel is 0.3's `[[in, out], …]` or `{ table: number[256] }` (pencil). `deepExact` is
  false when `space !== 'rgb'` or a channel has a `table`.
- **Gradient Map** (adjust-color): `GradientDef` plus `reverse`, `dither` (G.1); `deep.js` evaluates it in float with
  `sampleGradient(normalizeGradient(p), t)`, so v2 defs stay exact at 16 and 32 bits.

#### K. Compositor hook points

**K.1 Mask (`lib/mask-render.js`, stub by the skeleton; owned by masks-vector-masks).**

```ts
type MaskParts = 'all' | 'raster' | 'vector';
maskCanvasFor(layer, doc, { purpose: 'composite' | 'bake', parts?: MaskParts = 'all' }): HTMLCanvasElement | null
     // document-sized alpha canvas: 'raster' = the raster mask with density and feather, 'vector' = the vector mask
     // with its density, feather and initialFill, 'all' = both intersected; null when that part masks nothing.
     // Cached by the module on (mask canvas, layer.version, parts)
applyLayerMask(work, x, y, layer, doc, { parts = 'all' }?): HTMLCanvasElement   // work canvas (top-left at document x, y) through the mask
hasEffectiveMask(layer, parts = 'all'): boolean
maskCacheKey(layer, parts = 'all'): string                     // part of the style-cache key
```

Stub: exactly 0.3: `'raster'` and `'all'` return `layer.mask.canvas` when `mask.enabled`, else null; `'vector'` returns
null; `hasEffectiveMask` is `!!(mask?.enabled && mask.canvas)` for `'raster'` / `'all'`; `applyLayerMask` is 0.3's
`destination-in` step. **Callers** (every read that renders or bakes what a layer looks like; all placed by the
skeleton):

| File | Read | Call |
|---|---|---|
| `compositor.js` l.87 | pass-through group shortcut | `!hasEffectiveMask(layer)` |
| `compositor.js` l.97 | pass-through group `lerpInto` | `maskCanvasFor(layer, doc, { purpose: 'composite' })` |
| `compositor.js` l.152–160 | `finishLayer` mask step and the `masked` flag of the style cache | `hasEffectiveMask` / `applyLayerMask` with the parts of K.3; `maskCacheKey` in the style-cache key |
| `compositor.js` l.244 | `drawAdjustment` | `maskCanvasFor(…, { purpose: 'composite' })` |
| `layer-ops.js` | `layer:mask 'apply'` (Photoshop applies only the pixel mask), the bake paths of `rasterizeLayer` | `parts: 'raster'`, `purpose: 'bake'`; the vector mask stays on the layer |
| `depth.js` l.418, l.433 | `planFlatten`'s pass-through test, `maskOf` (16/32-bit flatten, merge, export) | `hasEffectiveMask`, `maskCanvasFor(…, { purpose: 'bake' })` |
| `automate.js` l.179 | Apply every mask | `parts: 'raster'` |
| `ai/features.js` l.385 | `activePixels` | `maskCanvasFor(…, { purpose: 'composite' })` |
| `io.js` | PSD writer | J.8 |

Reads that edit, move, copy or display the raster mask's own pixels keep `layer.mask.canvas`: painting and filling
on the mask (`tools/paint.js`, `tools/fill.js`, `edit-ops.js`, `tools.js`), the Channels panel, the Layers panel
thumbnail, Select and Mask's output, Content-Aware Scale, Auto-Align, smart-object placement, the mask view (K.1b).
`layer:vector-mask 'rasterize'` uses `parts: 'vector'`.

**K.1b Mask view (`lib/mask-view.js`, stub; owned by masks-vector-masks):** `paintMaskView(ctx, view, layer)`, called
by `CanvasView.paint` where 0.3 draws `maskView` and `showMaskOverlay` (the stub is that 0.3 code moved), and
`vectorMaskThumb(layer, w, h): HTMLCanvasElement` for the Layers panel row (L.15; stub: the path filled with grey on
white, honouring `initialFill`).

**K.2 Styles (`lib/style-prepare.js`, stub; owned by layer-style-effects):** `prepareStyles(layer, doc, onReady):
{ styles, ready: boolean }` turns stored styles into what `applyStyles` takes (pattern references decoded, arrays
passed through); the stub is 0.3's pattern-overlay resolution moved out of `compositor.js styledCanvas`. `ready:
false` means "do not cache" (a pattern still decoding).

**K.3 Blending (owner layer-style-blending, inside `compositor.js`).** `finishLayer` keeps 0.3's order (clipping
group, fill opacity, mask, styles, blend) when `effectiveBlending(layer)` is the default, with the same Canvas fast
path. layer-style-blending adds channels, knockout, Blend If and the five check boxes, and keeps every K.1 and K.2 call
the skeleton placed, the adjustment `ctx` and the margin growth of `composite()` (I.4). The mask step and the hides-
effects boxes: with both `maskHidesEffects` and `vectorMaskHidesEffects` off, `parts: 'all'` is applied before the
styles (0.3); both on, after; one on, the part whose box is off before the styles and the part whose box is on after.
The style-cache key uses `maskCacheKey(layer, <the parts applied before the styles>)`. Blend Interior Effects as Group
and Transparency Shapes Layer are the `applyStyles` options of J.6; knockout and channel restriction may use `split`.
**Group styles:** a group with enabled styles (`isStyleable` admits groups) renders over its content bounds grown by
`stylePadding` (not only the repaint rect), caches the styled result on `(group.version, maskCacheKey, clipKey, global
light)` (group versions bump when a child is touched), and the pass-through test uses `hasEnabledStyles(layer.styles)`
instead of `!layer.styles` (a styles object whose effects are all off keeps passing through); a pass-through group with
effects composites as an isolated group, as Photoshop does. Measured targets: the repaint time of a 4000 px document
with default options does not grow, and a brush dab on a layer next to a styled group does not run `applyStyles` for
the group.

#### L. UI registries

**L.1 Properties sections (`app.properties.registerSection`, `panels/properties.js` becomes the host, skeleton).**

```ts
app.properties.registerSection({ id, order: number, region: 'main' | 'mask', test(layer | null, doc): boolean,
  hides?: string[],                                        // section ids the host skips while this one's test passes
  render(layer, doc, ctx: { app, schedule(), keep: (key) => boolean }): HTMLElement | null,
  dispose?(element: HTMLElement): void }): void
```

The host renders, for the active layer (or the document when none), every section whose `test` passes and that no
other passing section `hides`, in `order`, and keeps 0.3's rule of not rebuilding a section the user is typing in
(`keep`). `render` may return the element it returned last time: the host keeps it mounted (a drag in progress
survives the re-render `setLayerProps` causes). The host calls `dispose(element)` whenever it removes or replaces an
element, and on `'doc:closed'`. It re-renders the type sections on `'type:selection'`, at most once per frame. Sections
moved out of properties.js by the skeleton, with their owners: `document` and `transform` (`lib/properties/transform.js`,
skeleton; X/Y/W/H through `app.rulers`, L.10; info-histogram-properties in 0.7), `fill` (`lib/properties/fill.js`,
gradients; its body comes from the paint editor's `section`, so patterns' pattern section shows there), `shape`
(`lib/properties/shape.js`, shapes-live; it declares `hides: ['transform']` for live shapes, which show Photoshop's one
set of live W/H/X/Y), `text` (`lib/properties/text.js`, type-character-panel), `paragraph` (`lib/properties/paragraph.js`,
stub empty, type-paragraph-panel), `adjustment` (`lib/properties/adjustment.js`, adjust-color; builds the I.1 frame in
panel mode and disposes it), `mask` (`lib/properties/mask.js`, masks-vector-masks, region `'mask'`). Each moved section
renders what 0.3 rendered. `app.properties` exists from the App constructor on, so a package registers from its
`install(app)`; the host's built-ins never replace a section registered before them (see "The skeleton as landed").

**L.2 Preferences sections (`app.preferences.registerSection`, extras.js, skeleton).** `{ id, title, order, fields:
FieldSpec[], read(settings) -> values, write(values, settings) -> patch }`; the Preferences dialog shows the sections
in order as one form (0.3's look). Built-in sections: `interface`, `tools`, `canvas`, `performance` (0.3's), and a
`guides` section (Guides, Grid & Slices) holding the grid fields moved out of `canvas`, which guides-snapping
replaces. type-editing (`type`: placeholder text), masks-vector-masks (overlay colour), conventions-shortcuts-fields
(tool switching) register theirs, from `install(app)` (`app.preferences` exists from the App constructor on; extras.js's
built-ins never replace a section a package registered first). preferences-dialog (0.8) re-homes all of them.

**L.3 Layer Style pages (`app.layerStyle.registerPage`, style-ui.js; landed by the skeleton).**

```ts
app.layerStyle.registerPage({ id, title, order,
  render(ctx: { layer, styles, opacity, fillOpacity, blend,   // opacity and fillOpacity 0..1 (not 0.3's local percents)
                advanced,                                     // the draft of layer.blending, never null inside the dialog
                apply(), select(id) }) -> HTMLElement })
```

The skeleton changes `styleDialog` so that it snapshots, live-applies, restores on Cancel and commits on OK `blending`
together with `styles`, `opacity`, `fillOpacity` and `blend`, in one `setLayerProps` entry; it stores `null` when
`isDefaultBlending(advanced)`; the replay argument includes `blending` when it changed, and a `layer:style` replay with
`{ blending }` applies it. The Blending Options page and `isStyleable(layer)` (used by `hasStyleable`) live in
`lib/blending-options.js` (stub: 0.3's blending form on `ctx.opacity` / `fillOpacity` / `blend`, and `!group && type
!== 'adjustment'`); layer-style-blending replaces that file. `isStyleable` is false for a layer whose
`app.backgroundRules.lockedProps(layer)` includes `'styles'` (L.13). The effect pages stay style-ui.js's.

**L.4 Path targets and path buttons (`tools/vector.js`, landed by the skeleton).**

```ts
registerPathTargetKind(kind, {
  fromRef(app, ref) -> target | null, fromActive(app, doc) -> target | null, rows?(app, doc) -> PathsPanelRow[],
  remove?(app, target): void,               // path:delete on this target (the vector mask: delete it)
  rename?(app, target, name): void,         // path:rename
  toSaved?(app, target): SavedPath,         // path:save and dragging the row onto New Path: a saved copy
})
registerPathButton({ key, label, icon, run(app), when?(tool) })
export function createShapeLayer(app, path, { name, label, style, kind, props }): ShapeLayer   // exported (0.3: private)
```

`activePathTarget`, `visibleTargets`, `currentPathTarget`, `path:delete`, `path:save`, `path:rename` and the Paths
panel consult the registered kinds after the built-ins (work, saved, shape). A target may define `preview(draft)` and
`endPreview(original)`; without them the vector tools draw the draft as an overlay (0.3's work-path behaviour).
`registerPathButton` adds a button after Selection / Fill / Stroke in the path tools' options bar. masks-vector-masks
registers the `'vector-mask'` kind and the Mask and Shape buttons (`path:make-shape` uses `createShapeLayer`).
shapes-live keeps these registries and the export.

**L.5 View underlays (`app.viewUnderlays`, a Set, app.js).** `fn(ctx, view)` is called by `CanvasView.paint` in
document space after the composite and before the grid, outside the document clip; Pattern Preview uses it.

**L.6 Pattern library (`app.patterns`, `lib/patterns.js`, stub by the skeleton; owned by patterns).**

```ts
app.patterns.current(): { id, name, canvas, width, height } | null
app.patterns.setCurrent(id): void
app.patterns.define(canvas, { name }): Promise<entry>     // Edit > Define Pattern
app.patterns.list(): entry[]; app.patterns.get(id): Promise<entry | null>
app.patterns.ref(entry): PatternRef                       // { dataUrl, presetId, name }
app.patterns.resolve(ref: PatternRef | string): ImageData | null   // the embedded pixels first; 0.3 data URLs accepted
app.currentPattern                                                // getter kept for 0.3 code: current()?.canvas ?? null
```

A `PatternRef` stored in layer data (styles, the Bevel texture, stroke and shape pattern fills) **always carries
`dataUrl`**, the pixels; `presetId` and `name` are provenance only. So a ref survives a deleted preset, another
machine, Copy / Paste Layer Style, actions and `.pigment`, and writers can embed it. The `pattern` widget's `onChange`
always fills `dataUrl`. `lib/patterns.js` exports `installPatterns(app)`, which `app.js start()` calls before MODULES
(the pattern package keeps that export). Stub: 0.3 behaviour (the last defined pattern, in memory). The skeleton
replaces every read of `app.currentPattern` (edit-ops Fill, layer-ops New Fill Layer, fill.js bucket, retouch.js
Pattern Stamp, style-ui.js pattern overlay) with `app.patterns.current()`, the one write (Define Pattern) with
`app.patterns.define()`, and deletes `edit-ops.js`'s unused `app.patterns = [...]` array, whose name this API takes.

**L.7 Layer double-click (`app.registerLayerDoubleClick(type, fn(layer, p) -> boolean)`, app.js).** The Move tool's
`onDoubleClick` hit-tests the layer under the pointer and calls `app.layerDoubleClick(layer, p)`; type-editing
registers `'text'` (start editing at the clicked index).

**L.8 Vendor steps.** `scripts/build-vendor.mjs` keeps the ag-psd bundle and then imports every
`scripts/vendor/*.mjs` and awaits its `build({ root, out, esbuild })`. A step that fails prints a warning and the
others still run. The ag-psd bundle's entry (`scripts/vendor-entries/ag-psd.js`) also imports `ag-psd-grdm.js`, which
wraps ag-psd's own `grdm` handler (no text patching of the bundle) so the Gradient Map's interpolation method is read
and written as Photoshop's 4-character code (`methodCode`: `Gcls`, `Perc`, `Lnr `, `Smoo`; version 1 blocks without
one are Classic); `lib/io.js` uses only `methodCode`, which an unfixed ag-psd ignores. Node tests import the module to
fix the `node_modules` copy the same way.

**L.9 Drop handlers (`app.registerDropHandler(mime, h)`, app.js).**

```ts
app.registerDropHandler(mime: string, { canvas?(data: string, docPoint: { x, y }, e): void,
                                        layer?(data: string, layer: Layer, e): void }): void
```

Panels start in-app drags with `dataTransfer.setData('application/x-pigment-gradient' | 'application/x-pigment-pattern',
JSON)` (a resolved `GradientDef & GradientPlacement`, a `PatternRef`). `canvas-view.js` (on the canvas) and the layer
rows of `panels/layers.js` (on a row) call `preventDefault` on dragover when a handler is registered for one of
`e.dataTransfer.types`, and call it on drop (skeleton; each call marked `// drop (E25)`). The app.js window drop of
files stays as it is. gradients registers the gradient MIME (a drop makes a Gradient Fill layer above the target or
the active layer), patterns the pattern MIME (a Pattern Fill layer).

**L.10 Rulers (`app.rulers`, `lib/rulers.js`, stub by the skeleton; owned by guides-snapping).**

```ts
app.rulers.unit(doc): 'px' | 'in' | 'cm' | 'mm' | 'pt' | 'pica' | 'percent'     // settings.rulerUnit
app.rulers.origin(doc): { x, y }                                      // document px
app.rulers.toRuler(doc, axis, px, { length = false }?): number        // length: no origin (widths, heights)
app.rulers.fromRuler(doc, axis, value, { length = false }?): number
app.rulers.format(doc, axis, px, { length = false }?): string         // value and unit label
```

Stub: no origin, and 0.3's unit maths (`panels/info.js fmtUnit`). Callers (skeleton, marked `// ruler
(lib/rulers.js)`): the Info panel, the Properties transform section, the Free Transform options bar X/Y/W/H.
guides-snapping implements the origin (the `rulerOrigin` collection, D) and the rulers themselves read it, so every
coordinate readout moves with the ruler origin.

**L.11 Merged sampling (`lib/sample.js`, skeleton).**

```ts
sampleMerged(app, doc, { stored = false, rect = null } = {}): HTMLCanvasElement   // what "Sample: All Layers" reads
app.sampleSkip?: (doc) => Set<Layer> | null                                       // layers sampling must not see
```

`sampleMerged` is `flattenDocument(doc, view.compositor)` (`stored`: `flattenStored`; with `rect`:
`composite(doc, { rawMode, rect })`), as each call site does today, except that when `app.sampleSkip(doc)` returns a
non-empty set it composites with `skip` (cached per document version and skip set). find.js (layers-panel-depth) sets
`app.sampleSkip` from the isolation state, so the Eyedropper, Magic Wand and the other "all layers" samplers see what
the canvas shows. Call sites (skeleton, marked `// sample (lib/sample.js)`): `tools/bucket.js` (the Paint Bucket's
Sample Merged), `tools/select.js` (Magic Wand, Quick Selection), `tools/object-select.js`, `tools/retouch.js` (the four
Sample All Layers sites), `tools/nav.js` (Eyedropper and Color Sampler), `panels/info.js`.

**L.12 Tool traits (`lib/tool-traits.js`, skeleton; no package edits it).**

```ts
paints(tool): boolean                                  // tool.paints ?? the fallback table
claimsModifier(tool, mod: 'ctrl' | 'alt' | 'space'): boolean   // tool.claimsModifiers?.has(mod) ?? the fallback table
```

A tool may declare `paints?: boolean` and `claimsModifiers?: Set<'ctrl' | 'alt' | 'space'>` (section "Tools" of this
file). Until each owner does, the fallback tables by tool id in `tool-traits.js` say: painting tools are the brush,
pencil, colour replacement, eraser family, clone and pattern stamp, history brush, gradient, paint bucket, dodge, burn,
sponge, blur, sharpen and smudge; the type tools claim Ctrl (box transform, move), the pen, path and shape tools claim
Ctrl and Alt (direct selection, convert point), the Move tool claims Ctrl (auto-select toggle). conventions' temporary
tools (`temp-tools.js`) do not spring-load on a modifier the active tool claims; finish-layer-menu's opacity digits act
only while `!paints(app.tools.active)`. type-editing and shapes-live set the properties on their tools from their own
files.

**L.13 Background rules (`app.backgroundRules`, stub in `layers-extras/structure.js` by the skeleton; completed by
finish-layer-menu).**

```ts
app.backgroundRules.canPlace(doc, layers: Layer[], target: Layer, mode: 'above' | 'below' | 'inside'): boolean
app.backgroundRules.lockedProps(layer): string[]   // the Background: ['blend', 'opacity', 'fillOpacity', 'mask',
                                                   // 'vectorMask', 'styles', 'position']; others: []
```

Stub: `canPlace` always true and `lockedProps` `[]` (0.3 behaviour). The Background is recognised as in 0.3
(`app.isBackgroundLayer`: the bottom raster layer of the root named "Background"). Users: layers-panel-depth (drop
indicators refuse what `canPlace` refuses; controls for locked properties disabled), masks-vector-masks (no vector mask,
density or feather on a layer whose `lockedProps` includes `'vectorMask'` / `'mask'`), layer-style-blending
(`isStyleable`). Renaming the Background (`layer:rename`) lifts its Background locks as Layer from Background does.

**L.14 Type panel sections (`lib/type/sections.js`, skeleton; no package edits it).**

```ts
registerTypeSection(panel: 'character' | 'paragraph', { id, order, replaces?: string,
  test?(ctx): boolean, render(ctx: { app, attrs /* readChar or readPara */, apply(patch), unit }): HTMLElement }): void
typeSections(panel): spec[]        // in order; emits 'type:sections-changed' on app when the list changes
```

The Character panel, the Paragraph panel and the Properties text / paragraph sections render the registered sections
after their own controls; a section with `replaces` takes the place of the built-in control of that id (the panels
give their rows ids: `family`, `style`, `size`, `leading`, `kerning`, `tracking`, `scale`, `baseline`, `color`,
`toggles`, `language`, `align`, `indents`, `spacing`, `hyphenate`). 0.5's type-opentype-glyphs (OpenType row),
type-fonts (the family control) and 0.9's type-international plug in here without editing `character.js` or
`paragraph.js`.

**L.15 The vector mask in the Layers panel row (skeleton, in `panels/layers.js`; owned by layers-panel-depth
afterwards, which keeps it).** A row whose layer has a `vectorMask` shows, after the raster mask's thumbnail, a link
icon and the vector mask's thumbnail (`vectorMaskThumb`, K.1b). Clicks run masks-vector-masks' command: click →
`layer:vector-mask 'target'` (the vector mask becomes the active path target, edited with the path tools),
Shift-click → `'toggle'`, the link icon → `'link'`, Ctrl/Cmd-click → `'select'` (load as a selection).

#### M. Commands, menus and keys

**M.1 Where.** The menu template moves from `src/main/menu.js` to `src/shared/menu-template.js` (pure, imports only
`src/shared`), so the renderer can read the menu's labels and paths (Edit > Search, the shortcut list);
`src/main/menu.js` re-exports `buildMenuTemplate`, `PANELS`, `IMAGE_MODES`, `STACK_MODES` (the unit and e2e tests
import from there). Every item click is `(item, win, ev) => run(cmd, arg, !!ev?.triggeredByAccelerator)`, which
`main.js` forwards so that the renderer runs the command with source `'menu-key'` (accelerator) or `'menu'` (mouse)
(O). Every item below lands in the skeleton. An item whose command is stubbed is disabled (`state.stubs`), as in 0.3.

**M.2 New top-level Type menu** (label `T&ype`, between Layer and Select, Photoshop's place; `&T` is taken by
Fil&ter). Layer > Type and Layer > Edit Text are removed from the Layer menu and appear here:

| Item | Command (arg) | Enabled | Owner |
|---|---|---|---|
| Panels ▸ Character Panel | `window:panel-character` | always | exists |
| Panels ▸ Paragraph Panel | `window:panel-paragraph` | always | type-paragraph-panel |
| Orientation ▸ Horizontal / Vertical / Vertical, Stacked (CJK) | `text:orientation` (`'horizontal'`, `'vertical'`, `'vertical-stacked'`), radios from `state.textOrientation` | text layer | exists (moved) |
| Text on Path, Release from Path, Flip Text on Path | `text:on-path`, `text:release-path`, `text:flip-path` | text layer | exists (moved) |
| Edit Text | `layer:edit-text` | text layer | exists (moved) |
| Rasterize Type Layer | `layer:rasterize` (`'type'`) | text layer | finish-layer-menu honours the arg (0.3 ignores it and rasterises the active layer, which is a text layer here) |

Type menu items of later releases (Anti-Alias, Warp Text, Create Work Path, Convert to Shape, OpenType, Paste Lorem
Ipsum, Update All Text Layers, Manage Missing Fonts, Language Options, Load/Save Default Type Styles) are added by the
0.5–0.9 skeletons.

**M.3 New and changed items in the other menus.**

| Menu | Item | Command (arg) | Key | Owner |
|---|---|---|---|---|
| File > Export | Quick Export as PNG | `file:export-quick` | Shift+Ctrl+' (was Alt+Shift+Ctrl+E) | exists |
| File > Export | Export As… | `file:export` | Alt+Shift+Ctrl+W (was Alt+Shift+Ctrl+S) | exists |
| File > Export | Save for Web (Legacy)… | `file:save-for-web` | Alt+Shift+Ctrl+S (new) | exists |
| Edit | Toggle Last State (after Redo) | `edit:toggle-last-state` | Alt+Ctrl+Z | conventions-shortcuts-fields |
| Edit | Step Forward, Step Backward | unchanged ids | none (were Alt+Shift+Ctrl+Z, Alt+Ctrl+Z) | exists |
| Edit > Paste Special | Paste Without Formatting | `edit:paste-without-formatting` | none | type-editing |
| Edit | Search… (after Clear) | `edit:search` | Ctrl+F | conventions-shortcuts-fields |
| Edit | Define Pattern… (label gains "…") | `edit:define-pattern` | none | patterns |
| Edit | Keyboard Shortcuts… | `help:shortcuts` | Alt+Shift+Ctrl+K (was Ctrl+/; the Help item loses its accelerator) | exists |
| Edit | Menus… (after Keyboard Shortcuts) | `edit:menus` | Alt+Shift+Ctrl+M | stub until shortcuts-editor (0.5), `lib/stubs-later.js` |
| macOS app menu | Settings… | `edit:preferences` | Cmd+K (was Cmd+, : Cmd+, is Hide Layers, as in Photoshop; Windows and Linux keep Ctrl+K) | exists |
| Image > Adjustments, Layer > New Adjustment Layer | Color and Vibrance…, Clarity and Dehaze…, Grain… (after Color Lookup, separator before) | `image:adjust-color-vibrance`, `image:adjust-clarity-dehaze`, `image:adjust-grain`; `layer:new-adjustment` (`'color-vibrance'`, `'clarity-dehaze'`, `'grain'`) | none | adjust-color (placeholder kinds until then) |
| Layer > New | Layer… (opens the New Layer dialog, see below) | `layer:new` | Shift+Ctrl+N (unchanged) | finish-layer-menu |
| Layer > New | Group… (label gains "…") | `layer:new-group` | none | finish-layer-menu |
| Layer | Duplicate Layer… (label gains "…") | `layer:duplicate` | none | finish-layer-menu |
| Layer > Layer Style | Create Layers | `layer:style-create-layers` | none | layer-style-blending |
| Layer > Layer Style | Hide All Effects / Show All Effects (label from `state.effectsHidden`) | `layer:style-toggle-all` | none | layer-style-blending |
| Layer > Layer Style | Scale Effects… | `layer:style-scale` | none | layer-style-blending |
| Layer | Vector Mask ▸ Reveal All, Hide All, Current Path, ─, Delete, ─, Disable / Enable, Link / Unlink (after Layer Mask) | `layer:vector-mask` (`'reveal-all'`, `'hide-all'`, `'current-path'`, `'delete'`, `'toggle'`, `'link'`; the Layers panel row also uses `'target'` and `'select'`, L.15) | none | masks-vector-masks |
| Layer > Rasterize | Type, Shape, Fill Content, Vector Mask, Smart Object, ─, Layer, All Layers, ─, Layer Style | `layer:rasterize` (`'type'`, `'shape'`, `'fill'`), `layer:vector-mask` (`'rasterize'`), `layer:smart-rasterize`, `layer:rasterize`, `layer:rasterize-all`, `layer:rasterize-style` | none | finish-layer-menu (args), masks-vector-masks |
| Layer | Hide / Show Layers | `layer:visibility` | Ctrl+, (new) | finish-layer-menu (selected layers) |
| Layer > Arrange | Reverse | `layer:arrange-reverse` | none | finish-layer-menu |
| Layer > Distribute | Top Edges, Vertical Centers, Bottom Edges, ─, Left Edges, Horizontal Centers, Right Edges, ─, Horizontally, Vertically | `layer:distribute` (`'top'`, `'vcenter'`, `'bottom'`, `'left'`, `'hcenter'`, `'right'`, `'horizontal'`, `'vertical'`) | none | finish-layer-menu (0.3 accepts the last two) |
| Layer | Lock Layers…, Lock All Layers in Group… (after the Lock Layer submenu) | `layer:lock-dialog`, `layer:lock-group` | Ctrl+/ (Lock Layers) | finish-layer-menu |
| Layer | Merge Down / Merge Layers / Merge Group (label from `state.selectedCount` and `state.layerType`) | `layer:merge` (new id; `layer:merge-down` keeps 0.3's meaning) | Ctrl+E (moves from `layer:merge-down`) | finish-layer-menu; the skeleton registers it working (M.6) |
| Select | Similar Layers (after Isolate Layers) | `layer:select-similar` | none | finish-layer-menu |
| Filter | Last Filter | `filter:last` | Alt+Ctrl+F (was Ctrl+F) | exists |
| View | Proof Colors | `view:proof` | Ctrl+Y (new; Ctrl+Y no longer redoes) | exists |
| View > Show | Smart Guides (checkbox, `state.smartGuides`) | `view:smart-guides` | none | guides-snapping |
| View | Pattern Preview (checkbox, `state.patternPreview`) | `view:pattern-preview` | none | patterns |
| View | Snap To ▸ Guides, Grid, Layers, Document Bounds, Artboards, Slices (checkboxes from `state.snapTo`), ─, All, None | `view:snap-to` (`'guides'`, `'grid'`, `'layers'`, `'bounds'`, `'artboards'`, `'slices'`, `'all'`, `'none'`) | none | guides-snapping |
| View | Guides ▸ Lock Guides (checkbox), Clear Canvas Guides, Clear Selected Artboard Guides, Clear Selected Guides, ─, New Guide…, New Guide Layout…, New Guides From Shape, Edit Selected Guides… (the top-level New Guide… and Clear Guides move in here) | `view:lock-guides`, `view:clear-guides`, `view:clear-artboard-guides`, `view:clear-selected-guides`, `view:new-guide`, `view:new-guide-layout`, `view:guides-from-shape`, `view:edit-selected-guides` | Alt+Ctrl+; (Lock Guides) | guides-snapping (`view:new-guide`, `view:clear-guides` exist) |
| Window | Paragraph (after Character), Gradients and Patterns (after Swatches) | `window:panel-paragraph`, `window:panel-gradients`, `window:panel-patterns` | none | the panel packages |

**When the New Layer, New Group and Duplicate Layer dialogs open.** `layer:new`, `layer:new-group` and
`layer:duplicate` open their dialog only when the argument is `undefined` and `ctx.source` is `'menu'`, `'menu-key'` or
`'key'`, or when the argument has `dialog: true`. Every other source (`'api'`, `'action'`, `'panel'`, `'toolbar'`,
`'assistant'`) creates without asking, so the specs, the built-in actions (`actions/defaults.js`) and the Layers panel
behave as in 0.3. The menu template and the keymap pass no argument (Shift+Ctrl+N from the page and from the menu
carry the same `undefined` and de-duplicate). Arguments: `layer:new` `{ name?, dialog?, below?, clip?, color?, blend?,
opacity?, neutral? }`; `layer:new-group` `{ name?, dialog?, color?, blend?, opacity? }`; `layer:duplicate` `{ name?,
dialog?, destination? }`. A dialog reports the fields it applied through `ctx.setReplayArg`. Layers panel footer: a
plain click passes nothing, Alt-click `{ dialog: true }`, Ctrl/Cmd-click `{ below: true }`.

**Layer property commands on several layers** (finish-layer-menu, in `layer-ops.js`). `layer:opacity`,
`layer:fill-opacity`, `layer:blend`, `layer:lock` and `layer:visibility` act on `selectedOrActive(doc)` by default
and accept `{ ids?: string[], value }` (`{ ids?, visible }` for visibility; the visibility applied is the opposite of
the active layer's), besides 0.3's plain value or id argument, which keeps its 0.3 meaning. `layer:clip` accepts
`{ id }`. They write through `setLayersProps(app, layers, patchOrFn, label, { merge })` (`layer-ops.js`, landed by the
skeleton as a loop inside `history.group`, then made one entry by finish-layer-menu): one history entry whose merge key
is the sorted ids plus the patch keys, so a scrubby Opacity drag over three selected layers is one entry. The Layers
panel passes `ids` explicitly.

Commands without a menu item (panel menus, context menus, options bar, keys): see M.7.

Items that reuse an existing command with a new argument stay harmless until their owner lands: the skeleton makes
`layer:distribute` answer an edge argument with "Not available yet" (0.3 would distribute centres horizontally), and
each Rasterize item is enabled only for its layer kind, so 0.3's `layer:rasterize` does the right thing for Type,
Shape and Fill Content (Fill Content keeping the vector mask comes with finish-layer-menu).

**M.4 New key bindings** (all `src/shared/keymap.js`; RENDERER_KEYS unless marked MENU):

| Key | Command | Owner |
|---|---|---|
| Ctrl+F (MENU) | `edit:search` | conventions-shortcuts-fields |
| Alt+Ctrl+F (MENU) | `filter:last` | exists |
| Alt+Ctrl+Z (MENU) | `edit:toggle-last-state` | conventions-shortcuts-fields |
| Ctrl+Y (MENU) | `view:proof` | exists |
| Alt+Shift+Ctrl+S / Alt+Shift+Ctrl+W / Shift+Ctrl+' (MENU) | `file:save-for-web` / `file:export` / `file:export-quick` | exist |
| Alt+Shift+Ctrl+K / Alt+Shift+Ctrl+M (MENU) | `help:shortcuts` / `edit:menus` | exists / 0.5 |
| Ctrl+K (MENU, the macOS app menu too) | `edit:preferences` | exists |
| Ctrl+E (MENU) | `layer:merge` | finish-layer-menu (working placeholder from the skeleton) |
| Ctrl+/ (MENU) | `layer:lock-dialog` | finish-layer-menu |
| Ctrl+, (MENU) | `layer:visibility` | finish-layer-menu |
| Alt+Ctrl+; (MENU) | `view:lock-guides` | guides-snapping |
| Alt+Shift+Ctrl+E | `layer:stamp-visible` | finish-layer-menu |
| Alt+Ctrl+E | `layer:stamp-selected` | finish-layer-menu |
| Alt+Shift+Ctrl+N | `layer:new-no-dialog` | finish-layer-menu |
| Alt+] / Alt+[ | `layer:select-forward` / `layer:select-backward` | finish-layer-menu |
| Alt+. / Alt+, | `layer:select-front` / `layer:select-back` | finish-layer-menu |
| Shift+Alt+] / Shift+Alt+[ | `layer:select-add-forward` / `layer:select-add-backward` | finish-layer-menu |
| / | `layer:lock-transparency-toggle` | finish-layer-menu |
| 1 … 9, 0 | `layer:opacity-digit-1` … `-9`, `layer:opacity-digit-0` (10 % … 90 %, 100 %; two digits typed quickly set an exact value; only while `!paints(app.tools.active)`, L.12) | finish-layer-menu |
| Shift+1 … Shift+0 | `layer:fill-digit-1` … `-0` (fill opacity) | finish-layer-menu |
| Shift+Alt+N, I, K, M, B, A, G, S, D, W, O, F, H, V, J, Z, L, E, X, U, T, C, Y, P | `layer:blend-mode-normal`, `-dissolve`, `-darken`, `-multiply`, `-color-burn`, `-linear-burn`, `-lighten`, `-screen`, `-color-dodge`, `-linear-dodge`, `-overlay`, `-soft-light`, `-hard-light`, `-vivid-light`, `-linear-light`, `-pin-light`, `-hard-mix`, `-difference`, `-exclusion`, `-hue`, `-saturation`, `-color`, `-luminosity`, `-pass-through` (Photoshop's letters; 0.4 sets the layer's mode, painting tools' modes come with 0.5) | finish-layer-menu |
| Shift+= / Shift+- | `layer:blend-next` / `layer:blend-prev` | finish-layer-menu |
| Alt+Ctrl+L / M / U / B | `image:adjust-levels-last`, `image:adjust-curves-last`, `image:adjust-hue-saturation-last`, `image:adjust-color-balance-last` | adjust-tonal |
| \ | `layer:mask-overlay` (rubylith on the targeted mask) | masks-vector-masks |

Darker Color, Lighter Color, Subtract and Divide have no Photoshop letter and get no key. The digit, `/`, `\` and
blend-mode keys never act while a text field has focus (shortcuts.js skips plain keys there, as in 0.3).

**Matching on every keyboard.** `eventMatches` (keymap.js) compares by physical key (`codeToKey(event.code)`, which
gains `Backslash` and `Period` handling where missing) whenever the binding has Alt or Shift, not only Shift, **and the
key produced (`event.key`) is not an ASCII letter or digit**: on macOS Option changes `event.key` (Option+[ gives '“',
Option+Shift+F 'Ï'), so Alt+[, Alt+], Alt+, , Alt+., Alt+\ and the Shift+Alt letters would otherwise never match, and
Shift turns a digit or symbol into another symbol (Shift+1 gives '!'). A letter or digit that was produced matches only
the binding of that letter or digit, never another binding by position: on AZERTY the key labelled Z sends code
`KeyW`, so a position match would turn Ctrl+Alt+Z into Ctrl+Alt+W; on QWERTZ Shift+Alt+Y (code `KeyZ`) would run the
Shift+Alt+Z blend mode. `shortcuts.js` and `main.js` (the Shift+Alt interception) both use `eventMatches`. Plain `/`
and `\` depend on the layout (on a German keyboard `/` needs Shift and does not match): a release-note line.
`keymap-04.test.mjs` checks synthetic events such as `{ key: '“', code: 'BracketLeft', altKey: true }` against Alt+[,
and AZERTY and QWERTZ events against the whole table.

**TYPE_KEYS** (new table in keymap.js: accelerators active only while a Type tool session is editing; type-editing's
`edit-keys.js` dispatches them from the editor's input, which has focus, so `shortcuts.js` never sees them; the
commands act through `lib/type/target.js` and are registered by type-editing):

| Key | Command | Key | Command |
|---|---|---|---|
| Shift+Ctrl+. / , | `type:size-up` / `type:size-down` (2 px) | Alt+Shift+Ctrl+. / , | `type:size-up-10` / `type:size-down-10` |
| Alt+Up / Alt+Down | `type:leading-down` / `type:leading-up` (2 px) | Alt+Ctrl+Up / Down | `type:leading-down-10` / `type:leading-up-10` |
| Alt+Left / Alt+Right | `type:kern-down` / `type:kern-up` (20/1000 em: kerning at a caret, tracking on a range) | Alt+Ctrl+Left / Right | `type:kern-down-100` / `type:kern-up-100` |
| Shift+Alt+Up / Down | `type:baseline-up` / `type:baseline-down` (2 px) | Shift+Alt+Ctrl+Up / Down | `type:baseline-up-10` / `type:baseline-down-10` |
| Shift+Ctrl+L / C / R | `type:align-left` / `-center` / `-right` | Shift+Ctrl+J / F | `type:align-justify-left` / `type:align-justify-all` |
| Shift+Ctrl+B / I | `type:toggle-faux-bold` / `type:toggle-faux-italic` | Shift+Ctrl+U / Shift+Ctrl+/ | `type:toggle-underline` / `type:toggle-strike` |
| Shift+Ctrl+K / H | `type:toggle-all-caps` / `type:toggle-small-caps` | Shift+Ctrl+= / Alt+Shift+Ctrl+= | `type:toggle-superscript` / `type:toggle-subscript` |
| Shift+Ctrl+X / Alt+Shift+Ctrl+X | `type:reset-scale-x` / `type:reset-scale-y` | Alt+Shift+Ctrl+A | `type:auto-leading` |
| Shift+Ctrl+Q | `type:reset-tracking` | Alt+Shift+Ctrl+H / T | `type:toggle-hyphenation` / `type:toggle-composer` |
| Ctrl+H (editing) | `type:hide-selection` | | |

The 0.3 editor's own Ctrl+B / I / U and Ctrl+Shift+> / < handling is replaced by this table (no existing spec presses
those keys in a type session). `keymap.js` also exports `typeKeyFor(commandId): string | null`, computed from the
tables: for every MENU_KEYS or RENDERER_KEYS command whose accelerator is also in TYPE_KEYS (Shift+Ctrl+L
`image:auto-tone`, Shift+Ctrl+C `edit:copy-merged`, Shift+Ctrl+R `filter:lens-correction`, Shift+Ctrl+J
`layer:via-cut`, Shift+Ctrl+B `image:auto-color`, Shift+Ctrl+I `select:inverse`, Shift+Ctrl+U `image:adjust-desaturate`,
Shift+Ctrl+X `filter:liquify`, Ctrl+H `view:extras`) the type command of that key. The type session's `handle` uses it
(B.8); nothing else duplicates the mapping.

**M.5 UI state** (`app.syncUiState`, added keys): `selectedCount` (selected layers), `effectsHidden` (active layer's
`styles.hidden`), `hasVectorMask`, `vectorMaskEnabled`, `typeEditing`, `smartGuides`, `lockGuides`, `snapTo`
(comma list of the enabled Snap To targets), `patternPreview`.

**M.6 Stubs.** Each package's MODULES entry is created by the skeleton as a stub whose `install(app)` calls
`stubCommands(app, [...])` with the package's new ids (M.7) and nothing else. A package replaces its entry file.
`lib/stubs-later.js` stubs `edit:menus`. The new adjustment kinds are placeholder kinds in `adjust-color.js`
(`placeholderAdjustment(name, defaults, { layer: true })`), so their commands exist disabled through the adjustment
registry. Tools (Triangle, Adjustment Brush) need no stub: a tool exists when its package registers it. Two ids are
**registered working by the skeleton** instead of stubbed, because a key moves to them and an existing spec presses
that key: `type:toggle-panels` (the options-bar button; shows the Character panel, and the Paragraph panel when it is
registered) and `layer:merge` (0.3's Ctrl+E: it runs `layer:merge-down` and reports it with `setReplayCommand`;
finish-layer-menu re-registers it with the context-dependent dispatch). Both are listed with their package and are not
in `app.stubbed`.

**M.7 Every new command id.** Menu place, key, what exists until the owner lands, owner.

| Id | Menu place | Key | Until the owner lands | Owner |
|---|---|---|---|---|
| `window:panel-paragraph` | Type > Panels; Window | none | stub | type-paragraph-panel |
| `type:toggle-panels` | none (Type tool options bar button) | none (Photoshop has none) | working (skeleton) | type-paragraph-panel keeps it working when its panel registers |
| `type:reset-character` | Character panel menu | none | stub | type-character-panel |
| `type:reset-paragraph`, `type:hyphenation-settings`, `type:justification-settings` | Paragraph panel menu | none | stub | type-paragraph-panel |
| the 36 `type:*` ids of TYPE_KEYS (`size-up`, `size-down`, `size-up-10`, `size-down-10`, `leading-down`, `leading-up`, `leading-down-10`, `leading-up-10`, `kern-down`, `kern-up`, `kern-down-100`, `kern-up-100`, `baseline-up`, `baseline-down`, `baseline-up-10`, `baseline-down-10`, `align-left`, `align-center`, `align-right`, `align-justify-left`, `align-justify-all`, `toggle-faux-bold`, `toggle-faux-italic`, `toggle-underline`, `toggle-strike`, `toggle-all-caps`, `toggle-small-caps`, `toggle-superscript`, `toggle-subscript`, `reset-scale-x`, `reset-scale-y`, `auto-leading`, `reset-tracking`, `toggle-hyphenation`, `toggle-composer`, `hide-selection`) | none | TYPE_KEYS | stub | type-editing |
| `edit:paste-without-formatting` | Edit > Paste Special | none | stub | type-editing |
| `edit:toggle-last-state` | Edit | Alt+Ctrl+Z | stub (`undoLike: true`) | conventions-shortcuts-fields |
| `edit:search` | Edit | Ctrl+F | stub (`record: false`) | conventions-shortcuts-fields |
| `edit:menus` | Edit | Alt+Shift+Ctrl+M | stub (`stubs-later.js`) | shortcuts-editor (0.5) |
| `image:adjust-color-vibrance`, `image:adjust-clarity-dehaze`, `image:adjust-grain` | Image > Adjustments; Layer > New Adjustment Layer (`layer:new-adjustment` args) | none | placeholder kinds (disabled) | adjust-color |
| `image:adjust-levels-last`, `-curves-last`, `-hue-saturation-last`, `-color-balance-last` | none (Photoshop has none) | Alt+Ctrl+L / M / U / B | stub | adjust-tonal |
| `layer:style-create-layers`, `layer:style-toggle-all`, `layer:style-scale` | Layer > Layer Style | none | stub | layer-style-blending |
| `layer:vector-mask` | Layer > Vector Mask; Layer > Rasterize > Vector Mask | none | stub | masks-vector-masks |
| `layer:mask-overlay` | none (Properties mask section) | \ | stub | masks-vector-masks |
| `layer:mask-overlay-options` | none (Properties mask section, Channels panel menu) | none | stub | masks-vector-masks |
| `path:make-mask`, `path:make-shape` | none (path tools' options bar buttons, Paths panel) | none | stub | masks-vector-masks |
| `layer:copy-shape-attributes`, `layer:paste-shape-attributes` | none (Layers panel context menu of shape layers) | none | stub | shapes-live |
| `layer:collapse-all-groups`, `layer:panel-options` | none (Layers panel menu) | none | stub (`record: false`) | layers-panel-depth |
| `layer:merge` | Layer (Merge Down / Layers / Group) | Ctrl+E | working (skeleton: Merge Down) | finish-layer-menu |
| `layer:merge-group` | none (reached through `layer:merge`; Layers panel menu) | none | stub | finish-layer-menu |
| `layer:arrange-reverse` | Layer > Arrange | none | stub | finish-layer-menu |
| `layer:lock-dialog`, `layer:lock-group` | Layer | Ctrl+/ (`lock-dialog`), none | stub | finish-layer-menu |
| `layer:select-similar` | Select | none | stub | finish-layer-menu |
| `layer:new-no-dialog` | none | Alt+Shift+Ctrl+N | stub | finish-layer-menu |
| `layer:stamp-visible`, `layer:stamp-selected` | none (Photoshop has none) | Alt+Shift+Ctrl+E, Alt+Ctrl+E | stub | finish-layer-menu |
| `layer:select-forward`, `-backward`, `-front`, `-back`, `-add-forward`, `-add-backward` | none | Alt+] Alt+[ Alt+. Alt+, Shift+Alt+] Shift+Alt+[ | stub | finish-layer-menu |
| `layer:lock-transparency-toggle` | none | / | stub | finish-layer-menu |
| `layer:opacity-digit-0` … `-9`, `layer:fill-digit-0` … `-9` | none | digits, Shift+digits | stub | finish-layer-menu |
| the 24 `layer:blend-mode-*` ids | none | Shift+Alt+letter | stub | finish-layer-menu |
| `layer:blend-next`, `layer:blend-prev` | none | Shift+=, Shift+- | stub | finish-layer-menu |
| `view:smart-guides` | View > Show | none | stub | guides-snapping |
| `view:snap-to` | View > Snap To | none | stub | guides-snapping |
| `view:lock-guides` | View > Guides | Alt+Ctrl+; | stub | guides-snapping |
| `view:clear-artboard-guides`, `view:clear-selected-guides`, `view:new-guide-layout`, `view:guides-from-shape`, `view:edit-selected-guides` | View > Guides | none | stub | guides-snapping (declares `changesDocument: true` on these) |
| `view:new-guide`, `view:clear-guides` (existing ids, new owner) | View > Guides | none | app.js's 0.3 commands, marked `changesDocument: true` by the skeleton | guides-snapping re-registers both from `lib/guides.js` (New Guide dialog with colour; Clear Guides on the collection); the app.js registrations are the skeleton's placeholders (rule 3) |
| `view:ruler-unit`, `view:ruler-origin-reset` | none (ruler context menu) | none | stub (`ruler-origin-reset`: `changesDocument: true`) | guides-snapping |
| `view:pattern-preview` | View | none | stub | patterns |
| `window:panel-gradients`, `window:panel-patterns` | Window | none | stub | gradients, patterns |

`type:box-size` (type-editing's Alt-click dialog) is an internal function, not a command.

**M.8 Changed default bindings and the existing specs.** Every binding whose command changes, and every e2e line that
presses the old key (grep of `tests/e2e/*.mjs` for `press(` and `keyboard.down`; the Electron test presses no key):

| Key | 0.3 | 0.4 | Spec lines pressing it | Change (skeleton, step) |
|---|---|---|---|---|
| Ctrl+F | `filter:last` | `edit:search` | `editing.spec.mjs:144`, `filters-b.spec.mjs:173`, `hunt4-sessions.spec.mjs:364, 421, 426, 441` | `press('Control+f')` → `press('Control+Alt+f')` (step 10) |
| Alt+Ctrl+Z | `edit:step-backward` | `edit:toggle-last-state` | none | |
| Alt+Shift+Ctrl+Z | `edit:step-forward` | none | none | |
| Ctrl+Y | `edit:redo` (renderer) | `view:proof` | none (specs redo with Control+Shift+z or the command) | |
| Alt+Shift+Ctrl+S | `file:export` | `file:save-for-web` | none | |
| Alt+Shift+Ctrl+E | `file:export-quick` | `layer:stamp-visible` | none | |
| Ctrl+/ | `help:shortcuts` | `layer:lock-dialog` | none | |
| Cmd+, (macOS) | `edit:preferences` | `layer:visibility` | none | |
| Ctrl+E | `layer:merge-down` | `layer:merge` | `layers.spec.mjs:26` (one layer selected after `setActive`) | none: `layer:merge` merges down with one layer selected, and the skeleton registers it working (M.6) |
| Ctrl+B / I / U, Ctrl+Shift+> / < inside a type session | the 0.3 editor's bold / italic / underline / size | TYPE_KEYS (Shift+Ctrl+B / I / U, Shift+Ctrl+. / ,) | none (`editing.spec.mjs:115` and `actions.spec.mjs:126` press Control+i outside a type session: Invert, unchanged) | |
| digits, Shift+digits, `/`, `\`, Shift+=, Shift+-, Alt+[ ] , ., Shift+Alt+letters | unbound | M.4 | none outside a text field (the specs press Escape, Enter, Delete, Backspace, Tab, Home, End, arrows, F9, Shift+F9, Shift+B and tool letters) | |

The other three edited lines are not keys: `actions.spec.mjs:570` and `:1081` compare `doc.guides` with `toEqual([{
axis, pos }])` and become `toMatchObject` (guides gain `id`, D); `files.spec.mjs:44` does `d.guides.push(…)` on the
frozen array and becomes `d.guides = [...d.guides, { axis: 'x', pos: 33 }]` (step 3).

#### N. Failed settings write

0.3's browser bridge swallows a failed `localStorage.setItem` (`storage.set` catches everything) and the app logs a
failed `setSettings` with `console.warn` only, so a full storage loses settings silently.

- Browser bridge: `storage.set` returns `false` on an exception; `setSettings(patch)` then rejects with an `Error`
  whose `code` is `'storage-quota'` (`QuotaExceededError`) or `'storage-unavailable'`, after updating its in-memory
  copy (the session keeps working). `window.__pigmentTest.failSettingsWrite = 'quota' | 'unavailable'` simulates it.
- Electron: `ipc.js setSettings` already rejects when `JsonStore.save` fails; the rejection carries `code: 'write-failed'`
  and the system error message.
- App (`app.js`): `saveSettings` and `saveSettingsSoon` catch and call `app.reportWriteFailure('settings', err)`, which
  shows one error toast per area and code per session ("Settings could not be saved (the browser storage is full).
  Changes made now are lost when Pigment closes."), emits `'settings:write-failed'` `{ area, code }` and writes a
  `console.warn`. The preset store reports through the same function with area `'presets'`.

#### O. Bridge and main-process additions (skeleton)

- **Menu command source.** `main.js runCommand(cmd, arg, viaKey)` sends `pigment:event:command` with a third value;
  the bridge passes it on and `app.js` runs `app.commands.run(cmd, arg, viaKey ? 'menu-key' : 'menu')`. The browser
  build has no native menu and never produces either source.
- **Shift+Alt+letter on Windows and Linux.** The 24 blend-mode keys share letters with the menu mnemonics (`&File`,
  `&Edit`, `&Image`, `&Layer`, `&Select`, `Fil&ter`, `T&ype`, `&View`, `&Window`, `&Help`). `main.js` listens to
  `webContents.on('before-input-event')`: on win32 and linux, a keyDown with Shift and Alt, without Ctrl or Meta, whose
  accelerator is in RENDERER_KEYS calls `event.preventDefault()` (no mnemonic, no page keydown) and sends the command
  over the same channel as a key (`app.commands.run(cmd, undefined, 'key')`). A new Electron test,
  `tests/electron/keys-04.spec.mjs`, sends Shift+Alt+F with `webContents.sendInputEvent` and asserts, through a command observer, that `layer:blend-mode-soft-light` was
  dispatched once with source `'key'` (it is a disabled stub until finish-layer-menu lands; the observer still sees it).
- **`bridge.readClipboardText(): Promise<string>`**: preload `pigment.readClipboardText` → ipc `readClipboardText`
  (`clipboard.readText()` in `main/clipboard.js`); the browser build uses `navigator.clipboard.readText()` and, when
  `window.__pigmentTest.clipboardText` is a string, returns that instead (the specs already set it through
  `writeClipboardText`). type-editing's `edit:paste-without-formatting` uses it when run from the menu.

### Packages

Ports for `PIGMENT_E2E_PORT`: skeleton 8800, then 8801 to 8816 in the order below. "Stub ids" are the ids the
skeleton's stub entry registers and the package must register for real (M.7). "Same release" says what the package
needs from another 0.4 package and what it builds against until that lands.

#### 1. type-engine-core (port 8801, entry `lib/type/layout.js`)

Owns its new files, `text-path.js`, `package.json` (the dependency), and `lib/type/model.js` and `lib/type/api.js`
once the skeleton has landed (changes to the attribute list or the facade's signatures are announced to the
integrator: four packages build on them). Delivers paragraph text in a box with width and height, the overflow flag,
several character formats and per-paragraph formats in one layer, tracking in 1/1000 em that keeps kerning,
ligatures and complex scripts, colour and emoji fonts. Reads font files with `queryLocalFonts()` and `blob()` where
the platform allows (Electron already grants `local-fonts`, `main.js ALLOWED_PERMISSIONS`; the browser build asks
for the permission and falls back to the stub engine's Canvas measurement; `tools/text.js` keeps its family list for
the options bar, `fonts.js` loads faces by family on demand and calls `fontsChanged()` when faces arrive, B.4), shapes
with HarfBuzz (MIT, wasm, vendored by `scripts/vendor/harfbuzz.mjs`; CSP already allows `'wasm-unsafe-eval'`), draws
glyph outlines with `Path2D` and colour glyphs (COLR, CBDT, sbix, emoji) with `fillText` per cluster at the shaped
positions. Registers engine `'harfbuzz'` with `supports(layer)` (false while the wasm or a run's face data is missing:
the stub draws the layer) and the font provider (`available: true`, `metrics`, `hasFeature`, `outline`, `advances`,
`addFontData`; it also sets `window.__pigmentTest.addFont(bytes, meta)` in the browser build); keeps the first-baseline
rule of A; calls the composer, breaker, hyphenator, kerner and list formatter of B; moves `text-path.js` to
`shapeText()` / `glyphRuns()` (emoji, marks and kerning survive on a path; the stacked and rotated modes keep their
output; the extension never calls `layoutText`). **Provides:** glyph outlines (type-character-panel's optical kerning;
Create Work Path in 0.5), metrics (caps, super/subscript and underline positions from the font), the engine every type
package renders with. **Same release:** none needed; the type packages build against the stub engine. **Tests:** unit
`type-engine-core.test.mjs` (line layout from given advances: box width and height, overflow, tabs, alignment, space
before/after, leading, the first baseline at 0.8 × size; shaping of the test font in Node if harfbuzzjs runs there,
else in e2e); e2e `type-engine-core.spec.mjs`, which loads the OFL test font of `tests/fixtures/fonts/` through
`__pigmentTest.addFont` so HarfBuzz runs in the browser build (a layer with two runs of different size and colour
renders both, round-trips `.pigment`; a box with a height overflows and reports it; tracking keeps "fi" as one ligature;
an emoji ZWJ sequence stays one cluster; text on a path still follows the path; a layer drawn before its font arrived
redraws when it arrives). **Done:** the HarfBuzz engine is the default, every existing text spec passes on it (where
pixels move by antialiasing the old spec's tolerance is kept, not widened), the stub engine stays registered as the
fallback, and the skeleton smoke spec, which pins `'canvas'`, still passes.

#### 2. type-editing (port 8802, entry `lib/type/editor.js`)

Owns `tools/text.js`, `lib/type/target.js` (after the skeleton) and its new files. Delivers the 13 features of its
brief: an own caret and selection drawn over the layout (`hitTest`, `caretRect` with `angle`, `selectionRects` quads,
so path and stacked text keep working through B.5), a hidden `<textarea>` that carries IME composition (underlined
composition text) and dead keys and mirrors the selection (B.8), selection by drag and 2/3/4/5 clicks (word, line,
paragraph, all) and Ctrl+A, tab characters, session undo/redo (content snapshots; commit is one history entry),
formatted cut/copy/paste between type layers (an in-app clipboard `{ content, text }` used when the system clipboard's
text still equals its `text`; system text/plain always written) and `edit:paste-without-formatting` (from the menu
through `bridge.readClipboardText()`), eight box handles for width and height (snap source `'type-box'`; a dragged
box stores `height`), Ctrl/Cmd showing the transform box (through `app.transformTool`, back to editing after),
Ctrl-drag or drag outside the text to move it, Alt-click for the box-size dialog, placeholder text
(`settings.type.placeholder`, preference section `type`), double-click with the Move tool (`registerLayerDoubleClick
('text', …)`), the overflow indicator (+ in the bottom-right handle) from `layout.overflow`, and the TYPE_KEYS commands
(M.4) on `lib/type/target.js`. Installs the selection provider of `target.js` (calling `selectionChanged` on every
selection move) and replaces the `'type'` session entry with B.8's (policy `'commit'`, `ownsFocus`, `handle`). Keeps
the stable surface of B.8 and sets `claimsModifiers` / `paints: false` on the type tools (L.12). **Stub ids:**
`edit:paste-without-formatting` and the 36 `type:*` ids of TYPE_KEYS. **Same release:** engine (stub engine),
Character and Paragraph panels (they act through `target.js`, independent). **Tests:** unit `type-editing.test.mjs`
(selection levels with `Intl.Segmenter`, session undo stack, clipboard merge rules); e2e `type-editing.spec.mjs` (type,
select a word by double-click, apply bold through the type target, undo inside the session through Edit > Undo and
Ctrl+Z, commit gives one entry; copy two runs and paste into another layer keeps both; Paste Without Formatting from the
command with `__pigmentTest.clipboardText`; IME composition via `CompositionEvent`; Move tool double-click starts
editing; box handles change width and height; TYPE_KEYS change size and alignment; Shift+Ctrl+L while editing aligns
left and records no Auto Tone; a menu command run with source `'menu'` commits the text first). **Done:** the 0.3
textarea overlay is gone; every existing text spec passes (the ones that type through `page.keyboard` keep working
through the hidden textarea).

#### 3. type-character-panel (port 8803, entry `lib/type/char-format.js`)

Owns `panels/character.js` (rewritten), `lib/properties/text.js` and its new files; registers the `font-size` option
kind and `type:reset-character`. Delivers every field of the Character panel on the range model (`readChar` /
`applyChar`, mixed values shown blank, re-read on `'type:selection'`), units (pt, px, mm through `settings.type.unit`,
converted with the document resolution; the model stays in px), the preset size list, leading with Auto, kerning
Metrics / Optical / manual, vertical and horizontal scale, baseline shift, faux bold / italic as toggles independent of
the face, caps, super and subscript, underline, strikethrough, language (the list is `hyphenationLanguages()` plus the
languages of the document's text), fractional widths, system layout and the other type options through
`applyTypeOptions`, point / paragraph conversion and box width through `applyBox`, no break, Reset Character, the panel
menu, and the editable Properties text section (transform stays the skeleton's section; paragraph controls come from
type-paragraph-panel's section). Renders `typeSections('character')` with row ids (L.14). New-text defaults go through
`setTypeDefaults` (B.7). Optical kerning: `registerKerner('optical', fn)` computed from `fonts.outline`; with the stub
provider (`available: false`) the panel shows Optical and the engine falls back to Metrics. The font family control
stays a plain select until type-fonts (0.5), which replaces it through `replaces: 'family'`. **Stub ids:**
`type:reset-character`. **Same release:** the engine's outlines and metrics (stub: null / approximate), type-editing's
selection provider (stub: the 0.3 textarea selection, which already reports `selectionChanged`). **Tests:** unit
`type-character-panel.test.mjs` (unit conversions, optical kerning on synthetic outlines, mixed-value display); e2e
`type-character-panel.spec.mjs` (size in pt at 300 ppi stores the right px; a range made bold keeps the rest regular,
also after typing one more character (A `replacePlain`); leading Auto; Reset Character; moving the caret updates the
panel). **Done:** every listed field works on a range and on several selected layers with one undo entry each.

#### 4. type-paragraph-panel (port 8804, entry `lib/panels/paragraph.js`)

Owns its new files and `lib/properties/paragraph.js`; registers the Paragraph panel (group `'middle'`, after
Character) and `type:reset-paragraph`, `type:hyphenation-settings`, `type:justification-settings`. Delivers the
seven alignments, indents, space before/after, Hyphenate and the Hyphenation dialog, Justification settings, Roman
Hanging Punctuation, the Single-line (greedy with Adobe's cost rules) and Every-line (Knuth–Plass) composers
(`registerComposer`; they use `spaceWidth` and `hyphenWidth` and apply `limit`, `zone` and `lastWord`), line-break
opportunities by UAX 14 (`registerBreaker`, falling back to space-only breaks for `breakRules: 'legacy'`), TeX
hyphenation patterns per language (`registerHyphenator(fn, { languages })`; bundle en-US, en-GB, de, fr, es, it, nl, pt
and check each pattern file's licence), bulleted and numbered lists (`registerListFormatter`), Reset Paragraph. Renders
`typeSections('paragraph')` (L.14); the Hyphenation and Justification dialogs read `readPara(app, { deep: true })` so
each field shows its own mixed state. **Stub ids:** `window:panel-paragraph`, `type:reset-paragraph`,
`type:hyphenation-settings`, `type:justification-settings`. **Same release:** the engine calls the composers (the stub
engine does too, so the package tests on it). **Tests:** unit `type-paragraph-panel.test.mjs` (Knuth–Plass on fixed
box widths gives the known optimum; UAX 14 classes for a sample set; `'legacy'` rules give 0.3's breaks; hyphenation of
a word list with the before/after/minWord filters; list numbering); e2e `type-paragraph-panel.spec.mjs`. **Done:** a
paragraph layer with justify-all and hyphenation lays out with the every-line composer; the panel edits the paragraphs
under the selection; a version 2 document (`composer: 'single'`, `breakRules: 'legacy'`) keeps every line of 0.3,
including "well-known" and CJK text.

#### 5. layer-style-blending (port 8805, entry `lib/blending-options.js`)

Owns `compositor.js`, `lib/blending-options.js`, `src/shared/pixels/blend-if.js`. Delivers the Blending Options page
(on L.3's `ctx.advanced`: fill opacity, channels R/G/B, knockout none/shallow/deep, Blend Interior Effects as Group,
Blend Clipped Layers as Group, Transparency Shapes Layer, Layer Mask Hides Effects, Vector Mask Hides Effects, Blend If
with split sliders), the compositor work of K.3 (per-pixel path only when `effectiveBlending` is not default; the 0.3
fast path otherwise; the mask parts before and after the styles; group styles with their cache), styles on groups
(`isStyleable` admits groups and refuses the Background through `app.backgroundRules`; a pass-through group with
effects composites as an isolated group, as Photoshop does), `layer:style-create-layers` (layers from `splitEffects` in
its documented order: exterior below, interior clipped above), `layer:style-toggle-all` (`styles.hidden`),
`layer:style-scale` (`scaleEffects`). Keeps every K.1 / K.2 call, the adjustment `ctx` and the margin growth (I.4) of
the skeleton. **Stub ids:** the three commands. **Same release:** layer-style-effects (`interiorAsGroup`,
`transparencyShapes`, `split`, exact `splitEffects`: the specs that need them skip while `STYLE_FEATURES` says false),
masks-vector-masks (K.1 stub: `parts: 'vector'` gives null). **Tests:** unit `layer-style-blending.test.mjs` (Blend If
ranges with split points, channel flags, knockout arithmetic on ImageData, the parts split of the hides-effects boxes);
e2e `layer-style-blending.spec.mjs` (knockout deep through a group shows the background; Blend If hides the dark pixels
of the upper layer; a group takes a drop shadow; Hide All Effects; Scale Effects 50 % halves sizes of two shadows;
Create Layers on a drop shadow; Blending Options edits are undone by Cancel and recorded by OK). **Done:** a document
without blending options renders bit-identically to 0.3 (existing compositor and style specs pass), the measured
repaint time of a 4000 px document with default options does not grow, and a brush dab next to a styled group does not
re-run its styles.

#### 6. layer-style-effects (port 8806, entry `lib/contour-editor.js`)

Owns `styles.js`, `style-ui.js`, `lib/style-prepare.js` and its new files; registers the `contour` widget and the
`contours` preset kind. Delivers the 14 features of its brief: every effect's Photoshop fields (J.6), contours and the
Contour Editor with presets, noise, Bevel & Emboss Contour and Texture sub-effects, gradient and pattern fills through
the shared widgets (Gradient Overlay and Stroke with the G.1 placement fields flat on the effect, `'shape-burst'` for
Stroke; pattern fills as `PatternRef` with `dataUrl`), multiple instances (+ / reorder / delete in the effect list),
dragging in the document to position shadows, satin and overlays while the dialog is open (`canvasCapture` +
`setCanvasThrough`), the `applyStyles` options `interiorAsGroup`, `transparencyShapes` and `split`, exact
`splitEffects`, and `scaleEffects` for every pixel field it adds; sets `STYLE_FEATURES`. Keeps the skeleton's
`blending` handling in `styleDialog` (L.3) and `mergeStyles`' `hidden` and arrays. **Same release:** gradients and
patterns fill the `gradient` and `pattern` widgets (stubs: two-colour editor and the current pattern);
layer-style-blending owns the Blending Options page. **Tests:** unit `layer-style-effects.test.mjs` (contour LUTs, every
new field changes numbers as specified, an effect with all new fields at their defaults gives 0.3's pixels exactly,
each `applyStyles` option, `split` parts recomposite to the merged image, `splitEffects` order;
`tests/unit/styles.test.mjs` passes unchanged); e2e `layer-style-effects.spec.mjs` (two drop shadows, contour change,
texture, drag-to-position). **Done:** effect output of 0.3 documents unchanged; a document with instances and contours
round-trips `.pigment`.

#### 7. adjust-tonal (port 8807, entry `lib/adjust/tonal.js`)

Owns `adjust-ui.js`, `src/shared/pixels/adjust.js` (the tonal kinds that stay there after the split),
`lib/adjust/frame.js`, `lib/adjust/presets.js` and its new files; registers the `preset` widget, the preset kinds
`adjustment:levels`, `:curves`, `:exposure`, `:brightness-contrast`, `:threshold` with Photoshop-like built-ins, and
the `.alv` and `.acv` formats. Delivers Brightness/Contrast, Levels (channel menu by document mode through `space`,
J.9; sliders, histogram, black / grey / white eyedroppers, Auto and Auto Options, clipping preview with Alt-drag),
Curves (points, channels, pencil mode (`{ table }`) and Smooth, eyedroppers, the on-image tool, display options, Show
Clipping, presets, Auto), Exposure, Threshold, Equalize (asks about the selection), adjustment presets, Auto Color
Correction Options, and `image:adjust-levels-last`, `-curves-last`, `-hue-saturation-last`, `-color-balance-last` (open
with the last-used values; the plain commands open with the defaults, Photoshop's behaviour: release-note line). Declares
`deepExact` for Levels and Curves (J.9). Keeps the skeleton's frame, `sampleBelow`, `prepare` call and adjustment `ctx`
in `adjust-ui.js`. **Stub ids:** the four `-last` commands. **Provides:** the frame and the preset widget for
adjust-color. **Tests:** unit `adjust-tonal.test.mjs` (auto algorithms, drawn-curve tables, clipping masks, `space`
conversions, `.acv` and `.alv` round trips); e2e `adjust-tonal.spec.mjs` (click the white eyedropper then the canvas
while Levels is open sets the white point; save and load a Levels preset; Alt+Ctrl+L reopens the last values; the
Curves on-image tool adds a point; the same editor in Properties for a Levels layer, its eyedropper sampling the full
resolution composite below). **Done:** the 0.3 adjustment specs pass.

#### 8. adjust-color (port 8808, entry `lib/adjust/color.js`)

Owns `src/shared/pixels/adjust-color.js` (hue-saturation, black-white, photo-filter, channel-mixer, gradient-map,
shadows-highlights moved there by the skeleton, and the new kinds `color-vibrance`, `clarity-dehaze`, `grain`),
`adjust-more-ui.js`, `panels/adjustments.js`, `lib/properties/adjustment.js` and its new files; registers the preset
kinds and formats of its kinds (`.ahu`, `.cha`, `.blw`, …). Delivers Hue/Saturation with Master and editable colour
ranges (J.9 `ranges`), range sliders and range eyedroppers, the on-image tool and presets; Black & White (Auto,
presets); Photo Filter; Channel Mixer; Gradient Map with the `gradient` widget (`placement: false`; Reverse, Dither,
interpolation); Shadows/Highlights with Show More Options; HDR Toning additions (its flatten confirmation moves to
`prepare`, I.2, and the 0.3 wrapper is deleted); the three new kinds as adjustment layers (Clarity, Dehaze and
Shadows/Highlights declare `margin`, Grain seeds from `ctx.origin`, I.4, so partial repaints match full ones); the
Properties controls for adjustment layers (the I.1 frame in panel mode with `sampleBelow`, disposed by the host:
previous-state toggle, presets, Auto, on-image tool); adjustment presets in the Adjustments panel; the Adjustment Brush
tool (a masked adjustment layer whose mask it paints; `paints: true`, L.12). Old params (single-range Hue/Saturation,
0.3 Gradient Map stops) are read unchanged; a kind whose new params `deep.js` cannot reproduce declares
`deepExact(params) => false`. **Same release:** adjust-tonal (frame, preset widget: stubs work), gradients (gradient
widget: stub). **Tests:** unit `adjust-color.test.mjs` (multi-range numbers; old params give 0.3's pixels exactly; the
new kinds; Grain identical for a document and for any sub-rectangle with its `ctx`); e2e `adjust-color.spec.mjs`.
**Done:** the three new kinds lose `placeholder` and appear enabled in both menus.

#### 9. gradients (port 8809, entry `lib/panels/gradients.js`)

Owns `tools/fill.js`, `gradient-model.js` (after the skeleton), `lib/properties/fill.js` and its new files; registers
the `gradient` widget, the `'gradient'` paint renderer and paint editor, the `gradients` preset kind, the Gradients
panel (group `'top'`, after Swatches) and the `application/x-pigment-gradient` drop handler (E25). Delivers New Fill
Layer: Gradient, live gradients (the Gradient tool's Gradient mode makes and edits a Gradient Fill layer through the
on-canvas widget; Classic mode paints pixels as in 0.3), the picker and presets with groups, the Gradient Editor
(colour and opacity stops, midpoints, smoothness, New / Save / Import / Export through the preset store), noise
gradients, the five interpolation methods (in the reference sampler and `gradient-render.js`), the Gradients panel
(drag onto a layer row or the canvas makes a Gradient Fill). Every writer resolves colour references (G.1); the
renderer honours G.3's `box` and `origin`. Maps the tool's 0.3 `preset` option (an index) to preset ids. **Stub ids:**
`window:panel-gradients`. **Provides:** the `gradient` widget (layer-style-effects, shapes-live, adjust-color).
**Tests:** unit `gradients.test.mjs` (render vs reference sampler for every kind and method within ±1; noise
determinism per seed; a shape gradient keeps its place when the stroke widens); e2e `gradients.spec.mjs`. **Done:**
every gradient in Pigment (tool, fill layers, shapes, Gradient Map, Gradient Overlay, Stroke) goes through the model.

#### 10. patterns (port 8810, entries `lib/panels/patterns.js`, `lib/tools/bucket.js`)

Owns `patterns.js`, `edit-ops.js`, `modes/dialogs.js`, `lib/tools/bucket.js` and its new files; registers the
`pattern` widget, the `'pattern'` paint renderer and paint editor, the `patterns` preset kind (pixels in blobs), the
Patterns panel (group `'top'`) and the `application/x-pigment-pattern` drop handler (E25). Delivers `app.patterns`
backed by the preset store (persistent; `ref()` and `resolve()` with embedded `dataUrl`, L.6), Define Pattern with a
name dialog, Fill with Pattern and the picker, Scripted Patterns (Brick Fill, Cross Weave, Place Along Path, Random
Fill, Spiral, Symmetry Fill), Bitmap's Custom Pattern through the widget, Pattern fill layers with Angle, Link with
Layer and Snap to Origin, Pattern Preview (`view:pattern-preview`, a view underlay), the Paint Bucket's pattern source
(keeping its `sampleMerged` call). Old documents keep their embedded patterns. **Stub ids:** `window:panel-patterns`,
`view:pattern-preview`. **Provides:** the `pattern` widget and `app.patterns` (layer-style-effects texture and overlay,
shapes-live, Pattern Stamp). **Tests:** unit `patterns.test.mjs` (scripted pattern placement determinism per seed); e2e
`patterns.spec.mjs` (define, restart keeps it (the browser backend persists), fill, a style using a deleted preset still
renders, Pattern Preview draws around the canvas, drag from the panel makes a Pattern Fill).

#### 11. guides-snapping (port 8811, entry `lib/guides.js`)

Owns `canvas-view.js`, `tools/move.js`, `lib/snap.js`, `lib/rulers.js` and its new files; writes the `rulerOrigin`
collection (registered by the skeleton), registers the `guides` preference section and `'grid'` / `'layer'` snap
targets. Delivers guides as store objects (colour per guide, selection with the Move tool, move and delete individual
guides, Edit Selected Guides, Clear Selected / Canvas / Artboard Guides, Lock Guides), New Guide (dialog with colour;
the recorder stores the colour), New Guide Layout, New Guides From Shape, rulers (units, ruler origin by dragging the
corner, double-click to reset, context menu) with `app.rulers` so Info, Properties and Free Transform read the same
origin and units, grid colour, style, Gridline Every and Subdivisions, View > Snap To targets, `app.snap` for every
source of F (with `pointer`, `exclude`, `excludeGuides`, `axis`), `app.snap.end()` from canvas-view, Smart Guides with
spacing and Ctrl-hover distances. Declares `changesDocument: true` on every guide command that changes the document
(E31), and takes over `view:new-guide` and `view:clear-guides` from app.js (M.7). Keeps the skeleton's canvas capture,
view underlays, mask view, drop-handler and `p.temporary` code in canvas-view.js. **Stub ids:** `view:smart-guides`, `view:snap-to`, `view:lock-guides`, `view:clear-selected-guides`,
`view:clear-artboard-guides`, `view:new-guide-layout`, `view:guides-from-shape`, `view:edit-selected-guides`,
`view:ruler-unit`, `view:ruler-origin-reset`. **Tests:** unit `guides-snapping.test.mjs` (snap priorities and
tolerance, Ctrl and `temporary`, layout math, ruler conversions with an origin); e2e `guides-snapping.spec.mjs` (also:
Clear Selected Guides refused while a slow operation runs and refused inside Blur Gallery). **Done:** the marquee,
crop, shapes, pen, Free Transform and guide drags snap to guides, grid, layers and the document per the menu.

#### 12. masks-vector-masks (port 8812, entry `lib/vector-mask.js`)

Owns `panels/paths.js`, `lib/mask-render.js`, `lib/mask-view.js`, `lib/properties/mask.js` and its new files;
registers the `'vector-mask'` path target kind (with `remove`, `rename`, `toSaved`), the Mask and Shape path buttons
and the `masks` preference section. Delivers non-destructive density and feather on both mask kinds (K.1 with `parts`),
mask view modes (mask alone, rubylith overlay with colour and opacity: `layer:mask-overlay`,
`layer:mask-overlay-options`), `layer:vector-mask` (all args, including `'target'` and `'select'` from the Layers
panel row, L.15), `initialFill` (J.1), rasterising a vector mask into the layer mask, the Properties mask controls
(density, feather, Select and Mask, Color Range, Invert, the vector mask row), `path:make-mask` and `path:make-shape`
(`createShapeLayer`), the vector mask row in the Paths panel, the thumbnail of the Layers panel row
(`vectorMaskThumb`) and vector masks from paths. Refuses masks on what `app.backgroundRules.lockedProps` locks. The
vector mask is edited with the path tools through its target (preview writes `layer.vectorMask.path` like the shape
target). **Stub ids:** `layer:vector-mask`, `layer:mask-overlay`, `layer:mask-overlay-options`, `path:make-mask`,
`path:make-shape`. **Same release:** layer-style-blending calls K.1 with the parts of K.3 (its own fast path must not
bypass it), shapes-live owns `vector.js` (L.4 suffices). **Tests:** unit (pure mask maths in a file of its own under
`src/shared/pixels/` if it adds one); e2e `masks-vector-masks.spec.mjs` (density 50 % halves the mask, feather blurs it,
Apply bakes only the raster part and keeps the vector mask; a vector mask hides outside the path, moves with the layer,
survives `.pigment`, exports to PSD baked; Hide All and Reveal All differ; a 16-bit document with a vector mask
flattens like the 8-bit one).

#### 13. shapes-live (port 8813, entry `lib/shape-props.js`)

Owns `tools/vector.js`, `path-ops.js`, `lib/properties/shape.js` and its new files; registers the `paint` widget and
the `stroke-styles` preset kind. Delivers live shape properties in Properties (W/H/X/Y, angle, per-corner radii,
polygon and line parameters; the section `hides: ['transform']` for live shapes), the Triangle tool, Polygon sides /
star ratio / smooth corners and indents, Line weight and arrowheads, fills and strokes with none / solid / gradient /
pattern (paints placed by G.3's `box` and `origin`, no stored from/to), stroke caps, joins, alignment, dashes and dash
presets, geometry options (the tools' gear menu), Copy / Paste Shape Attributes, click-on-canvas Create dialogs and the
Rounded Rectangle radius. Shapes keep their parameters and regenerate the path (J.5); `normalizeShapeProps` reads 0.3
shapes, `mapShapeGeometry` keeps them live through moves and transforms (J.2), `shapeBounds` pads for every stroke
option. Sets `claimsModifiers` on the pen, path and shape tools (L.12). **Stub ids:** `layer:copy-shape-attributes`,
`layer:paste-shape-attributes`. **Same release:** gradients and patterns widgets (stubs), masks-vector-masks registers
its target kind and buttons in this file's registries (L.4: keep them and the `createShapeLayer` export). **Tests:**
unit `shapes-live.test.mjs` (path regeneration, arrowhead and corner geometry, every row of the 0.3 reading table,
`mapShapeGeometry` for translation, scale, rotation and skew); e2e `shapes-live.spec.mjs` (also: move a rectangle, then
change its corner radius in Properties: it stays where it was moved).

#### 14. layers-panel-depth (port 8814, entry `lib/panels/layers-menu.js`)

Owns `panels/layers.js`, `layers-extras/find.js` and its new files. Delivers scrubby Opacity and Fill (through
`numericField` with `scrubby` and the multi-layer property commands with `{ ids }`, M.3), lock buttons, the filter bar
(more filter types; isolation honoured by auto-select and, through `app.sampleSkip`, by every merged sample, L.11),
footer buttons with modifiers (New Layer: Alt-click `{ dialog: true }`, Ctrl-click `{ below: true }`), drags (several
rows, Alt-drag copies, into groups, effect rows between layers; drop indicators refuse what
`app.backgroundRules.canPlace` refuses), the eye column (drag across, Alt-click solo), Alt-click between layers to clip
(`layer:clip { id }`), nested groups with masks and pass-through, effect rows under the layer (`effectEntries`,
per-effect eyes through `setEffect`), the panel menu and Panel Options (`settings.layersPanel`), Collapse All Groups,
Isolate Layers, the blend-mode menu with live preview while hovering and arrow-key stepping (`blend-preview.js`). Uses
`layer:move-to` with `{ ids: [...], target, mode, duplicate }` (skeleton). Keeps the skeleton's vector-mask thumbnail
and link icon (L.15) and the drop-handler call (E25) in the rows. Declares `record: false` on its view commands.
**Stub ids:** `layer:collapse-all-groups`, `layer:panel-options`. **Same release:** finish-layer-menu's commands in the
panel menu (stubs until then: the e2e checks those entries only for being present and disabled), layer-style-blending's
group styles (group effect rows are tested at integration), conventions-shortcuts-fields' numeric field (the stub's
`scrubby` drag is enough to test the value path). **Tests:** e2e `layers-panel-depth.spec.mjs`; existing
`layers.spec.mjs` and `hunt2-layers.spec.mjs` pass.

#### 15. finish-layer-menu (port 8815, entry `lib/layer-dialogs.js`)

Owns `layer-ops.js`, `layers-extras/structure.js`, `layers-extras/tags.js` and its new files. Delivers the New Layer
dialog (Name, clip to previous, colour, mode, opacity, neutral fill; before `createPaint` for fill layers), New Group
dialog, Duplicate Layer dialog (as, destination document), all three opening only under M.3's rule, New Fill Layer:
Solid Color through the New Layer dialog, the Rasterize submenu args, Hide / Show Layers and the other property
commands on every selected layer (`setLayersProps` as one merging entry, M.3), Arrange with several layers and Reverse,
the full Distribute submenu, Lock Layers… and Lock All Layers in Group…, links honoured by Align and Distribute (Free
Transform: the skeleton's call in `collectTargets`), Merge Layers / Merge Group through `layer:merge` (Ctrl+E;
`layer:merge-down` keeps its 0.3 meaning; the step recorded is the concrete id through `setReplayCommand`), Stamp
Visible and Stamp Layers, layer navigation, opacity digits (only while `!paints(app.tools.active)`, L.12), `/` lock,
blend-mode keys, Select Similar Layers, and the Background rules through `app.backgroundRules` (L.13: it stays at the
bottom of the stack, cannot be put into a group, nothing can be arranged below it, its blend mode, opacity, mask,
vector mask and styles are locked; Layer from Background, and renaming it, lift all of that). The digit, `/` and
blend-mode keys act only while no text field has focus (painting tools' own uses arrive with 0.5). **Stub ids:**
`layer:merge-group`, `layer:new-no-dialog`, `layer:arrange-reverse`, `layer:lock-dialog`, `layer:lock-group`,
`layer:lock-transparency-toggle`, `layer:stamp-visible`, `layer:stamp-selected`, `layer:select-forward`,
`layer:select-backward`, `layer:select-front`, `layer:select-back`, `layer:select-add-forward`,
`layer:select-add-backward`, `layer:select-similar`, `layer:opacity-digit-0` … `-9`, `layer:fill-digit-0` … `-9`, the
24 `layer:blend-mode-*` ids, `layer:blend-next`, `layer:blend-prev`; it re-registers the skeleton's working
`layer:merge`. **Tests:** e2e `finish-layer-menu.spec.mjs` (every command; dialogs replay through `ctx.setReplayArg`;
`layer:new` from the API, an action and the panel never opens the dialog; Ctrl+E on two selected layers merges them and
an action records `layer:merge-selected`); existing layer specs pass.

#### 16. conventions-shortcuts-fields (port 8816, entry `lib/conventions.js`)

Owns `form.js`, `dialogs.js`, `tools.js`, `shortcuts.js`, `lib/numeric-field.js` and its new files; registers the
`conventions` preference section and replaces the `numeric` widget. Delivers `edit:toggle-last-state` (`undoLike: true`;
through `app.historyStep`), `edit:search` (`record: false`; a palette over the commands with their menu paths from
`menu-template.js` and `app.uiState`, the tools (their `tool:*` commands) and the panels (`window:panel-*`); no Stock
or Learn. Its `run()` opens the palette and returns at once; on a choice the palette closes first, checks
`isEnabled(id)` and that the id is not in `app.stubbed`, then runs `app.commands.run(id, arg, 'menu')` with the
template item's argument), temporary navigation keys (Space, Ctrl+Space, Alt+Space, hold R), spring-loaded tools (hold
a tool key; Ctrl = Move, Alt = Eyedropper for painting tools) through `view.tempTool` and `view.tempToolVia`, never on
a modifier the active tool claims (L.12), tool flyouts and the "Use Shift Key for Tool Switch" preference, scrubby
labels and popup sliders, movable dialogs (positions in `settings.conventions.dialogPositions`) with the canvas visible
and navigable under them (wheel zoom, Space pan, zoom keys; `passesMenu` lets the view commands through so macOS works
like Windows), Alt turns Cancel into Reset (`onReset` in `dialogs.open` and `formDialog`), and the numeric field with
its lazy type switch and the document-level enhancer for every other number input (H). The key changes themselves are
the skeleton's. **Stub ids:** `edit:toggle-last-state`, `edit:search`. **Tests:** unit
`conventions-shortcuts-fields.test.mjs` (the expression parser: `100+50`, `50%`, `2in` at 300 ppi, invalid input keeps
the old value); e2e `conventions-shortcuts-fields.spec.mjs` (also: type `100+50` and press Enter in a Blur Gallery
field: the value is 150 and the next Enter applies the gallery; Toggle Last State twice returns to the same state;
Search runs a command and the actions recorder records that command, not Search). **Done:** every existing spec that
fills `input[type="number"]` still passes; the report lists the number inputs left plain.

### Tests expected from every 0.4 builder

As for 0.3: unit tests for pure modules under `tests/unit/*.test.mjs` (node:test, no DOM) that check numbers; an e2e
spec using `helpers.mjs` (and `helpers-<package>.mjs` if needed); `tests/e2e/app.spec.mjs` and
`tests/e2e/skeleton-04.spec.mjs` green, with the package's ids no longer in `app.stubbed` (the spec checks each M.7 id
as "a disabled stub or a real registration" and gates its stub-behaviour assertions, rule 8, so nobody edits it); the whole existing suite
green on the package's port. A spec that reads history right after a dialog closes polls (commits land under
`app.busy`). Report what the contract asked for that was not done, every behaviour change of an existing feature,
every place where the package had to deviate from this contract, every test it skips until another package lands
(rule 8), and the measured cost of anything on the repaint path.

### The skeleton as landed: where it differs from the text above

The skeleton follows the contracts above; where the code forced a different or extra detail, it is listed here (the
names above stay valid). Package owners build against this list too.

- **Gradient model** (`gradient-model.js`): `normalizeGradient(g, { fg, bg, keepRefs })` (`keepRefs: true` keeps
  `{ ref }` stops, for preset data only); the result carries the placement fields of the input (`PLACEMENT_KEYS`); 0.3's
  tool strings `stops: 'fgbg' | 'fgt'` are read as refs; a stop's `mid` bends the segment that ends at that stop
  (Photoshop's .grd convention); `gradientT` is unclamped and un-reversed (`'shape-burst'` reads 0). Extra exports:
  `gradientSampler(def, opts)`, `INTERPOLATIONS`, `GRADIENT_KINDS`, `PLACEMENT_KEYS`.
- **Rich-text model** (`type/model.js`): typing over a range takes the first replaced character's style; `RANGES` has
  `fontWeight: [100, 900]`; colours are kept as the strings given; content objects are deep-frozen; `mapChar(content,
  fn)` calls `fn(sparseStyle, resolvedStyle)`. Extra exports: `normalizeTypeOptions`, `tidyNumber`.
- **Type facade** (`type/api.js`): extra exports `canvasEngine`, `engines` (an alias), `fonts` delegating to the
  provider (its optional `advances` and `addFontData` are `undefined` when the registered provider lacks them, so
  `if (fonts.addFontData)` tests the provider); an engine may implement `bounds(layer, layout)`; composer results may
  carry `textFrom` / `textTo`. The stub engine asks the registered breaker once per distinct (language of the
  paragraph's first character, paragraph `breakRules`) over the whole text and hands each paragraph its breaks; it
  applies a composer's `justify` as given (`wordSpace` px per space, `letterSpace` px per glyph gap, `glyphScale` as a
  horizontal scale of the line's runs; without `justify` it spreads the extra width over the spaces as B.6 says) and
  `hang` (the line starts `hang.start` px into the left margin and may reach `hang.end` px into the right), and draws
  '-' after a `hyphen` line in the style of the character before it (the line's `width` includes it; `text` does not).
  `document.js` exports `applyLegacyFont(content, typeOptions, font)`; `type/target.js` exports `editTypeLayers(app,
  layers, fn, { label, merge, keys })`; `type/sections.js` exports `attachSections(app)`. While editing with a caret only,
  `applyTypeStyle` changes the whole text (0.3's Character panel behaviour).
- **Document store** (`doc-store.js`): extras `collectionSpec(name)`, `collections()`, `store.raw` (unregistered
  collections, verbatim), constructor option `{ clock }`; guide colours are stored lower-cased; `setRaw` emits like
  every change. `smart-object.js cloneDocument` copies only `guides` into an inner document.
- **Preset store** (`presets.js`): `backend.write(kind, null)` deletes the kind's file; a format's `read` may return
  `blobs` and `kindVersion`, its `write` gets `{ kind, kindVersion, def, groups, readBlob }`; removed built-in groups are
  stored with `hidden: true`; editing a kind before `ready(kind)` resolved throws (await it in "Save Preset…"). The 0.4
  kinds and their built-ins are registered in `lib/preset-kinds.js` (`registerPresetKinds04()`; built-in ids: gradients by
  slug of the 0.3 name, shapes by the `CUSTOM_SHAPES` key, stroke styles `solid` / `dashed` / `dotted`, contour
  `linear`). Main-process files: `src/main/preset-files.js`. A settings write error reaches the renderer as a message
  starting with `[write-failed]` (IPC drops error properties); `app.reportWriteFailure` reads `err.code` or that prefix.
- **Sessions and commands**: `sessions.undo()` / `redo()` ask every active session that defines them, not only
  `'observe'` ones; a RegExp `allow` never admits a `changesDocument` command under any policy (so New Guide commits a
  running Free Transform); observers see every run, unknown ids included; `stubCommands` no longer lists an id that
  already has a real definition, and an entry may be `{ id, record, undoLike, changesDocument }` so a stub carries its
  owner's flags. `command:done` carries `replayId` / `replayArg` only when `setReplayCommand` was used.
- **Menu command source**: `pigment:event:command` carries a third value, `true` (accelerator: `'menu-key'`), `false`
  (mouse: `'menu'`) or `'key'` (Shift+Alt+letter taken by `main.js` on Windows and Linux; app.js drops such a key while
  a text field has focus, including the input of a session that `ownsFocus` (the type editor; `isTextTarget()` is false
  for it), or a dialog is open, as shortcuts.js does on the page). Queued startup commands keep it.
- **Keys** (`keymap.js`): the physical-key fallback of `eventMatches` applies only when `event.key` is not an ASCII
  letter or digit (M.4 "Matching on every keyboard"). Extra exports `BLEND_MODE_KEYS` (`[mode, letter, label]`), `sameAccelerator(a, b)`; a
  `SHORTCUT_GROUPS` entry with `type: true` lists TYPE_KEYS. Toggle Developer Tools is F12 on macOS too (Alt+Cmd+I is
  Image Size).
- **Adjustments**: `adjust.js` exports `adjustmentDef(kind)` (the compositor reads `margin` through it) and
  `registerTestAdjustment(kind, def)` for tests only (the registry is a frozen table); `composite()` takes an internal
  `noMargin`; `adjust-def.js` exports `applyLutKeepLuma`; `pixelEditDialog` with a frame passes `onReset` (back to
  the parameters the dialog opened with) to `app.dialogs.open`, so conventions' Alt = Reset works in every adjustment
  dialog; registered editors get `{ source, app }` in the Properties panel as in a dialog; `deep.js isExactKind(kind, params = {})`; `adjust-ui.js`
  exports `editCtx(app, session)` and `pixelEditDialog`'s `run` gets the session third; `smart-object.js
  applySmartFilter(img, f, ctx)`. Gradient Map at 8 bits samples the model (identical to 0.3 for ordinary stops; ±1 on
  some reversed gradients and where two stops share a position).
- **Styles** (`styles.js`): `scaleEffects` also scales `width`; at most 10 instances per effect (`MAX_INSTANCES`);
  `INSTANCE_KEYS`; Gradient Overlay reads `fx.gradient` (a v2 def) before 0.3's `fx.stops`.
- **Geometry**: `path-ops.js mapPathPoints(path, f)` (layer-move.js cannot import image-ops.js); `image-ops.js
  bakeVectorMask(layer, doc)`; `mapShapeGeometry` treats `[1, 0, 0, 1, dx, dy]` as a translation (props shifted),
  anything else keeps the props.
- **Snap stub**: ignores `axis` for `'move'` (0.3 snapped Shift-constrained moves on both axes).
- **Paints** (`paint.js`, `paint-editors.js`): extra exports `paintRenderer`, `canvasGradient`, `canvasStops`,
  `paintEditor`, `resolvePaint`; an editor flag `editAfterCreate` (the default gradient editor creates the fg→bg paint,
  then opens `layer:edit-fill` with its live preview, as 0.3 did). New Fill Layer > Pattern without a pattern cancels.
- **Patterns stub** (`patterns.js`): keeps the last 24 patterns like 0.3, `define` emits `'patterns:changed'`; the
  current pattern lives in memory until the patterns package writes `settings.patterns.current`.
- **Field widgets**: `numericField(spec)` returns `{ element, input, label, get, set, setDisabled, destroy }`; in the
  options bar the input has no `data-key` (its wrapping label has it); `buildForm(fields, { app })` gives widgets the
  app; widget elements carry `data-widget` and `data-key`; the `gradient` stub opens its editor inline (a popover sits
  under a dialog's backdrop); `fields.js` exports `gradientCss(def, opts)` and `isStubWidget(type)` (true while `type`
  is still the skeleton's stub; tests use it as the capability flag of rule 8).
- **Section registries** (L.1, L.2): `app.properties` and `app.preferences` are created in the App constructor, before
  MODULES, so a package registers its sections from `install(app)` (no need to wait for `'app:ready'`). Both are
  `{ registerSection(spec), sections(), render() }` (`render()` redraws the Properties panel once its host is mounted,
  and does nothing for Preferences); the later registration of an id wins, except that the built-ins, which
  `lib/extras.js` and `lib/panels/properties.js` register late in MODULES, never replace a section a package registered
  first. Properties built-ins: each `lib/properties/<file>.js` exports its spec, which the host registers: `transform.js`
  `documentSection` (id `document`, order 0, `'main'`) and `transformSection` (`transform`, 10, `'main'`), `fill.js`
  `fillSection` (`fill`, 10), `adjustment.js` `adjustmentSection` (`adjustment`, 10), `shape.js` `shapeSection`
  (`shape`, 20), `text.js` `textSection` (`text`, 30), `paragraph.js` `paragraphSection` (`paragraph`, 40, renders
  nothing), `mask.js` `maskSection` (`mask`, 100, region `'mask'`). The host imports these files as namespaces: an owner
  may drop the export and register a section of the same id from its own module instead (a missing export is skipped);
  a section file that fails to load still takes the whole panel with it.
- **Properties sections**: section specs may set `keepWhileTyping: false`; the host has `sections()` and `render()`;
  shared DOM helpers live in `lib/properties/ui.js`. The rulers stub's callers in the transform section and the Free
  Transform bar apply only the origin (they stay in px, as 0.3 showed them).
- **Layer Style pages**: the page context has `globalLight()`; `app.layerStyle.pages()` / `globalLight()`;
  opacities are 0..1 and not rounded. `lib/blending-options.js` is already a MODULES entry (it registers the page and
  stubs the three Layer Style commands).
- **Paths** (`tools/vector.js`): `pathTargetKinds()`; `path:rename` of a registered kind takes `{ kind, name }`;
  registered path buttons appear in the Path Selection and Direct Selection tools. The four snap calls (shape drag
  start and end, pen anchor, path-selection drag) pass `exclude`: the layer of the target being drawn into or edited
  (none for a new shape layer or a work path). They pass no `axis`: Shift in these tools constrains by 45° or by
  proportion, not to one axis.
- **Exports other packages' files import** (rule 2 applies to them as to stub APIs: the owner keeps them, it may add
  more): `tools/fill.js` (gradients) `GRADIENT_PRESETS` (read by `lib/preset-kinds.js`) and `BLEND_OPTIONS` (read by
  `lib/tools/bucket.js`, patterns); `tools/vector.js` (shapes-live) `CUSTOM_SHAPES` and `customPath` (read by
  `lib/preset-kinds.js`), besides L.4's exports; `adjust-ui.js` (adjust-tonal) `buildAdjustmentEditor`,
  `adjustmentSource` (read by `lib/properties/adjustment.js`, adjust-color) and `ADJUSTMENT_ICONS` (read by
  `lib/panels/properties.js`). A missing one breaks the importing module: for `lib/preset-kinds.js` the error is only
  logged and `app.presets` starts with no 0.4 kinds; for bucket.js the Paint Bucket is gone.
- **Test plumbing**: there are no shared 0.4 helpers in `tests/e2e/helpers.mjs` (unchanged); a package that needs some
  adds `tests/e2e/helpers-<package>.mjs`. `tests/e2e/server.mjs` serves `tests/fixtures/fonts/` at `/fixtures/fonts/`
  (type-engine-core's OFL test font: `fetch('/fixtures/fonts/<file>')` in the page, then `fonts.addFontData`).
- **App helpers**: `installCanvasCapture(app)` in `start()`; `app.layerDoubleClick(layer, p)`, `app.dropHandlerFor(dt,
  where)`; `app.ui.patternPreview` holds View > Pattern Preview; the adjustment frame takes `source` and `preview`
  options and returns `disarm()`; `adjust/presets.js` exports `adjustmentPresetKind(kind, editor)`. `sampleMerged`
  shares a cached read-only canvas per document version; `setLayersProps` merges only for one layer; `registerIcons`
  appends to `ICON_NAMES`.
- **Settings defaults**: the J.7 objects are shared references inside `DEFAULT_SETTINGS` (`withDefaults` copies one
  level): write a new object (`saveSettings({ guides: { ...settings.guides, lock: true } })`), never mutate one in place.

### The packages as built: what the integration recorded

The sixteen packages follow the contracts above. Where one added an export, a file, a command id or a rule the text
does not name, or chose between two readings of it, it is listed here (merged from the packages' notes at
integration; the user-facing side is in `docs/0.4/<package>.md` and the user guide).

- **type-engine-core** (`lib/type/fonts.js`, `shaper.js`, `layout.js`, `render.js`; harfbuzzjs 1.6.4 copied into
  `src/renderer/vendor/harfbuzz/` by `scripts/vendor/harfbuzz.mjs`, run by `postinstall`). The engine `'harfbuzz'` is
  tried before the stub `'canvas'`; `supports(layer)` is false while the wasm or a run's face is missing, and the stub
  draws the layer. Faces come from `queryLocalFonts()` (Electron; the browser only with the `local-fonts`
  permission) or `fonts.addFontData` / `window.__pigmentTest.addFont`; a face arriving calls `fontsChanged()` (no
  history entry, the dirty flag unchanged). Metric-compatible aliases when a family is missing: Arial/Helvetica →
  Liberation Sans or Arimo, Times New Roman/Times → Liberation Serif or Tinos, Courier New/Courier → Liberation Mono or
  Cousine, Calibri → Carlito, Cambria → Caladea. `api.js` also exports `kerner(mode)` and `listMarkerText(paras,
  index)`; `registerKerner` and `registerListFormatter` relay out open documents. Layout rules of the engine: each
  baseline is the previous one plus the line's own leading (Photoshop; identical to the stub for one size); trailing
  spaces hang and are not in `line.width`; tracking is added after each shaping cluster except a line's last, so a
  ligature stays one glyph. `LayoutRun` carries `units` (positioned shaping units with `x`, `advance`, `trk`), `face`
  and `size`; `LayoutLine` carries `_glyphScale`, `_hyphen`, `_marker`. `fonts.advances(style, text)` gives one value
  per UTF-16 unit (a cluster's advance on its first unit, 0 on the others). A kerner is called once per shaped piece as
  `fn(style, pieceText, outlines)` with `outlines[k]` per shaping unit; GPOS `kern` is off while it is asked. Colour
  glyphs and characters the face lacks are drawn with `fillText` at the shaped positions (the face is also a private
  CSS FontFace). Stacked vertical text iterates grapheme clusters.
- **Both engines take a negative composer `wordSpace`** (integration): justified lines close up their word spaces down
  to the Justification dialog's Minimum (`lib/type/paragraph.js SPACES_SHRINK = true`).
- **Hyphenation in the facade** (integration): `hyphenateRange` asks the hyphenators that name the character's
  language, then the catch-alls (no `languages`), newest first in each, and one that answers `null` passes the word on.
  A word of `minWord` letters or fewer stays whole (Photoshop's "Words Longer Than").
- **type-editing** (`lib/type/editor.js`, `edit-selection.js`, `edit-history.js`, `clipboard.js`, `edit-keys.js`). The
  editor draws its own caret, selection and IME underline over the layout; a hidden `<textarea class="type-input">`
  at the caret takes typing, IME and dead keys (its value is the plain text, its selection the editor's). The session's
  `handle` (B.8) runs the 40 ms echo check first (sources `'key'` and `'menu-key'`, never while the editor itself
  dispatches), then answers undo-like and clipboard ids for every source (Edit › Undo clicked while typing undoes the
  typing), then `typeKeyFor` keys; any other `'menu'` command commits first. A box drawn with the tool stores its
  height (a fixed box; 0.3 boxes keep `height: null` until a top or bottom handle is dragged). Moving the text while
  editing snaps with `source: 'move'`. Shift+Enter inserts U+2028. Paste Without Formatting is registered in
  `editor.js`. The type:* commands work outside a session on every selected text layer as one entry.
- **type-character-panel** (`lib/type/char-format.js`, `char-values.js` (pure), `optical-kerning.js`,
  `lib/properties/text.js`). Every change goes through `target.js`; with a caret it sets the insertion style; with no
  text layer it edits the defaults (`setTypeDefaults`). Every panel change also becomes the default for new text
  (except a manual kern and a targeted layer's colour). New text takes `settings.type.char` / `.para` from a
  `'type:session'` listener inside the creation entry (`tools/text.js beginNew` builds from the tool options). Kerning
  is a Metrics / Optical / 0 select plus a manual number. Reset Character keeps face, size, colour and stroke.
  Preferences › Type Units (order 36). Optical kerning shapes each piece again without `kern` and returns `null`
  (Metrics) when its unit count differs from the outlines the engine passed.
- **type-paragraph-panel** (`lib/panels/paragraph.js`, `lib/type/paragraph.js`, `hyphenation.js`, `line-breaks.js`
  (UAX 14 on Unicode 16.0), `lib/type/patterns/` (TeX patterns for en-US, en-GB, de, fr, es, it, nl, pt with
  `LICENSES.md`), `lib/properties/paragraph.js`, `scripts/build-type-paragraph-data.mjs`). New text uses the Every-line
  Composer and `breakRules: 'standard'` (set on `'type:session'`); version 2 documents keep `'single'` / `'legacy'` and
  0.3's lines. The line search sums piece widths between break candidates and measures the chosen lines again in one
  piece. A second, catch-all hyphenator maps regional tags (de-AT, en-AU, pt-BR) to the bundled language. Turning a
  list on gives an unindented paragraph 1.5 em per level. `type:toggle-panels` toggles back to the panel shown before.
  The panel menu has Line breaks: Standard / At Spaces Only (0.3).
- **layer-style-blending** (`src/shared/pixels/blend-if.js`, `lib/blending-options.js`, `compositor.js
  finishAdvanced`). A layer with default blending options goes through 0.3's code; a non-default one through
  `finishAdvanced` (mask parts before and after the effects, clipped layers as a group or each cut to the base, Blend If
  through `split`, knockout and channels per pixel). Root-level Shallow knockout behaves as Deep; Deep goes to the
  Background or transparency. A pass-through group with effects or non-default options is drawn isolated; groups
  ignore Fill unless styled. `styledCanvas` passes `origin`, `docWidth`, `docHeight`, `interiorAsGroup` and
  `transparencyShapes` for every layer. Extra export `hasEffects(styles)`. 16/32-bit flattening falls back to the
  8-bit composite for a layer with non-default blending options other than Blend Clipped Layers as Group, which the
  float clipping composite follows (`depth.js planFlatten`).
- **layer-style-effects** (`styles.js`, `contour.js`, `styles-more.js`, `lib/contour-editor.js`,
  `lib/style-canvas-drag.js`, `lib/style-prepare.js`). `STYLE_FEATURES` is all true. With `split: true`, `above` is
  always `null` and `layer` drawn Normal over `below` gives the merged image exactly. `splitEffects` entries carry
  `name` and `part` (a bevel gives highlight and shadow parts; a centred stroke an outer and an inner part), each
  cropped to its own pixels. `applyStyles` also takes `origin`, `docWidth`, `docHeight` (else `styles._place`). New
  fields beyond J.6: bevel technique `'chisel-soft'`, `texture.origin`, the stroke's `patternScale`, `patternAngle`,
  `link`, `origin`, and a glow's `reverse`; their defaults are `EFFECT_FIELD_DEFAULTS` / `effectDefaults(key)`
  (`DEFAULT_STYLES` stays 0.3's). A Pattern Overlay stores a PatternRef; a Gradient Overlay keeps 0.3's `stops` in step.
  Dragging a shadow with Use Global Light on sets that effect's own angle. The contours kind has Photoshop's 12
  built-ins.
- **adjust-tonal** (`src/shared/pixels/adjust-tonal.js`, `lib/adjust/*`: `tonal.js`, `tonal-ui.js`,
  `levels-editor.js`, `curves-editor.js`, `simple-editors.js`, `auto-options.js`, `eyedroppers.js`,
  `preset-widget.js`, `presets.js`, `frame.js`, `tonal-formats.js` (.alv, .acv)). Levels and Curves keep `lut`
  (exact for RGB; for the CMYK and Lab spaces it is the grey axis only, so `deep.js lutCovers(kind, params)` sends them
  to the 8-bit fallback, integration). The frame returns `paramsChanged(params)`; the `preset` widget has
  `changed(data)` and the options `defaults`, `title`, `manage`. `pixelEditDialog`'s editor factory gets `{ refresh }`
  and `run` gets `{ preview }`; `beginPixelEdit` takes `ignoreSelection`; `app.adjustDialog(kind, arg, ctx, { last })`.
  Plain Adjustments commands open with the defaults except Shadows/Highlights, Replace Color, Match Color, HDR Toning
  and Color Lookup (they keep their last settings). `settings.adjust.curvesDisplay`.
- **adjust-color** (`src/shared/pixels/adjust-color.js`, `lib/adjust/color.js`, `hue-sat-editor.js`,
  `shadows-highlights.js`, `color-editors.js`, `color-formats.js` (.ahu, .cha, .asv, .blw),
  `lib/tools/adjustment-brush.js`, `lib/panels/adjustment-presets.js`, `lib/properties/adjustment.js`). New command
  `layer:adjustment-preset` (`'<group>/<preset>'`). Shadows/Highlights stays destructive-only and declares a constant
  `margin`; Clarity and Dehaze use fixed neighbourhoods (24 and 22 px). The Show More Options flag is
  `settings.adjust.shMoreOptions` (inside adjust-tonal's `adjust` namespace, accepted at integration). The Adjustment
  Brush joins "new layer + first stroke" into one history entry.
- **gradients** (`gradient-model.js` methods and noise, `src/shared/pixels/gradient-render.js`,
  `lib/gradient-widget.js`, `gradient-editor.js`, `gradient-picker.js`, `gradient-presets.js`, `gradient-paint.js`,
  `lib/panels/gradients.js`, `lib/properties/fill.js`). Classic defs without dither still draw through a Canvas
  gradient (0.3's pixels); every other method and noise draw per pixel. The Gradient tool's `mode` defaults to
  `'classic'`. `tools/fill.js` re-registers the `gradients` preset kind with groups (the later registration wins).
  While the on-canvas widget is dragged the layer draws a Canvas-gradient draft (`paint.gradient._draft`, never
  stored). `settings.gradients.collapsed` and `.view`.
- **patterns** (`lib/patterns.js`, `pattern-builtins.js`, `scripted-patterns.js`, `pattern-picker.js`,
  `pattern-widget.js`, `pattern-paint.js`, `pattern-preview.js`, `lib/panels/patterns.js`, `lib/tools/bucket.js`).
  `lib/patterns.js` registers the `patterns` preset kind with twelve seeded built-ins (pixels as PNG side files);
  `app.patterns` adds `currentId()`, `refFor(id)`, `canvasOf(ref)`, `ready()`, `remove(ids)`, `rename(id, name)` and
  `resolve(ref, onReady)`. There is always a current pattern. A paint without `link` (0.3) keeps 0.3's anchor; new
  paints carry `link`. The Paint Bucket's tiles start at the document origin. `.pigment` writes a fill layer's
  `pattern: { scale, angle, link, origin, presetId, name }` (`document.js describePattern`, integration). A linked
  Pattern Fill layer's pattern moves with the layer and with Canvas Size, Crop and Reveal All (`layer-move.js`,
  `image-ops.js remapDocument`, integration). The Pattern Stamp has the `pattern` option (integration).
- **guides-snapping** (`lib/guides.js`, `snap.js`, `rulers.js`, `smart-guides.js`, `guide-layout.js`, `canvas-view.js`,
  `tools/move.js`). `app.snap` picks the nearest target within 6 screen px, ties by kind (guide < document < artboard <
  slice < layer < grid); guides and the grid snap only while shown; `'move'` rounds to whole pixels; the Move tool snaps
  the layers' content bounds. `SnapTarget` may carry `edge: 'start' | 'centre' | 'end'`; providers get `query.kinds`
  and `query.boxes`. `rulers.js` re-registers `rulerOrigin` with `transformOrigin(v, m)` (an untouched origin stays on
  the document corner). New command ids `view:move-guide` (`{ moves: [{ id, axis, from, to }] }`) and
  `view:ruler-origin` (`{ x, y }`), both `changesDocument`. The ruler and corner drags run with source `'panel'`. Guide
  positions keep two decimals. `smart-object.js cloneDocument` copies the ruler origin (integration).
- **masks-vector-masks** (`lib/vector-mask.js`, `mask-render.js`, `mask-view.js`, `src/shared/pixels/mask-math.js`,
  `lib/properties/mask.js`, `lib/panels/paths.js`). New command `layer:mask-properties` (`{ part: 'raster' | 'vector',
  density?, feather?, invert?, fromSelection?, merge?, layerId? }`). Feather is a Gaussian with sigma = feather / 2,
  normalised at the document edge. A `'composite'` read whose last build took over 30 ms may show it for up to 150 ms
  while the layer changes; `'bake'` reads are always exact. Extra export `renderVectorMask(vm, w, h)`. The vector-mask
  path target's `rename` renames the layer; `select` loads the path without density or feather.
- **shapes-live** (`lib/path-ops.js`, `shape-geometry.js` (pure), `tools/vector.js`, `tools/shape-widgets.js`,
  `shape-paint-ui.js`, `shape-props.js`, `lib/properties/shape.js`). New command `layer:shape-properties` (`{ id? |
  ids?, props?, fill?, stroke?, label?, merge? }`). `mapShapeGeometry` fits an affine map when it has no matrix; skew,
  perspective or a mirrored custom shape makes a plain path; a non-uniform scale scales radii by the smaller factor.
  Extra exports `isLiveShape`, `regenerateShape`, `shapeChangePatch`, `DEFAULT_STROKE`. Pattern paints of shapes carry
  a `dataUrl` of their pixels. The Properties section `shape-live` (order 21) hides Transform for live shapes. Miter
  limit 4; dashes in stroke widths; render bounds padded only as far as the stroke reaches.
- **layers-panel-depth** (`lib/panels/layers.js`, `layers-menu.js`, `layers-effects.js`, `layers-model.js` (pure),
  `lib/blend-preview.js`, `layers-extras/find.js`). New command `layer:effect` (`{ id, op: 'toggle' | 'toggle-all' |
  'delete' | 'clear' | 'move' | 'copy', key?, index?, target?, visible? }`). The blend-mode control is a button with
  its own list (`.blend-mode-button[data-blend]`, `.blend-mode-list [data-mode]`). An effect switched off with its eye
  keeps `present: true`. `find.js` sets `app.sampleSkip` while layers are isolated. Thumbnails default to the layer's
  own pixels (`settings.layersPanel.thumbBounds: 'layer'`).
- **finish-layer-menu** (`lib/layer-ops.js`, `layer-dialogs.js` (`app.layerDialogs`), `layers-extras/structure.js`,
  `layers-extras/stamp.js`, `layer-menu-model.js` (pure)). `app.backgroundRules` keeps the stub's API;
  `lockedProps(background)` is `blend, opacity, fillOpacity, mask, vectorMask, styles, position`. A layer mask on the
  Background converts it to "Layer 0" first. `layer:distribute 'horizontal' | 'vertical'` make equal gaps (`'hcenter'`
  / `'vcenter'` spread centres). `layer:duplicate` takes `documentName`. `layer:merge` (Ctrl+E) dispatches to
  merge-selected, merge-group or merge-down through their current definitions. `settings.layerMenu.digitPairMs`.
- **conventions-shortcuts-fields** (`lib/numeric-field.js`, `conventions.js`, `command-search.js`, `temp-tools.js`,
  `form.js`, `dialogs.js`, `tools.js`, `shortcuts.js`). The numeric field's listeners sit on `window` in the capture
  phase (the expression is evaluated before `dialogs.js` sees Enter); a window-level enhancer gives every plain number
  input the same arithmetic, units and stepping. Spring-loaded tool keys switch the real tool and back (450 ms);
  `view.tempToolVia` is `'ctrl'`, `'alt'` or `'space'`. Alt = Eyedropper only for brush, pencil, Color Replacement and
  gradient; Ctrl = Move only for the selection, painting and retouching slots. Over a document, a click beside a
  dialog no longer cancels it. A temporary tool draws its own overlay (`canvas-view.js`, integration); clone, heal,
  dodge, burn and the Adjustment Brush claim Alt in `tool-traits.js` (integration). Search focuses its field as it
  opens.
- **Preferences**: section patches that write the same namespace object merge one level deep (`extras.js`,
  integration), so `type` (type-editing) and `type-units` (type-character-panel) keep each other's keys.
- **Labels**: `COMMAND_LABELS` names the ids added beyond M.7 (`view:move-guide`, `view:ruler-origin`,
  `layer:mask-properties`, `layer:shape-properties`, `layer:effect`, `layer:adjustment-preset`).

### Effect blend modes against the backdrop (0.4, after the hunt)

Photoshop's model, which the compositor follows for every layer that has effects (raster, text, shape, fill, smart
object, styled group, a clipping base, a clipped layer):

1. Each exterior effect (drop shadow, outer glow, the outer part of an Outer Bevel, Emboss or Pillow Emboss, the
   outer part of an outside or centred stroke) is composited onto the backdrop (what lies below the layer) with its
   own mode and opacity, bottom first.
2. The layer's content is composited with the layer's mode, faded by its fill opacity.
3. The interior effects (overlays, satin, inner glow, inner shadow, an inner bevel, an inside stroke) are cut to the
   layer's shape (its box with Transparency Shapes Layer off) and composited over that, each in its own mode: the
   layer's mode does not reach them and the fill does not fade them, so a Fill 0 % layer with an Overlay gradient
   blends the gradient with the image below. With Blend Interior Effects as Group on, Photoshop "applies the blending
   mode of the layer to layer effects that modify opaque pixels": the interior effects are blended into the content,
   faded with it by the fill and drawn with it in the layer's mode (steps 2 and 3 as one image).
4. The layer's opacity fades all of that as one lerp from the backdrop. (Dissolve speckles the content at the layer's
   opacity instead and draws the parts at theirs times it.)

A mode that gives the effect's own colour whatever the backdrop counts as Normal (`asDrawn`): Multiply, Darken and
Linear Burn with black, Screen, Lighten and Linear Dodge with white. Photoshop's default drop shadow (black, Multiply)
and default bevel (white Screen, black Multiply) therefore keep the fast path and its pixels.

Code:
- `styles.js`: `exteriorBlends(styles, { asDrawn })` and `interiorBlends` list the modes of the exterior and interior
  effects that draw; `splitsInterior` says when the interior effects must come apart. `applyStyles(..., { split:
  true })` returns `{ image, layer, parts, below, above, inner, offsetX, offsetY }`: `image` is the merged render as
  before, `layer` the content with its interior effects, `parts` the exterior effects one by one (`{ key, index,
  part?, image, x, y, blend, opacity }`, cropped to their pixels; a Dissolve one comes speckled, as Normal), `below`
  those merged. With `interior: true` as well, `layer` is the content alone and `inner` the interior effects one by
  one, cut to the shape (the merged interior is still built, since the knock-out of the exterior effects reads it).
- `compositor.js`: `needsSplit(layer)` is true when the layer has exterior effects and one of their modes (as drawn) or
  the layer's own is not Normal (`exteriorApart`), or when its interior effects must come apart (`interiorApart`: Blend
  Interior Effects as Group off, and the layer is not Normal, or its fill is below 100 % under an interior effect that
  is not Normal). Then `styledCanvas` caches the parts as canvases (`entry.parts`, `entry.inner`, `entry.below`,
  `entry.layer`, `entry.layerBox`) and `drawStack` composites them: straight onto the target at opacity 1, on a copy of the
  backdrop that is lerped back (`lighter` of backdrop × (1 − opacity) and result × opacity) below 1. When every mode
  is Normal, Normal over Normal is one source-over, so the merged image is drawn exactly as before (the fast path,
  same pixels, same cost). A clipped layer outside its group (`clipTo`) and the mask parts after the effects cut the
  parts as they cut the content.
- Blending Options (`finishAdvanced`, `drawPixels`, `blend-if.js compositeAdvanced({ parts })`): the per-pixel path
  always takes the exterior effects apart from the content; when they all draw as Normal on a Normal layer they go in
  merged (`below`, `exteriorParts`), which without knockout keeps 0.3's order and rounding (merged effects and content
  each at the opacity: the effects are knocked out under the content, so that is the one fade). Order: parts in their
  modes, then the knockout (it cuts through to the Background or the group's backdrop under the layer's shape), then
  the content in the layer's mode weighted by Blend If, then the interior parts (`inner`) in their modes with the same
  weights, then the channel restriction against the backdrop, then one fade by the opacity (`fadeFrom`). Blend If acts on the content
  and its interior effects (This Layer reads the content with them, Underlying the backdrop before the parts); it
  does not hide the exterior effects, as in Photoshop, where a shadow is computed from the layer's transparency and
  stays whole when Blend If hides some of the layer's pixels. The channel restriction applies to the parts too.
  Without parts or knockout, content-at-opacity is one `blendImages`, as before.
- Groups: a Pass Through group's children composite onto the real backdrop; a Normal (isolated) group's children see
  the group's transparency, so a Multiply shadow inside it multiplies with nothing (Photoshop does the same). A styled
  group is an isolated group whose own effects follow the model.
- 16 and 32 bits: `depth.js planFlatten` still sends styled layers to the 8-bit composite, which follows the model.
- Bakes. Create Layers (`blending-options.js`) makes each exterior part a layer below with its mode and opacity, so
  the picture is unchanged at layer opacity 100 % whatever the modes; it warns (Photoshop's "Some aspects of the
  Effects cannot be reproduced with layers") for knockout, layer opacity below 100 % with exterior effects (the shadow
  is knocked out by the layer as one image, which separate layers cannot do) and, with Blend Interior Effects as Group
  on, reduced fill with interior effects. With it off on a layer that is not Normal or has a reduced fill, the interior
  parts become clipped layers in their own modes and the base's Blend Clipped Layers as Group goes off (clipped layers
  then blend with the backdrop in their own modes, cut to the base's shape and not faded by its fill, which is the
  interior model); a base that already has clipped layers keeps the option and gets the warning, and so does a layer
  below 100 % opacity or with Transparency Shapes Layer off.
  Rasterize Layer Style and Convert to Smart Object render against transparency, as Photoshop's do: the parts are
  merged into the layer, which keeps its mode, so an exterior effect in another mode keeps its look only where it
  comes out the same (a black Multiply shadow does; a Screen glow does not). `layer-ops.js lookBefore` /
  `lookChanged` compare the composite over the layer's box before and after, and a notice says when it changed.
  Merge Down, Merge Visible, Stamp Visible and Flatten composite through the compositor, so they match the canvas
  wherever what they composite onto is what the canvas shows (Merge Down onto an opaque lower layer).

### Blending Options on adjustment layers (0.4, after the hunt)

Photoshop gives an adjustment layer the blend mode, Opacity, Fill, the channels and Blend If of Blending Options
(knockout and the five check boxes act on a layer's own pixels and effects, which it has none of). Its "pixels" are
the adjusted backdrop:

1. The adjustment runs on a copy of the backdrop (what lies below it; in a clipping group, the base made opaque with
   the clipped layers below it).
2. The adjusted colour is blended onto the backdrop's colour in the layer's mode at full strength (Normal: the
   adjusted colour itself; the alpha stays the backdrop's).
3. The channels switched off keep the backdrop's values.
4. That is mixed back into the backdrop by opacity × fill opacity × mask (× the base's shape for a clipped adjustment
   outside its group) × Blend If, where This Layer reads the adjusted pixels and Underlying Layer the backdrop. Fill
   scales an adjustment exactly as Opacity does. Dissolve keeps the adjusted pixel where a noise value that depends
   on the document position falls below that weight.

Code:
- `blend-if.js`: `adjustmentMix(layer, blending)` is null when nothing changes the mix (Normal, Fill 100 %, no Blend
  If, all channels); then 0.3's lerp by opacity × mask runs unchanged (same pixels). Otherwise it gives `{ mode,
  opacity (× fill), blendIf, channels }` for `mixAdjustment(dst, adjusted, { ..., coverage, x, y })`, which does steps
  2 to 4 on ImageData (the same rounding as `compositor.js lerpPixels` where they coincide).
- `compositor.js`: `drawAdjustment` and `drawClippedAdjustment` hand the adjusted pixels to `mixAdjusted`, which
  picks one or the other. Merge Down (an adjustment layer onto the layer below), Merge Visible, Stamp Visible and
  Flatten composite through the compositor, so they keep the look wherever the merge renders what the canvas shows.
- 16 and 32 bits: `deep.js adjustLayerDeep(..., { mode, blendIf, channels })` does the same mix in float (Normal,
  Multiply and Screen; Blend If reads the samples on the 0..255 scale without rounding, float above 1 as 255);
  `depth.js` passes the options from `flattenDeep` (`adjustAcc`), the clipping groups (`clipGroupDeep` items) and
  the clipped adjustments outside their group. `planFlatten` sends an adjustment layer in another mode to the 8-bit
  composite.
- UI: `blending-options.js isStyleable(layer, app, { page: 'blending' })` (`takesBlendingOptions`) admits adjustment
  layers; the effects keep `isStyleable(layer)`, which does not. The Layer Style dialog shows the Blending Options page
  alone for them (no knockout, check boxes or Global Light), and the fx menu lists Blending Options and Copy, Paste and
  Clear Layer Style. The Layers panel's Fill field and the Shift+digit keys work on them. Paste Layer Style gives an
  adjustment layer the mode, Fill, Blend If and channels of the copied style and leaves its effects and knockout out.
- Files: `.pigment` stores `fillOpacity` and `blending` for every layer already. PSD: Blend If of every layer goes to
  the layer record's blending ranges (`io.js blendIfToPsd` / `blendIfFromPsd`: composite gray, then R, G, B; ag-psd's
  `blendingRanges`) and Fill to `iOpa`, both read back. The channel restriction is not written (ag-psd's `brst`
  reader drops the last channel), so saving says the Blending Options of such a layer were not kept.

### Repaint caches (0.4, after the hunt)

A large document repaints only what an edit can reach, and none of it changes a pixel: every path below gives the
pixels of a plain full composite (tests/e2e/repaint-speed.spec.mjs compares them after every kind of edit). Each step is
a switch in `compositor.js REPAINT` (`reuse`, `region`, `prefix`, `chain`), so a test or a measurement can turn one
off; the preview while a pointer is held is the one switch `canvas-view.js PREVIEW`.

- **The plan** (`Compositor.planOf`, `lib/repaint-plan.js`). A full composite (`composite(doc)` with no options, the
  view's and every flatten's) first describes the root's draw units: a layer `drawChildren` draws, with the clipped
  layers it takes along. Each unit has an `id` (its layers), a `pkey` (what the compositor reads from them, by value or
  by object identity: visibility, opacity, Fill, mode, clip, the `blending` and `styles` objects, `maskCacheKey`, a
  raster's canvas and position, an adjustment's kind and `params` object, a rendered layer's cached render canvas), a
  `vkey` (their versions) and a `box` (where the unit can change the backdrop: a raster's content box, which on a
  large canvas is measured once per canvas and version: at once when the unit had a smaller box before (an opacity edit
  of a document-sized layer around a small subject), else when the app is idle, its canvas box standing in until then;
  brush hints grow it without measuring; a render's box; a styled layer's padded box and cached render; a group's
  children; ALL for an adjustment layer or a group holding one). The document's size, mode, depth, global light and
  Background layer make the plan's `global`. `diffPlans` compares the plan with the last full composite's: **same**
  (selecting a layer, guides, history, the selection: the last composite stands), **region** (the union of the changed
  units' old and new boxes), or **full** from the lowest changed unit (an adjustment layer, a layer added, deleted or
  moved, a document-wide change).
- **Region.** The changed box grows by the margins of the adjustment layers (I.4: Clarity above a shape carries its
  change that far), is composited with `composite(doc, { rect })` and pasted into a copy of the last composite. It is
  used when it covers at most 45 % of the document, when the document holds no Dissolve layer (its noise follows the
  repaint rect), no shown group with knockout and Transparency Shapes Layer off (it knocks out its whole content box,
  which a group rendered over the region alone would measure inside the region; a layer with that option keeps its
  whole source in `drawLayer` instead of the crop to the rect), no adjustment kind that measures the whole image (`LOCAL_KINDS`: Equalize, Match Color, HDR Toning,
  Replace Color and a dithered Color Lookup are not local), and no mode renderer. After compositing, the boxes are
  measured again from the fresh caches; a change outside the region redoes the whole composite. A partial composite
  relies on a canvas giving back an unchanged pixel unchanged through getImageData and putImageData (tested).
- **Brush hints.** A brush dab touches its layer without a document event. `BrushStroke` passes its dirty rect and
  layer to `view.invalidate(rect, layer)`, which hands them to `Compositor.hintPixels`. A unit whose layers only moved
  version, every touch covered by a hint of the layer's current version, repaints the hinted rects (a unit with
  effects, a feathered mask or a clipped adjustment takes its box instead). The end of a stroke touches the layer with
  an empty hint, so the history step repaints nothing.
- **Prefix.** A full composite starts from a cached composite of the units below the lowest change when one matches
  them (`samePrefix`), and keeps a new one just below that unit (on a view's compositor that has composited before; up
  to two, least recently used out). An edit high in the stack skips everything below it; a region repaint patches the
  prefixes it reaches, so they stay good. Cached prefixes are taken before the mode renderer runs.
- **Chain.** Consecutive adjustment layers (at any level) share one getImageData and one putImageData of the target;
  between two of them the data goes through `roundtrip`, a table of what the canvas gives back for each colour at each
  alpha, measured once, so translucent pixels round as the unchained passes rounded them. An adjustment layer's mask
  that is opaque white over the rect (a new adjustment layer's) is not read: it weighs every pixel by 1.
- **Preview** (`canvas-view.js PREVIEW`, as Photoshop draws while dragging). While a pointer is held anywhere in the
  window and the view's last composite that did work took more than `slowMs`, the view draws the last full composite
  with `Compositor.preview` over it: the changed region (or the visible rect) composited at full resolution, except the
  root's adjustment layers from the changed unit up, which run on a copy scaled to the view's resolution
  (`zoom × devicePixelRatio`). A region of at most 600 × 600 px is composited exactly instead. A preview never becomes
  the full composite, the plan or a prefix of anything but exact pixels; when the pointer is released the view
  composites at full resolution. Every other reader (export, history, panels, merges) calls `composite` and gets full
  resolution. Kinds that read around a pixel read a wider neighbourhood in the preview; `ctx.scale` carries the scale
  to them.
- **Memory.** A view's compositor keeps the full composite, a spare buffer (so the canvas a caller was handed stays as
  it was until the composite after next) and up to two prefixes: four document-sized canvases, and the preview's
  buffer (the visible rect) once a gesture has previewed. `drawStack`'s two scratch canvases live for one composite.
  When a document goes to the background (`documents.js activate`), `Compositor.release` drops everything but its
  full composite. Other compositors keep the full composite only.
