# Pigment user guide

Pigment is a free image editor that works like Photoshop: the same menus, tools, panels and
keyboard shortcuts. This guide walks through each area. On macOS read **Ctrl** as **Cmd** and
**Alt** as **Option**.

## Getting started

- **New image**: File › New (Ctrl+N) or one of the quick-start sizes on the welcome screen.
- **Open**: File › Open (Ctrl+O), drag files into the window, or use "Open with" from your file
  manager. Pigment opens PSD/PSB, PNG, JPEG, WebP, GIF, TIFF, Targa, BMP, AVIF, SVG and ICO, and
  its own `.pigment` files. File › Open as Smart Object opens each file as a new document holding
  one smart object.
- **New from clipboard**: copy an image anywhere, then Edit › Paste (Ctrl+V) with no document open.
- **Save**: File › Save (Ctrl+S). Layered work is saved as `.pigment` (everything is kept) or `.psd`
  (for other apps: layers, groups, masks, locks, fill opacity, adjustment layers and editable text).
  Saving a flat format (PNG, JPEG, WebP, GIF, TIFF, Targa) asks before merging the layers; JPEG and
  WebP ask for their quality the first time. Formats Pigment can only read (BMP, SVG, AVIF, ICO) are
  never overwritten: Save opens Save As for them.
- **Export**: File › Export › Export As (Ctrl+Alt+Shift+S) with quality, size and background;
  Quick Export as PNG (Ctrl+Alt+Shift+E); Save for Web (Legacy); Layers to Files writes each
  top-level layer as an image. See [File formats and Save for Web](#file-formats-and-save-for-web).
- **Close**: File › Close (Ctrl+W), Close All (Ctrl+Alt+W), Close Others (Ctrl+Alt+P).
- **Print**: File › Print (Ctrl+P) opens a dialog with the printer, copies, paper size (A4, Letter,
  Legal, A3, A5, Tabloid or custom millimetres), orientation, margins, scale (fit to page, 100 % or a
  percentage) and position, with a preview of the page. Save as PDF writes the same page to a file.

Each open image has a tab. Ctrl+Tab / Ctrl+Shift+Tab switch between them.

## The workspace

- **Toolbox** (left): click a tool, or press its letter (V move, M marquee, L lasso, W wand,
  C crop, I eyedropper, J healing, B brush, S clone, Y history brush, E eraser, G gradient/bucket,
  O dodge/burn, P pen, T type, A path selection, U shapes, H hand, R rotate view, Z zoom).
  Tools that share a slot have a small triangle: right-click or long-press to pick one, or press
  Shift + the letter to cycle through them. The wand slot (W) holds Quick Selection, Magic Wand
  and Object Selection; the crop slot (C) holds Crop and Perspective Crop.
- **Options bar** (top): settings of the current tool.
- **Panels** (right): Color, Swatches, Brushes · Properties, Adjustments, Character, Paths ·
  Layers, Channels, History, Actions, Navigator, Info, AI Assistant. Window menu shows any panel; Tab hides
  and shows all panels; Window › Reset Workspace restores the layout.
- **Status bar**: zoom (type a value), document size, and a hint for the current tool.

## Viewing

- Zoom: Ctrl+= / Ctrl+-, Ctrl+0 fits the image, Ctrl+1 is 100%; Ctrl+wheel or a trackpad pinch zooms at
  the pointer (Preferences can make the plain wheel zoom). The Zoom tool (Z) zooms in on click, out with Alt.
- Pan: hold Space and drag, use the Hand tool (H), or scroll (Shift+wheel scrolls sideways).
- Rotate the view: Rotate View tool (R); Escape or View › Reset View Rotation resets.
- Rulers (Ctrl+R), grid (Ctrl+'), guides (drag from a ruler, Ctrl+; shows/hides), pixel grid at
  high zoom, snapping (View › Snap).
- View › Theme switches between light, dark and the system setting.
- **Proof Colors (CMYK)** in the View menu shows how the image would look printed with process
  inks; **Gamut Warning** (Ctrl+Shift+Y) greys out colours that CMYK cannot reproduce. Both are
  previews: the document stays RGB. The Info panel shows a second readout under the pointer in
  CMYK, Lab or HSB (pick it in the panel), and the Color Picker has Lab and CMYK fields that
  convert in both directions.

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

### Smart objects

A smart object keeps its source (a layered document or an image) and renders it through its
transform, so scaling it down and up again loses nothing, and every filter applied to it stays
editable.

- **Make one**: Layer › Smart Objects › Convert to Smart Object wraps the selected layers;
  File › Place Image as Layer places files as smart objects (Preferences › Place files as smart
  objects turns that off). New Smart Object via Copy duplicates one with its own source.
- **Edit the contents**: Layer › Smart Objects › Edit Contents (or double-click the thumbnail) opens
  the source in its own tab, named "<layer> (smart object)". Save (Ctrl+S) in that tab writes the
  change back into the layer; closing the tab asks whether to apply unsaved changes.
- **Replace Contents** swaps the source for another file and keeps the transform; **Export Contents**
  writes the source as `.pigment` or PNG; **Reset Transform** returns it to its original size;
  **Rasterize** turns it into ordinary pixels.
- **Smart filters**: any filter, adjustment or Camera Raw applied to a smart object is listed under
  the layer in the Layers panel. Click the eye to toggle one, double-click to change its settings,
  right-click for more; Layer › Smart Objects › Clear Smart Filters removes them all. The layer mask
  applies to the filtered result.
- Free Transform, scale, rotate, skew and flip work on smart objects without rasterizing them; Warp,
  Perspective Warp and Puppet Warp offer to rasterize the smart object first. Layer › Duplicate Layer makes a second
  instance that shares the contents (editing one updates both); New Smart Object via Copy makes an
  independent copy.

### Stack modes

A stack mode combines the layers inside a smart object into one image: Layer › Smart Objects ›
Stack Mode › Mean, Median, Maximum, Minimum, Range, Summation, Standard Deviation, Variance,
Entropy, Skewness or Kurtosis (None turns it off). Median removes things that move between
shots; Mean averages out noise. The smart object's source needs two or more visible layers;
File › Scripts › Load Files into Stack builds one from files (see
[Combining images](#combining-images)). Layer › Smart Objects › Convert to Layers unpacks a smart
object back into its layers; its smart filters and stack mode are discarded after you confirm.

### Background, links, labels and finding layers

- **Background**: Layer › New › Background from Layer flattens the active layer onto the background
  colour and moves it to the bottom of the stack; it cannot be moved and has no transparency, but
  you can still paint on it (the eraser paints the background colour). Layer from Background turns
  it back into an ordinary layer and asks for a name (default "Layer 0"). A document has at most
  one Background.
- **Group from Layers** (Layer › New) groups the selected layers and asks for the name, colour
  label, mode and opacity. **Delete › Hidden Layers** removes every hidden layer after a
  confirmation. **Rasterize › All Layers** turns every text, shape, fill and smart layer into pixels.
- **Link Layers**: select two or more layers and choose Layer › Link Layers (or the chain button in
  the Layers panel). Linked layers move together with the Move tool, including Alt-drag copies and
  arrow-key nudges. Running the command on a linked layer unlinks it. Select Linked Layers selects
  the whole set. Free Transform and Align do not follow links.
- **Colour labels**: right-click a layer's eye and pick a colour; the row is tinted.
- **Find Layers** (Select › Find Layers, Ctrl+Alt+Shift+F) opens a filter bar at the top of the
  Layers panel: filter by Kind (toggle buttons), Name, Effect, Mode, Attribute or Color. The switch
  at the right turns filtering off without losing the setting. Groups stay listed when something
  inside them matches.
- **Isolate Layers** (Select menu) shows only the selected layers, in the panel and on the canvas,
  until you choose it again. It changes nothing in the document: saves and exports still include
  every layer.
- **Select › Deselect Layers** clears the layer selection; **All Layers** is Ctrl+Alt+A.
- **Export one layer**: Layer › Quick Export as PNG writes each selected layer next to the saved
  document (it asks for a folder if the document is unsaved, and never overwrites: it adds " (2)").
  Layer › Export As offers the format, quality, scale, trim and background. A selected group
  exports as one file; empty layers are skipped.
- Labels and links are saved in `.pigment` files only.

### Matting

Layer › Matting cleans the edge of a cut-out layer:

- **Defringe…** replaces the colour of the edge pixels with colour from further inside, over the
  width you enter.
- **Color Decontaminate…** removes background colour that shows through semi-transparent edge
  pixels, by the amount you enter.
- **Remove Black Matte / Remove White Matte** run at once and take the dark or light halo out of a
  layer that was cut from a black or white background.

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
- **Object Selection** (in the wand slot, Shift+W): drag a rectangle, or draw a lasso in Lasso
  mode, around one object; the selection shrinks to the object inside it. Shift adds, Alt
  subtracts, Shift+Alt intersects, a click deselects. With Object Subtract on, Alt removes the
  object found in the region; with it off, the region itself. Options: Sample All Layers, Hard Edge.
- **Quick Mask** (Q): the unselected area turns red. Paint with black to remove from the
  selection, white to add, grey for partial selection; press Q again to get the selection back.
- Selected pixels can be moved with the Move tool (Alt-drag copies them), filled (Edit › Fill,
  Shift+F5; Alt+Backspace fills with the foreground colour, Ctrl+Backspace with the background),
  stroked (Edit › Stroke), cleared (Delete) or copied.

### Select Subject, Sky and Focus Area

- **Select › Subject** selects the most prominent object of the active layer; **Select › Sky**
  selects the sky. Both run in one step and can be undone. They work from colour and saliency on
  your computer, not from a learned model, so a busy scene can give the wrong region and a picture
  with no clear subject or sky reports that nothing was found. Fix the result with the selection
  tools or in Select and Mask.
- **Select › Focus Area…** selects what is sharp. In-Focus Range moves the split between sharp and
  blurred (Auto picks it; higher values keep only the sharpest areas), Image Noise Level stops
  noise from counting as detail, Soften Edge feathers the result. Output To sends it to a
  selection, layer mask, new layer or new document; the Select and Mask… button continues there.

### Select and Mask

Select › Select and Mask… (Ctrl+Alt+R) opens a workspace for refining a selection or a layer mask.
With no selection on a layer that has a mask, it refines that mask. Nothing in the document changes
until you click OK; Cancel or Escape leaves no trace.

- **Tools** (left): Quick Selection and Object Selection (W), Refine Edge Brush (R) for hair and
  soft edges, Brush (B), Lasso and Polygonal Lasso (L), Hand (H), Zoom (Z). `[` and `]` change the
  brush size; Alt subtracts. Ctrl+Z and Ctrl+Shift+Z step through your strokes.
- **View Mode**: Onion Skin (O), Marching Ants (M), Overlay (V), On Black (A), On White (T), Black
  & White (K), On Layers (Y); F cycles, X toggles the preview, P shows the original, J shows the
  edge area.
- **Edge Detection**: Radius widens the band in which Pigment looks for the true edge; Smart Radius
  adapts it. Refine Mode chooses Color Aware or Object Aware.
- **Global Refinements**: Smooth, Feather, Contrast, Shift Edge; Clear Selection and Invert.
- **Output**: Decontaminate Colors (with Amount) removes background colour from the edge and
  outputs to a new layer. Output To: Selection, Layer Mask, New Layer, New Layer with Layer Mask,
  New Document, New Document with Layer Mask. New Layer outputs hide the original layer.

The other commands are unavailable while the workspace is open (zoom and pan still work).

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
Color Balance (Ctrl+B), Black & White (Ctrl+Alt+Shift+B), Photo Filter, Channel Mixer, Color
Lookup, Invert (Ctrl+I), Posterize, Threshold, Gradient Map, Selective Color, Shadows/Highlights,
HDR Toning, Desaturate (Ctrl+Shift+U), Match Color, Replace Color and Equalize. Auto Tone (Ctrl+Shift+L), Auto Contrast and Auto Color fix an image
in one step.

The image updates live while the dialog is open; untick Preview to compare. In Curves, click to
add points, drag them, drag a point off the graph (or press Delete) to remove it. After any
adjustment or filter, Edit › Fade blends the result back with the original at an opacity and mode.

To keep adjustments editable, use adjustment layers instead (see Layers). Shadows/Highlights, HDR
Toning, Match Color, Replace Color, Desaturate and Equalize are not available as layers.

### Color Lookup, HDR Toning, Match Color, Replace Color

- **Color Lookup** grades the image through a lookup table. Pick one of the 31 presets, or Load 3D
  LUT… for a `.cube` (1D or 3D), `.3dl`, `.look` or `.csp` file. Dither hides banding. The presets
  have Photoshop's names but are generated by Pigment: they approximate those looks and are not
  Adobe's tables. Also available as an adjustment layer. File › Export › Color Lookup Tables…
  writes the document's adjustment layers as a `.cube` and/or `.3dl` table with 16, 32 or 64 grid
  points (layer opacity counts; masks and blend modes do not).
- **HDR Toning** compresses or exaggerates the tonal range. Methods: Local Adaptation (Radius,
  Strength, Gamma, Exposure, Detail, Shadow, Highlight, Vibrance, Saturation and a toning curve),
  Exposure and Gamma, Highlight Compression, Equalize Histogram. It works on a flattened image and
  asks before flattening.
- **Match Color** makes the layer's colours follow another image. Choose the Source document and
  layer (or Merged); tick the selection options to measure only the selected areas; adjust
  Luminance, Color Intensity and Fade; Neutralize removes a cast. Save / Load Statistics keeps a
  source's colour statistics as a file.
- **Replace Color**: click the preview to sample the colour to change (it starts from the
  foreground colour). Shift-click or the Add eyedropper adds colours, Alt-click or Subtract removes
  them. Fuzziness widens the range; Localized Color Clusters with Range limits it to the area near
  the samples. Then set Hue, Saturation and Lightness for the replacement. Selection / Image
  switches the preview between the mask and the picture.

### Apply Image and Calculations

Both blend channels between images. The other image must be open and have the same pixel size.

- **Image › Apply Image…** blends a source (a document, one of its layers or Merged, and a channel:
  RGB, Red, Green, Blue, transparency, grey, the layer mask, the selection or a saved alpha
  channel) into the active layer with a blend mode and opacity. Invert, Preserve Transparency and a
  Mask (another channel that limits the effect) are optional; Add and Subtract take Scale and Offset.
- **Image › Calculations…** blends two single channels (Source 1 and Source 2) and puts the result
  in a new alpha channel, a selection or a new greyscale document.

## Filters

Each filter has a dialog with a live preview on the canvas. A few apply at once: Average, Blur,
Blur More, Sharpen Edges, Sharpen More, Despeckle, Facet, Fragment, Find Edges, Solarize and NTSC
Colors. A selection limits the filter to the
selected area, with soft edges for feathered selections. Filter › Last Filter (Ctrl+F) repeats the
last filter with the same settings. On a smart object every filter becomes an editable smart filter.

| Filter menu | Filters |
|---|---|
| (top) | Filter Gallery, Lens Correction, Liquify, Camera Raw Filter |
| Blur | Average, Blur, Blur More, Box Blur, Gaussian Blur, Lens Blur, Motion Blur, Radial Blur, Shape Blur, Smart Blur, Surface Blur |
| Blur Gallery | Field Blur, Iris Blur, Path Blur, Spin Blur, Tilt-Shift |
| Distort | Displace, Pinch, Polar Coordinates, Ripple, Shear, Spherize, Twirl, Wave, ZigZag |
| Noise | Add Noise, Despeckle, Dust & Scratches, Median, Reduce Noise |
| Pixelate | Color Halftone, Crystallize, Facet, Fragment, Mezzotint, Mosaic, Pointillize |
| Render | Clouds, Difference Clouds, Fibers, Flame, Lens Flare, Lighting Effects, Picture Frame, Tree, Vignette |
| Sharpen | Shake Reduction, Sharpen, Sharpen Edges, Sharpen More, Smart Sharpen, Unsharp Mask |
| Stylize | Diffuse, Emboss, Extrude, Find Edges, Glowing Edges, Oil Paint, Solarize, Tiles, Trace Contour, Wind |
| Video | De-Interlace, NTSC Colors |
| Other | Custom, High Pass, HSB/HSL, Invert Alpha, Maximum, Minimum, Offset |

The Filter Gallery adds these groups (also listed in the Filter menu when "Show all groups in
Filter menu" is ticked in the gallery):

| Gallery group | Effects |
|---|---|
| Artistic | Colored Pencil, Cutout, Dry Brush, Film Grain, Fresco, Neon Glow, Paint Daubs, Palette Knife, Plastic Wrap, Poster Edges, Rough Pastels, Smudge Stick, Sponge, Underpainting, Watercolor |
| Brush Strokes | Accented Edges, Angled Strokes, Crosshatch, Dark Strokes, Ink Outlines, Spatter, Sprayed Strokes, Sumi-e |
| Distort | Diffuse Glow, Glass, Ocean Ripple |
| Sketch | Bas Relief, Chalk & Charcoal, Charcoal, Chrome, Conté Crayon, Graphic Pen, Halftone Pattern, Note Paper, Photocopy, Plaster, Reticulation, Stamp, Torn Edges, Water Paper |
| Stylize | Glowing Edges |
| Texture | Craquelure, Grain, Mosaic Tiles, Patchwork, Stained Glass, Texturizer |

Filters that need explaining:

- **Lens Blur** blurs like a lens, with an iris shape (triangle to octagon, Blade Curvature,
  Rotation), Specular Highlights that bloom into bokeh, and Noise. Depth Map Source makes the blur
  vary across the image: Transparency, the Layer Mask, or any saved alpha channel. Blur Focal
  Distance (0–255) is the map value that stays sharp; Invert swaps near and far. On a smart object
  Lens Blur becomes a smart filter, which cannot keep a depth map: the blur is uniform there
  (rasterize the layer to use a map).
- **Displace** shifts pixels by a second image, the map. The dialog lists the other open documents,
  the layers of this document, or File… for any image Pigment opens. The map's red channel moves
  pixels horizontally and green vertically (a grey map moves both): 128 is no shift, white and
  black move by the full Scale in opposite directions. The map is stretched or tiled to fit. The
  map is not stored with the settings: Last Filter or an action opens the chooser again.
- **Flame** draws fire along a path, so draw a path first (Pen tool, or select a saved path in the
  Paths panel); without one the filter says "Draw a path first". Six flame types (one flame along
  the path, several flames along it or in one direction, candle light and others), with length,
  width, turbulence, jaggedness, quality and a custom colour. Use it on a pixel layer: on a shape
  layer it asks to rasterize, and the shape's path goes with it.
- **Tree** draws one of 11 trees (oak, maple, birch, elm, cherry blossom, apple, bare, pine,
  spruce, willow, palm) on the layer, over what is there. Use an empty layer. Light direction,
  leaves amount and size, branch height and thickness, camera tilt, leaf and branch colour;
  Arrangement gives a different tree for each number. The default leaf colour means the species'
  natural colour.
- **Picture Frame** draws one of 10 frames (vines, leaves, flowers, geometric, bamboo, rope, wood,
  film, stars, circles) around the edge of the layer, in two colours. Size 100 covers 12 % of the
  shorter side on each edge.
- **Lighting Effects** lights the layer with a spot, point or infinite light: position, colour and
  intensity, and for a spot its angle, radius, focus and hotspot; Gloss, Metallic, Exposure and
  Ambience describe the surface. A Texture channel with Height embosses the surface. The dialog edits one
  light; there is no on-canvas light editor.
- **Shake Reduction** sharpens a photo blurred by camera movement. It estimates the blur trace from
  the image (Blur Trace Bounds 10–199 px limits its length), then removes it; Source Noise,
  Smoothing and Artifact Suppression trade sharpness against ringing. It finds one straight trace:
  curved or mixed shake is not removed, and an image with no directional blur is left unchanged.
- **Fibers** and **Tiles** use the colours in their dialogs (black and white by default), not the
  toolbox colours. **Wind**'s direction is where the streaks blow to. **Trace Contour** follows
  Photoshop's colours: a contour in the red channel shows as cyan on white.
- **Average** fills with the mean colour. With a selection that is not a rectangle, the mean is
  taken over the selection's bounding box.

### Filter Gallery

Filter › Filter Gallery… shows a large preview, the effect thumbnails in groups, and the settings
of the selected effect.

- Click a thumbnail to choose the effect for the selected effect layer; change its settings on the
  right.
- The list at the bottom right is the effect stack. **+** adds an effect layer (a copy of the
  selected one), the trash deletes it, the eye hides it. Drag rows or use the arrows to reorder:
  the bottom row is applied first.
- Zoom with the percentage menu, + / −, Fit or the mouse wheel; drag to pan.
- OK applies the whole stack as one undo step that Last Filter and actions can repeat.
- Sketch effects draw with the toolbox foreground and background colours as they are when the
  dialog opens (Chrome is always grey; Water Paper keeps the image's colours).
- **Texturizer**, **Conté Crayon** and **Glass** have built-in textures and a Load Texture… button
  for any image file, which is tiled and scaled by Scaling. A loaded texture is not stored with an
  action or a saved smart filter; replaying falls back to a built-in texture.
- While you edit, the preview runs on a copy reduced to 720 px on its longest side, with the
  settings unscaled, so stroke lengths and radii look larger in the preview of a big image than in
  the result.

### Blur Gallery

Filter › Blur Gallery › Field Blur, Iris Blur, Tilt-Shift, Path Blur or Spin Blur puts the controls
on the image, with a panel in place of the panel dock.

- **Pins**: click the image to add a pin (it copies the selected pin's settings), drag to move it,
  Delete removes it, arrow keys nudge it (Shift for 10 px). Drag the ring around the selected pin
  to set the amount: a full turn is 100 px of blur, or 360° for Spin Blur.
- **Field Blur**: each pin sets a blur amount; between pins the amount blends. A pin at 0 keeps its
  area sharp.
- **Iris Blur**: sharp inside the ellipse, blurred outside. The outer dots set size and rotation,
  the inner dots the fully sharp area, the square on the outline its roundness.
- **Tilt-Shift**: sharp between the solid lines, blurring out to the dashed lines. Drag the lines;
  drag the dots on the solid lines to rotate (Shift snaps to 15°).
- **Path Blur**: motion blur along a path. Drag its points, click the path to add one, drag on the
  image to start another path. The red arrows at the ends set the speed there. Paths have no
  curve handles.
- **Spin Blur**: rotational blur inside the ellipse; the ring sets the angle.
- **Panel**: Blur tab (the selected pin), Effects tab (Bokeh for Field, Iris and Tilt-Shift; Motion
  Effects with strobe for Path and Spin), Noise tab (grain in the blurred areas), Preview, Reset.
- Enter or OK applies as one undo step; Escape or Cancel restores the image. P toggles the
  preview, H hides the on-canvas controls. Zoom and pan work; other commands wait until you finish.
- Large layers preview at reduced quality while you drag and sharpen when you let go. Path and Spin
  Blur are the slow ones: several seconds on a 12-megapixel layer.

### Lens Correction

Filter › Lens Correction… (Ctrl+Shift+R) fixes lens faults and tilted or converging pictures.

- **Custom tab**: Remove Distortion (positive corrects barrel distortion, negative pincushion; the
  corners stay put), Chromatic Aberration (red/cyan, green/magenta, blue/yellow fringe), Vignette
  Amount and Midpoint, Vertical and Horizontal Perspective, Angle, Scale (50–150 %).
- **Tools**: Straighten (draw along something that should be level or upright), Remove Distortion
  (drag towards or away from the centre), Hand. Show Grid helps to judge straight lines.
- **Auto Correction tab**: Pigment has no lens profile database, so there is no search by camera
  and lens. The three checkboxes switch the Custom tab's distortion, chromatic aberration and
  vignette values on and off; "Straighten horizon" finds the dominant near-horizontal edge and sets
  the angle; Auto Scale Image enlarges just enough to hide the empty edges; Edge chooses what fills
  them otherwise (Transparency, Edge Extension, Wrap Around, Background Color).
- The dialog opens neutral each time; Previous brings back the last correction.

### Camera Raw Filter

**Camera Raw Filter** (Filter › Camera Raw Filter…, Ctrl+Shift+A) develops the layer like a RAW
converter: Basic (white balance temperature and tint, exposure, contrast, highlights, shadows,
whites, blacks, texture, clarity, dehaze, vibrance, saturation), Detail (sharpening amount, radius
and detail; luminance and colour noise reduction), HSL (hue, saturation and luminance for reds,
oranges, yellows, greens, aquas, blues, purples and magentas) and Effects (vignette, grain). Auto
sets the tone from the histogram; Reset clears everything. On a smart object it becomes a smart
filter you can reopen later. It works on RGB images: Pigment does not open camera RAW files.

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
- **Warp** (Edit › Transform › Warp, or the Warp button while transforming): a 4 × 4 control net
  with corner handles and inner points to drag. Pick a preset (Arc, Arc Lower/Upper, Arch, Bulge,
  Shell Lower/Upper, Flag, Wave, Fish, Rise, Fisheye, Inflate, Squeeze, Twist) and set its Bend;
  dragging a point makes it Custom (Bend, H and V only apply to a preset). Clicking Warp after you
  scale or rotate applies that transform first, then warps the result. Enter applies, Escape cancels. Text, shape
  and smart object layers are rasterized first, after you confirm. A layer mask warps with the layer.
- **Perspective Warp** (Edit › Perspective Warp): in Layout mode drag out a quad over each plane of
  the photo (edges snap together; Delete removes the selected quad), switch to Warp and drag the
  corners; Shift-click an edge to make it vertical or horizontal. Enter applies.
- **Puppet Warp** (Edit › Puppet Warp): a mesh covers the layer's pixels (choose fewer or more
  points). Click to add pins, drag them to move that part of the image while the other pins hold
  it in place; Delete removes the selected pin. Rigid keeps shapes stiff, Normal is the default,
  Distort allows stretching. Enter applies.
- **Image size** (Ctrl+Alt+I) resamples the image (choose the method; untick Resample to change only
  the print resolution). **Canvas size** (Ctrl+Alt+C) adds or removes canvas around an anchor.
  Image › Image Rotation turns or flips the whole image. **Crop** (C): drag a box, adjust the
  handles, press Enter; pick a ratio in the options bar. Image › Crop crops to the selection,
  Trim removes transparent or plain borders, Reveal All grows the canvas to show every layer.

### Content-Aware Scale

Edit › Content-Aware Scale (Ctrl+Alt+Shift+C) resizes a pixel layer, or the selected pixels, by
removing or inserting seams through the areas with the least detail, so the important parts keep
their shape.

- Drag the handles (Shift keeps the proportions, Alt scales from the centre) or type W and H in
  pixels in the options bar. Enter applies, Escape cancels; Undo while the box is up also cancels.
- **Amount**: 100 uses seams only, 0 is an ordinary resize.
- **Protect**: choose a saved alpha channel (Select › Save Selection); its white areas are kept.
  **Protect skin tones** keeps skin-coloured areas.
- Widening inserts seams up to twice the size; beyond that it stretches.
- It works on pixel layers only (text, shape, smart and group layers are refused; rasterize them
  first), at 8 bits, on areas up to 40 megapixels.

### Perspective Crop

The Perspective Crop tool (in the crop slot, Shift+C) crops a rectangle that was photographed at
an angle and makes it flat. Drag a box and pull its corners onto the corners of the object, or
click the four corners one by one; the grid shows the perspective. Enter crops. In the options
bar, W, H and Resolution set the output size, Front Image copies the document's current size and
Clear empties the fields. A crop with real perspective rasterizes text and smart-object layers and
drops the selection and guides; a plain rectangle is an ordinary crop.

## Combining images

- **Auto-Align Layers** (Edit menu): select two or more pixel layers that show overlapping content.
  Pigment matches features between them and moves or warps the layers into register. Projection:
  Auto, Perspective, Collage, Cylindrical, Spherical or Reposition (move only; keeps the canvas
  size, the others grow the canvas). Lock one layer to make it the reference. Vignette Removal and
  Geometric Distortion are estimated from the images; there are no lens profiles. Layers with
  nothing in common are reported and left where they are.
- **Auto-Blend Layers** (Edit menu): Panorama hides the seams between aligned layers with layer
  masks; Stack Images keeps the sharpest part of each layer (focus stacking). Seamless Tones and
  Colors evens out brightness; Content Aware Fill Transparent Areas fills the empty corners on a
  new merged layer.
- **Photomerge** (File › Automate): pick files or open documents, a layout and the blend options;
  the result is a new document with one masked layer per image. Images it cannot place are added
  as hidden layers.
- **Load Files into Stack** (File › Scripts): opens the files as layers of one document, optionally
  aligned and wrapped in a smart object ready for a stack mode. **Statistics** does that and
  applies a stack mode in one step.
- **Merge to HDR** (File › Automate): pick two or more exposures of the same scene. Pigment aligns
  them, optionally removes ghosts (three or more exposures), blends the best-exposed parts of each
  (exposure fusion) into a new document and opens HDR Toning. This is not Photoshop's 32-bit
  radiance map: the result is an ordinary image, not scene-referred data.

## Type

The Type tool (T): click to type a line, or drag a box for paragraph text. Choose the font, size,
style, colour and alignment in the options bar or the Character panel (leading, tracking,
underline and stroke too). Click the ✓ or press Ctrl+Enter to finish, Escape to cancel. Text stays
editable: click it with the Type tool or double-click its thumbnail. Free Transform scales and
rotates text without rasterizing it; Layer › Rasterize › Layer turns it into pixels.

- **Text on a path**: with the Type tool, move the pointer over a path (the work path, a saved path
  or the outline of the active shape layer); the cursor changes, and clicking starts text that
  follows the path. Layer › Type › Text on Path attaches an existing text layer to the active path;
  Release from Path detaches it; Flip Text on Path puts it on the other side. Drag the small
  I-beam on the path to slide the text along it.
- **Orientation**: Layer › Type › Horizontal, Vertical (the line turned 90°) or Vertical, Stacked
  (each character upright, lines running right to left, for Chinese, Japanese and Korean). The
  Character panel has the same choice.

## Shapes and paths

- **Shape tools** (U): rectangle, rounded rectangle, ellipse, polygon/star, line and custom shapes.
  Shift keeps proportions, Alt draws from the centre. In the options bar choose Shape (an editable
  shape layer with fill and stroke), Path (a work path) or Pixels (painted on the current layer).
- **Pen** (P): click for corner points, drag for smooth curves, click the first point to close.
  Freeform Pen draws like a pencil; Add / Delete / Convert Anchor Point edit existing paths.
- **Path Selection / Direct Selection** (A) move whole paths or single points and handles.
- The **Paths** panel keeps the work path and saved paths: fill or stroke a path, load it as a
  selection, or make a path from a selection.
- **Path operations**: with a shape layer active, the shape tools' options bar offers New Layer,
  Combine Shapes, Subtract Front Shape, Intersect Shape Areas and Exclude Overlapping Shapes, so a
  second shape can cut a hole in the first or keep only the overlap. Layer › Shape Operations
  changes how the selected subpaths (Path Selection tool) or the whole layer combine; Merge Shape
  Components turns the result into a single outline.

## Image modes

Image › Mode converts the document. Each conversion is one undo step. Bitmap, Indexed Color and
Multichannel need a flattened image and ask first; Grayscale and Duotone ask whether to flatten.

- **Grayscale**: one grey channel.
- **Bitmap…**: black and white only. Methods: 50 % Threshold, Pattern Dither, Diffusion Dither,
  Halftone Screen (frequency, angle, six dot shapes) and Custom Pattern (seven built-in tiles),
  with an output resolution.
- **Duotone…**: a grey image printed with one to four inks. Choose Monotone to Quadtone or one of
  eight presets, and set each ink's colour, name and curve. Choose Duotone again to edit the inks.
- **Indexed Color…**: up to 256 colours. Palette (Exact, System, Web, Uniform, Perceptual,
  Selective, Adaptive, Custom), number of colours, forced colours, transparency, matte, and
  Diffusion, Pattern or Noise dither. **Image › Mode › Color Table…** (or a double-click on the
  Index channel) edits the palette: click a swatch, drag across a range for a gradient, pick the
  transparent colour with the eyedropper, load or save an `.act` file.
- **RGB Color**, **CMYK Color**, **Lab Color**: the Channels panel and the Info panel show the
  channels of the mode. **Image › Trap…** (CMYK only) spreads colours slightly under their
  neighbours.
- **Multichannel**: each channel becomes a spot channel.
- **File › Automate › Conditional Mode Change…** converts only when the document is in one of the
  modes you tick; it is meant for actions.

Things to know:

- Pigment always stores RGB pixels with transparency. CMYK, Lab and Multichannel are channel views
  of those pixels: you see and select their channels, but nothing is separated into inks and there
  is no colour management. Do not rely on CMYK numbers for press work.
- The foreground and background colours snap to what the mode can hold (greys in Grayscale,
  palette colours in Indexed Color) and come back when you switch to a colour document.
- Text, shape, fill and adjustment layers are not converted; the mode only limits how they are shown.
- Bitmap, Duotone and Indexed Color need 8 bits per channel. Painting in a large Indexed Color
  document is slower than in RGB.

## Bit depth

Image › Mode › 8, 16 or 32 Bits/Channel converts all pixel layers in one undo step. 16 bits is
available in Grayscale, RGB, CMYK, Lab and Multichannel; 32 bits in Grayscale and RGB. Going down
to 8 bits dithers to avoid banding. File › New can start a document at any depth.

- **Full precision**: Levels, Curves, Brightness/Contrast, Exposure, Vibrance, Hue/Saturation,
  Color Balance, Black & White, Photo Filter, Channel Mixer, Invert, Posterize, Threshold, Gradient
  Map and Desaturate; crop, Canvas Size, flips, 90° rotations and Flatten Image.
- **8-bit on the pixels they touch**: painting and retouching, fills, filters, the other
  adjustments, Image Size, arbitrary rotation, Free Transform, the warps, Content-Aware Scale,
  Merge Down and the Auto commands. The untouched pixels keep their precision; the changed ones
  come from 8-bit values. Masks are 8-bit.
- **32 bits** keeps highlights above white (Exposure +2 then −2 loses nothing) and clips them when
  you go back down. Values are display-referred, not linear light as in Photoshop.
- The Info panel adds a 16-bit readout on Photoshop's 0–32768 scale, or floating-point values at
  32 bits; "from 8-bit" marks a value that comes from the 8-bit composite.
- Files: `.pigment` keeps the deep pixels; 16-bit PNG and TIFF open and save at 16 bits; PSD, JPEG,
  WebP and Targa are written at 8 bits with a notice. Export As says whether a file is composited
  at 16 bits or from the 8-bit composite, and why (layer effects, clipping masks and blend modes
  other than Normal, Multiply and Screen force the 8-bit composite).

## Actions and automation

### The Actions panel

Window › Actions (Alt+F9) lists action sets, their actions and each action's steps. It shares the
bottom panel group with Layers.

- **Record**: select or create an action (New Action asks for its name, set, function key and
  colour), press the record button, do the work, press stop. Menu commands are recorded with the
  settings you confirmed in their dialogs. Also recorded: selections made with tools (as the
  resulting selection), Free Transform, layer picks (by name), foreground/background colour
  changes, guides and Save As. Undo while recording removes the step.
- **Not recorded**: brush, eraser and other tool strokes, Move tool drags, layer drag-reordering,
  Warp / Perspective Warp / Puppet Warp, Fade, and edits made in place to an adjustment, fill or
  smart filter. Pigment says so once when it happens.
- **Play**: select an action and press play, or a step to start from there. Untick a step to skip
  it; turn on its dialog toggle to stop at that command's dialog (it opens with the command's usual
  values, not the recorded ones). If a command is not available, playback asks Stop or Continue.
- **Edit**: drag steps to reorder, duplicate or delete them, double-click a step to edit its
  recorded settings (as JSON). The panel menu has Insert Stop (a message, optionally with
  Continue), Insert Menu Item (any command), Insert Conditional (play another action if a condition
  holds), Playback Options (accelerated, step by step, or with a pause), Button Mode, and Save,
  Load, Clear and Reset Actions.
- **Files**: sets are saved as `.pigment-actions` files. Photoshop `.atn` files cannot be loaded.
- A **Default Actions** set comes with the app: Vignette (selection), Frame Channel – 50 pixel,
  Wood Frame – 50 pixel, Cast Shadow (type), Water Reflection (type), Custom RGB to Grayscale,
  Molten Lead, Sepia Toning (layer), Quadrant Colors, Gradient Map. They are built from Pigment's
  commands and only resemble Photoshop's.

### Batch and Image Processor

- **File › Automate › Batch…** plays an action on every file of a folder (optionally its
  subfolders) or on the open documents. Destination: None (leave open), Save and Close, or Folder
  with file naming built from tokens (document name, serial number, date, extension) and literal
  text; colliding names get `-2`, `-3`. Override Action "Open" and "Save As" Commands make recorded
  open and save steps use the batch's files. Errors: Stop for Errors, or Log Errors to File.
- **File › Scripts › Image Processor…** converts a folder or the open documents to JPEG, PSD, PNG
  and/or TIFF, each into its own subfolder, with Resize to Fit and an optional action. Open
  documents are left unchanged. "Convert Profile to sRGB" does nothing (no colour management).

### Other Automate and Scripts commands

- **Fit Image…** scales the image to fit inside a width and height; Don't Enlarge leaves smaller
  images alone.
- **Crop and Straighten Photos** finds separate photos on a scan and puts each into its own
  document, straightened. The scan needs a plain border colour and gaps between the photos.
- **Contact Sheet…** lays out the images of a folder as thumbnails on one or more pages, with
  optional file-name captions, in RGB or Grayscale.
- **Conditional Mode Change**, **Merge to HDR**, **Photomerge**, **Load Files into Stack** and
  **Statistics** are described under Image modes and Combining images.
- **Delete All Empty Layers**, **Flatten All Layer Effects** (bakes every layer style into pixels)
  and **Flatten All Masks** (applies every layer mask) each make one undo step.

## File formats and Save for Web

| Format | Open | Save / Export | Notes |
|---|---|---|---|
| `.pigment` | yes | yes | Everything: layers, masks, styles, smart objects, channels, paths, guides, mode, 16/32-bit pixels, File Info |
| PSD / PSB | yes | PSD | Layers, groups, masks, adjustment layers, editable text; 8 bits; File Info as XMP |
| PNG | yes | yes | 8-bit; 16-bit when the document is 16-bit or with "PNG 16-bit" in Export As; palette PNGs open as Indexed Color |
| PNG-8 | yes | Export As, Save for Web | Palette, dither, transparency; saving an Indexed Color document as `.png` also writes PNG-8 |
| JPEG, WebP | yes | yes | Quality; WebP lossless |
| GIF | yes | yes | Opens as Indexed Color with its colour table; first frame only, no animation |
| TIFF | yes | yes | 8, 16 or 32-bit float; LZW, Deflate, PackBits or none. Not read: JPEG-in-TIFF, CCITT, YCbCr, Lab, BigTIFF. Multi-page files open the first image; grey files open as RGB |
| Targa (.tga) | yes | yes | 24/32-bit, optional RLE |
| BMP, AVIF, SVG, ICO | yes | no | SVG is rasterized |

**Save for Web (Legacy)** (File › Export) shows the original next to the optimised result for GIF,
JPEG, PNG-8, PNG-24 or WebP. Set the quality or the palette, colours, dither, transparency and
matte, and the image size; the status line gives the file size and a download-time estimate.
Save… writes exactly the bytes that were previewed. There is no 4-up view, no slices, no metadata
options and no animation.

**File Info** (File › File Info…, Ctrl+Alt+Shift+I) holds the title, author, description,
copyright notice, status and URL, keywords, rating, credit and source, and shows the camera data
(EXIF) of an opened photo read-only. It is saved in `.pigment` files and written as XMP into PSD
files; other formats are saved without it. Metadata is read when you open JPEG, TIFF, PSD, PNG
and WebP files.

## AI

The AI menu adds generative tools and an assistant. They are optional and off until you connect an
account: nothing leaves your computer unless you run one of them, and then only the pixels and
text that feature needs.

### Accounts

AI › AI Accounts… shows one card per provider:

- **OpenAI**: click **Sign in with ChatGPT**. Your browser opens the ChatGPT sign-in; approve
  Pigment there and come back. This uses your ChatGPT Plus or Pro plan for the chat models (Describe
  Image and the assistant). If the browser is on another computer, use Copy link to open the page
  there and paste the address it ends on into the card. Alternatively paste an **API key** from
  platform.openai.com: it is billed per use, and it is the only way to use OpenAI's image models
  (Generative Fill, Generative Expand, Generate Image, Remove / Replace Background, Replace Sky).
- **Google Gemini**: paste an API key from Google AI Studio. Google offers no plan sign-in for
  third-party apps. Gemini keys cover both chat and image models.

Each card lets you choose the chat and image model and sign out; Preferred provider picks which
one the features use when both are connected (each dialog can still switch). Keys and tokens are
stored in the app data folder, encrypted with the system keychain where one is available; the
dialog warns when it is not. Sign in with ChatGPT needs the desktop app; in the browser version keys
are kept in the browser.

### Generative tools

Each tool asks for a prompt and the provider and model, then adds the result as a new layer above
the current one (one undo step; the original pixels are never changed), with a Cancel button in
the status toast while it runs.

- **Generative Fill**: make a selection, describe what should appear in it. Up to three
  variations, each a layer holding only the selected area.
- **Generative Expand**: enter the new canvas size (and where the image stays) and describe how
  the new area should continue the picture; the canvas grows and the empty band is filled. A
  transparent area you added yourself with Image › Canvas Size is filled too.
- **Generate Image**: a picture from a description, as a layer in the open document or as a new
  document of the size you choose, optionally with a transparent background.
- **Remove Background**: keeps the subject of the active layer. The result is a copy of the layer
  with a layer mask (so you can refine the edge with a brush), and the original is hidden.
- **Replace Background**: keeps the subject and generates new surroundings from your description.
- **Replace Sky**: the bright area at the top of the image is treated as the sky, or select the
  sky yourself first; describe the new one.
- **Describe Image**: a text description of the composite that you can copy or store as the
  document description (File › Document Properties).

### Assistant

Window › AI Assistant (or AI › AI Assistant) opens a chat panel for the active document. Choose the
provider and chat model at the top, type a question or an instruction and press Enter (Shift+Enter
for a new line). With Attach image ticked, a downscaled copy of the composite goes with each
message so the model can see what it is working on.

The assistant can read the document (layers, selection) and edit it: apply adjustments and filters,
change the selection, crop, resize the image or canvas, add or change layers, fill, add text, run
most menu commands and run Generative Fill. Every action shows in the conversation as a step,
changes the document immediately and is a normal history entry, so Ctrl+Z undoes it. Stop ends a
turn after the current step; the trash button clears the conversation. It cannot open, save,
close or print files, and it never talks to the providers on its own.

## Undo and history

Ctrl+Z undoes (repeat to go further back), Ctrl+Shift+Z redoes; Alt+Ctrl+Z and Shift+Ctrl+Z step
backward and forward. The History panel lists every step: click one to go back to it, and take
snapshots of states you want to keep. Edit › Preferences sets how many steps and how much memory
the history may use. Edit › Purge frees memory: Undo, Clipboard, Histories or All. Purging cannot
be undone.

## Keyboard shortcuts

Help › Keyboard Shortcuts shows every shortcut. The most used ones:

| Action | Shortcut |
|---|---|
| New / Open / Save / Save As | Ctrl+N / Ctrl+O / Ctrl+S / Ctrl+Shift+S |
| Export As / Quick Export as PNG | Ctrl+Alt+Shift+S / Ctrl+Alt+Shift+E |
| Close / Close All / Close Others | Ctrl+W / Ctrl+Alt+W / Ctrl+Alt+P |
| File Info | Ctrl+Alt+Shift+I |
| Undo / Redo | Ctrl+Z / Ctrl+Shift+Z |
| Copy / Copy Merged / Paste | Ctrl+C / Ctrl+Shift+C / Ctrl+V |
| Free Transform / Content-Aware Scale | Ctrl+T / Ctrl+Alt+Shift+C |
| Select all / Deselect / Inverse | Ctrl+A / Ctrl+D / Ctrl+Shift+I |
| Select and Mask | Ctrl+Alt+R |
| Select all layers / Find Layers | Ctrl+Alt+A / Ctrl+Alt+Shift+F |
| New layer / Layer via copy / Merge down | Ctrl+Shift+N / Ctrl+J / Ctrl+E |
| Group / Ungroup | Ctrl+G / Ctrl+Shift+G |
| Levels / Curves / Hue-Saturation / Invert | Ctrl+L / Ctrl+M / Ctrl+U / Ctrl+I |
| Last filter / Liquify | Ctrl+F / Shift+Ctrl+X |
| Camera Raw filter / Lens Correction | Ctrl+Shift+A / Ctrl+Shift+R |
| Actions panel | Alt+F9 |
| Cycle the tools in a slot (wand: Quick Selection, Magic Wand, Object Selection; crop: Crop, Perspective Crop) | Shift+W, Shift+C |
| Print | Ctrl+P |
| Gamut warning | Ctrl+Shift+Y |
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
- **Very large images are slow**: Pigment keeps every layer in memory; a 10,000 × 10,000 layer takes
  400 MB at 8 bits per channel. A 16-bit layer keeps its 16-bit samples as well (another 800 MB),
  a 32-bit layer 1.6 GB more. Lower the history memory in Preferences, flatten finished parts, work
  at a smaller size, or stay at 8 bits. Edit › Purge frees the undo history and the clipboard.
- **A command does nothing and a message says "Finish … first"**: Blur Gallery, Select and
  Mask and Content-Aware Scale take over the window until you apply (Enter) or cancel (Escape).
- **Select Subject or Select Sky picked the wrong area, or found nothing**: they are heuristics,
  not a trained model. Start from the Object Selection tool or Quick Selection instead and refine
  in Select and Mask; AI › Remove Background uses a provider model if you have an account connected.
- **A 16-bit image shows banding after a filter or brush stroke**: those work at 8 bits on the
  pixels they change. Do tonal work with adjustments (or adjustment layers), which keep the
  precision.
- **Export As says "8-bit composite"** for a 16-bit document: a layer effect, clipping mask or a
  blend mode other than Normal, Multiply or Screen is in use. Flatten or simplify those layers to
  export real 16-bit data.
- **CMYK values do not match Photoshop**: CMYK and Lab are views of RGB pixels without colour
  management; see Image modes.
- **A Color Lookup preset looks different from Photoshop's**: the presets are Pigment's own
  approximations. Load the original `.cube` or `.3dl` file to get the exact look.
- **A TIFF does not open**: JPEG-compressed, CCITT, YCbCr, Lab and BigTIFF files are not
  supported; the message names the reason. Re-save the file with LZW or no compression.
- **An action loaded from Photoshop is refused**: `.atn` files are not supported. Record the action
  again in Pigment.
- **An action stops with "not available"**: the step's command cannot run on this document (no
  selection, wrong layer type, a layer name that does not exist). Choose Continue to skip it, or
  untick the step.
- **Displace or a texture filter opens its dialog during Last Filter or an action**: the map or
  texture file is not stored with the settings and has to be chosen again.
- **Flame says "Draw a path first"**: it needs a path; draw one with the Pen tool.
- **Shake Reduction changed nothing**: it found no straight, directional blur to remove.
- **Fonts are missing in the Type tool**: Pigment lists installed fonts when the system allows it;
  otherwise it offers common font families.
- **Sign in with ChatGPT never comes back**: the browser must reach `http://127.0.0.1:1455` (or
  the next few ports) on the computer running Pigment. If the browser is elsewhere, or a firewall
  blocks it, copy the final address from the browser's address bar and paste it into the card.
  "Plan access not granted" means the sign-in finished but the account's plan cannot be used by
  apps; use an API key instead.
- **An AI feature says it needs an image model**: ChatGPT plans do not include image models. Add
  an OpenAI API key (after signing out of ChatGPT) or a Gemini key.
- **"No secure storage" warning in AI Accounts**: the system keychain (Keychain, Credential
  Manager, or libsecret on Linux) is not available, so keys are stored unencrypted in
  `ai-credentials.json` in the app data folder. Install or unlock a keyring, or sign out when done.
