# Tools and the brush engine: PhotoCraft beyond the inventory, and its limits

PhotoCraft clone abb30df (2026-11-15), compared with Pigment's docs/parity/tools.md (175 rows).

## (a) PhotoCraft features this page has no row for

Photoshop features the inventory missed:

- **Per-control pressure curves and a global pressure curve.** Every brush Dynamic has its own
  ResponseCurve (`crates/paint/src/brush.rs:47-60`, `Dynamic.curve`), plus Preferences › Tools ›
  Pressure Curve with Linear/Soft/Hard presets (`ui-egui` `pressure_curve_ui.rs`, TOOL-213-11).
- **Eraser: Erase to History** in Brush, Pencil and Block modes, with ⌥ at the press reversing it
  for that stroke (`paint.historyBrush` `eraseToHistory`, #10692). The page's Eraser row does not
  name it.
- **Shift+right-click painting menu**: Edit Brush… plus the tool's Mode list
  (`ui-egui/src/brush_mode_menu.rs`, #4929).
- **Right-click Brush Preset picker** on the canvas (partial: a pen barrel right-click with
  Windows Ink on often paints a dot, #5364).
- **Clone Stamp and Healing Brush from another open document**, with colour-mode and ICC
  conversion (`cloneSource.set` `document`).
- **Stroke Path with any brush-based tool and Simulate Pressure** (`path.stroke`, TOOL-214-11).
- **Make Symmetry Path** (`paint.symmetryFromPath`): symmetry along a custom path.
- **Star tool** as a separate shape tool (#11377).
- **Brush tip from any image file** (`brush.presets.importImage`, TOOL-213-12), not only from a
  selection.
- **Brush size and hardness keys on non-US keyboard layouts** (`layout_keys.rs`, #3109).
- **Keyboard shortcut sets and `.kys` import/export, plus per-tool shortcut editing**
  (`engine/src/kys.rs`, `shortcut_sets.rs`, `tool_shortcuts.rs`).
- **Selected colour channels constrain painting**: Shift-selected channel sets limit brushes,
  erasers and toning tools at native depths (docs/multi-channel-editing.md).
- **Exact CMYK inks when painting on a CMYK target** (`BrushSettings.color_cmyk`, #4344).
- **Painting a type, shape, smart or fill layer offers to rasterize it** (TOOL-213-5).
- **Remembered tools and colours across launches**: the last tool, each group's last tool, the
  foreground/background colours (incl. mask colours and CMYK picks) (`tool_memory.rs`).
- **Flick panning, Scroll All Windows, animated and press-and-hold zoom** (`flick_pan.rs`,
  `canvas/scroll_all_windows.rs`, `zoom_hold.rs`).
- **Crop: saved crop presets, W × H × Resolution, Front Image, image snapping in default mode**
  (TOOL-214-9, #8580).
- **Ruler protractor and Use Measurement Scale** (`tools/analysis_ui.rs`).

Beyond Photoshop:

- **Every tool is a scriptable command.** Strokes, retouching, selections and shapes are engine
  commands with typed JSON parameters (`paint.stroke`, `paint.remove`, `select.quick`, …), driven by
  actions, by the control channel and by MCP (docs/control-protocol.md, docs/mcp.md). Strokes
  replay exactly (seeded jitter, `seed`).
- **Classical, local, model-free replacements for Adobe's AI tools**: Remove tool by non-local patch
  completion (`algo/src/nonlocal.rs`), Object Finder and Object Selection by GrabCut/max-flow
  (`algo/src/segment*`), Quick Selection by a contrast-sensitive min cut, Magnetic Lasso by live wire.
- **Optional WinTab pen driver on Windows** (tilt with orientation axes, rotation with twist pens).
- **WebAssembly plug-in ABI v1** (docs/plugins.md); not tool-specific.

## (b) What limits PhotoCraft's real usefulness in this area

- **Open bugs.** gaps.md G3 counts 579 open issues (2026-10-10), 54 of them painting and 54
  selection, ~150 UI/panels/shortcuts. Its own readiness estimate for brushes is "breadth ~90%,
  ready for real work ~55%" (brush-parity.md summary); G4 Brush feel 100–180 h, G6/G9 more.
- **Brush feel and latency.** Lag with big brushes (#2619, #1994) and under the cursor (#2566,
  #1343); jumpy pressure on Windows (#2046); tap sensitivity (#1933); interpolation/smoothing
  (#2138, #2057) and soft-edge falloff (#2149, #1619) differ from Photoshop; pixelated cursor
  (#1433). Scorecard latency budgets P13/P16/P33 are over; P32 (hitch at mouse-up) is not measurable.
- **Performance budgets.** gaps.md G2: 22 of 25 budgeted scenarios over budget at the 2026-10-05
  baseline (layer move with styles 321 ms vs 25 ms, opacity change 276 ms vs 20 ms, paste 12 MP
  1.2 s vs 100 ms, Select Subject 559 ms vs 100 ms).
- **Crash.** The 150-layer nudge crashes the GPU compositor (P12, gaps.md G2).
- **Pen input is uneven by platform** (hardware-parity.md): the default Windows Ink path has no
  tilt or rotation, barrel rotation is not applied to the tip on macOS (#1301), native Wayland has
  no pen at all (only via Xwayland), GNOME 50 pen does not click (#2622).
- **Features that exist but are thin or facades**:
  - Path alignment and path arrangement menus are drawn but every entry is disabled
    (`ui-egui/src/tools/vector_ui/pen.rs:838-884`).
  - Preset Manager handles only brushes, custom shapes and patterns, as a text list with rename
    and delete (`engine/src/cmd/edit_menu_cmds/presets.rs:66`, `prefs_ui/dialogs.rs:240`).
  - Tool presets: no .tpl import or export.
  - Noise gradients absent; .grd noise gradients are skipped on import
    (`preset_import_cmds.rs:416`).
  - Shapes cannot take a pattern fill (`tools/shape_paint_ui.rs:25`).
  - Mixer Brush: no live result while dragging, no Alt-click loading (#2247).
  - Art History Brush: 8 of 10 styles, Area approximated, no Mode or pressure (TOOL-213-20).
  - Healing Brush: no Pattern source, Diffusion or Replace mode; users call it "horrible in
    general" (#1092) and report it stops responding after switching (#1751).
  - Symmetry: 4 of 10 modes plus a path.
  - Contextual Task Bar exists only for the Crop tool.
  - Erodible, airbrush and bristle tips are not modelled (bitmap look-alike presets only).
  - Polygon has no Smooth Corners / Smooth Indents; Freeform Pen has no Magnetic option; Direct
    Selection cannot nudge points with the arrow keys; smart guides have no distance labels.
  - Object Selection has only Rectangle mode (no Lasso mode, Object Subtract, Hard Edge).
  - No Adjustment Brush tool, no HDR (32-bit) Color Picker, no on-screen colour sampling outside
    the canvas, no Magic Wand Sample Size.
- **Self-reported status vs code.** Where checked, PhotoCraft's docs matched its code, with a few
  stale lines in its favour (Scroll All Windows exists in `canvas/scroll_all_windows.rs` though
  ui-parity.md says missing) and one control the code shows as a disabled facade that the
  parity docs do not flag (path alignment/arrangement).
