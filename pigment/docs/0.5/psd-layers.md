# psd-layers

PSD fidelity for layers: layer effects, Blending Options, vector masks and layer masks, shape layers, fill layers,
adjustment layers, colour labels, linked layers and the global light, both when Pigment opens a PSD and when it saves
one. Maximize Compatibility is a save option and a preference.

## User guide

### What a PSD keeps

When you save a document as a Photoshop file (File › Save As, format PSD), these stay editable in Photoshop and come
back editable when Pigment opens the file again:

- **Layer styles (Layer › Layer Style).** Every effect, with every instance of the effects that can have several
  (Drop Shadow, Inner Shadow, Color Overlay, Gradient Overlay, Stroke): contours and their corner points, noise, glow
  technique, range and jitter, glow gradients, Bevel & Emboss with its Contour and Texture, gradient and pattern
  overlays with their placement, Stroke with a colour, gradient (Shape Burst too) or pattern fill, Hide All Effects.
  Patterns used by effects are saved in the file.
- **Global Light** (Layer › Layer Style › Global Light): its angle and altitude.
- **Blending Options**: Fill opacity, Blend If (as in 0.4) and now also Knockout (None, Shallow, Deep), the channels
  the layer blends into (R, G, B), Blend Interior Effects as Group, Blend Clipped Layers as Group, Transparency Shapes
  Layer, Layer Mask Hides Effects and Vector Mask Hides Effects.
- **Vector masks**: the path with its operations (combine, subtract, intersect, exclude), Reveal All or Hide All as
  the start, enabled or disabled, linked or not, and the Properties panel's Density and Feather for the vector mask.
- **Layer masks**: the mask's own pixels, enabled or disabled, with the Properties panel's Density and Feather as
  settings (Photoshop shows them in its Properties panel; the mask is no longer baked at its density).
- **Shape layers**: fill (solid colour, gradient, pattern, or none) and stroke (width, alignment, caps, corners, miter
  limit, dashes, stroke colour, gradient or pattern). Rectangles (each corner's radius, rotation) and ellipses stay
  live shapes you can edit in the Properties panel; other shapes come back as path shapes with their exact outline.
- **Fill layers** (Layer › New Fill Layer): Solid Color, Gradient (style, angle, scale, offset, reverse, dither,
  method) and Pattern (scale, angle, Link with Layer, the Snap to Origin offset).
- **Adjustment layers**: every adjustment Photoshop has as an adjustment layer, now also Hue/Saturation's Colorize
  and Color Lookup (the loaded table is saved in the file; a built-in look by its name).
- **Layer colours** (the Layers panel's colour labels) and **linked layers**.

The notice "layers with layer effects or Blending Options were saved without them" now appears only for what PSD
cannot hold, and "Hue/Saturation layer set to Colorize was saved without Colorize" no longer appears.

### Opening a PSD

A PSD from Photoshop opens with the same things editable. What Photoshop has and Pigment does not is approximated or
left out, and Pigment tells you which, by name, after the file opens. For example a Bevel & Emboss in the Stroke Emboss
style opens as Emboss, and a Stroke set to Overprint opens without it. An inverted vector mask opens as its path with
the whole canvas excluded from it (which draws the same mask). An adjustment layer Pigment cannot use (an ICC Color
Lookup) keeps its place as a hidden empty layer, as before.

### Grayscale, Duotone and Multichannel documents

PSD files from Pigment are RGB. In a Grayscale, Duotone or Multichannel document a shape, fill layer or effect is
saved as an editable shape, fill or effect only when its colours are what the document shows (greys in a Grayscale
document). Otherwise it is saved as the grey pixels you see, as in 0.4, so the file looks like the document.

### Maximize Compatibility

Edit › Preferences › File Handling › **Maximize PSD and PSB File Compatibility**:

- **Always** (the default): the PSD also holds the flattened picture, so other applications and older versions of
  Photoshop can show it.
- **Never**: a smaller file without the flattened picture; only applications that read the layers can show it.
- **Ask**: Pigment shows **Photoshop Format Options** each time you save a PSD, with a **Maximize compatibility** check
  box. **Don't show again** makes your answer the preference. Cancel cancels the save.

Saves that cannot ask (Batch, the Image Processor, Save in the Close prompt) use the preference, with Ask counting as
on.

## Release notes

- PSD files keep layer effects, every instance of the multi-instance effects, contours, Bevel & Emboss Contour and
  Texture, and gradient and pattern overlays editable, both ways.
- PSD files keep Blending Options: Knockout, the channel restriction, Blend Interior Effects as Group, Blend Clipped
  Layers as Group, Transparency Shapes Layer, Layer Mask Hides Effects, Vector Mask Hides Effects.
- PSD files keep vector masks as vector masks (with their density, feather and Reveal All / Hide All start) instead of
  baking them into the layer mask.
- PSD files keep shape layers as shape layers (fill, stroke, dashes; live rectangles and ellipses) and fill layers as
  Solid Color, Gradient and Pattern fills.
- PSD files keep Hue/Saturation's Colorize and Color Lookup layers.
- PSD files keep layer colour labels, linked layers and the Global Light.
- Opening a PSD tells you which effect and vector settings Pigment approximated or left out, by name.
- New preference: Edit › Preferences › File Handling › Maximize PSD and PSB File Compatibility (Always, Ask, Never;
  default Always, which is 0.4's behaviour). New dialog: Photoshop Format Options when the preference is Ask.
- Changed: a layer mask's Density and Feather are saved as mask settings with the mask's own pixels, not baked into
  the pixels (Photoshop shows the same result). A layer with a vector mask is saved with the vector mask, not with
  the vector mask baked into its layer mask; only a shape layer's own extra vector mask is still baked (PSD holds one
  outline per layer), with a notice.
- Changed: the "saved without them" notice for effects and Blending Options, and the "saved without Colorize" notice,
  appear only where PSD cannot hold the feature (in a Grayscale, Duotone or Multichannel document, coloured effects
  are still saved as pixels with the notice).
- Changed: a PSD with a Global Light other than Photoshop's 120° / 30° opens with that Global Light.
- Fixed in Pigment's copy of ag-psd: Knockout Shallow and Deep, one or two restricted channels, Vector Mask Hides
  Effects, a Stroke effect with a Shape Burst gradient (which made every effect of the layer disappear), the pattern
  fill's Scale, Angle and Link with Layer, and the gradient fill's Scale and Offset precision.

## Known gaps

- **Live shapes other than rectangles and ellipses.** Triangles, polygons and stars, lines and custom shapes are
  saved with their exact outline and open as path shapes: Photoshop's origination records for those kinds are not
  documented well enough to write reliably.
- **A layer mask's link.** The link between a layer and its raster mask (Layers panel chain) is not saved: the PSD
  flag that might hold it ("position relative to layer") has no clear meaning, so every mask opens linked. A vector
  mask's link is saved.
- **A shape stroke's own opacity and blend mode** (Photoshop's stroke options) open as 100 % Normal, with a notice.
  A pattern stroke on a shape is saved linked to the layer whatever its Link with Layer setting.
- **Effects in Grayscale, Duotone and Multichannel documents** are saved as pixels unless every colour is grey (the
  file is RGB), with 0.4's notice.
- **A pattern that has not loaded yet** (a style or shape pattern held only as data in a document opened a moment
  ago and not yet drawn) cannot be put in the file: that effect is left out, or the shape or fill is saved as pixels,
  with a notice.
- **Stripes gradients** are saved with the Classic method (PSD has no Stripes code), with a notice.
- **Spread and Choke** are Photoshop percentages of Size; Pigment's are pixels. A round trip keeps the same picture,
  but Photoshop shows the percentage rounded to whole numbers.
