# Pigment 0.4: the Layers panel in depth

Package 14 of 0.4 ("Photoshop parity, stage 2"). Scrubby Opacity and Fill on every selected layer, lock buttons on
every selected layer, the blend-mode menu with live preview and arrow keys, the footer buttons' modifiers, drags of
several rows, copies, effects and drops on the footer, the eye column, Alt-click to clip, nested groups, the effects
listed under each layer, the panel menu and Panel Options, Collapse All Groups, more Find Layers filters, and Isolate
Layers honoured by every merged sample.

## User guide

### Opacity, Fill, blend mode and locks

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

### Footer buttons

- **New Layer**: Alt-click opens the New Layer dialog; Ctrl/Cmd-click adds the layer below the current one.
- **New Group**: Alt-click opens the New Group dialog.
- **Add Mask**: adds a layer mask that reveals all (or the selection); Alt-click adds one that hides all (or the
  selection). Clicked on a layer that already has a layer mask, it adds a vector mask (Alt: one that hides all).
- Drop layer rows on **New Layer** to duplicate them, on **Delete** to delete them. Drop an effect row on **Delete** to
  delete that effect, or the **Effects** row to delete all of the layer's effects.

### Dragging rows

Dragging a selected row drags every selected layer; they keep their order. Hold **Alt** when you drop to copy them
instead. Drop on the upper or lower half of a row to place the layers above or below it; drop on the middle of a closed
group, or the lower part of an open group's row, to put them inside it. The drop line does not appear where the layers
cannot go: under the Background, into themselves.

### The eye column

Click an eye to show or hide that layer. Press on an eye and drag down (or up) the column: every layer you pass over
takes the state of the first one, at once on the canvas, and the whole drag is one step in History. Alt-click an eye
to show only that layer (Alt-click it again to bring the others back). Right-click an eye for the colour labels.

### Clipping masks

Hold **Alt** and click the line between two layers to clip the upper layer to the lower one; the pointer changes over
the line. Alt-click the line again to release it.

### Groups

Click a group's triangle to open or close it. **Alt**-click opens or closes the group and every group inside it;
**Ctrl/Cmd**-click opens or closes every group of the document. **Collapse All Groups** in the panel menu closes them
all. Groups show their layer mask and vector mask like any layer, and Pass Through in the blend-mode menu.

### Effects under the layer

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

### The panel menu and Panel Options

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

### Find Layers and Isolate Layers

The filter bar (Select › Find Layers) has a new **Selected** type (only the selected layers) and new attributes: **Not
locked**, **Vector mask** and **Advanced blending** (layers whose Blending Options are not the defaults).

While layers are isolated (Select › Isolate Layers), the Eyedropper, Color Sampler, Magic Wand, Quick Selection,
Object Selection, Paint Bucket, the retouch tools' Sample All Layers and the Info panel read only what the canvas shows,
and the Move tool's auto-select never picks a layer the isolation hides.

## Release notes

- Layers panel: Opacity and Fill are scrubby fields that change every selected layer, as one History step per drag.
- Layers panel: the blend-mode menu previews each mode on the canvas while you hover it; ↑ / ↓ step through the modes.
- Layers panel: drag several rows at once; Alt-drag copies; drop rows on New Layer to duplicate or on Delete to delete.
- Layers panel: drag down the eye column to show or hide many layers in one step.
- Layers panel: Alt-click the line between two layers to make or release a clipping mask.
- Layers panel: layer effects are listed under each layer with their own eyes; drag them between layers.
- Layers panel: a panel menu with Panel Options (thumbnail size and contents, effects, "copy" names) and Collapse All
  Groups.
- Layers panel: New Layer Ctrl/Cmd-click adds below the current layer, Alt-click opens the dialog; New Group Alt-click
  opens its dialog; Add Mask adds a vector mask on a layer that already has a layer mask, Alt-click hides.
- Find Layers: Selected type; Not locked, Vector mask and Advanced blending attributes.
- Isolate Layers: the samplers (Eyedropper, Magic Wand, Paint Bucket, Info and others) see only the isolated layers.
- **Changed default:** layer thumbnails show the layer's own pixels (Panel Options › Thumbnail Contents: Layer Bounds,
  `settings.layersPanel.thumbBounds: 'layer'`). Earlier versions showed the whole canvas; choose Entire Document for that.
- **Changed:** the blend-mode drop-down of the Layers panel is a button with its own list (so it can preview): it no
  longer is a `<select>`; it acts on every selected layer instead of the active one.
- **Changed:** Opacity, Fill and the lock buttons act on every selected layer, not only the active one.
- **Changed:** the row context menu's Merge Down is Merge Down, Merge Layers or Merge Group as Ctrl+E does
  (`layer:merge`), and Create Clipping Mask acts on the row's layer.
- **Changed:** a styled layer shows its effects as rows under it (Panel Options › Show effects under the layers turns
  that off).
- No key changed.

## Known gaps

- **Use Default Masks on Fill Layers** (`settings.layersPanel.fillDefaultMasks`, declared by the skeleton) is not in
  Panel Options: new fill and adjustment layers are made by `layer-ops.js` (finish-layer-menu), which does not add a
  mask in 0.4. Wired by the integrator or in 0.5.
- An effect switched off with its eye in the Layers panel keeps `present: true` (PSD's flag for "listed") so that its
  row stays; an effect switched off in the Layer Style dialog is no longer listed. Photoshop lists both.
- While isolated, a clipped layer whose base is hidden by the isolation is drawn unclipped on the canvas (0.3); merged
  sampling skips the base and so does not see the clipped layer.
- No Smart Object or Artboard filter types (0.4 has only embedded smart objects and no artboards).
- Expanding and collapsing groups and effect lists is not recorded in History (as in Photoshop); the group state is
  saved in `.pigment` files, the effects list state is not.
- With several selected layers in different modes the blend-mode button shows "—"; the arrow keys step from the active
  layer's mode and apply the result to all of them.
