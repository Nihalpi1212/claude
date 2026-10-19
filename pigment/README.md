# Pigment

A free, open-source image editor for **Windows** and **macOS** (Linux too) that covers what people use
Adobe Photoshop for: layers and masks, painting and retouching, selections, adjustments, filters,
layer styles, text and vector shapes, with Photoshop's shortcuts and PSD files. No account, no
subscription, no telemetry.

Built with [Electron](https://www.electronjs.org/) and plain JavaScript (no framework, no bundler),
with [ag-psd](https://github.com/Agamnentzar/ag-psd) for Photoshop files. MIT licensed.

## Features

**Documents and files**
- Tabs for several images, drag and drop, "Open with" from the file manager, recent files, quick-start sizes
- Open PSD/PSB (layers, groups, masks, opacity, blend modes, visibility), PNG, JPEG, WebP, GIF, BMP, AVIF, SVG, ICO
- Save layered work as **.pigment** (zip with PNG layers, masks, styles, channels, paths, guides) or **.psd**
- Export As PNG / JPEG / WebP with quality, scale and size; quick PNG export; export layers to files
- Copy and paste through the system clipboard (paste into, paste in place, new image from clipboard)

**Layers**
- Pixel, text, shape, fill (solid, gradient, pattern) and adjustment layers; groups with pass-through
- Layer masks (reveal/hide all or selection, from transparency, apply, disable, link), clipping masks
- 27 blend modes, opacity and fill opacity, locks, align and distribute, merge, flatten, rasterize
- **Layer styles**: drop shadow, inner shadow, outer and inner glow, bevel and emboss, satin, color,
  gradient and pattern overlay, stroke; copy/paste styles; global light
- Thumbnails, drag-and-drop reordering, rename in place, solo visibility (Alt-click the eye)

**Paint and retouch**
- Brush, pencil, eraser with size, hardness, opacity, flow, spacing, smoothing and pen pressure
- Brush presets, color picker, swatches, eyedropper and color sampler
- **Content-Aware Fill** and a content-aware spot healing brush; healing brush, patch, red eye, clone stamp, pattern stamp, history brush
- Background eraser, magic eraser, color replacement, blur, sharpen, smudge, dodge, burn, sponge
- Paint bucket and gradients (linear, radial, angle, reflected, diamond) with presets and dithering

**Select**
- Rectangular, elliptical, single row/column marquee; lasso, polygonal and magnetic lasso
- Magic wand and quick selection; add/subtract/intersect; feather and anti-aliasing
- Color range, grow, similar, border, smooth, expand, contract, feather, transform selection
- Quick mask (Q), save and load selections as channels, layer transparency as selection

**Adjust and filter**
- Brightness/contrast, levels (with histogram and auto), curves (editable curve per channel),
  exposure, vibrance, hue/saturation (with colorize), color balance, black & white, photo filter,
  channel mixer, invert, posterize, threshold, gradient map, selective color, shadows/highlights,
  desaturate, equalize; auto tone, auto contrast, auto color; Fade
- Every adjustment also works as a non-destructive adjustment layer with its own mask
- 40+ filters with live preview: Gaussian, box, motion, radial and surface blur; sharpen, unsharp
  mask, smart sharpen, high pass; add noise, median, despeckle, dust & scratches, reduce noise;
  mosaic, crystallize, pointillize, fragment; twirl, pinch, spherize, ripple, wave, zigzag, polar
  coordinates, shear, offset; emboss, find edges, solarize, diffuse, oil paint, glowing edges;
  clouds, difference clouds, lens flare, vignette; maximum, minimum, custom kernel; Last Filter (Ctrl+F)
- **Liquify** (Shift+Ctrl+X): forward warp, reconstruct, twirl, pucker and bloat brushes

**Transform and canvas**
- Free transform (Ctrl+T): scale, rotate, skew, distort, perspective, numeric entry, flips and 90° turns;
  transforms pixels, selections, text and shapes; Transform Again
- Image size (bicubic, Lanczos, bilinear, area, nearest), canvas size with anchor, rotate canvas,
  crop tool with ratios and overlays, crop to selection, trim, reveal all, duplicate image

**Type and vectors**
- Point and paragraph text, editable at any time: font, style, size, leading, tracking, color, alignment, stroke
- Rectangle, rounded rectangle, ellipse, polygon/star, line and custom shapes as shape layers, paths or pixels
- Pen, freeform pen, add/delete/convert anchor points, path and direct selection; Paths panel
  (fill, stroke, make selection, path from selection)

**Workspace**
- Photoshop's menu layout and keyboard shortcuts, tool flyouts, options bar
- Panels: Color, Swatches, Brushes, Properties, Adjustments, Character, Paths, Layers, Channels,
  History (with snapshots), Navigator, Info
- Rulers, guides, grid, pixel grid, snapping, view rotation, light and dark themes

## Download

Installers are produced by the **Pigment release** GitHub Actions workflow and attached to each GitHub
Release tagged `pigment-v*`:

| Platform | File |
|---|---|
| Windows 10/11 (x64, Arm) | `pigment-<version>-win-<arch>.exe` (installer) or `pigment-<version>-win-portable.exe` |
| macOS 11+ (Apple silicon and Intel) | `pigment-<version>-mac-universal.dmg` |
| Linux (x64) | `pigment-<version>-linux-x86_64.AppImage` |

The builds are **not code-signed** (signing certificates cost money and are not part of this repository), so:

- **macOS**: the first time, right-click (or Control-click) *Pigment.app* and choose **Open**, then **Open**
  again. Alternatively run `xattr -dr com.apple.quarantine /Applications/Pigment.app`.
- **Windows**: in the SmartScreen prompt choose **More info** and then **Run anyway**.

## Build it yourself

You need Node.js 22.

```sh
cd pigment
npm ci            # also bundles ag-psd into src/renderer/vendor
npm start         # run the app
npm test          # unit tests of the pixel engine (node:test)
npm run test:e2e  # end-to-end tests in Chromium (Playwright)
npm run dist:mac  # or dist:win / dist:linux: installers in dist/
```

`npm run dev:web` serves the editor at http://127.0.0.1:8766 so it can run in a normal browser
(files are read and written in memory there).

## How it works

- `src/main/` is the Electron main process (window, native menu, file dialogs, settings, recent files).
  The renderer is sandboxed and talks to it only through the preload bridge (`src/preload.cjs`).
- `src/shared/pixels/` is the image-processing engine: blend modes, adjustments, filters, layer styles,
  selections, transforms and retouching, written as pure functions on RGBA buffers and unit-tested in Node.
- `src/renderer/` is the editor: the document model and compositor, history (undo), the canvas view,
  tools, panels and dialogs. See [ARCHITECTURE.md](ARCHITECTURE.md) and the
  [user guide](docs/USER-GUIDE.md).

## What it does not do (yet)

- CMYK, Lab, 16/32-bit channels and color management (Pigment edits 8-bit RGB)
- Smart objects, artboards, 3D, video timelines, camera RAW
- Generative fill and other AI features
- Puppet warp, perspective warp, sky replacement and other AI-based tools
- Text on a path; vertical type is horizontal text turned 90° (no upright stacked CJK layout); one style per text layer
- Shape path operations (combine, subtract, intersect shapes)
- Printing (export an image and print it from your system's image viewer)
