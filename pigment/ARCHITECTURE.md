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
                               menu.js (native menus), clipboard.js (Electron 44 async clipboard), protocol.js,
                               settings-store.js, recent.js, watch.js, startup-files.js
  src/preload.cjs              contextBridge -> window.pigment (see "The preload bridge")
  src/shared/                  code shared by main, renderer and Node tests (no DOM, no Electron):
    defaults.js                settings defaults
    formats.js                 file extensions Pigment opens, dialog filters
    keymap.js                  shortcuts (MENU_KEYS / RENDERER_KEYS), labels, accelerator parsing
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
  docs/                        USER-GUIDE.md
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

theme, language of units (`rulerUnit`: px|in|cm|mm|pt|percent), `recentLimit`, `restoreSession`,
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
   and finally the result is drawn into the target with `globalAlpha = opacity` and the blend mode:
   Canvas 2D `globalCompositeOperation` when it exists (normal→source-over, multiply, screen,
   overlay, darken, lighten, color-dodge, color-burn, hard-light, soft-light, difference,
   exclusion, hue, saturation, color, luminosity, linear-dodge→lighter), otherwise the per-pixel
   fallback in `pixels/blend.js` on the affected rect.
3. An adjustment layer takes the current target pixels (its "below"), runs
   `pixels/adjust.js` on a copy, and blends the result back through its mask and opacity.
   `dissolve` is implemented as per-pixel random alpha in the fallback.
4. Caches: `layerCanvas` per layer version; group results per (group version, child versions); the
   full composite per document version. `rect` limits all work to that document rectangle (brush
   strokes repaint only the dirty rect).

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
}
```

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

- **Open**: PNG, JPEG, WebP, GIF (first frame), BMP, AVIF, SVG (rasterised at document size), PSD/PSB (via ag-psd: layers, groups, masks, opacity, blend modes, visibility, clipping, text layers (rasterised + text data kept when available), adjustment layers mapped where kinds exist), `.pigment`.
- **`.pigment`**: a ZIP (store or deflate) with `document.json` (version, size, dpi, tree with layer parameters, selection/channels/paths/guides) and `layers/<id>.png` (raster pixels), `masks/<id>.png`, `thumbnail.png`. Written and read by `src/shared/zip.js` + the renderer's PNG encoding (canvas `toBlob`).
- **Export As**: PNG (8-bit, transparency), JPEG (quality, background), WebP (quality / lossless), BMP? (no), PSD (ag-psd `writePsd`: raster layers, groups (with masks), masks, opacity/fill opacity/blend/visibility/locks, text layers as text, adjustment layers as PSD adjustments where a type exists), scale/resample, metadata strip, "quick export" PNG.
- **Save safety**: `WRITE_EXTENSIONS` (pigment, psd, png, jpg, jpeg, webp) are the only formats `encodeForPath` writes; `Documents.save` sends read-only formats (gif, bmp, svg, ...) to Save As, and a typed-in read-only extension becomes `.png`. JPEG/WebP quality is asked once per document (`doc.saveOpts`, remembered as `settings.saveQuality`) and never taken from the Export As dialog.
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

- `npm test` — node:test over `tests/unit/*.test.mjs`: every pixel module, zip, keymap, menu template, protocol, startup files. No DOM, no Electron.
- `npm run test:e2e` — Playwright (Chromium) against `tests/e2e/server.mjs` serving `src/renderer` with the browser bridge; specs drive the real UI (`window.pigmentApp`, `window.__pigmentTest`).
- `npm run test:electron` — launches the real app (xvfb on Linux): bridge, menu, open/save through the main process, packaged build.
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
- **Filter dialogs** (`lib/filter-ui.js`): `filter:<kind>` commands exist for every registry kind (label from `name`, "…" when the kind has fields or a custom UI; disabled while `placeholder`). `app.filterEditor.register(kind, { fields?, margin?, open? })` adds dialog fields or a custom opener `open(kind, { params, def, ctx }) -> Promise<params | null>`; a custom opener owns its session (`app.beginPixelEdit` / `app.pixelEditDialog`, or a `TransformTool`-like on-canvas session) and resolves with the params it committed (they are remembered for Last Filter and recorded for actions). `app.filterEditor.fields(kind)`, `defaults(kind)`, `ranges(kind)`, `toRun`, `remember(kind, params)`, `run(kind, params, { dialog, ctx })` are available. Smart filters (`lib/smart-object.js`) re-run any kind from `{ kind, params }` with `FILTERS[kind].apply`, so custom-UI kinds must be fully described by their params (pins in image fractions, paths as point lists, never DOM state).
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
