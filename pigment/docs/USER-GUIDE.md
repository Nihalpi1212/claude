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

## New in Pigment 0.4

Pigment 0.4 brings a new type engine with several character and paragraph formats in one text layer, the Character and Paragraph panels, deeper layer styles, adjustment dialogs with presets and eyedroppers, gradients and a pattern library, guides and snapping, vector masks, live shapes, a deeper Layers panel and Layer menu, and Photoshop's shortcuts and conventions. The sections below describe each area; the release notes list every changed default and key (docs/RELEASE-NOTES-0.4.md).

### Type: the HarfBuzz type engine

#### How Pigment draws text

Pigment 0.4 shapes text with HarfBuzz, the shaping engine of Chrome, Firefox and Android. Kerning, ligatures (such as
"fi" and "ffi"), combining accents, emoji sequences and scripts whose letters change shape with their neighbours are
set as the font designer intended. Each glyph is drawn from the font's own outline.

Pigment reads the fonts installed on your computer. The desktop app has access to them from the start. In a browser,
open the font list in the options bar of the Type tool once, and allow the browser to use your fonts. A font's files
are read the first time a text layer uses it. Until they arrive, which takes a moment, the text is drawn with the
browser's own text drawing; then it is drawn again with the font. This does not add a step to History and does not
mark the document as changed.

When a font is not installed, Pigment uses a font with the same measurements where one exists, as the operating
system does: Liberation Sans for Arial and Helvetica, Liberation Serif for Times New Roman, Liberation Mono for
Courier New, Carlito for Calibri and Caladea for Cambria. Any other missing font is drawn with the browser's text
drawing, as in Pigment 0.3.

#### Several formats in one text layer

A text layer can mix fonts, sizes, colours, tracking, baseline shift, super- and subscript, small and all caps,
underline and strikethrough from one character to the next. Each paragraph has its own alignment, indents and space
before and after. The Character and Paragraph panels set these values. With auto leading, each line is spaced from
the line above by the leading of its largest text, so a line with large letters does not run into the line above.

#### Paragraph text in a box

Drag with the Type tool to make a text box. The text wraps at the box's width. A box can also have a fixed height:
lines that do not fit are hidden, and the box reports that its text overflows (the Type tool shows a plus sign in the
box's corner handle). Point text, made by clicking, grows with the text.

#### Tracking

Tracking (Character panel) is set in thousandths of an em and is added after each character of the selection. A
ligature counts as one character, so tracking never breaks "fi" into two letters. No tracking is added after the last
character of a line, so tracked text stays aligned with the box's edge.

#### Colour fonts and emoji

Colour fonts (COLR, CBDT, sbix, such as Noto Color Emoji or Segoe UI Emoji) draw in their own colours. Emoji
sequences (families, flags, skin tones) stay one character for the caret and for tracking. When the font of a run has
no glyph for a character, the browser's text drawing finds one in another installed font, so emoji and other scripts
appear in any font.

#### Text on a path

Text on a path takes its glyphs from the same engine: kerning, ligatures, accents and emoji stay intact on a path, and
each run keeps its own size and colour.

### Type: editing text

#### Typing

Click with the Horizontal or Vertical Type tool to start point text, or drag to draw a paragraph box. A new text layer
starts with placeholder text ("Lorem Ipsum", or a paragraph of it in a box), already selected: the first key you type
replaces it. To start with an empty layer instead, turn off **Fill new type layers with placeholder text** in
Preferences > Type. Click a text layer with a Type tool, or double-click it with the Move tool, to edit it.

Pigment draws its own text cursor and selection on the canvas, over the text as it is laid out, so they follow every
size, font and line of the layer. Input methods for Chinese, Japanese and Korean, and dead keys for accents, work as in
any text field: the text being composed appears in the layer, underlined, until you confirm it.

- **Tab** types a tab character (tab stops come from the paragraph's tab spacing).
- **Enter** starts a new paragraph; **Shift+Enter** starts a new line in the same paragraph.
- **Ctrl+Enter** (Cmd+Return on macOS), Enter on the numeric keypad or the ✓ button commits the text; **Esc**
  cancels the edit.
- Clicking outside the text commits it. Choosing a command in a menu with the mouse also commits the text first, then
  runs the command.

#### Selecting text

- Drag across text to select it. Shift-click extends the selection.
- Double-click selects a word, three clicks a line, four clicks a paragraph, five clicks all the text. Dragging after
  a double-click extends the selection by whole words (and by lines or paragraphs after three or four clicks).
- **Ctrl+A** selects all the text.
- The arrow keys move by character; **Ctrl+Left** / **Ctrl+Right** by word; **Home** / **End** go to the start and
  end of the line; **Ctrl+Home** / **Ctrl+End** to the start and end of the text; **Ctrl+Up** / **Ctrl+Down** by
  paragraph. Add Shift to extend the selection. On macOS, Cmd+Left / Right go to the line's start and end, and
  Cmd+Up / Down to the text's start and end.
- **Ctrl+H** hides the selection highlight while you look at the formatting (press it again to show it).

#### Undo while typing

While you edit text, Edit > Undo, Ctrl+Z and Redo step through your typing and formatting changes inside the text.
When you commit, the whole edit becomes one step in the History panel.

#### Cut, copy and paste

Cut and copy put the text on the system clipboard, so you can paste it into other applications. Pasted into a Pigment
text layer, it keeps its fonts, sizes, colours and paragraph formats. If you copied something else since (in Pigment or
another application), Paste inserts that plain text in the format at the cursor.

**Edit > Paste Special > Paste Without Formatting** pastes the clipboard's text in the format at the cursor, even when
it was copied from formatted Pigment text.

#### Paragraph boxes

While editing paragraph text, the box shows eight handles. Drag a corner or an edge to change the box's width and
height. A box keeps the height you give it: text that does not fit is hidden, and the bottom-right handle shows a red
plus sign. Make the box taller, or the text smaller, to show it.

To make a box of an exact size, Alt-click (Option-click on macOS) with a Type tool: Pigment asks for the width and the
height of the box. Alt-dragging asks too, with the size you dragged filled in.

#### Moving and transforming text while editing

- Drag starting outside the text to move it. Hold **Ctrl** (Cmd on macOS) and drag inside the text to move it too.
- Hold **Ctrl** (Cmd) to see the transform box. Drag a handle to scale the text, or drag just outside a corner to
  rotate it. When you release the mouse button, the transform is applied and you go on editing.

#### Type shortcuts

These keys work while you edit text (Ctrl is Cmd on macOS). With a selection they change the selected characters; with
just the cursor, size, leading and baseline changes apply to what you type next.

| Keys | Action |
|---|---|
| Shift+Ctrl+. / Shift+Ctrl+, | Font size up / down by 2 px |
| Alt+Shift+Ctrl+. / , | Font size up / down by 10 px |
| Alt+Up / Alt+Down | Leading tighter / looser by 2 px |
| Alt+Ctrl+Up / Down | Leading by 10 px |
| Alt+Left / Alt+Right | Kerning (at the cursor) or tracking (on a selection) by 20/1000 em |
| Alt+Ctrl+Left / Right | Kerning or tracking by 100/1000 em |
| Shift+Alt+Up / Down | Baseline shift up / down by 2 px (Shift+Alt+Ctrl: 10 px) |
| Shift+Ctrl+L / C / R | Align left / centre / right |
| Shift+Ctrl+J / F | Justify, last line left / justify all |
| Shift+Ctrl+B / I | Faux Bold / Faux Italic |
| Shift+Ctrl+U / Shift+Ctrl+/ | Underline / Strikethrough |
| Shift+Ctrl+K / H | All Caps / Small Caps |
| Shift+Ctrl+= / Alt+Shift+Ctrl+= | Superscript / Subscript |
| Shift+Ctrl+X / Alt+Shift+Ctrl+X | Horizontal / vertical scale back to 100 % |
| Alt+Shift+Ctrl+A | Auto leading |
| Shift+Ctrl+Q | Tracking back to 0 |
| Alt+Shift+Ctrl+H / T | Hyphenation on or off / switch the paragraph composer |
| Ctrl+H | Hide or show the selection highlight |

Several of these keys run other commands when no text is being edited (Shift+Ctrl+L is Auto Tone, Shift+Ctrl+C Copy
Merged): while you type, they act on the text only.

### Type: the Character panel

#### What the Character panel changes

The Character panel (Window > Character, or the panel button in the Type tool's options bar) works on:

- **the selected characters** while you edit text with a Type tool. Select a word and change its size, and only that
  word changes. With only a text cursor and no selection, a change applies to the next characters you type, as in
  Photoshop.
- **every selected text layer** when you are not editing text. A change applies to all their text; the History panel
  gets one step for the change, however many layers are selected.
- **new text** when no text layer is selected. The panel then says "These settings apply to new text", and what you set
  there (tracking, underline, scale and so on) is what the next text you create starts with.

When the selection has several values (two sizes, bold and regular), the field is empty, a toggle button is half
lit and a list shows a blank entry. Typing a value or picking one sets it for the whole selection.

Every change you make in the panel also becomes the starting point for new text, as in Photoshop, except the colour of
existing text (which does not change your foreground colour) and manual kerning (which belongs to one pair of
letters).

#### The fields

- **Font** and **Style**: the font family and the face (weight, italic).
- **Size**: the font size, with a list of the usual sizes (6 to 72). Drag the label left or right to change the value.
- **Leading**: the distance between lines. "Auto" (the default) follows the size (120 % of the largest size on the
  line, set in the paragraph's justification settings); the field then shows the computed value in brackets. Type a
  value to fix it, or pick **Auto** in its list to go back.
- **Kerning**: **Metrics** uses the pairs stored in the font; **Optical** spaces each pair by the shapes of its letters
  (useful for fonts with poor kerning and for mixed fonts); **0** turns kerning off. The number next to it is manual
  kerning in thousandths of an em: with the text cursor between two letters it changes the space between that pair,
  on a selection it applies to every letter. Alt+Left / Alt+Right while editing change it in steps.
- **Track**: tracking, the space added between all letters of the selection, in thousandths of an em.
- **V** and **H**: vertical and horizontal scale in percent.
- **Shift**: baseline shift (positive moves the letters up).
- **Color**: the text colour.
- The toggle buttons: **Faux Bold**, **Faux Italic**, **All Caps**, **Small Caps**, **Superscript**, **Subscript**,
  **Underline** and **Strikethrough**. Faux Bold and Faux Italic are drawn by Pigment and work with any face, also with
  a face that is already bold or italic. All Caps and Small Caps, and Superscript and Subscript, exclude each other.
- **Language**: the dictionary used to hyphenate the text. The list shows the languages Pigment can hyphenate and the
  languages already used in the document.
- **aa** (anti-aliasing): None, Sharp, Crisp, Strong or Smooth, stored with the layer.
- **Orientation**, **Stroke** and **Text** (point text or a paragraph box with its width and height) are Pigment's
  own rows below. Choosing **Paragraph box** for point text puts a box around the text as it is; **Point text** removes
  the box. An empty box height means the box grows with the text.

The panel menu (the ••• button) has the toggles again, **Fractional Widths** (on by default; off rounds each letter's
width to whole pixels), **System Layout** (lays the layer out like an operating-system text field), **No Break** (the
selected words are never split across lines), the type unit, and **Reset Character**.

#### Type units

Sizes, leading, baseline shift and the box size are shown in pixels, points or millimetres. Choose the unit in the
Character panel menu or in Preferences > Type Units. Points and millimetres are converted with the document's
resolution (Image > Image Size): 12 pt is 12 px at 72 ppi and 50 px at 300 ppi. The options bar's size field uses the
same unit and has the same list of sizes; drag its "T" icon to change the size.

#### Reset Character

Panel menu > Reset Character sets leading, kerning, tracking, scales, baseline shift, the toggles, language, Fractional
Widths and No Break back to their defaults for the selection (or the selected layers, or new text). It keeps the font,
style, size, colour and stroke.

#### The Properties panel for type

With a text layer selected, the Properties panel shows the layer's transform, a **Character** section with the same
controls as the Character panel (it changes the same thing), the paragraph controls once the Paragraph panel is there,
**Edit Text** and a button that opens the Character panel.

### Type: the Paragraph panel

#### What the Paragraph panel changes

Window > Paragraph (or Type > Panels > Paragraph Panel, or the panel button in the Type tool's options bar) shows the
Paragraph panel. Like the Character panel it works on:

- **the paragraphs under the selection** while you edit text with a Type tool. With only a text cursor, the paragraph
  the cursor is in; with a selection, every paragraph the selection touches.
- **every selected text layer** when you are not editing text: all their paragraphs, one History step per change.
- **new text** when no text layer is selected. The panel then says "These settings apply to new text". The alignment
  you choose there is also the alignment in the Type tool's options bar.

When the paragraphs have different values, the field is empty and no alignment button is lit. The Properties panel
shows the same controls in its **Paragraph** section for a text layer.

#### Alignment

The seven buttons are, from the left: **Left align text**, **Center text**, **Right align text**, **Justify last
left**, **Justify last centered**, **Justify last right** and **Justify all**. The justify alignments stretch every line
of a paragraph text box to both edges; their last line is set left, centred or right, and Justify all stretches the last
line too. Point text (text without a box) is not justified. A line that ends with a forced line break (Shift+Enter) is
justified like any other line of the paragraph.

#### Indents and spacing

- **Indent left margin** and **Indent right margin** move the paragraph's lines in from the box edges.
- **Indent first line** indents the paragraph's first line from the left indent. A negative value makes a hanging
  indent (the first line starts further left).
- **Add space before paragraph** and **Add space after paragraph** add room between paragraphs. Space before the first
  paragraph of a layer is ignored.

The values are in the type unit you chose for the Character panel (pixels, points or millimetres).

#### Hyphenation

Turn on **Hyphenate** to let Pigment break words at the end of lines. Words are hyphenated by the patterns of their
language (the Character panel's **Language**): American and British English, German, French, Spanish, Italian, Dutch and
Portuguese. Text in another language is not hyphenated. A soft hyphen typed into a word (U+00AD) always marks a place
where the word may break, and shows a hyphen when it does.

**Hyphenation…** in the panel menu sets:

- **Words Longer Than**: shorter words are never hyphenated.
- **After First** and **Before Last**: the least number of letters before and after a hyphen.
- **Hyphen Limit**: the most lines in a row that may end with a hyphen (0: no limit).
- **Hyphenation Zone**: for text that is not justified, how far from the right edge a line must end before Pigment
  hyphenates the next word instead of moving it to the next line. 0 hyphenates whenever it helps.
- **Hyphenate Capitalized Words** and **Hyphenate Last Word** (the paragraph's last word).

When the selected paragraphs have different settings, the field is empty and reads "Mixed"; leave it empty to keep each
paragraph's own value, or type a value to set it for all of them. OK makes one History step.

#### Justification

**Justification…** in the panel menu sets how justified lines are stretched and compressed:

- **Word Spacing**: the space between words, in percent of the normal space: the least (Minimum), the preferred
  (Desired) and the most (Maximum). Desired applies to every line, also lines that are not justified.
- **Letter Spacing**: space added between letters, in percent of the normal space (0 % adds none).
- **Glyph Scaling**: how much the letters themselves may be made narrower or wider.
- **Auto Leading**: the line spacing of Auto leading, in percent of the largest font size on the line.
- **Single Word Justification**: how a justified line with a single word is set: Full Justify (its letters spread to
  both edges), Align Left, Align Center or Align Right.

Pigment stretches word spacing first, up to its Maximum, then letter spacing, then glyph scaling; beyond all three it
stretches word spacing further. Compression goes the other way, down to the Minimums. As in the Hyphenation dialog,
empty fields keep each paragraph's own values, and Minimum cannot be more than Desired nor Desired more than Maximum.

#### Composers

The panel menu chooses how lines are broken:

- **Adobe Every-line Composer** (the default) looks at the whole paragraph and picks the breaks that give the most even
  spacing (justified text) or the most even right edge (ragged text), hyphenating only where it pays off.
- **Adobe Single-line Composer** sets one line at a time: it fills each line as far as it can, prefers adjusting word
  spacing to hyphenating, and hyphenating to letter spacing.

#### Line breaks

Pigment breaks lines where the Unicode line breaking rules allow: after spaces, after hyphens and dashes, between
Chinese and Japanese characters (not before closing punctuation or small kana), at word boundaries in Thai and its
neighbours, never inside numbers such as 3.14 or 1,000.00, and after a slash in a long address. **Line breaks** in the
panel menu can switch a paragraph to **At Spaces Only (Pigment 0.3)**: breaks after spaces and nowhere else, as
Pigment 0.3 did. Documents saved by Pigment 0.3 open with that setting and the Single-line Composer, so their text
keeps every line it had.

A word longer than the line is broken where it must (Photoshop does the same) instead of sticking out of the box.

#### Roman Hanging Punctuation

With **Roman Hanging Punctuation** (panel menu) on, punctuation at the start and end of lines hangs outside the margins
so the edges of the text look straight: quotes, hyphens, periods and commas hang wholly outside; colons, semicolons,
dashes, ellipses, asterisks and tildes by half.

#### Bulleted and numbered lists

The two list buttons turn the paragraphs into a bulleted or a numbered list (press the button again to turn the list
off). A paragraph without a left indent gets one, so the marker sits inside the box. With a list on, the row shows:

- the marker: •, ◦, ▪, –, ✓ or ★ for bullets; 1. 2. 3., a. b. c., A. B. C., i. ii. iii. or I. II. III. for numbers;
- **Start**: the first number of a numbered list;
- **Level** (1 to 9): nested lists. The default bullet changes with the level (•, ◦, ▪), and the numbers of a nested
  list start again after each item of the list above it.

#### Reset Paragraph

**Reset Paragraph** (panel menu) sets every paragraph setting back to Photoshop's defaults: left alignment, no indents
or spacing, no hyphenation, the default hyphenation and justification settings, the Every-line Composer, Unicode line
breaks, no hanging punctuation and no list.

#### The panel button in the Type tool's options bar

The button shows the Character panel (the first time) or the Paragraph panel (if that was in front the last time).
Pressed again while one of them is in front, it brings back the panel that was there before.

### Layer styles: Blending Options and styles on groups

#### Blending Options

Layer › Layer Style › Blending Options… (or double-click a layer, or the fx menu of the Layers panel) opens the Layer
Style dialog on its first page.

**General Blending:** the layer's blend mode and opacity.

**Advanced Blending:**

- **Fill opacity** fades the layer's own pixels but not its effects: at 0 % a layer with a stroke shows only the stroke.
- **Channels R, G, B:** untick a channel and the layer leaves it alone: the layer only changes the channels that stay
  ticked (a layer with only G ticked changes nothing but the green of what is below it).
- **Knockout** punches through the layers below, under the layer's shape. Lower the Fill to see it: at Fill 0 % the
  hole goes all the way. **Shallow** goes down to the bottom of the layer's group (a Normal group: to transparency inside
  the group, so what is under the group shows; a Pass Through group: to what was under the group). **Deep** goes down
  to the Background layer (to transparency when the document has no Background). For a layer that is not in a group,
  Shallow works like Deep.
- **Blend Interior Effects as Group:** Inner Glow, Satin and the three overlays are blended into the layer first and
  fade with its Fill, instead of keeping their full strength.
- **Blend Clipped Layers as Group** (on by default): the layers clipped to this one are blended into it first and the
  result takes this layer's blend mode. Off: each clipped layer blends with what is below in its own mode, inside this
  layer's shape (this layer's Fill does not fade them).
- **Transparency Shapes Layer** (on by default): effects and knockout follow the layer's transparency. Off: the
  interior effects and the knockout fill the layer's whole content box.
- **Layer Mask Hides Effects:** the layer mask hides the effects too, instead of shaping the layer before them (by
  default a stroke follows the edge of the mask; with this on the stroke is cut off by it).
- **Vector Mask Hides Effects:** the same for the vector mask.

**Blend If** hides pixels by their brightness. Pick Gray or one channel (Red, Green, Blue) in the menu. The **This
Layer** slider hides the layer's pixels outside its range; the **Underlying Layer** slider hides the layer wherever what
is below it falls outside its range. Drag the black triangle right to hide dark pixels, the white one left to hide
light ones. Hold **Alt** while you drag a triangle to split it in two: between the halves the pixels fade in gradually
instead of being cut off hard. A split triangle's halves move on their own. The four numbers next to each slider show
and set its values (black left, black right, white left, white right). With a slider triangle focused, the arrow keys
move it (Shift: by 10, Alt: one half). The settings of each channel are kept; the layer shows where every channel
lets it through. Blend If leaves exterior effects (drop shadows, outer glows) alone.

The **Global Light…** button sets the angle every effect with Use Global Light shares.

Cancel puts everything back; OK records the whole dialog as one step in the History.

#### Styles on groups

Groups take layer styles like any layer: select a group and open Layer Style. The effects are drawn around everything
the group shows, as one shape. A Pass Through group with effects (or with advanced blending options) is composited as
an isolated group, as in Photoshop. The Background layer and adjustment layers take no styles.

#### Layer › Layer Style commands

- **Create Layers** turns each effect into a layer of its own: effects that lie outside the layer (Drop Shadow, Outer
  Glow, an outside stroke, the outer half of a bevel) become layers below it; effects inside it (the overlays, Satin,
  Inner Glow, Inner Shadow, the inner half of a bevel, an inside stroke) become layers clipped to it above. The layer
  keeps its pixels and loses its style. One undo step.
- **Hide All Effects / Show All Effects** hides every effect of the selected layers without removing them (the menu
  item says Show All Effects while they are hidden).
- **Scale Effects…** scales the sizes, distances, spreads, chokes and pattern scales of every effect of the layer (1 to
  1000 %), with a live preview.

### Layer styles: effects, instances and contours

#### The effect list

Layer › Layer Style (or double-click a layer, or the fx button of the Layers panel) opens the Layer Style dialog. The
list on the left has Blending Options and the ten effects. Tick an effect to switch it on; click its name to edit it.
Under Bevel & Emboss the list has two sub-effects, **Contour** and **Texture**, each with its own check box.

**Several instances.** Drop Shadow, Inner Shadow, Color Overlay, Gradient Overlay and Stroke can be applied more than
once, as in Photoshop. Click the **+** at the end of the effect's row: a copy of that effect appears above it and is
selected. Each copy has its own settings. The buttons under the list move the selected copy up or down (copies higher
in the list are drawn over the ones below) and delete it. Deleting the only copy of an effect switches it off and puts
its settings back to the defaults. A layer can hold up to ten copies of an effect.

**Reset to default** under each page puts that effect's settings back to Photoshop's defaults.

#### Drag in the document

While the page of Drop Shadow, Inner Shadow, Satin, Gradient Overlay, Pattern Overlay or the Bevel & Emboss Texture is
shown, drag in the document window to place the effect:

- Drop Shadow and Inner Shadow: the shadow follows the pointer; the drag sets Angle and Distance.
- Satin: sets Angle and Distance the same way.
- Gradient Overlay: moves the gradient (its offset; **Reset Alignment** puts it back in the middle).
- Pattern Overlay and Texture: moves the pattern (**Snap to Origin** puts it back).

The tool in the toolbox does not see these drags. The dialog stays open; Cancel undoes the drag with everything else.

#### Contours

A contour reshapes how an effect fades: Drop Shadow, Inner Shadow, Outer Glow, Inner Glow and Satin have a **Contour**,
Bevel & Emboss has a **Gloss Contour** (the lighting) and the **Contour** sub-effect (the shape of the bevel's edge).
Click the arrow next to the curve to pick one of Photoshop's built-in contours: Linear, Cone, Cone - Inverted, Cove -
Deep, Cove - Shallow, Gaussian, Half Round, Ring, Ring - Double, Rolling Slope - Descending, Rounded Steps and
Sawtooth 1. **Anti-aliased** softens contours with hard steps.

Click the curve itself to open the **Contour Editor**:

- Click the curve to add a point; drag a point to move it; drag it out of the box (or press Delete) to remove it. The
  two end points stay.
- **Input** and **Output** place the selected point exactly; **Corner** makes a sharp bend there instead of a smooth
  curve.
- **Preset** loads a built-in or saved contour; **Save as Preset…** adds the curve to the contour presets (they are kept
  with your other presets, in every document).

#### The effects and their new settings

- **Drop Shadow:** Contour, Anti-aliased, Noise, and **Layer knocks out drop shadow** (off: the shadow shows through a
  layer whose Fill is below 100 %).
- **Inner Shadow:** Contour, Anti-aliased, Noise.
- **Outer Glow and Inner Glow:** Noise; a **colour or gradient** fill (a gradient runs from the layer edge outwards, its
  left end at the edge; with no gradient chosen it is the glow colour fading to transparent); Technique **Softer** (a
  blur) or **Precise** (an exact distance from the edge: sharp corners stay sharp); Contour, Anti-aliased, **Range**
  (which part of the glow the contour spans) and **Jitter** (varies the gradient's colours from pixel to pixel).
- **Bevel & Emboss:** Technique Smooth, Chisel Hard or **Chisel Soft**; Gloss Contour and Anti-aliased. Sub-effects:
  **Contour** (Contour, Anti-aliased, Range) and **Texture** (Pattern, Snap to Origin, Scale, Depth from -1000 % to
  1000 %, Invert, Link with Layer). The texture uses the pattern's light and dark areas as bumps inside the layer.
- **Satin:** Contour and Anti-aliased.
- **Gradient Overlay:** the gradient picker and the Gradient Editor, Style, Angle, Scale, Method, Reverse, Dither,
  Align with Layer (off: the gradient spans the document instead of the layer) and Reset Alignment.
- **Pattern Overlay:** the pattern picker, Snap to Origin, Angle, Scale and Link with Layer (off: the pattern is
  anchored to the document, so it stays put when the layer moves).
- **Stroke:** Fill Type **Color**, **Gradient** (with every gradient style, plus **Shape Burst**, which runs across the
  stroke from its inside edge to its outside edge) or **Pattern** (Scale, Angle, Link with Layer).

### Adjustments: Levels, Curves and the tonal dialogs

#### The adjustment dialogs

Image › Adjustments opens each adjustment in a dialog that previews on the canvas. The same controls appear in the
Properties panel for an adjustment layer. From top to bottom:

- **Preset**: a menu of saved settings (see "Adjustment presets").
- **The adjustment's own controls** (below).
- **Eyedroppers and tools**: click a button, then click in the image. The canvas stays usable while the dialog is
  open: the click samples the image instead of using the active tool. The eyedroppers read the pixels before the
  adjustment (in Properties: everything below the adjustment layer, at full resolution) and average the area set by
  the Eyedropper tool's Sample Size (3 × 3 unless you changed it). Click the button again, or press Escape, to put the
  eyedropper down.
- **Auto**: sets the adjustment from the image. Alt-click (Option-click) Auto opens Auto Color Correction Options.
- **Preview**: turns the canvas preview on and off.

Image › Adjustments › Levels…, Curves…, Hue/Saturation… and Color Balance… open with the default settings, as in
Photoshop. To start from the values you used last, press **Alt+Ctrl+L**, **Alt+Ctrl+M**, **Alt+Ctrl+U** or
**Alt+Ctrl+B** (Option+Cmd on macOS). Shadows/Highlights, Replace Color, Match Color, HDR Toning and Color Lookup
still open with their last settings, as Photoshop's do.

#### Levels

- **Channel**: the composite or one channel. The list follows the document's mode: RGB, Red, Green, Blue in RGB;
  Gray in Grayscale (also Duotone and Bitmap); CMYK, Cyan, Magenta, Yellow, Black in CMYK; Lightness, a, b in Lab.
  An adjustment layer keeps the channels it was made with.
- **The histogram** of the image (of the channel shown).
- **Input Levels**: drag the black, grey and white triangles, or type the three values (shadows, midtones gamma,
  highlights). Hold **Alt** while dragging the black or white triangle to see which pixels clip: the canvas turns
  white (or black) except where a channel clips, shown in its colour.
- **Output Levels**: the two triangles or fields limit the darkest and lightest output.
- **Eyedroppers**: the black eyedropper makes the clicked colour black (each channel's input shadows move to it), the
  white one makes it white, the grey one makes it neutral grey while keeping its brightness (with a non-grey midtones
  target colour, it becomes that colour). Grayscale documents have no grey eyedropper.

#### Curves

- **Channel** as in Levels.
- **Points**: click the graph to add a point (up to 16), drag a point to shape the curve, drag it off the graph or
  press Delete to remove it; the arrow keys nudge the selected point (Shift: by 10). Input and Output show the
  selected point and can be typed.
- **Pencil**: draw the curve freehand. **Smooth** softens a drawn curve (click it several times for more). Switching
  back to Points turns the drawn curve into points that follow it.
- The **black and white sliders** under the graph move the curve's end points. With **Show Clipping** on (or Alt
  held), moving them shows the clipping display, as in Levels.
- **The on-image tool** (the button with the up-and-down arrow): click a tone in the image to add a point for it, and
  drag up or down to lighten or darken it.
- **Eyedroppers** as in Levels.
- **Curve Display Options**: show light (0–255) or pigment/ink percentages (the graph's axes reverse), a 4 × 4 or
  10 × 10 grid, and channel overlays, the histogram, the baseline and the intersection lines. These are remembered.

#### Exposure, Threshold, Brightness/Contrast

- **Exposure** has Photoshop's three eyedroppers: black sets Offset so the clicked tone becomes black, white sets
  Exposure so it becomes white, grey sets Exposure so it becomes middle grey.
- **Threshold** shows the histogram with a slider for the level.
- **Brightness/Contrast** has Auto.

#### Equalize

With a selection, Image › Adjustments › Equalize asks what to do: **Selected area only** equalizes the selection by its
own pixels; **Entire image based on selected area** measures the selection and applies the result to the whole layer.
Without a selection it equalizes the layer, as before.

#### Auto Color Correction Options

Alt-click Auto in Levels or Curves (or Brightness/Contrast) to choose how Auto works:

- **Algorithm**: Enhance Brightness and Contrast, Enhance Monochromatic Contrast (one stretch for all channels),
  Enhance Per Channel Contrast (each channel on its own; the default) or Find Dark & Light Colors (the darkest and
  lightest colours become black and white).
- **Snap Neutral Midtones**: the nearly neutral midtones become neutral.
- **Target Colors & Clipping**: the colours the shadows, midtones and highlights go to, and how much of the darkest
  and lightest pixels may clip (0.1 % by default).
- **Save as defaults**: keeps these settings for the Auto buttons and for Image › Auto Tone, Auto Contrast and Auto
  Color (Auto Tone uses Per Channel Contrast, Auto Contrast Monochromatic Contrast, Auto Color Find Dark & Light Colors
  with Snap Neutral Midtones, each with your clipping and target colours). Until you save defaults, the three
  commands work as in earlier versions.

The options apply to the image while the dialog is open; Cancel goes back.

#### Adjustment presets

The Preset menu at the top of Levels, Curves, Exposure, Brightness/Contrast and Threshold lists **Default**, the
built-in presets (Photoshop's lists: for Levels Darker, Increase Contrast 1–3, Lighten Shadows, Lighter, Midtones
Brighter, Midtones Darker; for Curves Color Negative, Cross Process, Darker, Increase Contrast, Lighter, Linear
Contrast, Medium Contrast, Negative, Strong Contrast; for Exposure Minus/Plus 1.0 and 2.0) and the ones you saved.
Picking one sets the dialog; changing anything afterwards shows **Custom**. The **⋯** button next to the menu has:

- **Save Preset…**: adds the current settings to the list under a name.
- **Load Preset…**: reads a preset file: Photoshop's Levels (.alv) or Curves (.acv) files, or Pigment's
  .pigment-presets. The preset is added to the list and applied.
- **Save to File…**: writes the current settings as a Photoshop .alv (Levels) or .acv (Curves) file, or a
  .pigment-presets file for the other adjustments.
- **Rename Preset…**, **Delete Current Preset** (a built-in one is hidden), **Reset Presets…** (back to the built-in
  list).

Presets are kept with your other presets (not in a document) and are there in every document and after a restart.
A preset made in one colour mode works in another: its composite goes to the composite and its channels to the
channels in order.

### Adjustments: Hue/Saturation and the colour dialogs

#### Hue/Saturation

- **Edit** chooses Master or one of the six colour ranges (Reds, Yellows, Greens, Cyans, Blues, Magentas). Each has
  its own Hue, Saturation and Lightness; Master applies to every pixel, a range only to its colours (greys belong to
  no range). Several ranges can be changed in one adjustment.
- With a range selected, the **range bars** show the colours it affects: the top bar is the input, the bottom bar the
  result. The two inner handles mark where the range has its full effect, the two outer triangles where its fall-off
  ends; drag a handle to move one bound, or the dark band between the inner handles to move the whole range. The
  numbers under the bars are the four bounds in degrees (Photoshop's notation).
- **Eyedroppers**: the first picks the range of the colour you click and centres the range on it; **+** widens the
  range so the clicked colour gets the full effect; **−** narrows it so the clicked colour is no longer affected.
- **On-image tool**: click a colour in the image to edit its range, then drag left or right to lower or raise its
  saturation; Ctrl-drag (Cmd on macOS) changes its hue.
- **Colorize** tints the whole image with one hue (the ranges do not apply).
- **Presets**: Cyanotype, Further Increase Saturation, Increase Saturation, Old Style, Red Boost, Sepia, Strong
  Saturation, Yellow Boost; Save Preset, Load Preset (.ahu) and Save to File (.ahu, Photoshop's format).

#### Black & White, Photo Filter, Channel Mixer, Selective Color, Gradient Map

- **Black & White**: **Auto** sets a grey mix that spreads the image's colours apart. The on-image tool: click a colour
  and drag left or right to change the slider for that colour. Presets: Blue Filter, Darker, Green Filter, High
  Contrast Blue Filter, High Contrast Red Filter, Infrared, Lighter, Maximum Black, Maximum White, Neutral Density, Red
  Filter, Yellow Filter; .blw files.
- **Photo Filter**: the **Filter** menu has Photoshop's list (Warming 85, LBA, 81, Cooling 80, LBB, 82, the colour
  filters, Sepia, Deep Red, Deep Blue, Deep Emerald, Deep Yellow, Underwater); choosing a colour of your own switches
  the menu to "Custom color".
- **Channel Mixer**: under the sliders, the **Total** of the source channels, with a warning when it is above 100 %
  (bright colours may clip). Presets: the six "Black & White with … Filter" and Infrared mixes; .cha files.
- **Selective Color**: presets and .asv files.
- **Gradient Map**: the full gradient field: click the bar to open the Gradient Editor, the arrow for the gradient
  presets; **Method** (the interpolation), **Reverse** and **Dither** (a little noise that hides banding).

#### Shadows/Highlights

The dialog shows the two amounts. **Show More Options** (remembered) adds, for Shadows and for Highlights, **Tone**
(which tones count as shadows or highlights) and **Radius** (the size of the neighbourhood each pixel is compared
with), and the **Adjustments**: **Color** (saturation of the corrected areas), **Midtone** (midtone contrast), **Black
Clip** and **White Clip** (how many percent of the pixels may become black or white). The first use starts from
Photoshop's settings (Shadows 35 %, Tone 50 %, Radius 30 px, Color +20, clips 0.01 %); later uses from the last ones.

#### HDR Toning

Presets (Flat, Monochromatic, Monochromatic High Contrast, Photorealistic, Photorealistic High Contrast, Saturated,
More Saturated, Surrealistic) and Save Preset. As before, a layered document is flattened first, after a question.

#### New adjustments

Image > Adjustments and Layer > New Adjustment Layer (and the Adjustments panel) have three more:

- **Color and Vibrance**: Temperature, Tint, Vibrance, Saturation (Camera Raw's Color panel as a layer).
- **Clarity and Dehaze**: Clarity adds or removes midtone contrast around edges; Dehaze removes (or, negative, adds)
  haze.
- **Grain**: Amount, Size, Roughness. The grain belongs to the image position: it stays put when you paint or zoom.

#### Adjustment layers in the Properties panel

Besides the editor: the preset menu, the eyedroppers and the on-image tool (they sample the image below the layer at
full resolution), Auto where the adjustment has one, and the toolbar's **View Previous State** button (also the `\`
key while the panel has focus): it shows the layer with the settings it had when you selected it, until you press it
again or change a setting. It adds nothing to the history.

#### Adjustments panel presets

At the top of the Adjustments panel, **Adjustment presets** in six groups (Portraits, Landscape, Photo Repair,
Creative, Black & White, Cinematic). A preset adds its adjustment layers above the active layer, in a group named after
the preset when there are several, each with a mask (the selection, if any). One undo removes them all.

#### Adjustment Brush tool

In the Brush tool group (Shift+B cycles to it). Choose the adjustment in the options bar and paint: the first stroke
adds an adjustment layer of that kind whose mask hides everything, and reveals the adjustment where you paint (the new
layer and the stroke are one undo step); the Properties panel opens to change its settings. While that layer is
selected, more strokes paint its mask. **Subtract** (or Alt while painting) hides the adjustment again.

### Gradients

#### Gradients everywhere

Every gradient in Pigment is one kind of thing: colour stops and opacity stops, each with a midpoint, a smoothness and an
interpolation method, or a noise gradient. The Gradient tool, Gradient Fill layers, shapes, Gradient Map, Gradient
Overlay and the Stroke effect all use the same gradient and the same editor.

**Interpolation methods** (the Method menu):

- **Perceptual** (new gradients): mixes colours in a perceptual colour space (Oklab), so the middle of a gradient looks
  as bright as you expect and red-to-green does not turn muddy.
- **Linear**: mixes light linearly (linear-light sRGB), like light from two lamps.
- **Classic**: Pigment 0.3's and older Photoshop's mixing of the sRGB numbers. Smoothness applies only here.
- **Smooth**: passes through every stop on a smooth curve (no visible kink at a stop, no overshoot).
- **Stripes**: no blending at all: each colour runs up to the midpoint of its segment, then the next one starts.

**Noise gradients** (Gradient Type: Noise in the Gradient Editor): random colour bands made from a seed. Roughness sets
how busy they are, the colour model (RGB, HSB, LAB) and the three channel ranges limit the colours, Restrict Colors
keeps them from getting oversaturated, Add Transparency varies the opacity too, and Randomize picks a new seed. The same
gradient always gives the same bands.

#### The gradient picker and presets

A gradient field shows the gradient as a bar with a small arrow next to it. Click the arrow to choose a preset from
the groups (Basics, Blues, Purples, Pinks, Reds, Oranges, Greens, Grays, Spectrums and Metals, Noise, and any groups
you make). Click the bar to open the Gradient Editor. "Foreground to Background" and the other presets that use the
foreground or background colour follow your colours in the Gradient tool; everywhere else they take the colours you have
at the moment you apply them.

#### Gradient Editor

- **Presets**: click one to start from it. Right-click a preset or a group for Rename, Duplicate and Delete.
- **Name** and **New**: add the gradient you are editing to the presets. **Save** stores it into the preset you
  started from (or adds it when there is none).
- **Import…** reads a presets file (`.pigment-presets`); **Export…** writes the selected preset, or all of them.
- **The ramp**: opacity stops above, colour stops below. Click under or over the ramp to add a stop, drag a stop to move
  it, drag it away from the ramp (or press Delete) to remove it. The small diamonds between the selected stop and its
  neighbours are the midpoints: drag them to move where the two colours meet half way.
- **Stops**: the selected stop's opacity, colour and location in percent. In the Gradient tool's editor a colour stop
  can also be the Foreground or Background colour.

#### Gradient Fill layers

Layer > New Fill Layer > Gradient… makes a Gradient Fill layer from the Gradient tool's gradient and opens the Gradient
Fill dialog, live on the canvas: the gradient (with its picker, editor and Method), Style, Angle, Scale, Offset,
Reverse and Dither. Double-click the layer's thumbnail or use Layer > Layer Content Options… to change it later. The
Properties panel shows the same controls for the active Gradient Fill layer.

#### Live gradients (Gradient tool, Gradient mode)

The Gradient tool has two modes in the options bar:

- **Classic**: paints the gradient into the pixels of the active layer, as before.
- **Gradient**: dragging makes a Gradient Fill layer above the active layer (inside the selection, if there is one).
  While that layer is active, the tool shows its gradient on the canvas: drag the round end points to change where
  it starts and ends, drag the line to move it, drag a square colour stop along the line, click the line to add a
  stop, drag a stop away from the line or press Delete to remove it, double-click a stop to change its colour. Dragging
  elsewhere draws that layer's gradient again. Every change is one step in History.

#### Gradients panel

Window > Gradients. Click a gradient to apply it to the active Gradient Fill layer (its placement stays), or, when no
Gradient Fill layer is active, to make it the Gradient tool's gradient. Double-click a gradient to rename it. Drag a
gradient onto the canvas or onto a row of the Layers panel to make a Gradient Fill layer there; drag it onto another
gradient or a group heading to reorder or regroup it. The buttons at the bottom add a group, add the current gradient
(of the active Gradient Fill layer, else of the Gradient tool) and delete the selected one; the menu has the thumbnail
size, Import, Export and Reset Gradients.

### Patterns

#### The pattern library

Pigment keeps a library of patterns, as Photoshop does. It starts with twelve built-in patterns in two groups (Basic:
Checkerboard, Diagonal Lines, Grid, Dots, Bricks, Weave; Textures: Noise, Clouds, Wood, Burlap, Water, Grass), and
holds every pattern you define or import. The library is kept with your presets, not in a document, so your patterns
are there in every document and after a restart.

One pattern is the **current pattern**: Edit › Fill › Pattern, the Paint Bucket (Fill: Pattern), the Pattern Stamp
tool and new Pattern Fill layers start from it. Click a pattern in the Patterns panel or in a picker to make it
current; a pattern you define becomes current at once.

A pattern used in a document (a Pattern Fill layer, a Pattern Overlay style, a fill) is copied into it. Deleting the
pattern from the library, or opening the document on another computer, changes nothing in the document.

#### Edit › Define Pattern…

Select a rectangle (or nothing, for the whole image) and choose Edit › Define Pattern…. The Pattern Name dialog shows
the tile and its size; give it a name and click OK. The pattern is made from what the document shows (all visible
layers), like Photoshop.

#### Patterns panel (Window › Patterns)

The panel shows the library in groups; click a group's heading to fold it.

- **Click** a pattern to make it the current pattern. When the active layer is a Pattern Fill layer, the click also
  puts the pattern in that layer (one undo step; its angle, scale and position stay).
- **Double-click** a pattern to rename it.
- **Drag** a pattern onto the canvas to make a Pattern Fill layer above the active layer, or onto a row of the Layers
  panel to make one above that layer. Drag it onto another pattern or onto a group heading to reorder or regroup it.
- **Right-click** a pattern to rename, duplicate or delete it; right-click a group heading to rename or delete the
  group.
- The footer buttons make a group, define a new pattern from the selection, and delete the selected pattern. The menu
  (⋯) has the three views (small and large thumbnails, list), Import Patterns…, Export Selected / All Patterns… and
  Reset Patterns….

**Import Patterns…** reads a `.pigment-presets` file of patterns, or pictures (PNG, JPEG, WebP, GIF, BMP): each picture
becomes a pattern. **Export** writes a `.pigment-presets` file with the patterns' pixels inside. **Reset Patterns…**
goes back to the built-in patterns and deletes the ones you added.

#### The pattern picker

Wherever Pigment asks for a pattern (the Fill dialog, the Pattern Fill dialog and Properties, the Paint Bucket's
options bar, Bitmap's Custom Pattern, the Pattern Overlay effect once the layer-style work lands) it shows a swatch
with a small arrow. Click either to open the picker; click a pattern to choose it. Below the patterns, **New from
Selection** defines a pattern from the current selection and **Import…** adds patterns from files.

#### Edit › Fill with a pattern

In Edit › Fill…, set Contents to **Pattern**. Choose the pattern under **Custom Pattern**. The tiles start at the
document's top-left corner, so two fills next to each other join without a seam.

Turn on **Scripted Patterns** and choose a script to place copies of the pattern instead of tiling it. After you click
OK, the script's own dialog asks for its options:

| Script | What it does | Options |
| --- | --- | --- |
| Brick Fill | Rows of copies, every other row shifted, like bricks | Pattern scale, Spacing, Offset between rows |
| Cross Weave | A grid of copies, every other one turned a quarter, like woven strips | Pattern scale, Spacing |
| Place Along Path | Copies along the chosen path (or the work path), turned to follow it | Pattern scale, Spacing, Alignment (along the path, alternate sides), Scale progression, Distance from path, Rotate angle, Adjust spacing to fit |
| Random Fill | Copies at random places, sizes and angles | Density, Minimum and Maximum scale, Rotate pattern |
| Spiral | Copies on a spiral from the middle of the area outwards | Pattern scale, Spacing, Starting angle, Scale progression, Rotate pattern |
| Symmetry Fill | The pattern repeated by a symmetry group | Symmetry type (translation, mirror, mirror both ways, glide reflection, 2-, 3-, 4- and 6-fold rotation, 4-fold rotation with mirrors), Pattern scale, Pattern translation X and Y, Pattern rotate angle |

Every script also has **Color randomness** (each copy's hue turned by up to half a turn) and **Brightness
randomness**. A recorded action replays a scripted fill exactly: the fill keeps the random choices it made.

#### Pattern Fill layers

Layer › New Fill Layer › Pattern… makes a Pattern Fill layer with the current pattern and opens the **Pattern Fill**
dialog, which shows its changes on the canvas:

- **Pattern**: the picker.
- **Angle**: turns the pattern (counter-clockwise for positive angles, as in Photoshop).
- **Scale**: 1 % to 1000 %.
- **Link with Layer**: on, the pattern starts at the layer's corner; off, at the document's origin. (A fill layer
  covers the document, so both start at the same place until the layer is moved; on shapes it decides whether the
  pattern travels with the shape.)
- **Drag in the document** while the dialog is open to move the pattern; **Snap to Origin** puts it back at the
  document's origin.

Cancel keeps the new layer with the current pattern, as Pigment's Gradient Fill does. Double-click the layer's fill
thumbnail or choose Layer › Layer Content Options… to open the dialog again. The Properties panel shows the same
settings for the active Pattern Fill layer (pattern, Angle, Scale, Link with Layer, Snap to Origin); each change there
is one undo step.

#### View › Pattern Preview

View › Pattern Preview shows the document repeated all around itself in the window, so you can paint a tile that
repeats without seams: a stroke that runs off one edge shows up on the far side. It only changes the view; the
document keeps its size and pixels. Choose it again to turn it off (it is off whenever Pigment starts).

#### Paint Bucket

With **Fill: Pattern** in the options bar, the Paint Bucket fills with the pattern chosen in the options bar's picker
(or the current pattern while none is chosen). The tiles start at the document's origin.

#### Image › Mode › Bitmap: Custom Pattern

With **Use: Custom Pattern**, set **Custom pattern** to **From the pattern library** and choose a pattern in the
picker. Its greys are the thresholds: where the image is lighter than the pattern, the result is white. The seven
threshold tiles of 0.3 (fine dither, lines, crosshatch, dots, bricks, noise) are still in the list.

### Guides, rulers and snapping

#### Making guides

- **Drag from a ruler** onto the canvas. The top ruler gives a horizontal guide, the left ruler a vertical one; hold
  **Alt** while dragging for the other orientation, and **Shift** to put the guide on a ruler tick. Released over the
  ruler, nothing is made. While snapping is on, the guide snaps to layer edges, the document, the grid and the other
  guides as you drag.
- **View › Guides › New Guide…** asks for the position, the orientation and the colour. The position is in the ruler
  units and counts from the ruler origin; type a unit to use another one (`120 px`, `2.5 cm`, `1 in`, `50%`). Typing
  `h` in front (`h40`) makes a horizontal guide whatever the orientation buttons say. The colour is the preference
  colour (Default), one of Photoshop's guide colours, or a custom colour.
- **View › Guides › New Guide Layout…** makes columns and rows: number, width (empty: the columns share the width)
  and gutter for each, margins, Center Columns, and Clear Existing Guides. The guides show on the canvas while the
  dialog is open; OK adds them as one step.
- **View › Guides › New Guides From Shape** puts guides on the left, centre and right and on the top, middle and bottom
  of the active shape layer (or of a layer's vector mask).

Making a guide shows the guides if they were hidden. Guides are saved in the document (a `.pigment` file keeps their
colours; Pigment 0.3 opens such a file with plain guides), move with Image Size, Canvas Size, Rotate, Flip and Crop, and
every change is one step in the history.

#### Selecting, moving and deleting guides (Move tool)

- **Click** a guide to select it; **Shift-click** adds a guide to the selection or takes it out. Selected guides are
  drawn wider. A click elsewhere on the canvas drops the selection.
- **Drag** a guide to move it; the other selected guides of the same orientation move with it. The guide snaps to
  what is around it (not to the guides moving with it).
- **Drag a guide off the canvas** (onto a ruler, or past the edge of the window) to delete it.
- **Delete** (or Backspace) deletes the selected guides instead of pixels or the layer.
- **View › Guides › Edit Selected Guides…** changes the colour of the selected guides, and the position and
  orientation when one guide is selected.
- **View › Guides › Clear Selected Guides** deletes the selected guides; **Clear Canvas Guides** deletes all of them.
- **View › Guides › Lock Guides** (Alt+Ctrl+;) stops the Move tool from picking guides; new guides can still be made.
  Hidden guides cannot be picked either.

#### Rulers

View › Rulers (Ctrl+R) shows the rulers.

- **Units:** right-click a ruler for its menu (Pixels, Inches, Centimeters, Millimeters, Points, Percent). The units are
  also in Preferences › Interface. Inches, centimetres, millimetres and points use the document resolution.
- **Origin:** drag from the square where the rulers meet to the point that should read 0 on both rulers. It snaps
  like a guide (hold Shift to put it on a whole pixel). Double-click the square to put the origin back on the document
  corner. The origin is saved with the document and is one step in the history.
- The Info panel, the Properties panel's X and Y, the Free Transform options bar, the New Guide dialog and the grid
  all count from the same origin.

#### Grid (View › Show › Grid, Ctrl+')

Preferences › Guides, Grid & Slices sets the grid colour, the style (lines, dashed lines, dots), Gridline Every with its
unit (pixels, inches, centimetres, millimetres, points or percent) and Subdivisions (fainter lines inside each cell).
The grid starts at the ruler origin. The same section sets the guide colour and style (lines or dashed lines) and the
Smart Guides colour.

#### Snapping

View › Snap (Shift+Ctrl+;) turns snapping on and off; **View › Snap To** chooses what is snapped to: Guides, Grid,
Layers, Document Bounds, Artboards and Slices (the last two have nothing to snap to until artboards and slices arrive),
with All and None. Guides and the grid snap only while they are shown, as in Photoshop.

Snapping works for the Move tool, the marquees, the Crop and Perspective Crop tools, the shape tools, the Pen, the Path
and Direct Selection tools, Free Transform, the type box, the gradient tool, guides and the ruler origin. A moved
layer or box snaps by its edges and its centre; a dragged point snaps itself. The reach is 6 screen pixels at every
zoom; when two targets are equally near, a guide wins, then the document bounds, then layers, then the grid. The Move
tool snaps the visible content of the layer, not its whole canvas. **Hold Ctrl (Cmd on macOS) while dragging** to
place something without snapping.

#### Smart Guides (View › Show › Smart Guides)

While you move a layer (Move tool, Free Transform), magenta lines show the edges and centres it lines up with, among
the other layers and the canvas. When the layer sits as far from a neighbour as two other layers sit from each other
(or halfway between two layers), it snaps there and the equal gaps are marked with their size.

**Ctrl-hover:** with the Move tool, hold Ctrl (Cmd) and point at another layer to see the distances between it and the
active layer; point at an empty part of the canvas to see the distances to the canvas edges. The values are in the
ruler units.

### Vector masks, mask density and feather

#### Two kinds of mask

A layer can have a **layer mask** (pixels: paint black to hide, white to show) and a **vector mask** (a path: the layer
shows inside the path's shapes), or both. With both, the layer shows only where both let it show. In the Layers panel
the vector mask's thumbnail sits after the layer mask's, each with its link icon.

#### Vector masks

**Layer › Vector Mask:**

- **Reveal All** adds a vector mask that shows the whole layer. Shapes you then draw into it with **Subtract Front
  Shape**, **Intersect** or **Exclude** cut the layer away (a plain combined shape adds nothing to a mask that already
  shows everything).
- **Hide All** adds a vector mask that hides the whole layer; shapes you draw into it show the layer inside them.
- **Current Path** adds a vector mask from the path selected in the Paths panel (else the work path, else the active
  shape layer's path): the layer shows inside the path.
- **Delete**, **Disable / Enable**, **Link / Unlink** (an unlinked vector mask stays in place when the layer moves).
- **Layer › Rasterize › Vector Mask** turns the vector mask into pixels of the layer mask (combined with the layer mask
  if there is one) and removes the vector mask. The layer looks the same afterwards.

A layer has at most one vector mask: the commands that add one tell you when the layer already has it.

**Editing the path.** Click the vector mask thumbnail in the Layers panel, or its row in the Paths panel ("<layer>
Vector Mask"): the vector mask becomes the path the path tools work on. Move or reshape its components with the Path
Selection and Direct Selection tools, add components with the Pen or a shape tool in Path mode, and use the path
operations (Combine, Subtract, Intersect, Exclude) as for any path. Every edit is one step in the History.

In the Layers panel: **Shift-click** the vector mask thumbnail to disable or enable it, **Ctrl/Cmd-click** it to load the
path as a selection, click the link icon to link or unlink it. In the Paths panel the vector mask row has its own menu
(right-click): Save Path…, Delete Vector Mask, Disable / Enable, Rasterize, and the path commands. Double-click the row
to edit the path with the Direct Selection tool. Delete Path (the trash button) deletes the vector mask when its row is
selected.

**From a path.** With the Path Selection or Direct Selection tool, the options bar has **Mask** (the current path
becomes the active layer's vector mask) and **Shape** (the current path becomes a new shape layer filled with the
foreground colour), after Selection, Fill and Stroke. The Paths panel's footer has an "Add vector mask from the path"
button, and each path's menu has Make Vector Mask and Make Shape Layer.

#### Density and feather

Select a layer with a mask and open the Properties panel. Each mask has two sliders:

- **Density** (0–100 %): how strongly the mask hides. At 50 % the hidden parts show the layer at half strength; at 0 %
  the mask does nothing.
- **Feather** (0–1000 px): softens the mask's edges, as a Gaussian blur of the mask.

Both are non-destructive: the mask's pixels and the vector mask's path do not change, and you can go back to 100 % and
0 px at any time. A slider drag is one step in the History. What the layer shows on screen, in a 16- or 32-bit
document, when you merge, flatten, rasterize, export or apply the mask always includes them.

**Apply** (Layer Mask) applies the layer mask, with its density and feather, to the layer's pixels; the vector mask
stays on the layer as it is.

#### The Masks section of the Properties panel

- **Layer Mask:** the thumbnail (click to paint on the mask or the layer), Density, Feather, **Select and Mask…** (refine
  the mask's edges; the result goes back into the layer mask), **Color Range…** (the colour range you pick replaces the
  mask), **Invert**, and Edit Mask / Select / Disable / Link / Apply / Delete. Without a layer mask: Add Mask and From
  Transparency.
- **Vector Mask:** the thumbnail (click to edit the path), Density, Feather, Edit Path, Select, Disable / Enable, Link /
  Unlink, Rasterize, Delete. Without a vector mask: Add Vector Mask (Reveal All) and From Path.
- **Show Overlay / Hide Overlay** and **Overlay Options…**

The controls are disabled where the layer cannot take the change (the Background layer's masks, once its rules are in
force).

#### Seeing the mask

- **Mask alone:** Alt-click the layer mask thumbnail in the Layers panel to see the mask in grey levels (with its density
  and feather) instead of the image; Alt-click again or press Esc to go back.
- **Overlay:** press **\\** (or Show Overlay in Properties) to see what the mask hides as a coloured overlay over the
  image: the layer mask if the layer has one, else the vector mask. Press \\ again to hide it.
- **Overlay Options…** (Properties) sets the overlay's colour and opacity (red at 50 % by default). The same two
  settings are in **Preferences › Masks**.

#### Files

`.pigment` files keep vector masks, density and feather. PSD files get one layer mask per layer with the density,
feather and vector mask baked in, so Photoshop shows what Pigment shows (a layer with only a vector mask gets a layer
mask); Photoshop does not receive them as a live vector mask or as live density and feather yet (planned with the PSD
layer work of 0.5).

### Live shapes

#### Shape tools

The shape tools are in one toolbox slot (key U; Shift+U steps through them): **Rectangle**, **Rounded Rectangle**,
**Ellipse**, **Triangle** (new), **Polygon**, **Line** and **Custom Shape**.

- **Drag** to draw. Shift keeps the proportions (a square, a circle, a custom shape's own proportions), Alt draws from
  the centre. The Line tool's Shift constrains to 45°.
- **Click** the canvas without dragging to open the **Create** dialog of the shape. It asks for the width and height,
  plus the shape's own values:
  - Rectangle: the four corner radii, linked or not.
  - Triangle: Equilateral and the corner radius.
  - Polygon: Symmetric, the number of sides, the corner radius, the star ratio and the smoothing.
  - Every shape: From Centre.

  The values you enter become the tool's options.
- The options bar shows **Fill** and **Stroke** swatches, the stroke width, the **Stroke Options** menu and the shape's
  own fields: Radius for the Rectangle, Rounded Rectangle and Triangle; Sides and Radius for the Polygon; Weight for the
  Line; the shape for the Custom Shape.
- The **gear** button opens the geometry options:
  - **Path Options**: the thickness and colour that paths are drawn with while you edit them.
  - **Constraints**: Unconstrained, Square (Circle), Fixed Size W × H, Proportional W : H, and From Center. The Custom
    Shape tool also has Defined Proportions and Defined Size.
  - Polygon: **Star ratio** (100 % is a plain polygon), **Smooth Star Indents** and **Smooth Corners**.
  - Line: **Arrowheads** at the start and/or end, with their **Width**, **Length** and **Concavity** in percent of the
    line weight.

Changing the fill or stroke in the options bar while a shape layer is selected restyles that layer. It is one step in
the History.

#### Fill and stroke

Click the Fill or Stroke swatch (in the options bar or the Properties panel) to open its menu:

- **No Color**: no fill / no stroke (a red slash on the swatch).
- **Solid Color**: the Color Picker, your recently used colours, and the swatches.
- **Gradient**: the gradient presets, and a gradient bar that opens the Gradient Editor. Under the bar are Style,
  Angle, Scale, Reverse, Dither and Align with Layer. A shape's gradient is placed on the shape: it moves with the
  shape and stays put when the stroke gets wider.
- **Pattern**: the pattern presets, Scale and Angle. The pattern moves with the shape.

**Stroke Options** (the dashed-line button): the stroke presets (Solid, Dashed, Dotted and your own), **Align**
(Inside, Center, Outside), **Caps** (Butt, Round, Square) and **Corners** (Miter, Round, Bevel).

- **More Options…** opens the Stroke dialog, with up to three dash and gap lengths in stroke widths.
- **Save Preset…** names the current stroke style and adds it to the presets.

#### Live Shape Properties

Select a shape layer and open Properties (Window › Properties). A live shape shows its own **W**, **H**, **X**, **Y** and
**Angle** instead of the Transform section. The link button keeps the width and height in proportion. X and Y count from
the ruler origin. The shape's own values follow:

- **Rectangle**: the four corner radii. With the link button on, every corner takes the value you type; with it off,
  only the corner you type in changes.
- **Triangle**: the corner radius.
- **Polygon**: Sides, the corner radius, the star ratio, Smooth corners and Smooth star indents.
- **Line**: the end points X1, Y1, X2, Y2, the Weight, and the arrowheads (Start, End) with their Width, Length and
  Concavity.
- **Custom Shape**: which shape.

Under them, **Appearance** has the Fill and Stroke swatches, the stroke width, Stroke Options, **Copy Attributes** and
**Paste Attributes**. Every change is one step in the History. A shape that is no longer live (its anchor points were
edited, or it was skewed) shows only Appearance and the Transform section.

#### Corner widgets

With a shape tool or the Path Selection tool, a live rectangle shows a small circle inside each corner:

- Drag a circle to round **every** corner.
- **Alt**-drag a circle to round only that corner.

A triangle has a circle in each corner, and a polygon one in its top corner; dragging either sets the shape's corner
radius.

#### Shapes stay live

Moving a shape (Move tool, Path Selection tool, arrow keys, Align and Distribute), Free Transform rotations and
scaling, Image Size, Canvas Size, Crop and Rotate Canvas keep a shape live. A rotation becomes the shape's Angle, and
a scale becomes its size and radii. A skew, a distortion or a perspective change turns the shape into a plain path.
So does a mirror of a custom shape. So does editing anchor points with the Direct Selection, Pen or Convert Point tools,
or combining shapes with a path operation (as in Photoshop).

#### Copy / Paste Shape Attributes

**Copy Shape Attributes** remembers the fill and the whole stroke (paint, width, alignment, caps, corners and dashes) of
the active shape layer. **Paste Shape Attributes** applies them to every selected shape layer, as one step in the
History. Use the Copy Attributes / Paste Attributes buttons in Properties, or the commands `layer:copy-shape-attributes`
and `layer:paste-shape-attributes`.

### The Layers panel

#### Opacity, Fill, blend mode and locks

The **Opacity** and **Fill** fields act on every selected layer. Drag the word **Opacity** or **Fill** left or right
to change the value (Shift: ten times faster, Alt: ten times slower); the canvas follows as you drag and the whole drag
is one step in History. The arrow keys in the field step by 1 % (Shift: 10 %), and the small ▾ button opens a slider.
A typed value (arithmetic such as `50+25` works) is applied with Enter or Tab.

The **blend-mode menu** shows each mode on the canvas while the pointer rests on it, before you choose it; moving off
the list shows the layers as they were. Click a mode (or press Enter) to apply it to every selected layer; Escape closes
the list without a change. With the menu button focused and the list closed, **↑** and **↓** step to the previous or
next mode at once. Groups list **Pass Through** first.

The four **lock** buttons lock or unlock every selected layer; when only some of them have a lock, its button shows a
line under it.

The Background layer's opacity, fill and blend mode cannot change (Layer › New › Layer from Background makes it an
ordinary layer): their controls are disabled while it is selected.

#### Footer buttons

- **New Layer**: Alt-click opens the New Layer dialog; Ctrl/Cmd-click adds the layer below the current one.
- **New Group**: Alt-click opens the New Group dialog.
- **Add Mask**: adds a layer mask that reveals all (or the selection); Alt-click adds one that hides all (or the
  selection). Clicked on a layer that already has a layer mask, it adds a vector mask (Alt: one that hides all).
- Drop layer rows on **New Layer** to duplicate them, on **Delete** to delete them. Drop an effect row on **Delete** to
  delete that effect, or the **Effects** row to delete all of the layer's effects.

#### Dragging rows

Dragging a selected row drags every selected layer; they keep their order. Hold **Alt** when you drop to copy them
instead. Drop on the upper or lower half of a row to place the layers above or below it; drop on the middle of a closed
group, or the lower part of an open group's row, to put them inside it. The drop line does not appear where the layers
cannot go: under the Background, into themselves.

#### The eye column

Click an eye to show or hide that layer. Press on an eye and drag down (or up) the column: every layer you pass over
takes the state of the first one, at once on the canvas, and the whole drag is one step in History. Alt-click an eye
to show only that layer (Alt-click it again to bring the others back). Right-click an eye for the colour labels.

#### Clipping masks

Hold **Alt** and click the line between two layers to clip the upper layer to the lower one; the pointer changes over
the line. Alt-click the line again to release it.

#### Groups

Click a group's triangle to open or close it. **Alt**-click opens or closes the group and every group inside it;
**Ctrl/Cmd**-click opens or closes every group of the document. **Collapse All Groups** in the panel menu closes them
all. Groups show their layer mask and vector mask like any layer, and Pass Through in the blend-mode menu.

#### Effects under the layer

A layer with layer effects shows **fx** and a small triangle in its row. Under it the panel lists **Effects** and each
effect (in the Layer Style dialog's order); the triangle hides or shows that list. Groups list their effects the same
way, above their layers.

- The eye of an effect switches that effect off or on; its row stays. The eye of **Effects** hides or shows all of them
  (Layer › Layer Style › Hide All Effects).
- Double-click an effect to open the Layer Style dialog on it.
- Drag an effect onto another layer to move it there; hold **Alt** to copy it. Drag **Effects** to move or copy all of
  them (they replace the target's effects). Drop them on **Delete** to delete them. The Background and adjustment
  layers take no effects.
- Right-click an effect for Edit, Hide or Show, Delete, Blending Options, Hide All Effects, Copy, Paste and Clear Layer
  Style, Create Layers and Scale Effects.

#### The panel menu and Panel Options

The **☰** button at the top right of the panel opens the panel menu: New Layer…, Duplicate Layer…, Delete Layer,
Delete Hidden Layers, Quick Export as PNG, Export As…, New Group…, New Group from Layers…, Collapse All Groups, Lock
Layers…, Lock All Layers in Group…, Convert to Smart Object, Edit Contents, Blending Options…, Edit Adjustment… (or Edit
Fill…), Create or Release Clipping Mask, Link Layers, Select Linked Layers, Merge Down / Merge Layers / Merge Group,
Merge Visible, Flatten Image and Panel Options….

**Panel Options…**:

- **Thumbnail Size**: None, Small, Medium (the size of earlier versions) or Large.
- **Thumbnail Contents**: **Layer Bounds** shows the layer's own pixels as large as the thumbnail allows; **Entire
  Document** shows them where they sit on the canvas (earlier versions always did this).
- **Show effects under the layers** and **Expand new effects** (whether a layer's effects list starts open).
- **Add “copy” to copied layers and groups**.

#### Find Layers and Isolate Layers

The filter bar (Select › Find Layers) has a new **Selected** type (only the selected layers) and new attributes: **Not
locked**, **Vector mask** and **Advanced blending** (layers whose Blending Options are not the defaults).

While layers are isolated (Select › Isolate Layers), the Eyedropper, Color Sampler, Magic Wand, Quick Selection,
Object Selection, Paint Bucket, the retouch tools' Sample All Layers and the Info panel read only what the canvas shows,
and the Move tool's auto-select never picks a layer the isolation hides.

### The Layer menu

#### New Layer, New Group, Duplicate Layer

**Layer › New › Layer…** (Shift+Ctrl+N) opens the **New Layer** dialog:

- **Name**.
- **Use Previous Layer to Create Clipping Mask**: the new layer is clipped to the layer below it.
- **Color**: the colour label of its row in the Layers panel.
- **Mode** and **Opacity**.
- **Fill with … -neutral color**: for modes that have one, the layer is filled with the colour that changes nothing in
  that mode (white for Multiply, Color Burn, Linear Burn, Darken, Darker Color and Divide; black for Screen, Color Dodge,
  Linear Dodge, Lighten, Lighter Color, Difference, Exclusion and Subtract; 50 % grey for Overlay, Soft Light, Hard
  Light, Vivid Light, Linear Light and Pin Light). Filters such as Add Noise or Lens Flare then work on a layer of its
  own that you can fade with its opacity.

**Alt+Shift+Ctrl+N** makes a new layer without the dialog.

**Layer › New › Group…** asks for the group's name, colour, mode (Pass Through by default) and opacity.

**Layer › Duplicate Layer…** asks for the copy's name (**As**, with one layer selected) and its **Destination**: this
document, another open document (the copies go on top of its stack, and Undo there takes them back out), or **New**:
a new document of the same size that holds only the copies, under the name you give it. With several layers selected
all of them are duplicated together.

The dialogs open from the menu and from the keys. Code, actions and the Layers panel's buttons make the layer without
asking; an action that recorded a dialog replays what you chose in it.

**Layer › New Fill Layer** asks the New Layer questions first (name, clipping, colour, mode, opacity), then for the
colour, gradient or pattern.

#### Changing several layers at once

Opacity, Fill, the blend mode, the locks and **Layer › Hide / Show Layers** (**Ctrl+,**) act on every selected layer,
as one step in the History. Hide / Show gives all of them the opposite of the active layer's state. Dragging an
opacity slider or scrubbing its label is one step, however many layers are selected.

#### Keys

- **1 … 9** set the opacity of the selected layers to 10 % … 90 %, **0** to 100 %. Two digits typed quickly set the
  exact value: 4 then 5 is 45 %, 0 then 5 is 5 %, 0 then 0 is 0 %. **Shift** with the digits sets Fill instead. While a
  painting tool (brush, pencil, eraser, stamps, gradient, bucket, dodge, burn, sponge, blur, sharpen, smudge) is
  active the digits leave the layer alone: those tools will use them for their own opacity.
- **/** locks or unlocks the transparent pixels of the selected layers.
- **Shift+Alt+letter** sets the blend mode of the selected layers, with Photoshop's letters: N Normal, I Dissolve,
  K Darken, M Multiply, B Color Burn, A Linear Burn, G Lighten, S Screen, D Color Dodge, W Linear Dodge, O Overlay,
  F Soft Light, H Hard Light, V Vivid Light, J Linear Light, Z Pin Light, L Hard Mix, E Difference, X Exclusion, U Hue,
  T Saturation, C Color, Y Luminosity, P Pass Through (groups). **Shift+=** and **Shift+-** step to the next and the
  previous mode.
- **Alt+]** and **Alt+[** select the layer above and below (going round at the top and the bottom), **Alt+.** the top
  layer, **Alt+,** the bottom layer. **Shift+Alt+]** and **Shift+Alt+[** add the layer above or below to the
  selection. Layers inside a collapsed group are skipped, as in the panel.
- None of these keys act while you type in a text field.

#### Arrange and Distribute

**Layer › Arrange** works on every selected layer: Bring to Front, Bring Forward, Send Backward and Send to Back move
them together and keep their order. **Reverse** turns the order of the selected layers round.

**Layer › Distribute** needs three or more selected layers. **Top Edges, Vertical Centers, Bottom Edges, Left Edges,
Horizontal Centers, Right Edges** spread that edge or centre evenly between the two outermost layers;
**Horizontally** and **Vertically** make the gaps between the layers equal.

**Linked layers** (Layer › Link Layers) move along when Align or Distribute moves one of their set, as they do with the
Move tool and Free Transform. Layers locked in position, and the Background, are not moved.

#### Locks

**Layer › Lock Layers…** (Ctrl+/) sets the locks of the selected layers: Transparency, Image, Position, All. **Lock All
Layers in Group…** sets them on every layer inside the selected group.

#### Merging and stamping

**Ctrl+E** does what the Layer menu item says: **Merge Down** with one layer selected, **Merge Layers** with several,
**Merge Group** with a group selected (the group becomes one layer with its name; its mode and opacity stay, its mask
and effects are rendered in, hidden layers inside it are dropped). An action records the merge that happened.

**Alt+Shift+Ctrl+E** (**Stamp Visible**) puts everything visible, merged, on a new layer above the active one.
**Alt+Ctrl+E** (**Stamp Layers**) merges a copy of the selected layers onto a new layer ("… (merged)"); with one layer
selected it merges a copy of it into the pixel layer below. The layers that were read stay as they were.

#### Rasterize

**Layer › Rasterize › Type, Shape, Fill Content** rasterize the selected layers of that kind; **Layer** rasterizes every
selected layer that is not made of pixels yet. The layer mask, the vector mask (Fill Content keeps it), the locks, the
colour label and the link stay.

#### Select › Similar Layers

Selects every layer of the same kind as the active one: pixel layers, type, shapes, fill layers, adjustment layers,
smart objects or groups.

#### The Background layer

The bottom layer of a new document, named "Background", follows Photoshop's rules:

- it stays at the bottom of the stack: it cannot be moved up or into a group, and nothing can be put below it (Send to
  Back stops right above it);
- its opacity, Fill, blend mode, masks, vector mask, effects and position are locked; adding a layer mask turns it into
  an ordinary layer ("Layer 0") first, in the same step;
- **Layer › New › Layer from Background…**, or renaming it, makes it an ordinary layer again;
- merging layers into it (Merge Down onto it, Merge Layers with it selected) keeps it the Background.

### Photoshop conventions: Search, temporary tools, numeric fields, dialogs

#### Edit > Toggle Last State (Alt+Ctrl+Z)

Undoes the last step. Pressed again right away, it redoes that step, so repeated presses flip between the last two
states to compare them (Photoshop's Alt+Ctrl+Z). After any other change it undoes that change first. In a text field it
undoes typing; in Select and Mask it is that workspace's own undo. It is never recorded into an action.

#### Edit > Search… (Ctrl+F)

Opens a search box over the menus, the tools and the panels. Type a few letters of a command, a menu or a tool
("gaus blur", "adjust lev", "brush tool", "layers panel"); each result shows its menu path and shortcut, and results
that cannot run right now are dimmed. Up and Down move through the results, Enter or a click runs the selected one
(the search box closes first), Esc closes it. With nothing typed, the last ten choices are listed. A command run from
Search is recorded into an action like the menu item itself; Search is not.

#### Numeric fields everywhere

Every number field of the app (dialogs, panels, the options bar) takes:

- **Arithmetic**: `100+50`, `200/4`, `3*12`, `(10+5)*2`. Type an operator after the number; Enter, Tab or clicking
  elsewhere works it out. Esc while typing an expression puts back what the field had.
- **Percentages**: `50%` is half of what the field had (or, in fields that say so, half of a reference such as the
  document size). In a field measured in % it is just 50.
- **Units**: in a field measured in pixels, `2in`, `5cm`, `30mm`, `72pt` are converted at the document's resolution
  (`2in` at 300 ppi is 600 px), and the other way round in fields measured in a length unit. Mixed entries such as
  `1in+10px` work.
- **Arrow keys**: Up and Down change the value by one step, with Shift by ten steps.
- **The mouse wheel** over the field being edited changes it by one step (Shift: ten).
- **Scrubby labels**: drag a field's label left or right to change the value (Shift: ten times faster, Alt: ten times
  finer). The cursor shows a double arrow over labels that scrub.
- An entry that is not valid leaves the field as it was.

Some fields also have a small ▾ button that shows a slider under the field.

#### Temporary and spring-loaded tools

- **Space**: the Hand tool while held (as before). **Ctrl+Space**: the Zoom tool zooming in; **Alt+Space**: zooming
  out (Cmd+Space and Option+Space on macOS).
- **Ctrl** (Cmd) held: the Move tool, with any tool that does not use Ctrl itself (the type, pen, path and shape tools
  keep Ctrl for their own use; the Hand, Zoom and Rotate View tools keep theirs).
- **Alt** (Option) held with the Brush, Pencil, Color Replacement or Gradient tool: the Eyedropper, which picks the
  foreground colour. Tools that use Alt themselves (Clone Stamp and Healing Brush set their source, Dodge and Burn swap,
  the selection tools subtract) keep it.
- **Hold a tool's key** (for example V while painting): the tool is active while the key is held, and the previous tool
  comes back when you let go. A short press switches tools as before. Turn this off in Preferences > Tools and
  shortcuts > Spring-loaded tools (Ctrl and Alt then do not spring either).

#### Tool switching

- A tool key picks the tool last used in its toolbox slot; Shift+key steps through the slot's tools.
- Preferences > Tools and shortcuts > **Use Shift key for tool switch**: when off, pressing the same key again steps
  through the slot's tools, as in Photoshop with that preference off.
- Alt-click on a toolbox button steps through its tools; a long press or a right-click shows them all (the flyout),
  with the slot's key.

#### Dialogs

- **Move a dialog** by dragging its title bar. It opens there again next time (each dialog remembers its own place);
  double-click the title bar to put it back in the middle. Preferences > Tools and shortcuts > "Open moved dialogs in
  the middle again" forgets all the places.
- **The canvas stays visible** under a dialog (it is no longer dimmed) and can be navigated while the dialog is open:
  the mouse wheel over the canvas zooms or scrolls it, Space-drag pans it, and the zoom shortcuts (Ctrl+=, Ctrl+-,
  Ctrl+0, Ctrl+1) work, also from the View menu.
- A click on the canvas beside a dialog no longer cancels it (Photoshop's behaviour; the dialog shakes to show it is
  still open). Without an open document a click outside still closes the dialog.
- **Alt turns Cancel into Reset**: hold Alt and the Cancel button reads Reset; clicking it puts every setting back to
  what it was when the dialog opened, and the dialog stays open.

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
