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
- **Export As**: PNG (8-bit, transparency), JPEG (quality, background), WebP (quality / lossless), BMP? (no), PSD (ag-psd `writePsd`: raster layers, groups, masks, opacity/blend/visibility, text layers as text), scale/resample, metadata strip, "quick export" PNG.
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
