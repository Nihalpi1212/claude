# Pigment 0.4: patterns

Package 10 of 0.4 ("Photoshop parity, stage 2"). The pattern library and everything that uses it: the Patterns panel
and pattern picker, Edit › Define Pattern, Edit › Fill with a pattern and the Scripted Patterns, Pattern Fill layers,
View › Pattern Preview, the Paint Bucket's pattern source and Bitmap's Custom Pattern.

## User guide

### The pattern library

Pigment keeps a library of patterns, as Photoshop does. It starts with twelve built-in patterns in two groups (Basic:
Checkerboard, Diagonal Lines, Grid, Dots, Bricks, Weave; Textures: Noise, Clouds, Wood, Burlap, Water, Grass), and
holds every pattern you define or import. The library is kept with your presets, not in a document, so your patterns
are there in every document and after a restart.

One pattern is the **current pattern**: Edit › Fill › Pattern, the Paint Bucket (Fill: Pattern), the Pattern Stamp
tool and new Pattern Fill layers start from it. Click a pattern in the Patterns panel or in a picker to make it
current; a pattern you define becomes current at once.

A pattern used in a document (a Pattern Fill layer, a Pattern Overlay style, a fill) is copied into it. Deleting the
pattern from the library, or opening the document on another computer, changes nothing in the document.

### Edit › Define Pattern…

Select a rectangle (or nothing, for the whole image) and choose Edit › Define Pattern…. The Pattern Name dialog shows
the tile and its size; give it a name and click OK. The pattern is made from what the document shows (all visible
layers), like Photoshop.

### Patterns panel (Window › Patterns)

The panel shows the library in groups; click a group's heading to fold it.

- **Click** a pattern to make it the current pattern. When the active layer is a Pattern Fill layer, the click also
  puts the pattern in that layer (one undo step; its angle, scale and position stay).
- **Double-click** a pattern to rename it.
- **Drag** a pattern onto the canvas to make a Pattern Fill layer above the active layer, or onto a row of the Layers
  panel to make one above that layer. Drag it onto another pattern or onto a group heading to reorder or regroup it.
- **Right-click** a pattern to rename, duplicate or delete it; right-click a group heading to rename or delete the
  group.
- The footer buttons make a group, define a new pattern from the selection, and delete the selected pattern. The menu
  (⋯) has the three views (small and large thumbnails, list), Import Patterns…, Export Selected / All Patterns… and
  Reset Patterns….

**Import Patterns…** reads a `.pigment-presets` file of patterns, or pictures (PNG, JPEG, WebP, GIF, BMP): each picture
becomes a pattern. **Export** writes a `.pigment-presets` file with the patterns' pixels inside. **Reset Patterns…**
goes back to the built-in patterns and deletes the ones you added.

### The pattern picker

Wherever Pigment asks for a pattern (the Fill dialog, the Pattern Fill dialog and Properties, the Paint Bucket's
options bar, Bitmap's Custom Pattern, the Pattern Overlay effect once the layer-style work lands) it shows a swatch
with a small arrow. Click either to open the picker; click a pattern to choose it. Below the patterns, **New from
Selection** defines a pattern from the current selection and **Import…** adds patterns from files.

### Edit › Fill with a pattern

In Edit › Fill…, set Contents to **Pattern**. Choose the pattern under **Custom Pattern**. The tiles start at the
document's top-left corner, so two fills next to each other join without a seam.

Turn on **Scripted Patterns** and choose a script to place copies of the pattern instead of tiling it. After you click
OK, the script's own dialog asks for its options:

| Script | What it does | Options |
| --- | --- | --- |
| Brick Fill | Rows of copies, every other row shifted, like bricks | Pattern scale, Spacing, Offset between rows |
| Cross Weave | A grid of copies, every other one turned a quarter, like woven strips | Pattern scale, Spacing |
| Place Along Path | Copies along the chosen path (or the work path), turned to follow it | Pattern scale, Spacing, Alignment (along the path, alternate sides), Scale progression, Distance from path, Rotate angle, Adjust spacing to fit |
| Random Fill | Copies at random places, sizes and angles | Density, Minimum and Maximum scale, Rotate pattern |
| Spiral | Copies on a spiral from the middle of the area outwards | Pattern scale, Spacing, Starting angle, Scale progression, Rotate pattern |
| Symmetry Fill | The pattern repeated by a symmetry group | Symmetry type (translation, mirror, mirror both ways, glide reflection, 2-, 3-, 4- and 6-fold rotation, 4-fold rotation with mirrors), Pattern scale, Pattern translation X and Y, Pattern rotate angle |

Every script also has **Color randomness** (each copy's hue turned by up to half a turn) and **Brightness
randomness**. A recorded action replays a scripted fill exactly: the fill keeps the random choices it made.

### Pattern Fill layers

Layer › New Fill Layer › Pattern… makes a Pattern Fill layer with the current pattern and opens the **Pattern Fill**
dialog, which shows its changes on the canvas:

- **Pattern**: the picker.
- **Angle**: turns the pattern (counter-clockwise for positive angles, as in Photoshop).
- **Scale**: 1 % to 1000 %.
- **Link with Layer**: on, the pattern starts at the layer's corner; off, at the document's origin. (A fill layer
  covers the document, so both start at the same place until the layer is moved; on shapes it decides whether the
  pattern travels with the shape.)
- **Drag in the document** while the dialog is open to move the pattern; **Snap to Origin** puts it back at the
  document's origin.

Cancel keeps the new layer with the current pattern, as Pigment's Gradient Fill does. Double-click the layer's fill
thumbnail or choose Layer › Layer Content Options… to open the dialog again. The Properties panel shows the same
settings for the active Pattern Fill layer (pattern, Angle, Scale, Link with Layer, Snap to Origin); each change there
is one undo step.

### View › Pattern Preview

View › Pattern Preview shows the document repeated all around itself in the window, so you can paint a tile that
repeats without seams: a stroke that runs off one edge shows up on the far side. It only changes the view; the
document keeps its size and pixels. Choose it again to turn it off (it is off whenever Pigment starts).

### Paint Bucket

With **Fill: Pattern** in the options bar, the Paint Bucket fills with the pattern chosen in the options bar's picker
(or the current pattern while none is chosen). The tiles start at the document's origin.

### Image › Mode › Bitmap: Custom Pattern

With **Use: Custom Pattern**, set **Custom pattern** to **From the pattern library** and choose a pattern in the
picker. Its greys are the thresholds: where the image is lighter than the pattern, the result is white. The seven
threshold tiles of 0.3 (fine dither, lines, crosshatch, dots, bricks, noise) are still in the list.

## Release notes

- New: the pattern library, kept with the presets (persistent), with twelve built-in patterns; the Patterns panel
  (Window › Patterns); the pattern picker wherever a pattern is chosen.
- New: Edit › Define Pattern… asks for the pattern's name (the Pattern Name dialog). From an action or a script it
  takes the recorded name.
- New: Edit › Fill › Pattern has the Custom Pattern picker and the Scripted Patterns (Brick Fill, Cross Weave, Place
  Along Path, Random Fill, Spiral, Symmetry Fill).
- New: Pattern Fill layers have Angle, Link with Layer, Snap to Origin and can be moved by dragging in the Pattern Fill
  dialog; the Properties panel edits them.
- New: View › Pattern Preview.
- New: drag a pattern from the Patterns panel onto the canvas or a layer row to make a Pattern Fill layer.
- New: Bitmap's Custom Pattern can use a pattern of the library.
- Changed: there is always a current pattern (the first built-in until you pick or define one; 0.3 had none until
  Define Pattern). So Fill › Pattern, the Paint Bucket's pattern source, the Pattern Stamp and New Fill Layer › Pattern
  work without defining a pattern first. The current pattern is remembered across restarts (`settings.patterns.current`).
- Changed: the Paint Bucket's pattern tiles start at the document's origin (0.3 started them at the corner of the
  filled area), as Photoshop and Edit › Fill do.
- Changed: Layer › New Fill Layer › Pattern opens the Pattern Fill dialog on the new layer (0.3 made the layer
  without a dialog).
- Changed: patterns no longer disappear when Pigment closes, and the library is no longer limited to the last 24.
- No default key changed.

## Known gaps

- `.pigment` files keep a Pattern Fill layer's pixels and scale, but not yet its Angle, Link with Layer and position:
  the skeleton's `Document.describe()` writes only `scale` (J.1 lists the other fields). Reopened, such a layer shows
  the pattern unturned at the document origin. (Integrator item; the e2e round trip test skips until it is fixed.)
- Moving a Pattern Fill layer with Link with Layer on does not yet move its pattern: fill layers have no position of
  their own in `layer-move.js` (skeleton), which would need to shift `paint.pattern.origin`.
- An action that recorded Layer › New Fill Layer › Pattern replays with the current pattern at 100 %, as in 0.3
  (`layer-ops.js` records no paint for patterns).
- Bitmap › Custom Pattern replayed from an action in a new session, before the pattern's pixels have decoded, falls
  back to the fine dither (the conversion in `modes.js` reads the tile synchronously). The Bitmap dialog itself always
  decodes first.
- Photoshop's `.pat` pattern files are not read yet (preset-files-manager, 0.5).
- The Pattern Stamp tool has no pattern picker of its own yet (it paints the current pattern).
- Scripted Patterns are Pigment's own placements modelled on Photoshop's scripts, not their exact output.
