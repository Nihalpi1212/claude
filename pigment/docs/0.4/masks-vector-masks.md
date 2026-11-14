# Pigment 0.4: vector masks, mask density and feather, mask views

Package 12 of 0.4 ("Photoshop parity, stage 2"). Vector masks (Layer › Vector Mask), non-destructive Density and
Feather on both kinds of mask, the mask overlay (rubylith) with its colour and opacity, the Masks section of the
Properties panel, vector masks in the Paths panel, and the Mask and Shape buttons of the path tools.

## User guide

### Two kinds of mask

A layer can have a **layer mask** (pixels: paint black to hide, white to show) and a **vector mask** (a path: the layer
shows inside the path's shapes), or both. With both, the layer shows only where both let it show. In the Layers panel
the vector mask's thumbnail sits after the layer mask's, each with its link icon.

### Vector masks

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

### Density and feather

Select a layer with a mask and open the Properties panel. Each mask has two sliders:

- **Density** (0–100 %): how strongly the mask hides. At 50 % the hidden parts show the layer at half strength; at 0 %
  the mask does nothing.
- **Feather** (0–1000 px): softens the mask's edges, as a Gaussian blur of the mask.

Both are non-destructive: the mask's pixels and the vector mask's path do not change, and you can go back to 100 % and
0 px at any time. A slider drag is one step in the History. What the layer shows on screen, in a 16- or 32-bit
document, when you merge, flatten, rasterize, export or apply the mask always includes them.

**Apply** (Layer Mask) applies the layer mask, with its density and feather, to the layer's pixels; the vector mask
stays on the layer as it is.

### The Masks section of the Properties panel

- **Layer Mask:** the thumbnail (click to paint on the mask or the layer), Density, Feather, **Select and Mask…** (refine
  the mask's edges; the result goes back into the layer mask), **Color Range…** (the colour range you pick replaces the
  mask), **Invert**, and Edit Mask / Select / Disable / Link / Apply / Delete. Without a layer mask: Add Mask and From
  Transparency.
- **Vector Mask:** the thumbnail (click to edit the path), Density, Feather, Edit Path, Select, Disable / Enable, Link /
  Unlink, Rasterize, Delete. Without a vector mask: Add Vector Mask (Reveal All) and From Path.
- **Show Overlay / Hide Overlay** and **Overlay Options…**

The controls are disabled where the layer cannot take the change (the Background layer's masks, once its rules are in
force).

### Seeing the mask

- **Mask alone:** Alt-click the layer mask thumbnail in the Layers panel to see the mask in grey levels (with its density
  and feather) instead of the image; Alt-click again or press Esc to go back.
- **Overlay:** press **\\** (or Show Overlay in Properties) to see what the mask hides as a coloured overlay over the
  image: the layer mask if the layer has one, else the vector mask. Press \\ again to hide it.
- **Overlay Options…** (Properties) sets the overlay's colour and opacity (red at 50 % by default). The same two
  settings are in **Preferences › Masks**.

### Files

`.pigment` files keep vector masks, density and feather. PSD files get one layer mask per layer with the density,
feather and vector mask baked in, so Photoshop shows what Pigment shows (a layer with only a vector mask gets a layer
mask); Photoshop does not receive them as a live vector mask or as live density and feather yet (planned with the PSD
layer work of 0.5).

## Release notes

- New: vector masks (Layer › Vector Mask › Reveal All, Hide All, Current Path, Delete, Disable / Enable, Link /
  Unlink; Layer › Rasterize › Vector Mask), edited with the path tools, shown in the Layers and Paths panels.
- New: Density and Feather for layer masks and vector masks, non-destructive (Properties panel).
- New: the mask overlay (rubylith) on **\\**, with Overlay Options (colour, opacity) and a Masks section in Preferences
  (`settings.masks.overlayColor`, default `#ff0000`; `settings.masks.overlayOpacity`, default 0.5).
- New: Mask and Shape buttons in the options bar of the Path Selection and Direct Selection tools; Make Vector Mask and
  Make Shape Layer in the Paths panel.
- New: Select and Mask…, Color Range… and Invert for the layer mask in the Properties panel.
- Changed: the mask overlay is drawn in the colour and opacity of the preferences (0.3: red at 50 %, the same default);
  the "mask alone" view and the overlay show the mask with its density and feather.
- Changed: the Properties mask section is now titled per mask kind ("Layer Mask", "Vector Mask") and has the new
  controls; Invert in it is recorded as `layer:mask-properties { part: 'raster', invert: true }` (0.3 did not go
  through a command).
- New command `layer:mask-properties` (`{ part: 'raster' | 'vector', density?, feather?, invert?, fromSelection?,
  merge? }`), recorded by actions: what the Properties sliders and buttons run.
- No key changes in this package (\\ for the overlay is the skeleton's).

## Known gaps

- The Channels panel menu has no "Layer Mask Display Options…" entry yet (that panel is not this package's); the same
  dialog is Overlay Options… in Properties.
- Select and Mask from Properties starts the workspace from the layer mask and writes its result back as the layer
  mask; it is recorded as Select and Mask. Color Range from Properties makes two History steps (the selection, then the
  mask from it).
- Rename on the vector mask's Paths row renames the layer (the row's name is the layer's).
- Vector masks are not read from PSD files (as in 0.3) and are written baked (above).
- On large documents a feathered mask is refined incrementally while you paint on it, and for a moment the previous
  result may show while a path with feather is dragged (a reduced preview); the final result is exact.
- Mask density and feather apply to the layer mask of adjustment and fill layers too; Photoshop's Properties offers
  the same.
