# Parity: Select, Filter and View menus

Part of [Pigment and Photoshop: feature parity](../PARITY.md), as of Pigment 0.4 (November 2026). The rows planned for 0.4 ("0.4 · *package*") show their 0.4 status and the counts below include them; the other rows and the overview paragraph describe Pigment 0.3.1 as the audit found it.

Verified in the code under /home/user/claude/pigment (menu: /home/user/claude/pigment/src/main/menu.js; no command in this area is stubbed, app.stubbed is empty). Select is the strongest part: every menu command except New 3D Extrusion exists, and Select and Mask is nearly complete (missing Refine Hair, presets, High Quality Preview), but Color Range is a thin form (no eyedroppers on the image, no Localized Color Clusters, Skin Tones, Out of Gamut, matte previews or .axt), Modify has no "apply effect at canvas bounds", Load/Save Selection lack document and channel-operation choices, there are no Quick Mask Options, and Subject / Sky / Focus Area are GrabCut and saliency heuristics rather than learned models. Filter has all the classic menu filters, the 47 Filter Gallery effects and the five Blur Gallery kinds, but many dialogs are simplified (Smart Sharpen, Reduce Noise, Wave, ZigZag, Spherize, Shear, Custom 3x3, Maximum/Minimum, Offset, Lens Flare, Lighting Effects with one light, Oil Paint on a different algorithm), smart filters have no masks, no per-filter blending options and no drag between layers, and Neural Filters, Adaptive Wide Angle, Vanishing Point, Filter > 3D and 8BF plug-ins are absent. Camera Raw Filter covers only Basic, a reduced Detail, HSL and a reduced Effects tab (no Curve, Color Grading, Optics, Geometry, Calibration, masking, healing, presets, snapshots, histogram or before/after); Liquify has five brushes and two sliders (no Smooth, Push Left, Freeze/Thaw, Face-Aware, meshes, view options, zoom, smart filter); Lens Correction lacks a profile database (Lensfun would be the honest substitute). View is the weakest menu: Proof Colors and Gamut Warning are a fixed generic CMYK simulation with no Proof Setup or ICC, guides can only be created and cleared all at once (no move, delete, lock, colours, Guide Layout, From Shape), snapping exists only in the Move tool (document edges and guides, no Snap To submenu, grid or layers, no Smart Guides), and Pixel Aspect Ratio, 32-bit Preview Options, Print Size, Actual Size, Fit Layer, Flip Horizontal view, Pattern Preview, real Screen Modes, the Extras master toggle with its Show submenu, ruler origin, bird's-eye view, flick panning and animated zoom (a dead setting, `void animate` in canvas-view.js) are missing. Features that depend on Adobe's trained models or data (Neural Filters, Adobe camera/lens profiles, ACR AI masks, Denoise and Lens Blur) are marked not-feasible with open-source or user-supplied substitutes named.

62 missing · 47 partial · 18 approximate · 17 not feasible · 78 done · 222 entries

## view

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Ruler origin | Drag from the ruler corner to set the zero point; double-click the corner to reset | Done | 0.4: drag from the ruler corner, double-click to reset; follows Image Size, Canvas Size, Rotate, Flip and Crop | S | 0.4 · guides-snapping |
| Bird's-eye view | Hold H and drag while zoomed in | Missing | Not present | S | 0.6 · view-navigation |
| Animated zoom | Preferences > Tools > Animated Zoom; continuous zoom while holding the Zoom tool | Missing | defaults.js has animatedZoom: true but nothing reads it and setZoom() discards its animate option (`void animate` in canvas-view.js); zoom always jumps | S | 0.6 · view-navigation |
| Flick panning | Preferences > Tools > Enable Flick Panning | Missing | The Hand tool pans without inertia | S | 0.6 · view-navigation |
| 32-bit Preview Options | View > 32-bit Preview Options (Exposure and Gamma / Highlight Compression); status bar 32-bit Exposure slider | Missing | No command; 32-bit is display-referred float shown as is (depth.js has no preview exposure) | M | 0.10 · hdr-32bit |
| Actual Size | View > Actual Size | Missing | Not present (needs the display's physical DPI) | S | 0.7 · screen-modes-extras |
| Fit Layer(s) on Screen | View > Fit Layer(s) on Screen; Alt-click a layer thumbnail | Missing | Not present | S | 0.7 · screen-modes-extras |
| Flip Horizontal (view only) | View > Flip Horizontal | Missing | Not present; the view matrix has zoom, pan and rotation only | M | 0.7 · screen-modes-extras |
| Pattern Preview | View > Pattern Preview | Done | 0.4: View › Pattern Preview | M | 0.4 · patterns |
| Pixel Aspect Ratio and Pixel Aspect Ratio Correction | View > Pixel Aspect Ratio (Square, D1/DV NTSC, PAL, Anamorphic..., Custom, Delete, Reset); View > Pixel Aspect Ratio Correction | Missing | No non-square pixel support anywhere in the view or document model | M | 0.11 · render-video |
| Print Size | View > Print Size | Missing | Not present | S | 0.7 · screen-modes-extras |
| Show > All, None, Show Extras Options | View > Show | Missing | Not present | S | 0.7 · screen-modes-extras |
| Show > Count, Slices, Notes | View > Show | Missing | The Count tool, slices and notes do not exist, so neither do their overlays | S | 0.10 · slices-web-export |
| Show > Layer Edges | View > Show > Layer Edges | Missing | Not present | S | 0.7 · screen-modes-extras |
| Show > Smart Guides | View > Show > Smart Guides | Done | 0.4: alignment lines, equal spacing and Ctrl-hover distances; no Smart Guides while drawing paths | M | 0.4 · guides-snapping |
| Show > Target Path | View > Show > Target Path (Shift+Ctrl+H) | Missing | No toggle | S | 0.7 · screen-modes-extras |
| Snap To | View > Snap To > Guides, Grid, Layers, Slices, Document Bounds, All, None | Done | 0.4: Guides, Grid, Layers, Document Bounds, All, None; Artboards and Slices have no targets yet | M | 0.4 · guides-snapping |
| Zoom tool options: Resize Windows to Fit, Zoom All Windows | Zoom tool options bar | Missing | Only Zoom in/out, Fit on screen, 100 %, Fill screen and Scrubby zoom; documents are tabs in one window | S | 0.8 · document-windows |
| Scroll-wheel and gesture zoom | Preferences > Tools: Zoom with Scroll Wheel; Alt+wheel; trackpad pinch | Partial | lib/canvas-view.js wheel handler: Ctrl/Cmd+wheel and pinch zoom, plain wheel scrolls (or zooms with the zoomWithWheel preference), Shift+wheel scrolls sideways. Alt+wheel, Photoshop's default zoom gesture, is not handled, and Ctrl+wheel zooms where Photoshop scrolls horizontally. | S | 0.6 · view-navigation |
| Ruler units | Right-click a ruler; Preferences > Units & Rulers (Pixels, Inches, Centimeters, Millimeters, Points, Picas, Percent) | Done | 0.4: Pixels, Inches, Centimeters, Millimeters, Points, Picas and Percent from the ruler menu or Preferences | S | 0.4 · guides-snapping |
| Rotate View tool | Rotate View tool (R): drag, Shift for 15 degrees, Rotation Angle field, Reset View, Rotate All Windows | Partial | lib/tools/nav.js RotateViewTool: drag, Shift snaps to 15 degrees, Angle field and Reset view. No compass overlay while dragging and no Rotate All Windows (there is one view per document). R is shared with the Hand slot as the panels auditor notes. | S | 0.6 · view-navigation |
| Temporary navigation keys | Space (Hand), Ctrl+Space / Alt+Space (Zoom in / out), hold R (Rotate View) | Done | 0.4: Space, Ctrl+Space, Alt+Space, and a held tool key (R for Rotate View) | S | 0.4 · conventions-shortcuts-fields |
| Extras (master toggle) | View > Extras (Ctrl+H) | Partial | view:extras (Ctrl+H) only toggles selection edges (settings.showSelectionEdges); guides, grid and paths stay | S | 0.7 · screen-modes-extras |
| Show > Brush Preview, Mesh, Edit Pins | View > Show | Partial | Puppet Warp has its own 'Show mesh' checkbox (/home/user/claude/pigment/src/renderer/lib/warp.js); no View > Show entries, no pin toggle, no brush preview | S | 0.7 · screen-modes-extras |
| Snap | View > Snap (Shift+Ctrl+;) | Done | 0.4: View › Snap; every placing tool snaps, nearest target first; Ctrl while dragging turns it off | M | 0.4 · guides-snapping |
| Status bar zoom field | Document window status bar: zoom percentage | Done | Editable zoom field in the status bar (app.js, view:set-zoom) |  |  |
| 100% and 200% | View > 100% (Ctrl+1), 200% | Done | view:zoom-100, view:zoom-200 (Ctrl+2) |  |  |
| Fit on Screen | View > Fit on Screen (Ctrl+0) | Done | view:zoom-fit (also resets the view rotation); extra Fill Screen item |  |  |
| Rulers | View > Rulers (Ctrl+R) | Done | view:rulers; drawn in canvas-view.js and follow zoom and pan |  |  |
| Show > Grid | View > Show > Grid (Ctrl+') | Done | view:grid |  |  |
| Show > Guides | View > Show > Guides (Ctrl+;) | Done | view:guides |  |  |
| Show > Pixel Grid | View > Show > Pixel Grid | Done | view:pixel-grid (drawn from 800 % zoom) |  |  |
| Show > Selection Edges | View > Show > Selection Edges | Done | view:extras |  |  |
| Zoom In / Zoom Out | View > Zoom In (Ctrl++), Zoom Out (Ctrl+-) | Done | view:zoom-in / view:zoom-out, preset steps 1 %..6400 % (/home/user/claude/pigment/src/renderer/lib/canvas-view.js; Photoshop goes to 12800 %) |  |  |
| Scrubby zoom and marquee zoom | Zoom tool options bar: Scrubby Zoom; drag a marquee when off | Done | ZoomTool in tools/nav.js: scrubby option on by default, marquee zoom when off, Alt zooms out |  |  |

## filters

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Blur Gallery: several blur types in one session | Blur Gallery panel: Field / Iris / Tilt-Shift / Path / Spin checkboxes combined | Missing | Each kind is its own command and session; they cannot be combined in one pass | M | 0.7 · filter-dialogs-b |
| Filter > 3D: Generate Bump (Height) Map, Generate Normal Map | Filter > 3D | Missing | No 3D group in the registry (FILTER_CATEGORIES in /home/user/claude/pigment/src/shared/pixels/filters.js). Both maps are classical image filters and do not need a 3D engine | M | 0.7 · filter-dialogs-b |
| Adaptive Wide Angle | Filter > Adaptive Wide Angle (Fisheye / Perspective / Auto / Panorama / Full Spherical, Constraint and Polygon Constraint tools, Scale, Focal Length, Crop Factor) | Missing | No command (README lists it as missing). Buildable with projection models and line constraints; Auto mode needs lens data (EXIF plus Lensfun as substitute for Adobe profiles) | L | 0.9 · lens-correction-profiles |
| Vanishing Point | Filter > Vanishing Point (Create/Edit Plane, Marquee, Stamp, Brush, Transform, Eyedropper, Measure; render grids, export) | Missing | No command (README lists it as missing) | XL | 0.10 · vanishing-point |
| Blur Gallery: options bar | Blur Gallery options bar: Selection Bleed, Focus, Save Mask to Channels, High Quality, Preview, Remove All Pins | Partial | Preview and Reset only | S | 0.7 · filter-dialogs-b |
| Blur Gallery: Effects (Bokeh, Motion Effects) and Noise | Blur Gallery: Effects tab (Light Bokeh, Bokeh Color, Light Range; Strobe Strength, Strobe Flashes, Strobe Flash Duration), Noise tab | Partial | Bokeh, strobe strength and flashes and the Noise tab exist; Strobe Flash Duration is missing; noise has Uniform/Gaussian but no Grain type | S | 0.7 · filter-dialogs-b |
| Blur: Lens Blur | Filter > Blur > Lens Blur (Depth Map source, Blur Focal Distance, Invert, Iris shape/radius/blade curvature/rotation, Specular Highlights, Noise) | Partial | All listed parameters are present (shared/pixels/filters-more-a.js LENS_BLUR_FIELDS; depth map from transparency, layer mask or an alpha channel). Missing: Set Focal Point by clicking in the image (lib/filters-a-ui.js has no click handling for it) and the Faster / More Accurate preview choice. | S | 0.7 · filter-dialogs-a |
| Blur: Radial Blur | Filter > Blur > Radial Blur (Amount, Spin/Zoom, Quality, Blur Center) | Partial | Amount, Spin/Zoom; centre set with two sliders instead of the draggable Blur Center box; no Quality choice | S | 0.7 · filter-dialogs-a |
| Blur: Shape Blur | Filter > Blur > Shape Blur (Radius, custom shape picker) | Partial | Ten built-in kernels (circle, square, triangle, diamond, star, heart, arrow, cross, hexagon, ring); cannot use the custom shape presets | S | 0.7 · filter-dialogs-a |
| Blur Gallery: Path Blur | Filter > Blur Gallery > Path Blur (Basic Blur / Rear Sync Flash, Speed, Taper, Centered Blur, End Point Speed, Edit Blur Shapes) | Partial | Speed, Taper, Centered Blur, end speeds, multiple paths. Paths have no curve handles, no Edit Blur Shapes, no Basic Blur / Rear Sync Flash preset; 4-13 s at 12 MP | M | 0.7 · filter-dialogs-b |
| Distort: Shear | Filter > Distort > Shear (curve with draggable points, Wrap Around / Repeat Edge Pixels) | Partial | One Bend slider (a three-point curve) in filter-ui.js; the engine accepts a point list but there is no curve editor | S | 0.7 · filter-dialogs-a |
| Distort: Spherize | Filter > Distort > Spherize (Amount, Mode: Normal / Horizontal only / Vertical only) | Partial | Amount only; no Mode | S | 0.7 · filter-dialogs-a |
| Distort: Wave | Filter > Distort > Wave (Number of Generators, Wavelength min/max, Amplitude min/max, Scale horiz/vert, Type, Randomize, Undefined Areas) | Partial | One amplitude, one wavelength, Type and edge mode; no generators, min/max ranges, per-axis scale or Randomize | M | 0.7 · filter-dialogs-a |
| Distort: ZigZag | Filter > Distort > ZigZag (Amount, Ridges, Style: Around Center / Out From Center / Pond Ripples) | Partial | Amount and Ridges; no Style | S | 0.7 · filter-dialogs-a |
| Last Filter | Filter > Last Filter (Alt+Ctrl+F) | Partial | filter:last (Ctrl+F) in /home/user/claude/pigment/src/renderer/lib/filter-ui.js repeats registry filters only: Camera Raw Filter and Liquify are never remembered (admitted for Camera Raw). filter:last-dialog (reopen the dialog) is registered but has no menu item or shortcut | S | 0.7 · filter-dialogs-a |
| Noise: Reduce Noise | Filter > Noise > Reduce Noise (Strength, Preserve Details, Reduce Color Noise, Sharpen Details, Remove JPEG Artifact; Advanced per-channel; saved settings) | Partial | A single Strength 0..10 slider (filter-ui.js FIELDS['reduce-noise']); every other option and the Advanced per-channel mode are missing | M | 0.7 · filter-dialogs-a |
| Other: Custom | Filter > Other > Custom (5 x 5 kernel, Scale, Offset, Load / Save .acf) | Partial | 3 x 3 kernel with Scale and Offset; no 5 x 5 grid, no Load/Save | S | 0.7 · filter-dialogs-a |
| Other: Maximum, Minimum | Filter > Other > Maximum / Minimum (Radius with decimals, Preserve: Squareness / Roundness) | Partial | Integer Radius 1..100 only; no Preserve choice (square kernel) | S | 0.7 · filter-dialogs-a |
| Other: Offset | Filter > Other > Offset (Horizontal, Vertical, Undefined Areas: Set to Transparent / Repeat Edge Pixels / Wrap Around) | Partial | Horizontal, Vertical and a 'Wrap around' checkbox (transparent otherwise); Repeat Edge Pixels is not offered although the engine has an edge parameter | S | 0.7 · filter-dialogs-a |
| Render: Lens Flare | Filter > Render > Lens Flare (Brightness, Flare Center, Lens Type: 50-300mm Zoom / 35mm Prime / 105mm Prime / Movie Prime) | Partial | Brightness and centre sliders only; one flare look, no Lens Type, no click-to-place preview | S | 0.7 · filter-dialogs-a |
| Render: Lighting Effects | Filter > Render > Lighting Effects (multiple Spot / Point / Infinite lights with on-canvas handles, presets, Properties: Colorize, Gloss, Metallic, Ambience, Texture, Height) | Partial | lighting-effects dialog edits one light only (the engine honours up to 16), no on-canvas light editor, no Lights list, no presets. Adobe has removed this filter from current releases | L | 0.7 · filter-dialogs-b |
| Sharpen: Smart Sharpen | Filter > Sharpen > Smart Sharpen (Amount, Radius, Reduce Noise, Remove: Gaussian / Lens / Motion Blur with Angle, Shadows and Highlights: Fade Amount, Tonal Width, Radius; presets; Use Legacy) | Partial | Amount, Radius, Reduce noise only (filter-ui.js FIELDS['smart-sharpen']); no Remove choice or angle, no Shadows / Highlights sections, no presets | M | 0.7 · filter-dialogs-a |
| Filters at 16 and 32 bits per channel | Filter menu on 16-bit / 32-bit documents | Partial | Every filter runs at 8 bits on the pixels it touches and the deep data is rebuilt from the 8-bit proxy (README limits, /home/user/claude/pigment/src/renderer/lib/depth.js) | L | 0.9 · deep-pipeline |
| Lens Correction: tools | Lens Correction toolbar: Remove Distortion, Straighten, Move Grid, Hand, Zoom | Partial | Remove Distortion, Straighten, Hand and zoom buttons; no Move Grid tool | S | 0.9 · lens-correction-profiles |
| Lens Correction: Auto tab Correction checkboxes, Auto Scale Image, Edge | Filter > Lens Correction > Auto Correction | Approximate | Geometric Distortion / Chromatic Aberration / Vignette checkboxes only switch the Custom values on and off; Auto Scale and Edge (Transparency, Edge Extension, Wrap Around, Background Color) work; extra 'Straighten horizon' button | S | 0.9 · lens-correction-profiles |
| Render: Flame | Filter > Render > Flame (6 flame types, length, width, angle, interval, quality; Advanced: turbulence, jag, opacity, flame lines, bottom alignment, style, shape, randomize; presets) | Approximate | flame with the six types and the basic sliders on Pigment's own generator; Advanced options Flame Lines, Bottom Alignment, Style, Shape and presets are missing | M | 0.7 · filter-dialogs-b |
| Render: Picture Frame | Filter > Render > Picture Frame (47 frames, vine/flower/leaf choices, margin, arrangement, Advanced) | Approximate | picture-frame: 10 own frames, Size, two colours, seed; far fewer designs and parameters than Photoshop | M | 0.7 · filter-dialogs-b |
| Render: Tree | Filter > Render > Tree (34 tree types, light direction, leaves, branches, arrangement, Advanced camera tilt and colours) | Approximate | tree: 11 own species with the main sliders; Photoshop has 34 types and custom leaf types | M | 0.7 · filter-dialogs-b |
| Sharpen: Shake Reduction | Filter > Sharpen > Shake Reduction (blur trace regions, Blur Trace Bounds, Source Noise, Smoothing, Artifact Suppression, Advanced traces, Detail loupe) | Approximate | shake-reduction estimates one straight trace and deconvolves (README limit); no multiple or curved traces, no trace regions or loupe. Adobe has dropped this filter from current releases | L |  |
| Stylize: Oil Paint | Filter > Stylize > Oil Paint (Stylization, Cleanliness, Scale, Bristle Detail, Lighting Angle and Shine) | Approximate | oil-paint is a neighbourhood-histogram effect with Radius and Levels (filter-ui.js); none of Photoshop's six controls, no brush-stroke relief or lighting. A user would notice immediately | L | 0.7 · filter-dialogs-b |
| Filter Gallery: the 47 effects (Artistic 15, Brush Strokes 8, Distort 3, Sketch 14, Stylize 1, Texture 6) | Filter Gallery groups; also Filter menu when 'Show all Filter Gallery groups and names' is on | Approximate | All 47 kinds exist (gallery-artistic.js, gallery-sketch.js, textures.js under /home/user/claude/pigment/src/shared/pixels) with Photoshop's parameter names, written from scratch: looks are similar, not pixel-identical. Rough Pastels and Underpainting have no Load Texture button; Glowing Edges lacks Smoothness | M | 0.7 · filter-dialogs-b |
| Lens Correction: Auto Correction lens profiles | Filter > Lens Correction > Auto Correction: Search Criteria (Camera Make, Model, Lens), Lens Profiles, Search Online | Not feasible | No profile database (README, /home/user/claude/pigment/src/renderer/lib/lens-correction.js). Adobe's profiles are licensed. Substitute: bundle or download the open Lensfun database and match by EXIF |  |  |
| Filter dialogs: live preview and Preview checkbox | Every filter dialog | Done | pixelEditDialog previews on the canvas inside the selection with a Preview checkbox (/home/user/claude/pigment/src/renderer/lib/adjust-ui.js); no small zoomable preview pane |  |  |
| Blur: Blur, Blur More | Filter > Blur | Done | blur, blur-more (direct) |  |  |
| Blur: Average | Filter > Blur > Average | Done | average (direct); with a non-rectangular selection the mean is taken over its bounding box |  |  |
| Blur: Box Blur | Filter > Blur > Box Blur | Done | box-blur, radius 1..500 |  |  |
| Blur: Gaussian Blur | Filter > Blur > Gaussian Blur | Done | gaussian-blur, radius 0.1..250 (Photoshop allows up to 1000) |  |  |
| Blur: Motion Blur | Filter > Blur > Motion Blur | Done | motion-blur: Angle, Distance 1..2000 |  |  |
| Blur: Smart Blur | Filter > Blur > Smart Blur (Radius, Threshold, Quality, Mode) | Done | smart-blur with Normal / Edge Only / Overlay Edge |  |  |
| Blur: Surface Blur | Filter > Blur > Surface Blur | Done | surface-blur: Radius, Threshold |  |  |
| Blur Gallery: Field Blur, Iris Blur, Tilt-Shift, Spin Blur | Filter > Blur Gallery | Done | /home/user/claude/pigment/src/renderer/lib/blur-gallery-ui.js on-canvas pins, rings and handles; engine blur-gallery.js. Spin Blur treats the ellipse as the outer limit |  |  |
| Distort: Pinch, Polar Coordinates, Ripple, Twirl | Filter > Distort | Done | pinch, polar, ripple (Small/Medium/Large), twirl, each with an extra Undefined areas choice |  |  |
| Distort: Displace | Filter > Distort > Displace (Horizontal/Vertical Scale, Stretch To Fit / Tile, Wrap Around / Repeat Edge Pixels, map file) | Done | displace (/home/user/claude/pigment/src/renderer/lib/filters-b-ui.js); map from another document, a layer or a file; the map is not stored with actions or saved smart filters |  |  |
| Filter Gallery dialog | Filter > Filter Gallery: preview with zoom, effect thumbnails by group, effect layer stack (new, delete, hide, reorder) | Done | /home/user/claude/pigment/src/renderer/lib/filter-gallery.js: all of those; the editing preview is a 720 px reduction with unscaled parameters, so strokes look larger than in the result |  |  |
| Lens Correction: Custom tab | Filter > Lens Correction > Custom: Remove Distortion, Chromatic Aberration (R/C, G/M, B/Y), Vignette Amount / Midpoint, Vertical / Horizontal Perspective, Angle, Scale | Done | All present (lens-correction.js, engine /home/user/claude/pigment/src/shared/pixels/lens.js) |  |  |
| Noise: Add Noise, Despeckle, Dust & Scratches, Median | Filter > Noise | Done | add-noise (Uniform/Gaussian, Monochromatic), despeckle, dust-scratches, median |  |  |
| Other: High Pass, HSB/HSL | Filter > Other | Done | high-pass (Radius), hsb-hsl (input and row order) |  |  |
| Pixelate: Color Halftone, Crystallize, Facet, Fragment, Mezzotint, Mosaic, Pointillize | Filter > Pixelate | Done | All seven kinds with Photoshop's options (Mezzotint's ten types, four screen angles for Color Halftone) |  |  |
| Render: Clouds, Difference Clouds, Fibers | Filter > Render | Done | clouds / difference-clouds (with a dialog for scale, colours and seed, a superset) and fibers (Variance, Strength) |  |  |
| Sharpen: Sharpen, Sharpen Edges, Sharpen More, Unsharp Mask | Filter > Sharpen | Done | sharpen (with an Amount dialog), sharpen-edges, sharpen-more, unsharp-mask (Amount, Radius, Threshold) |  |  |
| Stylize: Diffuse, Emboss, Extrude, Find Edges, Solarize, Tiles, Trace Contour, Wind | Filter > Stylize | Done | All eight with Photoshop's options (Diffuse's four modes, Extrude Blocks/Pyramids, Wind/Blast/Stagger); Tiles takes its colours from the dialog |  |  |
| Video: De-Interlace, NTSC Colors | Filter > Video | Done | de-interlace (Odd/Even, Duplication/Interpolation), ntsc-colors |  |  |
| Lens Correction: Preview, Show Grid, grid Size and Color | Lens Correction bottom bar | Done | Present in lens-correction.js |  |  |

## select

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Quick Mask Options | Double-click the Quick Mask button: Color Indicates Masked / Selected Areas, Color, Opacity; Alt-click toggles | Missing | Overlay is fixed red at 50 % showing masked areas; no options dialog, and the quick mask does not appear as a temporary channel in the Channels panel | S | 0.6 · select-menu-finish |
| Color Range inside an existing selection | Select > Color Range with an active selection (limits to it; Shift adds) | Missing | The result always replaces the selection and is computed over the whole composite | S | 0.6 · select-menu-finish |
| Color Range: Localized Color Clusters and Range | Select > Color Range: Localized Color Clusters checkbox, Range slider | Missing | Not present: no spatial weighting around sample points | M | 0.6 · select-menu-finish |
| Color Range: Out of Gamut | Select > Color Range: Select = Out of Gamut | Missing | Not present; the gamut test of applyProof() in /home/user/claude/pigment/src/shared/pixels/color.js could feed it | S | 0.6 · select-menu-finish |
| Color Range: Skin Tones and Detect Faces | Select > Color Range: Select = Skin Tones, Detect Faces checkbox | Missing | Not present. Skin-tone range is classical colour work; Detect Faces needs a face detector (an open-source model would be the substitute for Adobe's) | M | 0.9 · local-models-segmentation |
| Focus Area: Add / Subtract focus brushes, Hand, Zoom | Select > Focus Area dialog tools | Missing | No brushes or dialog tools (admitted in ARCHITECTURE.md) | M | 0.6 · select-menu-finish |
| Modify: Apply effect at canvas bounds | Select > Modify > Border / Smooth / Expand / Contract / Feather dialogs: checkbox | Missing | The five dialogs are a single number prompt (modify() in edit-ops.js); the engine always behaves as 'do not apply at canvas bounds' (edge pixels replicated) | S | 0.6 · select-menu-finish |
| Select and Mask: High Quality Preview / Real-time Refinement | Select and Mask Properties: View Mode checkboxes | Missing | No such options; refinement always runs at full size in a worker (no reduced preview) | S | 0.6 · selection-tools-depth |
| Select and Mask: Refine Hair | Select and Mask options bar: Refine Hair | Missing | Not present; would be an automatic Refine Edge pass over detected hair regions (heuristic, or an open-source matting model) | M | 0.9 · local-models-segmentation |
| Color Range: Sampled Colors with eyedropper, add and subtract eyedroppers | Select > Color Range: Select = Sampled Colors, eyedropper tools, click on image or preview | Partial | colorRange() in edit-ops.js is a form dialog: one colour swatch labelled 'Foreground color'. No clicking the image or preview, no +/- eyedroppers or Shift/Alt sampling, although selection-ops.js colorRange() already accepts several colours | M | 0.6 · select-menu-finish |
| Color Range: Highlights / Midtones / Shadows | Select > Color Range: Select menu tonal presets with Fuzziness and Range | Partial | Fixed luminance thresholds in rangeMask(); the Fuzziness slider has no effect and there is no Range slider for these | S | 0.6 · select-menu-finish |
| Color Range: Selection Preview modes and Selection/Image toggle | Select > Color Range: Selection Preview (None, Grayscale, Black Matte, White Matte, Quick Mask); Selection / Image radio | Partial | Only a greyscale mask preview inside the dialog; nothing is previewed on the canvas, no matte or quick-mask previews, no Image view | S | 0.6 · select-menu-finish |
| Focus Area: View modes | Select > Focus Area: View (Marching Ants, Overlay, On Black, On White, Black & White, On Layers, Reveal Layer) | Partial | FOCUS_VIEWS: Overlay, On Black, On White, Black & White, Onion Skin, None. Missing Marching Ants, On Layers, Reveal Layer | S | 0.6 · select-menu-finish |
| Load Selection | Select > Load Selection: Document, Channel (incl. layer transparency and masks), Invert, Operation | Partial | select:load offers the document's saved channels, Invert and New/Add/Subtract/Intersect. No source Document menu (other open documents of the same size) and no layer transparency / layer mask entries in the list | S | 0.6 · channels-depth |
| Save Selection | Select > Save Selection: Document (incl. New), Channel (New or existing), Name, Operation (Replace/Add/Subtract/Intersect) | Partial | select:save only asks for a channel name and always creates a new alpha channel in the current document. No destination document, no saving into an existing channel with an operation, no save as layer mask | S | 0.6 · channels-depth |
| Select and Mask: tool options | Select and Mask options bar: add/subtract, size, brush picker (hardness, spacing, angle, roundness), Sample All Layers, Object mode | Partial | Add/subtract, Size, Hardness (Brush only), Rectangle/Lasso mode, Sample All Layers. No brush picker with spacing, angle, roundness or pen-pressure size | S | 0.6 · selection-tools-depth |
| Color Range: Reds / Yellows / Greens / Cyans / Blues / Magentas | Select > Color Range: Select menu colour presets | Approximate | rangeMask() in edit-ops.js measures distance to the pure primary (#ff0000 etc.) with the Fuzziness slider; Photoshop selects by hue dominance with no fuzziness. Results differ visibly on desaturated colours | S | 0.6 · select-menu-finish |
| Focus Area: parameters and output | Select > Focus Area: In-Focus Range, Auto, Image Noise Level, Soften Edge, Output To, Select and Mask... | Approximate | /home/user/claude/pigment/src/renderer/lib/select-mask.js focusArea() with all those controls; the engine is local Laplacian energy plus graph cut (/home/user/claude/pigment/src/shared/pixels/segment.js), not Adobe's algorithm | S |  |
| Select and Mask: Refine Mode (Color Aware / Object Aware) | Select and Mask Properties: Refine Mode | Approximate | Both modes exist (segment control 'mode'); both are guided-filter matting variants in /home/user/claude/pigment/src/shared/pixels/matte.js, not Adobe's algorithms. Hair on busy backgrounds will be cruder | M | 0.9 · local-models-segmentation |
| Select and Mask: Select Subject button | Select and Mask options bar: Select Subject | Approximate | Button present (workspace.js selectSubject), same heuristic engine as Select > Subject | S | 0.9 · local-models-segmentation |
| Select and Mask on a layer mask | Properties panel / Select > Select and Mask with a mask targeted | Done | With no selection on a layer that has a mask the workspace refines that mask (select-mask.js) |  |  |
| Select All | Select > All (Ctrl+A) | Done | select:all in /home/user/claude/pigment/src/renderer/lib/edit-ops.js |  |  |
| Color Range: Fuzziness | Select > Color Range: Fuzziness slider | Done | Fuzziness 0..200 with Photoshop-like falloff (/home/user/claude/pigment/src/shared/pixels/selection-ops.js colorRange) |  |  |
| Color Range: Invert | Select > Color Range: Invert | Done | Invert checkbox in colorRange() (edit-ops.js) |  |  |
| Deselect | Select > Deselect (Ctrl+D) | Done | select:none in edit-ops.js |  |  |
| Edit in Quick Mask Mode | Select > Edit in Quick Mask Mode (Q) | Done | toggleQuickMask() in edit-ops.js: red rubylith overlay painted with any paint tool |  |  |
| Grow | Select > Grow | Done | select:grow uses the Magic Wand tolerance (selection-ops.js grow) |  |  |
| Inverse | Select > Inverse (Shift+Ctrl+I) | Done | select:inverse in edit-ops.js |  |  |
| Modify > Border | Select > Modify > Border (Width) | Done | select:border, ring of expand/contract (selection-ops.js border); prompt for width |  |  |
| Modify > Contract | Select > Modify > Contract | Done | select:contract (disc erosion) |  |  |
| Modify > Expand | Select > Modify > Expand | Done | select:expand (disc dilation) |  |  |
| Modify > Feather | Select > Modify > Feather (Shift+F6) | Done | select:feather, Shift+F6 |  |  |
| Modify > Smooth | Select > Modify > Smooth (Sample Radius) | Done | select:smooth (selection-ops.js smooth) |  |  |
| Reselect | Select > Reselect (Shift+Ctrl+D) | Done | select:reselect restores doc.savedSelection (edit-ops.js) |  |  |
| Similar | Select > Similar | Done | select:similar uses the Magic Wand tolerance (selection-ops.js similar) |  |  |
| Transform Selection | Select > Transform Selection | Done | select:transform starts Free Transform with selectionOnly (/home/user/claude/pigment/src/renderer/lib/image-ops.js) |  |  |
| Select and Mask: Edge Detection Radius and Smart Radius | Select and Mask Properties: Edge Detection | Done | Radius 0..250 px and Smart Radius (matte.js edgeBand / smartFactor) |  |  |
| Select and Mask: Decontaminate Colors with Amount | Select and Mask Properties: Output Settings | Done | decontaminate + amount (matte.js decontaminate) |  |  |
| Select and Mask: Output To | Select and Mask Properties: Output To (Selection, Layer Mask, New Layer, New Layer with Layer Mask, New Document, New Document with Layer Mask) | Done | OUTPUTS in /home/user/claude/pigment/src/renderer/lib/select-mask/output.js, all six |  |  |
| Select and Mask: Global Refinements | Select and Mask Properties: Smooth, Feather, Contrast, Shift Edge, Clear Selection, Invert | Done | All four sliders plus Clear Selection, Invert and Reset in workspace.js |  |  |
| Select and Mask: View modes | Select and Mask Properties: View (Onion Skin, Marching Ants, Overlay, On Black, On White, Black & White, On Layers), F cycles, X disables | Done | VIEW_MODES and VIEW_KEYS in /home/user/claude/pigment/src/renderer/lib/select-mask/preview.js |  |  |
| Select and Mask: Show Edge, Show Original, Transparency/Opacity, overlay Color, Indicates | Select and Mask Properties: View Mode section | Done | All present in the workspace form (workspace.js lines 1106-1113) |  |  |
| Select and Mask: tools | Select and Mask workspace toolbar: Quick Selection, Refine Edge Brush, Brush, Object Selection, Lasso, Polygonal Lasso, Hand, Zoom | Done | SUB_TOOLS in /home/user/claude/pigment/src/renderer/lib/select-mask/workspace.js, same shortcuts (W, R, B, L, H, Z) |  |  |

## camera-raw

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Camera Raw: Calibration | Camera Raw > Edit > Calibration (Process, Shadows Tint, Red/Green/Blue Primary Hue and Saturation) | Missing | Not present | M | 0.5 · camera-raw-panels |
| Camera Raw: Color Grading | Camera Raw > Edit > Color Grading (Shadows / Midtones / Highlights / Global wheels, Blending, Balance) | Missing | Not present (no split toning either) | M | 0.5 · camera-raw-panels |
| Camera Raw: Color Mixer 'Color' view, Targeted Adjustment tool, Point Color | Camera Raw > Edit > Color Mixer | Missing | Not present | M | 0.5 · camera-raw-panels |
| Camera Raw: Curve | Camera Raw > Edit > Curve (Parametric, Point, Red/Green/Blue channels, Targeted Adjustment) | Missing | No curve tab | M | 0.5 · camera-raw-panels |
| Camera Raw: Geometry | Camera Raw > Edit > Geometry: Upright (Auto, Level, Vertical, Full, Guided), Vertical, Horizontal, Rotate, Aspect, Scale, Offset X/Y, Constrain crop | Missing | Not present (Lens Correction has manual perspective, angle and scale only; there is no automatic Upright) | L | 0.5 · camera-raw-panels |
| Camera Raw: Optics (manual) | Camera Raw > Edit > Optics: Remove Chromatic Aberration, Distortion, Vignette, Defringe (purple / green amount and hue) | Missing | Not in the Camera Raw dialog; distortion, CA and vignette exist only in the separate Lens Correction filter; there is no Defringe anywhere | M | 0.5 · camera-raw-panels |
| Camera Raw: Masking (manual tools) | Camera Raw > Masking: Brush, Linear Gradient, Radial Gradient, Color Range, Luminance Range; add / subtract / intersect; local adjustment sliders | Missing | No local adjustments at all | XL | 0.7 · camera-raw-local |
| Camera Raw: Snapshots | Camera Raw > Snapshots | Missing | Not present | S | 0.5 · camera-raw-workspace |
| Camera Raw: histogram, clipping warnings, zoom / hand, colour sampler | Camera Raw dialog chrome | Missing | The dialog is a floating form over the canvas; no histogram, no shadow/highlight clipping overlay, no sampler | M | 0.5 · camera-raw-workspace |
| Camera Raw: Healing (Remove, Heal, Clone) and Red Eye | Camera Raw toolbar: Remove, Red Eye | Missing | Not in the dialog (the main editor has healing and red-eye tools in /home/user/claude/pigment/src/renderer/lib/tools/retouch.js) | M | 0.7 · camera-raw-local |
| Camera Raw: White balance | Camera Raw > Edit > Color: White balance menu (As Shot, Auto, Custom), eyedropper, Temperature, Tint | Partial | Temperature and Tint as relative -100..100 shifts. No White Balance tool (click a neutral), no Auto/As Shot menu | S | 0.5 · camera-raw-workspace |
| Camera Raw: Detail | Camera Raw > Edit > Detail: Sharpening (Amount, Radius, Detail, Masking), Noise Reduction (Luminance, Detail, Contrast), Color Noise Reduction (Color, Detail, Smoothness) | Partial | Sharpening Amount/Radius/Detail and Luminance / Color noise amounts only. Missing Masking, luminance Detail and Contrast, colour Detail and Smoothness | S | 0.5 · camera-raw-panels |
| Camera Raw: Effects vignette and grain | Camera Raw > Edit > Effects: Vignette (Style, Midpoint, Roundness, Feather, Highlights), Grain (Amount, Size, Roughness) | Partial | Vignette Amount and Grain Amount (+ seed) only | S | 0.5 · camera-raw-panels |
| Camera Raw: Auto and B&W buttons | Camera Raw > Edit header: Auto, B&W | Partial | Auto (autoTone from the histogram) and Reset exist; no B&W conversion toggle and no B&W Mixer | S | 0.5 · camera-raw-workspace |
| Camera Raw: Before / After views | Camera Raw bottom bar: cycle Before/After (Q), swap, copy settings | Partial | Only the Preview checkbox of pixelEditDialog (whole image on or off); no side-by-side or split views | S | 0.5 · camera-raw-workspace |
| Camera Raw: Texture, Clarity, Dehaze, Vibrance, Saturation | Camera Raw > Edit > Effects / Color | Approximate | Present with Pigment's own maths (ARCHITECTURE.md 'Camera Raw filter': texture as a mid-frequency boost, clarity as local contrast at about 1% of the long edge, a simple dehaze). Same controls, different look from Adobe's, most of all Dehaze. | M | 0.5 · camera-raw-panels |
| Camera Raw: Light (Exposure, Contrast, Highlights, Shadows, Whites, Blacks) | Filter > Camera Raw Filter > Edit > Light | Approximate | All six sliders exist (lib/develop-ui.js Basic tab) but shared/pixels/develop.js applies them as luminance-masked curves to 8-bit display-referred sRGB, not Adobe's process on scene-linear data: Exposure is not a true stop on linear light and highlight recovery cannot bring back clipped data. Results differ visibly from Camera Raw at strong settings. | L | 0.6 · raw-open-workflow |
| Camera Raw: Denoise (AI), Raw Details, Super Resolution | Camera Raw > Detail > Denoise; Enhance | Not feasible | Absent. Adobe models, and they apply to raw mosaics which Pigment does not open. Substitute: open-source denoise / super-resolution models on RGB |  |  |
| Camera Raw: Lens Blur | Camera Raw > Edit > Lens Blur (AI depth, bokeh shapes, focal range) | Not feasible | Absent. Adobe depth model. Substitute: open-source depth model feeding Pigment's Lens Blur |  |  |
| Camera Raw: Optics profile corrections | Camera Raw > Edit > Optics > Use profile corrections | Not feasible | Absent. Adobe lens profiles are licensed data. Substitute: the open Lensfun database, looked up from EXIF |  |  |
| Camera Raw: Profiles and profile browser | Camera Raw > Edit > Profile (Adobe Color, Monochrome, Artistic, Vintage...) | Not feasible | Absent. Adobe's profiles are licensed data. Substitute: a profile slot that loads user-supplied .cube LUTs (Pigment already reads LUT files in /home/user/claude/pigment/src/shared/pixels/lut.js) and Pigment's own looks |  |  |
| Camera Raw: Masking (AI: Subject, Sky, Background, Objects, People, Depth Range) | Camera Raw > Masking | Not feasible | Absent. Adobe models. Substitute: Pigment's heuristic Subject/Sky masks or open-source segmentation and depth models, labelled as such |  |  |
| Camera Raw: Color Mixer HSL | Camera Raw > Edit > Color Mixer > Mixer (Hue, Saturation, Luminance for 8 ranges) | Done | HSL tab with Hue / Saturation / Luminance for reds..magentas |  |  |
| Camera Raw as a smart filter | Filter > Camera Raw Filter on a smart object | Done | registerKind('camera-raw') in develop-ui.js; re-editable |  |  |

## liquify

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Liquify as a smart filter | Filter > Liquify on a smart object | Missing | filter:liquify is a plain pixel edit outside the filter registry, so it is never taken over as a smart filter and Last Filter does not repeat it | M | 0.7 · liquify-depth |
| Liquify: Smooth tool | Filter > Liquify toolbar (E) | Missing | Not present | S | 0.7 · liquify-depth |
| Liquify: Freeze Mask / Thaw Mask tools and Mask Options | Filter > Liquify toolbar (F, D); Mask Options (Replace/Add/Subtract/Intersect/Invert from Selection, Transparency, Layer Mask; None, Mask All, Invert All) | Missing | No freeze mask at all | M | 0.7 · liquify-depth |
| Liquify: Hand and Zoom | Filter > Liquify toolbar (H, Z), zoom menu | Missing | The stage shows the image at one fitted scale; no zoom or pan in the dialog | S | 0.7 · liquify-depth |
| Liquify: Push Left tool | Filter > Liquify toolbar (O) | Missing | Not present | S | 0.7 · liquify-depth |
| Liquify: Face tool and Face-Aware Liquify | Filter > Liquify: Face tool (A); Face-Aware Liquify (Eyes, Nose, Mouth, Face Shape sliders, Select Face) | Missing | Not present. Needs face landmarks: Adobe's detector is proprietary, an open-source landmark model (MediaPipe Face Mesh, Apache-2.0) is the honest substitute; the warps themselves are ordinary mesh edits | L | 0.10 · neural-filters-local |
| Liquify: Load Mesh, Load Last Mesh, Save Mesh | Filter > Liquify: Load Mesh Options | Missing | No buttons; the mesh is only serialised for action steps (/home/user/claude/pigment/src/renderer/lib/actions/mesh-data.js), so Pigment's own mesh file is a small step (.msh import would be extra) | S | 0.7 · liquify-depth |
| Liquify: View Options | Filter > Liquify: Show Guides, Show Face Overlay, Show Image, Show Mesh (size, colour), Show Mask (colour), Show Backdrop (Use, Mode, Opacity) | Missing | None of them; only the active layer is shown, without the other layers as backdrop | M | 0.7 · liquify-depth |
| Liquify: Forward Warp, Reconstruct, Twirl Clockwise, Pucker, Bloat | Filter > Liquify toolbar (W, R, C, S, B) | Partial | /home/user/claude/pigment/src/renderer/lib/liquify.js has the five tools; Alt with Twirl does not turn counter-clockwise (Alt only reconstructs in Forward Warp) | S | 0.7 · liquify-depth |
| Liquify: Brush Reconstruct Options | Filter > Liquify: Reconstruct... (amount), Restore All | Partial | Restore All and Undo stroke; no Reconstruct amount dialog | S | 0.7 · liquify-depth |
| Liquify: Brush Tool Options | Filter > Liquify: Size, Density, Pressure, Rate, Stylus Pressure, Pin Edges | Partial | Brush size and Brush pressure only | S | 0.7 · liquify-depth |

## guides

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Guide selection, colours and Edit Selected Guides | Click / Shift-click guides; View > Guides > Edit Selected Guides (orientation, position, colour) | Done | 0.4: click and Shift-click guides, a colour per guide, Edit Selected Guides | M | 0.4 · guides-snapping |
| Move and delete individual guides | Move tool: drag a guide, drag it back to the ruler to delete | Done | 0.4: the Move tool selects and drags guides, a drag out of the canvas deletes them, Delete clears the selected ones | S | 0.4 · guides-snapping |
| Clear Selected Guides / Clear Selected Artboard Guides / Clear Canvas Guides | View > Guides | Done | 0.4: all three in View › Guides (artboard guides wait for artboards) | S | 0.4 · guides-snapping |
| Lock Guides | View > Guides > Lock Guides (Alt+Ctrl+;) | Done | 0.4: View › Guides › Lock Guides (Alt+Ctrl+;) | S | 0.4 · guides-snapping |
| New Guide Layout | View > Guides > New Guide Layout (Columns, Rows, Gutter, Margin, Center Columns, presets, Target) | Done | 0.4: Columns, Rows, Gutter, Margin, Center Columns, presets | M | 0.4 · guides-snapping |
| New Guides From Shape | View > Guides > New Guides From Shape | Done | 0.4: View › Guides › New Guides From Shape | S | 0.4 · guides-snapping |
| Create guides by dragging from a ruler | Drag from a ruler; Alt switches orientation; Shift snaps to ruler ticks | Done | 0.4: Alt switches orientation, Shift snaps to ruler ticks, positions keep two decimals | S | 0.4 · guides-snapping |
| New Guide | View > Guides > New Guide (Orientation, Position with units, Color) | Done | 0.4: orientation, position with units from the ruler origin, colour | S | 0.4 · guides-snapping |
| Clear Guides | View > Guides > Clear Guides | Done | view:clear-guides (undoable) in /home/user/claude/pigment/src/renderer/app.js |  |  |

## smart-filters

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Smart filters: filter mask | Layers panel smart filter mask thumbnail; Layer > Smart Filter > Add / Delete / Disable Filter Mask | Missing | No smart filter mask (filters[].mask is always null; admitted in ARCHITECTURE.md). A selection active when the filter is added is ignored as a mask | M | 0.6 · smart-filters-depth |
| Smart filters: Blending Options per filter | Layers panel: double-click the sliders icon on a smart filter (Mode, Opacity) | Missing | Filter entries carry only kind, params, enabled; no blend mode or opacity per filter | M | 0.6 · smart-filters-depth |
| Smart filters: drag or Alt-drag between layers | Layers panel: drag a smart filter or the Smart Filters row to another smart object (move / copy) | Missing | Not present | S | 0.6 · smart-filters-depth |
| Smart filters: apply any filter non-destructively | Filter menu on a smart object | Partial | app.smartFilters.intercept turns registry filters, adjustments and Camera Raw into smart filters. Liquify cannot be a smart filter; Lens Blur loses its depth map; Displace maps and loaded Filter Gallery textures are not saved in .pigment | M | 0.6 · smart-filters-depth |
| Smart filters: reorder | Layers panel: drag a smart filter up or down | Partial | Context menu Move Up / Move Down only; no drag reordering | S | 0.6 · smart-filters-depth |
| Convert for Smart Filters | Filter > Convert for Smart Filters | Done | Runs layer:smart-convert (/home/user/claude/pigment/src/renderer/lib/smart-object.js) |  |  |
| Smart filters: enable / disable (one or all), edit, delete, clear | Layers panel smart filter rows; Layer > Smart Filter | Done | filterOp() in smart-object.js and the rows in /home/user/claude/pigment/src/renderer/lib/panels/layers.js (eye, double-click to edit, Delete, Clear Smart Filters, Enable/Disable) |  |  |

## color-management

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Proof Setup: Color Blindness (Protanopia-type, Deuteranopia-type) | View > Proof Setup | Missing | Not present; classical matrices, no profiles needed | S | 0.6 · soft-proofing |
| Proof Setup: Legacy Macintosh RGB, Internet Standard RGB (sRGB), Monitor RGB | View > Proof Setup | Missing | Not present | S | 0.6 · soft-proofing |
| Proof Setup: Working Cyan / Magenta / Yellow / Black Plate, Working CMY Plates | View > Proof Setup | Missing | Not present | M | 0.6 · soft-proofing |
| Proof Setup: Custom | View > Proof Setup > Custom (Device to Simulate, Preserve Numbers, Rendering Intent, Black Point Compensation, Simulate Paper Color / Black Ink, save/load) | Missing | No Proof Setup submenu and no ICC engine (README: everything is treated as sRGB). Buildable with an open-source CMM (Little CMS compiled to WebAssembly) and user-supplied ICC profiles | L | 0.6 · soft-proofing |
| Gamut Warning | View > Gamut Warning (Shift+Ctrl+Y); Preferences > Transparency & Gamut colour and opacity | Approximate | view:gamut greys pixels outside the same generic CMYK model; no warning colour or opacity preference, not tied to a proof profile | M | 0.6 · soft-proofing |
| Proof Colors | View > Proof Colors (Ctrl+Y) | Approximate | view:proof in /home/user/claude/pigment/src/renderer/lib/color-modes.js toggles the generic CMYK preview; menu label 'Proof Colors (CMYK)', no Ctrl+Y shortcut | M | 0.6 · soft-proofing |
| Proof Setup: Working CMYK | View > Proof Setup > Working CMYK | Approximate | The only proof is a fixed generic CMYK simulation (applyProof in /home/user/claude/pigment/src/shared/pixels/color.js), not a profile-based working space | L | 0.6 · soft-proofing |

## presets

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Camera Raw: Presets panel and settings load / save | Camera Raw > Presets; More menu: Load Settings, Save Settings, defaults | Missing | No presets, no saving or loading of settings (.xmp). Adobe's bundled presets cannot be shipped; Pigment's own and user .xmp reading can | M | 0.5 · camera-raw-workspace |
| Color Range: Load / Save settings (.axt) | Select > Color Range: Load..., Save... | Missing | Not present | S | 0.6 · select-menu-finish |
| Lens Correction: Settings menu | Lens Correction > Custom > Settings (Lens Default, Previous Correction, Custom, Default; Load / Save settings) | Partial | Previous and Reset buttons only; no saved settings files or Lens Default | S | 0.9 · lens-correction-profiles |
| Select and Mask: Preset menu and Remember Settings | Select and Mask Properties: Preset (Default, Load Preset, Save Preset), Remember Settings | Partial | View and tool preferences are remembered (settings.tools['select-mask']); no named refine presets, no Load/Save, no Remember Settings checkbox for the refinement values | S | 0.6 · selection-tools-depth |

## 3d

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| New 3D Extrusion | Select > New 3D Extrusion | Missing | No 3D at all (README). Adobe has discontinued Photoshop's 3D features, so this is the lowest priority; a faithful build is a 3D subsystem | XL | 0.11 · 3d-lite |
| Show > 3D overlays | View > Show > 3D Secondary View, Ground Plane, Lights, Selection, UV Overlay, Mesh Bounding Box | Missing | No 3D (discontinued by Adobe) | XL | 0.11 · 3d-lite |

## ai

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Neural Filters workspace | Filter > Neural Filters (filter list, download manager, preview, Output: Current Layer / New Layer / Masked / Smart Filter) | Missing | No command and no menu item (README lists it as missing). The shell (panel, output options, model download manager) is buildable; the individual filters depend on models, see below | L | 0.10 · neural-filters-local |
| Neural Filters: Color Transfer | Filter > Neural Filters > Color | Missing | Absent, but buildable without a model: Reinhard-style Lab statistics transfer from a reference image with luminance/colour strength and hue/saturation/brightness sliders (Match Color engine is the base) | M | 0.10 · neural-filters-local |
| Select Sky | Select > Sky | Approximate | select:sky uses a colour/position/smoothness prior plus GrabCut (segment.js selectSky); same limit and same substitute as Select Subject | L | 0.9 · local-models-segmentation |
| Select Subject | Select > Subject (Device / Cloud processing) | Approximate | select:subject runs saliency plus GrabCut locally (segment.js selectSubject); README admits it is a heuristic that picks the wrong region in busy scenes. Adobe's trained model cannot be shipped; the honest upgrade is an open-source segmentation model (U2-Net / ISNet / SAM in ONNX) run offline | L | 0.9 · local-models-segmentation |
| Neural Filters: Colorize | Filter > Neural Filters > Color | Not feasible | Absent. Proprietary model. Substitute: an open-source colourisation model (DDColor / DeOldify, ONNX) the user downloads, or a provider request |  |  |
| Neural Filters: Harmonization | Filter > Neural Filters > Color | Not feasible | Absent. Proprietary model. Substitute: classical statistics matching of the layer to a reference layer (Match Color already exists in /home/user/claude/pigment/src/shared/pixels/adjust-more.js) presented honestly as Match to Layer |  |  |
| Neural Filters: Style Transfer | Filter > Neural Filters > Creative | Not feasible | Absent. Adobe's styles and model are proprietary. Substitute: an open-source arbitrary style-transfer model (AdaIN-type, ONNX) with user-supplied style images |  |  |
| Neural Filters: Landscape Mixer | Filter > Neural Filters > Creative (cloud) | Not feasible | Absent. Adobe cloud model. Substitute: provider image-edit with a reference image through the user's key |  |  |
| Neural Filters: Depth Blur | Filter > Neural Filters > Photography | Not feasible | Absent. Proprietary depth model. Substitute: an open-source monocular depth model (MiDaS / Depth Anything, ONNX) feeding the existing Lens Blur depth map input |  |  |
| Neural Filters: Super Zoom | Filter > Neural Filters > Photography | Not feasible | Absent. Proprietary model. Substitute: an open-source super-resolution model (Real-ESRGAN, ONNX) |  |  |
| Neural Filters: Makeup Transfer | Filter > Neural Filters > Portraits | Not feasible | Absent. Proprietary model. Substitute: an open-source makeup-transfer model the user downloads, or a provider image-edit prompt with a reference image |  |  |
| Neural Filters: Skin Smoothing | Filter > Neural Filters > Portraits | Not feasible | Absent. Adobe's model is proprietary. Substitute: face detection with an open-source model plus classical frequency-separation smoothing inside the face mask |  |  |
| Neural Filters: Smart Portrait | Filter > Neural Filters > Portraits (cloud) | Not feasible | Absent. Runs on Adobe's cloud GAN. Substitute: an image-edit request through the user's own OpenAI/Gemini key (the AI menu already has that plumbing), clearly labelled as generative |  |  |
| Neural Filters: JPEG Artifacts Removal | Filter > Neural Filters > Restoration | Not feasible | Absent. Proprietary model. Substitute: classical deblocking (which Reduce Noise's missing 'Remove JPEG Artifact' option also needs) or an open-source model such as FBCNN |  |  |
| Neural Filters: Photo Restoration | Filter > Neural Filters > Restoration | Not feasible | Absent. Proprietary model. Substitute: open-source face/photo restoration models (GFPGAN / CodeFormer, check their licences) plus classical scratch inpainting |  |  |

## artboards

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Fit Artboard on Screen | View > Fit Artboard on Screen | Missing | No artboards (README) | S | 0.9 · artboards-frames |
| Show > Canvas Guides, Artboard Guides, Artboard Names | View > Show | Missing | No artboards, so no distinction between canvas and artboard guides | S | 0.9 · artboards-frames |

## layers

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Find Layers (Layers panel filter bar) | Select > Find Layers (Alt+Shift+Ctrl+F); Layers panel filter row | Partial | 0.4: the filter bar with the Selected type and the Not locked, Vector mask and Advanced blending attributes; no Smart Object or Artboard filter | S | 0.4 · layers-panel-depth |
| Isolate Layers | Select > Isolate Layers | Done | 0.4: the samplers and the Move tool see only the isolated layers | S | 0.4 · layers-panel-depth |
| All Layers | Select > All Layers (Alt+Ctrl+A) | Done | layer:select-all in /home/user/claude/pigment/src/renderer/lib/layer-ops.js; no Alt+Ctrl+A accelerator in keymap.js |  |  |
| Deselect Layers | Select > Deselect Layers | Done | select:deselect-layers in /home/user/claude/pigment/src/renderer/lib/layers-extras/structure.js |  |  |

## prefs

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Guides, Grid & Slices preferences | Preferences > Guides, Grid & Slices (guide colour and style, grid colour, style, Gridline Every, Subdivisions) | Done | 0.4: guide colour and style, Smart Guides colour, grid colour, style, Gridline Every and Subdivisions; the slice settings wait for slices | S | 0.4 · guides-snapping |
| Overscroll | Preferences > Tools > Overscroll | Partial | Panning past the document edge always works (clampPan keeps a 40 px sliver on screen) but there is no Overscroll preference to turn it off; the string does not occur in the source. The file-edit auditor's 'missing' for the preference and the view auditor's 'done' for the behaviour are both right in part. | S | 0.6 · view-navigation |

## panels

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Navigator panel | Window > Navigator: proxy view, zoom slider, buttons, zoom field; Ctrl-drag to zoom to an area; Panel Options (view box colour) | Partial | /home/user/claude/pigment/src/renderer/lib/panels/navigator.js has the thumbnail with draggable view box, slider, buttons, field, Fit / 100 % / Fill; no Ctrl-drag region zoom, no panel options | S | 0.6 · view-navigation |

## scripting

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Third-party plug-in filters (8BF) | Filter menu plug-in entries; Plugins | Missing | No plug-in host. Hosting Photoshop-SDK filter plug-ins needs a native module per platform and Adobe's SDK terms; Pigment's own script/plug-in interface is the realistic substitute | XL | 0.9 · plugin-api |

## slices

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Lock Slices, Clear Slices | View > Lock Slices, View > Clear Slices | Missing | No slices (README) | S | 0.10 · slices-web-export |

## workspace

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Screen Mode | View > Screen Mode (Standard, Full Screen Mode With Menu Bar, Full Screen Mode), F cycles | Partial | Only the OS full-screen toggle (view:fullscreen, F11) and Show/Hide Panels (Tab). No three-mode cycle, no chrome-free black-surround mode, no F key | S | 0.7 · screen-modes-extras |
