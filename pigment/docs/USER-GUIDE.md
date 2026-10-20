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
- **Print**: File › Print (Ctrl+P) opens a dialog with the printer, copies, paper size (A4, Letter,
  Legal, A3, A5, Tabloid or custom millimetres), orientation, margins, scale (fit to page, 100 % or a
  percentage) and position, with a preview of the page. Save as PDF writes the same page to a file.

Each open image has a tab. Ctrl+Tab / Ctrl+Shift+Tab switch between them.

## The workspace

- **Toolbox** (left): click a tool, or press its letter (V move, M marquee, L lasso, W wand,
  C crop, I eyedropper, J healing, B brush, S clone, Y history brush, E eraser, G gradient/bucket,
  O dodge/burn, P pen, T type, A path selection, U shapes, H hand, R rotate view, Z zoom).
  Tools that share a slot have a small triangle: right-click or long-press to pick one, or press
  Shift + the letter to cycle through them.
- **Options bar** (top): settings of the current tool.
- **Panels** (right): Color, Swatches, Brushes · Properties, Adjustments, Character, Paths ·
  Layers, Channels, History, Navigator, Info, AI Assistant. Window menu shows any panel; Tab hides
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
- Free Transform, Warp and the other transforms work on smart objects without rasterizing them.

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
  dragging a point makes it Custom. Enter applies, Escape cancels. Text and shape layers are
  rasterized first.
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
| Camera Raw filter | Ctrl+Shift+A |
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
- **Very large images are slow**: Pigment keeps every layer in memory at 8 bits per channel; a
  10,000 × 10,000 layer takes 400 MB. Lower the history memory in Preferences, flatten finished
  parts, or work at a smaller size.
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
