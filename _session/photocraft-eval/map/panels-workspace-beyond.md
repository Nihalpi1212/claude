# PhotoCraft beyond the panels-workspace and more pages

Scope: Pigment's docs/parity/panels-workspace.md (209 rows) and docs/parity/more.md (44 rows). The row-by-row map is in panels-workspace.jsonl next to this file.

## (a) PhotoCraft features in this area with no row on the two pages

Photoshop features the inventory missed:

1. **Panels in their own OS windows.** craft-ui docking with the `native-windows` feature: a floated group becomes a real OS window (crates/ui-egui/src/panels/panel_docking/native_tests.rs). docs/ui-parity.md and scorecard UI-217-5 still say "missing". Both docs are stale.
2. **Undo-safe, atomic workspace operations.** craft-ui `Workspace::apply_all` either applies a whole batch of dock actions or none. Closed panels remember where they go back (craft-libs/crates/ui/src/docking/workspace.rs). Lock Workspace refuses moves, floats and closes but still allows resize and minimise, which is Photoshop's rule.
3. **Histogram panel at full depth:** Compact, Expanded and All Channels views, Source, statistics, the cached-data warning and Uncached Refresh, and the adjusted histogram drawn over the original while an adjustment previews (ui-parity.md, Panels and workspace).
4. **Color panel panel-menu modes:** Hue Cube, Brightness Cube, Color Wheel, the slider spaces, the colour ramps and Copy Color as HTML (color_panel_ui.rs).
5. **Layers panel extras:** Clip Thumbnails to Layer Bounds, the filter-type dropdown (6 of 9 kinds), wheel-stepping blend modes, the New Group button modifiers, and new layers landing inside the open active group.
6. **Straighten Layer from the Ruler tool**, gated as Photoshop gates it (engine/src/cmd/analysis_cmds.rs).
7. **Keyboard-layout-aware brush keys.** [ and ] map to other keys on non-US layouts (layout_keys.rs). The `.kys` import plus Export and Summarize go beyond Pigment's table (engine/src/kys.rs, shortcut_sets.rs).
8. **Menu bar from the keyboard:** Alt or F10, then the arrow keys and mnemonics (menus/menu_keys.rs).
9. **Six stock workspaces, including Pixel Art,** plus saved workspaces that can carry shortcuts, menus and toolbar.
10. **Spring-loaded document tabs while dragging layers.** Dropping onto a tile in an n-up arrangement also works (panels/layer_transfer.rs).

Beyond Photoshop:

11. **Every command is drivable headlessly.** The same command ids serve the UI, the CLI, a control channel and an MCP server. `ui.set` and `ui.inspect` drive the dock, toolbar and dialogs without pixel coordinates (crates/automation, docs/mcp.md, docs/control-protocol.md). An agent acceptance suite runs 10 workflows over MCP (AUTO-219-10).
12. **Sandboxed WebAssembly plug-in API (ABI v1)** under Filter > Plug-ins, with a plug-ins folder preference (docs/plugins.md). It is filters only: the ABI v2 panel kind is missing (AUTO-219-6).
13. **The same app runs as a web build (wasm32).** On the web, memory gates refuse oversized operations with a clear message instead of crashing (gaps.md G17).
14. **Fourteen UI themes.** These include Photoshop's four greys, Soft Dark and Soft Light, and the "Studio" themes with a floating Properties card. UI scale runs from 75 to 300%.
15. **LZ4-compressed scratch tiles** that never outlive the process (docs/scratch-disks.md). Memory Usage is set as a percent of RAM.

## (b) What limits PhotoCraft's real usefulness in this area

- **Open bugs.** gaps.md G3 counts 579 open issues (2026-10-10). By title, about 150 are UI, panels, menus and shortcuts, 25 Linux/Wayland, 24 Windows and 20 macOS. The project's own estimate is ~76% feature breadth but only ~45% "ready for real work" (target-app-parity.md), and it calls itself alpha.
- **Performance budgets mostly missed.** In the scorecard, 3 of 90 performance scenarios are within budget, 22 are over budget or failing, and 52 were never run (baseline 2026-10-05). Native GUI latency is unmeasured (gaps.md G2, 200–350 h).
- **Settings that do nothing.** 8 of 203 preferences are unread. Two of them are in this area: `workspace.auto_show_hidden_panels` and `workspace.enable_floating_document_window_docking`.
- **Thin features:**
  - Info panel. Readouts are quantised to 0–255 at every bit depth (panels/info.rs:72). There are no readout modes, no Panel Options and no before/after values. Pigment is ahead here.
  - Status bar. "Efficiency" is the fixed string "Efficiency: 100%". "Scratch Sizes" is the layered document size. "Measurement Scale" is hard-coded to "1 pixel = 1.0000 pixels" even though a real measurement scale exists (panels/chrome_ui.rs:104–109). There is no Timing.
  - Timeline. It is a playhead panel with video layers made of GIF, WebP or image-sequence frames. There is no movie decode or encode, no frame animation (atn_cmds/events.rs:959 says so), and no keyframes, tracks, audio, transitions or tweening. Render Video writes image sequences or an animated GIF only.
  - Contextual Task Bar. Only the Crop tool supplies one.
  - Customize Toolbar. Tools can only be hidden, not reordered or regrouped.
  - The options bar cannot float or dock at the bottom.
  - History Log. It writes to a text file only; the Metadata destination does nothing.
  - Actions. Some Photoshop basics are missing: Replace Actions, Clear All, Reset and the bundled Default Actions. Insert Conditional is not in the panel. About 89 `.atn` events are unmapped (docs/atn.md).
- **Hardware.** Windows Ink gives no tilt or rotation (WinTab is opt-in). On native Wayland the pen does not work (GNOME 50 pen does not click, #2622). Barrel rotation is not applied to the tip angle on macOS (#1301). The app fails to start without a GPU adapter on some Linux systems (#2519, #2412).
- **Distribution.** Windows builds are unsigned. The update check runs once per launch, with no automatic install. There is no in-app bug report.
- **Localization.** Engine error and status messages are English in every language. There is no RTL layout, and Hindi is 16% translated.
- **The docs lag the code in both directions.** ui-parity.md and scorecard UI-217-5 say panels cannot float, but the code floats them, even into OS windows. ui-parity.md says History Brush sources are "to come", but the panel has the source column. The code was taken as the truth in the map.
