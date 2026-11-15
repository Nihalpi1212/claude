# PhotoCraft beyond the image-layer rows

Scope: Image and Layer menus; the Layers, Channels, Histogram, Adjustments and Properties panels. Paths are under /home/user/storytold/photocraft unless they say otherwise. Checked in code unless marked (doc).

## (a) Features with no row on the Pigment page

### Photoshop features the inventory missed

1. **Image > Adjustments on a smart object records a smart filter.** Hue/Saturation with Colorize, Curves, Levels, Shadows/Highlights, Replace Color, Equalize and the others. The selection becomes the filter mask, and the result is re-rendered from the source. Code: crates/engine/src/cmd/adjust_cmds.rs adjust_as_smart_filter, crates/engine/src/cmd/smart_cmds/rendering.rs:164; scorecard FILE-215-4.
2. **Editing several colour channels at once.** Shift-click colour rows in the Channels panel to build a set. Brushes, adjustments and filters then edit only those planes, in RGB, CMYK and Lab at 8, 16 and 32 bit. Levels and Curves show a combined entry such as "RB". Source: docs/multi-channel-editing.md, channel.target with `colors` and `extend`.
3. **Channels panel extras.** Layer Mask Display Options (rubylith colour and opacity), Quick Mask Options, Convert to Alpha Channel, Merge Spot Channel, and Cmd+2..9 and Cmd+\ targeting. Code: crates/ui-egui/src/panels/channels_panel.rs, crates/engine/src/cmd/channel_cmds.rs:261-273.
4. **Layers panel options.** Thumbnail Contents (layer bounds or entire document), mask badges, Expand New Effects, Add "copy" to copied layers, Use Default Masks on Fill Layers, Preview on canvas when reordering, and Prevent Auto-Nesting into artboards and frames. Code: crates/ui-egui/src/panels/layers_panel_ui.rs.
5. **Mask commands in the Layers context menu.** Add Mask to Selection, Subtract Mask from Selection and Intersect Mask with Selection. Code: crates/ui-egui/src/panels/layer_menu_ui.rs.
6. **Frame tool and frames.** Frame Tool (K), frame strokes, Fit Content to Frame / Fit Frame to Content, and two-thumbnail frame rows. The page has only the Frames menu row. Source: docs/frame-tool.md, crates/engine/src/cmd/frame_cmds.rs.
7. **Spot channels as print plates.** Spot channels are written as TIFF extra samples and as PSD spot planes. PDF writes them as overprinting /Separation plates, and a Multichannel document as plates alone. Source: scorecard FILE-215-17, docs/gaps.md G10 (doc).
8. **Advanced Blending in layered TIFF.** Saved in layered TIFF as well as PSD (knko infx clbl tsly lmgm vmgm), with tests in both byte orders. Source: scorecard FILE-215-16, FILE-215-5 (doc).
9. **Measurement extras.** The Measurement Log exports and deletes rows (measurementLog.export / delete). Count groups have their own colour, marker size and label size. There is a Straighten Layer command for the Ruler. Code: crates/engine/src/cmd/analysis_cmds.rs.
10. **Linked smart objects update automatically.** A linked file that changes while the document is open re-renders its layers, with one undo step per file. Code: crates/engine/src/link_watch.rs.
11. **Unsupported PSD adjustments are kept, not dropped.** An adjustment PhotoCraft cannot evaluate is stored raw so it round-trips (Adjustment::Unsupported in crates/doc/src/adjust.rs). The Layers panel marks it "Not rendered".

### Beyond Photoshop

12. **Every command is scriptable headless.** Each Image and Layer command id, with typed parameter specs, also runs from the CLI, the control channel and MCP. Examples: `layer.vectorMask.info`, `variables.list`, `image.adjustments.blackWhite.auto`, `measurementLog.list`. Code: CommandSpec params strings in crates/engine/src/cmd/*.
13. **SVG smart objects.** An SVG source is re-rendered at its placement scale. Code: crates/engine/src/cmd/smart_svg_cmds.rs; scorecard FILE-215-9.
14. **Extra resampling and LUT options.** Lanczos resampling in Image Size and Crop. Tetrahedral interpolation for Color Lookup. CC0 generated looks, and .look files saved in UTF-16 load. Code: crates/algo/src/resample.rs, craft-libs/crates/cms/src/lutfile.rs.
15. **CMYK and Lab compositing on stored values.** Plain stacks are composited on the stored ink or L/a/b values, so an opaque layer keeps its exact inks or L/a/b. This includes the adjustment layers Photoshop evaluates on those values. Code: crates/compose/src/native.rs, native_lab.rs. Pigment stores RGB only.

## (b) What limits PhotoCraft's real usefulness here

- **Bug backlog (docs/gaps.md G3, 2026-10-10, doc).** 579 open issues. By title: 87 layers, about 150 UI/panels/menus, 46 type and 41 performance. The project rates Layers / masks / styles / smart objects as 65% ready for real work, adjustments and filters 70%, and colour modes 70% (docs/target-app-parity.md, Feature areas).
- **Layer operations miss their performance budgets badly (docs/scorecard.md Performance, doc; the baseline was taken on a heavily loaded machine).**

  | Scenario | Budget | Measured p50 |
  |---|---:|---:|
  | Move a layer with styles (P1) | 25 ms | 321 ms |
  | Change opacity (P2) | 20 ms | 276 ms |
  | Change fill (P3) | 20 ms | 279 ms |
  | Duplicate a 12 MP layer (P8) | 100 ms | 508 ms |
  | Paste a 12 MP layer (P10) | 100 ms | 1.2 s |
  | Move a layer on a 15000×10000 16-bit document (P14) | 80 ms | 2.7 s |

  22 of 25 budgeted scenarios are over budget.
- **A crash.** P12, an arrow-key nudge in a 150-layer document, panics the GPU compositor (wgpu "Buffer with 'pc_compose_uniforms' label is invalid"). Menus are slow with thousands of layers (#2460, doc).
- **Advanced Blending is slow.** It runs on the CPU compositor only; the GPU path falls back (FILE-215-16). Some knockout and blend-and-clipping oracle files still differ, and several cases are not yet measured against Photoshop (compose/src/advanced.rs header).
- **Smart filters are not faithful yet.** Re-rendering matches Photoshop on 5 of 30 files (target-app-parity.md, doc). Smart filter rows have no collapse, drag reorder or context menu (FILE-215-5).
- **Thin features.**
  - Contour Anti-aliased does not change the render (FILE-215-15).
  - A single pixel layer copies without its mask and styles (UI-217-23, doc).
  - HDR Toning has no Method menu.
  - Replace Color and HDR Toning are schema-generated parameter dialogs, not Photoshop's layouts.
  - Video layers take only animated GIF/WebP or image frames, and their frames are not persisted in .pcraft (video_cmds.rs header).
  - Mask All Objects makes one mask, not one group per object, from classical segmentation.
  - CMYK and Lab stacks with effects, masks or most blend modes still composite through display RGB.
- **Adjustment dialogs are shallower than Pigment 0.4's.** There are no adjustment presets at all (no .acv/.ahu/.blw files, no preset menus, nothing in the Adjustments panel). Also missing: Auto Color Correction Options, Curves Display Options, Show Clipping and Auto, on-image adjustment tools, and Hue/Saturation range eyedroppers.
- **Missing outright in this area.** Copy SVG; Image Size preview and Fit To presets; generative layers; Color and Vibrance / Clarity / Dehaze / Grain as adjustments (they exist only inside the Camera Raw filter).
- **Settings.** 8 of 199 preferences do nothing (gaps.md G9, doc).
