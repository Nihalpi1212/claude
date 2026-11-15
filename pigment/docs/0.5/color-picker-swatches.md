# color-picker-swatches (0.5, package 11)

The Color Picker dialog, the HUD colour picker, the Color panel's views, sliders and ramps, the Swatches panel on the
preset store (groups, search, import and export), Color Libraries with colour books you load (.acb), the Eyedropper's
Sample Size and Sample choices, sampling anywhere on the screen, and Copy Color as Hex / HTML.

## User guide

### Color Picker

Every colour you choose in Pigment opens the same Color Picker: the foreground and background colour chips, every
colour box in a dialog (Stroke, Layer Style, the Preferences, New Document…), the options bar, the Character panel and
the shape fill and stroke popover. A colour box shows its colour; click it to open the picker. While the picker is
open the box (and what it changes) follows the colour you choose; **Cancel** puts the colour back.

- **The field and the slider.** The large square shows two components of the colour and the narrow slider beside it
  the third. The radio buttons beside **H, S, B, R, G, B, L, a, b** choose which component the slider shows (H, hue,
  is the default, as in Photoshop). Pigment remembers your choice.
- **The numbers.** Type HSB (degrees and percent), RGB (0–255), hexadecimal, Lab or CMYK numbers. A field takes
  effect when you leave it or press Enter. Lab numbers are those of the document's colour profile (D50 Lab once the
  colour engine is ready; a Lab colour the document's colours cannot hold is replaced by the nearest one, and the
  picker says so). CMYK numbers use Pigment's simple CMYK model until colour settings arrive (0.6).
- **New and current.** The top half shows the new colour, the bottom half the colour you started with: click it to go
  back. In a Grayscale, Bitmap or Indexed document the new colour shows what the document will paint.
- **Warnings.** A triangle means the colour cannot be printed as it is (the same test as View > Gamut Warning); a cube
  means it is not one of the 216 web-safe colours. Click either to take the closest colour that is. **Only Web
  Colors** limits the field and every entry to web-safe colours.
- **Sampling.** While the picker is open, click (or drag) in the image to take a colour from it, as with the
  Eyedropper (its Sample Size and Sample settings apply). **Sample Screen** picks a colour anywhere on your screen,
  also outside Pigment (the colour is converted from sRGB into the document's profile).
- **Add to Swatches** adds the colour to the Swatches panel. **Color Libraries** opens the colour books.
- **Preferences > Color Picker** chooses Pigment's picker or your system's, and the style of the HUD colour picker.

### HUD colour picker

With a painting tool (Brush, Pencil, Mixer…), hold **Alt+Shift** and drag with the right mouse button on the image
(macOS: **Ctrl+Alt+Cmd** and drag). A small picker appears where you pressed, with the current colour under the
pointer. Drag in the square to change saturation and brightness, or across into the hue strip (the ring of the Hue
Wheel style) to change the hue; back in the square the new hue stays. The foreground colour changes as you drag.
Release to keep it (it joins the recent colours); press **Escape** while dragging to put the colour back. Preferences
> Color Picker > HUD color picker offers Hue Strip and Hue Wheel, each small, medium or large. Choosing a colour this
way is not a step in the History panel, as in Photoshop.

### Color panel

The panel menu (the "…" button) offers:
- three views: **Hue Cube** (the saturation and brightness square with a hue bar and the HSB, RGB and hex fields),
  **Brightness Cube** (hue across, saturation down, brightness on the slider) and **Color Wheel**;
- the sliders: **Grayscale, RGB, HSB, CMYK, Lab** or **Web Color** sliders (each track shows where it leads), or none;
- a colour ramp: **RGB Spectrum, CMYK Spectrum, Grayscale Ramp** or **Current Colors** (foreground to background),
  with **Make Ramp Web Safe**; click or drag in the ramp to pick (Alt: the background);
- **Copy Color as HTML** (COLOR="#ff8800") and **Copy Color's Hex Code** (ff8800).

A warning triangle beside the colour chips means the colour cannot be printed as it is; click it for the closest
printable colour.

### Swatches panel

- **Click** a swatch for the foreground colour, **Alt-click** (or Ctrl/Cmd-click) for the background.
- The **+** button adds the foreground colour; **New Swatch…** in the menu asks for a name. Double-click a swatch to
  rename it.
- **Groups**: the folder button makes a group (the selected swatch goes into it). Drag a swatch onto a group's heading
  to move it there, or use Move to… in its context menu. Click a heading to fold the group; right-click it to rename,
  ungroup or delete the group.
- **Search**: type part of a name (or a hex code) to show only the swatches that match.
- **Recent** shows the colours you used last.
- The menu has the views (Small and Large Thumbnails, Small List), Color Libraries, the Preset Manager, Pigment's own
  swatch libraries, **Import Swatches…** (Photoshop .aco and .ase, Pigment preset files), **Export Selected / All
  Swatches…**, **Replace Swatches…** and **Reset Swatches…**.
- Right-click a swatch for Copy Color as HTML / Copy Color's Hex Code.

Swatches are kept with your presets (the presets folder; in the browser build, the browser's storage). A swatch keeps
the numbers it was made with: RGB, Lab (from a colour book or typed in the picker), CMYK or grey. A palette edited in
Pigment 0.4 moves into the new Swatches panel the first time 0.5 starts.

### Color Libraries

Color Libraries (in the Color Picker, and in the Swatches panel's menu) shows colour books: choose a book, then a
colour; type a name or a number to find it. **Load Book…** adds a book from an Adobe Color Book file (.acb) or an
.ase file; opening or dropping an .acb file on Pigment adds it too. Pigment comes with no licensed books (TOYO, DIC,
HKS, ANPA, FOCOLTONE, TRUMATCH and others): load the .acb files you have. **Remove Book** takes a book out of Pigment.
**Picker** goes back to the Color Picker. A book colour keeps its book, name and Lab or CMYK numbers when you add it
to the swatches.

### Eyedropper

- **Sample Size**: Point Sample, or the average of 3 by 3 up to 101 by 101 pixels.
- **Sample**: Current Layer, Current & Below, All Layers, All Layers No Adjustments, Current & Below No Adjustments.
- **Show Sampling Ring**.
- **Sample Screen** (options bar), or drag from the image and release anywhere on the screen, picks a colour outside
  the image.
- Right-click the image for the sample sizes, **Copy Color's Hex Code** and **Copy Color as HTML** (the foreground
  colour).

## Release notes

- New: the Color Picker with the nine axes, Only Web Colors, the out-of-gamut and web-safe warnings, sampling the
  image and the screen while it is open, Lab numbers of the document's colour profile, Add to Swatches with Lab,
  CMYK and book colours, Color Libraries.
- New: every colour box (dialogs, options bar, Character panel, shape popover, lens correction grid) is a swatch that
  opens the Color Picker, instead of the system colour chooser. Preferences > Color Picker > System brings the
  system's chooser back (in a small dialog).
- New: the HUD colour picker (Alt+Shift+right-drag with a painting tool; Ctrl+Alt+Cmd+drag on macOS), Hue Strip or
  Hue Wheel, small, medium or large.
- New: Color panel views (Hue Cube, Brightness Cube, Color Wheel), sliders (Grayscale, RGB, HSB, CMYK, Lab, Web),
  colour ramps, the out-of-gamut warning, Copy Color as HTML / Hex Code.
- New: Swatches panel groups, search, views, Import / Export (.aco, .ase), Reset and Replace; swatches live in the
  preset store and keep Lab, CMYK and grey numbers.
- New: Color Libraries and .acb colour books (no licensed books are shipped).
- New: Eyedropper Sample Size up to 101 by 101, the five Sample choices, Sample Screen, Copy Color as Hex / HTML.
- Changed: the Eyedropper's Sample menu names are Photoshop's ("All Layers" and "Current Layer" keep their stored
  values, `merged` and `layer`); the "11 × 11 average" labels read "11 by 11 Average".
- Changed: 0.4's edited swatch palette (settings `swatches`) moves into the `swatches` preset kind once
  (`settings.colorUI.swatchesMigrated`); the Swatches panel no longer writes settings `swatches` / `swatchesEdited`.
- Changed: the Color Picker's Lab fields read D50 Lab of the document's profile (icc-engine) instead of 0.4's sRGB D65
  Lab: pure red reads L 54 a 81 b 70 instead of L 53 a 80 b 67 (as in Photoshop).
- Changed: Reset All Settings also resets the Swatches panel to the default swatches (its confirmation already said
  so).
- New settings (namespace `colorUI`): `pickerAxis`, `webOnly`, `panel` ({ view, sliders, ramp, webRamp }),
  `swatchesView`, `swatchesCollapsed`, `lastBook`, besides the declared `picker`, `hud`, `swatchesMigrated`.

## Known gaps

- CMYK numbers (fields, sliders, the printing warning) use Pigment's simple CMYK model; real CMYK profiles come with
  color settings (0.6) and CMYK documents (0.10).
- The colour field and the panel views are not colour-managed (they show the document's numbers as sRGB), as the
  other panel images (S6.4).
- Pigment ships no colour books (licensing); .acb books are read, not written.
- The System picker is the operating system's colour chooser inside a small dialog; when the system does not open it
  by itself, click its swatch.
- Sampling the image while the picker is open works when the picker is the only dialog (a picker opened from another
  dialog, such as Layer Style, does not let clicks through to the image).
- The HUD's "lock the hue" behaviour is by zone (the hue stays once you move back into the square) rather than
  Photoshop's held-key lock.
