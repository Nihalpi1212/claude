# Pigment 0.4: adjust-tonal

Package 7 of 0.4 ("Photoshop parity, stage 2"). The tonal adjustment dialogs finished: Levels, Curves, Exposure,
Threshold, Brightness/Contrast and Equalize, with eyedroppers, the on-image tool, Auto and Auto Color Correction
Options, adjustment presets (including Photoshop's .alv and .acv files), and the "last settings" commands.

## User guide

### The adjustment dialogs

Image › Adjustments opens each adjustment in a dialog that previews on the canvas. The same controls appear in the
Properties panel for an adjustment layer. From top to bottom:

- **Preset**: a menu of saved settings (see "Adjustment presets").
- **The adjustment's own controls** (below).
- **Eyedroppers and tools**: click a button, then click in the image. The canvas stays usable while the dialog is
  open: the click samples the image instead of using the active tool. The eyedroppers read the pixels before the
  adjustment (in Properties: everything below the adjustment layer, at full resolution) and average the area set by
  the Eyedropper tool's Sample Size (3 × 3 unless you changed it). Click the button again, or press Escape, to put the
  eyedropper down.
- **Auto**: sets the adjustment from the image. Alt-click (Option-click) Auto opens Auto Color Correction Options.
- **Preview**: turns the canvas preview on and off.

Image › Adjustments › Levels…, Curves…, Hue/Saturation… and Color Balance… open with the default settings, as in
Photoshop. To start from the values you used last, press **Alt+Ctrl+L**, **Alt+Ctrl+M**, **Alt+Ctrl+U** or
**Alt+Ctrl+B** (Option+Cmd on macOS). Shadows/Highlights, Replace Color, Match Color, HDR Toning and Color Lookup
still open with their last settings, as Photoshop's do.

### Levels

- **Channel**: the composite or one channel. The list follows the document's mode: RGB, Red, Green, Blue in RGB;
  Gray in Grayscale (also Duotone and Bitmap); CMYK, Cyan, Magenta, Yellow, Black in CMYK; Lightness, a, b in Lab.
  An adjustment layer keeps the channels it was made with.
- **The histogram** of the image (of the channel shown).
- **Input Levels**: drag the black, grey and white triangles, or type the three values (shadows, midtones gamma,
  highlights). Hold **Alt** while dragging the black or white triangle to see which pixels clip: the canvas turns
  white (or black) except where a channel clips, shown in its colour.
- **Output Levels**: the two triangles or fields limit the darkest and lightest output.
- **Eyedroppers**: the black eyedropper makes the clicked colour black (each channel's input shadows move to it), the
  white one makes it white, the grey one makes it neutral grey while keeping its brightness (with a non-grey midtones
  target colour, it becomes that colour). Grayscale documents have no grey eyedropper.

### Curves

- **Channel** as in Levels.
- **Points**: click the graph to add a point (up to 16), drag a point to shape the curve, drag it off the graph or
  press Delete to remove it; the arrow keys nudge the selected point (Shift: by 10). Input and Output show the
  selected point and can be typed.
- **Pencil**: draw the curve freehand. **Smooth** softens a drawn curve (click it several times for more). Switching
  back to Points turns the drawn curve into points that follow it.
- The **black and white sliders** under the graph move the curve's end points. With **Show Clipping** on (or Alt
  held), moving them shows the clipping display, as in Levels.
- **The on-image tool** (the button with the up-and-down arrow): click a tone in the image to add a point for it, and
  drag up or down to lighten or darken it.
- **Eyedroppers** as in Levels.
- **Curve Display Options**: show light (0–255) or pigment/ink percentages (the graph's axes reverse), a 4 × 4 or
  10 × 10 grid, and channel overlays, the histogram, the baseline and the intersection lines. These are remembered.

### Exposure, Threshold, Brightness/Contrast

- **Exposure** has Photoshop's three eyedroppers: black sets Offset so the clicked tone becomes black, white sets
  Exposure so it becomes white, grey sets Exposure so it becomes middle grey.
- **Threshold** shows the histogram with a slider for the level.
- **Brightness/Contrast** has Auto.

### Equalize

With a selection, Image › Adjustments › Equalize asks what to do: **Selected area only** equalizes the selection by its
own pixels; **Entire image based on selected area** measures the selection and applies the result to the whole layer.
Without a selection it equalizes the layer, as before.

### Auto Color Correction Options

Alt-click Auto in Levels or Curves (or Brightness/Contrast) to choose how Auto works:

- **Algorithm**: Enhance Brightness and Contrast, Enhance Monochromatic Contrast (one stretch for all channels),
  Enhance Per Channel Contrast (each channel on its own; the default) or Find Dark & Light Colors (the darkest and
  lightest colours become black and white).
- **Snap Neutral Midtones**: the nearly neutral midtones become neutral.
- **Target Colors & Clipping**: the colours the shadows, midtones and highlights go to, and how much of the darkest
  and lightest pixels may clip (0.1 % by default).
- **Save as defaults**: keeps these settings for the Auto buttons and for Image › Auto Tone, Auto Contrast and Auto
  Color (Auto Tone uses Per Channel Contrast, Auto Contrast Monochromatic Contrast, Auto Color Find Dark & Light Colors
  with Snap Neutral Midtones, each with your clipping and target colours). Until you save defaults, the three
  commands work as in earlier versions.

The options apply to the image while the dialog is open; Cancel goes back.

### Adjustment presets

The Preset menu at the top of Levels, Curves, Exposure, Brightness/Contrast and Threshold lists **Default**, the
built-in presets (Photoshop's lists: for Levels Darker, Increase Contrast 1–3, Lighten Shadows, Lighter, Midtones
Brighter, Midtones Darker; for Curves Color Negative, Cross Process, Darker, Increase Contrast, Lighter, Linear
Contrast, Medium Contrast, Negative, Strong Contrast; for Exposure Minus/Plus 1.0 and 2.0) and the ones you saved.
Picking one sets the dialog; changing anything afterwards shows **Custom**. The **⋯** button next to the menu has:

- **Save Preset…**: adds the current settings to the list under a name.
- **Load Preset…**: reads a preset file: Photoshop's Levels (.alv) or Curves (.acv) files, or Pigment's
  .pigment-presets. The preset is added to the list and applied.
- **Save to File…**: writes the current settings as a Photoshop .alv (Levels) or .acv (Curves) file, or a
  .pigment-presets file for the other adjustments.
- **Rename Preset…**, **Delete Current Preset** (a built-in one is hidden), **Reset Presets…** (back to the built-in
  list).

Presets are kept with your other presets (not in a document) and are there in every document and after a restart.
A preset made in one colour mode works in another: its composite goes to the composite and its channels to the
channels in order.

## Release notes

- Levels: input and output sliders with triangles, the clipping display with Alt-drag, black, grey and white point
  eyedroppers, Auto with Auto Color Correction Options, presets with Photoshop's .alv files, and channels in Gray,
  CMYK and Lab documents.
- Curves: pencil (drawn) curves and Smooth, black and white point sliders with Show Clipping, eyedroppers, the
  on-image tool, Curve Display Options, presets with Photoshop's .acv files, Auto and its options, channels in Gray,
  CMYK and Lab documents.
- Exposure eyedroppers; Threshold histogram and slider; Brightness/Contrast Auto.
- Equalize asks about the selection (selected area only, or the entire image based on it).
- Auto Color Correction Options, with Save as defaults for the Auto buttons and Image › Auto Tone / Contrast / Color.
- Adjustment presets for Levels, Curves, Exposure, Brightness/Contrast and Threshold: built-in lists, save, load,
  save to file, rename, delete, reset.
- New keys: Alt+Ctrl+L / M / U / B open Levels, Curves, Hue/Saturation and Color Balance with the last-used values.
- **Changed:** Image › Adjustments dialogs open with the default settings instead of the last-used ones (Photoshop's
  behaviour), except Shadows/Highlights, Replace Color, Match Color, HDR Toning and Color Lookup, which keep their last
  settings. Use the Alt+Ctrl keys above for the last values.
- **Changed:** the Levels dialog's Auto button moved from beside the Channel menu to the tool row under the editor and
  uses the Auto Color Correction Options (by default Enhance Per Channel Contrast at 0.1 % clipping, which is what 0.3's
  Auto did). The Curves dialog's own "Preset…" menu is replaced by the preset menu above the editor (the same curves,
  under Photoshop's names, plus more).
- **Changed:** Levels and Curves are drawn by the same code as before in RGB; their settings now carry a channel space
  (`space`), and an action or document saved by 0.4 with Levels or Curves in Gray, CMYK or Lab space, or with a drawn
  curve, is not understood by 0.3. 16 and 32-bit documents apply those (not RGB curves and levels) at 8 bits.
- Equalize run from an action recorded with a selection replays the choice made (`{ scope }`).

## Known gaps

- The clipping display (Alt-drag in Levels, Show Clipping in Curves) works in the dialogs; the Properties panel's
  editors do not show it yet, because the panel section (`lib/properties/adjustment.js`, adjust-color's) does not pass
  the preview hook the dialog passes (`clip`). The integrator or adjust-color can pass it.
- Levels' and Curves' output in the CMYK and Lab spaces is computed from the document's RGB pixels with Pigment's naive
  CMYK conversion and sRGB Lab, so it matches Photoshop only roughly (Pigment has no colour management).
- In 16 and 32-bit documents, flattening or exporting at full depth applies a Levels or Curves *layer* in CMYK or Lab
  space through tables exact for neutral pixels only (deep.js reads the kind's `lut`); destructive edits are exact
  enough because the 8-bit result is taken over. Integrator item in PKG-adjust-tonal.md.
- Built-in preset values approximate Photoshop's (Adobe's numbers are not published).
- Auto Color Correction Options cannot be opened from the menus without a dialog (Photoshop has none either).
- The preset menu groups presets that come in groups (from a .pigment-presets file), but has no command to make a
  group or move a preset into one; that is the Preset Manager's job (0.5).
