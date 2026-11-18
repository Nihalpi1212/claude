---
title: Text moves when I start editing a PSD text layer
description: A text layer from a Photoshop file can shift when you click it with the Type tool, because Pigment lays the text out itself. Pigment includes PhotoCraft's fixes for the known causes.
order: 20
verified: 0.5.0
---

Pigment reads the text's styles and position the way Photoshop saved them, so the text should stay where it was when you start editing it. Pigment 0.5 includes PhotoCraft's fixes for the known causes. If text still moves, keep your original file and report it with the PSD.

## Symptoms

- You open a PSD that was made in Photoshop and click one of its text layers with the **Horizontal Type Tool**. The text shifts, often to the left, as soon as editing starts.
- Centered text may show as left-aligned in the options bar.
- In some files, text that you click can disappear.

## Fix

1. Check your version with **Help › System Info…**. Pigment 0.5.0 and later include the fixes.
2. If the text still moves, choose **Edit › Undo** to go back, and keep a copy of the original with **File › Save a Copy…** before you edit further.
3. Report it with the PSD (zipped) and the Photoshop version that saved it; see [Get help with a problem](get-help.md).

## Why this happens

Clicking a PSD text layer with the Type tool starts editing it, and Pigment then lays the text out itself instead of showing the pixels Photoshop saved. Its type engine is not Photoshop's, so where a file stores the text's alignment, size or position in a way Pigment does not read yet, the text lands elsewhere. Older PhotoCraft releases read the alignment and size of each run of text only from Photoshop's default styles and ignored part of the position recent Photoshop versions store; both were fixed upstream ([PhotoCraft issue 3795](https://github.com/storytold/photocraft/issues/3795)).

## Still stuck?

See [Get help with a problem](get-help.md).
