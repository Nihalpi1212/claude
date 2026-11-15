# PhotoCraft beyond Pigment's formats / colour / automation page

Scope: Pigment's `docs/parity/formats-color-automation.md` (224 rows). Judged from PhotoCraft's code at abb30df
and craft-libs at e2dc681 (the revision PhotoCraft pins).

## (a) PhotoCraft features in this area that the page has no row for

Photoshop features the inventory has no row for:

- **Embedded Profile Mismatch / Missing Profile / Paste Mismatch prompts, with the policy applied on open.**
  `color.profileMismatch` (engine/src/cmd/color_cmds.rs: preserve, convert, discard, assignWorking) and
  `Session::open_document`. Pigment's row 81 lumps this in with Color Settings.
- **Spot working space dot gain** (`spotDotGain`, color_cmds.rs:1248) and spot-ink overprint preview on RGB/CMYK
  canvases (#10249).
- **Image > Mode > Color Table Load/Save (.act)**, plus palette BMP/PNG opened as Indexed (psd/src/act.rs, file-format-parity.md).
- **Preset file formats**: `.abr`, `.grd`, `.pat`, `.aco`, `.act`, `.ase`, `.asl`, `.shc`, `.kys` read and write
  (file-format-parity.md, Presets table). These belong on Pigment's presets pages, not this one.
- **Per-layer XMP** (`layer.xmpMetadata`, engine/src/cmd/layer_xmp_cmds.rs) kept through PSD.
- **PSD Measurement Scale and Count data** (io/src/annotations_map.rs, resource 1074).
- **Package** (file.package, print_cmds.rs:1687): collect the linked files into a folder. Pigment's row 213 mentions it,
  but only inside the linked-smart-object row.
- **Print**: the CUPS/IPP client in Rust, the Linux print portal, Japanese paper sizes, remembered settings, dry run
  (docs/printing.md).
- **Batch extras**: naming templates, a UTF-16 error log, Continue/Stop after Esc, override of the action's Open
  steps (file_cmds/batch_run.rs, batch_naming.rs).

Beyond Photoshop:

- **Formats Photoshop lacks**: OpenRaster R/W, Krita .kra read, GIMP .xcf read, Paint.NET .pdn read,
  Affinity .af/.afphoto/.afdesign/.afpub read (native, crates/affinity in craft-libs), QOI R/W, DDS R/W (BC1-BC3,
  mip chains), FITS R/W, XPM read, DPX write (Photoshop only reads DPX), deep EXR and Cryptomatte read, WebP in Save for Web.
- **Native .pcraft**: incremental saves, autosave, crash recovery and atomic saves (crates/format). These go beyond Pigment's
  .pigment container (rows 47 and 214).
- **Headless CLI** (apps/photocraft-cli: convert, run, batch, `--metadata`, `--jpeg-format`, `--dds-*`, ...), a
  **JSON control channel** and an **MCP server** (crates/automation). Every menu command can be scripted by its id,
  and an external AI agent can drive the open window through the ArtCraft Launcher's agents switch (craft-ai-agents).
  This is the real counterpart to Pigment's in-app assistant (row 173) and scripting rows (198-202).
- **Sandboxed WebAssembly plug-ins** (crates/plugins, ABI v1, filters only).
- **Vector smart objects edited in VectorCraft** (SVG, PDF, AI, EPS kept in their native format, docs/embedded-vector-editing.md).
- **Coated FOGRA39 profile fitted to Fogra's characterisation data** and a synthetic coated CMYK model (craft-libs
  cms synth.rs), so CMYK work needs no Adobe profiles.
- **Own pure-Rust ICC v2/v4 CMS** (craft-libs/crates/cms, about 7,000 lines): LUT profiles (mft1/mft2/mAB/mBA),
  named-colour profiles, device links, GPU 3D LUT display transform. Pigment uses LittleCMS 2 through WASM instead.
- **Classical Object Finder** (hover-to-select, ui-egui/src/tools/object_finder.rs) and **Remove tool** (non-local patch
  completion). Both work offline with no model.

## (b) What limits PhotoCraft's real usefulness in this area

- **PSD exchange is not reliable yet** (gaps.md G1, "blocks beta"). Photoshop-authored oracle 190/258 (74%), psd-tools
  249/309. Photoshop cannot reopen some of its files (#1281, #2469). Smart-filter re-render matches Photoshop on only 5
  of 30 files. No test opens its exports in a third-party editor (FILE-216-4). So the many PSD rows marked Done here are
  "implemented and round-trips with itself", not "accepted by Photoshop". Pigment's ag-psd path has no such corpus either,
  so this caveat cuts both ways.
- **Performance budgets**: 3 of 25 budgeted scenarios meet budget (target-app-parity.md). In the committed baseline,
  opening a 20 MP PSD to first pixels takes 1.75 s p50 (budget 1.0 s) and moving a layer on 15000x10000 16-bit takes 2.7 s
  p50. The baseline was taken on a heavily loaded machine (load 224), so these numbers overstate the problem, but no clean
  run exists.
- **Crash**: P12 (arrow-key nudge in a 150-layer document) panics in the wgpu compositor ("Buffer with
  'pc_compose_uniforms' label is invalid"). PSB over 4 GB fails to open from File > Open on Windows (#375).
- **Open-bug backlog**: about 150 open UI issues and 41 open performance issues (target-app-parity.md). G3, the user bug
  backlog (250-400 h), blocks beta.
- **Stubs behind live menu items**: File > Import > WIA Support returns zero devices on every platform
  (wia_cmds.rs:15, "not yet wired"). The History Log preference's Metadata destination does nothing; only the text-file
  destination writes (prefs_ui/save.rs:330). View > 32-bit Preview Options' Highlight Compression is a no-op
  (proof_sim.rs:15). "All 664 menu items dispatch a live command" measures wiring, not depth.
- **Thin features**:
  - Video is frame stacks only: no video codec at all, so no MP4/MOV open and no H.264 Render Video. Render Video writes an
    animated GIF or an image sequence.
  - The Timeline panel is 226 lines: playhead, fps and work area, with no tracks, clips or keyframes. There is no frame
    animation (atn_cmds/events.rs:959).
  - Merge to HDR Pro, Vanishing Point and similar are parameter dialogs or partial workspaces (G7).
  - File Info edits 6 Dublin Core fields and shows 9 camera fields. There is no IPTC, no GPS and no Origin tab.
  - Export Color Lookup Tables writes .cube only.
  - PDF write is one flattened page. PDF read is raster pages only.
  - AVIF cannot be opened, and AVIF write is off in default builds.
  - JPEG XL is write-only, lossless and without metadata.
- **No AI at all**: no ML runtime (AUTO-219-7) and no in-app generative or LLM features. G15 needs an owner decision on
  model licences (#41). Every generative row that Pigment covers with the user's OpenAI or Gemini keys is Missing in PhotoCraft.
- **No JavaScript scripting by policy**: AGENTS.md forbids JS in the app (gaps.md G11). Scripting is command-id JSON
  through the CLI, MCP and File > Scripts > Browse. Unmapped `.atn` events (89 still unmapped at #10606; 145 supported events by file-format-parity.md's latest count) load as kept steps that fail at playback by name.
- **Platform gaps in colour**: the monitor profile is detected only on macOS and Linux X11. Windows and Wayland use sRGB
  or a chosen .icc. There is no HDR/EDR output (hardware-parity.md).
- **Docs drift**, a reason to trust the code over the docs:
  - file-format-parity.md says PCX has no reader, but image-codecs has a PCX decoder (codecs/pcx.rs).
  - gaps.md G10 still lists DICOM and WBMP as missing, but the code has a DICOM reader and a WBMP writer (Save for Web).
  - gaps.md G14 still lists compressed RAF as missing; file-format-parity.md says it decodes (#7377).
  - target-app-parity.md quotes PSD oracle floors (133/256) that are older than gaps.md's (190/258).
- **Licensing / patents**: HEIF read uses a pure-Rust HEVC decoder (heic-rs). The code is clean, but HEVC patents are the
  same concern that made Pigment mark HEIF "Not feasible". CR3 is blocked on purpose: no public CRX specification exists,
  so no clean-room decoder can be written.
