# File and Edit menus, Preferences: what PhotoCraft has beyond the inventory, and what limits it

Page: /home/user/claude/pigment/docs/parity/file-edit.md (202 rows). PhotoCraft clone: /home/user/storytold/photocraft at abb30df.

## (a) PhotoCraft features in this area with no row on the page

Photoshop features the inventory missed:

- **Preferences > Plugins section**: Additional Plug-ins Folder (loads PhotoCraft's own `.wasm` plug-ins), Generator on/off (drives File > Generate > Image Assets). Show Extension Panels and Allow Scripts to Connect are stored but hidden as unimplemented (crates/engine/src/prefs.rs:1027, prefs/validate.rs:38-47).
- **Tools preference Show Highlight on Rollover** (Move tool Auto-Select outline), and **Preferences > Interface > Clip Thumbnails to Layer Bounds** (prefs.rs:344, 462).
- **Save a Copy / Save As per-format option dialogs beyond the page's list**: Targa Options (24/32 bit) and the Photoshop Format Options prompt (Maximize Compatibility: Ask) (crates/ui-egui/src/dialogs/targa_options_ui.rs, services.rs FormatChoices).
- **Free Transform a Copy (Cmd+Alt+T) and Transform Again on a Copy** as separate commands (engine/src/shell_commands.rs:54, edit_cmds.rs:1277). The page has one combined row.
- **Edit > Preferences > History Options: Show New Snapshot Dialog by Default** and the other History panel options stored in preferences (prefs.rs:1274).

Beyond Photoshop:

- **File > Open EXR Parts...**: per-part and per-channel-group layers from multi-part EXR, stereo views, an additive beauty precomp from AOVs; deep EXR and Cryptomatte readers (engine/src/cmd/exr_cmds.rs:79).
- **Native `.pcraft` format**: incremental and atomic saves, autosave and crash recovery, optional full composite (file-format-parity.md "Formats Photoshop doesn't have").
- **Extra formats**: Affinity `.af/.afphoto/.afdesign/.afpub` import (21 pinned public documents within 0-4.6/255 of their thumbnails), Paint.NET `.pdn` import, OpenRaster read/write, ICO, QOI, DirectDraw Surface with BC1-BC3 and mip chains, FITS, DPX write (Photoshop only reads DPX), Cineon write, Amiga IFF write; SVG opens as editable shape layers or a vector smart object; lossless and lossy WebP in Save for Web; JPEG XL and ICO in Export As.
- **PDF spot-plate output**: spot channels written as overprinting `/Separation` plates, a Multichannel document as plates alone (gaps.md G10).
- **Automation surface**: every menu command is a command id that the CLI (`photocraft-cli`), a loopback JSON control channel and an MCP server drive; Batch, droplets and Image Processor run from the CLI; batch naming templates `{name}/{serial}/{date}` (docs/batch-naming.md); Image Processor can take copies of open documents with unsaved edits.
- **Photoshop `.atn` actions load, play and save** (128 events mapped, 89 unmapped; docs/atn.md), and `.kys` keyboard-shortcut files import and export.
- **Help > Check for Updates** with an opt-out check per launch (DIST-220-1, partial).
- **Preferences Photoshop lacks**: pressure curve for pens, nudge bundling into one History state, low-latency drawing, GPU backend and adapter choice, effect-cache and GPU memory budgets, Linux display server, notifications auto-hide, system title bar, a LUT folder for Color Lookup, PDF import DPI and page range, EXR as ACEScg, SVG group rasterise depth, 14 UI themes.
- **Platforms**: a WebAssembly build that runs in the browser, Linux packages (AppImage, deb, rpm, Flatpak), FreeBSD (partial), Windows ARM64.

## (b) What limits PhotoCraft's real usefulness in this area

- **Open bugs.** gaps.md G3: 579 open issues at 2026-10-10, mostly from 0.5/0.6 users: about 150 UI/panels/menus/shortcuts, 94 file/format, 87 layers, 41 performance, plus 25 Linux/Wayland, 24 Windows and 20 macOS. Its own readiness estimate is ~45% "ready for real work" against ~76% feature breadth (target-app-parity.md).
- **PSD reliability (G1, "blocks beta").** Photoshop does not always accept PSDs PhotoCraft writes (#1281: Photoshop 26.6 cannot reopen its files; #2469), and Photoshop-authored files do not always render as Photoshop renders them: Photoshop-oracle floor 190/258 (74%), psd-tools 249/309, smart-filter re-render matches 5/30. No test opens its exports in a third-party editor (FILE-216-4).
- **Performance budgets (G2, "blocks beta").** 22 of 25 budgeted scenarios over budget at the 2026-10-05 baseline: layer move with styles 321 ms against 25 ms, opacity change 276 ms against 20 ms, paste of 12 MP 1.2 s against 100 ms, Select Subject 559 ms against 100 ms; menus slow with thousands of layers (#2460).
- **Crashes and hangs.** The 150-layer nudge crashes the GPU compositor (P12, G2); the Type tool froze the app for 60 s on one macOS machine (#2518); it cannot start without a GPU adapter (#2519, #2412); the web build can still trap on allocations that are not gated (G17, #10030-#10032, #6615).
- **Menu items that are live but thin.** File > Import > WIA Support is a stub that reports zero devices ("WIA device enumeration not yet wired", engine/src/cmd/wia_cmds.rs:11-21). Render Video writes only image sequences or animated GIF (no video codec), and nothing opens video files. Artboards to PDF, Save As PDF and PDF import are raster only (FILE-215-10). Automate > Lens Correction uses generic focal-length profiles. Layer Comps to PDF, PDF Presentation and Print Selected Area are missing.
- **Preferences that do nothing.** 8 of 203 are stored but hidden from the dialog because nothing reads them (general.colorPicker, workspace.autoShowHiddenPanels, workspace.enableFloatingDocumentWindowDocking, performance.legacyCompositing, plugIns.showExtensionPanels, plugIns.allowScriptsToConnect, type.textEngine, enhancedControls.scrubbySliderAcceleration; scorecard.md "Settings that do nothing"). Panel groups cannot float or tear off (UI-217-5).
- **Preset depth.** Edit > Presets > Preset Manager handles only brushes, custom shapes and patterns, and Export/Import Presets only brushes, custom shapes and tool presets; there is no `.tpl` reader.
- **No AI.** No ML runtime and no remote-provider path for Generative Fill/Expand, Sky Replacement, Neural Filters or learned Select Subject (G15, AUTO-219-7); Select Subject and Sky are classical heuristics.
- **Ecosystem.** No ExtendScript/UXP, no .8BF hosting; its own WebAssembly plug-in ABI is v1 and filters only (G16, AUTO-219-6). AGENTS.md forbids JavaScript in the app, so a scripting dialect is an open owner decision (G11).
- **Distribution.** Windows builds are unsigned (DIST-2); no in-app bug report (DIST-220-3).
- **Its documents lag its code in both directions.** scorecard.md still calls the Content-Aware Fill workspace "generic dialog" (TOOL-214-15), but crates/ui-egui/src/dialogs/caf_ui.rs is a full workspace; gaps.md G5 says "the full interpolation list" is missing, but prefs.rs:57 has all seven Photoshop methods. On the other side, the menu checklist counts WIA Support as live although it is a stub. Its docs are leads, not proof, either way.
