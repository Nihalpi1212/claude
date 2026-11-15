import json, sys
P = []
def r(a, b): P.append((a, b))
r("""Pigment 0.5 is "Photoshop parity, stage 3": a brush engine with tips, dynamics and pen-tablet input; the Brush
Settings and Brushes panels with .abr files; painting behaviours (straight lines, the on-canvas HUD, digit keys,
tip-shaped cursors); colour management through LittleCMS (document profiles, Assign Profile, profiles read and
embedded, wide-gamut display); PSD fidelity for layers (effects, vector masks, shapes, fill and adjustment layers,
blending options, labels) and for text (style and paragraph runs, PostScript names); the Camera Raw workspace and its
panels; the Styles, Shapes and Tool Presets panels; the Preset Manager and Photoshop preset files; the colour picker,
Color panel views, Swatches and colour books; the font menu (real styles, variable fonts, missing fonts); the Type menu
commands (Warp Text, outlines, type masks, anti-aliasing); the Keyboard Shortcuts and Menus editor; and Move tool
depth. It is built like 0.4: the **skeleton** lands first, then **fifteen packages** are built at the same time in one
checkout, then everything is integrated, hunted for cross-feature bugs, reviewed and released.""",
"""Pigment 0.5 is "Photoshop parity, stage 3": the brush engine, Brush Settings and Brushes panels with .abr, painting
behaviours, colour management through LittleCMS, PSD fidelity for layers and text, the Camera Raw workspace and
panels, the Styles, Shapes and Tool Presets panels, the Preset Manager and Photoshop preset files, the colour picker and
Swatches, the font menu, the Type menu commands, the shortcuts and menus editor, and Move tool depth. It is built like
0.4: the **skeleton** lands first, then **fifteen packages** are built at the same time in one checkout, then
everything is integrated, hunted for cross-feature bugs, reviewed and released.""")
r("""13. **The five paths.** Every package checks each of its features through: undo and redo (one history entry per
    gesture or command, with Photoshop's label); save and reopen as `.pigment` and as PSD (or its docs say why the
    field has no PSD form); action playback (commands with a replay argument, `record: false` for UI-only commands);
    16/32-bit documents and the non-RGB modes (Grayscale, Indexed, Duotone, CMYK, Lab and Bitmap are channel views
    over RGBA, 0.3); and the Electron build (the preload bridge, `pigment://` paths inside the asar, the native menu and
    its accelerators, file dialogs). Each package section names what applies.""",
"""13. **The five paths.** Every feature is checked through undo and redo (one entry per gesture or command, with
    Photoshop's label); save and reopen as `.pigment` and PSD (or the docs say why PSD cannot hold it); action
    playback (replay arguments; `record: false` for UI-only commands); 16/32-bit documents and the non-RGB modes
    (channel views over RGBA, 0.3); and the Electron build (preload bridge, `pigment://` inside the asar, the native
    menu and its accelerators, file dialogs). Each package section names what bites.""")
r("""The rename is mechanical: `paint.js` StrokeTool, the `BrushTool` / `PencilTool` / `EraserTool` overrides,
`retouch.js` DabTool, its subclasses and the stamps, and `adjustment-brush.js` define `strokeDown/Move/Up` where 0.4
defined `onPointerDown/Move/Up`; the Alt-click of the stamps and the Brush's Alt eyedropper stay inside their
`strokeDown`. Stub: `down → tool.strokeDown(p)`, and so on.""",
"""The rename is mechanical: every StrokeTool subclass (paint.js, retouch.js's DabTool family and stamps,
adjustment-brush.js) defines `strokeDown/Move/Up` where 0.4 defined `onPointerDown/Move/Up`; Alt-click handling stays in
`strokeDown`. Stub: `down → tool.strokeDown(p)`, and so on.""")
# S6.1 fix: the engine has no toDisplay; stages do it
r("""  adoptOnOpen(doc, { chunks, format }): void;
  toDisplay(canvas, view, { damage }): HTMLCanvasElement;  displaySpace(view): 'srgb' | 'display-p3';
}""",
"""  adoptOnOpen(doc, { chunks, format }): void;
  displaySpace(view): 'srgb' | 'display-p3';       // the display transform itself is a display stage (S6.4)
}""")
r("""**S6.4 Display.** `canvas-view.js paint()` draws `toDisplay(postProcessed, view, { damage })` where `postProcessed` is
0.4's `view.postProcess` result (proof colours, isolation, Select and Mask and mode previews keep working on document
numbers).""",
"""**S6.4 Display.** `canvas-view.js paint()` draws `toDisplay(postProcessed, view, { damage })` (pipeline.js: runs the
display stages) where `postProcessed` is 0.4's `view.postProcess` result (proof colours, isolation and the previews keep
working on document numbers).""")
r("""converts in under 60 ms on the CI runner.""", """converts in under 60 ms on the CI runner.""")
json.dump(P, open(sys.argv[1], 'w'))
