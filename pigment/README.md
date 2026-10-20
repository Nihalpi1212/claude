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
- **Print** (Ctrl+P): printer, paper size, orientation, margins, scale and position with a page preview;
  Save as PDF

**Layers**
- Pixel, text, shape, fill (solid, gradient, pattern) and adjustment layers; groups with pass-through
- Layer masks (reveal/hide all or selection, from transparency, apply, disable, link), clipping masks
- 27 blend modes, opacity and fill opacity, locks, align and distribute, merge, flatten, rasterize
- **Layer styles**: drop shadow, inner shadow, outer and inner glow, bevel and emboss, satin, color,
  gradient and pattern overlay, stroke; copy/paste styles; global light
- Thumbnails, drag-and-drop reordering, rename in place, solo visibility (Alt-click the eye)
- **Smart objects**: place files as smart objects or convert layers into one, edit the contents in
  their own tab, replace or export the source, transform without losing quality, reset the transform
- **Smart filters**: filters, adjustments and the Camera Raw filter applied to a smart object stay
  editable (double-click to change, toggle or clear them in the Layers panel)

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
- **Camera Raw Filter** (Ctrl+Shift+A): white balance, exposure, contrast, highlights, shadows, whites,
  blacks, texture, clarity, dehaze, vibrance, saturation, HSL per colour range, sharpening, noise
  reduction, vignette and grain, with Auto

**Transform and canvas**
- Free transform (Ctrl+T): scale, rotate, skew, distort, perspective, numeric entry, flips and 90° turns;
  transforms pixels, selections, text and shapes; Transform Again
- Image size (bicubic, Lanczos, bilinear, area, nearest), canvas size with anchor, rotate canvas,
  crop tool with ratios and overlays, crop to selection, trim, reveal all, duplicate image
- **Warp** (Edit › Transform › Warp): a Bézier control net with Arc, Arch, Bulge, Flag, Wave, Fish,
  Rise, Fisheye, Inflate, Squeeze, Twist and more presets and a Bend slider
- **Perspective Warp**: lay out quads on the planes of a photo, then move their corners
- **Puppet Warp**: a mesh over the layer, pins to hold and drag, rigid / normal / distort modes

**Type and vectors**
- Point and paragraph text, editable at any time: font, style, size, leading, tracking, color, alignment, stroke
- **Text on a path**: type along any path or shape, slide and flip it; horizontal, vertical and
  **stacked vertical** (upright CJK) orientation
- Rectangle, rounded rectangle, ellipse, polygon/star, line and custom shapes as shape layers, paths or pixels
- **Path operations**: combine, subtract, intersect and exclude shape areas, merge shape components
- Pen, freeform pen, add/delete/convert anchor points, path and direct selection; Paths panel
  (fill, stroke, make selection, path from selection)

**AI (optional, bring your own account)**
- **Sign in with ChatGPT** (uses your ChatGPT Plus or Pro plan for the chat models), or an OpenAI or
  Google Gemini **API key**; credentials stay on your computer, encrypted with the system keychain
- **Generative Fill** and **Generative Expand**, **Generate Image** (new layer or document),
  **Remove Background** (as a layer mask), **Replace Background**, **Replace Sky**, **Describe Image**
- **AI Assistant** panel: chat about the open image and let the model edit it; adjustments, filters,
  selections, crop, resize, layers, text and generative fill all land as undoable history steps

**Workspace**
- Photoshop's menu layout and keyboard shortcuts, tool flyouts, options bar
- Panels: Color, Swatches, Brushes, Properties, Adjustments, Character, Paths, Layers, Channels,
  History (with snapshots), Navigator, Info, AI Assistant
- **Proof Colors** (CMYK preview) and **Gamut Warning**; Lab and CMYK readouts in the Info panel and
  the Color Picker
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

- `src/main/` is the Electron main process (window, native menu, file dialogs, settings, recent files,
  printing). The renderer is sandboxed and talks to it only through the preload bridge (`src/preload.cjs`).
- `src/main/ai.js` holds the AI accounts: the Sign in with ChatGPT flow, API keys encrypted with
  Electron's `safeStorage`, and the only code that talks to the providers. The renderer never sees a
  token or key; it sends request descriptions and receives answers.
- `src/shared/pixels/` is the image-processing engine: blend modes, adjustments, filters, layer styles,
  selections, transforms and retouching, written as pure functions on RGBA buffers and unit-tested in Node.
- `src/renderer/` is the editor: the document model and compositor, history (undo), the canvas view,
  tools, panels and dialogs. See [ARCHITECTURE.md](ARCHITECTURE.md) and the
  [user guide](docs/USER-GUIDE.md).

## What it does not do (yet)

- True CMYK, Lab, 16/32-bit documents and ICC colour management: Pigment edits 8-bit RGB. Proof
  Colors, Gamut Warning and the Lab/CMYK readouts are previews and conversions of that RGB data
- Opening camera RAW files (CR2, NEF, ARW, DNG…): the Camera Raw filter develops RGB images only
- Artboards, 3D, video timelines
- Several styles inside one text layer (one font, size and colour per layer); text on a path follows
  the first subpath of the chosen path
- Masks on individual smart filters (the smart object's layer mask applies to all of them); Last
  Filter does not repeat the Camera Raw filter
- Image generation through a ChatGPT plan: OpenAI only serves image models to API keys, so
  Generative Fill, Generate Image and the background tools need an OpenAI or Gemini key. Plan
  sign-in covers Describe Image and the assistant
- Sign in with ChatGPT in the browser build (`npm run dev:web`): it needs the desktop app, so the
  browser build takes API keys only
