# Pigment user guide

Pigment is a free image editor that works like Photoshop: the same menus, tools, panels and
keyboard shortcuts. This guide walks through each area. On macOS read **Ctrl** as **Cmd** and
**Alt** as **Option**.

## Getting started

- **New image**: File › New (Ctrl+N) or one of the quick-start sizes on the welcome screen.
- **Open**: File › Open (Ctrl+O), drag files into the window, or use "Open with" from your file
  manager. Pigment opens PSD/PSB, PNG, JPEG, WebP, GIF, BMP, AVIF, SVG and ICO, and its own
  `.pigment` files.
- **New from clipboard**: copy an image anywhere, then Edit › Paste (Ctrl+V) with no document open.
- **Save**: File › Save (Ctrl+S). Layered work is saved as `.pigment` (everything is kept) or `.psd`
  (for other apps: layers, groups, masks, locks, fill opacity, adjustment layers and editable text).
  Saving a flat format (PNG, JPEG, WebP) asks before merging the layers; JPEG and WebP ask for their
  quality the first time. Formats Pigment can only read (GIF, BMP, SVG, AVIF, ICO) are never
  overwritten: Save opens Save As for them.
- **Export**: File › Export › Export As (Ctrl+Alt+Shift+S) for PNG, JPEG or WebP with quality,
  size and background; Quick Export as PNG; Layers to Files writes each top-level layer as an image.

Each open image has a tab. Ctrl+Tab / Ctrl+Shift+Tab switch between them.

## The workspace

- **Toolbox** (left): click a tool, or press its letter (V move, M marquee, L lasso, W wand,
  C crop, I eyedropper, J healing, B brush, S clone, Y history brush, E eraser, G gradient/bucket,
  O dodge/burn, P pen, T type, A path selection, U shapes, H hand, R rotate view, Z zoom).
  Tools that share a slot have a small triangle: right-click or long-press to pick one, or press
  Shift + the letter to cycle through them.
- **Options bar** (top): settings of the current tool.
- **Panels** (right): Color, Swatches, Brushes · Properties, Adjustments, Character, Paths ·
  Layers, Channels, History, Navigator, Info. Window menu shows any panel; Tab hides and shows all
  panels; Window › Reset Workspace restores the layout.
- **Status bar**: zoom (type a value), document size, and a hint for the current tool.

## Viewing

- Zoom: Ctrl+= / Ctrl+-, Ctrl+0 fits the image, Ctrl+1 is 100%; Ctrl+wheel or a trackpad pinch zooms at
  the pointer (Preferences can make the plain wheel zoom). The Zoom tool (Z) zooms in on click, out with Alt.
- Pan: hold Space and drag, use the Hand tool (H), or scroll (Shift+wheel scrolls sideways).
- Rotate the view: Rotate View tool (R); Escape or View › Reset View Rotation resets.
- Rulers (Ctrl+R), grid (Ctrl+'), guides (drag from a ruler, Ctrl+; shows/hides), pixel grid at
  high zoom, snapping (View › Snap).
- View › Theme switches between light, dark and the system setting.

## Layers

The Layers panel lists layers from top to bottom. Click to select, Ctrl-click to add to the
selection, Shift-click for a range. Double-click a name to rename it, the thumbnail to open its
options (text layers open for editing, adjustment layers show their settings in Properties).

- **New layer** Ctrl+Shift+N, **duplicate / layer via copy** Ctrl+J (copies the selection if there
  is one), **layer via cut** Ctrl+Shift+J, **delete** with the trash button.
- **Groups**: Ctrl+G groups the selected layers, Ctrl+Shift+G ungroups. Groups use Pass Through by default.
- **Order**: drag rows, or Ctrl+] / Ctrl+[ (forward/backward), Ctrl+Shift+] / Ctrl+Shift+[ (front/back).
- **Blend mode, opacity and fill**: at the top of the panel. Fill fades the layer's pixels but not
  its layer style.
- **Locks**: transparent pixels, image pixels, position, all.
- **Visibility**: click the eye; Alt-click shows only that layer.
- **Merge**: Ctrl+E merges down (or merges the selected layers), Ctrl+Shift+E merges visible,
  Layer › Flatten Image.
- **Align / distribute**: Layer › Align and Distribute, or the buttons in the Move tool's options.

### Masks and clipping

- Add a mask with the mask button (it reveals the selection if there is one). Layer › Layer Mask
  has Reveal All, Hide All, Reveal/Hide Selection, From Transparency, Apply, Delete, Disable and Link.
- Click the mask thumbnail to paint on the mask: black hides, white reveals, grey is partial.
  Alt-click the mask thumbnail to view the mask itself.
- **Clipping mask** (Ctrl+Alt+G): the layer shows only where the layer below has pixels.

### Fill and adjustment layers

The half-filled circle at the bottom of the Layers panel (or the Adjustments panel) adds a Solid
Color, Gradient or Pattern fill layer, or any adjustment as a layer. Adjustment layers change
everything below them without touching the pixels; edit them any time in the Properties panel and
paint on their mask to limit them.

### Layer styles

Layer › Layer Style (or the fx button) opens the Layer Style dialog: Blending Options, Drop Shadow,
Inner Shadow, Outer Glow, Inner Glow, Bevel & Emboss, Satin, Color Overlay, Gradient Overlay,
Pattern Overlay and Stroke. Tick an effect to enable it and click its name to change its settings.
Effects stay editable; copy and paste them between layers, or Rasterize › Layer Style to bake them in.
Global Light sets the shared angle for shadows and bevels.

## Selections

- **Marquee** (M): rectangle, ellipse, single row, single column. Shift draws a square/circle,
  Alt draws from the centre. With a selection, Shift adds, Alt subtracts, Shift+Alt intersects
  (or use the mode buttons in the options bar). Feather and anti-alias are in the options.
- **Lasso** (L): freehand, polygonal (click points, double-click or Enter to close) and magnetic
  (follows edges as you move).
- **Magic Wand** (W) selects similar colours (tolerance, contiguous, sample all layers);
  **Quick Selection** paints a selection that grows to edges.
- **Select menu**: All (Ctrl+A), Deselect (Ctrl+D), Reselect (Ctrl+Shift+D), Inverse (Ctrl+Shift+I),
  Color Range, Modify (Border, Smooth, Expand, Contract, Feather Shift+F6), Grow, Similar,
  Transform Selection, Load/Save Selection (as channels in the Channels panel), and
  Layer Transparency as Selection (or Ctrl-click a layer thumbnail).
- **Quick Mask** (Q): the unselected area turns red. Paint with black to remove from the
  selection, white to add, grey for partial selection; press Q again to get the selection back.
- Selected pixels can be moved with the Move tool (Alt-drag copies them), filled (Edit › Fill,
  Shift+F5; Alt+Backspace fills with the foreground colour, Ctrl+Backspace with the background),
  stroked (Edit › Stroke), cleared (Delete) or copied.

## Painting

- **Brush** (B), **Pencil** (hard edged) and **Color Replacement** (keeps texture, swaps colour).
  `[` and `]` change the size, Shift+`[` / Shift+`]` the hardness. Size, hardness, opacity, flow,
  smoothing and pen pressure are in the options bar; the Brushes panel has presets and the dab shape.
  Alt-click with a painting tool picks a colour.
- **Colours**: click the foreground/background swatches in the toolbox for the colour picker,
  X swaps them, D resets to black and white. The Color and Swatches panels and the Eyedropper (I)
  set colours too.
- **Eraser** (E) erases to transparency (to the background colour on a layer with locked
  transparency); **Background Eraser** removes colours similar to the one under the brush centre;
  **Magic Eraser** removes similar colours with one click.
- **Gradient** (G): drag across the image; choose linear, radial, angle, reflected or diamond and a
  preset in the options bar. **Paint Bucket** fills similar colours.
- **History Brush** (Y) paints back the image as it was when opened or last saved.

## Retouching

- **Spot Healing Brush** (J): paint over a blemish or a small object; when you release the mouse it is
  replaced with texture synthesised from around it (Content-Aware). Proximity Match blends nearby texture instead.
- **Content-Aware Fill** (Edit menu, or Contents › Content-Aware in Edit › Fill): select an object
  and it is replaced with texture from the rest of the image.
- **Healing Brush**: Alt-click a clean area to set the source, then paint; the texture is copied
  and blended into the colours of the destination.
- **Patch**: draw around the area to fix (or use any selection), then drag it onto clean texture.
- **Red Eye**: click a red pupil, or drag a box around the eye.
- **Clone Stamp** (S): Alt-click the source, then paint an exact copy. "Aligned" keeps the offset
  between strokes; "Sample all layers" copies what you see. **Pattern Stamp** paints the current
  pattern (Edit › Define Pattern makes one from the selection).
- **Blur, Sharpen, Smudge** soften, crisp up or push pixels; **Dodge, Burn, Sponge** (O) lighten,
  darken, or change saturation, limited to shadows, midtones or highlights.

## Adjustments

Image › Adjustments applies to the selected layer (inside the selection if there is one):
Brightness/Contrast, Levels (Ctrl+L), Curves (Ctrl+M), Exposure, Vibrance, Hue/Saturation (Ctrl+U),
Color Balance (Ctrl+B), Black & White (Ctrl+Alt+Shift+B), Photo Filter, Channel Mixer, Invert
(Ctrl+I), Posterize, Threshold, Gradient Map, Selective Color, Shadows/Highlights, Desaturate
(Ctrl+Shift+U) and Equalize. Auto Tone (Ctrl+Shift+L), Auto Contrast and Auto Color fix an image
in one step.

The image updates live while the dialog is open; untick Preview to compare. In Curves, click to
add points, drag them, drag a point off the graph (or press Delete) to remove it. After any
adjustment or filter, Edit › Fade blends the result back with the original at an opacity and mode.

To keep adjustments editable, use adjustment layers instead (see Layers).

## Filters

The Filter menu has Blur, Sharpen, Noise, Pixelate, Distort, Stylize, Render and Other groups,
each with a dialog and live preview. Filter › Last Filter (Ctrl+F) repeats the last filter with
the same settings. A selection limits the filter to the selected area (with soft edges for
feathered selections).

### Liquify

Filter › Liquify (Shift+Ctrl+X) opens the image in a large window with five brushes: Forward Warp
(W) pushes pixels as you drag, Reconstruct (R) brings them back, Twirl (C), Pucker (S) and Bloat (B)
work while you hold the mouse button. `[` and `]` change the brush size; Alt-drag with Forward Warp
reconstructs; Ctrl+Z undoes the last stroke, Restore All starts over. OK applies the result as one
undo step (limited to the selection if there is one).

## Transforming

- **Free Transform** (Ctrl+T) on the selected layers, or on the selected pixels when there is a
  selection. Drag a handle to scale (Shift keeps the proportions, Alt scales from the centre),
  drag outside the box to rotate (Shift snaps to 15°), drag inside to move, drag the centre point
  to change the pivot. Ctrl-drag a corner to distort, Ctrl+Shift-drag an edge to skew, or pick
  Edit › Transform › Skew / Distort / Perspective. The options bar takes exact values. Enter
  applies, Escape cancels.
- Edit › Transform also has Rotate 90°/180° and Flip, and Transform Again (Ctrl+Shift+T).
- **Image size** (Ctrl+Alt+I) resamples the image (choose the method; untick Resample to change only
  the print resolution). **Canvas size** (Ctrl+Alt+C) adds or removes canvas around an anchor.
  Image › Image Rotation turns or flips the whole image. **Crop** (C): drag a box, adjust the
  handles, press Enter; pick a ratio in the options bar. Image › Crop crops to the selection,
  Trim removes transparent or plain borders, Reveal All grows the canvas to show every layer.

## Type

The Type tool (T): click to type a line, or drag a box for paragraph text. Choose the font, size,
style, colour and alignment in the options bar or the Character panel (leading, tracking,
underline and stroke too). Click the ✓ or press Ctrl+Enter to finish, Escape to cancel. Text stays
editable: click it with the Type tool or double-click its thumbnail. Free Transform scales and
rotates text without rasterizing it; Layer › Rasterize › Layer turns it into pixels.

## Shapes and paths

- **Shape tools** (U): rectangle, rounded rectangle, ellipse, polygon/star, line and custom shapes.
  Shift keeps proportions, Alt draws from the centre. In the options bar choose Shape (an editable
  shape layer with fill and stroke), Path (a work path) or Pixels (painted on the current layer).
- **Pen** (P): click for corner points, drag for smooth curves, click the first point to close.
  Freeform Pen draws like a pencil; Add / Delete / Convert Anchor Point edit existing paths.
- **Path Selection / Direct Selection** (A) move whole paths or single points and handles.
- The **Paths** panel keeps the work path and saved paths: fill or stroke a path, load it as a
  selection, or make a path from a selection.

## Undo and history

Ctrl+Z undoes (repeat to go further back), Ctrl+Shift+Z redoes; Alt+Ctrl+Z and Shift+Ctrl+Z step
backward and forward. The History panel lists every step: click one to go back to it, and take
snapshots of states you want to keep. Edit › Preferences sets how many steps and how much memory
the history may use.

## Keyboard shortcuts

Help › Keyboard Shortcuts shows every shortcut. The most used ones:

| Action | Shortcut |
|---|---|
| New / Open / Save / Save As | Ctrl+N / Ctrl+O / Ctrl+S / Ctrl+Shift+S |
| Undo / Redo | Ctrl+Z / Ctrl+Shift+Z |
| Copy / Copy Merged / Paste | Ctrl+C / Ctrl+Shift+C / Ctrl+V |
| Free Transform | Ctrl+T |
| Select all / Deselect / Inverse | Ctrl+A / Ctrl+D / Ctrl+Shift+I |
| New layer / Layer via copy / Merge down | Ctrl+Shift+N / Ctrl+J / Ctrl+E |
| Group / Ungroup | Ctrl+G / Ctrl+Shift+G |
| Levels / Curves / Hue-Saturation / Invert | Ctrl+L / Ctrl+M / Ctrl+U / Ctrl+I |
| Last filter / Liquify | Ctrl+F / Shift+Ctrl+X |
| Zoom in / out / fit / 100% | Ctrl+= / Ctrl+- / Ctrl+0 / Ctrl+1 |
| Brush size / hardness | [ ] / Shift+[ Shift+] |
| Swap / default colours | X / D |
| Temporary hand tool | hold Space |
| Quick mask | Q |
| Show / hide panels | Tab |

## Troubleshooting

- **The app does not open on macOS** ("cannot be opened because it is from an unidentified
  developer"): right-click Pigment.app and choose Open, then Open. The builds are not code-signed.
- **Windows SmartScreen warning**: choose More info, then Run anyway.
- **Very large images are slow**: Pigment keeps every layer in memory at 8 bits per channel; a
  10,000 × 10,000 layer takes 400 MB. Lower the history memory in Preferences, flatten finished
  parts, or work at a smaller size.
- **Fonts are missing in the Type tool**: Pigment lists installed fonts when the system allows it;
  otherwise it offers common font families.
