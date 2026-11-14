# Pigment

A free, open-source image editor for **Windows** and **macOS** (Linux too) that covers what people use
Adobe Photoshop for: layers and masks, painting and retouching, selections, adjustments, filters,
layer styles, text and vector shapes, image modes, actions and batch processing, with Photoshop's
shortcuts and PSD files. No account, no subscription, no telemetry.

Built with [Electron](https://www.electronjs.org/) and plain JavaScript (no framework, no bundler),
with [ag-psd](https://github.com/Agamnentzar/ag-psd) for Photoshop files and
[HarfBuzz](https://harfbuzz.github.io/) (harfbuzzjs) for text shaping. MIT licensed.

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
- **Vector masks** (Reveal All, Hide All, Current Path, delete, disable, link, rasterize), edited with
  the path tools and shown in the Layers and Paths panels; Mask and Shape buttons on the path
  selection tools, Make Vector Mask in the Paths panel
- **Mask density and feather**, non-destructive, for layer and vector masks in the Properties panel,
  with Select and Mask, Color Range and Invert there; the mask overlay (\\) with its colour and opacity
- 27 blend modes, opacity and fill opacity, locks, align and distribute, merge, flatten, rasterize
- **Layer styles**: drop shadow, inner shadow, outer and inner glow, bevel and emboss, satin, color,
  gradient and pattern overlay, stroke, with Photoshop's fields for each: contours (Contour Editor and
  built-in contours), noise, glow technique, Bevel & Emboss Contour and Texture, gradient and pattern
  strokes; several instances of Drop Shadow, Inner Shadow, Color Overlay, Gradient Overlay and Stroke;
  drag in the document to place a shadow, satin, gradient or pattern; copy/paste styles; global light.
  Each shadow, glow and outer stroke blends with the layers below in its own blend mode, as in Photoshop
- **Blending Options**: fill opacity, channels, knockout (Shallow, Deep), Blend Interior Effects as
  Group, Blend Clipped Layers as Group, the mask-hides-effects options and Blend If with split sliders,
  also on adjustment layers; layer styles on groups; Create Layers, Hide All Effects, Scale Effects
- **Layers panel**: effects listed under each layer with their own eyes (drag them between layers);
  Opacity and Fill as scrubby fields for every selected layer; blend-mode menu that previews on the
  canvas while you hover; drag several rows, Alt-drag to copy, drag down the eye column; Alt-click
  between layers to clip; panel menu with Panel Options and Collapse All Groups; thumbnails,
  rename in place, solo visibility (Alt-click the eye)
- **Layer menu**: New Layer, New Group and Duplicate Layer dialogs (to another open document too),
  Arrange with Reverse, Distribute by every edge and centre and by equal gaps, Lock Layers and Lock All
  Layers in Group, Merge Down / Merge Layers / Merge Group on Ctrl+E, Stamp Visible and Stamp Layers,
  Select › Similar Layers, Rasterize Type / Shape / Fill Content / Vector Mask / Smart Object; opacity,
  fill and blend-mode keys (digits, Shift+digits, Shift+Alt+letters); Photoshop's Background rules
- Background from Layer / Layer from Background, Group from Layers, Delete Hidden Layers, Rasterize
  All Layers, Link Layers and Select Linked Layers, colour labels
- **Find Layers** (filter the Layers panel by kind, name, effect, mode, attribute or colour) and
  **Isolate Layers** (the samplers see only the isolated layers)
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
- Background eraser, magic eraser, color replacement, blur, sharpen, smudge, dodge, burn, sponge;
  the **Adjustment Brush**
- Paint bucket and gradients (linear, radial, angle, reflected, diamond) with dithering
- **Gradients**: the Gradient Editor (colour and opacity stops, midpoints, smoothness, presets with New,
  Save, Import and Export), noise gradients, the five interpolation methods (Perceptual, Linear,
  Classic, Smooth, Stripes), the gradient picker with preset groups, the Gradients panel, live
  gradients edited on the canvas, and Gradient Fill layers with Method, Dither and Offset; the same
  gradients in shapes, Gradient Map, Gradient Overlay and Stroke
- **Patterns**: a pattern library with built-in patterns, the Patterns panel and pattern picker,
  Define Pattern with a name, Edit › Fill with Scripted Patterns (Brick Fill, Cross Weave, Place Along
  Path, Random Fill, Spiral, Symmetry Fill), Pattern Fill layers with Angle, Link with Layer and Snap to
  Origin, View › Pattern Preview, and drag a pattern onto the canvas to make a fill layer

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
- Brightness/contrast, levels, curves, exposure, vibrance, hue/saturation (with colorize), color
  balance, black & white, photo filter, channel mixer, invert, posterize, threshold, gradient map,
  selective color, shadows/highlights, desaturate, equalize; auto tone, auto contrast, auto color; Fade
- **Levels and Curves** as in Photoshop: input and output sliders, black / grey / white point
  eyedroppers, the clipping display (Alt-drag, Show Clipping), Curves' pencil mode with Smooth, the
  on-image tool and Curve Display Options, Auto with Auto Color Correction Options, channels in Gray,
  CMYK and Lab documents, and presets that read and write Photoshop's .alv and .acv files. Exposure
  eyedroppers, the Threshold histogram, Brightness/Contrast Auto
- **Hue/Saturation** with several colour ranges, range eyedroppers and the on-image tool;
  Shadows/Highlights with Photoshop's Show More Options; presets for Hue/Saturation, Channel Mixer,
  Selective Color and Black & White that read and write Photoshop's preset files; HDR Toning presets
- New adjustments: **Color and Vibrance**, **Clarity and Dehaze** and **Grain**; the Adjustments panel
  has built-in presets; Alt+Ctrl+L / M / U / B open Levels, Curves, Hue/Saturation and Color Balance
  with the last values (the dialogs otherwise open with the defaults, as in Photoshop)
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
- Point and paragraph text, editable at any time, with **several fonts, sizes, colours and styles in
  one layer**, shaped by HarfBuzz (kerning, ligatures, complex scripts, colour fonts and emoji; a missing
  character falls back to another installed font); paragraph boxes with a height that show overflow
- **On-canvas editing**: the Type tool draws its own cursor and selection, with Photoshop's selection
  clicks, formatted copy and paste between type layers, Paste Without Formatting, input methods and
  dead keys, tab characters, placeholder text, an eight-handle paragraph box, moving and transforming
  the text while editing, and Photoshop's type keys
- **Character panel** on the selected characters: leading with Auto, kerning (Metrics, Optical,
  manual), tracking in 1/1000 em, vertical and horizontal scale, baseline shift, Faux Bold and Italic,
  All Caps, Small Caps, superscript, subscript, underline, strikethrough, language, No Break, Reset
  Character; type sizes in pixels, points or millimetres
- **Paragraph panel**: alignment and justification (justify last left, centred, right, all), indents,
  space before and after, the Single-line and Every-line composers, Justification settings (word and
  letter spacing, glyph scaling), hyphenation in eight languages with the Hyphenation settings, Roman
  Hanging Punctuation, bulleted and numbered lists; a Type menu with the Character and Paragraph panels
- **Text on a path**: type along any path or shape, slide and flip it; horizontal, vertical and
  **stacked vertical** (upright CJK) orientation
- **Live shapes**: rectangle (with corner radii, each editable on the canvas), rounded rectangle,
  ellipse, triangle, polygon/star (sides, star ratio, smooth corners), line (weight, arrowheads) and
  custom shapes stay editable in the Properties panel through moves, transforms and canvas changes;
  fills and strokes in solid colour, gradient or pattern, stroke caps, joins and dashes; Copy / Paste
  Shape Attributes; shape layers, paths or pixels
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
- Photoshop's menu layout and **default keyboard shortcuts** (Ctrl+F is Search, Alt+Ctrl+Z Toggle Last
  State, Ctrl+Y Proof Colors, as in Photoshop), tool flyouts, options bar
- **Search** (Ctrl+F) for tools, menu commands and panels; **spring-loaded tools** (hold Ctrl for
  Move, Alt for the Eyedropper, or a tool key for that tool while it is held; Ctrl/Alt+Space to zoom)
- **Numeric fields** that take arithmetic (`100+50`), percentages and units, step with Shift+arrow
  and the wheel, and scrub when you drag their label; dialogs that move, leave the canvas visible and
  navigable, and turn Cancel into Reset while Alt is held
- Panels: Color, Swatches, Gradients, Patterns, Brushes, Properties, Adjustments, Character,
  Paragraph, Paths, Layers, Channels, History (with snapshots), Actions, Navigator, Info, AI Assistant
- **Proof Colors** (CMYK preview) and **Gamut Warning**; Lab and CMYK readouts in the Info panel and
  the Color Picker
- **Guides and rulers**: guides with their own colours that can be selected, moved and deleted with the
  Move tool, Lock Guides, New Guide Layout, New Guides From Shape, Edit Selected Guides; ruler units and
  a movable ruler origin; grid colour, style and subdivisions
- **Snap To** guides, grid, layers and document bounds for every placing tool (marquee, crop, shapes,
  pen, Free Transform, type box, gradient), nearest target first; **Smart Guides** with alignment
  lines, equal spacing and Ctrl-hover distances
- Pixel grid, view rotation, light and dark themes

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
npm ci            # also bundles ag-psd and HarfBuzz into src/renderer/vendor
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

- The font menu of Photoshop (search, previews, favourites, variable-font axes), Warp Text, Convert to
  Shape and the other Type menu commands, OpenType features and the Glyphs panel, Character and
  Paragraph Styles, spelling and Find and Replace; text on a path follows the first subpath of the
  chosen path, and there is no area type
- Right-to-left and mixed-direction paragraphs (no bidirectional reordering across runs) and East
  Asian typography beyond stacked vertical text
- Artboards, frames, layer comps and slices
- The full Brush Settings engine (shape dynamics, scattering, texture, dual brush) and `.abr` brush
  files; the mixer brush and the art history brush
- The Styles, Shapes and Tool Presets panels; Photoshop's preset files for gradients (`.grd`),
  patterns (`.pat`), styles (`.asl`), contours (`.shc`) and swatches; the Preset Manager
- Editing the keyboard shortcuts and menus (Edit › Menus… is not built yet)
- Timeline, animation and video; 3D
- Opening camera RAW files (CR2, NEF, ARW, DNG…): the Camera Raw filter develops RGB images only
- ICC colour management: no profiles are read, converted or embedded, everything is treated as sRGB
- Vanishing Point, Adaptive Wide Angle and Neural Filters
- Photoshop `.atn` action files (actions are saved as `.pigment-actions`), lens profiles, and
  Adobe's cloud features (libraries, cloud documents, Adobe Fonts, Firefly)

Except Adobe's cloud features, each of these has a planned release in [docs/PARITY.md](docs/PARITY.md) ("Planned releases"): 0.5
brings the brush engine, ICC colour management, PSD fidelity for 0.4's layers and text, Camera Raw
depth, the preset panels and files, the colour picker and swatches, the font menu, the Type menu
commands and the shortcut editor; 0.6 selections, channels, colour settings and proofing, export and
save options, RAW opening and PDF import; later releases artboards, layer comps, slices, animation,
video and the rest.

Limits of what is there:

- **CMYK, Lab and Multichannel are views of RGB pixels.** Pigment always stores RGBA; those modes
  change the channels you see and what the Info panel reports, not how the file is stored. There is
  no ink-accurate separation. Proof Colors and Gamut Warning are previews of the same kind
- **16 and 32 bits**: Levels, Curves and the other tonal adjustments, crop, canvas size, flips, 90°
  turns and Flatten Image work at full precision. Painting, retouching, filters, Image Size, Free
  Transform and the warps work at 8 bits on the pixels they touch. Masks are 8-bit. 32-bit is
  display-referred float (highlights above white are kept), not linear light. Merges, stamps and
  clipping masks keep full precision, but layers with effects, knockout or Blend If on a pixel layer,
  blend modes other than Normal, Multiply and Screen, Merge Group, and Levels or Curves in the CMYK or
  Lab space go through the 8-bit composite. PSD files are written at 8 bits
- **PSD export of 0.4's features waits for 0.5**: the merged image is right, and Fill, Blend If,
  Hue/Saturation ranges, the Gradient Map's method and guides are written, but layer effects, knockout,
  the channel restriction and the other advanced blending options, and live shape parameters are not
  (saving says which layers lose them); the three new adjustments are written as hidden placeholders;
  masks are written with density, feather and the vector mask baked into a raster mask; a text layer
  with several styles or a stroke is written as pixels. Vector masks and layer effects are not read
  from PSD files
- **Type**: anti-aliasing methods are stored but text is drawn smooth; OpenType-SVG colour glyphs draw
  as plain outlines; variable fonts draw at their default instance; Hyphenate Across Column has no
  effect, only the eight bundled languages hyphenate, and East Asian Width is approximated in line
  breaking; converting paragraph to point text keeps each paragraph on one line; Reset Character keeps
  the font, size and colour. The vertical type modes keep 0.3's layout. In the browser build without the
  font permission, text is drawn by 0.3's Canvas engine (Optical kerning falls back to Metrics there)
- **Layer styles**: Create Layers cannot match the picture with knockout, a layer opacity below 100 % with
  exterior effects, or a Fill below 100 % with interior effects (it warns, as Photoshop does), and Dissolve
  effects speckle differently once they are layers; Stroke has no Overprint; there is no Make
  Default and no Styles page in the Layer Style dialog; dragging a shadow that uses global light sets
  its own angle instead of moving the global light
- **Adjustments**: the Properties panel does not show the Levels and Curves clipping display; built-in
  preset values (adjustment dialogs, Black & White Auto, Channel Mixer, HDR Toning) approximate
  Photoshop's; preset groups cannot be created; the Adjustments panel presets are built-in only and do
  not preview on hover; HDR Toning (.hdt) and Shadows/Highlights (.shh) files are not read. Clarity and
  Dehaze use a fixed neighbourhood, and Levels and Curves in CMYK and Lab follow Pigment's simple
  conversions, so they match Photoshop only roughly
- **Gradients and patterns**: the on-canvas gradient widget edits colour stops and end points only;
  Align with Layer is not offered on Gradient Fill layers. Scripted Patterns are Pigment's own
  placements modelled on Photoshop's scripts, not their exact output. An action that recorded New Fill
  Layer › Pattern with a pattern that is no longer in the library replays the current pattern
- **Guides and snapping**: no artboard guides or slices (Snap To › Artboards and Slices have no targets);
  the Properties panel's transform section and the Free Transform bar show pixels, not ruler units; the
  rulers do not follow a rotated view; Smart Guides do not show while a path is drawn
- **Masks and shapes**: Color Range from the Properties panel makes two History steps; the Mask and Shape
  buttons are not on the Pen tool's Path mode; corner widgets show with the shape and path selection
  tools, not with the Move tool's transform controls; the Stroke options have no "Align dashes to corners
  and path ends"
- **Layers panel and Layer menu**: no Use Default Masks on Fill Layers; no Smart Object or Artboard
  filters in Find Layers; the eye column has no Show/Hide menu items; while layers are isolated, a
  clipped layer whose base is hidden is drawn unclipped. The Move tool and Free Transform still move a
  new document's Background (Photoshop converts it to a layer first); Duplicate Layer into another
  document neither centres the layer nor converts its colours; a two-digit opacity typed quickly is
  recorded by actions as two steps. The digit keys set layer opacity, not a painting tool's opacity
- **Search and fields**: Search does not list open documents or help topics; a spring-loaded tool key
  switches to the real tool while it is held; plain number fields in older dialogs take arithmetic,
  stepping and scrubbing but have no unit list or popup slider
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
- Linked layers move together with the Move tool and with Align and Distribute; colour labels and links are saved in
  `.pigment`, not in PSD
- Masks on individual smart filters (the smart object's layer mask applies to all of them); Last
  Filter does not repeat the Camera Raw filter; Warp, Perspective Warp and Puppet Warp rasterize a
  smart object first
- Image generation through a ChatGPT plan: OpenAI only serves image models to API keys, so
  Generative Fill, Generate Image and the background tools need an OpenAI or Gemini key. Plan
  sign-in covers Describe Image and the assistant
- Sign in with ChatGPT in the browser build (`npm run dev:web`): it needs the desktop app, so the
  browser build takes API keys only
