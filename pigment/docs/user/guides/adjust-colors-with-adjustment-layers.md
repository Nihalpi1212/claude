---
title: Adjust colors without changing your pixels
description: Add a Curves, Levels or other adjustment layer in Pigment so you can change or switch it off later.
order: 20
verified: 0.5.0
---

Use **Layer › New Adjustment Layer** and pick an adjustment. The change sits on its own layer above your image, so your original pixels stay as they were and you can edit or hide the adjustment later.

## Add an adjustment layer

1. Open your image and click the layer the adjustment should sit above in the **Layers** panel.
2. Choose **Layer › New Adjustment Layer**, then an adjustment such as **Curves…**, **Levels…**, **Vibrance…** or **Hue/Saturation…**.
3. Change the settings in the **Properties** panel, which shows the settings of the new layer.

The same list is behind the button at the bottom of the **Layers** panel, labelled **Create new fill or adjustment layer** when you hover over it.

The adjustments in the menu are **Brightness/Contrast**, **Levels**, **Curves**, **Exposure**, **Vibrance**, **Hue/Saturation**, **Color Balance**, **Black & White**, **Photo Filter**, **Channel Mixer**, **Color Lookup**, **Invert**, **Posterize**, **Threshold**, **Gradient Map** and **Selective Color**.

## Limit it to one area

1. Select the area first, for example with the **Elliptical Marquee Tool**. See [Select part of an image and mask it](select-and-mask.md).
2. Add the adjustment layer as above.
3. With the adjustment layer active, choose **Layer › Layer Mask › Reveal Selection**. The adjustment now shows only inside the selection.

## Change it later

Click the adjustment layer in the **Layers** panel and edit its settings in **Properties**. Every step you take is also listed in the **History** panel.

## Apply an adjustment straight to the pixels

If you do not need to change it later, use **Image › Adjustments**, for example **Image › Adjustments › Curves…**. These change the pixels of the layer directly and are not kept as a separate layer.

## Read the colours in the Info panel

**Window › Info** shows the colour under the pointer in two readouts. To change what each one shows, open the panel
menu and choose a mode under **First Color Readout** or **Second Color Readout**: Actual Color (the document's own
channels), Proof Color (the numbers of **View › Proof Setup**'s profile), Grayscale, RGB Color, Web Color, HSB Color,
CMYK Color, Lab Color, Total Ink or Opacity. **Panel Options…** in the same menu sets both readouts, whether 16-bit
documents read 0–32768 or 0–65535, and a mode of its own for each Color Sampler. 32-bit documents show their values as
decimals, above 1.0000 for colours brighter than white.
