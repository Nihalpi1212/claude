# Pigment 0.4: layer style effects

Package 6 of 0.4 ("Photoshop parity, stage 2"). Every effect of the Layer Style dialog with Photoshop's fields:
contours and the Contour Editor, noise, glow techniques and gradient glows, the Bevel & Emboss Contour and Texture,
gradient and pattern fills for the Stroke, gradient and pattern placement, several instances of an effect, and dragging
in the document to place an effect while the dialog is open.

## User guide

### The effect list

Layer › Layer Style (or double-click a layer, or the fx button of the Layers panel) opens the Layer Style dialog. The
list on the left has Blending Options and the ten effects. Tick an effect to switch it on; click its name to edit it.
Under Bevel & Emboss the list has two sub-effects, **Contour** and **Texture**, each with its own check box.

**Several instances.** Drop Shadow, Inner Shadow, Color Overlay, Gradient Overlay and Stroke can be applied more than
once, as in Photoshop. Click the **+** at the end of the effect's row: a copy of that effect appears above it and is
selected. Each copy has its own settings. The buttons under the list move the selected copy up or down (copies higher
in the list are drawn over the ones below) and delete it. Deleting the only copy of an effect switches it off and puts
its settings back to the defaults. A layer can hold up to ten copies of an effect.

**Reset to default** under each page puts that effect's settings back to Photoshop's defaults.

### Drag in the document

While the page of Drop Shadow, Inner Shadow, Satin, Gradient Overlay, Pattern Overlay or the Bevel & Emboss Texture is
shown, drag in the document window to place the effect:

- Drop Shadow and Inner Shadow: the shadow follows the pointer; the drag sets Angle and Distance.
- Satin: sets Angle and Distance the same way.
- Gradient Overlay: moves the gradient (its offset; **Reset Alignment** puts it back in the middle).
- Pattern Overlay and Texture: moves the pattern (**Snap to Origin** puts it back).

The tool in the toolbox does not see these drags. The dialog stays open; Cancel undoes the drag with everything else.

### Contours

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

### The effects and their new settings

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

## Release notes

- Layer styles: every Photoshop field of the ten effects (contours, noise, glow technique and gradient fill, Bevel &
  Emboss Contour and Texture and Chisel Soft, gradient and pattern placement, Stroke gradient and pattern fills).
- Layer styles: several instances of Drop Shadow, Inner Shadow, Color Overlay, Gradient Overlay and Stroke.
- Layer styles: the Contour Editor and twelve built-in contours (preset kind `contours`).
- Layer styles: drag in the document to place a shadow, satin, gradient or pattern while the dialog is open.
- Documents from 0.3 render exactly as before: every new field's default gives 0.3's pixels (unit tested bit for
  bit).
- Changed: the Layer Style dialog's Gradient Overlay page uses the gradient picker instead of the Start / End colour
  fields, and the Pattern Overlay page the pattern picker instead of "Use current pattern". A Pattern Overlay now
  stores its pattern as a pattern reference (`{ dataUrl, presetId, name }`) instead of a data URL; 0.3's data URLs
  are still read. Editing a Gradient Overlay stores a v2 gradient (`gradient`) and keeps 0.3's `stops` in step with
  its colours.
- Changed: while the page of a draggable effect is shown, clicks in the document no longer cancel the Layer Style
  dialog (they place the effect); on the other pages a click outside the dialog cancels it as before.
- Changed: Layer › Layer Style › (effect) toggling and the fx menu's check marks count every instance of an effect.
- No new keys and no changed defaults. No settings are written (the `styles` namespace stays empty).

## Known gaps

- Dragging a shadow whose **Use global light** is on sets that effect's own angle and turns Use global light off for
  it; Photoshop moves the document's global light instead (and with it every effect that uses it).
- **Create Layers** (Layer › Layer Style › Create Layers, layer-style-blending) gets exact parts from `splitEffects`,
  except for effects with the Dissolve blend mode: their speckles are drawn again by the layer they become.
- Stroke: no Overprint option; Shape Burst runs across the stroke only (Photoshop's Shape Burst of a Gradient Overlay
  is not offered there, as in Photoshop).
- Contour presets are not yet imported from or exported to Photoshop's `.shc` files (preset-files-manager, 0.5).
- The Layer Style dialog has no "Make Default" button and no Styles page (presets-panels, 0.5).
- PSD export writes the effects as 0.3 did (one instance per effect; contours, textures and gradient strokes are not
  written; the merged image is right). psd-layers (0.5) maps them.
