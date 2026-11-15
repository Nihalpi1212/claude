# adjust-color (0.4 package 8)

Colour adjustment dialogs, the newer adjustments, adjustment presets and the Adjustment Brush.

## User guide

### Hue/Saturation

- **Edit** chooses Master or one of the six colour ranges (Reds, Yellows, Greens, Cyans, Blues, Magentas). Each has
  its own Hue, Saturation and Lightness; Master applies to every pixel, a range only to its colours (greys belong to
  no range). Several ranges can be changed in one adjustment.
- With a range selected, the **range bars** show the colours it affects: the top bar is the input, the bottom bar the
  result. The two inner handles mark where the range has its full effect, the two outer triangles where its fall-off
  ends; drag a handle to move one bound, or the dark band between the inner handles to move the whole range. The
  numbers under the bars are the four bounds in degrees (Photoshop's notation).
- **Eyedroppers**: the first picks the range of the colour you click and centres the range on it; **+** widens the
  range so the clicked colour gets the full effect; **−** narrows it so the clicked colour is no longer affected.
- **On-image tool**: click a colour in the image to edit its range, then drag left or right to lower or raise its
  saturation; Ctrl-drag (Cmd on macOS) changes its hue.
- **Colorize** tints the whole image with one hue (the ranges do not apply).
- **Presets**: Cyanotype, Further Increase Saturation, Increase Saturation, Old Style, Red Boost, Sepia, Strong
  Saturation, Yellow Boost; Save Preset, Load Preset (.ahu) and Save to File (.ahu, Photoshop's format).

### Black & White, Photo Filter, Channel Mixer, Selective Color, Gradient Map

- **Black & White**: **Auto** sets a grey mix that spreads the image's colours apart. The on-image tool: click a colour
  and drag left or right to change the slider for that colour. Presets: Blue Filter, Darker, Green Filter, High
  Contrast Blue Filter, High Contrast Red Filter, Infrared, Lighter, Maximum Black, Maximum White, Neutral Density, Red
  Filter, Yellow Filter; .blw files.
- **Photo Filter**: the **Filter** menu has Photoshop's list (Warming 85, LBA, 81, Cooling 80, LBB, 82, the colour
  filters, Sepia, Deep Red, Deep Blue, Deep Emerald, Deep Yellow, Underwater); choosing a colour of your own switches
  the menu to "Custom color".
- **Channel Mixer**: under the sliders, the **Total** of the source channels, with a warning when it is above 100 %
  (bright colours may clip). Presets: the six "Black & White with … Filter" and Infrared mixes; .cha files.
- **Selective Color**: presets and .asv files.
- **Gradient Map**: the full gradient field: click the bar to open the Gradient Editor, the arrow for the gradient
  presets; **Method** (the interpolation), **Reverse** and **Dither** (a little noise that hides banding).

### Shadows/Highlights

The dialog shows the two amounts. **Show More Options** (remembered) adds, for Shadows and for Highlights, **Tone**
(which tones count as shadows or highlights) and **Radius** (the size of the neighbourhood each pixel is compared
with), and the **Adjustments**: **Color** (saturation of the corrected areas), **Midtone** (midtone contrast), **Black
Clip** and **White Clip** (how many percent of the pixels may become black or white). The first use starts from
Photoshop's settings (Shadows 35 %, Tone 50 %, Radius 30 px, Color +20, clips 0.01 %); later uses from the last ones.

### HDR Toning

Presets (Flat, Monochromatic, Monochromatic High Contrast, Photorealistic, Photorealistic High Contrast, Saturated,
More Saturated, Surrealistic) and Save Preset. As before, a layered document is flattened first, after a question.

### New adjustments

Image > Adjustments and Layer > New Adjustment Layer (and the Adjustments panel) have three more:

- **Color and Vibrance**: Temperature, Tint, Vibrance, Saturation (Camera Raw's Color panel as a layer).
- **Clarity and Dehaze**: Clarity adds or removes midtone contrast around edges; Dehaze removes (or, negative, adds)
  haze.
- **Grain**: Amount, Size, Roughness. The grain belongs to the image position: it stays put when you paint or zoom.

### Adjustment layers in the Properties panel

Besides the editor: the preset menu, the eyedroppers and the on-image tool (they sample the image below the layer at
full resolution), Auto where the adjustment has one, and the toolbar's **View Previous State** button (also the `\`
key while the panel has focus): it shows the layer with the settings it had when you selected it, until you press it
again or change a setting. It adds nothing to the history.

### Adjustments panel presets

At the top of the Adjustments panel, **Adjustment presets** in six groups (Portraits, Landscape, Photo Repair,
Creative, Black & White, Cinematic). A preset adds its adjustment layers above the active layer, in a group named after
the preset when there are several, each with a mask (the selection, if any). One undo removes them all.

### Adjustment Brush tool

In the Brush tool group (Shift+B cycles to it). Choose the adjustment in the options bar and paint: the first stroke
adds an adjustment layer of that kind whose mask hides everything, and reveals the adjustment where you paint (the new
layer and the stroke are one undo step); the Properties panel opens to change its settings. While that layer is
selected, more strokes paint its mask. **Subtract** (or Alt while painting) hides the adjustment again.

## Release notes

- New adjustments: Color and Vibrance, Clarity and Dehaze, Grain (adjustment layers; enabled in Image > Adjustments,
  Layer > New Adjustment Layer and the Adjustments panel).
- Hue/Saturation edits several colour ranges at once, with movable range bounds, range eyedroppers, the on-image tool
  and presets. Its parameters gain `ranges` (default `[]`); 0.3's single-range layers open as Master plus that range
  and render as before. 16 and 32-bit documents apply layers with ranges through the 8-bit path.
- Gradient Map gains `dither` (default false) and the full gradient field (Gradient Editor, presets, method).
- Shadows/Highlights gains `shadowTone`, `highlightTone` (50), `shadowRadius`, `highlightRadius` (null: `radius`),
  `color`, `midtone`, `blackClip`, `whiteClip` (0). Without them a 0.3 setting gives 0.3's result. **Changed
  default:** the first Shadows/Highlights dialog starts with Photoshop's settings, including Color +20 and 0.01 %
  clipping (0.3: Shadows 35 % only).
- Photo Filter has the Filter menu; Channel Mixer shows the total; Selective Color has presets.
- Preset files read and written: .ahu (Hue/Saturation), .cha (Channel Mixer), .asv (Selective Color), .blw (Black &
  White).
- HDR Toning has presets; its "flatten first?" question is unchanged.
- New tool: Adjustment Brush, in the Brush group (after Color Replacement). Shift+B now cycles through four tools.
- New command `layer:adjustment-preset` (the Adjustments panel's presets; actions record it).
- The Properties panel's adjustment toolbar has View Previous State.
- PSD: as in 0.3, Hue/Saturation writes its Master only; Color and Vibrance, Clarity and Dehaze and Grain have no PSD
  adjustment and are written as hidden placeholders (the merged image is right).

## Known gaps

- Photoshop's range bars let the four bounds overlap the next range's; here a range stays under 360 degrees and its
  bounds stay in order.
- Black & White's Auto, the Channel Mixer and HDR Toning presets and the Photoshop-like built-ins approximate
  Photoshop's values (the names are Photoshop's).
- .blw files are read by parsing their descriptor; files Photoshop writes with keys this reader does not know are read
  for the six weights and the tint only. HDR Toning (.hdt) and Shadows/Highlights (.shh) files are not read yet.
- Clarity and Dehaze use fixed neighbourhoods (about 24 px), not one relative to the image size as Camera Raw does, so
  that a partial repaint matches a full one; Dehaze assumes white haze.
- The Adjustments panel presets are built-in only (no user presets), and hovering a preset does not preview it.
- The Properties panel does not show Levels' and Curves' clipping display (adjust-tonal's editors offer it in the
  dialog).
- PSD export of Hue/Saturation ranges and of the new kinds waits for psd-layers (0.5).
