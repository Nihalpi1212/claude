# brush-engine-core

The brush engine every painting tool goes through (Brush, Pencil, Eraser, Clone Stamp, Pattern Stamp, History Brush,
Adjustment Brush, Quick Mask painting, Stroke Path): tips, dynamics, controls, painting modes, the airbrush, smoothing
and Define Brush Preset.

## User guide

### Brush tips

- **Computed tips** are round or elliptical, with Size (1 to 5000 px), Hardness, Angle and Roundness. Dabs land at
  sub-pixel positions; above 128 px they land on whole pixels, which does not show at that size and paints much faster.
- **Sampled tips** are images. A sampled tip paints the shape of its image: where the image was dark the brush paints,
  where it was white or transparent it does not. The cursor follows the tip's outline.
- **Spacing** is the distance between dabs as a share of the tip's diameter. With Spacing unticked (Brush Settings),
  the brush places one dab for every pointer movement, so fast strokes leave gaps, as in Photoshop.

### Edit > Define Brush Preset…

Select the part of the image you want as a brush (or select nothing to use the whole image) and choose
**Edit > Define Brush Preset…**. Give the brush a name. Pigment takes what the document shows inside the selection,
crops it to the pixels that paint, and adds a brush to the Brushes panel in the group **Defined**. The Brush tool takes
the new brush at once. Paint black on white (or on a transparent layer) for a brush that paints at full strength; grey
paints partly. A tip is at most 5000 px on its longer side; a larger selection is scaled down.

### Brush Settings sections the engine paints

- **Shape Dynamics**: Size Jitter with Minimum Diameter, Tilt Scale, Angle Jitter, Roundness Jitter with Minimum
  Roundness, Flip X and Flip Y Jitter, Brush Projection, each with its Control.
- **Scattering**: Scatter (across the stroke, or along it too with Both Axes), Count and Count Jitter, each with its
  Control.
- **Color Dynamics**: Foreground/Background Jitter with its Control, Hue, Saturation and Brightness Jitter, Purity, and
  Apply Per Tip (off: one colour for the whole stroke). In Grayscale the colours stay grey; in Indexed Color every dab
  takes the nearest colour of the table.
- **Transfer**: Opacity Jitter and Control with Minimum (each dab's opacity is the most paint that dab can leave: a
  stroke at half pen pressure never passes 50 %), Flow Jitter and Control with Minimum.
- **Build-up** and **Smoothing** (the flags at the bottom of the list): see below.

**Controls**: Off, Fade (over the number of steps you give), Pen Pressure, Pen Tilt, Stylus Wheel, Rotation (the pen's
barrel), and for the angle also Initial Direction, Direction and Initial Rotation. With a mouse the pen controls act as
an upright pen at full pressure.

The options bar's **pressure buttons** override the Brush Settings: with "Pen pressure → size" on, pressure sets the
size (Shape Dynamics' size control is not applied a second time); with "Pressure → opacity" on, pressure sets the flow,
as in Pigment 0.4.

### Painting modes

The Brush and Pencil's **Mode** menu now starts Normal, **Dissolve**, **Behind**, **Clear**, then the other blend
modes. Behind paints only where the layer is transparent (as if painting on the back of the layer); Clear paints
transparency; Dissolve paints each pixel either fully or not at all, with the brush's strength as the chance. With the
layer's transparency locked, Behind and Clear change nothing.

### Airbrush (build-up)

The airbrush button in the options bar (Brush, Eraser, Clone Stamp, Pattern Stamp, History Brush and Adjustment Brush;
not the Pencil) or **Shift+Alt+P** while a painting tool is active turns build-up on and off. With build-up on, paint
keeps building while you hold the pointer still, 30 dabs a second at the brush's flow. It is the same setting as
Build-up in Brush Settings.

### Smoothing options

Smoothing in the options bar smooths the stroke's path. The button next to it opens the smoothing options:

- **Pulled String Mode**: the brush moves only when the pointer pulls a string of the smoothing's length taut (100 %
  is 120 screen pixels). The string is drawn while you paint.
- **Stroke Catch-up**: the brush keeps catching up with the pointer while you hold it still.
- **Catch-up on Stroke End**: in Pulled String Mode, the stroke ends at the point where you release; without it, the
  stroke ends a string's length short. (In the normal mode a stroke always ends at the release point, as in 0.4.)
- **Adjust for Zoom**: the string is measured on the screen, so it stays the same length at every zoom.

The **Smoothing** flag in Brush Settings is a different thing: it draws the path between two pointer samples as a curve
instead of a straight line, which helps fast curved strokes.

### Pen tablets

Pressure, tilt, barrel rotation and the stylus wheel reach every control. The pen's eraser end and side buttons are
described with the painting behaviours (brush-painting-behaviours).

## Release notes

- New brush engine: Shape Dynamics, Scattering, Color Dynamics and Transfer with every control (Fade, Pen Pressure, Pen
  Tilt, Stylus Wheel, Rotation, Direction, Initial Direction, Initial Rotation), sampled tips, Spacing off, Brush
  Projection.
- Edit > Define Brush Preset… makes a brush from the selection (group "Defined" in the Brushes panel).
- Airbrush (build-up): an options-bar button and Shift+Alt+P while painting.
- Smoothing options: Pulled String Mode with its string, Stroke Catch-up, Catch-up on Stroke End, Adjust for Zoom.
- Brush Settings' Smoothing flag smooths the path between pointer samples into curves.
- Painting modes Dissolve, Behind and Clear for the Brush and Pencil (0.4 had none of the three).
- Brushes up to 5000 px, with a size-bounded tip cache.
- Changed: Transfer's opacity is a per-dab ceiling. "Pressure → opacity" in the options bar still scales the flow, as
  in 0.4.
- Changed: dabs larger than 128 px are placed at whole pixels (they were placed at sub-pixel positions); no visible
  difference at that size, and a 2500 px dab paints in about a fifth of the time.
- Changed: the end of a stroke no longer composites the whole stroke's box a second time (only what had not been shown
  yet), so releasing a large stroke does not repaint the whole document.
- Changed: the stroke preview of the Brushes and Brush Settings panels draws a pressure that rises and falls along the
  curve, as Photoshop's does, so pen controls (and "Pen pressure → size") show in the preview.
- New key: Shift+Alt+P with a painting tool toggles the airbrush (it was Layer > Blend Mode > Pass Through, which still
  answers with other tools).

## Known gaps

- **Computed tips keep 0.4's dab raster** (a radial falloff drawn once per size and placed with bilinear filtering)
  rather than an analytic per-pixel tip. The 0.4 goldens allow three levels of difference per channel; an analytic
  falloff differs by more on soft brushes. The outline (cursor) is analytic.
- **The S2.8 repaint case** (`repaint-speed.spec.mjs`, a 2500 px textured stroke on 4000 × 4000 at under 25 ms per dab
  with no full repaint) does not pass on this machine. The engine's own cost is about 13 ms per 2500 px dab including
  its flushes; the view's per-frame composite of the ~3000 × 3000 region and its display take about 95 ms a frame, one
  frame per pointer event in the test, and a frame with four dabs covers more than the compositor's 45 % region limit,
  which makes it a full composite (one such frame in the test). Both are outside the engine (canvas-view.js and
  compositor.js).
- **Define Brush Preset** takes what the document shows (all visible layers), like Define Pattern, not the active
  layer alone.
- Pen Tilt as a size control squashes the tip with Tilt Scale and shrinks it with the lean; Photoshop's exact curve is
  not documented and may differ.
- Wetness and Mix controls of Transfer (Mixer Brush) are kept in presets and not painted (Mixer Brush is 0.10).
