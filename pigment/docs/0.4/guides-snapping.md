# Pigment 0.4: guides and snapping

Package 11 of 0.4 ("Photoshop parity, stage 2"). Guides as objects of the document (a colour each, selected, moved
and deleted with the Move tool), the View › Guides commands, rulers with units and a movable origin, the grid
preferences, View › Snap To for every tool that places something, Smart Guides and Ctrl-hover distances.

## User guide

### Making guides

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

### Selecting, moving and deleting guides (Move tool)

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

### Rulers

View › Rulers (Ctrl+R) shows the rulers.

- **Units:** right-click a ruler for its menu (Pixels, Inches, Centimeters, Millimeters, Points, Percent). The units are
  also in Preferences › Interface. Inches, centimetres, millimetres and points use the document resolution.
- **Origin:** drag from the square where the rulers meet to the point that should read 0 on both rulers. It snaps
  like a guide (hold Shift to put it on a whole pixel). Double-click the square to put the origin back on the document
  corner. The origin is saved with the document and is one step in the history.
- The Info panel, the Properties panel's X and Y, the Free Transform options bar, the New Guide dialog and the grid
  all count from the same origin.

### Grid (View › Show › Grid, Ctrl+')

Preferences › Guides, Grid & Slices sets the grid colour, the style (lines, dashed lines, dots), Gridline Every with its
unit (pixels, inches, centimetres, millimetres, points or percent) and Subdivisions (fainter lines inside each cell).
The grid starts at the ruler origin. The same section sets the guide colour and style (lines or dashed lines) and the
Smart Guides colour.

### Snapping

View › Snap (Shift+Ctrl+;) turns snapping on and off; **View › Snap To** chooses what is snapped to: Guides, Grid,
Layers, Document Bounds, Artboards and Slices (the last two have nothing to snap to until artboards and slices arrive),
with All and None. Guides and the grid snap only while they are shown, as in Photoshop.

Snapping works for the Move tool, the marquees, the Crop and Perspective Crop tools, the shape tools, the Pen, the Path
and Direct Selection tools, Free Transform, the type box, the gradient tool, guides and the ruler origin. A moved
layer or box snaps by its edges and its centre; a dragged point snaps itself. The reach is 6 screen pixels at every
zoom; when two targets are equally near, a guide wins, then the document bounds, then layers, then the grid. The Move
tool snaps the visible content of the layer, not its whole canvas. **Hold Ctrl (Cmd on macOS) while dragging** to
place something without snapping.

### Smart Guides (View › Show › Smart Guides)

While you move a layer (Move tool, Free Transform), magenta lines show the edges and centres it lines up with, among
the other layers and the canvas. When the layer sits as far from a neighbour as two other layers sit from each other
(or halfway between two layers), it snaps there and the equal gaps are marked with their size.

**Ctrl-hover:** with the Move tool, hold Ctrl (Cmd) and point at another layer to see the distances between it and the
active layer; point at an empty part of the canvas to see the distances to the canvas edges. The values are in the
ruler units.

## Release notes

- Guides have a colour each, can be selected, moved and deleted with the Move tool, and are edited with View › Guides ›
  Edit Selected Guides. New: Lock Guides (Alt+Ctrl+;), Clear Selected Guides, Clear Canvas Guides (was Clear Guides),
  New Guide Layout, New Guides From Shape, Clear Selected Artboard Guides (for artboards, later).
- New Guide asks for the orientation and the colour, takes units, and counts from the ruler origin. An action records
  the guide's colour.
- Guide positions keep two decimals (0.3 rounded guides from the rulers and New Guide to whole pixels).
- Rulers: units from the ruler's context menu, a movable ruler origin (drag the corner; double-click resets). A
  placed origin follows the image through Image Size, Canvas Size, Rotate, Flip and Crop; the untouched origin stays
  on the document corner.
- Grid: colour, style, Gridline Every with a unit and Subdivisions in Preferences › Guides, Grid & Slices. The grid
  now draws its subdivisions (the default is 4, so a 50 px grid shows fainter lines every 12.5 px) and starts at the
  ruler origin.
- Snapping (behaviour change): 0.3 snapped only Move tool drags, to the document edges and centre and to guides,
  taking the first target found. Now every placing tool snaps (marquee, crop, shapes, pen, path selection, Free
  Transform, type box, gradient, guides), to guides, the grid, other layers and the document per View › Snap To, and
  the nearest target wins. The Move tool snaps the layer's visible content instead of its whole canvas, and a
  Shift-constrained Move snaps along its axis only.
- Smart Guides are on by default (settings.guides.smartGuides, declared by the skeleton): alignment lines, equal
  spacing (also a snap target) and Ctrl-hover distances with the Move tool.
- Holding Ctrl/Cmd while dragging turns snapping off (from the skeleton).
- Preferences: the "Guides, Grid & Slices" section replaces the skeleton's (its grid spacing field is now "Gridline
  every" with a unit).

## Known gaps

- Artboard guides, slices and the slice preferences (colour, numbers) arrive with artboards (0.9) and slices (0.10);
  Snap To › Artboards and Slices have no targets until then.
- The Properties panel's transform section and the Free Transform options bar show X / Y from the ruler origin but in
  pixels, not in the ruler units (they are skeleton files; the integrator can switch them to `app.rulers.format`).
- The rulers do not follow a rotated view (as in 0.3).
- Smart Guides show for moves (Move tool, Free Transform, the type box) and for points that snap to a layer edge;
  Photoshop's Smart Guides for paths while they are drawn, and its angle readouts, are not there.
- Photoshop's Edit › Preferences "Show Smart Guides for…" options and the per-guide lock are not there.
- A guide drag is not a session: a key command during the drag does not cancel it.
