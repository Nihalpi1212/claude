# Pigment 0.5 skeleton: release notes

The skeleton of 0.5 (shared stores, schemas, registries, every menu item and key binding of the release, stub modules)
changes a few keys, menus and behaviours of 0.4.0 on purpose. These lines go into the 0.5 release notes; the packages'
own lines are in the other files of this folder (rule 7). Where the code forced a detail the contract did not say, it
is listed in ARCHITECTURE.md, "0.5 features (contracts)", "The skeleton as landed".

## Keys (Photoshop's defaults)

| Key | 0.4 | 0.5 |
|---|---|---|
| F1 | (none) | Help > Pigment Help |
| F5 | (none; reloaded the browser build) | Window > Brush Settings |
| F6, F7, F8 | (none) | Window > Color, Layers, Info (they show and reveal the panel; Photoshop's toggle) |
| F12 | Toggle Developer Tools | File > Revert (never inside a text field or while editing text) |
| Shift+Ctrl+F12 (Shift+Cmd+F12) | (none) | Toggle Developer Tools (development builds only) |
| `,` `.` `Shift+,` `Shift+.` with a painting tool | (none) | previous, next, first, last brush preset |
| digits, Shift+digits with a painting tool | (none) | the tool's opacity and flow |
| Shift+Alt+letter with a painting tool | the layer's blend mode | the tool's blend mode (Shift+Alt+Q Behind, Shift+Alt+R Clear) |
| Shift+Alt+P with a painting tool | Pass Through | Airbrush on or off |

The painting-tool keys work once their packages land (brush-painting-behaviours, brush-engine-core); until then they do
nothing with a painting tool, as in 0.4, and the layer keys keep working with the other tools. No function key reaches
the browser any more (F5 never reloads the browser build). Every key can be changed in the keymap
(`settings.keymap`); an action's function key now takes the key from the application command it shadows, so the
native menu shows no accelerator for that command and only the action runs.

## Menus

- Edit: Define Brush Preset… (before Define Pattern…), Define Custom Shape… (after it); after Purge: Presets ▸ (Preset
  Manager…, Export/Import Presets…, Migrate Presets), Color Settings…, Assign Profile…, Convert to Profile…; Camera Raw
  Preferences… after Preferences… (on macOS both in the app menu, after Settings…).
- Type: Add Fonts… first; Anti-Alias ▸ after Panels; after Rasterize Type Layer: Convert to Paragraph Text / Point
  Text, Warp Text…, Create Work Path, Convert to Shape; then Font Preview Size ▸, Update All Text Layers, Manage Missing
  Fonts…, Replace All Missing Fonts, Paste Lorem Ipsum.
- Window: Color, Swatches, Gradients, Patterns, Styles, Shapes, then Brush Settings, Brushes, Tool Presets, then 0.4's
  list.
- Items stay disabled until their package lands, as in 0.4; Color Settings… and Convert to Profile… stay disabled until
  0.6.
- Menus can hide items (a menu that lost items ends with "Show All Menu Items") and colour them, once the shortcuts
  editor lands.

## Behaviour

- Brushes, Pencil, the stamps and the History Brush go up to 5000 px (DabTools stay at 1000 px). Each painting tool
  keeps its own brush; 0.4's Brushes panel presets move into the preset store once, under their ids
  (`settings.brushPresets` stays). Brush cursors: Standard, Precise, Normal Brush Tip, Full Size Brush Tip.
- Preset files: File > Open has a "Presets" filter, and opening or dropping a file that only a preset format reads
  (.pigment-presets, later .abr, .grd, .pat, .ase…) imports it instead of opening it; Shift-dropping it imports it too.
  The Gradients and Patterns panels' Export offers every format that writes them, `.pigment-presets` first.
- A custom shape remembers its outline after its first edit, so it keeps drawing when its preset is deleted.
- PSD: saving follows `settings.psd.maximizeCompatibility` (Always, by default, as 0.4); without it the file holds a
  white composite and no thumbnail. Notices a PSD reader reports are shown after the file opens (one toast per line).
- Colour: documents carry a profile (none until a colour engine lands, so every file is written byte for byte as 0.4
  wrote it). New Document has a Color Profile field; the Info panel and status bar show the profile once an engine is
  there. Save for Web and Image Processor convert a tagged document to sRGB.
- Camera Raw: its tabs come from a registry (0.4's four, in 0.4's layout). Last Filter (Alt+Ctrl+F) repeats it without
  the dialog and Last Filter Dialog opens it prefilled; given parameters from the assistant or a script it opens the
  dialog prefilled (an action and Last Filter apply them directly).
- Type: the options bar has an anti-aliasing menu with Photoshop's seven methods (the Character panel too), Toggle
  Orientation and Warp Text buttons; new text takes the options bar's anti-aliasing.
- Free Transform can be started from a handle drag (the Move tool's transform controls, move-tool-depth); it ends a
  temporary tool and keeps the drag going as one "Free transform" entry.

## Review decisions of the 0.5 contract

The fifteen decisions are listed in ARCHITECTURE.md, "0.5 features (contracts)", "Review decisions". The ones a user
notices: the panel F-keys show their panel rather than toggling it; Export As does not default to "Convert to sRGB";
panel menus are not customisable; Export/Import Presets asks for a restart to apply imported settings; warped text is
edited unwarped.
