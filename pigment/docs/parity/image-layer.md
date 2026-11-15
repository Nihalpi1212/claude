# Parity: Image and Layer menus; Layers, Channels, Histogram, Adjustments and Properties panels

Part of [Pigment and Photoshop: feature parity](../PARITY.md), as of Pigment 0.4 (November 2026). The rows planned for 0.4 ("0.4 · *package*") show their 0.4 status and the counts below include them; the other rows and the overview paragraph describe Pigment 0.3.1 as the audit found it.

Verified in the working tree of /home/user/claude/pigment (paths below are relative to src/). The Image and Layer menus are broad but shallow in places: every menu command that exists is registered and none in this area is a stub, and Image > Mode dialogs, Canvas Size, Rotation, Trim, Apply Image, Calculations, Match/Replace Color, layer masks, smart objects (embedded), matting and all 27 blend modes are genuinely done. The biggest gaps are (1) Layer Style depth: Blending Options has only mode/opacity/fill (no Advanced Blending channels, Knockout, the five check boxes or Blend If), no contours, noise, bevel Contour/Texture, gradient/pattern stroke, multiple effect instances, Create Layers / Hide All Effects / Scale Effects, and no styles on groups; (2) adjustment dialogs: no eyedroppers, on-image tools, preset save/load, Auto options, Curves pencil, Hue/Saturation handles one colour range per adjustment with fixed ranges, Shadows/Highlights lacks Show More Options, Gradient Map/Gradient Fill/Gradient Overlay edit two colours only; (3) whole subsystems absent: Histogram panel, vector masks, artboards, frames, linked smart objects, smart-filter masks, Variables/Data Sets, Analysis (measurement scale, log, Count tool), video layers, slices, Copy CSS/SVG. The Channels panel cannot show or edit a single channel, paint on an alpha channel, create spot channels, or Split/Merge Channels; the Properties panel has no mask Density/Feather and shows a hard-coded "RGB colour, 8 bits/channel" for every document; the Layers panel lacks effect rows, a panel menu/options and several click modifiers, and Layer > New > Layer… and Merge Layers (layer:merge-selected is registered but unreachable) are not wired as in Photoshop. CMYK/Lab/Multichannel and 16/32-bit are honest approximations (RGB storage, 8-bit paint/filter path); Preserve Details 2.0, Mask All Objects, Adobe's Color Lookup tables, Pantone books and Library relinking cannot be reproduced faithfully and need open-source or user-supplied substitutes.

31 missing · 17 partial · 8 approximate · 4 not feasible · 143 done · 203 entries

## adjustments

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Curves: display options and Show Clipping | Curves dialog: Show Amount of Light/Pigment, 4x4 / 10x10 grid, Channel Overlays, Histogram, Baseline, Intersection Line, Show Clipping | Done | 0.4: Curve Display Options (light / pigment, 4x4 / 10x10 grid, channel overlays, histogram, baseline, intersection line) and Show Clipping in the dialog; the Properties panel's editor does not show clipping | S | 0.4 · adjust-tonal |
| Curves: eyedroppers and on-image adjustment tool | Curves dialog: black/grey/white eyedroppers, hand tool (click-drag in image), Ctrl-click to place a point | Done | 0.4: black, grey and white point eyedroppers, the on-image tool and Ctrl-click to place a point | M | 0.4 · adjust-tonal |
| Curves: pencil (draw) mode and Smooth | Curves dialog: pencil tool, Smooth button | Done | 0.4: pencil (drawn) curves and Smooth; PSD gets a drawn channel as points sampled from it | M | 0.4 · adjust-tonal |
| Hue/Saturation: range sliders and range eyedroppers | Hue/Saturation dialog: colour bars with draggable range/fall-off, eyedropper, add, subtract | Done | 0.4: colour bars with movable range bounds and fall-off, range eyedroppers (add, subtract); a range stays under 360 degrees and its bounds stay in order, where Photoshop lets them overlap the next range | M | 0.4 · adjust-color |
| Hue/Saturation: on-image tool and presets | Hue/Saturation dialog: hand tool (drag in image for saturation, Ctrl-drag hue), Preset menu | Done | 0.4: the on-image tool (drag for saturation, Ctrl-drag for hue) and presets with .ahu files | M | 0.4 · adjust-color |
| Newer adjustments: Color and Vibrance, Clarity and Dehaze, Grain | Image > Adjustments and Layer > New Adjustment Layer in recent releases | Approximate | 0.4: all three as adjustments and adjustment layers; Clarity and Dehaze use a fixed neighbourhood (about 24 px) and Dehaze assumes white haze. PSD has no adjustment for them: they are saved as hidden empty layers, with a notice | M | 0.4 · adjust-color |
| Levels: clipping preview while dragging | Levels dialog: Alt-drag input sliders | Done | 0.4: Alt-drag on the input sliders shows the clipping in the dialog (not in the Properties panel's editor) | S | 0.4 · adjust-tonal |
| Levels: black/grey/white point eyedroppers | Levels dialog: three eyedroppers (and double-click to set target colours) | Done | 0.4: the three eyedroppers, with target colours | M | 0.4 · adjust-tonal |
| Auto Color Correction Options | Levels/Curves > Options: algorithms (Monochromatic, Per Channel, Dark & Light Colors, Brightness and Contrast), Snap Neutral Midtones, target colours, clip %, Save as defaults | Done | 0.4: the four algorithms, Snap Neutral Midtones, target colours, clip percentages and Save as defaults, used by the Auto buttons and Image › Auto Tone / Contrast / Color | M | 0.4 · adjust-tonal |
| Curves: presets and Auto | Curves dialog: Preset menu, save/load .acv, Auto | Done | 0.4: preset menu with Photoshop's names, save and load .acv, Auto with its options; built-in values approximate Photoshop's | S | 0.4 · adjust-tonal |
| Black & White | Image > Adjustments > Black & White | Done | 0.4: Auto, the on-image tool, presets and .blw files; Auto and the built-ins approximate Photoshop's values | S | 0.4 · adjust-color |
| Brightness/Contrast | Image > Adjustments > Brightness/Contrast | Done | 0.4: Auto, Use Legacy and presets | S | 0.4 · adjust-tonal |
| Channel Mixer | Image > Adjustments > Channel Mixer | Done | 0.4: the Total with its warning, presets and .cha files; the built-ins approximate Photoshop's | S | 0.4 · adjust-color |
| Curves: point editing and channels | Image > Adjustments > Curves | Done | 0.4: point editing, channels in Gray, CMYK and Lab documents as well as RGB; CMYK and Lab follow Pigment's simple conversions, and 16/32-bit documents apply them at 8 bits | S | 0.4 · adjust-tonal |
| Equalize | Image > Adjustments > Equalize | Done | 0.4: asks about the selection (selected area only, or the entire image based on it); actions replay the choice | S | 0.4 · adjust-tonal |
| Exposure | Image > Adjustments > Exposure | Done | 0.4: eyedroppers and presets | S | 0.4 · adjust-tonal |
| Gradient Map | Image > Adjustments > Gradient Map | Done | 0.4: the full gradient (Gradient Editor, presets, method, midpoints, opacity stops, smoothness), Reverse and Dither; PSD keeps all of it, the method included (Stripes is saved as Classic) | M | 0.4 · adjust-color |
| HDR Toning | Image > Adjustments > HDR Toning | Done | 0.4: presets and Save Preset; .hdt files are not read | S | 0.4 · adjust-color |
| Hue/Saturation: Master and colour ranges | Image > Adjustments > Hue/Saturation: edit menu (Master, Reds ... Magentas) | Done | 0.4: Master plus up to six colour ranges at once; PSD keeps the ranges and their bounds (Colorize is not written, with a notice) | M | 0.4 · adjust-color |
| Levels: channel menu, input and output sliders, histogram | Image > Adjustments > Levels | Done | 0.4: input and output sliders with triangles, channels in Gray, CMYK and Lab documents; CMYK and Lab follow Pigment's simple conversions | S | 0.4 · adjust-tonal |
| Photo Filter | Image > Adjustments > Photo Filter | Done | 0.4: Photoshop's Filter menu (warming, cooling, colour filters) and Custom color | S | 0.4 · adjust-color |
| Shadows/Highlights with Show More Options | Image > Adjustments > Shadows/Highlights | Done | 0.4: Show More Options (Tone, Radius, Color, Midtone, Black and White Clip), starting from Photoshop's settings; .shh files are not read | M | 0.4 · adjust-color |
| Threshold | Image > Adjustments > Threshold | Done | 0.4: histogram and slider, presets | S | 0.4 · adjust-tonal |
| Levels: Auto and Auto Options | Levels dialog: Auto, Options… | Done | 0.4: Auto in the tool row with Auto Color Correction Options | S | 0.4 · adjust-tonal |
| Color Lookup | Image > Adjustments > Color Lookup | Approximate | adjust-more-ui.js colorLookupEditor: loads .cube/.3dl/.look/.csp, Dither; presets use Adobe's names but are generated by Pigment and do not match Adobe's tables (those are licensed; the honest route is user-loaded LUT files, which works). Abstract and Device Link (ICC) profile types missing | M | 0.6 · color-settings |
| Auto Color | Image > Auto Color | Approximate | adjust.js autoColor: per-channel stretch then per-channel gamma towards the common mean; Photoshop finds dark/light colours and snaps neutral midtones. Results are similar, not identical | S |  |
| Hue/Saturation: Colorize | Hue/Saturation dialog: Colorize | Done | colorize with its own hue/saturation/lightness |  |  |
| Color Balance | Image > Adjustments > Color Balance | Done | Shadows/Midtones/Highlights, three sliders, Preserve Luminosity |  |  |
| Desaturate | Image > Adjustments > Desaturate | Done | adjust.js desaturate (Ctrl+Shift+U) |  |  |
| Invert | Image > Adjustments > Invert | Done | adjust.js invert (Ctrl+I) |  |  |
| Match Color | Image > Adjustments > Match Color | Done | adjust-more-ui.js matchColorEditor: Luminance, Color Intensity, Fade, Neutralize, source document and layer, use selection in source/target, save/load statistics (JSON, not Adobe .sta) |  |  |
| Posterize | Image > Adjustments > Posterize | Done | levels 2..255 |  |  |
| Replace Color | Image > Adjustments > Replace Color | Done | adjust-more-ui.js replaceColorEditor: eyedropper/add/subtract, Fuzziness, Localized Color Clusters + Range, Selection/Image preview, Hue/Saturation/Lightness, result swatch |  |  |
| Selective Color | Image > Adjustments > Selective Color | Done | Nine ranges, CMYK sliders, Relative/Absolute |  |  |
| Vibrance | Image > Adjustments > Vibrance | Done | adjust-ui.js / shared/pixels/adjust.js vibrance + saturation |  |  |
| Auto Contrast | Image > Auto Contrast | Done | adjust.js autoContrast (luma stretch) |  |  |
| Auto Tone | Image > Auto Tone | Done | adjust.js autoLevels (per-channel clip 0.1%) |  |  |
| New Adjustment Layer (all 16 classic kinds) | Layer > New Adjustment Layer | Done | layer-ops.js 'layer:new-adjustment' for Brightness/Contrast ... Selective Color incl. Color Lookup; mask from selection; opens Properties. No New Layer dialog; dialog-level gaps listed per adjustment |  |  |

## layer-styles

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Advanced Blending check boxes | Blend Interior Effects as Group, Blend Clipped Layers as Group, Transparency Shapes Layer, Layer Mask Hides Effects, Vector Mask Hides Effects | Done | 0.4: Blend Interior Effects as Group, Blend Clipped Layers as Group, Transparency Shapes Layer, Layer Mask Hides Effects, Vector Mask Hides Effects. Not written to PSD (saving says so) | M | 0.4 · layer-style-blending |
| Advanced Blending: Channels R/G/B | Blending Options > Advanced Blending > Channels | Done | 0.4: on pixel and adjustment layers (a switched-off channel is left as it was). Not written to PSD (saving says so) | M | 0.4 · layer-style-blending |
| Advanced Blending: Knockout (None/Shallow/Deep) | Blending Options > Advanced Blending > Knockout | Done | 0.4: Shallow and Deep, cutting through after the exterior effects are drawn. Not written to PSD (saving says so) | M | 0.4 · layer-style-blending |
| Blend If with split sliders | Blending Options > Blend If (Gray/R/G/B; This Layer, Underlying Layer; Alt-split) | Done | 0.4: Gray, R, G, B, This Layer and Underlying Layer with Alt-split sliders, on pixel and adjustment layers (This Layer reads an adjustment's result); written to and read from PSD | M | 0.4 · layer-style-blending |
| Contour editor and contour presets | Contour picker in shadows, glows, bevel, satin; Contour Editor dialog | Done | 0.4: Contour Editor and twelve built-in contours, saved contour presets; .shc files are not read or written (0.5) | M | 0.4 · layer-style-effects |
| Create Layers (effects to layers) | Layer > Layer Style > Create Layer(s) | Done | 0.4: each effect becomes a layer in its own blend mode, so the picture stays the same; it warns, as Photoshop does, where layers cannot match (knockout, layer opacity below 100 % with exterior effects, Fill below 100 % with interior effects). Dissolve effects speckle differently once they are layers | M | 0.4 · layer-style-blending |
| Hide All Effects / Show All Effects | Layer > Layer Style > Hide All Effects | Done | 0.4: Layer › Layer Style › Hide All Effects / Show All Effects | S | 0.4 · layer-style-blending |
| Scale Effects | Layer > Layer Style > Scale Effects | Done | 0.4: 1 to 1000 % with a live preview | S | 0.4 · layer-style-blending |
| Bevel & Emboss: Contour sub-effect | Layer Style > Bevel & Emboss > Contour (contour, range) | Done | 0.4: Contour with Anti-aliased and Range | M | 0.4 · layer-style-effects |
| Bevel & Emboss: Texture sub-effect | Layer Style > Bevel & Emboss > Texture (pattern, scale, depth, invert, link with layer) | Done | 0.4: Pattern, Snap to Origin, Scale, Depth, Invert, Link with Layer, and dragging the texture in the document | M | 0.4 · layer-style-effects |
| Multiple instances of an effect | Layer Style dialog: + buttons on Stroke, Inner Shadow, Color Overlay, Gradient Overlay, Drop Shadow; reorder, delete | Done | 0.4: up to ten instances of Drop Shadow, Inner Shadow, Color Overlay, Gradient Overlay and Stroke, with + buttons, reorder and delete | M | 0.4 · layer-style-effects |
| Layer styles on groups | Layer Style on a group layer | Done | 0.4: effects and Blending Options on groups; a Pass Through group with effects is isolated, as in Photoshop | M | 0.4 · layer-style-blending |
| Bevel & Emboss: Structure and Shading | Layer Style > Bevel & Emboss | Done | 0.4: Smooth, Chisel Hard and Chisel Soft, Gloss Contour, every Structure and Shading field; outer bevel and emboss parts blend with the layers below in their own modes | M | 0.4 · layer-style-effects |
| Drop Shadow | Layer Style > Drop Shadow | Done | 0.4: Contour, Noise, Layer Knocks Out Drop Shadow; blends with the layers below in its own mode. Dragging a shadow that uses Global Light sets its own angle instead of moving the Global Light | M | 0.4 · layer-style-effects |
| Gradient Overlay | Layer Style > Gradient Overlay | Done | 0.4: gradient picker and editor, Style, Angle, Scale, Method, Reverse, Dither, Align with Layer, Reset Alignment, drag in the document | M | 0.4 · layer-style-effects |
| Inner Glow | Layer Style > Inner Glow | Done | 0.4: colour or gradient fill, Noise, Softer / Precise, Contour, Range, Jitter | M | 0.4 · layer-style-effects |
| Inner Shadow | Layer Style > Inner Shadow | Done | 0.4: Contour, Anti-aliased, Noise, several instances | S | 0.4 · layer-style-effects |
| Outer Glow | Layer Style > Outer Glow | Done | 0.4: colour or gradient fill, Noise, Softer / Precise, Contour, Range, Jitter; blends with the layers below in its own mode | M | 0.4 · layer-style-effects |
| Pattern Overlay | Layer Style > Pattern Overlay | Done | 0.4: pattern picker, Snap to Origin, Angle, Scale, Link with Layer, drag in the document | M | 0.4 · layer-style-effects |
| Satin | Layer Style > Satin | Done | 0.4: Contour, Anti-aliased, drag in the document | S | 0.4 · layer-style-effects |
| Stroke effect | Layer Style > Stroke | Partial | 0.4: Color, Gradient (with Shape Burst) and Pattern fills, several instances, the outer part blending with the layers below in its own mode; no Overprint option | M | 0.4 · layer-style-effects |
| Copy / Paste / Clear Layer Style | Layer > Layer Style | Done | layer-ops.js copy-style, paste-style (to all selected layers), clear-style |  |  |
| Blending Options: General Blending and Fill Opacity | Layer > Layer Style > Blending Options | Done | style-ui.js blending pane: Blend Mode, Opacity, Fill Opacity |  |  |
| Global Light | Layer > Layer Style > Global Light | Done | style-ui.js globalLightDialog (angle, altitude, live, undoable) |  |  |
| Rasterize Layer Style | Layer > Rasterize > Layer Style | Done | layer-ops.js 'layer:rasterize-style' |  |  |
| Color Overlay | Layer Style > Color Overlay | Done | mode, colour, opacity |  |  |

## panels

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Histogram: statistics | Histogram panel: Mean, Std Dev, Median, Pixels, Level, Count, Percentile, Cache Level | Missing | Absent | S | 0.7 · info-histogram-properties |
| Histogram: channel menu | Histogram panel: RGB, Red, Green, Blue, Luminosity, Colors; Show Channels in Color | Missing | Absent | S | 0.7 · info-histogram-properties |
| Histogram: source and cache refresh | Histogram panel: Source (Entire Image, Selected Layer, Adjustment Composite), uncached refresh | Missing | Absent | S | 0.7 · info-histogram-properties |
| Panel menu and Panel Options | Layers panel flyout menu; Panel Options (thumbnail size, Layer Bounds / Entire Document, Expand New Effects, Add 'copy' to Copied Layers) | Done | 0.4: panel menu and Panel Options (thumbnail size, Layer Bounds / Entire Document, show and expand effects, "copy" names); no Use Default Masks on Fill Layers | M | 0.4 · layers-panel-depth |
| Alt-click between layers to clip | Layers panel: Alt-click the line between two layers | Done | 0.4: Alt-click the line between two layers to make or release a clipping mask | S | 0.4 · layers-panel-depth |
| Effects listed under the layer | Layers panel: Effects rows with per-effect eye, collapse arrow, drag / Alt-drag fx to another layer | Done | 0.4: effect rows with their own eyes and a collapse arrow; drag or Alt-drag effects to another layer; double-click opens that instance | M | 0.4 · layers-panel-depth |
| Properties: smart object | Properties panel for a smart object: Edit Contents, Convert to Linked / Layers, embedded/linked info, layer comp | Missing | Only the generic Transform section; smart commands are in the menu and context menu | S | 0.7 · linked-smart-objects |
| Histogram panel (Compact, Expanded, All Channels views) | Window > Histogram | Missing | No panel (main/menu.js PANELS has none); histogram() in shared/pixels/adjust.js feeds only the Levels/Curves editors and Camera Raw | M | 0.7 · info-histogram-properties |
| Layer navigation shortcuts | Alt+[ / Alt+] select next/previous layer, Alt+, / Alt+. bottom/top | Done | 0.4: Alt+[ / Alt+], Alt+, / Alt+., and Shift+Alt+[ / ] to add to the selection | S | 0.4 · finish-layer-menu |
| Lock buttons | Layers panel: Lock transparent pixels, image pixels, position, artboard auto-nest, all | Done | 0.4: transparency, pixels, position and all, for every selected layer; Lock All also locks opacity, Fill, mode and effects. No artboards, so no artboard auto-nest | S | 0.4 · layers-panel-depth |
| Opacity and Fill | Layers panel: Opacity, Fill | Done | 0.4: scrubby fields for every selected layer, one History step per committed change; Fill also on adjustment layers | S | 0.4 · layers-panel-depth |
| Visibility column gestures | Layers panel: click eye, Alt-click to solo, drag down the eye column | Partial | 0.4: click, Alt-click to solo, drag down the eye column as one step; the eye column has no Show/Hide menu items | S | 0.4 · layers-panel-depth |
| Drag behaviours | Layers panel: drag to reorder, into/out of groups, Alt-drag to duplicate, drag to another document | Done | 0.4: drag several rows at once, Alt-drag to copy, into and out of groups, onto New Layer or Delete, effects between layers; Duplicate Layer copies into another document | M | 0.4 · layers-panel-depth |
| Filter bar | Layers panel: filter by Kind, Name, Effect, Mode, Attribute, Color, Smart Object, Selected, Artboard; on/off switch | Partial | 0.4: Kind, Name, Effect, Mode, Attribute (with Not locked, Vector mask, Advanced blending), Color and Selected; no Smart Object or Artboard filter | S | 0.4 · layers-panel-depth |
| Footer buttons | Layers panel: link, fx, mask, adjustment, group, new, delete and their modifiers | Done | 0.4: Photoshop's modifiers on New Layer, New Group and Add Mask (a vector mask on a layer that has a layer mask), drops on New Layer and Delete | S | 0.4 · layers-panel-depth |
| Properties: mask controls | Properties panel > Masks: Density, Feather, Select and Mask, Color Range, Invert, load, apply, enable, delete | Done | 0.4: Density, Feather, Select and Mask, Color Range, Invert and the mask actions; Color Range makes two History steps | M | 0.4 · masks-vector-masks |
| Properties: pixel layer transform, align and quick actions | Properties panel for a pixel layer: Transform (W, H, X, Y, angle, flip), Align and Distribute, Quick Actions (Remove Background, Select Subject) | Partial | transformSection: X/Y editable, W/H read-only, six align buttons. No W/H scaling, angle, flip, distribute, Remove Background / Select Subject buttons | S | 0.7 · info-histogram-properties |
| Properties: adjustment layer controls | Properties panel for an adjustment layer | Done | 0.4: editor, preset menu, eyedroppers, on-image tool, Auto and View Previous State; no clipping display for Levels and Curves there | M | 0.4 · adjust-color |
| Properties: document | Properties panel with no layer selected: Canvas (W/H, orientation, resolution, mode, fill), Rulers & Grids, Guides, Quick Actions (Image Size, Crop, Trim, Rotate) | Partial | documentSection: read-only W/H/resolution, Image Size… and Canvas Size… buttons. The Mode row is hard-coded to 'RGB colour, 8 bits/channel' (wrong for other modes and depths: a bug). No editable fields, rulers/grid, guides, Crop/Trim/Rotate | S | 0.7 · info-histogram-properties |
| Layer and mask thumbnails, type badges | Layers panel rows | Done | panels/layers.js thumb (document-bounds thumbnails), mask thumbnail with link icon, badges for fx, lock, type, smart object |  |  |
| Thumbnail click modifiers | Layers panel: Ctrl-click thumbnail loads selection (+Shift add, +Alt subtract, +Shift+Alt intersect); Shift-click mask disables; Alt-click mask views | Done | panels/layers.js: all of these for layer and mask thumbnails |  |  |
| Blend mode menu (27 modes + Pass Through) | Layers panel: blend mode menu | Done | document.js BLEND_MODES incl. Dissolve, Darker/Lighter Color, Linear Burn/Dodge, Vivid/Linear/Pin Light, Hard Mix, Subtract, Divide; blend.js per-pixel fallback; Pass Through for groups. No hover preview, no Shift+Plus/Minus cycling |  |  |
| Multi-select layers | Layers panel: click, Shift-click range, Ctrl-click toggle | Done | panels/layers.js row click handler |  |  |
| Row double-click and context menu | Layers panel: double-click name/thumbnail/empty area; right-click menu | Done | Rename, edit text, edit smart object, adjustment/fill options, Layer Style; context menu with properties, duplicate, delete, group, clip, mask, smart object, style, merge items |  |  |
| Clipping group display | Layers panel: indented clipped layers with arrow, underlined base | Done | panels/layers.js row: indent and arrow mark |  |  |
| Layer colour labels | Layers panel: right-click the eye > colour | Done | layers-extras/tags.js 'layer:color' (eye context menu, row tint, filter by colour); saved in .pigment only |  |  |
| Properties: fill layer | Properties panel for a fill layer | Done | fillSection: colour chip / gradient bar / pattern swatch, Edit Fill… (limits of the editors listed under New Fill Layer) |  |  |
| Adjustments panel: single adjustments | Window > Adjustments > Single adjustments | Done | panels/adjustments.js: one button per adjustment-layer kind plus the three fill layers |  |  |

## layers

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Copy CSS | Layer > Copy CSS | Missing | Absent | M | 0.10 · slices-web-export |
| Arrange | Layer > Arrange > Bring to Front, Bring Forward, Send Backward, Send to Back, Reverse | Done | 0.4: on every selected layer, with Reverse; the Background stays at the bottom | S | 0.4 · finish-layer-menu |
| Distribute | Layer > Distribute (Top/Vertical Centers/Bottom/Left/Horizontal Centers/Right Edges, Distribute Spacing Horizontally/Vertically) | Done | 0.4: every edge and centre, and Horizontally / Vertically for equal gaps; shapes by the pixels they cover | S | 0.4 · finish-layer-menu |
| Duplicate Layer | Layer > Duplicate Layer… | Done | 0.4: dialog with name and destination (this document, another open one, or a new document); into another document the layer is neither centred nor converted to its mode | M | 0.4 · finish-layer-menu |
| Hide / Show Layers | Layer > Hide Layers | Done | 0.4: Layer › Hide / Show Layers (Ctrl+,) on every selected layer, one step | S | 0.4 · finish-layer-menu |
| Link Layers / Select Linked Layers | Layer > Link Layers, Select Linked Layers | Done | 0.4: linked layers move together with the Move tool, Free Transform, Align and Distribute | M | 0.4 · finish-layer-menu |
| Lock Layers | Layer > Lock Layers…, Lock All Layers in Group | Done | 0.4: Lock Layers… (Ctrl+/) and Lock All Layers in Group… | S | 0.4 · finish-layer-menu |
| Merge Layers (selected) / Merge Group | Layer > Merge Layers, Merge Group (Ctrl+E with several layers or a group selected) | Done | 0.4: Ctrl+E merges by context (Merge Down, Merge Layers, Merge Group, Merge Clipping Mask on a clipping base); in 16/32-bit documents Merge Group composites at 8 bits | S | 0.4 · finish-layer-menu |
| Merge Visible and Stamp Visible | Layer > Merge Visible (Ctrl+Shift+E); Ctrl+Alt+Shift+E stamps to a new layer | Done | 0.4: Merge Visible, Stamp Visible and Stamp Layers match the canvas and keep 16/32-bit precision (layers with effects, knockout or Blend If on pixels go through the 8-bit composite) | S | 0.4 · finish-layer-menu |
| New Group | Layer > New > Group… | Done | 0.4: New Group dialog (name, colour, mode, opacity) | S | 0.4 · finish-layer-menu |
| New Layer dialog | Layer > New > Layer… (Ctrl+Shift+N), Alt-click the New Layer button | Done | 0.4: New Layer dialog with clipping, colour, mode, opacity and neutral fill; Alt-click on New Layer, Alt+Shift+Ctrl+N without the dialog | S | 0.4 · finish-layer-menu |
| New Fill Layer: Gradient | Layer > New Fill Layer > Gradient (Gradient Fill dialog) | Done | 0.4: Gradient Fill dialog with the full gradient, Method, Dither, Offset; Cancel removes the layer. Align with Layer is not offered on fill layers | M | 0.4 · gradients |
| New Fill Layer: Pattern | Layer > New Fill Layer > Pattern (Pattern Fill dialog) | Done | 0.4: Pattern Fill dialog with Angle, Link with Layer, Snap to Origin and dragging; Cancel removes the layer | M | 0.4 · patterns |
| New Fill Layer: Solid Color | Layer > New Fill Layer > Solid Color | Done | 0.4: asks the New Layer questions, then the colour | S | 0.4 · finish-layer-menu |
| Rasterize submenu | Layer > Rasterize > Type, Shape, Fill Content, Vector Mask, Smart Object, Video, Layer Style, Layer, All Layers | Done | 0.4: Type, Shape, Fill Content, Vector Mask, Smart Object, Layer Style, Layer and All Layers, keeping the Blending Options; no video layers, so no Video | S | 0.4 · finish-layer-menu |
| Layer groups: nesting, masks, pass-through | Layers panel: groups | Done | 0.4: nesting, layer and vector masks, Pass Through and isolated groups, styles on groups, Alt/Ctrl-click to open nested groups | M | 0.4 · layers-panel-depth |
| Align | Layer > Align (six edges/centres; to selection or canvas) | Done | layer-ops.js align: to the selection, else among selected layers, else to the canvas; uses painted bounds. No explicit Align To: Canvas choice with several layers selected |  |  |
| Create / Release Clipping Mask | Layer > Create Clipping Mask (Ctrl+Alt+G) | Done | layer-ops.js 'layer:clip'; compositor.js clipping chains incl. clipped groups |  |  |
| Delete: Layer, Hidden Layers | Layer > Delete | Done | layer-ops.js 'layer:delete', layers-extras/structure.js deleteHidden |  |  |
| Flatten Image | Layer > Flatten Image | Done | layer-ops.js 'image:flatten' (white fill, Background lock kept; float path in depth.js) |  |  |
| Group Layers / Ungroup Layers | Layer > Group Layers (Ctrl+G), Ungroup Layers | Done | layer-ops.js 'layer:group', 'layer:ungroup' |  |  |
| Layer Content Options | Layer > Layer Content Options | Done | layer-ops.js 'layer:properties' routes to the adjustment or fill editor |  |  |
| Matting | Layer > Matting > Color Decontaminate, Defringe, Remove Black Matte, Remove White Matte | Done | adjust-more-ui.js mattingCommand + shared/pixels/matting.js |  |  |
| Merge Down | Layer > Merge Down (Ctrl+E) | Done | layer-ops.js 'layer:merge-down' (keeps lower layer's mode/opacity; float merge via depth.js) |  |  |
| Group from Layers | Layer > New > Group from Layers | Done | layers-extras/structure.js groupFromLayers: Name, Color, Mode, Opacity |  |  |
| Layer from Background / Background from Layer | Layer > New > Layer from Background, Background from Layer | Done | layers-extras/structure.js fromBackground: dialog with Name, Color, Mode, Opacity |  |  |
| Layer via Copy / Layer via Cut | Layer > New > Layer via Copy (Ctrl+J), Layer via Cut (Ctrl+Shift+J) | Done | layer-ops.js viaCopy |  |  |
| Rename Layer | Layer > Rename Layer | Done | layer-ops.js 'layer:rename' and inline rename in the panel |  |  |

## channels

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Split Channels / Merge Channels | Channels panel menu | Missing | Absent | M | 0.6 · channels-depth |
| Per-channel visibility and single-channel view | Channels panel: eye column, click a channel to view it (grey or in colour) | Missing | File header states it: the canvas always shows the composite; rows have no eyes | M | 0.6 · channels-depth |
| Painting and filtering on alpha channels | Channels panel: select an alpha channel and edit it on canvas (with rubylith overlay) | Missing | Selecting a saved channel only highlights the row; its pixels change only through Save Selection / Calculations | M | 0.6 · channels-depth |
| Editing individual colour channels | Channels panel: target one channel for painting, filters, adjustments, paste | Missing | edit-ops.js pixelTarget returns only the layer canvas or its mask | L | 0.6 · channels-depth |
| Channel shortcuts, reordering and panel options | Ctrl+2/3/4/5, drag to reorder, panel menu thumbnail size | Missing | None of these; rows show no shortcut hints | S | 0.6 · channels-depth |
| Duplicate Channel dialog and duplicating colour channels | Channels panel menu: Duplicate Channel (As, destination document, Invert) | Partial | Alpha channels duplicate in place without a dialog; colour channels cannot be duplicated to an alpha channel (Calculations is the workaround) | S | 0.6 · channels-depth |
| Spot channels | Channels panel menu: New Spot Channel, Merge Spot Channel, solidity, ink colour | Partial | Spot channels exist only as the output of Multichannel conversion (flag `spot` with ink chip); no New Spot Channel, no Merge Spot Channel, not composited as inks in RGB documents | L | 0.6 · channels-depth |
| Save selection as channel | Channels panel: button; Select > Save Selection (document, channel, operation) | Partial | edit-ops.js 'select:save' asks for a name and always makes a new channel in the current document; no Replace/Add/Subtract/Intersect with an existing channel, no other-document or new-document destination | S | 0.6 · channels-depth |
| Channel Options | Channels panel: double-click / Channel Options (name, Color Indicates Masked Areas / Selected Areas / Spot Color, colour, opacity) | Partial | Rename prompt only | S | 0.6 · channels-depth |
| Alpha channels: new, duplicate, rename, delete | Channels panel footer and menu | Done | panels/channels.js newChannel, duplicateChannel, renameChannel, deleteChannel (undoable) |  |  |
| Load channel as selection | Channels panel: button, Ctrl-click (+Shift, +Alt, +Shift+Alt) | Done | panels/channels.js loadAsSelection for composite (luminosity), colour planes, mask and alpha channels; Select > Load Selection dialog with Invert and operation |  |  |
| Channel list per image mode | Channels panel: composite and colour channels with thumbnails | Done | panels/channels.js modeRows: RGB, CMYK, Lab composites and channels, single channel for Grayscale/Bitmap/Duotone/Indexed (Index row opens Color Table), layer mask row, saved channels |  |  |
| Apply Image | Image > Apply Image | Done | adjust-more-ui.js applyImageCommand: source document, layer/merged, channel, Invert, blending incl. Add/Subtract with Scale and Offset, Opacity, Preserve Transparency, Mask (document/layer/channel/invert) |  |  |
| Calculations | Image > Calculations | Done | adjust-more-ui.js calculationsCommand: two sources, blending, opacity, mask, result New Channel / New Document / Selection, preview |  |  |

## measurement

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Analysis: Count Tool | Image > Analysis > Count Tool | Missing | No count tool | M | 0.9 · notes-count-measurement |
| Analysis: Place Scale Marker | Image > Analysis > Place Scale Marker | Missing | Absent | S | 0.9 · notes-count-measurement |
| Analysis: Record Measurements and Measurement Log | Image > Analysis > Record Measurements; Window > Measurement Log | Missing | Absent | L | 0.9 · notes-count-measurement |
| Analysis: Select Data Points | Image > Analysis > Select Data Points | Missing | Absent | S | 0.9 · notes-count-measurement |
| Analysis: Set Measurement Scale | Image > Analysis > Set Measurement Scale | Missing | Absent (Image menu has no Analysis submenu) | M | 0.9 · notes-count-measurement |
| Analysis: Ruler Tool | Image > Analysis > Ruler Tool | Partial | Ruler tool exists (tools/nav.js: distance, angle, Straighten Layer, Clear) but there is no menu entry and no protractor (Alt second leg) check done here | S | 0.9 · notes-count-measurement |

## vector

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Copy SVG | Layer > Copy SVG | Missing | Absent | M | 0.7 · vector-io |
| Frames: Frame from Layers, Convert to Frame | Layer > New > Frame from Layers, Convert to Frame | Missing | No frame layers | L | 0.9 · artboards-frames |
| Vector Mask: Reveal All, Hide All, Current Path | Layer > Vector Mask | Done | 0.4: Layer › Vector Mask › Reveal All, Hide All, Current Path | L | 0.4 · masks-vector-masks |
| Vector Mask: Delete, Enable, Link, rasterize to layer mask | Layer > Vector Mask; Layer > Rasterize > Vector Mask | Done | 0.4: Delete, Disable / Enable, Link / Unlink, Layer › Rasterize › Vector Mask. PSD gets the vector mask baked into the raster mask, and vector masks are not read from PSD | M | 0.4 · masks-vector-masks |
| Properties: vector mask | Properties panel > Masks > vector mask (density, feather) | Done | 0.4: vector mask section with Density and Feather | M | 0.4 · masks-vector-masks |
| Properties: live shape properties | Properties panel for a shape layer: W/H/X/Y, per-corner radii, fill, stroke, stroke options (align, caps, joins, dashes), path operations | Done | 0.4: W/H/X/Y, per-corner radii, fill, stroke and stroke options, path operations, Copy / Paste Attributes; X and Y in pixels, not ruler units | M | 0.4 · shapes-live |
| Combine Shapes | Layer > Combine Shapes (Unite, Subtract Front, Intersect, Exclude) | Done | menu 'Shape Operations' -> tools/vector.js 'path:op' and 'path:merge-components' |  |  |

## smart-objects

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Smart Filter blending options | Double-click the blending icon of a smart filter (mode, opacity) | Missing | filterOp in smart-object.js has toggle/edit/up/down/delete only | M | 0.6 · smart-filters-depth |
| Smart Filter mask | Layer > Smart Filter > Add/Delete/Disable Filter Mask; mask thumbnail in Layers panel | Missing | No filter mask; README admits it (the layer mask applies to everything) | M | 0.6 · smart-filters-depth |
| Linked smart objects | Layer > Smart Objects > Convert to Linked, Embed Linked, Embed All Linked, Update Modified Content, Update All Modified Content, Relink to File, Reveal in Explorer; File > Place Linked | Missing | Sources are always embedded (makeSource document/image); no file link, no modified/missing status | L | 0.7 · linked-smart-objects |
| Non-destructive warps on smart objects | Edit > Transform > Warp, Puppet Warp, Perspective Warp applied to a smart object | Partial | Affine/perspective transforms stay live; Warp, Perspective Warp and Puppet Warp rasterize the smart object first (README) | M | 0.7 · transform-warp-depth |
| Smart filter rows in the Layers panel | Layers panel: Smart Filters list | Partial | panels/layers.js filterRows: per-filter eye, double-click edit, context menu Move Up/Down, Delete. No drag reorder, no drag/Alt-drag to another smart object | S | 0.6 · smart-filters-depth |
| Smart Filter: Enable/Disable, Clear | Layer > Smart Filter > Disable Smart Filters, Clear Smart Filters | Done | smart-object.js 'layer:smart-filters-toggle', 'layer:smart-filters-clear' |  |  |
| Convert to Layers | Layer > Smart Objects > Convert to Layers | Done | layers-extras/structure.js smartToLayers (warns about lost filters/transform) |  |  |
| Convert to Smart Object | Layer > Smart Objects > Convert to Smart Object | Done | smart-object.js convert (multi-layer, keeps links inside) |  |  |
| Edit Contents | Layer > Smart Objects > Edit Contents | Done | smart-object.js editContents (opens the source as a document, writes back on save) |  |  |
| New Smart Object via Copy | Layer > Smart Objects > New Smart Object via Copy | Done | smart-object.js viaCopy (independent source copy) |  |  |
| Rasterize smart object / Reset Transform | Layer > Smart Objects > Rasterize, Reset Transform | Done | smart-object.js 'layer:smart-rasterize', 'layer:smart-reset' |  |  |
| Replace Contents / Export Contents | Layer > Smart Objects > Replace Contents, Export Contents | Done | smart-object.js replaceContents, exportContents |  |  |
| Stack Mode | Layer > Smart Objects > Stack Mode | Done | align-blend.js 'layer:stack-mode' + shared/pixels/stack.js: None, Entropy, Kurtosis, Maximum, Mean, Median, Minimum, Range, Skewness, Standard Deviation, Summation, Variance |  |  |

## canvas

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Image Size: preview pane | Image Size dialog preview with zoom | Missing | No preview of the resampled result | M | 0.7 · image-size-crop |
| Image Size: Fit To presets and preset save/load | Image Size: Fit To menu (Original Size, Auto Resolution, paper and pixel presets, Load/Save Preset) | Missing | Absent from the dialog (File > Automate > Fit Image covers fit-in-box only) | S | 0.7 · image-size-crop |
| Image Size: Preserve Details (enlargement) with Reduce Noise | Image Size: Resample > Preserve Details, Reduce Noise slider | Missing | No edge-preserving upscaler and no noise slider | M | 0.7 · image-size-crop |
| Image Size: resample methods | Image Size: Resample menu | Partial | Bicubic, Lanczos, Bilinear, Area average, Nearest. Missing Automatic, Bicubic Smoother (enlargement), Bicubic Sharper (reduction) as choices | S | 0.7 · transform-warp-depth |
| Canvas Size | Image > Canvas Size | Done | image-ops.js canvasSize: units, Relative, 9-point anchor, extension colour (Background/Foreground/White/Black/Gray/Other, only with an opaque Background) |  |  |
| Crop (to selection) | Image > Crop | Done | image-ops.js cropToSelection |  |  |
| Duplicate | Image > Duplicate | Done | image-ops.js duplicate: name, Duplicate Merged Layers Only (depth.js keeps 16/32-bit samples) |  |  |
| Image Rotation | Image > Image Rotation | Done | image-ops.js rotateCanvas: 180, 90 CW, 90 CCW, Arbitrary (angle, direction), Flip Canvas Horizontal/Vertical |  |  |
| Image Size: dimensions, units, resolution, constrain, resample toggle, scale styles | Image > Image Size | Done | image-ops.js imageSize: px/percent/in/cm/mm/pt, constrain, Resample on/off (print size only), Scale Styles, size read-out (resolution in pixels/inch only, no pixels/cm) |  |  |
| Reveal All | Image > Reveal All | Done | image-ops.js revealAll |  |  |
| Trim | Image > Trim | Done | image-ops.js trim: transparent / top-left / bottom-right colour, four sides |  |  |

## automation

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Apply Data Set | Image > Apply Data Set (and File > Export > Data Sets as Files) | Missing | Absent | M | 0.9 · variables-data-sets |
| Variables: Data Sets (create, import CSV/text) | Image > Variables > Data Sets | Missing | Absent | L | 0.9 · variables-data-sets |
| Variables: Define | Image > Variables > Define | Missing | No variables (visibility, pixel replacement, text replacement) on layers | L | 0.9 · variables-data-sets |

## presets

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Adjustment presets: save, load, built-in lists | Preset menu and gear in every adjustment dialog (.alv, .acv, .ahu, .blw, .cha ...) | Done | 0.4: built-in lists, save, load, rename, delete, reset; .alv, .acv, .ahu, .cha, .asv, .blw files. Preset groups cannot be created; built-in values approximate Photoshop's | M | 0.4 · adjust-tonal |
| Adjustments panel: adjustment presets | Window > Adjustments > Adjustments presets (Portraits, Landscape, Photo Repair, Creative, Black & White, Cinematic), hover preview, Your Presets | Partial | 0.4: the six groups of built-in presets; no Your Presets and no hover preview | M | 0.4 · adjust-color |
| Style presets (Styles list, New Style, Make Default) | Layer Style dialog: Styles, New Style…, Make Default / Reset to Default | Partial | Only 'Reset to default' per effect; no saved styles, no Styles panel, no Make Default, no .asl import | M | 0.5 · presets-panels |

## color-modes

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Mode: Bitmap | Image > Mode > Bitmap | Done | 0.4: Custom Pattern takes a pattern from the library | S | 0.4 · patterns |
| Mode: Duotone (mono/duo/tri/quadtone) | Image > Mode > Duotone | Partial | modes/dialogs.js duotone options: type, up to four inks with colour, name and per-ink curve editor, presets. Overprint Colors button is present but disabled (inks always multiply); no load/save of .ado presets | M | 0.7 · image-size-crop |
| 8 / 16 / 32 Bits per Channel | Image > Mode > 8, 16, 32 Bits/Channel | Approximate | renderer/lib/depth.js + shared/pixels/deep.js: real 16-bit/float storage per raster layer; adjustments, crop, canvas size, flips, flatten and merges run at depth; painting, filters, Image Size, transforms run at 8 bits on touched pixels; masks stay 8-bit; 32-bit is display-referred, not linear; no HDR Toning dialog on 32 to 8/16 conversion (highlights are clipped with a toast); PSD written at 8 bits | XL | 0.9 · deep-pipeline |
| Mode: Multichannel | Image > Mode > Multichannel | Approximate | Conversion creates spot channels stored as saved channels flagged `spot`; the picture is still RGBA underneath | L | 0.10 · cmyk-lab-storage |
| Color Table | Image > Mode > Color Table | Done | modes/dialogs.js colorTableDialog: presets Black Body, Grayscale, Spectrum, System Mac/Win, per-entry edit, colour ramp over a range, transparency eyedropper, load/save .act |  |  |
| Mode: Grayscale | Image > Mode > Grayscale | Done | renderer/lib/modes.js image:mode + shared/pixels/modes.js; 8/16/32-bit allowed |  |  |
| Mode: Indexed Color | Image > Mode > Indexed Color | Done | modes/dialogs.js: palettes Exact, System Mac/Win, Web, Uniform, Local Perceptual/Selective/Adaptive, Custom; colours, Forced, Transparency, Matte, Dither (Diffusion/Pattern/Noise), Amount, Preserve Exact Colors (no Master palettes) |  |  |
| Mode: RGB Color | Image > Mode > RGB Color | Done | modes.js image:mode; native storage |  |  |

## masks

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Mask density and feather (non-destructive) | Properties panel > Masks: Density, Feather | Done | 0.4: Density and Feather for layer and vector masks, non-destructive; PSD gets them baked into the raster mask | M | 0.4 · masks-vector-masks |
| Mask view modes | Alt-click mask thumbnail (view mask), Shift+Alt-click or \ (rubylith overlay), Layer Mask Display Options | Done | 0.4: Alt-click shows the mask, \ the overlay with Overlay Options (colour, opacity); Layer Mask Display Options in the Channels panel menu | S | 0.4 · masks-vector-masks |
| Layer Mask: Delete, Apply, Enable/Disable, Link/Unlink | Layer > Layer Mask | Done | layer-ops.js maskOp delete/apply/toggle/link (Apply on raster layers) |  |  |
| Layer Mask: Reveal All, Hide All, Reveal Selection, Hide Selection, From Transparency | Layer > Layer Mask | Done | layer-ops.js maskOp (works on groups, text, shapes, smart objects too; From Transparency needs a raster layer) |  |  |

## ai

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Generative layers (kept variations, regenerate from Properties) | Layer > New > Generative Layer; Properties panel variations | Missing | ai/features.js Generative Fill creates one plain raster layer per variation; no generative layer type that keeps prompt and variations. Buildable with the user's own provider keys (Firefly itself is Adobe cloud) | M | 0.10 · generative-features |
| Image Size: Preserve Details 2.0 | Image Size: Resample > Preserve Details 2.0 | Not feasible | Adobe's trained upscaling model. Substitute: an open-source super-resolution model the user downloads (e.g. an ESRGAN-family ONNX model), clearly labelled as such |  |  |
| Mask All Objects | Layer > Mask All Objects | Not feasible | Absent; Photoshop uses a proprietary object-detection model. Substitute: an open-source segmentation model the user downloads (e.g. Segment Anything ONNX) creating one masked group per object, or Pigment's heuristic Object Selection run per region, labelled as approximate |  |  |

## artboards

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Artboards: Artboard, Artboard from Group, Artboard from Layers | Layer > New > Artboard… | Missing | No artboards (README lists them as missing) | XL | 0.9 · artboards-frames |

## formats

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Export As (layers) | Layer > Export As… | Partial | layers-extras/export.js exportAs: format, quality, one scale (25-300%), trim, background. Missing multiple scales with suffixes, image/canvas size fields, resample choice, metadata and colour-space options, preview | M | 0.6 · export-as |
| Quick Export as PNG (layers) | Layer > Quick Export as PNG | Done | layers-extras/export.js quickExport |  |  |

## slices

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| New Layer Based Slice | Layer > New Layer Based Slice | Missing | No slices (README) | L | 0.10 · slices-web-export |

## timeline

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Video Layers submenu | Layer > Video Layers (New Video Layer from File, New Blank Video Layer, Insert/Duplicate/Delete Frame, Replace Footage, Interpret Footage, Restore Frame...) | Missing | No timeline or video (README) | XL | 0.10 · video-timeline-core |

## type-engine

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Properties: type layer | Properties panel for a type layer: transform, character, paragraph, type options | Done | 0.4: transform, character, paragraph and type options, editable | M | 0.4 · type-character-panel |

## cloud

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Relink to Library Graphic | Layer > Smart Objects > Relink to Library Graphic | Not feasible | Needs Creative Cloud Libraries. Substitute: Relink to File once linked smart objects exist |  |  |

## color-management

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Mode: CMYK Color | Image > Mode > CMYK Color | Approximate | A view of RGB pixels: channels and Info readouts are derived (shared/pixels/modes.js channelPlanes); no ICC separation, no CMYK storage, no per-plate editing. README admits it. Users doing print work will notice | XL | 0.10 · cmyk-lab-storage |
| Mode: Lab Color | Image > Mode > Lab Color | Approximate | View of RGB pixels with derived L/a/b channels; adjustments and filters still run on RGB, so Lab-specific workflows (curves on a/b, sharpening L) are not possible | L | 0.10 · cmyk-lab-storage |
| Trap | Image > Trap | Approximate | modes.js image:trap + modes/dialogs.js trapDialog (width in px/pt/mm), enabled in CMYK mode; works on the derived CMYK view of RGB pixels, not real plates | M | 0.11 · cmyk-formats-separations |
| Duotone / spot ink colour books (Pantone, Toyo, DIC...) | Duotone Options and Spot Channel colour picker: Color Libraries | Not feasible | Absent; the books are licensed data. Honest substitute: inks picked as free RGB/Lab colours (what Pigment does) plus import of user-supplied .acb/.ase swatch files |  |  |
