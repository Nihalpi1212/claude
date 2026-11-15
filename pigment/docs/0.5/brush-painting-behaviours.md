# brush-painting-behaviours

How the painting tools behave under the pointer and the keyboard: straight lines, the axis lock, the on-canvas resize
HUD, the HUD colour picker gesture, the number keys, the mode and preset keys, the tilde eraser, the pen's eraser end,
tip rotation with the arrow keys, and the brush cursors with their preferences. Everything here applies to the Brush,
Pencil, Eraser, Clone Stamp, Pattern Stamp, History Brush, Adjustment Brush and the retouching tools (Blur, Sharpen,
Smudge, Dodge, Burn, Sponge, Color Replacement, Background Eraser, Healing Brush, Spot Healing Brush) unless a line says
otherwise.

## User guide

### Straight lines

- **Shift-click** draws a straight line from where your last stroke with that tool ended (in the same document) to
  where you click. The line is one stroke: one step in the History panel, undone in one go. Keep clicking with Shift
  held to draw connected lines. The retouching tools draw lines too (a Burn line darkens along the line).
- **Shift-drag** keeps the stroke horizontal or vertical: it follows the direction you first move in. Pressing Shift in
  the middle of a stroke holds it straight from that point; releasing Shift lets it follow the pointer again.
- While Shift is held between strokes, a dashed line shows where a click would draw.
- Smoothing does not bend or shorten a straight line.

### Resize the brush on the canvas (HUD)

- **Windows and Linux**: hold **Alt** and drag with the **right** mouse button (or the pen's side button).
- **macOS**: hold **Control+Option** and drag.

Drag left or right to change the size, up or down to change the hardness (up is harder). In Preferences > Cursors you
can set the vertical drag to change the opacity instead. The brush shows at the point where you started, in the brush
preview colour, as soft and as strong as it will paint, with its values below it. Press **Esc** before releasing to put
the values back. The HUD changes the tool's options, not the image: it adds nothing to the History panel. Holding Alt
first (the temporary Eyedropper) or Control first on macOS (the temporary Move tool) does not get in the way: the drag
resizes the brush and samples no colour or moves no layer.

### HUD colour picker

- **Windows and Linux**: hold **Alt+Shift** and drag with the right mouse button.
- **macOS**: hold **Control+Option+Command** and drag.

The colour picker appears at the pointer; drag to choose the foreground colour and release to keep it, or press
**Esc** to go back to the colour you had. (The picker itself comes with the Color Picker and Swatches work of this
release; until it is there the gesture does nothing.)

### Sampling a colour

Hold **Alt** while the Brush, Pencil or Color Replacement tool is active and click: the Eyedropper samples the
foreground colour (as in 0.4).

### Number keys

With a painting tool active:

- **1** to **9** set the opacity to 10 % to 90 %, **0** to 100 %. Type two digits quickly (within 0.6 s) for an exact
  value: **4** **5** is 45 %, **0** **5** is 5 %, **0** **0** the least the tool allows.
- **Shift+1** to **Shift+0** set the flow the same way.
- With the airbrush on, the two swap: the digits set the flow and Shift+digits the opacity, as in Photoshop.
- Tools without an opacity set their own amount: Blur, Sharpen and Smudge their Strength, Dodge and Burn their
  Exposure, the Sponge its Flow.
- With any other tool (the Move tool, for example) the digits set the selected layers' opacity and fill, as before.

### Mode keys

With a painting tool active, **Shift+Alt+letter** sets the tool's painting mode (the layer's blend mode is left
alone): N Normal, I Dissolve, **Q Behind**, **R Clear**, K Darken, M Multiply, B Color Burn, A Linear Burn, G Lighten,
S Screen, D Color Dodge, W Linear Dodge (Add), O Overlay, F Soft Light, H Hard Light, V Vivid Light, J Linear Light,
Z Pin Light, L Hard Mix, E Difference, X Exclusion, U Hue, T Saturation, C Color, Y Luminosity.

- Dodge and Burn: **Shift+Alt+S** Shadows, **M** Midtones, **H** Highlights.
- Sponge: **Shift+Alt+D** Desaturate, **S** Saturate.
- Color Replacement: **Shift+Alt+C** Color, **U** Hue, **T** Saturation, **Y** Luminosity.

A mode the tool does not have leaves the key to the layer, as before. Shift+Alt+P with a painting tool is the airbrush.

### Brush preset keys

- **,** (comma) and **.** (period): the previous and the next brush in the Brushes panel's order (wrapping round).
- **Shift+,** and **Shift+.**: the first and the last brush.

### Erase with the current brush (tilde)

Hold the **`** key (tilde, left of 1) while painting with the Brush or the Pencil: the stroke erases with that tool's
own brush (its size, hardness, dynamics and texture). On a layer whose transparency is locked it paints the background
colour, on a layer mask it hides, as the Eraser does. Release the key and the tool paints again.

### The pen's eraser end

Turn the pen over and erase: a stroke with the pen's eraser end is an Eraser tool stroke, with the Eraser's own size
and settings, whatever tool is active. The active tool stays selected; the next stroke with the tip paints with it.

### Rotate the brush tip

**Right arrow** turns the tip 1° clockwise, **Left arrow** 1° back; with **Shift**, 15°. This sets the tip's angle (Brush
Settings > Brush Tip Shape) of the Brush, Pencil, Eraser, the stamps, the History Brush and the Adjustment Brush; a
round tip shows the change once its roundness is below 100 %.

### Cursors

Preferences > **Cursors and tools** > **Painting cursor**:

- **Standard**: a small dot at the pointer.
- **Precise**: a crosshair.
- **Normal Brush Tip** (the default): the outline of the brush where it paints at least half strength. For a soft
  brush this is smaller than its size, as in Photoshop.
- **Full Size Brush Tip**: the whole brush.

The outline is the real tip: its angle, roundness and flips, and the shape of a sampled tip. **Caps Lock** shows the
crosshair whatever is set (switch it off to see the brush again).

Preferences > **Cursors**:

- **Show crosshair in brush tip**: a small crosshair at the centre of the outline.
- **Show only crosshair while painting**: the outline disappears while you paint, and comes back when you release.
- **Other cursors**: Standard, or Precise (the crosshair for the tools that would show the arrow).
- **Brush preview colour**: the colour of the resize HUD's brush (red by default).
- **Brush leash colour**: the string drawn in Pulled String smoothing (blue by default).
- **Resize HUD, vertical drag**: Hardness (default) or Opacity.

## Release notes

- New: Shift-click straight lines from the end of the last stroke (one History step), and Shift-drag held to the
  horizontal or vertical, for every painting and retouching tool.
- New: on-canvas brush resize HUD: Alt+right-drag (Windows, Linux) or Control+Option-drag (macOS); left/right size,
  up/down hardness or opacity.
- New: HUD colour picker gesture: Alt+Shift+right-drag (Windows, Linux) or Control+Option+Command-drag (macOS).
- New: number keys set the painting tool's opacity, Shift+number keys its flow; two quick digits set an exact value.
- New: Shift+Alt+letter sets the painting tool's mode, with Behind (Q) and Clear (R); Dodge, Burn and Sponge get
  their Range and Mode keys.
- New: , . Shift+, Shift+. step through the brush presets.
- New: hold ` (tilde) to erase with the current brush; the pen's eraser end erases with the Eraser.
- New: Left / Right arrows rotate the brush tip (1°, Shift 15°).
- New: the brush cursor follows the real tip (angle, roundness, sampled shapes); Normal and Full Size Brush Tip
  cursors; Caps Lock for the crosshair; Preferences > Cursors.
- Changed key: with a painting tool active, the digits and Shift+digits set the tool's opacity and flow (0.4: they did
  nothing with a painting tool; with any other tool they still set the layer's opacity and fill).
- Changed key: with a painting tool active, Shift+Alt+letter sets the tool's mode, not the layer's blend mode (0.4 set
  the layer's whatever the tool). With other tools it is the layer's, as before. In Electron on Windows and Linux the
  same goes for the keys the application menu takes first.
- New keys with a painting tool: , . Shift+, Shift+. (brush presets), ` held (erase), Left / Right (tip angle), Alt+right
  drag and Alt+Shift+right drag (HUDs).
- Changed default look: "Normal Brush Tip" (the default painting cursor, 0.4's "Outline") draws a soft brush's
  half-strength outline, smaller than 0.4's full circle; choose "Full Size Brush Tip" for 0.4's look. The outline now
  shows the tip's angle and roundness.
- Changed: a tip smaller than 6 screen pixels shows a crosshair instead of a tiny circle (0.4 showed a dot below 4).

## Known gaps

- **The HUD colour picker** is a gesture only: the picker it opens is color-picker-swatches' (S7.1, review decision 2);
  until that lands the gesture opens nothing and changes nothing.
- **Standard cursors** are Pigment's own cursors (a dot for painting tools, the crosshair or arrow for the others), not
  Photoshop's tool-icon cursors.
- **The paint keys are not recorded in actions**, like the other tool-option keys ([ and ], the tool letters): each
  carries a replay argument (`{ tool, key, value }`; the preset keys replay as `tool:brush-preset` with the preset id),
  so a step inserted by hand replays exactly.
- **The resize HUD is not a command**: it writes the tool's options live, as dragging the options bar's sliders does,
  and adds no History step (Photoshop does the same).
- **The pen's eraser end** does not switch the toolbox to the Eraser: the stroke is the Eraser's and the toolbox keeps
  the active tool. Hovering the eraser end does not change the cursor.
- **Tilde** erases with the Brush and the Pencil only (as in Photoshop); with the other tools it does nothing.
- **Arrow-key rotation** turns the tip of the tools with a full brush; the retouching tools' round dabs have no angle.
- Lines and axes are in document coordinates: with the view rotated, Shift-drag holds the image's horizontal or
  vertical, not the screen's.
