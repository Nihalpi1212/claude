# Pigment 0.4: gradients

Package 9 of the 0.4 round: the gradient model completed (five interpolation methods, noise gradients), the per-pixel
renderer, the `gradient` field widget with its preset picker, the Gradient Editor, New Fill Layer > Gradient, the
Properties fill section, live gradients of the Gradient tool, the Gradients panel and its drags.

## User guide

### Gradients everywhere

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

### The gradient picker and presets

A gradient field shows the gradient as a bar with a small arrow next to it. Click the arrow to choose a preset from
the groups (Basics, Blues, Purples, Pinks, Reds, Oranges, Greens, Grays, Spectrums and Metals, Noise, and any groups
you make). Click the bar to open the Gradient Editor. "Foreground to Background" and the other presets that use the
foreground or background colour follow your colours in the Gradient tool; everywhere else they take the colours you have
at the moment you apply them.

### Gradient Editor

- **Presets**: click one to start from it. Right-click a preset or a group for Rename, Duplicate and Delete.
- **Name** and **New**: add the gradient you are editing to the presets. **Save** stores it into the preset you
  started from (or adds it when there is none).
- **Import…** reads a presets file (`.pigment-presets`); **Export…** writes the selected preset, or all of them.
- **The ramp**: opacity stops above, colour stops below. Click under or over the ramp to add a stop, drag a stop to move
  it, drag it away from the ramp (or press Delete) to remove it. The small diamonds between the selected stop and its
  neighbours are the midpoints: drag them to move where the two colours meet half way.
- **Stops**: the selected stop's opacity, colour and location in percent. In the Gradient tool's editor a colour stop
  can also be the Foreground or Background colour.

### Gradient Fill layers

Layer > New Fill Layer > Gradient… makes a Gradient Fill layer from the Gradient tool's gradient and opens the Gradient
Fill dialog, live on the canvas: the gradient (with its picker, editor and Method), Style, Angle, Scale, Offset,
Reverse and Dither. Double-click the layer's thumbnail or use Layer > Layer Content Options… to change it later. The
Properties panel shows the same controls for the active Gradient Fill layer.

### Live gradients (Gradient tool, Gradient mode)

The Gradient tool has two modes in the options bar:

- **Classic**: paints the gradient into the pixels of the active layer, as before.
- **Gradient**: dragging makes a Gradient Fill layer above the active layer (inside the selection, if there is one).
  While that layer is active, the tool shows its gradient on the canvas: drag the round end points to change where
  it starts and ends, drag the line to move it, drag a square colour stop along the line, click the line to add a
  stop, drag a stop away from the line or press Delete to remove it, double-click a stop to change its colour. Dragging
  elsewhere draws that layer's gradient again. Every change is one step in History.

### Gradients panel

Window > Gradients. Click a gradient to apply it to the active Gradient Fill layer (its placement stays), or, when no
Gradient Fill layer is active, to make it the Gradient tool's gradient. Double-click a gradient to rename it. Drag a
gradient onto the canvas or onto a row of the Layers panel to make a Gradient Fill layer there; drag it onto another
gradient or a group heading to reorder or regroup it. The buttons at the bottom add a group, add the current gradient
(of the active Gradient Fill layer, else of the Gradient tool) and delete the selected one; the menu has the thumbnail
size, Import, Export and Reset Gradients.

## Release notes

- New: the five interpolation methods (Perceptual, Linear, Classic, Smooth, Stripes) and noise gradients, for every
  gradient (tool, fill layers, shapes, Gradient Map, Gradient Overlay, Stroke).
- New: the Gradient Editor (stops, midpoints, smoothness, presets with New, Save, Import and Export), the gradient
  picker with preset groups, the Gradients panel (Window > Gradients), live gradients (the Gradient tool's Gradient
  mode), and Gradient Fill layers with Method, Dither, Offset and the Properties fill section.
- Changed: the Gradient tool's options bar shows the gradient as a bar with a picker instead of a menu of eight names;
  its 0.3 choice is kept (the preset it named). The Gradient tool's default mode is **Classic**, Pigment 0.3's
  behaviour (Photoshop's default is Gradient).
- Changed: Gradient Fill layers made in 0.4 store the full gradient (midpoints, opacity stops, method). New Fill Layer >
  Gradient starts from the Gradient tool's gradient and style (0.3: foreground to background, linear).
- Changed: 0.3's eight gradient presets are in the Basics and "Spectrums and Metals" groups, next to new built-ins.
- Unchanged: 0.3 documents and 0.3-style gradients (classic, no dither) render exactly as before.
- Gradients made in 0.4 with a method other than Classic, with Dither, or noise, are drawn pixel by pixel: a Gradient
  Fill layer of 2000 × 1500 takes about 0.1 s to draw when it changes (it is cached afterwards); while you drag its
  on-canvas widget a fast preview is shown.

## Known gaps

- Photoshop `.grd` files are not read or written yet (preset-files-manager, 0.5). Import / Export use Pigment's
  `.pigment-presets` files.
- Gradient Fill layers are measured against the document; "Align with Layer" applies to shapes and effects only.
- The on-canvas widget edits colour stops; opacity stops and midpoints are edited in the Gradient Editor.
- The Gradients panel tab is added after the existing tabs of its group (Color, Swatches, Brushes, Gradients), not
  directly after Swatches.
