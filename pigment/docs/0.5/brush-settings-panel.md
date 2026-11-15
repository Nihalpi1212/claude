# brush-settings-panel

The Brush Settings panel (F5), the Brushes panel with groups, search and recent brushes, the options bar's brush
picker, the Texture, Dual Brush, Brush Pose, Noise and Wet Edges sections, and Photoshop brush files (.abr).

## User guide

### Brush Settings panel (Window > Brush Settings, F5)

Brush Settings edits the brush of the painting tool you are using. Each painting tool keeps its own brush, as in
Photoshop: changing the Brush's settings does not change the Eraser's. With a tool that does not paint (the Move tool,
say) the panel edits the last painting tool you used; its name is shown at the top.

- The **list on the left** has every section. Tick a section's box to use it; click its name to see its settings. The
  **lock** beside a section keeps that section's settings when you pick another brush preset (in the Brushes panel,
  the options bar's picker, or with the keys). Locks hold for every painting tool.
- **Brush Tip Shape**: the tips of the loaded presets (click one to use its tip), **Size** with **Restore Original
  Size** (back to the size of the preset the brush came from), **Flip X** and **Flip Y**, the **angle and roundness
  control** (drag the arrow to turn the tip, drag one of the two dots to squash it; Shift turns in 15° steps; the arrow
  keys work when the control has focus), **Angle**, **Roundness**, **Hardness** (computed tips) and **Spacing**. With
  Spacing unticked the brush places one dab for every pointer movement.
- **Shape Dynamics**, **Scattering**, **Color Dynamics** and **Transfer** are painted by the brush engine (see
  brush-engine-core). Every jitter has its **Control**: Off, Fade (with its number of steps), Pen Pressure, Pen Tilt,
  Stylus Wheel, Rotation, and for the angle also Initial Direction, Direction and Initial Rotation.
- **Texture**: the brush paints through a pattern, as if the canvas had that relief. Choose the **pattern** (none
  chosen: the current pattern), **Invert**, **Scale**, **Brightness**, **Contrast**, the **Mode** and the **Depth** (at
  100 % the dark parts of the pattern take no paint). With **Texture Each Tip** every dab meets the texture on its own,
  so paint builds up through the texture as dabs overlap, and the depth has its own **Minimum Depth**, **Depth Jitter**
  and **Control**; without it the whole stroke meets the texture once. The texture stays put on the canvas: two strokes
  over the same place show the same relief.
- **Dual Brush**: a second tip is stroked along the same path, and the brush paints only where the two meet. Pick the
  second tip from the list and set its **Size**, **Spacing**, **Scatter** (with **Both Axes**), **Count** and **Count
  Jitter**, **Flip** (each dab of the second tip flipped at random) and the **Mode** that combines the two (Color Burn,
  Photoshop's default, paints only inside the second tip's dabs).
- **Brush Pose**: Tilt X, Tilt Y, Rotation and Pressure as a pen would give them. With a mouse they stand in for the
  pen; with a pen they are used only where **Override** is ticked. They act through the other sections: the pressure
  through the options bar's pressure button for size and through the Pen Pressure controls, the tilt through Pen Tilt,
  the rotation through Rotation.
- **Noise** adds grain to the soft edges of each tip (hard tips show little or none). **Wet Edges** makes paint pool at
  the edges of the stroke and the inside stay lighter, like watercolour. **Build-up** is the airbrush (it keeps
  painting while the pointer rests; the options bar's airbrush button is the same setting). **Smoothing** draws fast
  strokes as curves. **Protect Texture** keeps the current texture's pattern and scale whenever you pick a preset that
  has a texture.
- The **stroke preview** at the bottom is painted by the brush engine with every section, the pen pressure rising and
  falling along it.
- The panel menu (⋯) has **Clear Brush Controls** (every section off; the tip stays; also the button at the bottom left),
  **Unlock All Settings**, **Copy Texture to Other Tools** (every painting tool gets this texture) and **New Brush
  Preset…**.
- Tools that work dab by dab (Blur, Sharpen, Smudge, Dodge, Burn, Sponge, the healing tools, Color Replacement,
  Background Eraser) use the tip's Size and Hardness only in this release.

Brush settings are tool settings, not document changes: they are not in the History panel and are kept between
sessions.

### Brushes panel (Window > Brushes)

- The presets are in **groups** that open and close: General Brushes, Airbrushes, Special Effects Brushes and Pigment
  Media Brushes (Grainy Pencil, Canvas Texture, Watercolour Wash, Dual Charcoal, Spatter, Dry Brush), then your own.
  Brushes you import from a file go into a group named after the file.
- **Click** a brush to use it with the current painting tool; **Ctrl+click** (Cmd+click) selects several without
  using them. The brush the tool uses is outlined; a dot marks it when you have changed it since.
- **Search** above the list finds brushes by name. The **row of recent brushes** under it lists the last ones you
  picked, newest first.
- **Size** at the top sets the tool's brush size.
- **Drag** a brush onto another to put it there, or onto a group's name to move it into that group.
- **Right-click** a brush to rename, duplicate, export or delete it, and a group's name to rename or delete it. Deleting
  a brush keeps its tip image: a tool or tool preset that uses that tip still paints with it.
- The buttons at the bottom open Brush Settings, add a group, save the current brush as a new preset, and delete the
  selected brushes. The menu (⋯) also has the views (**Thumbnails**, **List**, **Strokes**), **Import Brushes…**,
  **Export Selected Brushes…**, **Export All Brushes…** and **Reset Brushes…**.
- **New Brush Preset…** saves the tool's brush with every section. Tick **Include tool settings** to save the tool's
  opacity, flow, mode and smoothing with it, and **Include color** to save the foreground colour: picking the preset
  later sets them again. The new preset becomes the tool's brush.

### The options bar's brush button

The brush button shows the tool's tip and size. Click it for the brush picker: Size, Hardness, the angle and roundness
control, search, the recent brushes and the presets, with buttons for Brush Settings and New Preset.

### Photoshop brush files (.abr)

Open an .abr file with **File > Open**, drop it on the window, or use **Import Brushes…** in the Brushes panel's menu.
The brushes go into a new group named after the file; a brush's texture pattern goes into the Patterns panel and the
brush keeps using it. Pigment reads .abr files from Photoshop 7.0.1 and later (versions 6 to 10) with every section
above, and older ones (versions 1 and 2: computed and sampled tips). Pigment writes .abr files (Photoshop's version 6.2)
with **Export Selected Brushes…** and **Export All Brushes…** (choose "Photoshop Brushes" or type a name ending in
.abr), with their sampled tips and texture patterns.

What Pigment cannot read is listed after the import: erodible, airbrush and bristle tips (they paint as round tips and
keep their settings for a later release), texture modes Pigment does not have, and damaged parts of a file (the rest of
the file is still read). On export, what an .abr file cannot hold is listed: the Behind and Clear modes of a brush's
tool settings (written as Normal), a missing tip image or texture pattern.

## Release notes

- New: the **Brush Settings panel** (Window > Brush Settings, F5) with every section of Photoshop's: Brush Tip Shape
  with the angle and roundness control, Shape Dynamics, Scattering, Texture, Dual Brush, Color Dynamics, Transfer,
  Brush Pose, Noise, Wet Edges, Build-up, Smoothing and Protect Texture, section locks, Clear Brush Controls, Copy
  Texture to Other Tools and a live stroke preview.
- New: **Texture**, **Dual Brush**, **Brush Pose**, **Noise** and **Wet Edges** paint (every painting tool on the brush
  engine: Brush, Pencil, Eraser, the stamps, History Brush, Adjustment Brush, Quick Mask painting).
- New: **Photoshop brush files (.abr)**, read (versions 1, 2 and 6 to 10, with sampled tips and texture patterns) and
  written (version 6.2).
- New: Pigment Media Brushes, six built-in brushes that use the new sections (Grainy Pencil 10, Canvas Texture 45,
  Watercolour Wash 60, Dual Charcoal 36, Spatter 30, Dry Brush 24).
- Changed: the **Brushes panel** shows the brush presets in groups (0.4's built-ins are in General Brushes, Airbrushes
  and Special Effects Brushes) with search, recent brushes, three views, drag and drop, and Import / Export of every
  brush format. Its sliders for hardness, spacing, angle, roundness, flow and opacity moved to the Brush Settings panel
  (and the options bar); the Brushes panel keeps Size.
- Changed: **new brush presets** are saved in the brush preset library (with groups, Import and Export), not in the
  settings file; 0.4's own presets were moved there once (skeleton). Saving a preset can now include the tool's
  settings and the foreground colour.
- Changed: picking a preset in the Brushes panel or the options bar's picker runs the "Brush Preset" command, so an
  action records it with the brush's data (its tip image too) and plays it back where the preset does not exist.
- Changed: the options bar's brush button shows the tip's shape (and a dot when the brush differs from its preset); its
  popover has the angle and roundness control, search and the recent brushes; "Brush settings…" there opens the Brush
  Settings panel (0.4: the Brushes panel).
- Changed: the Size sliders of the Brushes panel and the picker go to 5000 px (0.4: 1000 px; tools that work dab by dab
  still stop at 1000 px).

## Known gaps

- **Texture and Dual Brush modes** are Pigment's reading of Photoshop's: each mode leaves the brush unchanged at depth
  0 and darkens toward the pattern's dark parts as Photoshop's do, but Linear Height, Height and Hard Mix are not
  measured against Photoshop.
- **Wet Edges** works on the whole stroke (the inside at half its alpha, the edges at full); Photoshop's exact falloff
  is not matched. On frames of more than a megapixel (very large brushes) the edge is measured on blocks a few pixels
  wide.
- **.abr**: build-up and the Smoothing box are written and read under the descriptor keys 'Rpt ' and 'Smoo', which
  ag-psd does not read and which are not checked against a Photoshop file; the brush hierarchy section ('phry') is
  skipped, so groups inside an .abr file are not recreated (the file becomes one group); 16-bit RLE samples are
  reported, not read; a brush's tool settings colour is not written (Photoshop's tool presets hold it, .tpl).
  Photoshop's brush packs are not bundled: the tests build their .abr files.
- **Brushes panel**: Photoshop's "Brush Name", "Brush Stroke" and "Brush Tip" view toggles are three views here; nested
  groups are shown one level deep; there is no "Show Additional Preset Info" or "Get More Brushes".
- **Locks** hold one set for every tool (Photoshop's also); "Reset All Locked Settings" is "Unlock All Settings".
- Brush Settings edits are not recorded in actions (tool options are not, as in 0.4); a picked preset is.
- Mixer Brush settings (Wetness, Mix in Transfer) are kept in presets and .abr files but not shown: the Mixer Brush is
  0.10.

## Third-party data

None bundled. The .abr reader uses ag-psd's descriptor reader, `parseBrushDescriptor` and `readPattern`, and the writer
ag-psd's `writePattern`, through the existing `#ag-psd` bundle (ag-psd, MIT, already listed).
