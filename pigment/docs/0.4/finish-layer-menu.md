# Pigment 0.4: the Layer menu, finished

Package 15 of 0.4 ("Photoshop parity, stage 2"). The New Layer, New Group, Duplicate Layer and Lock Layers dialogs,
the property commands on every selected layer, Arrange with several layers and Reverse, the whole Distribute submenu,
links honoured by Align and Distribute, Merge Layers / Merge Group on Ctrl+E, Stamp Visible and Stamp Layers, layer
navigation, the opacity digits, the `/` lock and the blend-mode keys, Select › Similar Layers, the Rasterize submenu,
and the rules of the Background layer.

## User guide

### New Layer, New Group, Duplicate Layer

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

### Changing several layers at once

Opacity, Fill, the blend mode, the locks and **Layer › Hide / Show Layers** (**Ctrl+,**) act on every selected layer,
as one step in the History. Hide / Show gives all of them the opposite of the active layer's state. Dragging an
opacity slider or scrubbing its label is one step, however many layers are selected.

### Keys

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

### Arrange and Distribute

**Layer › Arrange** works on every selected layer: Bring to Front, Bring Forward, Send Backward and Send to Back move
them together and keep their order. **Reverse** turns the order of the selected layers round.

**Layer › Distribute** needs three or more selected layers. **Top Edges, Vertical Centers, Bottom Edges, Left Edges,
Horizontal Centers, Right Edges** spread that edge or centre evenly between the two outermost layers;
**Horizontally** and **Vertically** make the gaps between the layers equal.

**Linked layers** (Layer › Link Layers) move along when Align or Distribute moves one of their set, as they do with the
Move tool and Free Transform. Layers locked in position, and the Background, are not moved.

### Locks

**Layer › Lock Layers…** (Ctrl+/) sets the locks of the selected layers: Transparency, Image, Position, All. **Lock All
Layers in Group…** sets them on every layer inside the selected group.

### Merging and stamping

**Ctrl+E** does what the Layer menu item says: **Merge Down** with one layer selected, **Merge Layers** with several,
**Merge Group** with a group selected (the group becomes one layer with its name; its mode and opacity stay, its mask
and effects are rendered in, hidden layers inside it are dropped). An action records the merge that happened.

**Alt+Shift+Ctrl+E** (**Stamp Visible**) puts everything visible, merged, on a new layer above the active one.
**Alt+Ctrl+E** (**Stamp Layers**) merges a copy of the selected layers onto a new layer ("… (merged)"); with one layer
selected it merges a copy of it into the pixel layer below. The layers that were read stay as they were.

### Rasterize

**Layer › Rasterize › Type, Shape, Fill Content** rasterize the selected layers of that kind; **Layer** rasterizes every
selected layer that is not made of pixels yet. The layer mask, the vector mask (Fill Content keeps it), the locks, the
colour label and the link stay.

### Select › Similar Layers

Selects every layer of the same kind as the active one: pixel layers, type, shapes, fill layers, adjustment layers,
smart objects or groups.

### The Background layer

The bottom layer of a new document, named "Background", follows Photoshop's rules:

- it stays at the bottom of the stack: it cannot be moved up or into a group, and nothing can be put below it (Send to
  Back stops right above it);
- its opacity, Fill, blend mode, masks, vector mask, effects and position are locked; adding a layer mask turns it into
  an ordinary layer ("Layer 0") first, in the same step;
- **Layer › New › Layer from Background…**, or renaming it, makes it an ordinary layer again;
- merging layers into it (Merge Down onto it, Merge Layers with it selected) keeps it the Background.

## Release notes

- The New Layer, New Group and Duplicate Layer dialogs (with destination document); New Fill Layer asks the New Layer
  questions first. The dialogs open only from the menu and the keys; code, actions and the Layers panel create without
  asking, as before.
- Opacity, Fill, blend mode, locks and Hide / Show Layers (new key **Ctrl+,**; macOS Cmd+, , which was Settings) act on
  every selected layer, as one History step. Before 0.4 they changed the active layer only.
- **Ctrl+E** is Merge Down / Merge Layers / Merge Group by context (it was always Merge Down). `layer:merge-down` keeps
  its meaning.
- New keys: digits and Shift+digits (opacity, fill), `/` (lock transparency), Shift+Alt+letters (blend modes),
  Shift+= / Shift+- (next / previous blend mode), Alt+[ ] , . and Shift+Alt+[ ] (layer navigation), Alt+Shift+Ctrl+E
  (Stamp Visible, was Quick Export), Alt+Ctrl+E (Stamp Layers), Alt+Shift+Ctrl+N (New Layer without the dialog),
  Ctrl+/ (Lock Layers…, was Keyboard Shortcuts). `/` depends on the keyboard layout: on a German keyboard it needs
  Shift and does not match.
- Layer › Arrange works on every selected layer; new Reverse. Layer › Distribute has every edge; **Distribute
  Horizontally / Vertically now make the gaps equal** (before 0.4 they spread the centres, which is now Horizontal /
  Vertical Centers; `layer:distribute` without an argument still spreads horizontal centres).
- Align and Distribute move linked layers along and leave the Background and position-locked layers in place.
- Lock Layers… and Lock All Layers in Group…; Stamp Visible, Stamp Layers; Select › Similar Layers.
- Layer › Rasterize honours Type / Shape / Fill Content and the selected layers.
- **The Background stays at the bottom** (it can no longer be moved up, grouped, or have layers put below it) and its
  opacity, fill, blend mode, masks and effects are locked; a layer mask converts it to "Layer 0". Renaming it makes it
  an ordinary layer.
- Duplicate Layer honours "Add copy to Copied Layers and Groups" (`settings.layersPanel.addCopy`).

## Settings

`settings.layerMenu` (namespace object, J.7): `digitPairMs` (default 600) — how quickly a second digit must follow the
first to make a two-digit opacity. Not shown in Preferences.

## Known gaps

- Stamps, Merge Group and the Background merges composite at 8 bits per channel (16/32-bit documents get their new
  pixels from the 8-bit composite, as Merge Visible did in 0.3); Merge Down / Merge Layers / Merge Visible keep the
  float path of lib/depth.js.
- The digits, `/`, Shift+= / Shift+- and the blend-mode keys always act on layers; painting tools' own opacity, flow and
  mode keys come with brush-painting-behaviours (0.5). While a painting tool is active the digits do nothing.
- Duplicate Layer into another document keeps the layer's position; it does not centre it in a document of another
  size, and it does not convert colours between image modes.
- The Background is still recognised by its name and place (0.3); a persisted background flag is psd-layers' (0.5).
- Vector masks on the Background are refused by masks-vector-masks (Photoshop converts the layer, as Pigment does for
  layer masks).
