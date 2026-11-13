# Parity: File and Edit menus, Preferences

Part of [Pigment and Photoshop: feature parity](../PARITY.md), as of Pigment 0.3.1 (November 2026).

File and Edit are the best-covered menus structurally (no stubbed commands; every item in /home/user/claude/pigment/src/main/menu.js is registered and implemented), but only about a third of Photoshop's inventory here is fully done. The solid parts are Open/Save/Close/Revert, Batch, Image Processor, Photomerge, Load Files into Stack, Statistics, Auto-Align/Auto-Blend, Content-Aware Scale, Free Transform with Warp presets, Purge, Print layout and the basic Fill/Stroke/clipboard commands. The biggest gaps are whole subsystems the menus depend on: ICC colour management (Color Settings, Assign/Convert to Profile, embedded profiles, print colour management), PDF/EPS/RAW/HDR/HEIF/JPEG 2000 formats, PSD round-trip fidelity (layer styles, smart objects, shapes and fill layers are lost or rasterised, 8-bit RGB only), artboards/layer comps/slices/variables/timeline (which take Artboards to Files, Layer Comps to Files, Data Sets, Render Video and Video Frames to Layers with them), and a scripting/plugin engine. In Edit, the Content-Aware Fill workspace does not exist (the command fills directly with no sampling area, adaptation settings or output choice), Sky Replacement is only a prompt-driven provider call, and Define Brush Preset, Define Custom Shape, Preset Manager, Search, Check Spelling, Find and Replace Text, Paste Outside, Toggle Last State, Split Warp, and the Keyboard Shortcuts/Menus/Toolbar editors are missing. Preferences is a single page of 17 settings (/home/user/claude/pigment/src/renderer/lib/extras.js) against Photoshop's twenty sections; several settings already defined in /home/user/claude/pigment/src/shared/defaults.js (canvasBackground, gridSubdivisions, animatedZoom, recentLimit, restoreSession) have no UI or no effect, and the main-process file watcher is never used by the renderer. Truly not-feasible items are limited to Adobe services: Stock templates and search, Share for Review/Invite, cloud documents and Version History, Firefly, and loading Adobe's own plugins and scripts unmodified.

98 missing · 47 partial · 6 approximate · 7 not feasible · 44 done · 202 entries

## prefs

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Export Preferences | File > Export > Export Preferences (Preferences > Export) | Missing | No Quick Export format, destination (ask / next to document), metadata or colour-space preferences. | S | 0.6 · export-as |
| Camera Raw preferences (defaults, sidecar XMP, cache, DNG and JPEG/TIFF handling, performance) | Preferences > Camera Raw | Missing | The Camera Raw filter (/home/user/claude/pigment/src/renderer/lib/develop-ui.js) has no preferences, raw defaults or presets storage. | M | 0.5 · camera-raw-workspace |
| Cursors: Other Cursors (Standard / Precise), Brush Preview colour, brush leash colour | Preferences > Cursors | Missing | No options for non-painting cursors or preview colours. | S | 0.5 · brush-painting-behaviours |
| Enhanced Controls (Microsoft Dial, Touch Bar) | Preferences > Enhanced Controls | Missing | No hardware control support. | M | 0.10 · accessibility-i18n-input |
| File Handling: File Compatibility (Camera Raw preferences, prefer Camera Raw for raw files, Ignore EXIF profile tag, Ignore Rotation Metadata, Ask Before Saving Layered TIFF, Disable PSD compression, Maximize PSD and PSB Compatibility) | Preferences > File Handling: File Compatibility | Missing | No such options; EXIF orientation is always applied by the browser decoder and PSDs always carry a composite. | M | 0.8 · preferences-dialog |
| File Handling: Image Previews, File Extension case, Save As to Original Folder, Enable legacy Save As, do not append 'copy' | Preferences > File Handling: File Saving Options | Missing | No such options; .pigment always stores a thumbnail and Save a Copy always appends ' copy'. | S | 0.8 · preferences-dialog |
| General: Color Picker (Adobe or system) and HUD Color Picker | Preferences > General | Missing | Only Pigment's own picker; no system picker choice and no HUD picker. | S | 0.5 · color-picker-swatches |
| General: Export Clipboard | Preferences > General: Export Clipboard | Missing | Copies always go to the system clipboard as PNG; there is no switch to keep large copies internal. | S | 0.8 · preferences-dialog |
| General: Auto show the Home Screen, Use Legacy New Document Interface, Beep When Done | Preferences > General: Options | Missing | The welcome screen always shows with no document; no completion sound; one New Document dialog. | S | 0.8 · preferences-dialog |
| Guides, Grid & Slices: guide colours and styles (canvas, artboard, smart guides) | Preferences > Guides, Grid & Slices: Guides | Missing | Guide colour and style are fixed. | S | 0.4 · guides-snapping |
| Guides, Grid & Slices: Slices (line colour, show slice numbers) and Path options | Preferences > Guides, Grid & Slices: Slices, Paths | Missing | No slices; path outline colour and thickness are fixed. | S | 0.10 · slices-web-export |
| History Log (save to metadata, text file or both; Sessions Only, Concise, Detailed) | Preferences > History Log | Missing | No edit log is written anywhere. | M | 0.8 · file-info-dialog |
| Interface: canvas colour and border per screen mode (Standard, Full Screen with Menus, Full Screen, Artboards) | Preferences > Interface: Appearance | Missing | settings.canvasBackground is defined in /home/user/claude/pigment/src/shared/defaults.js but has no UI and no reader; there are no screen modes beyond the OS full screen. | S | 0.7 · screen-modes-extras |
| Interface: Show Channels in Color, Dynamic Color Sliders, Show Menu Colors | Preferences > Interface: Options | Missing | No such options. | S | 0.8 · preferences-dialog |
| Interface: UI Language, UI Font Size, UI Scaling | Preferences > Interface: Presentation | Missing | English only with no string catalogue; no font size or scaling control (OS zoom only). | L | 0.10 · accessibility-i18n-input |
| Technology Previews | Preferences > Technology Previews | Missing | No experimental feature switches. | S | 0.8 · preferences-dialog |
| Tools: Show Tooltips / Rich Tooltips, Enable Gestures, Use Shift Key for Tool Switch, Overscroll, Enable Flick Panning | Preferences > Tools | Missing | Tooltips are always on and Shift+letter always cycles; no gesture, overscroll or flick panning settings. | S | 0.8 · preferences-dialog |
| Tools: Snap Vector Tools and Transforms to Pixel Grid, Show Transformation Values, Double Click Layer Mask Launches Select and Mask, Vary Round Brush Hardness based on HUD | Preferences > Tools | Missing | None of these options exist (Pigment adds its own 'Scale shape strokes with transforms'). | S | 0.8 · preferences-dialog |
| Transparency & Gamut: Gamut Warning colour and opacity | Preferences > Transparency & Gamut: Gamut Warning | Missing | View > Gamut Warning exists but its overlay colour and opacity are fixed. | S | 0.6 · soft-proofing |
| Units & Rulers: Type unit, Column Size (width, gutter), New Document Preset Resolutions (print, screen), Point/Pica Size | Preferences > Units & Rulers | Missing | None of these exist; type size is always in pixels. | S | 0.8 · preferences-dialog |
| Preferences dialog structure | Edit > Preferences (20 sections, Prev/Next, search) | Partial | One page with four headings (Interface, Cursors and tools, Canvas, Performance) and 17 settings in extras.js, plus Reset All Settings. | M | 0.8 · preferences-dialog |
| Cursors: Painting Cursors (Standard, Precise, Normal Brush Tip, Full Size Brush Tip, crosshair in tip, only crosshair while painting) | Preferences > Cursors: Painting Cursors | Partial | cursorStyle: Brush outline, Precise, Dot. No full-size tip (soft edge), no crosshair-in-tip options. | S | 0.5 · brush-painting-behaviours |
| File Handling: Recent File List Contains N files | Preferences > File Handling | Partial | settings.recentLimit (20) is honoured by /home/user/claude/pigment/src/main/ipc.js but has no field in Preferences; the menu shows 15. | S | 0.8 · preferences-dialog |
| General: Reset All Warning Dialogs, Reset Preferences on Quit | Preferences > General | Partial | Reset All Settings resets preferences, tool options, swatches, brush presets and layout at once. There are no 'don't show again' warnings to reset. | S | 0.8 · preferences-dialog |
| General: Resize Image During Place, Skip Transform when Placing, Always Create Smart Objects when Placing | Preferences > General: Options | Partial | 'Place files as smart objects' exists (placeAsSmart). Resize-to-fit is always on and the transform step is always skipped, with no preferences for either. | S | 0.7 · linked-smart-objects |
| Guides, Grid & Slices: Grid colour, style, Gridline Every, Subdivisions | Preferences > Guides, Grid & Slices: Grid | Partial | Grid spacing in pixels only. settings.gridSubdivisions exists without UI; no colour, style (lines, dashes, dots) or units. | S | 0.4 · guides-snapping |
| Interface: Color Theme (four brightness levels), Highlight Color, Neutral Color Mode | Preferences > Interface: Appearance | Partial | Theme is System, Light or Dark; no intermediate greys, highlight colour or neutral mode. | S | 0.8 · preferences-dialog |
| Performance: Memory Usage (let the app use N% of RAM) | Preferences > Performance: Memory Usage | Partial | Only a per-document history memory cap (historyMemoryMB). No overall memory budget or usage readout. | M | 0.11 · scratch-memory-limits |
| Tools: Animated Zoom, Zoom Resizes Windows, Zoom with Scroll Wheel, Zoom Clicked Point to Center | Preferences > Tools | Partial | Zoom with the scroll wheel is in Preferences. settings.animatedZoom exists in defaults.js without UI or a reader; the other two are absent. | S | 0.6 · view-navigation |
| Transparency & Gamut: Grid Size and Grid Colors | Preferences > Transparency & Gamut: Transparency Settings | Partial | Small/Medium/Large and two custom colours (checkerboardSize, checkerboardLight, checkerboardDark). No 'None' and no named colour presets. | S | 0.8 · preferences-dialog |
| General: Image Interpolation default | Preferences > General: Image Interpolation | Done | resampleMethod (Image Size) and transformInterpolation in the Preferences dialog. |  |  |
| General: Use Legacy Free Transform (proportional scaling by default) | Preferences > General: Options | Done | 'Keep proportions while transforming (Shift releases)' (transformProportional). |  |  |
| Performance: History States | Preferences > Performance: History & Cache | Done | historyLimit, 1 to 1000, applied to open documents at once. |  |  |
| Units & Rulers: Rulers unit | Preferences > Units & Rulers: Units | Done | rulerUnit: pixels, inches, centimetres, millimetres, points, percent (no picas). |  |  |

## export

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Zoomify | File > Export > Zoomify | Missing | No tiled-pyramid export. The Zoomify viewer is third-party; a tile pyramid plus Pigment's own HTML viewer would be the substitute. | S | 0.10 · slices-web-export |
| Generate > Image Assets | File > Generate > Image Assets | Missing | No automatic asset export from layer names (for example 'icon.png, 200% icon@2x.png'). | M | 0.10 · slices-web-export |
| Save for Web: named presets and Optimize to File Size | Save for Web: Preset menu, panel menu | Missing | The last settings are remembered (settings.saveForWeb) but there are no named presets and no target-file-size optimiser. | S | 0.9 · save-for-web |
| Save for Web: encoder options (JPEG Progressive/Optimized/Blur, GIF Lossy/Interlaced/Web Snap, PNG Interlaced, Embed Color Profile, Metadata menu) | Save for Web: optimisation settings | Missing | None of these exist; 'Convert to sRGB' is a no-op checkbox because documents are sRGB already. | M | 0.9 · save-for-web |
| Color Lookup Tables | File > Export > Color Lookup Tables | Partial | file:export-luts in /home/user/claude/pigment/src/renderer/lib/adjust-more-ui.js writes .cube and .3dl with a description and 16/32/64 grid points. Missing: .csp and ICC (abstract/device-link) output, copyright field, lowercase-extension option and Photoshop's quality range up to 256. | S | 0.6 · color-settings |
| Export As: Image Size, Scale, Resample method, Canvas Size | File > Export > Export As: Image Size / Canvas Size | Partial | Width, height (linked) and a scale preset. No Resample menu (the canvas 'high' smoothing is always used) and no Canvas Size fields. | S | 0.6 · export-as |
| Export As: multiple scales with suffixes, layer/artboard asset list | File > Export > Export As: Scale All, asset list | Partial | One file per export. Selected layers have their own Export As (/home/user/claude/pigment/src/renderer/lib/layers-extras/export.js) but there is no 1x/2x/3x list with suffixes and no per-asset settings. | M | 0.6 · export-as |
| Export As: preview with zoom and 2-up comparison | File > Export > Export As: preview pane | Partial | No preview; only a debounced 'about N KB' estimate from a real encode. Save for Web has the 2-up preview. | M | 0.6 · export-as |
| Layers to Files | File > Export > Layers to Files | Partial | file:export-layers (file-ops.js): top-level layers or groups, any flat format, Visible Layers Only, Trim, file name prefix. Missing: PSD and PDF output, per-format options (JPEG quality, PNG-8 transparency, TIFF compression), Include ICC Profile, nested layers. | S | 0.6 · export-as |
| Quick Export as [format] | File > Export > Quick Export as PNG | Partial | file:export-quick in /home/user/claude/pigment/src/renderer/lib/file-ops.js always writes PNG next to the document (asks before overwriting). The format, quality, location and metadata cannot be changed because Export Preferences does not exist. | S | 0.6 · export-as |
| Save for Web: Color Table editing (lock, shift to web, delete, map to transparent, sort, load/save table) | Save for Web: Color Table panel and menu | Partial | The table is shown read-only; a custom palette can be supplied through the Indexed Color fields. No per-swatch editing or .act load/save in this dialog. | M | 0.9 · save-for-web |
| Save for Web: Original / Optimized / 4-Up tabs | Save for Web: view tabs | Partial | 2-up only (README limit); no single-pane tabs and no 4-up comparison of settings. | M | 0.9 · save-for-web |
| Export As: formats | File > Export > Export As: Format | Done | PNG, PNG-8, 16-bit PNG, JPEG, WebP, GIF, TIFF and Targa with quality and per-format fields (file-ops.js exportAs). Covers Photoshop's PNG/JPG/GIF and more. |  |  |
| Save for Web (Legacy): core optimisation | File > Export > Save for Web (Legacy) | Done | /home/user/claude/pigment/src/renderer/lib/modes/save-for-web.js: 2-up original/optimised, GIF, JPEG, PNG-8, PNG-24 and WebP, palette type, colour count, forced colours, dither and amount, transparency, matte, image size and percent, zoom, real file size and download time, colour table display. |  |  |

## formats

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Open: 32-bit HDR formats (OpenEXR, Radiance .hdr, Portable Bit Map/PFM) | File > Open | Missing | 32-bit documents exist (depth.js) but only TIFF float and .pigment carry them; no EXR/HDR/PBM readers. | M | 0.10 · hdr-32bit |
| Open: EPS / DCS (Rasterize EPS Format dialog) | File > Open | Missing | No PostScript interpreter. Would need a bundled or user-installed interpreter (Ghostscript is AGPL, so user-installed helper is the honest route). | L | 0.9 · formats-more-codecs |
| Open: JPEG 2000 and JPEG XL | File > Open | Missing | Neither is decoded (Chromium does not decode them and no reader is registered). OpenJPEG and libjxl are open source and can be built to WASM. | M | 0.9 · formats-more-codecs |
| Open: legacy and specialist formats (DICOM, PCX, IFF, Pixar, Scitex CT, Cineon/DPX, Photoshop Raw with Raw Options, WBMP, MPO) | File > Open | Missing | None of these are registered in OPEN_READERS (io.js). | M | 0.9 · formats-more-codecs |
| Open: camera RAW files (DNG, CR2/CR3, NEF, ARW, RAF...) through Camera Raw | File > Open (Camera Raw dialog) | Missing | No RAW decoder; the Camera Raw filter develops RGB layers only. Adobe's camera profiles are proprietary, but an open decoder (LibRaw compiled to WASM) feeding the existing develop pipeline is an honest substitute. | L | 0.6 · raw-open-workflow |
| Open: PDF and Illustrator files (Import PDF dialog: pages/images, crop to, resolution, mode, bit depth) | File > Open (Import PDF) | Missing | No PDF reader. pdf.js can rasterise pages and extract images offline. | M | 0.6 · pdf-import |
| Photoshop PDF save (Adobe PDF presets, compression, output, security, preserve editing capabilities) | File > Save As: Photoshop PDF; Edit > Adobe PDF Presets | Missing | The only PDF is Chromium's print-to-PDF of one flattened page (print.js saveAsPdf). No PDF writer with presets, compression, PDF/X or passwords, and no Adobe PDF Presets manager. A local PDF writer with Pigment's own presets is the substitute for Adobe's .joboptions. | L | 0.7 · pdf-export |
| Scripts > Load Multiple DICOM Files | File > Scripts > Load Multiple DICOM Files | Missing | No DICOM reader. | M | 0.9 · formats-more-codecs |
| Open: PSD/PSB fidelity | File > Open (Photoshop and Large Document formats) | Partial | readPsdDocument in /home/user/claude/pigment/src/renderer/lib/io.js reads layers, groups, raster masks, opacity, fill opacity, blend modes, clipping, locks, text (one style per layer) and 14 adjustment kinds. Not read: layer styles/effects, vector masks, shape and fill layers (arrive as pixels), smart objects and smart filters (pixels), artboards, layer comps, guides, alpha/spot channels, paths, ICC profile, 16/32-bit depth and CMYK/Lab/Grayscale modes (all become 8-bit RGB). | L | 0.5 · psd-layers |
| Save As: format list | File > Save As: Format menu | Partial | Writes .pigment, PSD, PNG, JPEG, WebP, GIF, TIFF and Targa (SAVE_FILTERS in documents.js plus depth.js and modes/formats.js). Missing: PSB (opened but not written), BMP (read only), Photoshop PDF, EPS, DCS, JPEG 2000, JPEG XL, OpenEXR, Radiance, Portable Bit Map, PCX, DICOM, IFF, Photoshop Raw, Scitex, Pixar, Multi-Picture. | M | 0.9 · formats-more-codecs |
| Save: PSD write fidelity (and Maximize Compatibility) | File > Save As: Photoshop | Partial | writePsdDocument (io.js) always writes 8-bit RGB with a composite. Kept: pixels, groups, masks, opacity, blend, clipping, locks, editable text (one style), 14 adjustment kinds, XMP. Lost: layer styles (not written and not baked in), smart objects, shapes and fill layers (rasterised), alpha/spot channels, paths, guides, 16/32-bit data, image mode. No Maximize Compatibility choice. | L | 0.5 · psd-layers |
| Format option dialogs (JPEG Options, PNG Format Options, TIFF Options, WebP options) | File > Save As: per-format dialogs | Partial | JPEG and WebP ask for quality only (documents.js lossyOptions): no matte, baseline/optimized/progressive, lossless WebP or metadata switches. PNG has no compression/interlace choice. TIFF depth and compression fields exist in Export As only; Save As to .tif asks nothing; no layered TIFF, byte order or pyramid. | M | 0.6 · save-options-common-formats |
| Open: HEIF/HEIC | File > Open | Not feasible | HEVC is patent-encumbered, so a decoder cannot be shipped freely. Substitute: use the operating system's codec where installed (macOS ImageIO, Windows HEIF extension) or a user-installed libheif. |  |  |
| Open: common raster formats (PNG 8/16-bit and palette, JPEG, WebP, GIF, BMP, TIFF, Targa, AVIF, SVG, ICO) | File > Open | Done | io.js decodeImage plus registered readers in /home/user/claude/pigment/src/renderer/lib/depth.js (16-bit PNG, TIFF, TGA) and /home/user/claude/pigment/src/renderer/lib/modes/formats.js (GIF). Stated limits: TIFF without JPEG-in-TIFF, CCITT, YCbCr, Lab, BigTIFF, first page only; SVG is rasterised at its natural size. |  |  |

## file

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Browse in Bridge / Close and Go to Bridge | File > Browse in Bridge, File > Close and Go to Bridge | Missing | No file browser. Adobe Bridge is a separate Adobe application; the honest equivalent is a built-in folder and thumbnail browser (with ratings and keywords from the File Info metadata Pigment already reads). | L | 0.9 · home-new-doc-browser |
| Import > WIA Support / Images from Device (scanners and cameras) | File > Import > WIA Support (Windows), Images from Device (macOS) | Missing | No device acquisition. Needs native platform APIs (WIA, ImageCaptureCore) through a helper; TWAIN is licence-encumbered. | L | 0.9 · home-new-doc-browser |
| Open As (force a file format) | File > Open As (Windows) | Missing | Format is chosen by extension with magic-byte sniffing as fallback (io.js openDocument); the user cannot force a reader. | S | 0.6 · file-handling-autosave |
| Save As dialog options (As a Copy, Layers, Alpha Channels, Spot Colors, Notes, Use Proof Setup, Embed Color Profile) | File > Save As: Save options | Missing | The native save dialog has no option panel; the only question is a 'will be flattened' confirmation. Nothing lets the user drop layers or channels or embed a profile. | M | 0.6 · save-options-common-formats |
| Share (send the image to another app or service) | File > Share / Quick Share | Missing | No share command. The OS share sheet (macOS share menu, Windows share contract) on an exported copy would be the offline equivalent; Pigment only has Reveal in Finder/Explorer. | S | 0.6 · file-handling-autosave |
| File Handling: Save in Background and Automatically Save Recovery Information Every N minutes | Preferences > File Handling | Missing | Saving blocks behind a busy overlay and there is no crash recovery or autosave; settings.restoreSession and lastSession exist in defaults.js but nothing reads them. | M | 0.6 · file-handling-autosave |
| Auto-Update Open Documents (reload when the file changes on disk) | Preferences > General: Auto-Update Open Documents | Missing | /home/user/claude/pigment/src/main/watch.js and the watchFile IPC exist, but no renderer code calls watchFile or listens for file-changed, so nothing happens. | S | 0.6 · file-handling-autosave |
| Revert | File > Revert (F12) | Partial | file:revert in /home/user/claude/pigment/src/renderer/app.js reloads the file after a confirmation, but it replaces the document and discards its history; Photoshop records Revert as an undoable history state. F12 is not bound. | S | 0.6 · file-handling-autosave |
| Close, Close All, Close Others (with Save changes prompt) | File > Close / Close All / Close Others | Done | documents.js close/closeAll and files.js closeOthers; Photoshop's 'Apply to All' checkbox in the prompt is not offered (each document asks). |  |  |
| Exit / Quit (with unsaved-changes prompts) | File > Exit | Done | menu.js quit role and file:quit. |  |  |
| Open (multi-select, tabs, drag and drop, OS 'Open with', already-open files are activated) | File > Open | Done | DocumentManager.openDialog/openPaths in /home/user/claude/pigment/src/renderer/lib/documents.js. |  |  |
| Open Recent (list, Clear Recent File List) | File > Open Recent | Done | 15 entries in the menu, Clear Recent Files (menu.js, /home/user/claude/pigment/src/main/recent.js); also listed on the welcome screen. |  |  |
| Open as Smart Object | File > Open as Smart Object | Done | file:open-smart in /home/user/claude/pigment/src/renderer/lib/layers-extras/files.js: each file opens as its own document holding one smart object; layered files stay documents. |  |  |
| Save | File > Save | Done | documents.js save(); read-only formats and multi-layer flat files route to Save As. |  |  |
| Save a Copy | File > Save a Copy | Done | file:save-copy (documents.js saveAs with copy: true); the document keeps its path and dirty state. |  |  |

## transform

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Transform a duplicate and step-and-repeat | Ctrl+Alt+T (transform a copy), Ctrl+Alt+Shift+T (transform again on a copy) | Missing | Neither shortcut nor behaviour exists in keymap.js or image-ops.js. | S | 0.7 · transform-warp-depth |
| Warp: Split Warp Horizontally / Vertically / Crosswise, Remove Warp Split, Grid sizes (3x3, 4x4, 5x5, custom), Convert Warp Anchor Point, Toggle Guides | Edit > Transform submenu and Warp options bar | Missing | The net is always the single 4x4 Bezier patch; no splits, no grid choice, no guide options. | M | 0.7 · transform-warp-depth |
| Perspective Warp | Edit > Perspective Warp | Partial | PerspectiveWarp in warp.js: Layout and Warp modes, quads that snap together, Shift-click an edge to straighten. Missing: the three auto-straighten buttons (vertical, horizontal, both) and non-destructive use on a smart object. | S | 0.7 · transform-warp-depth |
| Puppet Warp | Edit > Puppet Warp | Partial | PuppetWarp in /home/user/claude/pigment/src/renderer/lib/warp.js: Mode (Rigid, Normal, Distort), Density, Show Mesh, pins, Alt-drag rotation, remove all pins. Missing: Expansion, Pin Depth (bring forward / send backward), Rotate Auto/Fixed with a numeric angle, and it rasterises a smart object instead of staying editable. | M | 0.7 · transform-warp-depth |
| Transform > Warp: control net and presets | Edit > Transform > Warp; options bar Warp menu, Bend, H, V | Partial | BezierWarp in warp.js with 15 presets (Arc to Twist), Bend, H and V. Missing the Cylinder preset and the Change Warp Orientation toggle. | S | 0.7 · transform-warp-depth |
| Free Transform options bar: numeric X, Y, W, H, rotation, horizontal and vertical skew, Maintain Aspect Ratio link | Free Transform options bar | Partial | X, Y, W%, H%, angle and one skew field. No vertical skew, and the W/H link is a preference (transformProportional) rather than a button in the bar; values are blank for a distorted quad. | S | 0.7 · transform-warp-depth |
| Free Transform: Interpolation | Free Transform options bar: Interpolation | Partial | Bicubic, Bilinear, Nearest Neighbor. No Bicubic Smoother, Bicubic Sharper or Bicubic Automatic. | S | 0.7 · transform-warp-depth |
| Free Transform options bar: reference point | Free Transform options bar: reference point locator and Use Relative Positioning | Partial | The pivot can be dragged on the canvas, but there is no nine-point locator, no show/hide toggle and no relative positioning (delta) switch. | S | 0.7 · transform-warp-depth |
| Content-Aware Scale | Edit > Content-Aware Scale | Done | /home/user/claude/pigment/src/renderer/lib/content-aware-scale.js: seam carving with Amount, Protect (alpha channel), Protect Skin Tones, W and H. No reference point locator or relative positioning fields. |  |  |
| Free Transform: handles and modifier keys | Edit > Free Transform (Ctrl+T) | Done | Transform tool in /home/user/claude/pigment/src/renderer/lib/image-ops.js: scale, rotate (Shift snaps 15 degrees), Alt from centre, Ctrl-drag distort, Ctrl+Shift skew; pixels, selections, text, shapes and smart objects. |  |  |
| Transform > Rotate 180, 90 CW, 90 CCW, Flip Horizontal, Flip Vertical | Edit > Transform | Done | edit:transform-rotate-180/90/-90 and flip-h/flip-v. |  |  |
| Transform > Scale, Rotate, Skew, Distort, Perspective | Edit > Transform | Done | edit:transform-<mode> commands in image-ops.js. |  |  |
| Transform > Again | Edit > Transform > Again (Ctrl+Shift+T) | Done | edit:transform-again replays the last matrix relative to the new bounds. |  |  |

## automation

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Automate > Create Droplet | File > Automate > Create Droplet | Missing | No droplet. Equivalent: a small launcher or shortcut that starts Pigment with a batch description for the dropped files. | M | 0.8 · automate-finish |
| Automate > Lens Correction (batch with lens profiles) | File > Automate > Lens Correction | Missing | Only the interactive Filter > Lens Correction exists. Adobe's lens profile database is licensed data; the open Lensfun database is the honest substitute for automatic profiles. | M | 0.9 · lens-correction-profiles |
| Automate > PDF Presentation | File > Automate > PDF Presentation | Missing | No multi-page PDF or slideshow output (the only PDF path is one page from the Print dialog). | M | 0.7 · pdf-export |
| Data Sets as Files (variables and data-driven graphics) | File > Export > Data Sets as Files; Image > Variables | Missing | No variables or data sets. | M | 0.9 · variables-data-sets |
| Import > Variable Data Sets | File > Import > Variable Data Sets | Missing | No variables. | M | 0.9 · variables-data-sets |
| Automate > Batch | File > Automate > Batch | Partial | lib/automate/batch.js: Set, Action, Source (Folder or Opened Files), Include All Subfolders, Override Action Open / Save As commands, Destination (None, Save and Close, Folder), File Naming with serial numbers, Errors (stop or log). Missing: Suppress File Open Options Dialogs, Suppress Color Profile Warnings, and the Import and Bridge sources. This agrees with the formats auditor's 'partial' and replaces the file-edit auditor's 'done'. | S | 0.8 · automate-finish |
| Automate > Contact Sheet II | File > Automate > Contact Sheet II | Partial | /home/user/claude/pigment/src/renderer/lib/automate/contact-sheet.js: folder or open documents, units, size, resolution, RGB/Grayscale, flatten, across/down, columns, rows, auto-spacing, rotate for best fit, caption font and size. Missing: bit depth, colour profile, separate vertical/horizontal spacing, font style, Bridge source, save/load presets. | S | 0.8 · automate-finish |
| Automate > Merge to HDR Pro | File > Automate > Merge to HDR Pro | Approximate | file:automate-merge-hdr (adjust-more-ui.js) is exposure fusion into a normal image followed by HDR Toning, with align and remove-ghosts options. No 32-bit radiance result, no EV/response-curve handling, no HDR Pro workspace (presets, edge glow, tone and detail, choice of base frame for deghosting). Users wanting a 32-bit master would notice. | L | 0.10 · hdr-32bit |
| Automate > Conditional Mode Change | File > Automate > Conditional Mode Change | Done | file:automate-conditional-mode in /home/user/claude/pigment/src/renderer/lib/modes.js. |  |  |
| Automate > Crop and Straighten Photos | File > Automate > Crop and Straighten Photos | Done | file:automate-crop-straighten in /home/user/claude/pigment/src/renderer/lib/automate.js with /home/user/claude/pigment/src/renderer/lib/automate/scan.js; each photo becomes a new document. |  |  |
| Automate > Fit Image | File > Automate > Fit Image | Done | automate.js fitImage with Don't Enlarge. |  |  |
| Automate > Photomerge | File > Automate > Photomerge | Done | /home/user/claude/pigment/src/renderer/lib/align-blend.js: files or open documents, Auto/Perspective/Collage/Cylindrical/Spherical/Reposition, Blend Images Together, Vignette Removal, Geometric Distortion Correction, Content Aware Fill Transparent Areas (vignette and distortion are estimated from the images, no lens profiles). |  |  |
| Scripts > Delete All Empty Layers | File > Scripts > Delete All Empty Layers | Done | automate.js deleteEmptyLayers, one undo step. |  |  |
| Scripts > Flatten All Layer Effects | File > Scripts > Flatten All Layer Effects | Done | automate.js flattenEffects. |  |  |
| Scripts > Flatten All Masks | File > Scripts > Flatten All Masks | Done | automate.js flattenMasks (pixel layers with raster masks; there are no vector masks to flatten). |  |  |
| Scripts > Image Processor | File > Scripts > Image Processor | Done | batch.js imageProcessorCommand: open images or folder, same location or folder, JPEG (quality 0 to 12), PSD, PNG, TIFF with Resize to Fit, Run Action, Copyright Info. Not present: save/load settings, 'open first image to apply settings', ICC profile inclusion. |  |  |
| Scripts > Load Files into Stack | File > Scripts > Load Files into Stack | Done | align-blend.js file:script-load-stack with Attempt to Automatically Align and Create Smart Object after Loading. |  |  |
| Scripts > Statistics | File > Scripts > Statistics | Done | align-blend.js file:script-statistics with the eleven stack modes and auto-align. |  |  |

## edit

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Fill: Scripted Patterns (Brick Fill, Cross Weave, Place Along Path, Random Fill, Spiral, Symmetry Fill) | Edit > Fill: Pattern > Script | Missing | No scripted pattern fills. (Tree, Picture Frame and Flame exist as Render filters, as in current Photoshop.) | M | 0.4 · patterns |
| Toggle Last State | Edit > Toggle Last State (Ctrl+Alt+Z) | Missing | The menu has Step Forward and Step Backward instead (the pre-2019 layout), and Ctrl+Alt+Z steps backward rather than toggling between the last two states. | S | 0.4 · conventions-shortcuts-fields |
| Fill shortcuts | Alt+Backspace, Ctrl+Backspace, Shift+F5, Shift+Backspace, with Shift to preserve transparency | Partial | Alt+Backspace/Delete, Ctrl+Backspace/Delete and Shift+F5 are bound (/home/user/claude/pigment/src/shared/keymap.js). Shift+Backspace (open Fill), the Shift variants that preserve transparency and Ctrl+Alt+Backspace (fill from history) are not. | S | 0.7 · edit-clipboard-finish |
| Fade | Edit > Fade (Ctrl+Shift+F) | Partial | edit:fade in /home/user/claude/pigment/src/renderer/lib/adjust-ui.js offers opacity and every blend mode, but only after a filter or adjustment (the only code that sets app.lastPixelEdit). It does not work after a brush stroke, Fill, Stroke or other paint command, has no shortcut and is not recorded in actions. | S | 0.7 · edit-clipboard-finish |
| Fill: Blending (Mode, Opacity, Preserve Transparency) | Edit > Fill: Blending | Partial | Mode (27 modes), opacity and Preserve Transparency are present. Photoshop's Behind and Clear fill modes are not. | S | 0.7 · edit-clipboard-finish |
| Stroke | Edit > Stroke | Partial | strokeDialog in edit-ops.js: width, colour, Inside/Center/Outside, mode, opacity. Needs a selection (Photoshop strokes the layer's content when there is none), no Preserve Transparency checkbox (follows the layer lock), no Behind/Clear modes. | S | 0.7 · edit-clipboard-finish |
| Fill: History | Edit > Fill: Contents > History | Approximate | Fills from the last saved state (history.savedSnapshot), not from the state or snapshot marked as the history source in the History panel. Noticeable to anyone using snapshots as the source. | S | 0.6 · history-panel-depth |
| Clear | Edit > Clear | Done | edit:clear: clears the selection (background colour on a transparency-locked layer), hides on a mask, deletes the layer when nothing is selected. |  |  |
| Fill: colour contents (Foreground, Background, Color..., Black, 50% Gray, White) | Edit > Fill: Contents | Done | fillDialog in edit-ops.js; works on layers and masks. |  |  |
| Purge (Undo, Clipboard, Histories, All, Video Cache) | Edit > Purge | Done | edit:purge in layers-extras/files.js with confirmation; Video Cache does not apply. |  |  |
| Undo / Redo (multiple steps) | Edit > Undo, Redo | Done | edit:undo and edit:redo in app.js; menu shows the step name; text fields and live typing use native undo. |  |  |

## workspace

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Menus (show/hide and colour menu items, menu sets) | Edit > Menus | Missing | The menu template is fixed in menu.js. | M | 0.5 · shortcuts-editor |
| Search (tools, panels, menus, help, Stock) / Discover panel | Edit > Search (Ctrl+F) | Missing | No command search. A local palette over the command registry and tools is buildable; Help, Learn and Stock results need Adobe services. | M | 0.4 · conventions-shortcuts-fields |
| Toolbar customisation (reorder, group, hide tools; extra tools; presets) | Edit > Toolbar | Missing | The toolbox layout is fixed in /home/user/claude/pigment/src/renderer/lib/toolbar.js; settings.toolboxColumns is defined but unused. | M | 0.9 · workspaces-toolbar |
| Workspace: Auto-Collapse Iconic Panels, Auto-Show Hidden Panels, Open Documents as Tabs, Enable Floating Document Window Docking, Large Tabs, Narrow Options Bar | Preferences > Workspace | Missing | Documents are always tabs in one window; there are no floating document windows or iconic panels to configure. | M | 0.8 · panel-docking |
| Keyboard Shortcuts editor (sets, application menus, panel menus, tools, taskspaces, conflict warnings, Summarize) | Edit > Keyboard Shortcuts | Partial | shortcutsDialog in app.js is a read-only table of the built-in keys. Nothing can be rebound, saved as a set or exported. | M | 0.5 · shortcuts-editor |
| Home screen (recent files with thumbnails, sort/filter, Learn, cloud and shared files) | Home screen shown with no document / File > New, Open | Partial | /home/user/claude/pigment/src/renderer/lib/welcome.js shows New, Open, New from clipboard, quick sizes and a recent list (name and path, no thumbnails, no sort or filter). Cloud, Shared with you and Learn tabs need Adobe services. | S | 0.9 · home-new-doc-browser |

## color-management

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Assign Profile | Edit > Assign Profile | Missing | No document profile to assign. | M | 0.5 · icc-engine |
| Color Settings (working spaces, colour management policies, conversion engine and intent, black point compensation, dither, blend RGB/text gamma, settings files) | Edit > Color Settings | Missing | No ICC colour management: profiles are not read, converted or embedded and everything is treated as sRGB (README). Adobe's ACE engine and some bundled profiles are proprietary; LittleCMS (WASM) with freely distributable profiles (sRGB, Display P3, Adobe RGB, ECI/FOGRA CMYK) is the open substitute. | XL | 0.6 · color-settings |
| Convert to Profile (basic and advanced) | Edit > Convert to Profile | Missing | No profile conversion; mode changes use fixed formulas (/home/user/claude/pigment/src/shared/pixels/color.js). | M | 0.6 · color-settings |
| New Document: Color Profile | File > New: Advanced Options > Color Profile | Missing | No ICC colour management at all; every document is treated as sRGB. Depends on the Color Settings subsystem. | M | 0.5 · icc-engine |
| Print: Color Management (Printer or Photoshop manages colors, printer profile, rendering intent, black point compensation, hard proofing) | File > Print: Color Management | Missing | No ICC handling; the flattened sRGB PNG is sent to the driver. | L | 0.8 · print |
| New Document: Color Mode and bit depth | File > New: Color Mode (Bitmap, Grayscale, RGB, CMYK, Lab) and 1/8/16/32 bit | Approximate | All five modes and 8/16/32 bit are offered (extras.js MODES/DEPTHS). CMYK and Lab documents are views over RGBA pixels, not real separations (README limits), so a prepress user would notice. | L | 0.10 · cmyk-lab-storage |

## presets

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Presets > Export/Import Presets and Migrate Presets | Edit > Presets > Export/Import Presets, Migrate Presets | Missing | Presets sit inside settings.json with no export or import. Migrating from an earlier Photoshop does not apply; importing Photoshop preset files is the useful equivalent. | M | 0.5 · preset-files-manager |
| Presets > Preset Manager | Edit > Presets > Preset Manager | Missing | No central manager for brushes, swatches, gradients, styles, patterns, contours, shapes and tool presets; brushes and swatches are edited only in their panels. | M | 0.5 · preset-files-manager |
| Photoshop preset file formats (.abr, .pat, .grd, .asl, .csh, .aco/.ase, .tpl, .atn) | Preset Manager and panel menus: Load / Save / Import | Missing | None can be read or written; .atn is recognised only to explain that it cannot be loaded (/home/user/claude/pigment/src/renderer/lib/actions/model.js). The formats are publicly documented or reverse-engineered, so readers are feasible offline. | L | 0.5 · preset-files-manager |
| Define Pattern | Edit > Define Pattern | Partial | edit:define-pattern (edit-ops.js) captures the merged selection, with no name dialog. Patterns live in memory only (last 24, lost on quit), there is no Patterns panel or picker, and only the most recent one is usable by Fill, Pattern Stamp, Paint Bucket and pattern layers. | M | 0.4 · patterns |
| Fill: Pattern with Custom Pattern picker | Edit > Fill: Contents > Pattern | Partial | Fills with app.currentPattern, the last pattern defined this session; no picker, no pattern library, error if none was defined. | S | 0.4 · patterns |

## timeline

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Render Video | File > Export > Render Video | Missing | No Timeline, frames or video layers. | XL | 0.11 · render-video |
| Import > Video Frames to Layers | File > Import > Video Frames to Layers | Missing | No video import. Chromium can decode common video locally, so frames to layers is buildable without a Timeline. | M | 0.10 · animation-io |
| Open: animated GIF as frames | File > Open (GIF opens with a frame animation in the Timeline) | Missing | GIF is read and written as a single frame; there is no Timeline. | L | 0.10 · animation-io |
| Open: video files as video layers | File > Open (MP4, MOV...) | Missing | No video layers or Timeline. | XL | 0.10 · video-timeline-core |
| Save for Web: animation frames and Looping Options | Save for Web: Animation section | Missing | GIF is written as one frame; there are no frames to export. | L | 0.10 · animation-io |

## content-aware

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Content-Aware Fill: Fill Settings (Color Adaptation, Rotation Adaptation, Scale, Mirror) | Edit > Content-Aware Fill: Fill Settings | Missing | inpaint() takes only a patch size; no colour adaptation levels, rotation, scale or mirrored patches. | M | 0.7 · content-aware-fill-workspace |
| Content-Aware Fill: Output To (Current Layer, New Layer, Duplicate Layer) and live preview panel | Edit > Content-Aware Fill: Output Settings, Preview | Missing | Always writes into the current layer with no preview before commit. | M | 0.7 · content-aware-fill-workspace |
| Content-Aware Fill workspace: Sampling Area (Auto, Rectangular, Custom; overlay opacity, colour, indicates), Sampling Brush, Lasso, Hand and Zoom tools | Edit > Content-Aware Fill: workspace and Sampling Area Options | Missing | No workspace. The user cannot see or edit which pixels are sampled; the source is always a fixed margin around the hole. | L | 0.7 · content-aware-fill-workspace |
| Fill: Content-Aware with Color Adaptation | Edit > Fill: Contents > Content-Aware | Partial | Choosing Content-Aware runs edit:content-aware-fill; there is no Color Adaptation checkbox and the dialog's mode and opacity are ignored for it. | S | 0.7 · content-aware-fill-workspace |
| Content-Aware Fill: the fill itself | Edit > Content-Aware Fill | Approximate | /home/user/claude/pigment/src/renderer/lib/content-aware.js runs a patch-based inpaint (/home/user/claude/pigment/src/shared/pixels/inpaint.js) from a margin around the selection straight into the active layer. Different algorithm from Adobe's; results are comparable on textures and weaker on structure. | M | 0.7 · content-aware-fill-workspace |

## metadata

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Export As: Metadata (None / Copyright and Contact Info) and Color Space (Convert to sRGB, Embed Color Profile) | File > Export > Export As: Metadata, Color Space | Missing | Exported files carry no XMP, EXIF or ICC profile and the dialog has no such options. | M | 0.6 · export-as |
| File Info: metadata templates (import, export, append/replace) | File > File Info: Template Folder menu | Missing | No .xmp template import or export. | S | 0.8 · file-info-dialog |
| File Info: Origin, IPTC, IPTC Extension, GPS Data, Audio/Video Data, Photoshop (history log), DICOM, Raw Data | File > File Info: remaining tabs | Partial | Only Credit and Source from Origin. No IPTC contact/image/status fields, no GPS, no raw XMP view, no history tab. | M | 0.8 · file-info-dialog |
| Metadata preserved in saved and exported files | File > Save As / Export (XMP, EXIF, IPTC carried in the file) | Partial | XMP is read from JPEG, TIFF, PSD, PNG and WebP, but written only into PSD on save (file-info.js stampPsd) and into JPEG by the Image Processor. Save As or Export to JPEG, PNG, TIFF or WebP drops XMP and all EXIF, so a photo loses its camera data and copyright. | M | 0.6 · metadata-io |
| File Info: Basic (title, author, description, rating, keywords, copyright status, notice and URL) | File > File Info: Basic | Done | properties() in file-ops.js with /home/user/claude/pigment/src/renderer/lib/file-info.js; undoable. Author Title and Description Writer fields are absent. |  |  |
| File Info: Camera Data | File > File Info: Camera Data | Done | EXIF from JPEG and TIFF shown read-only (file-info.js readExif/describeExif). |  |  |

## new-doc

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| New Document: Saved presets (save, rename, delete custom document presets) | File > New: Saved tab, Save Preset button | Missing | No way to save a custom document preset; only the built-in list plus Custom. | S | 0.9 · home-new-doc-browser |
| New Document: Recent items and Clipboard preset | File > New: Recent tab | Partial | A Clipboard preset appears when the clipboard holds an image and the last used settings are remembered (settings.newDocPreset). There is no list of recently used sizes. | S | 0.9 · home-new-doc-browser |
| New Document: units (pixels, inches, cm, mm, points, picas; resolution in px/inch or px/cm) | File > New: Width/Height unit menu, Resolution unit menu | Partial | Units are px, in, cm, mm only (UNITS in extras.js). No points, picas or columns; resolution is ppi only (no pixels/cm). | S | 0.9 · home-new-doc-browser |
| New Document: preset categories (Photo, Print, Art & Illustration, Web, Mobile, Film & Video) | File > New: category tabs with blank document presets | Partial | One flat select of 21 sizes (DOC_PRESETS in extras.js: screen, paper, photo, social, web, icon). No category tabs, no mobile device presets, no Film & Video presets (which also need pixel aspect ratio). | S | 0.9 · home-new-doc-browser |
| New Document: name, width, height, orientation swap, resolution | File > New (New Document dialog) | Done | newDocumentDialog in /home/user/claude/pigment/src/renderer/lib/extras.js; limits 30000 px per side, 250 MP; memory summary line. |  |  |
| New Document: Background Contents | File > New: Background Contents (White, Black, Background Color, Transparent, Custom) | Done | All five choices in extras.js, including a custom colour picker. |  |  |

## scripting

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Remote Connections | Edit > Remote Connections | Missing | No remote control service. Photoshop itself has retired this; a local, opt-in automation socket would be the equivalent if wanted. | M | 0.8 · scripting-api |
| Scripts > Browse (run a script) and the scripting engine (ExtendScript, UXP) | File > Scripts > Browse | Missing | No scripting. Running Adobe .jsx or UXP scripts unmodified is not feasible (proprietary object model); the honest substitute is Pigment's own JavaScript scripting API over the command registry (/home/user/claude/pigment/src/renderer/lib/commands.js), with user script files in a sandbox. | XL | 0.8 · scripting-api |
| Scripts > Script Events Manager | File > Scripts > Script Events Manager | Missing | No way to run an action or script on events (Start Application, Open Document, Save Document...). | M | 0.8 · scripting-api |
| Plugins (UXP and legacy extension panels, Generator, filter plug-ins, plugin manager) | Preferences > Plugins; Plugins menu | Missing | No plugin system. Loading Adobe UXP/CEP panels or .8bf filters is not feasible (proprietary host APIs); the honest substitute is a Pigment plugin API on the existing filter, adjustment and format registries. Only 'Show all Filter Gallery groups and names' exists, inside the Filter Gallery dialog. | XL | 0.9 · plugin-api |

## type-engine

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Check Spelling | Edit > Check Spelling | Missing | No spell check for text layers. Electron's built-in Hunspell spellchecker is available offline (spellcheck is already enabled in /home/user/claude/pigment/src/main/main.js for inputs only). | M | 0.7 · type-styles-prefs |
| Find and Replace Text | Edit > Find and Replace Text | Missing | No search across text layers. | S | 0.7 · type-styles-prefs |
| Paste Special > Paste Without Formatting | Edit > Paste Special > Paste Without Formatting (while editing type) | Missing | Text layers hold one style, so pasted text is always plain, but there is no command and it will be needed once rich text exists. | S | 0.4 · type-editing |
| Type preferences (Use Smart Quotes, Enable Missing Glyph Protection, Show Font Names in English, Use ESC key to commit text, glyph alternates, Fill new type layers with placeholder text, recent fonts count, text engine options) | Preferences > Type | Missing | No type preferences. | M | 0.7 · type-styles-prefs |

## clipboard

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Paste dialog for vector artwork (Paste As Smart Object, Pixels, Path, Shape Layer) | Edit > Paste (from Illustrator or SVG data) | Missing | Only bitmap clipboard data is read; SVG or PDF clipboard content is ignored. | M | 0.7 · vector-io |
| Paste Special > Paste Outside | Edit > Paste Special > Paste Outside | Missing | Not in the menu or the registry; it is Paste Into with the inverted selection as the mask. | S | 0.7 · edit-clipboard-finish |
| Copy and paste of whole layers, shapes, paths and styled text between documents | Edit > Copy / Paste with layers selected | Partial | Text, shape, fill and smart layers are copied as rasterised pixels (copyPixels renders them). There is no clipboard for layer structure, vector data or text attributes; Duplicate to another document is the only route. | M | 0.7 · edit-clipboard-finish |
| Cut, Copy, Copy Merged | Edit > Cut / Copy / Copy Merged | Done | /home/user/claude/pigment/src/renderer/lib/edit-ops.js: pixels inside the selection to an internal clipboard and the system clipboard as PNG; works on masks. |  |  |
| Paste (new layer, centred in view or selection; new document from clipboard) | Edit > Paste | Done | edit-ops.js paste; prefers the internal clipboard when it matches the system image. |  |  |
| Paste Special > Paste Into | Edit > Paste Special > Paste Into | Done | edit:paste-into creates the layer with an unlinked mask from the selection. |  |  |
| Paste Special > Paste in Place | Edit > Paste Special > Paste in Place | Done | edit:paste-in-place. |  |  |

## layers

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Layer Comps to Files / Layer Comps to PDF | File > Export > Layer Comps to Files, Layer Comps to PDF | Missing | No layer comps. | M | 0.8 · layer-comps |
| Place Linked, linked smart object management (Update Modified Content, Relink to File, Embed Linked) and Package | File > Place Linked, File > Package | Missing | Smart objects are always embedded; there is no link to an external file, so Package (collect linked files) has nothing to do. | M | 0.7 · linked-smart-objects |
| Place Embedded | File > Place Embedded | Partial | file:place in /home/user/claude/pigment/src/renderer/lib/smart-object.js places the file as a smart object fitted to the canvas (or pixels when the preference is off) and switches to Move. It does not enter a Free Transform session to size and confirm the placement, and PDF/AI cannot be placed; SVG is rasterised rather than kept as a vector smart object. | S | 0.7 · linked-smart-objects |
| Auto-Align Layers | Edit > Auto-Align Layers | Done | align-blend.js: Auto, Perspective, Collage, Cylindrical, Spherical, Reposition, Vignette Removal, Geometric Distortion (estimated from the images, not from lens profiles). |  |  |
| Auto-Blend Layers | Edit > Auto-Blend Layers | Done | align-blend.js: Panorama or Stack Images, Seamless Tones and Colors, Content Aware Fill Transparent Areas. |  |  |

## performance

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Performance: Graphics Processor settings (Use Graphics Processor, advanced modes, 30-bit display), multithreaded compositing | Preferences > Performance: Graphics Processor Settings | Missing | Rendering is Canvas 2D with pixel code in JavaScript; no GPU pipeline or settings. | XL | 0.11 · gpu-pipeline |
| Performance: Cache Levels, Cache Tile Size and the document-type optimisation presets | Preferences > Performance: History & Cache | Missing | No image pyramid or tile cache; the compositor works on full-resolution canvases (/home/user/claude/pigment/src/renderer/lib/compositor.js). | L | 0.10 · tile-store |
| Scratch Disks | Preferences > Scratch Disks | Missing | Everything is held in RAM; no disk-backed storage for pixels or history, so very large documents are limited by memory. | XL | 0.11 · scratch-memory-limits |

## print

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Print One Copy | File > Print One Copy | Missing | No command; print.js already stores printDefaults, so a silent print with them is small. | S | 0.8 · print |
| Print Selected Area | File > Print: Position and Size > Print Selected Area | Missing | Always prints the whole flattened document. | S | 0.8 · print |
| Print: Printing Marks and Functions (crop and registration marks, description, labels, emulsion down, negative, background, border, bleed) | File > Print: Printing Marks, Functions | Missing | None of these exist in the print dialog. | S | 0.8 · print |
| Print: printer, copies, paper, orientation, position and size, scale to fit, preview | File > Print (Photoshop Print Settings) | Done | /home/user/claude/pigment/src/renderer/lib/print.js and /home/user/claude/pigment/src/main/print.js: printer list, copies, paper sizes and custom, margins, fit/100%/custom scale, centre or offsets, live page preview, Save as PDF. |  |  |

## artboards

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Artboards to Files / Artboards to PDF | File > Export > Artboards to Files, Artboards to PDF | Missing | No artboards. | M | 0.9 · artboards-frames |
| New Document: Artboards checkbox | File > New: Artboards | Missing | No artboards exist anywhere in Pigment (README 'What it does not do'). Needs the artboard layer type first. | XL | 0.9 · artboards-frames |

## vector

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Define Custom Shape | Edit > Define Custom Shape | Missing | The Custom Shape tool has a fixed built-in list (/home/user/claude/pigment/src/renderer/lib/tools/vector.js); a path cannot be saved as a new shape. | S | 0.5 · presets-panels |
| Paths to Illustrator | File > Export > Paths to Illustrator | Missing | Paths cannot be exported. An SVG (or simple .ai-compatible PDF) writer for the Paths panel would be the equivalent. | S | 0.7 · vector-io |

## 3d

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| 3D preferences and 3D features | Preferences > 3D | Missing | No 3D (README). Adobe has itself retired Photoshop's 3D features, so this is the lowest-value gap in the area. | XL | 0.11 · 3d-lite |

## brush-engine

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Define Brush Preset | Edit > Define Brush Preset | Missing | Brush tips are parametric only (size, hardness, angle, roundness in /home/user/claude/pigment/src/renderer/lib/brush.js); a selection cannot become a sampled brush tip. Needs image-tip support in the brush engine. | M | 0.5 · brush-engine-core |

## panels

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Import > Notes | File > Import > Notes | Missing | No Note tool or Notes panel, so nothing to import into. | S | 0.9 · notes-count-measurement |

## slices

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Save for Web: slices, Slice Select tool, HTML output settings, Preview in browser | Save for Web: toolbox, Preview button, Output Settings | Missing | No slices in Pigment at all; the dialog has no tools, no HTML output and no browser preview. | L | 0.10 · slices-web-export |

## view

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| New Document: Pixel Aspect Ratio | File > New: Advanced Options > Pixel Aspect Ratio (and View > Pixel Aspect Ratio) | Missing | No pixel aspect ratio field in the document model or the view. | M | 0.11 · render-video |

## ai

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Generative Fill | Edit > Generative Fill (and the Contextual Task Bar) | Approximate | AI > Generative Fill (/home/user/claude/pigment/src/renderer/lib/ai/features.js) sends the selection and a prompt to the user's own OpenAI or Gemini account and adds 1 to 3 result layers. Adobe Firefly itself is not feasible. Missing versus Photoshop: generative layer with variation history in Properties, reference image, the item under the Edit menu and a contextual task bar. | M | 0.10 · generative-features |
| Sky Replacement | Edit > Sky Replacement | Approximate | Only AI > Replace Sky (ai/features.js): a text prompt generates a sky through the user's provider key over a heuristic or selected sky mask. Nothing of Photoshop's dialog: sky preset library and imported sky images, Shift Edge, Fade Edge, sky brightness/temperature/scale/flip, foreground lighting and colour adjustment, output as a layer group with masks. Adobe's sky model and bundled skies are proprietary; an offline version using Select Sky plus a user-supplied sky image and colour harmonisation is buildable. | L | 0.10 · neural-filters-local |
| Image Processing (Select Subject and Remove Background on device or cloud, generative Remove tool, Firefly model choice) | Preferences > Image Processing | Not feasible | These choose between Adobe's device models and Adobe's cloud. Pigment's counterpart is the AI Accounts dialog (/home/user/claude/pigment/src/renderer/lib/ai/accounts.js) for provider and model, with local heuristics for Select Subject and Sky; an open segmentation model the user downloads would be the closest device-side substitute. |  |  |

## cloud

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Invite to Edit / Share for Review | File > Invite, File > Share for Review | Not feasible | Requires Adobe cloud documents and accounts. No substitute beyond exporting a file. |  |  |
| New Document: templates from Adobe Stock | File > New: Templates section | Not feasible | Needs Adobe Stock servers and licensed template files. Honest substitute: a local templates folder of .pigment/.psd files offered in the dialog. |  |  |
| Cloud documents (Save to Creative Cloud, PSDC, offline availability) | File > Save / Save As: Save to cloud documents | Not feasible | Needs Adobe's cloud storage. Local .pigment files are the substitute; a user-chosen synced folder works with any cloud drive. |  |  |
| Search Adobe Stock | File > Search Adobe Stock | Not feasible | Adobe Stock service and licensing. No substitute planned. |  |  |
| Version History | File > Version History | Not feasible | Photoshop's versions live with cloud documents. Substitute: local numbered versions or snapshots stored inside the .pigment container or beside the file. |  |  |
