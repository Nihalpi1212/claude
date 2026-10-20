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
