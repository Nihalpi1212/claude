import json, os
D = os.path.dirname(os.path.abspath(__file__))
rows = [json.loads(l) for l in open(os.path.join(D, "sample-rows.jsonl"))]
E = {
0: ("PC prefs.rs Export struct; read by web_cmds/quick.rs:33,39 and menus/items.rs:127. Pigment: no export prefs (only layers-extras Quick Export as PNG).", "holds"),
1: ("PC i18n.rs LANGUAGES + craft-i18n catalogs; theme.rs ui_font_size; prefs_ui/appearance.rs:173 display_scale(ui_scale). Pigment: no i18n/scale.", "holds"),
2: ("PC io/src/pdf_import.rs: craft-pdf raster pages to artboards, MAX_PAGES 16, no vector/text import; .ai with %PDF routed (io lib.rs:1008). Pigment: no PDF reader.", "holds"),
3: ("PC edit.menus opens shortcuts dialog tab (prefs_ui/dialogs.rs:19), hide + colours; no menu sets. Pigment shortcuts-editor.js is the 0.5 skeleton stub (edit:menus disabled) -> Missing.", "holds"),
4: ("PC dialogs/caf_ui.rs header: Sampling Brush, Lasso, Hand, Zoom; Auto/Rectangular/Custom; overlay opacity/colour/Indicates (show_overlay, color, Excluded Area). Pigment: no workspace.", "holds"),
5: ("PC prefs.rs Performance: use_gpu, rendering_mode, gpu_backend, gpu_adapter, low_latency_drawing, legacy_compositing; no 30-bit display field anywhere (rg 30.?bit empty).", "PhotoCraft lacks the 30-bit display option the row names (the mapper's own note), so Partial, not Done; ahead unchanged"),
6: ("Pigment tools/paint-keys.js:265-267 Other cursors, Brush preview colour, Brush leash colour (0.5 brush-painting-behaviours). PC prefs Cursors has other + brush_preview_color; no leash colour (rg leash empty in PC).", "holds"),
7: ("craft-libs image-codecs format.rs:294 Avif read:false; PhotoCraft does not enable the avif feature. Pigment opens AVIF through Chromium.", "holds"),
8: ("PC edit_menu_cmds/presets.rs:67 PRESET_KINDS = brushes, customShapes, patterns. Pigment preset-manager.js (0.5 preset-files-manager) covers every kind with .aco/.ase/.pat/.grd/.csh/.asl/.tpl.", "holds"),
9: ("PC menu_catalog.rs:88-90 Paste Special has only Paste in Place/Into/Outside; no plain-text paste command. Pigment menu-template.js:225 + type/editor.js:934.", "holds"),
10: ("PC prefs.rs GuidesGridAndSlices: guide_color, guide_style, smart_guide_color; no artboard guide colour although PC has artboard guides (artboard_cmds.rs clearSelectedArtboardGuides). Pigment page itself says artboard guides wait for 0.9.", "the row names artboard guide colours; neither has them (PC has artboards but no separate colour; Pigment has no artboards), so both Partial; ahead same holds"),
11: ("PC extra_cmds.rs:1151 file.scripts.deleteAllEmptyLayers; Pigment automate.js:119 deleteEmptyLayers.", "holds"),
12: ("craft-libs codecs/dpx.rs (Cineon handled there, 46 refs); format.rs Dpx U8/U16, Cineon U16, base read/write true.", "holds"),
13: ("PC smart_svg_cmds.rs: SVG/PDF/AI/EPS sources, external editing; vector_preview.rs display SVG; EPS/AI editing via external app. Pigment: raster-only placing.", "holds"),
14: ("PC io/src/slices_map.rs import + export_resource used by psd_import.rs:1387 and psd_export/document.rs:230.", "holds"),
15: ("PC color_cmds.rs proof setup: profile, intent, bpc, simulatePaper; no preserve numbers or simulate black ink. Pigment 0.5 icc-engine doc lists soft-proofing as not built.", "holds"),
16: ("PC engine/src/cmd/variables_cmds.rs (visibility/text/pixel variables, data sets, export as files) + panels/variables_ui.rs.", "holds"),
17: ("PC print_cmds.rs: bleed, emulsion_down only; no negative/background/border.", "holds"),
18: ("craft-libs format.rs:294 Avif read:false, write behind an optional feature PhotoCraft does not enable. Pigment opens via Chromium, no writer.", "holds"),
19: ("PC file_cmds/info.rs INFO_FIELDS: title, author, description, keywords, copyright, authorTitle (+EXIF readouts); no IPTC. Pigment file-info.js has credit and source.", "holds"),
20: ("PC: no generation command; craft-ai-integrations ai-features catalogue is not a PhotoCraft dependency (only craft-ai-agents in automation). Pigment ai/features.js:711 ai:generate-image.", "holds"),
21: ("PC crop_task_bar.rs:5 'Generative Expand goes here once generative fill comes through the shared AI layer'. Pigment ai:generative-fill (features.js:709) on external APIs.", "holds"),
22: ("PC dialogs/export_dialog.rs single scale; Pigment file-ops.js exportAs single scale, no canvas size.", "holds"),
23: ("Pigment 0.5 icc-engine: color/pipeline.js describe(); app.js:709 statusbar 'profile'; panels/info.js:154. PC chrome_ui.rs Document Profile.", "holds"),
24: ("PC panels/histogram_panel.rs:247-277 Mean, Std Dev, Median, Pixels, Level, Count, Percentile; cache_levels pref. Pigment: no Histogram panel.", "holds"),
25: ("PC histogram_panel.rs HistView Compact/Expanded/All Channels.", "holds"),
26: ("PC channel_cmds target_surface/read_target_surface used by paint, mixer, redeye, adjust_params, channel_clip; target {channel:i} in paint params.", "holds"),
27: ("PC analysis_cmds image.analysis.placeScaleMarker with length/color/textPosition (tests.rs:357-372).", "holds"),
28: ("PC frame_cmds.rs:375 layer.new.frameFromLayers, :385 layer.frame.convert.", "holds"),
29: ("PC variables_cmds image.applyDataSet.", "holds"),
30: ("PC adjust_editors/curves.rs draws fixed histogram/quarter grid/baseline, no Display Options or Show Clipping (levels_clipping.rs is Levels only). Pigment adjust/curves-editor.js:5,146.", "holds"),
31: ("PC adjust_dialog picker_kind sets black/grey/white points; no target-colour editing or Auto Options anywhere (rg target colour / auto options empty). Pigment adjust/eyedroppers.js + auto-options.js with target colours.", "PhotoCraft has the three eyedroppers but not their target colours (the mapper's own note), so Partial; recorded Done contradicts the note; ahead pigment holds"),
32: ("PC adjust_editors/basic.rs channel_mixer: Total, Constant, Monochrome; no presets/.cha (rg empty). Pigment adjust/color-formats.js .cha.", "holds"),
33: ("PC adjust_cmds matchColor: no Save/Load Statistics (rg empty). Pigment adjust-more-ui.js:396-397 Load/Save Statistics.", "holds"),
34: ("PC curves.rs:220-238 pencil map, Smooth. Pigment 0.4 pencil + Smooth.", "holds"),
35: ("PC dialogs/duplicate_layer_ui.rs name + destination document; Pigment 0.4 dialog.", "holds"),
36: ("craft-libs crates/ui/src/docking iconic columns + labels.rs; PC panel_docking.rs:824 auto_collapse_iconic pref. Pigment: per-group chevron only.", "holds"),
37: ("PC menus/view_cmds/arrange.rs:73 newWindowForDocument -> float_window(app, doc) (a second viewport on the same document). Pigment: one view per document.", "holds"),
38: ("PC menu_catalog.rs:706 view.show.notes, :797 Notes panel; notes_cmds PSD Anno round trip; import reads PSD/.pcraft, not PDF.", "holds"),
39: ("PC video_cmds.rs:501-518 newVideoLayerFromFile on flattened image formats/sequences; no movie decoder.", "holds"),
40: ("PC engine/src/cmd/atn_cmds (+ PHOTOSHOP_STEP opaque steps shown as '(Photoshop)' in actions.rs). Pigment refuses .atn.", "holds"),
41: ("PC tools/vector_ui/paths_panel.rs fixed 28x28 thumbnails, row actions; no Panel Options.", "holds"),
42: ("PC panels/info.rs:72-83 fixed RGB + colour-managed CMYK, no mode choice. Pigment settings.infoSecondary CMYK/Lab/HSB select.", "holds"),
43: ("PC: no bundled default action set (rg Wood Frame / Sepia Toning / Molten Lead empty). Pigment lib/actions/defaults.js.", "holds"),
44: ("PC actions_edit_cmds.rs:380-487 actions.conditional step plays/round-trips, but the Actions panel offers only Insert Menu Item/Stop/Path (actions.rs:1623-1631). Pigment panels/actions.js:71 Insert Conditional dialog.", "holds"),
45: ("Pigment 0.5 presets-panels tool-presets.js + preset-files/tpl.js readTplFile. PC tool.presets.* with no .tpl code.", "holds"),
46: ("PC menus/invoke.rs:859 toggle_panels (Tab) AND shell_commands.rs:75 window.toggle.dock 'Show/Hide Panels' Shift+Tab; auto_show_hidden_panels pref unread. Pigment keymap.js:135 only Tab (window:toggle-panels), no Shift+Tab, no edge hover.", "both Partial is right, but PhotoCraft has Shift+Tab (hide panels, keep tools) which Pigment lacks, so PhotoCraft is ahead, not same"),
47: ("PC panels/actions.rs Button Mode; Pigment actions:button-mode.", "holds"),
48: ("PC canvas.rs:644,1214,1585 read prefs.general.animated_zoom; zoom_hold.rs. Pigment animatedZoom unread.", "holds"),
49: ("PC menu_catalog.rs:712-713 Show > All and Show Extras Options; no None. Pigment menu-template has no View > Show > All/None.", "holds"),
50: ("PC channel_cmds/view.rs QuickMaskOptions (color, opacity, indicates) + channel_options_ui.rs. Pigment fixed red overlay.", "holds"),
51: ("PC dialogs/camera_raw_ui/controls.rs:492-500 Calibration: shadows tint, R/G/B primary hue and saturation; :493 comment 'Process Version is implied: 2012 and later' (no Process selector). Pigment develop/tabs-04.js calibration is a skeleton file (camera-raw-panels not started).", "PhotoCraft's Calibration panel lacks the Process Version choice that sits at the top of Photoshop's Calibration panel (mapper noted 'process version fixed'), so Partial; ahead unchanged"),
52: ("PC liquify_ui.rs zoom field, wheel/pinch zoom, Space/middle-drag pan; no Hand/Zoom tool buttons. Pigment liquify.js has no zoom/pan.", "holds"),
53: ("PC proof_sim.rs:302 Legacy Macintosh RGB; menus/invoke.rs:24 Internet Standard and Monitor RGB both map to sRGB. Pigment: no Proof Setup.", "holds"),
54: ("PC engine/src/snap.rs alignment only, no equal spacing (rg empty); move_distance Cmd-hover distances. Pigment renderer/lib/smart-guides.js equal spacing.", "holds"),
55: ("PC filters_ext pathBlur parameter dialog (gaps.md G7). Pigment blur-gallery-ui.js:53-118 on-canvas path points, end speeds, Centered Blur.", "holds"),
56: ("PC: no shake command (rg shake only hits 'handshake'). Pigment shared/pixels/filters-more-a.js shake-reduction.", "holds"),
57: ("PC lens correction uses the generic filter_dialog (no grid). Pigment lens-correction.js:86 grid, gridSize, gridColor.", "holds"),
58: ("PC canvas/rulers.rs ruler_origin; Pigment 0.4 guides-snapping.", "holds"),
59: ("PC selection_cmds.rs fuzziness 0..200; Pigment selection-ops.js colorRange.", "holds"),
60: ("PC paint/src/symmetry.rs SymmetryMode Vertical/Horizontal/Dual/Diagonal only + symmetryFromPath. Pigment: no brush symmetry (0.5 brush-engine-core does not add it).", "holds"),
61: ("PC retouch_cmds/content_aware_move.rs paint.contentAwareMove; Tool::ContentAwareMove (state/tool_options.rs:463).", "holds"),
62: ("PC Tool::CurvaturePen (canvas.rs:1597,2112), direct_select.rs:757-787 curvature_hover/press, double-click smooth/corner.", "holds"),
63: ("PC dialogs/color_picker_ui.rs:47,56,606 out_of_gamut / not_web_safe warnings. Pigment's warnings in color-picker.js are color-picker-swatches work (stopped mid-build) -> not built.", "holds"),
64: ("PC panels/properties.rs:265-269 options-bar Select and Mask button; tools/retouch_ui.rs:1156 Select Subject. Pigment selection tools have no such buttons.", "holds"),
65: ("PC widgets/task_bar.rs used by tools/crop_task_bar.rs and frame_tool.rs:796 task_bar (Crop and Frame only). Pigment none.", "holds (the note misses the Frame tool's bar; status unchanged)"),
66: ("Pigment 0.5 brush-engine-core brush/dynamics.js:25-61 tilt, tangentialPressure (wheel), twist. PC paint/src/brush.rs controls; platform input gaps per hardware-parity.md.", "holds"),
67: ("Pigment tools/shape-widgets.js:201,293 Smooth Corners + Smooth Indents, shape-geometry.js:408. PC: no smooth corners (rg empty).", "holds"),
68: ("Pigment 0.5 presets-panels tool-presets.js + tpl.js. PC tool.presets.* without .tpl.", "holds"),
69: ("PC snap.rs alignment + move_distance Cmd distances, no equal spacing. Pigment smart-guides.js alignment, equal spacing, Ctrl distances.", "holds"),
70: ("Pigment 0.5 brush-painting-behaviours AxisLock + Shift-click (PKG notes, gesture code); PC tools/stroke_constraint.rs.", "holds"),
71: ("PC Tool::AddAnchorPoint/DeleteAnchorPoint/ConvertPoint (canvas.rs:2133); Pigment AddAnchorTool etc.", "holds"),
72: ("PC type_extra_cmds.rs:699-737,1015 dlig toggle; text/src/layout/style.rs:75 pushes \"dlig\" 1 into shaping. Pigment shaper has a features override but no UI control.", "holds"),
73: ("PC type_extra_cmds.rs:991-996 stylistic sets 1-20; text tests round-trip ss01/ss02. Pigment: no control.", "holds"),
74: ("PC type_area_cmds type.fillPath, text/src/area.rs. Pigment: clicking a path starts type on a path only.", "holds"),
75: ("PC type_extra_cmds.rs:808 update_all re-lays every text layer. Pigment type:update-all is type-menu-commands work (stopped) -> not built.", "holds"),
76: ("PC panels/type_panels_ui.rs:33,630,680 glyph_recent. Pigment has no Glyphs panel.", "holds"),
77: ("PC actions_record.rs:5,55-79 records type.create/type.edit. Pigment ignores layer:edit-text in actions.", "holds"),
78: ("PC tools/type_tool/panel.rs:359-373 style row has Faux Bold/Italic, All Caps, Small Caps, no Superscript/Subscript; FontBaseline in model and type.setStyle only. Pigment 0.4 Subscript button.", "holds"),
79: ("PC: no reset character command (rg empty). Pigment 0.4 panel menu Reset Character (keeps font/size/colour).", "holds"),
80: ("Pigment 0.5 type-fonts font-library.js:791-805 type:font-preview-size + font-picker.js:193 sample sizes. PC menu item only moves a checkmark; Preferences size works.", "holds"),
81: ("PC panel.rs:498 'Hyphenate is stored ... but layout never breaks words (#6710)'; no settings dialog. Pigment type/hyphenation.js + paragraph.js registerHyphenator.", "holds"),
82: ("PC panel.rs:367 All Caps; Pigment 0.4.", "holds"),
83: ("PC type_tool/keys.rs session undo; Pigment 0.4 type-editing.", "holds"),
}
OV = {
5: {"photocraft": "Partial"},
10: {"photocraft": "Partial", "pigment": "Partial"},
31: {"photocraft": "Partial"},
46: {"ahead": "photocraft"},
51: {"photocraft": "Partial"},
}
out = open(os.path.join(D, "sample.jsonl"), "w")
for i, r in enumerate(rows):
    rec = {"pigment": r["pigment"], "photocraft": r["photocraft"], "ahead": r["ahead"]}
    chk = dict(rec); chk.update(OV.get(i, {}))
    ev, why = E[i]
    out.write(json.dumps({"page": r["page"], "feature": r["feature"], "group": r["_group"], "recorded": rec, "checked": chk, "evidence": ev, "why": why}) + "\n")
out.close()
import collections
c = collections.defaultdict(lambda: [0,0,0,0])
for l in open(os.path.join(D, "sample.jsonl")):
    j = json.loads(l); p = c[j["page"]]; p[0] += 1
    for k, idx in (("photocraft",1),("pigment",2),("ahead",3)):
        if j["recorded"][k] != j["checked"][k]: p[idx] += 1
for k, v in c.items(): print(k, v)
print("total", [sum(v[i] for v in c.values()) for i in range(4)])
