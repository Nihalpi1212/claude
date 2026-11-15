# presets-panels (0.5, package 9)

The Styles, Shapes and Tool Presets panels, the tool preset picker of the options bar, Reset Tool and Reset All
Tools, tool presets for the type tools, the Layer Style dialog's Styles page with New Style and Make Default, Edit >
Define Custom Shape and the Custom Shape picker. Photoshop's files for these presets (.asl, .csh, .tpl) are
preset-files-manager's formats: the panels' Import and Export list them.

## User guide

### Styles panel (Window > Styles)

A style is a set of layer effects (and, if you choose, blending options) kept as a preset.

- **Click** a style to apply it to the active layer. It replaces the layer's effects, as in Photoshop: one step in the
  History panel ("Apply Style"), undone with Edit > Undo.
- **Shift-click** adds the style's effects to the layer's (an effect the style has replaces the layer's own of that
  kind; the others stay).
- **Drag** a style onto a layer in the Layers panel to apply it there, or onto the canvas to apply it to the layer
  under the pointer (the active layer when there is none).
- **Clear Style** (the first button under the list) removes the active layer's effects and blending options.
- **New Style** (the + button, or New Style… in the menu) makes a style from the active layer: tick Include Layer
  Effects and, if you want them in the style, Include Layer Blending Options (blend mode, opacity, fill opacity and
  the advanced options).
- The folder button makes a group; drag styles onto a group's heading to move them into it, onto another style to
  reorder them. Double-click a style or a group to rename it. Ctrl-click (Cmd-click on macOS) selects several, for
  Delete and Export Selected.
- The menu has the views (Small Thumbnail, Large Thumbnail, Small List, Text Only), the Preset Manager, Pigment's own
  style library, **Import Styles…** (Photoshop .asl and Pigment preset files), **Export Selected Styles…**, **Export All
  Styles…**, **Replace Styles…** and **Reset Styles…**.

Pigment comes with a **Basics** group: Drop Shadow, Inner Shadow, Bevel and Emboss, Outer Glow, Stroke and Color
Overlay.

Styles that use patterns (a Pattern Overlay, a pattern Stroke, the Bevel and Emboss Texture) name a pattern of the
Patterns panel. New Style adds a pattern the Patterns panel does not have yet. If a style's pattern has been deleted,
that effect is applied switched off and Pigment says which pattern is missing.

### Layer Style dialog: Styles, New Style, Make Default

- **Styles**, the first entry of the dialog's list, shows the styles. Click one to use its effects in the dialog
  (Shift-click adds them); nothing is applied to the layer until you click OK. The dialog still opens on Blending
  Options.
- **New Style…** (under the list) saves what the dialog shows as a style.
- Each effect's page has **Make Default** and **Reset to Default**. Make Default keeps the page's values as that
  effect's default: an effect a layer does not have yet starts from them in the dialog, and Reset to Default goes back
  to them (to Pigment's defaults until you made one). Patterns are not part of a default.

### Shapes panel (Window > Shapes) and the Custom Shape tool

- **Click** a shape to make it the Custom Shape tool's shape.
- **Drag** a shape onto the canvas to make a shape layer there, filled and stroked as the Custom Shape tool's options
  say, a quarter of the document's shorter side across, in the shape's own proportions. Dragged onto a layer in the
  Layers panel, the shape layer is made above that layer, in the middle of the document. Either is one History step.
- **Edit > Define Custom Shape…** (or the + button) makes a shape from the current path: the path chosen in the Paths
  panel, else the work path, else the active shape layer's path. With the Path Selection tool, only the selected path
  components are used. The shape keeps its proportions and its size (Defined Size and Defined Proportions in the
  Custom Shape tool's options use them) and becomes the tool's current shape.
- The Custom Shape tool's options bar shows the shape as a button: click it for the shape picker.
- The menu has the views, the Preset Manager, Pigment's own shape library, Import (Photoshop .csh and Pigment preset
  files), Export, Replace and Reset.

A custom shape layer keeps its own outline: deleting the shape from the panel, or opening the document where the
shape
is not installed, does not change the layer.

### Tool presets (Window > Tool Presets, and the options bar)

A tool preset keeps a tool with all its options: for painting tools also the brush (its tip, including a sampled
tip, and every Brush Settings section), for the Type tools the font, size, style, alignment and the other character
and paragraph settings, and, if you tick Include Color, the foreground colour.

- The tool's icon and name at the left of the options bar open the **tool preset picker**: click a preset to use it.
  The + button saves the current tool as a **New Tool Preset**; the gear menu has everything the panel's menu has.
- **Current Tool Only** (in the picker and at the bottom of the panel; the two follow each other) lists the active
  tool's presets alone; untick it to see every preset. Picking a preset of another tool switches to that tool.
- Picking a Type tool preset while a text layer is selected does not change that layer: the preset is for the next
  text you type.
- The menu: New Tool Preset…, Rename, Delete, **Sort by Tool**, Show All / Show Current Tool Presets, the views,
  **Reset Tool** (the active tool back to its defaults), **Reset All Tools** (asks first), the Preset Manager, **Reset
  Tool Presets…**, **Import Tool Presets…** (Photoshop .tpl and Pigment preset files), **Export Selected Tool
  Presets…**, **Export All Tool Presets…** and **Replace Tool Presets…**. An exported tool preset carries its brush's
  tip image, so it works on another computer.

Choosing a tool preset and applying a style are recorded in actions with everything they need: the action plays the
same on a computer that does not have the preset. Define Custom Shape is recorded with the shape's outline. Reset Tool
and Reset All Tools are not recorded.

## Release notes

- New: Styles panel, Shapes panel and Tool Presets panel (Window menu), with groups, views, import and export of
  Photoshop .asl, .csh and .tpl files.
- New: tool preset picker in the options bar, New Tool Preset, Current Tool Only, Reset Tool and Reset All Tools.
- New: tool presets for the Type tools.
- New: Edit > Define Custom Shape…; the Custom Shape tool's shape is chosen from a picker of the Shapes library.
- New: the Layer Style dialog has a Styles page, New Style…, and Make Default / Reset to Default on each effect.
- New: six built-in styles in a Basics group.
- Changed: the options bar's tool icon and name are a button (the tool preset picker), for the tools of the toolbox.
- Changed: the Custom Shape tool's Shape option is a picker of shape thumbnails instead of a list of names.
- Changed: the Layer Style dialog's "Reset to default" button is **Reset to Default** and resets to the default made
  with Make Default when there is one; the list starts with a **Styles** row.
- Changed: a new custom shape layer keeps its outline in the layer (`shapeProps.unit`) from the start, so it draws the
  same when its shape is deleted or not installed.
- Changed: Defined Size and Defined Proportions of a shape defined in Pigment or read from a .csh file use the size it
  was made at (0.4's built-in shapes keep 100 px per unit).

## Known gaps

- Make Default does not keep patterns (a default holds plain values; the current pattern fills a pattern field).
- Photoshop's Styles panel menu items that change the preview (Text / Shape previews) are not offered: thumbnails are
  drawn on a grey square.
- Dropping a style on the canvas picks the layer by its pixels (as the Move tool's auto-select does); a style dropped
  on an adjustment layer is refused (they take no effects).
- There are no Pigment-made tool preset libraries (preset-files-manager ships none for this kind).
- Panel actions (new group, rename, delete, reorder, New Style, New Tool Preset) change preset libraries, not the
  document: they are not History steps and are not recorded in actions, as in Photoshop.
