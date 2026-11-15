# Pigment 0.4: Blending Options, styles on groups and the Layer Style commands

Package 5 of 0.4 ("Photoshop parity, stage 2"). The Blending Options page of the Layer Style dialog with Photoshop's
Advanced Blending (fill opacity, channels, knockout, the five check boxes) and Blend If with split sliders; layer
styles on groups; Layer › Layer Style › Create Layers, Hide All Effects / Show All Effects and Scale Effects.

## User guide

### Blending Options

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

### Styles on groups

Groups take layer styles like any layer: select a group and open Layer Style. The effects are drawn around everything
the group shows, as one shape. A Pass Through group with effects (or with advanced blending options) is composited as
an isolated group, as in Photoshop. The Background layer and adjustment layers take no styles.

### Layer › Layer Style commands

- **Create Layers** turns each effect into a layer of its own: effects that lie outside the layer (Drop Shadow, Outer
  Glow, an outside stroke, the outer half of a bevel) become layers below it; effects inside it (the overlays, Satin,
  Inner Glow, Inner Shadow, the inner half of a bevel, an inside stroke) become layers clipped to it above. The layer
  keeps its pixels and loses its style. One undo step.
- **Hide All Effects / Show All Effects** hides every effect of the selected layers without removing them (the menu
  item says Show All Effects while they are hidden).
- **Scale Effects…** scales the sizes, distances, spreads, chokes and pattern scales of every effect of the layer (1 to
  1000 %), with a live preview.

## Release notes

- New: Blending Options with Advanced Blending (fill opacity, channels, knockout Shallow and Deep, Blend Interior
  Effects as Group, Blend Clipped Layers as Group, Transparency Shapes Layer, Layer Mask Hides Effects, Vector Mask
  Hides Effects) and Blend If with split sliders.
- New: layer styles on groups.
- New: Layer › Layer Style › Create Layers, Hide All Effects / Show All Effects, Scale Effects….
- Changed: a Pass Through group whose `styles` object has every effect switched off now passes through (0.3 isolated it
  as soon as it had a styles object). A Pass Through group with effects or advanced blending options is isolated.
- Changed: the Layer Style dialog opens on groups (0.3 refused them).
- No default and no key changed.

## Known gaps

- Blending options are not written to PSD (0.5, psd-layers); the merged image in the PSD is right.
- 16 and 32 bits per channel: the float flatten does not know advanced blending options and composites such layers as
  if they had none (the integrator adds a fallback to the 8-bit composite).
- Create Layers on a layer with Fill below 100 %: the clipped effect layers are faded by the Fill along with the layer
  (the clipping group in Pigment fades as a whole), so interior effects come out weaker than they were. Exterior effect
  layers blend with the document below them in their own modes, where the style blended them with each other first:
  the picture can change slightly where a shadow in Multiply lies over coloured layers (Photoshop warns about the same).
- Groups ignore Fill opacity unless they have effects (as 0.3).
- Blend If and knockout run per pixel on the visible part of the layer; very large layers with these options repaint
  more slowly than plain ones (no cost for layers without them).
- Blend If's Underlying Layer reads the composite below the layer inside its group (an isolated group's own content).
