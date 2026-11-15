# PhotoCraft beyond the Select, Filter and View inventory page

Page: /home/user/claude/pigment/docs/parity/select-filter-view.md (222 rows). PhotoCraft clone: /home/user/storytold/photocraft at abb30df. Paths below are relative to that clone.

## (a) PhotoCraft features in this area with no row on the page

Photoshop features the inventory has no row for:
- **Select > Convert to Shape** (`select.convertToShape`, menu_catalog.rs:542; engine vector_cmds): turns the selection into a shape layer, with a fill and a tolerance.
- **View > Rotate View / Rotate Left / Rotate Right / Reset View** commands (menus/view_cmds/dispatch.rs:53-56, 324-332), and Window > Arrange Match Zoom / Location / Rotation / All, Float in Window, Scroll All Windows on the Hand bar (dispatch.rs:26-38, panels/options_bar.rs:863). Each document can be its own OS window.
- **Camera Raw open-time dialog for raw files**: demosaic choice in Detail (camera_raw_ui/controls.rs:477-480), a filmstrip of several raws opened together (camera_raw_ui/filmstrip.rs), `.xmp` sidecars read and written beside the raw, and the Camera Raw Defaults preferences (gaps.md G14). Inside Camera Raw there is also a vectorscope and Alt clipping diagnostics per channel (camera_raw_scope_ui.rs:5-20).
- **Liquify Show Backdrop** with a chosen layer, the In Front / Behind / Blend modes and an opacity (liquify_ui.rs:104-124), plus a bounded redo (Cmd+Shift+Z, scorecard TOOL-214-16).
- **Smart filters**: per-filter Blending Options, drag and Alt-drag to other smart objects, and drag reordering (panels/smart_ui.rs, docs/smart-filters.md). Smart-filter stacks also go through PSD save and open for 49 mapped filters (scorecard FILE-215-2).
- **File > Automate > Lens Correction** (batch twin of the filter, lens_cmds.rs:490).
- **Proof setups** on its own pure-Rust ICC engine (craft-cms): any .icc as the proof device, the four intents, BPC and Simulate Paper Color (color_cmds.rs:1372-1376).

Beyond Photoshop:
- **Filter > Render > Relight…** (`filter.render.relight`, filters_ext.rs:792-799): a one-light relighting with angle, elevation, intensity, ambient, warmth and softness, listed next to Lighting Effects (menus/items.rs:43).
- **View > Pixel Art Preview** (`view.pixelArtPreview`, dispatch.rs:426). Not checked in depth.
- **Face detection** (`image.detectFaces`, engine cmd/face_cmds.rs; algo/src/faces.rs): a pure-Rust port of libfacedetection's YuNet CNN, about 100 KB of weights, desktop only. Neither Color Range's Detect Faces nor Face-Aware Liquify uses it yet, but it is the missing piece for both.
- **In-dialog zoomable preview** for every generated filter dialog (dialogs/filter_preview_ui.rs): zoom, pan, press-and-hold to compare, and the canvas acts as the locator.
- **Every command can be scripted**: filters, Select and Mask edits, Liquify strokes, Vanishing Point planes and Color Range eyedropper points are all plain command parameters, driven through the control channel or MCP (`ui.menu.invoke`, `ui.dialog.set`). They replay exactly in actions, and `.atn` import maps Photoshop events onto them (engine cmd/atn_cmds/events.rs).
- **Selected colour sets** (docs/multi-channel-editing.md): supported filters and tone edits can run on a chosen subset of channels.
- **WebAssembly plug-in ABI v1** (crates/plugins, docs/plugins.md): sandboxed plug-in filters under Filter > Plug-ins. PhotoCraft's own ABI, not 8BF.
- **Measured Photoshop matching**: Color Range's hue families were checked against Photoshop 2025 on 126 colours each and match to within one level (algo/src/selection.rs:803-808), and Average against Photoshop 26.6.1 (docs/average-filter.md).

## (b) What limits PhotoCraft's real usefulness in this area

Bugs and readiness (from docs, not re-measured):
- gaps.md G3 counts **579 open issues** (2026-10-10), sorted by title: about 150 UI/panels/menus/shortcuts, 54 selection, 41 performance, 25 Linux/Wayland. target-app-parity.md puts feature breadth at about 76% but "ready for real work" at about 45%. It scores Selections, Select and Mask and channels at 55%, and Adjustments and filters at 70%.
- **Smart-filter re-rendering matches Photoshop on only 5 of 30 PSD files** (gaps.md G1). Smart filters work inside PhotoCraft, but exchanging them with Photoshop is unreliable.

Performance budgets missed (docs/scorecard.md, baseline 2026-10-05 on a heavily loaded machine; gaps.md G2 says 22 of 25 budgeted scenarios are over):
- P29 Select Subject on 24 MP: 559 ms p50 against a 100 ms budget.
- P26 / P27 Select > Modify > Smooth and Feather on 24 MP: 216 and 357 ms p95 against 100 ms. Later cropped-mask work is not in the baseline yet.
- P30 Liquify full-resolution brush, P31 / P36 Camera Raw exposure change, and P25 / P50 Gaussian Blur cancel and frame time are all **not run**. Only local runs exist for P25 (13-44 ms after #6205).
- P41 Gaussian Blur r 40 on 36 MP takes about 3 s (tracked only).
- P12: a 150-layer arrow-key nudge **panics the GPU compositor** (wgpu validation error). This is not specific to Select, Filter or View, but it hits the canvas every view feature draws on.

Features that exist but are thin (checked in code):
- Several Photoshop workspaces open as the **generated parameter dialog** instead of their own UI: Lens Correction (no Remove Distortion, Straighten, Move Grid, Hand or Zoom tools, no grid, no Green/Magenta fringe slider), Focus Area (In-Focus Range and Noise only: no brushes, view modes, Soften Edge or Output To), Path Blur (no on-canvas paths, gaps.md G7), Lighting Effects (one light in the form, more only as JSON), Shear (amount slider, the curve only as JSON) and Proof Setup > Custom.
- **Blur Gallery** has no Effects, Motion Effects or Noise tabs, no Selection Bleed, Save Mask to Channels or High Quality, and cannot combine blur types in one session.
- **Select and Mask**: Refine Hair and Object Aware are greyed out (#2671, #2788), and there are no Presets.
- **Detect Faces in Color Range is refused** ("not available yet") although the face detector exists.
- **View flags with nothing behind them**: Show > Mesh, Edit Pins and Brush Preview toggle a flag that no canvas code reads. 32-bit Preview's Highlight Compression changes nothing, because the canvas texture is clamped to 0-1 (proof_sim.rs:14-17). Proof Setup > Monitor RGB proofs as sRGB (menus/invoke.rs:24). Pixel Aspect Ratio is a view setting, not stored per document.
- **No Shake Reduction, no Filter > 3D and no Neural Filters.** There is no ML runtime (gaps.md G15). Select Subject and Select Sky are classical heuristics, and Camera Raw has no masking, Geometry, Optics, healing or snapshots (G14).
- **Last Filter** repeats only registry filters. Camera Raw, Liquify and Lens Correction are not repeated, and there is no reopen-the-dialog variant.
- **Lens profiles are generic**, interpolated by focal length (algo/src/lens.rs:21-22). There is no Lensfun database.
- **Platform**: the browser (wasm) build leaves out the face detector and the JPEG XL decoder (algo/src/faces.rs:11-13).
