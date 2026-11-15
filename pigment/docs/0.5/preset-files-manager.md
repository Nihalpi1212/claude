# preset-files-manager (0.5, package 10)

The Preset Manager, Export/Import Presets, Migrate Presets, and Photoshop's preset files: patterns (.pat), gradients
(.grd), swatches (.aco, .ase), custom shapes (.csh), styles (.asl) and tool presets (.tpl). Brushes (.abr) are
brush-settings-panel's format (see its notes); every format here is opened, dropped and imported the same way.

## User guide

### Photoshop preset files

Open a preset file with **File > Open**, drop it on the window, or use **Import…** in a panel's menu or **Load…** in
the Preset Manager: Pigment adds its presets to the right library instead of opening a document. The presets of a
file go into a group named after the file, as in Photoshop.

| File | Goes to | Notes |
|---|---|---|
| .pat (Photoshop Patterns) | Patterns | RGB, Grayscale and Indexed patterns, with their transparency. |
| .grd (Photoshop Gradients) | Gradients | Solid gradients (with Foreground / Background stops, midpoints, transparency and smoothness) and noise gradients. Gradients read from Photoshop files use the Classic method, as they were made; Pigment's own files keep the method. Gradient files of Photoshop 5 (version 3) are not read. |
| .aco (Photoshop Swatches) | Swatches | RGB, HSB (read as RGB), CMYK, Lab and Grayscale swatches, with their names. Colour-book swatches (Pantone and others), which the file holds only as a book number, are skipped and reported. |
| .ase (Swatch Exchange) | Swatches | RGB, CMYK, Lab and Gray colours, their groups (inside the file's group), and the global / spot / process type. |
| .csh (Custom Shapes) | Shapes | Each shape keeps its outline and its proportions. |
| .asl (Styles) | Styles and Patterns | Each style's effects, and the patterns its effects use (added to Patterns; the style uses them from there). The advanced Blending Options of a style (knockout, Blend Interior Effects / Clipped Layers as Group, Transparency Shapes Layer, Layer Mask / Vector Mask Hides Effects) come with it; its blend mode, opacity and fill opacity are not part of Pigment's styles and are reported. |
| .tpl (Tool Presets) | Tool Presets, Brushes, Patterns | The tool, its options, the brush of a painting tool (with its tip image and texture pattern) and the character settings of a type tool. |

What a file holds that Pigment cannot use is listed in a message after the import. A damaged file imports what can be
read before the damage. Preset files over 64 MB are refused with a message.

To save presets as a Photoshop file, use **Export Selected…** or **Export All…** in a panel's menu (or **Save
Set…** in the Preset Manager) and type the Photoshop extension (for example `Mine.grd`); without one the file is a
Pigment presets file (.pigment-presets), as before.

### Edit > Presets > Preset Manager…

One window for every kind of preset. **Preset Type** chooses the library (Brushes, Swatches, Gradients, Styles,
Patterns, Contours, Custom Shapes, Tool Presets, then every other kind). Click a preset to select it, Shift-click to
select a range, Ctrl-click (Cmd-click on macOS) to add or remove one; Ctrl+A selects all.

- **Load…** imports preset files into the library.
- **Save Set…** saves the selected presets as a file (**Save All…** when nothing is selected).
- **Rename…** (or double-click) renames the selected presets one by one.
- **Delete** (or the Delete key) removes them. Deleted built-in presets come back with Reset.
- Drag presets to reorder them; dropped on a preset of another group, they move into that group.
- The menu button chooses the view (Text Only, Small Thumbnail, Large Thumbnail, Small List, Large List), **Reset**
  (back to Pigment's presets), **Replace…** (the presets of a file in place of the current ones) and the **Pigment
  libraries** of that kind.

Changes to presets are not document changes: they are not in the History panel and are kept as soon as they are made.

### Pigment libraries

Pigment comes with libraries of its own that you can load from the Preset Manager's menu: Web Safe Colors, Grays and
Hue Wheel (swatches), Pigment Gradients, Pigment Shapes, Pigment Patterns, Pigment Styles and Dry Media (brushes).
Loading one adds its presets in a group of their own.

### Edit > Presets > Export/Import Presets…

**Export Presets** saves your own presets (and the built-in presets you changed) of the types you tick into one file
(.pigment-bundle), with your settings for tools, brushes, painting, the colour picker, fonts and keyboard shortcuts.
Use it to move your presets to another computer or to keep a copy.

**Import Presets** reads a .pigment-bundle: choose the file, tick the types (and the settings) to import, and click
**Import Presets**. Presets already in your library are not added again. Imported settings apply after Pigment
restarts.

### Edit > Presets > Migrate Presets

Brings presets from an older Pigment: choose a bundle it exported, or its presets folder (the `presets` folder in its
settings folder; choosing the settings folder itself works too). Presets already in your library are skipped, so
migrating twice adds nothing.

## Release notes

- New: Edit > Presets > Preset Manager…, Export/Import Presets… and Migrate Presets (they were disabled in the 0.5
  skeleton).
- New: Photoshop preset files .pat, .grd, .aco, .ase, .csh, .asl and .tpl open, drop and import into their libraries,
  and the panels export them when the typed file name ends in their extension.
- New: Pigment-made preset libraries (swatches, gradients, shapes, patterns, styles, dry media brushes), loaded from
  the Preset Manager's menu.
- New: .pigment-bundle files (Export/Import Presets): opening or dropping one imports its presets; its settings are
  imported only from Edit > Presets > Export/Import Presets.
- New setting namespace `presetManager`: `kind` (the type last shown) and `view` (the view chosen), both written by
  the Preset Manager.

## Known gaps

- **.tpl layout.** Tool preset files are written and read in the layout of .abr files of version 6.2 (sections samp,
  patt and desc), which is how Pigment reads the format; it has not been checked against files Photoshop wrote,
  because none could be used in the tests. Pigment adds its own options as JSON text under a key of its own, so its
  files round trip exactly; a Photoshop file's tool options are read from the keys Photoshop's scripting uses
  (opacity, flow, mode, the type tool's text style). Presets of tools Pigment does not have are reported.
- **.asl blending options.** The advanced options are read from and written to the style's `blendOptions` under the
  names of Photoshop's scripting interface; their placement in a real .asl has not been checked against files
  Photoshop wrote. Bevel & Emboss texture depth and invert, and a pattern Stroke's link, are left out of .asl files
  Pigment writes (ag-psd's descriptor writer cannot type them; psd-layers' notes).
- **Gradient method.** A .grd file holds no interpolation method in Photoshop; Pigment writes Photoshop's own
  `gradientsInterpolationMethod` key inside each gradient so its own files keep the method; Photoshop ignores it.
  The Stripes method is written as Classic.
- **Version 3 .grd files** (Photoshop 5) are not read.
- **Swatch colour books.** .aco colours from colour books (Pantone and others) are skipped: the file stores only a
  book number. Spot colours of an .ase keep their type (`type: 'spot'` in the swatch's data) for a later export.
- **Grayscale swatches** (.aco and .ase) are read as ink percentages (0 is white), as Photoshop's Grayscale K.
- **Preset Manager.** Groups are shown as headers but are managed in each panel (new group, rename group); a drag
  between groups moves presets into the target's group. Deleting a preset with a side file other than a pattern
  (a brush tip, a font) leaves the side file in the library folder.
- **Replace…** removes the current presets only after the file imported at least one preset.

## Third-party notices

No third-party code or data is bundled by this package. The Pigment libraries in `src/renderer/presets/` are made by
Pigment (colours, gradients, shapes and patterns of its own). Reading uses ag-psd (MIT, already bundled) through the
skeleton's `#ag-psd` internals: `readCsh`, `readVersionAndDescriptor`, `writeVersionAndDescriptor`, `parseEffects`,
`serializeEffects`, `parseBrushDescriptor`, `createReader`, `createWriter`.
