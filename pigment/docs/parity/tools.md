# Parity: Tools and the brush engine

Part of [Pigment and Photoshop: feature parity](../PARITY.md), as of Pigment 0.4 (November 2026). The rows planned for 0.4 ("0.4 · *package*") show their 0.4 status and the counts below include them; the other rows and the overview paragraph describe Pigment 0.3.1 as the audit found it.

Pigment has almost every Photoshop toolbox slot (65 registered tools across move, marquee, lasso, wand, crop, eyedropper, heal, brush, clone, history, eraser, fill, blur, dodge, pen, type, path-select, shape, hand, zoom), but most tools carry only their core options, and the painting engine behind them is a single round-dab stamper (src/renderer/lib/brush.js, 319 lines). The largest gap is the brush engine: no sampled/bristle/erodible/airbrush tips, no Shape Dynamics, Scattering, Texture, Dual Brush, Color Dynamics, Transfer, Brush Pose, Wet Edges or Build-up, no tilt/rotation input, no symmetry, no Shift-click straight lines, no Behind/Clear modes, no .abr, and the Mixer Brush and Art History Brush are absent. The second gap is presets and colour UI: there is no Gradient Editor at all (every gradient UI edits two colours), no Gradients, Patterns, Shapes, Styles or Tool Presets panels, one in-memory pattern slot, 8 hard-coded custom shapes, no .aco/.ase/.grd/.pat/.csh/.asl import or export, a Color panel with only the Hue Cube view, and a colour picker without web/gamut warnings, model radio buttons, libraries or screen sampling. Whole tools missing: Artboard, Slice and Slice Select, Frame, Note, Count, Remove, Content-Aware Move, Curvature Pen, Triangle, Type Mask tools, Adjustment Brush, plus the Clone Source panel, Contextual Task Bar, Edit Toolbar, smart guides and canvas right-click menus (no tool implements onContextMenu). Several present tools run on simpler algorithms a user would notice (Magnetic Lasso snaps points instead of tracing edges, Quick Selection is a windowed flood fill, Object Selection is GrabCut, healing is low-frequency colour transfer rather than Poisson blending, Red Eye has no pupil detection). Honest not-feasible items are the Object Finder and Remove tool models (substitute: a downloadable open-source segmentation or inpainting model), Pantone and other licensed colour books, and Adobe's bundled brush and preset libraries (substitute: user-supplied files).

58 missing · 54 partial · 10 approximate · 4 not feasible · 49 done · 175 entries

## brush-engine

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Shift-click straight lines and Shift-drag axis constraint | All painting tools | Missing | StrokeTool and DabTool never read p.shift and keep no last-stroke end point. | S | 0.5 · brush-painting-behaviours |
| On-canvas brush resize HUD | Alt+right-drag (Win) / Ctrl+Option-drag (Mac): size, hardness or opacity with a red preview | Missing | No drag gesture for size/hardness. | M | 0.5 · brush-painting-behaviours |
| Pen tilt, barrel rotation and stylus wheel input | Brush Settings control menus; tablet input | Missing | canvas-view.js passes pressure, tiltX and tiltY to tools, but BrushStroke.local() keeps pressure only; twist and tangential pressure are never read. | M | 0.5 · brush-engine-core |
| Color Dynamics | Brush Settings: Apply Per Tip, Foreground/Background Jitter, Hue / Saturation / Brightness Jitter, Purity | Missing | Not implemented; the dab colour is fixed for the stroke. | M | 0.5 · brush-engine-core |
| Transfer | Brush Settings: Opacity Jitter, Flow Jitter, Wetness Jitter, Mix Jitter and controls | Missing | Only the 'pressure -> opacity' toggle, which scales flow per dab. | M | 0.5 · brush-engine-core |
| Scattering | Brush Settings: Scatter, Both Axes, Count, Count Jitter and controls | Missing | Not implemented. | M | 0.5 · brush-engine-core |
| Brush Pose | Brush Settings: Tilt X, Tilt Y, Rotation, Pressure and overrides | Missing | Not implemented. | S | 0.5 · brush-settings-panel |
| Noise, Wet Edges, Build-up, Smoothing, Protect Texture | Brush Settings: checkbox options | Missing | None of the five exists in BrushStroke. | M | 0.5 · brush-settings-panel |
| Texture | Brush Settings: pattern, Scale, Brightness, Contrast, Texture Each Tip, Mode, Depth, Minimum Depth, Depth Jitter | Missing | Not implemented (no pattern library to draw from either). | M | 0.5 · brush-settings-panel |
| Dual Brush | Brush Settings: second tip, Mode, Size, Spacing, Scatter, Count | Missing | Not implemented. | M | 0.5 · brush-settings-panel |
| Shape Dynamics | Brush Settings: size / angle / roundness jitter, minimum diameter, tilt scale, Flip X/Y jitter, Brush Projection, Control menus (Fade, Pen Pressure, Pen Tilt, Stylus Wheel, Rotation, Direction, Initial Direction) | Missing | Only the fixed 'pressure -> size' toggle (BrushStroke.effectiveSize). No jitter, no Fade or direction control. | M | 0.5 · brush-engine-core |
| Airbrush tips | Brush Tip Shape: Hardness, Distortion, Granularity, Spatter Size, Spatter Amount | Missing | Not implemented. | M | 0.10 · brush-tips-mixer |
| Erodible tips | Brush Tip Shape: Softness, Shape, Sharpen Tip | Missing | Not implemented. | M | 0.10 · brush-tips-mixer |
| Bristle tips | Brush Tip Shape: bristle shapes, Bristles, Length, Thickness, Stiffness, Angle; Live Tip Brush Preview | Missing | Not implemented. | L | 0.10 · brush-tips-mixer |
| Sampled (image) brush tips and Define Brush Preset | Edit > Define Brush Preset; Brush Tip Shape tip list | Missing | dabCanvas() only builds round dabs; there is no bitmap tip and no Define Brush Preset command. | M | 0.5 · brush-engine-core |
| Symmetry painting | Options bar butterfly menu: Vertical, Horizontal, Dual Axis, Diagonal, Wavy, Circle, Spiral, Parallel Lines, Radial, Mandala; transformable symmetry path | Missing | No symmetry code (README lists the brush engine gaps but not this one). | L | 0.10 · brush-tips-mixer |
| Airbrush build-up | Options bar: Enable airbrush-style build-up; Brush Settings: Build-up | Missing | No time-based dabs: a stationary pointer deposits one dab. The 'Airbrush' presets in panels/brushes.js are only low-flow round tips. | S | 0.5 · brush-engine-core |
| Number keys set opacity; Shift+number sets flow | Painting tools: 1-0, Shift+1-0 | Missing | keymap.js has no digit bindings. | S | 0.5 · brush-painting-behaviours |
| Mixer Brush tool | Toolbar: Brush group; Wet, Load, Mix, Flow, presets (Dry ... Very Wet Heavy Mix), load / clean after each stroke, current load swatch, Sample All Layers | Missing | Not implemented (README: missing). Needs a per-dab reservoir/pickup model and ideally bristle tips. | L | 0.10 · brush-tips-mixer |
| Retouch tools share the brush engine (presets, dynamics, spacing) | Blur, Sharpen, Smudge, Dodge, Burn, Sponge, Healing, Color Replacement, Background Eraser brush pickers | Partial | These are DabTool subclasses with their own round mask (R.dabMask), fixed spacing and only size and hardness; the Brushes panel notes 'This tool uses size and hardness only'. No angle, roundness, spacing or presets for them. | M | 0.7 · retouch-tools-depth |
| Painting blend modes | Brush / Pencil / stamp / fill options bar: Mode | Partial | All 26 layer modes (Canvas blend or per-pixel blendImages). Missing the painting-only modes Behind and Clear, and Dissolve is filtered out (BLEND_OPTIONS). Clone Stamp, Pattern Stamp, History Brush and Eraser have no Mode menu at all. | M | 0.5 · brush-engine-core |
| Brush Tip Shape: size, angle, roundness, hardness, spacing, Flip X / Flip Y | Brush Settings panel: Brush Tip Shape | Partial | lib/panels/brushes.js sliders for size, hardness, spacing, angle, roundness (plus flow, opacity). Spacing is one global value (settings.brush.spacing), not per tool. No Flip X / Flip Y, no angle/roundness dial, no spacing on/off. | S | 0.5 · brush-settings-panel |
| Alt temporarily samples a colour while painting | Brush, Pencil, Color Replacement, Paint Bucket, Gradient, shapes + Alt | Partial | Brush and Pencil only (Alt-click calls eyedropper.sampleAt). Paint Bucket uses Alt for the background colour instead; other tools do nothing. | S | 0.5 · brush-painting-behaviours |
| Brush angle and roundness quick control | Options bar: brush angle; Brush preset picker angle/roundness widget | Partial | Angle and roundness are sliders in the Brushes panel only (tool options fed through installTipHook); no draggable ellipse widget, no arrow-key rotation. | S | 0.5 · brush-settings-panel |
| Brush tool: size, hardness, opacity, flow | Toolbar: Brush (B); options bar | Partial | Size stops at 1,000 px (lib/tools.js BRUSH_OPTIONS and lib/panels/brushes.js SIZE_MAX; the Pencil at 500 px) where Photoshop allows 5,000 px. Hardness, opacity and flow are complete. | S | 0.5 · brush-engine-core |
| Painting in 16 and 32 bits per channel | All painting and retouch tools in 16/32-bit documents | Approximate | Strokes are composited on the 8-bit canvas and lib/depth.js rebuilds the deep data of touched pixels from it (documented in README). Gradients and soft brushes band in 16-bit documents. | L | 0.9 · deep-pipeline |
| Dab rendering model | Brush engine | Approximate | Dabs are cached Canvas radial-gradient sprites (size rounded up to whole pixels, smoothstep falloff, 8-bit) drawn with drawImage; angle/roundness by canvas transform. Photoshop computes each tip analytically at sub-pixel size. Differences show as slightly different soft-edge falloff and stepping in very small soft brushes. | M | 0.5 · brush-engine-core |
| Pressure toggles: pressure for size, pressure for opacity | Options bar buttons | Approximate | Checkboxes 'Pen pressure -> size' and 'Pressure -> opacity'. The opacity one scales per-dab flow (BrushStroke.dab), not stroke opacity, so overlapping dabs still build to full opacity. No override of the Brush Settings controls because those do not exist. | S | 0.5 · brush-engine-core |
| Smoothing and smoothing options | Options bar: Smoothing 0-100% and gear (Pulled String Mode, Stroke Catch-up, Catch-up on Stroke End, Adjust for Zoom) | Approximate | One slider 0-0.95 driving an exponential moving average of the pointer (BrushStroke.extend); the stroke always jumps to the release point (a fixed catch-up on stroke end). None of the four modes; no leash line. | M | 0.5 · brush-engine-core |
| Brush stroke preview | Brush Settings / Brushes panel preview | Done | panels/brushes.js drawStroke paints an S curve with the current tip, spacing, flow and opacity. |  |  |
| Painting on layer masks and in Quick Mask; selection clipping; lock transparency | Painting tools | Done | StrokeTool.strokeTarget switches to the mask; BrushStroke 'mask' mode paints the grey value; the selection clips in flush(); locked transparency keeps alpha. |  |  |
| [ and ] size, Shift+[ and ] hardness | Painting tools | Done | tool:brush-size-up/down and hardness (app.js adjustBrush; graded size steps, 25% hardness steps). |  |  |
| Pencil tool with Auto Erase | Toolbar: Brush group; options bar | Done | PencilTool: aliased whole-pixel dabs, size, opacity, mode, Auto erase (starts in the background colour when the first pixel is the foreground colour). |  |  |

## retouch

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Patch tool: Content-Aware mode (Structure, Color, Sample All Layers) | Patch options bar: Patch: Content-Aware | Missing | Only the Normal heal is implemented. | M | 0.8 · retouch-healing |
| Spot Healing Brush: Create Texture, Mode, pressure toggle | Spot Healing options bar | Missing | No Create Texture type, no Mode menu (Replace, Multiply, Screen, Darken, Lighten, Color, Luminosity), no pressure-for-size button. | S | 0.8 · retouch-healing |
| Content-Aware Move tool (Move / Extend, Structure, Color, Transform On Drop) | Toolbar: Healing group | Missing | No tool; the inpainter in content-aware.js could back it. | M | 0.8 · retouch-healing |
| Art History Brush tool | Toolbar: History Brush group; Style (Tight Short ... Loose Curl), Area, Tolerance | Missing | Not implemented (README: missing). | M | 0.7 · retouch-tools-depth |
| Clone Source panel | Window > Clone Source: five sources, X/Y offset, W/H scale, rotate, flip, Show Overlay (opacity, Clipped, Auto Hide, Invert, blend) | Missing | No panel; one source point per tool instance, no scale/rotate/flip. | M | 0.7 · retouch-tools-depth |
| Smudge tool | Toolbar: Blur group; Mode, Strength, Sample All Layers, Finger Painting | Partial | SmudgeTool: size, hardness, strength, Finger painting. Missing Mode and Sample All Layers. | S | 0.7 · retouch-tools-depth |
| Sharpen tool with Protect Detail | Toolbar: Blur group; Mode, Strength, Sample All Layers, Protect Detail | Partial | SharpenTool: size, hardness, strength (R.sharpenDab). Missing Protect Detail, Mode and Sample All Layers. | S | 0.7 · retouch-tools-depth |
| Blur tool | Toolbar: Blur group; brush picker, Mode, Strength, Sample All Layers, pressure | Partial | BlurTool: size, hardness, strength (R.blurDab). Missing Mode (Darken, Lighten, Hue, Saturation, Color, Luminosity), Sample All Layers and brush presets; works on pixels only (refuses masks). | S | 0.7 · retouch-tools-depth |
| Color Replacement tool | Toolbar: Brush group; Mode, Sampling (Continuous / Once / Background Swatch), Limits, Tolerance, Anti-alias | Partial | ColorReplaceTool: Mode (Color, Hue, Saturation, Luminosity), Sampling Continuous / Once, Tolerance. Missing Sampling: Background Swatch, Limits (Discontiguous / Contiguous / Find Edges), Anti-alias. | S | 0.7 · retouch-tools-depth |
| Clone Stamp tool | Toolbar: Clone Stamp (S); Mode, Opacity, Flow, Aligned, Sample (Current Layer / Current & Below / All Layers), ignore adjustment layers | Partial | CloneStampTool: Alt-click source, Aligned, Sample all layers (on/off), brush options. Missing Mode, 'Current & Below', ignore-adjustments toggle, sampling from another document, and the overlay preview inside the cursor (only a crosshair marks the source). | M | 0.7 · retouch-tools-depth |
| Pattern Stamp tool | Toolbar: Clone Stamp group; pattern picker, Aligned, Impressionist | Partial | PatternStampTool paints the single current pattern (Edit > Define Pattern) with Aligned. No pattern picker, no Impressionist, no Mode. | M | 0.7 · retouch-tools-depth |
| Dodge and Burn tools | Toolbar: Dodge group (O); Range, Exposure, airbrush, Protect Tones | Partial | DodgeTool / BurnTool: Range (shadows, midtones, highlights), Exposure, Alt swaps between them. Missing Protect Tones and the airbrush toggle. | S | 0.7 · retouch-tools-depth |
| Sponge tool | Toolbar: Dodge group; Mode Saturate / Desaturate, Flow, airbrush, Vibrance | Partial | SpongeTool: mode and flow. Missing Vibrance (clipping protection) and the airbrush toggle. | S | 0.7 · retouch-tools-depth |
| Eraser tool | Toolbar: Eraser (E); Mode Brush / Pencil / Block, Opacity, Flow, Smoothing, Erase to History | Partial | EraserTool: three modes, erases to transparency or to the background colour on a transparency-locked layer. 'Erase to original' uses the saved state only (same limit as the History Brush); Block is 16 document pixels rather than a fixed screen size. | S | 0.7 · retouch-tools-depth |
| Background Eraser tool | Toolbar: Eraser group; Sampling, Limits, Tolerance, Protect Foreground Color | Partial | BackgroundEraserTool: Sampling Continuous / Once / Background swatch, Tolerance, Protect foreground colour. Missing Limits (Discontiguous / Contiguous / Find Edges): it always erases every matching pixel under the dab. | S | 0.7 · retouch-tools-depth |
| Patch tool: Normal mode (Source / Destination) | Toolbar: Healing group; options bar | Partial | PatchTool: lasso or existing selection, drag to patch, Source/Destination. Only a dashed box follows the drag (no live preview). Missing Transparent, Use Pattern, Diffusion and the selection combine buttons. | M | 0.8 · retouch-healing |
| Healing Brush | Toolbar: Healing group; options: Mode, Source (Sampled / Pattern), Aligned, Use Legacy, Sample, Diffusion | Partial | HealingBrushTool: Alt-click source, Aligned, Sample all layers (on/off), size, hardness. R.heal moves each pixel toward source texture plus the destination's local mean colour (low-frequency transfer), not Poisson blending: seams show on strong gradients. Missing Mode, Source: Pattern, Sample 'Current & Below', ignore-adjustment-layers, Diffusion, Clone Source panel offsets. | M | 0.8 · retouch-healing |
| History Brush tool | Toolbar: History Brush (Y); source chosen in the History panel | Partial | HistoryBrushTool paints from history.savedSnapshot() only (the image as opened or last saved) and refuses when the canvas size changed. The History panel has snapshots but no 'set source for the history brush' column, so no arbitrary state can be the source. No Mode menu. | M | 0.7 · retouch-tools-depth |
| Spot Healing Brush: Proximity Match | Spot Healing options bar: Type | Approximate | Per dab: 8 candidate patches on a ring are scored by border colour and variance, the best is healed in (R.heal). Coarser than Photoshop's; visible on patterned areas. | M | 0.8 · retouch-healing |
| Red Eye tool | Toolbar: Healing group; Pupil Size, Darken Amount | Approximate | RedEyeTool: click (60 px box) or drag a box; pixels whose red exceeds green/blue inside a centred circle are desaturated and darkened. No pupil detection, so a click must be centred and the fixed 60 px area misses large or small eyes. | S | 0.8 · retouch-healing |
| Spot Healing Brush: Content-Aware | Toolbar: Spot Healing (J); Type: Content-Aware | Approximate | lib/tools/retouch.js SpotHealingTool collects the stroke as a mask and runs app.contentAwareFill (src/shared/pixels/inpaint.js) on release; Sample All Layers present. Result appears after the stroke, and quality depends on the local patch inpainter rather than Adobe's PatchMatch. | M | 0.8 · retouch-healing |
| Magic Eraser tool | Toolbar: Eraser group; Tolerance, Anti-alias, Contiguous, Sample All Layers, Opacity | Done | MagicEraserTool with all five options. |  |  |

## vector

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Live corner radii | On-canvas corner widgets on rectangles, triangles and polygons; Properties: per-corner radii with link toggle | Done | 0.4: corner widgets on rectangles, triangles and polygons with the shape and path selection tools, per-corner radii with a link in Properties; no corner widgets with the Move tool's transform controls | M | 0.4 · shapes-live |
| Path alignment and path arrangement | Options bar: Path alignment (align / distribute components, Align To), Path arrangement (Bring Shape To Front ...) | Missing | No commands to align, distribute or reorder subpaths. | M | 0.7 · pen-paths |
| Pen tool modifiers: Ctrl for Direct Selection, Space to reposition an anchor while dragging | Pen tool + Ctrl/Cmd, + Space | Missing | PenTool handles Shift and Alt only; Ctrl does nothing and Space starts panning. | S | 0.7 · pen-paths |
| Curvature Pen tool | Toolbar: Pen group | Missing | Not implemented. | M | 0.7 · pen-paths |
| Content-Aware Tracing tool | Toolbar: Pen group (technology preview) | Missing | Not implemented; could reuse the Magnetic Lasso edge map once it traces edges. | M | 0.7 · pen-paths |
| Triangle tool | Toolbar: Shape group | Done | 0.4: Triangle tool in the Shape group, live, with corner radius | S | 0.4 · shapes-live |
| Path operations | Options bar: New Layer, Combine, Subtract Front, Intersect, Exclude Overlapping, Merge Shape Components | Partial | All six for shape layers (PATH_OP_OPTION, path:op, path:merge-components; lib/path-ops.js). The menu is shown only in Shape mode, so components of a work path or saved path cannot be given an operation from the options bar. | S | 0.7 · pen-paths |
| Make: Selection / Mask / Shape buttons | Pen and Path Selection options bar in Path mode | Partial | 0.4: Mask and Shape buttons on the Path Selection and Direct Selection tools; not on the Pen tool's Path mode | M | 0.4 · masks-vector-masks |
| Pen options: Rubber Band, Auto Add/Delete, path overlay colour and thickness | Pen options bar and gear menu | Partial | Auto add/delete checkbox present. The rubber-band preview segment is always on (no toggle). No path colour / thickness setting. | S | 0.7 · pen-paths |
| Shape geometry options | Shape gear menu: Unconstrained, Square/Circle, Fixed Size, Proportional, From Center; Space repositions while drawing | Done | 0.4: Unconstrained, Square / Circle, Fixed Size, Proportional, From Center; Space repositions while drawing | S | 0.4 · shapes-live |
| Shape fill: none, solid, gradient, pattern | Shape options bar: Fill popup; Properties | Done | 0.4: Fill swatch with none, solid, gradient and pattern, also in Properties | M | 0.4 · shapes-live |
| Shape stroke: caps, corners (joins), dashed lines and presets, gradient / pattern strokes | Stroke Options popup and More Options dialog | Done | 0.4: Stroke Options with alignment, caps, joins, dashes and presets, gradient and pattern strokes; no "Align dashes to corners and path ends" | M | 0.4 · shapes-live |
| Path Selection tool | Toolbar: Path Selection (A); options: Select Active Layers / All Layers, fill, stroke, W/H, path ops, alignment, arrangement, Align Edges, Constrain Path Dragging | Partial | PathSelectionTool: click or Shift-click subpaths, drag to move, Alt-drag duplicates, arrows nudge, Delete removes; live shapes stay parametric when all subpaths move. Options bar has only Selection / Fill / Stroke buttons: no Select: Active Layers / All Layers, no W/H/X/Y, no fill/stroke fields, no marquee selection of several paths. | M | 0.7 · pen-paths |
| Direct Selection tool | Toolbar: Path Selection group; Constrain Path Dragging | Partial | DirectSelectionTool: click or marquee anchors, Shift adds, drag anchors, handles (Alt breaks symmetry) and curve segments. No Constrain Path Dragging switch, no Select: All Layers. | S | 0.7 · pen-paths |
| Freeform Pen tool and Magnetic option | Toolbar: Pen group; Curve Fit, Magnetic (Width, Contrast, Frequency, pen pressure) | Partial | FreeformPenTool with Curve fit (simplify and smooth on release, closes near the start). The Magnetic option is missing. | M | 0.7 · pen-paths |
| Polygon tool: sides, star ratio, smooth corners | Toolbar: Shape group; Sides, gear: Star Ratio, Smooth Star Indents, corner radius | Done | 0.4: sides, Star Ratio, Smooth Star Indents, corner radius | S | 0.4 · shapes-live |
| Line tool: weight and arrowheads | Toolbar: Shape group; Weight / stroke, gear: Arrowheads Start / End, Width, Length, Concavity | Done | 0.4: weight and arrowheads (start, end, width, length, concavity) in the gear menu | S | 0.4 · shapes-live |
| Pen and shape tool mode: Shape / Path / Pixels | Options bar tool mode menu | Done | Pen: Shape, Path. Shape tools: Shape, Path, Pixels (with Anti-alias). Pixels mode has no Mode / Opacity fields. |  |  |
| Align Edges | Shape options bar | Done | 'Align edges' checkbox rounds the box to whole pixels (ShapeTool.box). |  |  |
| Shape stroke: colour, width, alignment | Shape options bar: Stroke, width, Stroke Options: Align | Done | STYLE_OPTIONS: stroke on/off, colour, width 0.5-288 px, Inside / Center / Outside; changing them restyles the selected shape layer. |  |  |
| Pen tool | Toolbar: Pen (P) | Done | lib/tools/vector.js PenTool: click corners, drag smooth points, close on the first point, Shift 45 degrees, Alt breaks handles, Backspace removes the last anchor, undo steps back one anchor, Enter/Esc finish. |  |  |
| Add Anchor Point, Delete Anchor Point, Convert Point tools | Toolbar: Pen group | Done | AddAnchorTool, DeleteAnchorTool, ConvertPointTool (click to corner, drag out handles, drag a handle independently, Shift 45 degrees). |  |  |
| Rectangle tool | Toolbar: Shape (U) | Done | ShapeTool 'rect' (plus the legacy Rounded Rectangle tool 'rrect' with a Radius field); Shift square, Alt from centre, click for a size dialog. |  |  |
| Ellipse tool | Toolbar: Shape group | Done | ShapeTool 'ellipse'. |  |  |

## presets

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Brush file import and export (.abr) | Brushes panel menu: Import Brushes, Export Selected Brushes | Missing | No .abr reader or writer (README: missing). Needs the sampled-tip engine first; presets could meanwhile be exported in Pigment's own JSON. | M | 0.5 · brush-settings-panel |
| Preset management | Edit > Presets: Preset Manager, Export / Import Presets, Migrate Presets | Missing | No preset manager; brush presets and swatches live in the settings file only. | M | 0.5 · preset-files-manager |
| Swatch files: .aco / .ase import and export, legacy swatches | Swatches panel menu: Import Swatches, Export Selected Swatches, Export Swatches for Exchange, Legacy Swatches | Missing | No swatch file support (only .act colour tables in the Indexed Color dialog, src/shared/pixels/quantize.js). | M | 0.5 · preset-files-manager |
| Gradients panel | Window > Gradients: groups, new gradient, import / export .grd, legacy gradients, drag onto layers | Partial | 0.4: Window › Gradients with groups, new gradient and dragging onto layers; Import / Export use .pigment-presets files, not .grd (0.5) | M | 0.4 · gradients |
| Patterns panel and pattern picker | Window > Patterns: groups, import / export .pat, legacy patterns; pattern pickers in Fill, Pattern Stamp, Paint Bucket, Pattern Overlay, brush Texture | Partial | 0.4: Window › Patterns with groups, and the pattern picker in Fill, Pattern Stamp, Paint Bucket, Pattern Overlay and Bitmap; no .pat files (0.5); brush Texture waits for the brush engine | M | 0.4 · patterns |
| Shapes panel | Window > Shapes: groups, import / export .csh, legacy shapes, drag onto canvas | Missing | No panel; shapes are the 8 constants in tools/vector.js. | M | 0.5 · presets-panels |
| Styles panel | Window > Styles: layer style presets, groups, import / export .asl, legacy styles | Missing | No style presets (only Copy / Paste / Clear Layer Style). | M | 0.5 · presets-panels |
| Tool Presets | Window > Tool Presets; options bar preset picker; Current Tool Only; New / load / save .tpl | Missing | No tool presets. Options persist per tool in settings.tools, which is the only saved state. | M | 0.5 · presets-panels |
| Paint Bucket tool | Toolbar: Gradient group; Fill Foreground / Pattern, Mode, Opacity, Tolerance, Anti-alias, Contiguous, All Layers | Done | 0.4: Foreground or Pattern (the picker), tiles anchored to the document origin, Mode, Opacity, Tolerance, Anti-alias, Contiguous, All Layers | S | 0.4 · patterns |
| Custom Shape tool and shape picker | Toolbar: Shape group; Shape picker with groups; Edit > Define Custom Shape | Partial | A dropdown of 8 built-in shapes (CUSTOM_SHAPES: heart, arrow, star, check, speech bubble, plus, bolt, drop). No thumbnails, no groups, no Define Custom Shape, no user shapes. | M | 0.5 · presets-panels |
| Brushes panel: presets, groups, search, preset options | Window > Brushes: folders, drag to reorder, search, size slider, recent brushes, New Brush with 'Include Tool Settings' and 'Include Color', view options | Partial | A flat grid of 16 built-in round presets plus user presets (save, rename, delete; stored in settings.brushPresets with size, hardness, spacing, angle, roundness, flow). No groups, reorder, search, recent row, or tool/colour capture. | M | 0.5 · brush-settings-panel |
| Adobe's bundled and downloadable brush libraries | Brushes panel: General / Dry Media / Wet Media / Special Effects, Legacy Brushes, Get More Brushes (Kyle T. Webster packs) | Not feasible | Adobe's brush sets are licensed content and the extra packs come from Adobe's servers. Substitute: Pigment's own presets and user-supplied .abr files once import exists. |  |  |

## color-ui

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| HUD colour picker | Alt+Shift+right-click (Win) / Ctrl+Option+Cmd-click (Mac); Hue Strip or Hue Wheel, sizes in Preferences | Missing | No HUD picker. | M | 0.5 · color-picker-swatches |
| Color Picker: Only Web Colors | Color Picker checkbox | Missing | Not present. | S | 0.5 · color-picker-swatches |
| HDR Color Picker (32-bit) | Color Picker in 32-bit documents: Intensity, stops | Missing | The same 8-bit picker is used at every depth. | M | 0.10 · hdr-32bit |
| Color Picker: sample from the image or anywhere on screen while open | Color Picker open + click in the document / drag outside | Missing | The dialog is modal over the canvas and has no sampling; the browser EyeDropper API is not used. | S | 0.5 · color-picker-swatches |
| Color Picker: out-of-gamut and not-web-safe warnings | Color Picker warning triangle and cube (click to snap) | Missing | Not present in the dialog (View > Gamut Warning exists for the canvas only). | S | 0.5 · color-picker-swatches |
| Eyedropper: sample anywhere on screen; Copy Color as Hex / HTML | Drag the Eyedropper out of the window; right-click menu | Missing | Sampling stops at the canvas; no use of the EyeDropper API or desktop capture; no copy-colour commands. | S | 0.5 · color-picker-swatches |
| Color Picker dialog: field, hue strip, HSB / RGB / Lab / CMYK / hex fields, new / current | Click the foreground or background swatch | Partial | lib/extras.js pickColor with createColorWidget: SB square, hue strip, HSB, RGB, hex, Lab and CMYK fields, new/current swatches, recent colours and swatches row. No radio buttons to change the field's axis (S, B, R, G, B, L, a, b). CMYK is a profile-less formula (differs from Photoshop's SWOP numbers). | M | 0.5 · color-picker-swatches |
| Eyedropper: Sample layers | Eyedropper options bar: Current Layer, Current & Below, All Layers, All Layers no Adjustments, Current & Below no Adjustments | Partial | Only 'All layers' and 'Current layer'. | S | 0.5 · color-picker-swatches |
| Eyedropper: Sample Size | Eyedropper options bar: Point, 3x3, 5x5, 11x11, 31x31, 51x51, 101x101 | Partial | lib/tools/nav.js EyedropperTool: Point, 3x3, 5x5, 11x11, 31x31. 51x51 and 101x101 missing. | S | 0.5 · color-picker-swatches |
| Color Picker: Color Libraries | Color Picker > Color Libraries (PANTONE, TOYO, HKS, DIC, ANPA, FOCOLTONE, TRUMATCH) | Not feasible | Absent. The books are licensed data (Adobe itself dropped most Pantone books). Substitute: let the user load their own .acb / .ase / .aco libraries and ship only freely licensed sets. |  |  |
| Color Picker: Add to Swatches | Color Picker button | Done | 'Add to Swatches' button appends to settings.swatches and refreshes the panel. |  |  |
| Eyedropper: sampling ring, Alt-click for background, drag to sample | Eyedropper tool | Done | Ring with new/previous colour (showRing option), Alt sets background, status bar shows hex and RGB. |  |  |
| Foreground / background colours, Swap (X), Default (D) | Toolbar colour controls | Done | ToolManager.renderToolbox swatches; tool:swap-colors, tool:default-colors, tool:pick-fg/bg. |  |  |

## select

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Move the selection outline (drag inside with a selection tool, arrow keys nudge) | Any selection tool: drag inside selection; arrow keys 1 px / Shift 10 px | Missing | Pointer down inside a selection starts a new marquee; selection tools have no onKeyDown for arrows. Only Select > Transform Selection moves the outline. | S | 0.6 · selection-tools-depth |
| Magic Wand: Sample Size | Magic Wand options bar: Sample Size (Point, 3x3 ... 101x101) | Missing | The wand always samples the single clicked pixel; it does not read the Eyedropper's sample size either. | S | 0.6 · selection-tools-depth |
| Marquee: Space repositions the marquee while dragging | Marquee / shape tools + Space during drag | Missing | Space always switches to the temporary hand (shortcuts.js sets view.spaceHeld); a drag in progress is not moved. | S | 0.6 · selection-tools-depth |
| Selection tools: Select and Mask / Select Subject buttons in the options bar | Options bar of marquee, lasso, wand, quick and object selection | Missing | The commands exist (select:select-mask, select:subject) but none of the selection tools' option lists has the buttons. | S | 0.6 · selection-tools-depth |
| Marquee Style: Normal / Fixed Ratio / Fixed Size | Marquee options bar: Style, Width, Height, swap button | Partial | All three styles with W/H fields. No swap W/H button, and Fixed Size takes pixels only (no in/cm/% units). | S | 0.6 · selection-tools-depth |
| Quick Mask button and Quick Mask Options | Toolbar: Edit in Quick Mask Mode (Q); double-click for Masked / Selected Areas, colour, opacity | Partial | Button and Q toggle select:quick-mask (edit-ops.js): a hidden grey layer with a fixed 50% red overlay on the unselected area. No options dialog (colour, opacity, selected-areas mode); the mask is not undoable. | S | 0.6 · select-menu-finish |
| Lasso tool | Toolbar: Lasso (L) | Partial | LassoTool 'free': freehand outline closed on release. Holding Alt to switch to straight segments mid-drag is missing. | S | 0.6 · selection-tools-depth |
| Polygonal Lasso tool | Toolbar: Lasso group | Partial | Click points, close on first point or double-click, Backspace removes the last point, Enter commits, Esc cancels. Missing: Shift constrains to 45 degrees, Alt-drag for freehand segments. | S | 0.6 · selection-tools-depth |
| Magnetic Lasso tool (Width, Contrast, Frequency, pen pressure) | Toolbar: Lasso group; options bar | Approximate | LassoTool 'magnetic': each point (dropped every few pixels by Frequency) snaps to the strongest gradient inside the Width radius above the Contrast threshold; points are joined by straight lines. Photoshop traces the edge between fastening points (live-wire). A user sees a rougher outline on curved edges. No pen-pressure width toggle, no [ ] width keys. | M | 0.6 · selection-tools-depth |
| Object Selection tool: Rectangle / Lasso mode, Sample All Layers, Object Subtract, Hard Edge | Toolbar: Object Selection (W); options bar | Approximate | lib/tools/object-select.js: region goes to a GrabCut in the segmentation worker (src/shared/pixels/segment.js). All four options present. Photoshop uses a trained model; on busy backgrounds Pigment's cut is visibly less reliable. | M | 0.9 · local-models-segmentation |
| Quick Selection tool | Toolbar: Quick Selection (W); options bar: brush picker, Sample All Layers, Enhance Edge | Approximate | WandTool 'quick': tolerance flood fill from five seeds inside a window of three brush radii, plus the disc under the brush; Alt subtracts. Not Photoshop's edge-aware region growing, so it leaks or stops by tolerance rather than at object edges. Size only (no hardness/spacing/angle picker), no Enhance Edge; shows Tolerance and Contiguous options Photoshop does not have. | M | 0.6 · selection-tools-depth |
| Selection tools: Feather and Anti-alias | Marquee / Lasso options bar | Done | feather 0-250 px and anti-alias on marquee and lasso tools (Selection.feather, fromEllipse/fromPolygon antialias). |  |  |
| Selection tools: New / Add / Subtract / Intersect | Options bar buttons; Shift, Alt, Shift+Alt | Done | COMBINE_OPTION segment plus combineMode() modifiers on marquee, lasso, wand, quick selection and object selection. |  |  |
| Magic Wand: Tolerance, Anti-alias, Contiguous, Sample All Layers | Toolbar: Magic Wand (W); options bar | Done | WandTool 'wand' through selectionOps.floodFill. |  |  |
| Single Row and Single Column Marquee | Toolbar: Marquee group | Done | MarqueeTool shape 'row' / 'column': 1 px row or column at the click. |  |  |
| Rectangular and Elliptical Marquee | Toolbar: Marquee tools (M) | Done | lib/tools/select.js MarqueeTool: Shift = square/circle, Alt = from centre, modifier latching when a selection exists, size readout. |  |  |

## view

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Move tool: drag, reposition and delete existing guides | Move tool over a guide; Alt-click toggles orientation | Done | 0.4: select, drag and delete guides (drag out of the canvas, or Delete); Alt-click to toggle a guide's orientation is not there | S | 0.4 · guides-snapping |
| Count tool | Toolbar: Eyedropper group (count groups, colour, marker and label size) | Missing | No count tool. | M | 0.9 · notes-count-measurement |
| Smart guides and measurement guides | View > Show > Smart Guides; Ctrl/Cmd-hover distances, equal-spacing hints, Alt-drag distance | Done | 0.4: alignment lines, equal-spacing hints and Ctrl-hover distances with the Move tool; not while drawing paths, and no angle readouts | M | 0.4 · guides-snapping |
| Rotate View tool | Rotate View tool (R): drag, Shift for 15 degrees, Rotation Angle field, Reset View, Rotate All Windows | Partial | lib/tools/nav.js RotateViewTool: drag, Shift snaps to 15 degrees, Angle field and Reset view. No compass overlay while dragging and no Rotate All Windows (there is one view per document). R is shared with the Hand slot as the panels auditor notes. | S | 0.6 · view-navigation |
| Ruler tool: measurement readouts | Toolbar: Eyedropper group; options bar X, Y, W, H, A, L1, L2; Info panel | Partial | RulerTool shows length, angle, dX, dY only in the status bar while dragging. No options-bar fields, nothing in the Info panel, line endpoints cannot be dragged afterwards, no Shift 45 degree constraint, no protractor (Alt-drag a second line), no Use Measurement Scale. | M | 0.9 · notes-count-measurement |
| Hand tool | Toolbar: Hand (H); Scroll All Windows, 100%, Fit Screen, Fill Screen; Space; flick panning; hold H for bird's-eye view | Partial | lib/tools/nav.js HandTool: drag to pan, Space from any tool, middle-button pan, double-click fits, three buttons. No Scroll All Windows, no flick panning, no bird's-eye view. | S | 0.6 · view-navigation |
| Zoom tool | Toolbar: Zoom (Z); Zoom In/Out, Resize Windows to Fit, Zoom All Windows, Scrubby Zoom, 100%, Fit Screen, Fill Screen; Ctrl+Space / Alt+Space | Partial | ZoomTool: click, Alt-click, Scrubby zoom, marquee zoom when scrubby is off, Fit and 100% buttons. Missing Resize Windows to Fit and Zoom All Windows (one tabbed window), the Fill Screen button, Ctrl+Space / Alt+Space temporary zoom, animated press-and-hold zoom. | S | 0.6 · view-navigation |
| Snapping (guides, grid, layers, document bounds, artboards, slices) | View > Snap, View > Snap To; all drawing tools | Done | 0.4: guides, grid, layers and document bounds for every placing tool, nearest target first; artboards and slices wait for those features | M | 0.4 · guides-snapping |
| Ruler tool: Straighten Layer and Clear | Ruler options bar | Done | Buttons run image:rotate with layerOnly and clear the line. |  |  |

## workspace

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Canvas right-click context menus for tools | Right-click on canvas with Move (layers under cursor), selection tools (Deselect, Feather, Layer Via Copy, Fill, Stroke, Make Work Path...), painting tools (brush picker), type, pen, shape | Missing | canvas-view.js forwards button 2 to tool.onContextMenu but no tool implements it; the browser menu is just suppressed. | M | 0.8 · context-menus-task-bar |
| Reset Tool / Reset All Tools | Right-click the tool icon in the options bar | Missing | Only Preferences > Reset All Settings, which also resets preferences, swatches and layout. | S | 0.5 · presets-panels |
| Edit Toolbar (customise the toolbar) | Toolbar '...' > Edit Toolbar; Extra Tools; save / load toolbar presets | Missing | Slot order is hard-coded (SLOT_ORDER in lib/tools.js); no customisation, no two-column layout. | M | 0.9 · workspaces-toolbar |
| Contextual Task Bar | Window > Contextual Task Bar: floating bar with next actions per tool and selection | Missing | No floating task bar. Toolbar.setSecondary() can show a contextual strip but nothing uses it for this. | M | 0.8 · context-menus-task-bar |
| Temporary tool switches by modifier | Ctrl/Cmd = Move tool from most tools; Alt = eyedropper in painting tools; Ctrl+Space zoom | Done | 0.4: Ctrl = Move, Alt = Eyedropper with painting tools, Ctrl+Space and Alt+Space zoom; tools that use Alt keep it | S | 0.4 · conventions-shortcuts-fields |
| Tool flyouts and shortcut cycling | Long-press / right-click a tool; letter keys; Shift+letter cycles; 'Use Shift Key for Tool Switch' preference; spring-loaded keys | Done | 0.4: long-press or right-click flyouts, Shift+letter cycling, the 'Use Shift key for tool switch' preference, spring-loaded keys | S | 0.4 · conventions-shortcuts-fields |
| Screen Mode button | Toolbar: Change Screen Mode (F): Standard, Full Screen With Menu Bar, Full Screen | Partial | No toolbar button and no F cycling. view:fullscreen (F11) is OS full screen and Tab hides the panels. | S | 0.7 · screen-modes-extras |

## layers

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Frame tool | Toolbar: Frame tool (K): rectangle / ellipse frames, place image into frame | Missing | No frame layer type or tool. | L | 0.9 · artboards-frames |
| Move tool: arrow-key nudging | Move tool + arrow keys (Shift = 10 px, Alt+arrow duplicates) | Partial | 1 px and Shift 10 px nudges (MoveTool.onKeyDown, one history entry each). Alt+arrow duplicate-and-nudge is missing; nudging selected pixels moves the whole layer instead of the selection content. | S | 0.5 · move-tool-depth |
| Move tool: Show Transform Controls | Move tool options bar | Partial | MoveTool.drawOverlay draws the bounding box and 8 handles, but they are not draggable (no hit testing); only double-click opens Free Transform. | M | 0.5 · move-tool-depth |
| Move tool: align buttons | Move tool options bar: Align left/centre/right/top/middle/bottom | Partial | Six align buttons run layer:align (layer-ops.js align(): to selection, to the union of selected layers, or to the canvas for one layer). No explicit 'Align To: Selection / Canvas' menu. | S | 0.5 · move-tool-depth |
| Move tool: Auto-Select (Layer / Group) | Move tool options bar: Auto-Select + Layer/Group menu | Partial | Checkbox 'Auto-select layer' and Ctrl/Cmd-click hit test (MoveTool.hitTest). No Group choice: always picks the leaf layer; marquee-drag on empty canvas to select several layers is missing. | S | 0.5 · move-tool-depth |
| Move tool: distribute buttons and distribute spacing | Move tool options bar: Distribute (6 edges/centres) + Distribute Spacing (H/V), '...' flyout | Partial | No distribute controls in the options bar. Layer > Distribute has only Horizontally / Vertically (layer:distribute); no per-edge variants and no distribute spacing. | S | 0.5 · move-tool-depth |
| Move tool: Alt-drag duplicate | Move tool + Alt | Done | MoveTool.duplicateLayers on p.alt; with a selection Alt duplicates the selected pixels (liftSelection keepOriginal). |  |  |
| Move tool: move selected pixels (floating selection) | Move tool with an active selection | Done | MoveTool.liftSelection cuts the pixels to a floating layer and commitFloating merges them back; the selection follows. |  |  |
| Move tool: drag layers, Shift constrains, moves multi-selection and linked layers | Toolbar: Move tool (V) | Done | lib/tools/move.js MoveTool; linked layers move together via app.linkedLayers; locked layers refused with a toast. |  |  |

## crop

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Crop: Content-Aware fill of new canvas area | Crop options bar: Fill (Background / Content-Aware Fill / Generative Expand) | Missing | No fill choice on the crop tool. The parts exist separately (content-aware.js contentAwareFill, AI > Generative Expand with the user's key) but are not wired into the crop commit. | M | 0.7 · image-size-crop |
| Crop: Straighten and rotating the crop box | Crop options bar: Straighten; drag outside the box to rotate | Missing | CropTool has no angle: no Straighten line and no rotation by dragging outside the box (the Ruler tool's Straighten Layer is the only route). | M | 0.7 · image-size-crop |
| Crop: shield and mode settings | Crop options bar gear: Use Classic Mode, Show Cropped Area, Auto Center Preview, Enable Crop Shield (colour, opacity, auto adjust) | Partial | Fixed 50% black shield drawn in CropTool.drawOverlay; none of the settings; the image never recentres under the box (always classic behaviour). | S | 0.7 · image-size-crop |
| Crop: overlay options | Crop options bar: overlay menu (Rule of Thirds, Grid, Diagonal, Triangle, Golden Ratio, Golden Spiral; Auto / Always / Never show; O cycles) | Partial | Rule of thirds, Grid, Golden ratio, None. Missing Diagonal, Triangle, Golden Spiral, the show modes and the O / Shift+O keys. | S | 0.7 · image-size-crop |
| Crop: ratio presets and size presets | Crop options bar: preset menu (Ratio, W x H x Resolution, Original Ratio, 1:1, 4:5, 5:7, 2:3, 16:9, New Crop Preset), swap, Clear | Partial | Free, 1:1, 4:3, 3:2, 16:9, Original ratio, Custom W:H. Missing: W x H x Resolution (resample on crop), 4:5 / 5:7 / 2:3, swap W/H button, Clear, saved crop presets. | S | 0.7 · image-size-crop |
| Crop: Delete Cropped Pixels | Crop options bar | Done | Checkbox 'Delete cropped pixels' passed to app.cropDocument. |  |  |
| Crop tool: box, handles, move, Enter / double-click commit, Esc cancel, Reset | Toolbar: Crop (C) | Done | lib/tools/move.js CropTool; size badge; commits through app.cropDocument. |  |  |
| Perspective Crop tool | Toolbar: Crop group; options bar W, H, Resolution, Front Image, Clear, Show Grid | Done | lib/tools/perspective-crop.js with all those options; rasterizes text and smart layers (documented). |  |  |

## gradients

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Gradient Editor (colour stops, opacity stops, midpoints, smoothness, New / Save / Import / Export) | Click the gradient preview: Gradient Editor dialog | Done | 0.4: colour and opacity stops, midpoints, smoothness, New, Save, Import, Export (.pigment-presets files; .grd in 0.5) | M | 0.4 · gradients |
| Noise gradients | Gradient Editor: Gradient Type Noise (roughness, colour model, restrict colours, add transparency, randomize) | Done | 0.4: roughness, colour model, restrict colours, add transparency, randomize | M | 0.4 · gradients |
| Gradient interpolation method | Gradient options bar / editor: Perceptual, Linear, Classic, Smooth, Stripes | Done | 0.4: Perceptual, Linear, Classic, Smooth and Stripes for every gradient; PSD keeps it on Gradient Maps (Stripes as Classic) | M | 0.4 · gradients |
| Live gradients (on-canvas gradient widget) | Gradient options bar: Gradient vs Classic gradient; on-canvas line with draggable colour stops and midpoints, creates an editable Gradient Fill layer | Partial | 0.4: the Gradient tool's Gradient mode makes an editable Gradient Fill layer with an on-canvas line; the widget edits colour stops and end points, not midpoints or opacity stops | M | 0.4 · gradients |
| Gradient picker and presets | Gradient options bar: preset picker with thumbnails and groups | Done | 0.4: picker with thumbnails and groups, presets kept across sessions | S | 0.4 · gradients |
| Gradient tool: Mode, Opacity, Reverse, Dither, Transparency | Gradient options bar | Done | All five options; dither is a 2x2 ordered +/-1.5 level pattern. |  |  |
| Gradient tool: Linear, Radial, Angle, Reflected, Diamond | Toolbar: Gradient (G); options bar | Done | lib/tools/fill.js GradientTool with document.js makeGradient (diamond rendered per pixel); Shift constrains to 45 degrees; works on masks. |  |  |

## panels

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Color panel: other views and sliders | Color panel menu: Brightness Cube, Color Wheel, Grayscale / RGB / HSB / CMYK / Lab / Web Color Sliders; spectrum ramp (RGB, CMYK, Grayscale, Current Colors); Copy Color as HTML / Hex; gamut warning | Missing | Only the Hue Cube view; numeric fields but no sliders; no panel menu, no ramp, no copy-colour commands, no gamut alert. | M | 0.5 · color-picker-swatches |
| Note tool and Notes panel | Toolbar: Eyedropper group; Window > Notes | Missing | No note annotations. | M | 0.9 · notes-count-measurement |
| Color Sampler tool | Toolbar: Eyedropper group; Info panel readouts; up to 10 samplers | Partial | ColorSamplerTool: up to 8 samplers (Photoshop: 10), drag to move, Alt-click to delete, Clear; values in the Info panel. No sample-size option, no per-sampler colour-mode menu; doc.samplers is not in the undo history. | S | 0.7 · info-histogram-properties |
| Swatches panel: use, add, rename, delete, recent colours | Window > Swatches | Partial | lib/panels/swatches.js: click = foreground, Alt/Ctrl-click = background, add from foreground, rename, delete, reset to 60 defaults, recent row. No groups, drag reorder, search, list view or thumbnail sizes; swatches hold RGB hex only (no Lab/CMYK/spot). | M | 0.5 · color-picker-swatches |
| Color panel: Hue Cube with fields | Window > Color | Done | lib/panels/color.js: SB square, hue strip, HSB / RGB / hex fields, foreground / background chips (double-click opens the picker), swap and default. |  |  |

## type-engine

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Horizontal and Vertical Type Mask tools | Toolbar: Type group | Missing | Only the two type tools are registered. | M | 0.5 · type-menu-commands |
| Type tool options bar | Orientation toggle, font, style, size, anti-aliasing, alignment, colour, Warp Text, panels toggle, cancel / commit | Partial | Family, style, size, three alignments, colour, Character panel button. Missing the orientation toggle, anti-aliasing method and Warp Text. | M | 0.5 · type-menu-commands |
| Horizontal and Vertical Type tools | Toolbar: Type (T) | Done | lib/tools/text.js TypeTool x2: point text, paragraph box by dragging, click to edit, Ctrl/Cmd+Enter commits, text on a path entry. |  |  |

## 3d

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| 3D Material Eyedropper and 3D Material Drop | Toolbar: Eyedropper and Gradient groups (legacy 3D) | Missing | No 3D in Pigment. Adobe has itself retired Photoshop's 3D features, so these belong with a 3D subsystem decision rather than the tools work. | XL | 0.11 · 3d-lite |

## adjustments

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Adjustment Brush tool | Toolbar: Brush group (current release): paint an adjustment through a new masked adjustment layer | Done | 0.4: in the Brush group; the first stroke adds a masked adjustment layer, later strokes paint its mask | M | 0.4 · adjust-color |

## artboards

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Artboard tool | Toolbar: Move group > Artboard tool (size presets, add-artboard plus buttons, orientation) | Missing | No artboard layer type or tool (README lists artboards as missing). | L | 0.9 · artboards-frames |

## prefs

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Brush cursor options | Preferences > Cursors: Standard / Precise / Normal Brush Tip / Full Size Brush Tip, crosshair in tip, precise while painting; Caps Lock toggles | Partial | Preference cursorStyle: outline, precise, dot. The outline is always a circle of the nominal size (ignores angle, roundness, hardness and pressure); no Caps Lock toggle, no crosshair-in-tip. | S | 0.5 · brush-painting-behaviours |

## slices

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Slice tool and Slice Select tool | Toolbar: Crop group | Missing | No slices anywhere (README: missing; Save for Web has no slices). | L | 0.10 · slices-web-export |

## ai

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Object Finder (hover preview, Show All Objects, overlay colour/opacity, refresh) | Object Selection options bar: Object Finder, gear menu | Not feasible | Absent. Adobe's object detector is a proprietary model. Honest substitute: an open-source segmentation model (e.g. Segment Anything in ONNX) that the user downloads, run locally in a worker to pre-compute object masks for hover; until then the tool needs a drag. |  |  |
| Remove tool | Toolbar: Healing group; Remove after each stroke, Sample All Layers, Find distractions (wires, people) | Not feasible | Absent. It runs Adobe's trained inpainting model (and Firefly for the generative mode). Closest honest substitutes: the same brush-then-fill gesture on Pigment's Content-Aware Fill (already what Spot Healing does), an open-source inpainting model (e.g. LaMa in ONNX) the user downloads, or Generative Fill through the user's OpenAI/Gemini key. |  |  |
