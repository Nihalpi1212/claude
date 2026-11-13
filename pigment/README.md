# Pigment

A free, open-source image editor for **Windows** and **macOS** (Linux too) that covers what people use
Adobe Photoshop for: layers and masks, painting and retouching, selections, adjustments, filters,
layer styles, text and vector shapes, image modes, actions and batch processing, with Photoshop's
shortcuts and PSD files. No account, no subscription, no telemetry.

Built with [Electron](https://www.electronjs.org/) and plain JavaScript (no framework, no bundler),
with [ag-psd](https://github.com/Agamnentzar/ag-psd) for Photoshop files. MIT licensed.

## Features

**Documents and files**
- Tabs for several images, drag and drop, "Open with" from the file manager, recent files, quick-start sizes
- Open PSD/PSB (layers, groups, masks, opacity, blend modes, visibility), PNG (8- and 16-bit, palette),
  JPEG, WebP, GIF, TIFF, Targa, BMP, AVIF, SVG, ICO; Open as Smart Object
- Save layered work as **.pigment** (zip with PNG layers, masks, styles, channels, paths, guides,
  16/32-bit pixels) or **.psd**; Save As also writes PNG, JPEG, WebP, GIF, TIFF and Targa
- Export As PNG, PNG-8, 16-bit PNG, JPEG, WebP, GIF, TIFF (8/16/32-bit, LZW / Deflate / PackBits) and
  Targa with quality, scale and size; quick PNG export; export layers to files; Quick Export and
  Export As for the selected layers
- **Save for Web (Legacy)**: original and optimised side by side for GIF, PNG-8, PNG-24, JPEG and
  WebP, with palette, dither, transparency, image size and a file-size estimate
- **File Info** (title, author, copyright, keywords, rating, read-only camera data), written as XMP
  into PSD files; Close Others; Purge
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
- Background from Layer / Layer from Background, Group from Layers, Delete Hidden Layers, Rasterize
  All Layers, Link Layers and Select Linked Layers, colour labels
- **Find Layers** (filter the Layers panel by kind, name, effect, mode, attribute or colour) and
  **Isolate Layers**
- **Matting**: Defringe, Color Decontaminate, Remove Black / White Matte
- **Smart objects**: place files as smart objects or convert layers into one, edit the contents in
  their own tab, replace or export the source, transform without losing quality, reset the transform
- **Smart filters**: filters, adjustments and the Camera Raw filter applied to a smart object stay
  editable (double-click to change, toggle or clear them in the Layers panel)
- **Stack modes** on a smart object (mean, median, maximum, minimum, range, and seven more) and
  Convert to Layers

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
- **Select Subject**, **Select Sky** and **Focus Area** (colour, saliency and sharpness heuristics that
  run on your computer, not a learned model)
- **Object Selection tool**: drag a box or lasso around an object and the selection shrinks to it
- **Select and Mask** workspace: quick selection, refine edge brush, brush, lasso and object
  selection tools, seven view modes, edge detection radius, smooth / feather / contrast / shift
  edge, Decontaminate Colors, output to a selection, mask, layer or document

**Adjust and filter**
- Brightness/contrast, levels (with histogram and auto), curves (editable curve per channel),
  exposure, vibrance, hue/saturation (with colorize), color balance, black & white, photo filter,
  channel mixer, invert, posterize, threshold, gradient map, selective color, shadows/highlights,
  desaturate, equalize; auto tone, auto contrast, auto color; Fade
- **Color Lookup** (31 built-in looks, and .cube, .3dl, .look and .csp files), **HDR Toning**,
  **Match Color**, **Replace Color**; Export Color Lookup Tables (.cube, .3dl)
- Most adjustments also work as a non-destructive adjustment layer with its own mask
- **Apply Image** and **Calculations**: blend a layer or channel of one image into another, or two
  channels into a new channel, selection or document
- More than 70 filters in the Filter menu with live preview:
  - Blur: average, blur, blur more, box, Gaussian, lens (with a depth map), motion, radial, shape,
    smart and surface blur
  - Sharpen: sharpen, sharpen edges, sharpen more, smart sharpen, unsharp mask, shake reduction
  - Noise: add noise, despeckle, dust & scratches, median, reduce noise
  - Pixelate: color halftone, crystallize, facet, fragment, mezzotint, mosaic, pointillize
  - Distort: displace, pinch, polar coordinates, ripple, shear, spherize, twirl, wave, zigzag
  - Stylize: diffuse, emboss, extrude, find edges, glowing edges, oil paint, solarize, tiles, trace
    contour, wind
  - Render: clouds, difference clouds, fibers, flame, lens flare, lighting effects, picture frame,
    tree, vignette
  - Video and Other: de-interlace, NTSC colors; custom kernel, high pass, HSB/HSL, maximum, minimum,
    offset; Last Filter (Ctrl+F)
- **Filter Gallery**: 46 more effects (Artistic, Brush Strokes, Distort, Sketch, Texture) that stack
  as effect layers in one dialog
- **Blur Gallery**: Field, Iris, Tilt-Shift, Path and Spin Blur with pins and handles on the canvas,
  bokeh and noise
- **Lens Correction** (Ctrl+Shift+R): distortion, chromatic aberration, vignette, perspective, angle
  and scale, with straighten and remove-distortion tools and automatic horizon detection
- **Liquify** (Shift+Ctrl+X): forward warp, reconstruct, twirl, pucker and bloat brushes
- **Camera Raw Filter** (Ctrl+Shift+A): white balance, exposure, contrast, highlights, shadows, whites,
  blacks, texture, clarity, dehaze, vibrance, saturation, HSL per colour range, sharpening, noise
  reduction, vignette and grain, with Auto

**Transform and canvas**
- Free transform (Ctrl+T): scale, rotate, skew, distort, perspective, numeric entry, flips and 90° turns;
  transforms pixels, selections, text and shapes; Transform Again
- Image size (bicubic, Lanczos, bilinear, area, nearest), canvas size with anchor, rotate canvas,
  crop tool with ratios and overlays, crop to selection, trim, reveal all, duplicate image
- **Perspective Crop tool**: mark the four corners of a slanted rectangle and crop it flat
- **Content-Aware Scale** (Ctrl+Alt+Shift+C): resize by removing or inserting seams through the
  unimportant areas, with a protected channel and skin-tone protection
- **Warp** (Edit › Transform › Warp): a Bézier control net with Arc, Arch, Bulge, Flag, Wave, Fish,
  Rise, Fisheye, Inflate, Squeeze, Twist and more presets and a Bend slider
- **Perspective Warp**: lay out quads on the planes of a photo, then move their corners
- **Puppet Warp**: a mesh over the layer, pins to hold and drag, rigid / normal / distort modes

**Modes and bit depth**
- Image › Mode: Bitmap, Grayscale, Duotone (mono- to quadtone), Indexed Color (with Color Table),
  RGB, CMYK, Lab and Multichannel; Trap; Conditional Mode Change
- 8, 16 and 32 bits per channel: tonal adjustments, crop, flips, 90° turns and Flatten Image keep
  the full precision; 16-bit PNG and TIFF in and out
- Channels panel that follows the mode (CMYK, Lab, grey, index and spot channels)

**Combine images**
- **Auto-Align Layers** (Auto, Perspective, Collage, Cylindrical, Spherical, Reposition) and
  **Auto-Blend Layers** (panorama seams or focus stacking)
- **Photomerge**, **Load Files into Stack**, **Statistics**, **Merge to HDR** (exposure fusion)

**Actions and automation**
- **Actions panel** (Alt+F9): record, play, edit, save and load actions; stops, menu items,
  conditionals, function keys, Button Mode, a Default Actions set
- **Batch** and **Image Processor** over folders or open files; Fit Image, Crop and Straighten
  Photos, Contact Sheet, Delete All Empty Layers, Flatten All Layer Effects, Flatten All Masks

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
  History (with snapshots), Actions, Navigator, Info, AI Assistant
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

For a feature-by-feature comparison with Photoshop (1,432 entries, each marked done, partial,
approximate, missing or not feasible, with the release that plans it), see
[docs/PARITY.md](docs/PARITY.md).

Missing features:

- Several styles inside one text layer (one font, size and colour per layer); text on a path follows
  the first subpath of the chosen path
- Artboards, frames, vector masks, layer comps and slices
- The full Brush Settings engine (shape dynamics, scattering, texture, dual brush) and `.abr` brush
  files; the mixer brush and the art history brush
- Timeline, animation and video; 3D
- Opening camera RAW files (CR2, NEF, ARW, DNG…): the Camera Raw filter develops RGB images only
- ICC colour management: no profiles are read, converted or embedded, everything is treated as sRGB
- Vanishing Point, Adaptive Wide Angle and Neural Filters
- Photoshop `.atn` action files (actions are saved as `.pigment-actions`), lens profiles, and
  Adobe's cloud features (libraries, cloud documents, Adobe Fonts, Firefly)

Limits of what is there:

- **CMYK, Lab and Multichannel are views of RGB pixels.** Pigment always stores RGBA; those modes
  change the channels you see and what the Info panel reports, not how the file is stored. There is
  no ink-accurate separation. Proof Colors and Gamut Warning are previews of the same kind
- **16 and 32 bits**: Levels, Curves and the other tonal adjustments, crop, canvas size, flips, 90°
  turns and Flatten Image work at full precision. Painting, retouching, filters, Image Size, Free
  Transform and the warps work at 8 bits on the pixels they touch. Masks are 8-bit. 32-bit is
  display-referred float (highlights above white are kept), not linear light. PSD files are written
  at 8 bits
- **Color Lookup presets** carry Photoshop's names but are generated by Pigment; they approximate
  Adobe's tables and do not match them. Loaded LUT files are applied as they are
- **Merge to HDR** is exposure fusion into a normal image followed by HDR Toning, not a 32-bit
  radiance map
- **Select Subject, Select Sky and Focus Area** are heuristics (colour, saliency, sharpness), not a
  learned model, and can pick the wrong region in a busy scene. The AI menu's Remove Background uses
  a provider model instead
- **Shake Reduction** estimates one straight blur trace; curved or mixed camera shake is not removed
- **Lens Correction** has no lens profile database: Auto Correction straightens the horizon and
  switches the manual corrections on and off. Auto-Align's vignette and distortion options are
  estimated from the images for the same reason
- Lighting Effects edits one light in its dialog. A Displace map or a texture loaded from a file is
  not stored with an action or a saved smart filter and has to be chosen again
- Save for Web has the 2-up view only (no 4-up, slices or animation); GIF is read and written as a
  single frame
- TIFF: no JPEG-in-TIFF, CCITT, YCbCr, Lab or BigTIFF; multi-page files open their first image
- Actions do not record brush strokes, Move tool drags, the Warp tools or Fade
- Linked layers move together with the Move tool only; colour labels and links are saved in
  `.pigment`, not in PSD
- Masks on individual smart filters (the smart object's layer mask applies to all of them); Last
  Filter does not repeat the Camera Raw filter; Warp, Perspective Warp and Puppet Warp rasterize a
  smart object first
- Image generation through a ChatGPT plan: OpenAI only serves image models to API keys, so
  Generative Fill, Generate Image and the background tools need an OpenAI or Gemini key. Plan
  sign-in covers Describe Image and the assistant
- Sign in with ChatGPT in the browser build (`npm run dev:web`): it needs the desktop app, so the
  browser build takes API keys only
