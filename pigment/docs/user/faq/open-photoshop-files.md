---
title: Can Pigment open my Photoshop files?
description: Pigment opens and saves layered PSD and PSB files and keeps what it does not understand yet.
order: 20
verified: 0.5.0
---

Yes. Pigment opens, edits and saves layered PSD and PSB files, including 16-bit, 32-bit, CMYK and Lab documents, smart objects and editable text.

When it saves the file again, the picture renders the same for 307 of the 309 files in the psd-tools test set PhotoCraft checks against. Parts Pigment does not model yet, such as raw blocks and descriptors, are carried over instead of being dropped. A re-saved file is not byte for byte the same as the original, because Pigment rewrites image resources, layer records and the composite. Photoshop does not yet accept every PSD Pigment writes exactly as Pigment shows it, so keep your original until you have checked the result.

Results vary from file to file. If a PSD does not open or looks wrong, report it with the file; see [Get help with a problem](../troubleshooting/get-help.md).

Pigment also opens layered TIFF, Paint.NET, OpenRaster, GIMP, Krita, SVG and Affinity files (Affinity read only), and many flat formats. The full list is in [Open and save files](../guides/open-and-save-files.md).
