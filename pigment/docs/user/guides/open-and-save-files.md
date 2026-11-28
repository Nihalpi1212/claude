---
title: Open and save files
description: Open a PSD or other image in Pigment, and save it with its layers or as a flat copy.
order: 10
verified: 0.5.0
---

Open a file with **File › Open…** and keep your layers with **File › Save As…**, choosing **PSD Document** or **Pigment** as the type. Formats such as PNG and JPEG are flat: they hold one image with no layers.

## Open a file

1. Choose **File › Open…**.
2. Pick your file. The type menu in the dialog starts with **All Formats**, then lists each format by name (**Photoshop**, **Pigment**, **Affinity**, **GIMP**, **Krita**, **OpenRaster**, **Paint.NET**, **RAW images**, **SVG** and the flat formats).
3. Confirm in the dialog.

You can also reopen a recent file from **File › Open Recent**. Files you open or save also show in your system's recent lists: **Recent** in Windows Explorer and Start, **Apple menu › Recent Items** and the Dock menu on a Mac, and the recent files of your desktop and its file dialogs on Linux. **File › Open Recent › Clear Recent File List** also takes Pigment's files out of the Linux list; Windows and macOS keep theirs until you clear them there. With **Recent File List Contains** set to 0 in Preferences › File Handling, Pigment adds nothing. On Linux under Wayland, dropping a file on the window does not work yet; see [Install Pigment](../getting-started/install.md).

Pigment opens PSD and PSB (including 16-bit, 32-bit, CMYK and Lab files), layered TIFF, Paint.NET (`.pdn`), OpenRaster (`.ora`), GIMP (`.xcf`), Krita (`.kra`), SVG, and the flat formats PNG, JPEG, TIFF, WebP, GIF, BMP, TGA, ICO, QOI, PNM, PCX, OpenEXR, Radiance HDR, FITS, DPX and Cineon, DDS and Amiga IFF. HEIC and HEIF photos from iPhone and Mac open too, as do AVIF images (8, 10 and 12-bit, with transparency; animated AVIF does not open), and so do camera raw files such as DNG, CR2, NEF, ARW, RW2, PEF, ORF and RAF. Affinity files (`.af`, `.afphoto`, `.afdesign`, `.afpub`) open read only; Pigment cannot save them. Anything it cannot match exactly, such as layer effects and adjustments of another app, is approximated or left out, and Pigment shows a warning. JPEG XL files do not open, and Pigment cannot save AVIF.

`.pigment` files from Pigment 0.1 to 0.4 open as well, every kind of layer included: see [Open documents from Pigment 0.4 and earlier](open-pigment-0-4-documents.md).

## Save with layers

1. Choose **File › Save As…**.
2. Pick **PSD Document** (`.psd` or `.psb`) to share the file with Photoshop, or **Pigment** (`.pigment`) for Pigment's own format.
3. Name the file and save.

After that, **File › Save** saves into the same file. **File › Save a Copy…** saves a copy under a new name. While a large file saves, the status bar and the tab title show "Saving" with a percentage.

The **Save As…** dialog also lists OpenRaster, PNG, JPEG, JPEG XL, WebP, TIFF, Targa, OpenEXR, FITS and other flat formats. **File › Save** on an opened JPEG keeps its quality, and on a WebP keeps it lossy or lossless. Check the file extension in the name box: Pigment writes the format that the extension names. If you want a flat PNG or JPEG with a size and quality preview, use [Export an image](export-an-image.md) instead.

## Pigment's own format

A `.pigment` file saved by Pigment 0.5 holds the same format as PhotoCraft's `.pcraft` files, so Pigment opens `.pcraft` files and saves them back as they are. Pigment 0.4 cannot open the new `.pigment` files.

## Describe a file: File Info

**File › File Info…** shows and edits the file's description, as Photoshop's File Info does, in tabs:

- **Basic**: title, author, description, a **Rating** of 0 to 5 stars, the description writer, keywords and copyright, and when the file was created and changed and by which application.
- **Camera Data**: what the camera recorded (make and model, lens, exposure, aperture, ISO, flash, white balance and more), read only.
- **Origin**, **IPTC** and **IPTC Extension**: where and when the picture was taken, headline, credit, source, instructions, urgency, the creator's contact details, subject and scene codes, alt text for accessibility, the people, places and organisations shown, model and property releases, licensing and artwork. A field that holds a list takes several entries separated by `;`. For a list of places or licensors, the tab shows the first one.
- **GPS Data**: the position the camera recorded, read only.
- **Raw Data**: the XMP metadata as it is stored, with **Copy**.
- **Audio/Video Data**, **DICOM** and **Photoshop** (the history log) appear when the file has them.

Pigment saves the fields in the file's XMP metadata, and also keeps the IPTC copy that older applications read (in a PSD, and in a JPEG exported with **Metadata: All**) in step. A JPEG that has only that older IPTC copy opens with its fields filled in. OK adds one step to the History panel.

## Good to know

Saving a PSD again keeps the layers and the rendered result, but the file is not byte for byte the same as the one you opened. Pigment rewrites image resources, layer records and the composite. It keeps parts it does not model yet instead of dropping them. Photoshop does not yet open every PSD that Pigment writes exactly as Pigment shows it; keep your original file until you have checked the result.
