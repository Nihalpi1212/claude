# Parity: Further features found by the completeness pass

Part of [Pigment and Photoshop: feature parity](../PARITY.md), as of Pigment 0.3.1 (November 2026).

Completeness pass over the seven auditors' lists, verified read-only in /home/user/claude/pigment/src (menu.js, keymap.js, lib/form.js, lib/canvas-view.js, lib/tools/*.js, lib/edit-ops.js, lib/image-ops.js, lib/depth.js, lib/style-ui.js, lib/panels/layers.js and others). The auditors' inventory is thorough at menu level; what they left out is mostly behaviour with no menu item: document scroll bars and edge auto-scroll, dialog conventions (Alt = Reset, Shift+arrow and arithmetic in number fields, last-used-settings shortcuts), on-canvas dragging of layer-style effects, moving an unlinked mask, blend-mode hover preview, pasting into a mask, cloning from another document, the Selection Brush tool, Free Transform Path / Transform Points, Copy/Paste Shape Attributes, the HDR Toning conversion dialog when leaving 32-bit, artboard properties, and the raw-workflow half of Camera Raw (crop, workflow options, filmstrip and sync, Save Image, in-ACR HDR/panorama merge). Hard limits not listed anywhere: documents are capped at 30,000 px per side, zoom at 1%-6400% and brushes at 1,000 px. I also recorded ten behaviours that do exist but were missing from the inventory (selection becomes the mask of a new adjustment layer, adjustments as smart filters, floating-selection transform, mode-change flatten prompts, shared smart-object instances, and so on). Of the 'done' entries I re-checked (over thirty, including Indexed Color, Color Table, Match/Replace Color, Apply Image, Calculations, Canvas Size, Trim, Free Transform, Content-Aware Scale, Auto-Align/Blend, which all hold up), twelve are corrected here: Camera Raw's tone and presence sliders are approximations on 8-bit sRGB, Remove Background needs a cloud provider key, Curves, Levels, Lens Blur, Batch, Rotate View, the Brush size range, wheel zoom, Overscroll and the claim that shortcuts match Photoshop's defaults are partial. One entry (Dynamic Text) rests on my recollection of a 2025 Photoshop release and should be confirmed against Adobe's release notes before it is scheduled.

25 missing · 7 partial · 1 approximate · 1 not feasible · 10 done · 44 entries

## layers

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Blend mode menu: live preview while hovering and arrow-key stepping | Layers panel and options bar blend mode menus: the canvas previews each mode as the pointer moves down the list | Missing | The blend control is a native <select> (lib/panels/layers.js data-blend) that applies on change only; nothing previews on hover. | S | 0.4 · layers-panel-depth |
| Collapse All Groups and expand/collapse nested groups | Layers panel menu > Collapse All Groups; Alt-click a group arrow (expand or collapse it with all nested groups), Ctrl-click (all top-level groups) | Missing | No collapse-all command or modifier handling on the group arrow in lib/panels/layers.js; groups toggle one at a time. | S | 0.4 · layers-panel-depth |
| Select Similar Layers | Move tool / layer context menu > Select Similar Layers (Select > Similar Layers in older releases) | Missing | No command selects all layers of the active layer's kind. The Layers panel Kind filter (lib/layers-extras/find.js) narrows the list but does not select. | S | 0.4 · finish-layer-menu |
| Move tool: drag a marquee to select several layers | Move tool with Auto-Select on: drag from empty canvas over layers to select them all | Missing | lib/tools/move.js onPointerDown either moves the layers it finds or reports 'Nothing to move'; there is no rubber-band layer selection on the canvas. | S | 0.5 · move-tool-depth |
| Paste into a layer mask or channel | Target a mask (Alt-click its thumbnail) or an alpha channel, then Edit > Paste | Missing | lib/edit-ops.js paste() always creates a new layer (or a mask from the selection for Paste Into); it does not look at app.ui.editingMask, so greyscale artwork cannot be pasted into a mask or channel. | S | 0.6 · channels-depth |
| Background layer behaviours | Layers panel: the locked Background (cannot move or hold transparency; Delete and the Eraser paint the background colour; stays at the bottom) | Partial | Present as a convention: the bottom raster layer named 'Background' gets position and transparency locks (lib/layers-extras/structure.js BACKGROUND_LOCKS), Clear fills the background colour when transparency is locked (lib/edit-ops.js clearPixels) and the Eraser paints the background colour (lib/tools/paint.js line 252). I found no code that stops other layers being arranged below it or that disables its blend mode, opacity and mask as Photoshop does; the layer is recognised by its name, so renaming it ends the behaviour. | S | 0.4 · finish-layer-menu |
| Move a layer mask independently of its layer | Layers panel: unlink the mask, target it, drag with the Move tool (and the reverse: move the layer under a fixed mask) | Partial | With the link off, moving the layer leaves the mask in place (lib/layer-move.js shifts the mask only when mask.linked is not false). The other direction is absent: the Move tool (lib/tools/move.js) always moves the layer, even when the mask is the edit target, so a mask cannot be repositioned on its own. | S | 0.5 · move-tool-depth |
| Smart object instances share one source | Duplicate a smart object (Ctrl+J): copies update together; New Smart Object via Copy is independent | Done | lib/smart-object.js: source objects are shared by reference between a layer and its structural copies; layer:smart-via-copy makes a separate source. |  |  |
| Free Transform of the selected pixels only, and of several layers at once | Edit > Free Transform with a selection (floating selection) or with several layers selected | Done | lib/image-ops.js start(): a selection on a raster layer is cut into a floating piece that is transformed and merged back; without a layer the selection outline itself is transformed; several selected layers and linked group masks transform together. |  |  |
| New adjustment or fill layer takes the active selection as its mask | Layer > New Adjustment Layer / New Fill Layer with a selection active | Done | lib/layer-ops.js lines 687 and 705: the new layer's mask is built from the selection (maskFromSelection), otherwise a white mask. |  |  |
| Rasterize prompt when painting on a type, shape or smart layer | Painting or retouch tool on a non-pixel layer: 'This layer must be rasterized before proceeding' | Done | lib/layer-ops.js line 296 asks to rasterize before a paint tool edits a text, shape or smart layer. |  |  |

## camera-raw

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Camera Raw: Crop and Rotate tool | Camera Raw (raw workflow) toolbar: Crop (aspect presets, constrain to image), Straighten, Rotate 90, Flip | Missing | lib/develop-ui.js has four tabs (Basic, Detail, HSL, Effects) and no geometry tools. Photoshop's Camera Raw Filter also lacks crop; this matters once RAW files open through the dialog. | M | 0.7 · camera-raw-local |
| Camera Raw: Photo Merge (HDR, Panorama, HDR Panorama) | Camera Raw filmstrip menu > Merge to HDR, Merge to Panorama, Merge to HDR Panorama (result as DNG) | Missing | Absent with the raw workflow. Pigment's own File > Automate > Merge to HDR and Photomerge (lib/align-blend.js, shared/pixels/hdr.js) could back it, with a .pigment or TIFF result instead of DNG. | M | 0.6 · raw-open-workflow |
| Camera Raw: filmstrip, settings sync across images, ratings and Save Image | Camera Raw with several files: filmstrip, Select All, Sync Settings, Copy/Paste Edit Settings, star ratings and mark for deletion, Save Image (convert to DNG, JPEG, TIFF, PSD with naming) | Missing | One layer at a time, no multi-image session and no conversion output. Image Processor (lib/automate/batch.js) is the nearest batch route but does not apply Camera Raw settings. | L | 0.6 · raw-open-workflow |
| Camera Raw: Workflow Options and output buttons | Camera Raw: workflow link (colour space, bit depth, resize to fit, output sharpening, Open in Photoshop as Smart Objects); Open, Open Object, Open Copy, Done | Missing | Camera Raw exists only as a filter on an 8-bit RGB layer (filter:camera-raw); there is no raw-open path, so no output colour space, depth or size, and no 'Done' that saves settings without opening. | M | 0.6 · raw-open-workflow |

## brush-engine

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Brush Settings: attribute locks and Clear Brush Controls | Brush Settings panel: lock icon beside each section; panel menu > Clear Brush Controls, Reset All Locked Settings, Copy Texture to Other Tools | Missing | The Brush Settings sections themselves are missing (listed by the tools auditor), and nothing keeps a setting fixed while presets change. Belongs with the brush-engine work. | S | 0.5 · brush-settings-panel |
| Erase with the current brush by holding the tilde key | Brush tool: hold ` (~) to paint in Clear mode with the same tip | Missing | No Backquote handling in the renderer; erasing needs the Eraser tool (which has its own size and settings). | S | 0.5 · brush-painting-behaviours |
| Brush tip rotation with the arrow keys | Painting tools: Left/Right arrow rotate the brush tip by 1 degree, Shift by 15 degrees | Missing | Angle is set in the Brushes panel only; arrow keys are not handled by the paint tools (lib/tools/paint.js, lib/shortcuts.js). | S | 0.5 · brush-painting-behaviours |

## vector

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Free Transform Path, Transform Path submenu and Transform Points | Edit > Free Transform Path / Edit > Transform Path > Scale, Rotate, Skew, Distort, Perspective, Warp (with a path or anchor points selected); Edit > Free Transform Points | Missing | Free Transform (lib/image-ops.js start()) collects layers or the selection only; with just a work path or saved path active it answers 'Select a layer to transform'. Shape layers do transform as vectors through the layer route (their path is mapped through the matrix), but a work path, a saved path, one path component or a set of selected anchor points cannot be transformed, and there is no Warp for paths. | M | 0.7 · pen-paths |
| Copy / Paste Shape Attributes | Layers panel context menu on a shape layer > Copy Shape Attributes, Paste Shape Attributes (also Copy Fill, Copy Complete Stroke) | Missing | No command copies a shape layer's fill and stroke to another shape layer; only Copy/Paste Layer Style exists (layer:copy-style, layer:paste-style). | S | 0.4 · shapes-live |
| Shape tools: click the canvas for the Create dialog; Rounded Rectangle radius | Shape tools: single click opens Create Rectangle / Ellipse / Polygon (Width, Height, Radii, Sides, From Center) | Partial | Present: lib/tools/vector.js sizeDialog() asks Width, Height, Radius (rounded rectangle), Sides (polygon) and From centre, and the rounded rectangle has a Radius option. One radius for all corners; per-corner radii and the star ratio are not in the dialog. | S | 0.4 · shapes-live |

## view

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Auto-scroll while dragging past the window edge | Any drag tool (marquee, lasso, move, crop, pen, shapes): the view scrolls when the pointer leaves the document window | Missing | No edge auto-scroll code exists (no autoScroll/edgeScroll in the renderer); a drag that leaves the canvas does not move the view, so selecting or drawing beyond the visible area needs a zoom out first. | S | 0.6 · view-navigation |
| Document window scroll bars | Document window: horizontal and vertical scroll bars | Missing | The canvas view (lib/canvas-view.js) pans by wheel, Space-drag, Hand tool and Navigator only; there is no scroll bar element anywhere in the renderer. A user cannot see how far the view is from the document edges or drag a thumb. | S | 0.6 · view-navigation |
| Zoom range | View zoom limits (about 0.2% to 12800%) | Partial | lib/canvas-view.js: MIN_ZOOM 0.01 and MAX_ZOOM 64, that is 1% to 6400%. Photoshop goes to 12800% and below 1% for very large documents. | S | 0.6 · view-navigation |

## select

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Selection Brush tool | Toolbar: Lasso group > Selection Brush tool (paint a selection with a brush; Add/Subtract, Size, Hardness, Opacity, overlay colour) | Missing | No such tool: lib/tools/select.js registers marquee, lasso and wand kinds only, and no source file mentions a selection brush. The closest path today is Quick Mask (Q) plus the Brush tool, which gives the same result in two steps and without the tool's own overlay options. | M | 0.6 · selection-tools-depth |
| Luminosity and channel selection shortcuts | Ctrl+Alt+2 (load composite luminosity as a selection), Ctrl+Alt+3/4/5 (load a colour channel) | Partial | Ctrl-clicking the composite row in the Channels panel loads its luminosity (lib/panels/channels.js), with Shift/Alt to add or subtract. The keyboard forms are not in shared/keymap.js. | S | 0.6 · channels-depth |

## workspace

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Numeric fields: Shift+arrow steps of 10, arithmetic and unit entry everywhere | All numeric fields in dialogs, options bar and panels (arrow keys, Shift+arrow, mouse wheel over a field, expressions such as 100+50 or 50%, typed units) | Missing | Fields are plain <input type=number> built by lib/form.js and the options bar: arrow keys step by the field's step only, Shift is ignored, expressions are rejected by the browser and units cannot be typed (Image Size and Canvas Size have their own unit menus). The auditors list this for the Character panel only; it applies to every field. | M | 0.4 · conventions-shortcuts-fields |
| Dialog conventions: Alt turns Cancel into Reset | Every adjustment, filter and settings dialog: hold Alt/Option to change Cancel into Reset | Partial | lib/form.js supports an optional Reset button (opts.resetButton) but no dialog asks for it, and no dialog reacts to Alt. Reset exists only in a few custom sessions (Camera Raw, Select and Mask, the Properties panel for adjustment layers). In all other dialogs the only way back to the starting values is Cancel and reopen. | S | 0.4 · conventions-shortcuts-fields |
| Cycle open documents from the keyboard | Ctrl+Tab / Ctrl+Shift+Tab | Done | view:next-tab and view:prev-tab in shared/keymap.js and the View menu. |  |  |
| Operating-system recent documents | Dock menu / taskbar jump list of recent files | Done | main/ipc.js line 191 calls app.addRecentDocument for every file opened or saved. |  |  |
| Reveal the document in the file manager | Document tab context menu > Reveal in Explorer / Finder | Done | File > Show in Explorer / Reveal in Finder (file:reveal in main/menu.js), enabled when the document has a path. |  |  |

## adjustments

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Adjustment dialogs opened with last-used settings | Alt+Ctrl+L (Levels), Alt+Ctrl+M (Curves), Alt+Ctrl+U (Hue/Saturation), Alt+Ctrl+B (Color Balance): reopen with the previous values | Missing | shared/keymap.js binds only the plain Ctrl+L/M/U/B forms and lib/adjust-ui.js keeps no last-used parameters per kind (dialogs always start from the kind's defaults). Fit Image and Filter Gallery remember their values; the adjustments do not. | S | 0.4 · adjust-tonal |
| Adjustments on a smart object become smart filters | Image > Adjustments on a smart object (Photoshop: Shadows/Highlights and a few others) | Done | lib/adjust-ui.js line 761: an adjustment on a smart layer is intercepted by app.smartFilters and stored as a smart filter ('adjust:kind'), editable later. Pigment allows every adjustment kind here, which is more than Photoshop. |  |  |

## artboards

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Artboard properties and behaviours | Properties panel for an artboard (W, H, X, Y, device preset, background colour); canvas with several artboards, auto-nesting of layers, clipping to the artboard, Alt-drag to duplicate an artboard, artboard names on the canvas | Missing | Artboards do not exist in the document model (README 'What it does not do'). The auditors list the Artboard tool, menu commands, export and PSD data but not the per-artboard properties and the nesting and clipping rules that make artboards work. | L | 0.9 · artboards-frames |

## formats

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Photoshop template files (.psdt) | File > Open / Save As: Photoshop template (opens as an untitled copy) | Missing | lib/io.js OPEN_EXTENSIONS has psd and psb but not psdt, so the file is not offered or recognised although it is an ordinary PSD inside. Opening it through the PSD reader as an untitled document is a small change. | S | 0.6 · psd-document |

## image-modes

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| 32-bit to 16/8-bit conversion through HDR Toning | Image > Mode > 8 or 16 Bits/Channel from a 32-bit document: HDR Toning dialog (Local Adaptation, Equalize Histogram, Exposure and Gamma, Highlight Compression), preceded by the Merge / Don't Merge prompt | Missing | lib/depth.js depthCommand converts directly and then shows the toast 'Highlights brighter than white were clipped'. The HDR Toning engine exists (shared/pixels/hdr.js, Image > Adjustments > HDR Toning) but is not offered at conversion time, so highlights above white are lost unless the user tones first. | S | 0.10 · hdr-32bit |
| Mode change prompts (flatten, rasterize) | Image > Mode > ... with layers: Flatten / Don't Flatten / Cancel, and the notice for modes that hold one layer | Done | lib/modes.js: flattening is 'required' for Bitmap, Indexed and similar modes (confirm dialog) and offered as a choice otherwise (flattenChoice in lib/modes/dialogs.js). |  |  |

## layer-styles

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Layer Style: drag in the document to position an effect | Layer Style dialog open on Drop Shadow, Inner Shadow, Satin, Gradient Overlay or Pattern Overlay: drag on the canvas to set distance/angle or the overlay's position | Missing | lib/style-ui.js has no pointer handling on the canvas; distance, angle and overlay offsets are set by sliders only. | S | 0.4 · layer-style-effects |

## performance

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Maximum document size | File > New / Image Size / Canvas Size limits (30,000 px for PSD, 300,000 x 300,000 px for PSB) | Partial | lib/extras.js MAX_SIDE = 30000, and Image Size / Canvas Size refuse more than 30,000 px per side (lib/image-ops.js lines 478 and 599). Every layer is one HTML canvas, so the practical ceiling is lower still (Chromium's canvas area limit and memory). Reaching Photoshop's PSB sizes needs the tiled document model the auditors list under 'Big documents'. | XL | 0.10 · tile-store |

## retouch

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Clone Stamp and Healing Brush: sample from another open document | Clone Stamp / Healing Brush: Alt-click in one document, paint in another (also the five sources of the Clone Source panel) | Missing | lib/tools/retouch.js stores the source as a point { x, y } of the current document only; switching documents does not carry it over. | S | 0.7 · retouch-tools-depth |
| Delete and Fill Selection | Shift+Backspace / Shift+Delete with a selection, and the selection context menu > Delete and Fill Selection (one-step content-aware removal) | Approximate | Edit > Content-Aware Fill (lib/content-aware.js, edit:content-aware-fill) fills the selection directly with Pigment's own inpainting (shared/pixels/inpaint.js), which is the same one-step gesture. It has no keyboard shortcut in shared/keymap.js and no canvas context menu, and the synthesis differs from Adobe's, most visibly on large or structured areas. | S | 0.7 · content-aware-fill-workspace |

## type-engine

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Dynamic Text | Type layer / Properties panel > Dynamic Text (recent releases): text resizes automatically to fill its box | Missing | lib/tools/text.js lays text out at one fixed size per layer; nothing fits the size to the box. Listed from my recollection of Photoshop's 2025 releases; confirm against Adobe's release notes before scheduling. | M | 0.8 · type-on-path-area |

## filters

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Filters and adjustments on a layer mask and through a feathered selection | Any filter or adjustment with a mask targeted or a selection active | Done | lib/adjust-ui.js beginPixelEdit() works on app.pixelTarget (the mask canvas while editing a mask, lib/edit-ops.js line 28) and blends the result through the selection's alpha, reading a margin around it for neighbourhood filters. |  |  |

## presets

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Adobe's bundled preset libraries (gradients, patterns, shapes, styles, swatches, contours, skies, tool presets) | Default and Legacy groups in the Gradients, Patterns, Shapes, Styles and Swatches panels; contour picker; Sky Replacement sky folders | Not feasible | Adobe's preset content is licensed with Photoshop and cannot be shipped. Pigment carries its own small sets (gradient presets in lib/tools/fill.js, patterns in lib/patterns.js, swatches, custom shapes). The honest substitute is Pigment-made libraries under the same group structure plus import of the user's own .grd, .pat, .csh, .asl, .aco/.ase files and sky images, which the auditors list as missing. |  |  |
