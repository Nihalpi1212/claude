---
title: Open documents from Pigment 0.4 and earlier
description: Pigment 0.5 opens the .pigment files of Pigment 0.1 to 0.4, says what it converted differently, and asks before saving over them.
order: 15
verified: 0.5.0
---

Open a `.pigment` file from Pigment 0.1 to 0.4 with **File › Open…** as any other file: Pigment recognises it by its content and converts it, every kind of layer included. The first **File › Save** asks before it writes the new format over the old file.

## Open the document

1. Choose **File › Open…** (or drop the file on the window, or pick it in **File › Open Recent**).
2. Pick the `.pigment` file.
3. Read the notes shown after it opens: they list what was drawn differently or left out, one line each, with the layers they concern. When nothing is listed, everything came over exactly.

## What is converted exactly

- The document: its size, resolution, image mode (Bitmap, Grayscale, Duotone, Indexed Color, RGB) and 8, 16 or 32 bits per channel.
- Pixel layers and groups, adjustment, fill, shape, type and smart-object layers, with their opacity, fill opacity, blend mode, locks and clipping, their layer masks (with density and feather) and vector masks.
- The settings of every adjustment and every layer style, and advanced blending (Blend If, knockout, channels).
- Type, as type you can edit: its text, fonts, character settings (size, tracking, kerning, leading, scale, baseline shift, faux bold and italic, caps, superscript and subscript, underline, strikethrough, OpenType features) and paragraph settings (alignment, indents, spacing). Point type, paragraph boxes, type on a path and vertical type.
- Smart objects, with what they hold (a document or an image) and where they are placed. Copies of one smart object stay copies: editing the contents of one changes them all.
- The smart filters Pigment has: the blurs, Sharpen and Unsharp Mask, Smart Sharpen, High Pass, the noise filters, Mosaic, Fragment, Facet, Emboss, Find Edges, Solarize, Maximum, Minimum, Offset, Twirl, Pinch, Spherize, Ripple, Polar Coordinates, and the adjustments used as smart filters.
- Colour labels and linked layers, the selection, saved channels, guides, paths, the global light and **File › File Info…**.

## What is approximated

These come over with their settings but look a little different:

- Some adjustments and effects, because Pigment computes them as Photoshop does: Brightness/Contrast, Photo Filter, Color Balance, Vibrance, Selective Color, Exposure, the Curves spline, some shadows, glows and strokes.
- Type: Pigment's type engine lays it out, so a line can break elsewhere or a character sit slightly differently. A stroke on the characters becomes a **Stroke** layer effect.
- Smart objects that are turned or scaled, and smart filters, which Pigment's own filters draw.
- CMYK and Lab documents open in RGB: Pigment 0.4 kept RGB pixels for them. Multichannel documents open in RGB with their inks as spot channels.

## What is not converted

The notes after opening list these, so you know where to look:

- **Color and Vibrance**, **Clarity and Dehaze** and **Grain** adjustment layers keep their settings but change nothing yet.
- Smart filters Pigment does not have (Filter Gallery effects, Glowing Edges, Oil Paint and others) are left out; the smart object and its other filters stay.
- Type settings Pigment does not have: bulleted and numbered lists, hanging punctuation, justification spacing, hyphenation settings, tab stops, **No Break**.
- A stroke on a shape filled with a pattern.
- Smart objects nested more than 8 deep, and anything missing from a damaged file.

## Save in the new format

The document keeps its file. The first time you choose **File › Save**, Pigment asks: "Save in the new Pigment format? Pigment 0.4 will no longer be able to open this file."

- **Save** writes the new format over the old file.
- **Save As…** keeps the old file and saves the document as a new one.
- **Cancel** saves nothing.

Tick **Don't show again** to stop the question. After the first save the file is in the new format and **File › Save** does not ask again. Keep a copy of the old file if you still use Pigment 0.4.

## If the file does not open

A file that cannot be read says "This Pigment 0.4 file is damaged:" and why. Open it in Pigment 0.4 and save it again, or export it as PSD from there.
