---
title: Export an image
description: Export a PNG, JPG, GIF, WebP, TIFF, TGA, ICO or JPEG XL from Pigment with a preview, a size estimate and a scale.
order: 50
verified: 0.5.0
---

Choose **File › Export › Export As…**, set the format, and click **Export**. The dialog shows a preview and an estimate of the file size before you save. Your layered document is not changed.

## Export with settings

1. Choose **File › Export › Export As…**.
2. Under **File Settings**, pick a **Format**: **PNG**, **JPG**, **GIF**, **WebP**, **TIFF**, **TGA**, **ICO** or **JPEG XL**.
3. Set the options for that format:
   - **JPG** and lossy **WebP** have a **Quality** slider from 1 to 100.
   - **WebP** also has a **Lossless** checkbox.
   - **GIF** has only **Transparency**: with it off, transparent areas become white. A GIF holds up to 256 colours, chosen for the image.
   - **TGA** has **Resolution**: **Auto**, **24 bits/pixel** or **32 bits/pixel**.
   - **Transparency** keeps transparent areas. JPG has no transparency, so this checkbox is not shown for JPG and the image is flattened.
   - **Metadata** is **None** or **All**.
4. Under **Image Size**, set **Scale** in percent. The size in pixels shows below it.
5. Check the preview on the right. The line under it shows the format and the estimated file size.
6. Click **Export**, then choose a name and a place for the file.

Pigment shows "Exported" with the file path and size in the status bar when it is done.

## Export in one step

**File › Export › Quick Export as PNG** exports without asking about settings. It uses the format, quality, metadata and location you set in **File › Export › Export Preferences…**.

## Export layers

Choose **Layer › Export As…** (or **Layer › Quick Export as PNG**) to export only the active layer.

With several layers or artboards selected in the **Layers** panel, both commands export each one as its own file. You choose a name and place once. The first file gets that name, and the others get the same name with a number and the layer name added.

## Export color lookup tables

**File › Export › Color Lookup Tables…** saves what the document's adjustment layers do to colours as lookup tables other applications can load (video editors, games, other image editors).

1. Set **File**: the name and place. Each format gets its own extension.
2. Fill in **Description** and **Copyright**; every file carries them.
3. Pick **Quality**: **Poor** (7 grid points), **Low** (17), **Medium** (33), **High** (64) or **Maximum** (256), or **Custom** to type the **Grid Points**. An ICC profile holds at most 177 points, so with more it is written at 177.
4. Tick the formats: **3DL**, **CUBE**, **CSP** and **ICC Profile**. ICC profiles are written from RGB documents only.
5. **Use lowercase file extensions** writes `.cube`; turn it off for `.CUBE`.
6. **Scope** bakes all visible adjustment layers or only the selected ones.

## Keep your layers

Exporting makes a flat copy. To keep the layers, use **File › Save As…** with **PSD Document** or **Pigment**; see [Open and save files](open-and-save-files.md).
