# Tools and their options

This page lists every tool in Adobe Illustrator's Advanced toolbar and Tools panel, together with the tool's options dialog (opened by double-clicking the tool), its on-canvas widgets and the modifier keys that change what it does. It also covers the toolbar itself: the Basic and Advanced toolbars, the Edit Toolbar drawer, custom toolbars, the fill and stroke widget, drawing modes, screen modes and tear-off tool groups. It is part of Nib's parity audit and is dated November 2026, measured against Illustrator 2026 (version 30.x) and the first notes on Illustrator 2027 (version 31.0, announced 10 November 2026). Nib has no code yet, so every row is Missing unless it depends on Adobe's servers or models (Not feasible). The page was written from knowledge of Illustrator plus checks against search-result snippets, because helpx.adobe.com is blocked from this container. "(v)" after a feature name means a search snippet confirmed it; "(?)" means it is not certain the feature exists in the current version. The type tools are only listed here and are covered in the Type area; the menu commands that tools share (Object > Transform, Pathfinder panel, Blend menu, Live Paint menu, Perspective Grid menu, Image Trace) are covered in their own areas, and only the tool side is here.

Status: **Missing** (no code yet) or **Not feasible** (needs Adobe's servers, licensed content or proprietary models; the plan names the substitute). Effort: S under a day, M a few days, L a week or more, XL a subsystem. Tier: core, next, later, n/a.

### Toolbar and tool infrastructure

| Feature | What Illustrator does (options that matter) | Nib plan | Status | Effort | Tier |
|---|---|---|---|---|---|
| Tool framework | Every tool has pointer down/move/up handlers, a cursor, an options object and an optional double-click dialog; tool use is undoable. | A tool registry of ES modules with `onPointer*`, `cursor`, `options` and `dialog`; each finished gesture commits one command to the command registry. | Missing | L | core |
| Advanced toolbar | Window > Toolbars > Advanced: every tool, arranged in groups; default since 2018 was Basic, Advanced restored by users. | Ship an Advanced toolbar definition (JSON) listing groups in Illustrator's order. | Missing | M | core |
| Basic toolbar | Window > Toolbars > Basic: a reduced set of tools; the rest live in the drawer. | A second toolbar definition with the reduced set. | Missing | S | next |
| Edit Toolbar drawer | The "..." button at the bottom opens All Tools; drag tools in and out of the toolbar; greyed tools are already present; Reset; Show/hide fill/stroke and drawing-mode controls. | A drawer panel listing all registered tools, drag to reorder or remove, persisted per toolbar in settings. | Missing | M | next |
| Custom toolbars | Window > Toolbars > New Toolbar / Manage Toolbar: named extra floating toolbars. | Named toolbar definitions stored in settings, each a floating panel. | Missing | M | later |
| Tool groups and flyouts | Tools share a slot; press and hold (or Alt-click) to show the flyout; Alt-click cycles through the group. | Group definitions with last-used tool remembered per slot; Alt-click cycles. | Missing | S | core |
| Tear-off tool groups | The arrow at the end of a flyout tears it off as a floating toolbar strip. | Flyout tear-off button that creates a temporary floating panel. | Missing | S | later |
| Single / double column toolbar | The double arrow at the top toggles one or two columns. | CSS layout toggle stored in settings. | Missing | S | next |
| Tool tips with shortcut | Hovering shows tool name and shortcut; rich tooltips with animation in recent versions. | Plain tooltip with name and shortcut; Approximate: no animated rich tooltips. | Missing | S | core |
| Single-key tool shortcuts | V, A, P, T, M, L, B, Shift+B, N, E, C, R, O, S, W, Shift+W, Shift+M, K, U, G, I, Shift+O, H, Z and more; Shift+key cycles within a group (preference). | Keymap entries per tool, editable in Keyboard Shortcuts, with Illustrator's defaults. | Missing | S | core |
| Spring-loaded tools | Holding a tool key temporarily switches to that tool and returns on release. | Key-down/key-up timing: a held key (over ~250 ms) reverts on release. | Missing | S | next |
| Temporary Selection tool (Ctrl/Cmd) | Holding Ctrl/Cmd switches to the last-used Selection or Direct Selection tool. | Modifier override in the tool dispatcher. | Missing | S | core |
| Temporary Hand tool (Space) | Space switches to Hand while held (not inside text editing). | Modifier override; suppressed while editing text. | Missing | S | core |
| Temporary Zoom (Ctrl/Cmd+Space, Ctrl/Cmd+Alt+Space) | Zoom in / out while held. | Modifier override. | Missing | S | core |
| Fill and stroke widget | Fill and Stroke squares, X to swap focus, Shift+X to swap colours, D for default (white fill, black 1 pt stroke), Color / Gradient / None buttons (< > /). | A toolbar widget bound to the current selection's or the default style's fill and stroke. | Missing | M | core |
| Double-click fill/stroke opens Color Picker | Double-clicking the fill or stroke square opens the Color Picker dialog. | Open Nib's Color Picker dialog (Color area). | Missing | S | core |
| Drawing modes: Draw Normal | New objects go on top of the current layer. | Default insertion index. | Missing | S | core |
| Drawing modes: Draw Behind | New objects go behind the selected object (or at the bottom of the layer). | Insertion index rule in the object creation command. | Missing | S | next |
| Drawing modes: Draw Inside | With one object selected, new art is drawn into an automatic clipping group using that object as the clip; Shift+D cycles modes; dashed corners mark the target. | Create or reuse a clip group whose clip path is the target; new objects become its children. | Missing | M | next |
| Screen modes | Normal, Full Screen with Menu Bar, Full Screen; F cycles; Presentation Mode (Shift+F) shows one artboard per screen. | Window chrome states plus Electron full screen; Presentation Mode as a separate view. | Missing | M | next |
| Presentation Mode | Shows artboards full screen, arrow keys step through them, Esc exits. | Full-screen viewer stepping through artboards. | Missing | S | later |
| Tool options in Control and Properties panels | The Control bar and Properties panel show options of the active tool (e.g. brush, stroke, shape properties). | A tool-options strip bound to the active tool's options object. | Missing | M | core |
| Contextual Task Bar (v) | A floating bar near the selection with next actions (e.g. for shapes: Gen Shape Fill, Edit Path, Fill, Stroke); pin, hide, reset position. | A floating bar with context-specific commands from the registry; Approximate: generative buttons call the user's own AI provider. | Missing | M | next |
| On-canvas tool widgets | Live corners, shape widgets (pie, polygon sides), bounding box, rotation handles. | Shared widget layer drawn in the overlay canvas. | Missing | L | core |
| Precise cursors (Caps Lock) | Caps Lock switches painting/drawing cursors to crosshairs. | Cursor swap on Caps Lock state. | Missing | S | next |
| Click-to-enter dimensions | Clicking (not dragging) with most shape and drawing tools opens a dialog with exact sizes. | Each shape tool supplies a dialog for click-without-drag. | Missing | S | core |
| Alt-drag from centre, Shift to constrain | Shape tools draw from the centre with Alt; Shift constrains to square/circle/45 degrees. | Shared modifier handling in a shape-tool base class. | Missing | S | core |
| Space to reposition while drawing | Holding Space while dragging a shape or marquee moves it instead of resizing. | Pointer-delta mode toggle on Space during a drag. | Missing | S | core |
| Tilde (~) multiples | Dragging with ~ held with shape and some tools draws many copies; with transform tools it transforms the pattern only. | Tool-specific handling of the backquote key; pattern-only transform flag. | Missing | S | later |
| Arrow keys while drawing | While dragging grids, stars, polygons, spirals and flares, arrows change counts (sides, points, rows, segments). | Tool-specific key handlers during a drag. | Missing | S | next |
| Touch workspace / touch shortcuts (?) | Touch workspace with touch shortcut widget on Windows touch devices. | Not planned beyond pointer events; Approximate: pen and touch go through Pointer Events. | Missing | M | later |
| Pressure and tilt input | Pressure, stylus wheel, tilt, bearing and rotation drive brush width, Blob Brush, Eraser. | Pointer Events `pressure`, `tiltX/Y`, `twist`; Approximate: no Wacom-specific API. | Missing | M | next |
| AI Assistant (beta) (v) | Illustrator 31.0 adds an AI Assistant that runs multi-step production tasks from prompts. | Not feasible with Adobe's model; substitute: a prompt panel calling the user's own OpenAI or Gemini key that emits Nib commands. | Not feasible | L | n/a |
| Quick Skill Guide (v) | Illustrator 31.0 in-app learning guide for skills. | Not feasible as Adobe content; substitute: local help pages in Nib. | Not feasible | S | n/a |

### Selection tools

| Feature | What Illustrator does (options that matter) | Nib plan | Status | Effort | Tier |
|---|---|---|---|---|---|
| Selection tool (V) | Click selects topmost object or whole group; drag a marquee; Shift adds/removes; bounding box with eight handles. | Hit test on the scene graph returning the top-level group; marquee intersects path geometry, not bounds. | Missing | M | core |
| Selection: move and Alt-drag duplicate | Drag moves; Alt-drag copies; Shift constrains to 45 degrees; Ctrl/Cmd+D repeats (Transform Again). | Move command with duplicate flag and constraint angle (respects Constrain Angle preference). | Missing | S | core |
| Selection: bounding box scale and rotate | Drag handles to scale (Shift keeps proportions, Alt from centre); hover outside a corner to rotate. | Bounding-box widget producing a transform command. | Missing | M | core |
| Selection: Show/Hide Bounding Box | View > Show/Hide Bounding Box (Shift+Ctrl/Cmd+B); Reset Bounding Box after rotation. | View flag; store per-object box rotation for Reset. | Missing | S | core |
| Selection: double-click to isolate | Double-clicking a group, symbol, compound path or clip group enters Isolation Mode. | Isolation mode state in the document view. | Missing | M | core |
| Selection: select behind | Ctrl/Cmd+click (Alt+Ctrl on Windows) selects the object behind the current one at that point. | Hit-test stack cycling. | Missing | S | next |
| Selection: Selection tool options dialog | Double-click opens Object > Transform > Move (Horizontal, Vertical, Distance, Angle, Transform Objects/Patterns, Preview, Copy). | Move dialog with those fields. | Missing | S | core |
| Selection: hover highlight | Object outline highlights under the cursor (Preferences: Object Highlighting). | Overlay draw of the hovered path. | Missing | S | core |
| Direct Selection tool (A) | Click selects anchors, segments or a path inside groups; drag moves points; handles shown for selected anchors. | Hit test on anchors/segments; selection set of (path, anchor index, handle) records. | Missing | M | core |
| Direct Selection: drag segment | Dragging a curve segment reshapes it (moves both handles); Shift constrains. | Segment drag solves handle offsets for a point on the curve. | Missing | M | core |
| Direct Selection: Alt-click | Alt-click selects the whole path or group (like Group Selection). | Modifier routes to Group Selection behaviour. | Missing | S | core |
| Direct Selection: live corners | Corner widgets on selected corner anchors; drag to round; double-click opens Corners dialog (Round, Inverted Round, Chamfer; Radius; Relative/Absolute rounding); Alt-click cycles corner type. | Per-anchor corner records (type, radius) evaluated into geometry at render; widget hides above a zoom/size threshold. | Missing | L | core |
| Direct Selection: options dialog | Double-click opens the Move dialog. | Reuse Move dialog. | Missing | S | core |
| Direct Selection: handle display options | Preferences > Selection & Anchor Display: anchor size, handle style, Highlight anchors on mouse over, Show handles when multiple anchors selected. | Overlay settings in Preferences (Preferences area for the dialog). | Missing | S | next |
| Group Selection tool | Click selects an object in a group; click again selects the parent group, and so on up. | Click counter that walks up the parent chain. | Missing | S | core |
| Magic Wand tool (Y) | Selects objects with similar attributes to the clicked one. | Attribute comparison over all selectable objects. | Missing | M | next |
| Magic Wand options: Fill Color + Tolerance | Tolerance 0-255 (RGB) or 0-100 (CMYK). | Distance in the document's colour space against tolerance. | Missing | S | next |
| Magic Wand options: Stroke Color + Tolerance | As above for stroke. | Same comparison on stroke paint. | Missing | S | next |
| Magic Wand options: Stroke Weight + Tolerance | Tolerance in points. | Numeric comparison. | Missing | S | next |
| Magic Wand options: Opacity + Tolerance | Tolerance in percent. | Numeric comparison. | Missing | S | next |
| Magic Wand options: Blending Mode | Same blending mode. | Equality comparison. | Missing | S | next |
| Magic Wand: Use Same Tolerance for All Objects (?) | Flyout option in the Magic Wand panel; also Reset, Show Stroke Options, Show Transparency Options. | Panel flyout toggles. | Missing | S | later |
| Magic Wand: Shift / Alt | Shift-click adds, Alt-click subtracts. | Selection set operations. | Missing | S | next |
| Lasso tool (Q) | Freehand lasso selects anchors and segments inside the loop; Shift adds, Alt subtracts. | Point-in-polygon on anchors and segment sample points. | Missing | S | next |
| Perspective Selection tool | See Perspective section. | See Perspective section. | Missing | M | later |

### Pen and anchor tools

| Feature | What Illustrator does (options that matter) | Nib plan | Status | Effort | Tier |
|---|---|---|---|---|---|
| Pen tool (P): straight segments | Click to place corner anchors; Shift constrains to 45 degrees; click the start to close; Esc or Ctrl/Cmd-click to end open path. | Path builder state machine committing one Add Path command per path (with interim undo of each anchor). | Missing | M | core |
| Pen: curves | Click-drag pulls symmetric handles; Shift constrains handle angle. | Cubic Bezier anchors with in/out handles. | Missing | S | core |
| Pen: break handle with Alt | Alt-drag a handle while drawing breaks it to a corner; Alt-click the last anchor removes its out handle. | Handle mode flags per anchor (smooth, corner, cusp). | Missing | S | core |
| Pen: Space to move anchor while placing | Holding Space while dragging moves the anchor being placed. | Drag mode switch. | Missing | S | core |
| Pen: rubber band preview | Preferences > Selection & Anchor Display: Enable Rubber Band for Pen tool / Curvature tool. | Overlay preview of the next segment, toggle in Preferences. | Missing | S | core |
| Pen: continue an open path | Clicking an endpoint of an open path continues it; clicking another endpoint joins them. | Endpoint hit test; join command. | Missing | S | core |
| Pen: auto add/delete | Hover a segment adds an anchor, hover an anchor deletes it (Preferences: Disable Auto Add/Delete). | Contextual cursor and command; preference flag. | Missing | S | core |
| Pen: cursor feedback | Cursor shows +, -, o (close), / (continue), ^ (convert). | Cursor set per hover state. | Missing | S | core |
| Pen: Ctrl/Cmd to adjust | Holding Ctrl/Cmd temporarily gives Direct Selection to adjust previous anchors and handles. | Modifier override. | Missing | S | core |
| Add Anchor Point tool (+) | Click on a segment adds an anchor without changing shape. | De Casteljau split at the nearest t. | Missing | S | core |
| Delete Anchor Point tool (-) | Click an anchor removes it; Illustrator re-fits the neighbouring segments. | Remove anchor and refit adjacent curves by least squares. | Missing | S | core |
| Anchor Point tool (Shift+C) | Click a smooth anchor to convert to corner; drag a corner to pull out smooth handles; drag one handle to make it independent; drag a segment to reshape it. | Anchor-type conversion commands. | Missing | S | core |
| Curvature tool (Shift+~) | Click to place smooth points that the curve passes through; double-click or Alt-click for corner points; drag points to adjust; Delete removes; Esc ends. | Interpolating spline (Catmull-Rom style through points) converted to cubic Beziers; Approximate: Nib's curve fit may differ from Adobe's. | Missing | M | core |
| Curvature: edit existing paths | Selecting a path with Curvature shows its anchors for curvature-style edits; double-click toggles smooth/corner. | Edit mode on any path. | Missing | S | next |
| Join tool (?) | In Pencil group (since 2017): scrub across overlapping or open path ends to join and trim them. | Find nearest endpoints and intersections along the scrub; trim and join. | Missing | M | next |

### Line and grid tools

| Feature | What Illustrator does (options that matter) | Nib plan | Status | Effort | Tier |
|---|---|---|---|---|---|
| Line Segment tool (\) | Drag a straight line; Shift constrains to 45 degrees; Alt from centre; ~ for many lines. | Two-anchor open path. | Missing | S | core |
| Line Segment options | Click opens dialog: Length, Angle, Fill Line. | Dialog fields mapped to path creation. | Missing | S | core |
| Live Line widgets (?) | Lines show a length/angle readout and live rotation. | Measurement label in the overlay. | Missing | S | next |
| Arc tool | Drag an arc; F flips, C toggles open/closed, X flips concave/convex, Up/Down changes slope. | Arc as one cubic segment with slope parameter. | Missing | S | next |
| Arc Segment Tool Options | Length X-Axis, Length Y-Axis, reference point, Type (Open/Closed), Base Along (X/Y Axis), Slope (Concave/Convex slider -100 to 100), Fill Arc. | Dialog mapping to arc generator. | Missing | S | next |
| Spiral tool | Drag to size and rotate; Up/Down add/remove segments; Ctrl/Cmd changes decay; R reverses direction. | Spiral generator from quarter-turn cubic segments. | Missing | S | later |
| Spiral options | Radius, Decay (percent), Segments, Style (clockwise / counter-clockwise). | Dialog mapping to generator. | Missing | S | later |
| Rectangular Grid tool | Drag a grid; arrows change rows/columns; X/C skew vertical dividers, V/F skew horizontal. | Generator producing a group of a frame rectangle and divider lines. | Missing | S | later |
| Rectangular Grid options | Default Size (Width, Height, reference point), Horizontal Dividers (Number, Skew Bottom/Top), Vertical Dividers (Number, Skew Left/Right), Use Outside Rectangle As Frame, Fill Grid. | Dialog mapping to generator, skew as logarithmic spacing. | Missing | S | later |
| Polar Grid tool | Drag a polar grid; arrows change concentric/radial counts; X/C/V/F skew. | Generator producing ellipses and radial lines. | Missing | S | later |
| Polar Grid options | Default Size, Concentric Dividers (Number, Skew In/Out), Radial Dividers (Number, Skew Bottom/Top), Create Compound Path From Ellipses, Fill Grid. | Dialog mapping to generator. | Missing | S | later |

### Shape tools and live shapes

| Feature | What Illustrator does (options that matter) | Nib plan | Status | Effort | Tier |
|---|---|---|---|---|---|
| Rectangle tool (M) | Drag rectangle; Shift square; Alt from centre; click for dialog (Width, Height, constrain link). | Live rectangle object with parametric width, height, corner radii, rotation. | Missing | M | core |
| Live Shape: rectangle properties | Transform panel / Properties: width, height, angle, four corner types and radii, Scale Corners, link radii. | Shape parameters edited by commands; expand to path on demand (Object > Shape > Expand Shape). | Missing | M | core |
| Live Shape: corner widgets on rectangle | Drag a corner widget rounds all corners; Alt-click cycles corner type; select one widget to round one corner. | Same corner widget as Direct Selection on live rectangles. | Missing | S | core |
| Rounded Rectangle tool | Drag; Up/Down change radius; Left/Right square/max; click dialog: Width, Height, Corner Radius. | Live rectangle with initial radius from Preferences. | Missing | S | core |
| Ellipse tool (L) | Drag ellipse; Shift circle; Alt centre; click dialog: Width, Height. | Live ellipse object. | Missing | S | core |
| Live Shape: ellipse pie widget | Drag the pie widget to make a pie; Pie Start/End Angle in Transform panel; Invert Pie. | Pie start/end angle parameters on live ellipses. | Missing | S | next |
| Polygon tool | Drag polygon; Up/Down change sides; Shift keeps a flat base; click dialog: Radius, Sides. | Live polygon with radius, sides, rotation. | Missing | S | core |
| Live Shape: polygon side widget | Drag the side widget to change sides (3-11 by widget, up to 1000 via panel); corner widgets; Make Sides Equal. | Parameter edit through widget and panel. | Missing | S | next |
| Star tool | Drag star; Up/Down change points; Ctrl/Cmd holds inner radius; Alt makes straight "shoulders"; click dialog: Radius 1, Radius 2, Points. | Star generator (not live in Illustrator); Nib may keep parameters as a live shape. | Missing | S | core |
| Flare tool | Draws a lens flare (centre, halo, rings, rays); drag for centre then drag for ring path; arrows change rays/rings. | Generator producing a group of gradient-filled shapes with blend modes. | Missing | M | later |
| Flare Tool Options | Center (Diameter, Opacity, Brightness), Halo (Growth, Fuzziness), Rays (Number, Longest, Fuzziness), Rings (Path, Number, Largest, Direction); click for dialog; editable after creation by double-clicking tool with flare selected. | Dialog mapping to generator; flare stored as a parametric object for re-editing. | Missing | M | later |
| Shaper tool (Shift+N) | Draw rough gestures that become clean live shapes (rectangle, ellipse, triangle, polygon, line); scribble over overlapping shapes to punch, merge or delete (Shaper Group). | Gesture recognizer (template matching on resampled strokes) to live shapes; Shaper Group as a live Pathfinder group storing operations per region. | Missing | L | next |
| Shaper Group editing | Click to select the group, the face or the shapes inside; arrow widget toggles; drag a face out of the group; fill of each face. | Live group re-running boolean ops on edit (shares Pathfinder kernel). | Missing | L | next |
| Live shape: Convert to Shape (?) | Object > Shape > Convert to Shapes turns near-rectangles/ellipses into live shapes. | Shape recognizer on selected paths (shared with Shaper). | Missing | S | later |

### Drawing and painting tools

| Feature | What Illustrator does (options that matter) | Nib plan | Status | Effort | Tier |
|---|---|---|---|---|---|
| Paintbrush tool (B) | Freehand path with the current brush (calligraphic, scatter, art, pattern, bristle) applied as a live stroke. | Freehand capture, curve fitting, then stroke with the active brush definition (Brushes covered in the Brushes area). | Missing | M | core |
| Paintbrush options: Fidelity | Slider Accurate to Smooth (5 steps). | Curve-fit error tolerance mapped to slider. | Missing | S | core |
| Paintbrush options: Fill new brush strokes | Fills the new path with the current fill. | Flag on the create command. | Missing | S | next |
| Paintbrush options: Keep Selected | Leaves the new path selected. | Flag. | Missing | S | core |
| Paintbrush options: Edit Selected Paths + Within N pixels | Drawing near a selected path redraws it. | Nearest-path test within distance; splice new samples into the path. | Missing | M | next |
| Paintbrush options: Reset | Restores defaults. | Reset button in options dialog. | Missing | S | core |
| Paintbrush: Alt to close | Alt while drawing closes the path on release. | Close flag. | Missing | S | next |
| Paintbrush: [ and ] for size | Brackets change calligraphic brush size. | Keymap to brush size. | Missing | S | next |
| Blob Brush tool (Shift+B) | Paints filled, merged compound shapes with no stroke; merges with overlapping art of the same fill. | Stroke-outline polygon of the dab track, union with touching same-fill paths via the boolean kernel. | Missing | L | next |
| Blob Brush options: Keep Selected | Leaves result selected. | Flag. | Missing | S | next |
| Blob Brush options: Merge Only with Selection | Merge only with selected objects. | Restrict union candidates. | Missing | S | next |
| Blob Brush options: Fidelity | Accurate to Smooth. | Fit tolerance. | Missing | S | next |
| Blob Brush options: Default Brush Options | Size, Angle, Roundness, each Fixed / Random / Pressure / Stylus Wheel / Tilt / Bearing / Rotation with Variation. | Shared calligraphic tip model with input-driven variation. | Missing | M | next |
| Pencil tool (N) | Freehand open or closed paths with smoothing. | Freehand capture plus curve fitting (Schneider algorithm). | Missing | M | core |
| Pencil options: Fidelity | Accurate to Smooth slider. | Fit tolerance. | Missing | S | core |
| Pencil options: Fill new pencil strokes | Fill new paths. | Flag. | Missing | S | core |
| Pencil options: Keep Selected | Leave selected. | Flag. | Missing | S | core |
| Pencil options: Alt key toggles to Smooth tool | Holding Alt smooths instead of drawing. | Modifier override. | Missing | S | next |
| Pencil options: Close paths when ends are within N pixels | Auto-close threshold. | Endpoint distance test. | Missing | S | core |
| Pencil options: Edit selected paths + Within N pixels | Redraw selected paths. | Same as Paintbrush. | Missing | S | next |
| Pencil: Alt for straight segments | Alt draws straight lines; Alt+Shift constrains to 45 degrees. | Straight-segment mode in the capture. | Missing | S | next |
| Live Pencil tool (?) | Reportedly added in 29.6 (2025) as a real-time smoothing mode. | Live smoothing preview while drawing (moving-average plus refit). | Missing | M | later |
| Smooth tool | Drag along a path to smooth it; options: Fidelity slider. | Local refit of the path segment under the drag with looser tolerance. | Missing | M | next |
| Path Eraser tool | Drag along a path to erase that part of it, leaving open paths. | Remove the curve interval under the stroke; split path. | Missing | S | next |
| Eraser tool (Shift+E) | Erases through any vector object (not text), splitting and closing shapes; Alt-drag a marquee to erase a rectangle; Shift constrains. | Subtract the brush-stroke outline from filled paths and split stroked paths via the boolean kernel. | Missing | L | next |
| Eraser options | Angle, Roundness, Size, each Fixed / Random / Pressure / Stylus Wheel / Tilt / Bearing / Rotation with Variation; [ ] change size. | Shared calligraphic tip model. | Missing | S | next |
| Scissors tool (C) | Click on a path or anchor to split it there; closed path becomes open. | Split command at nearest t. | Missing | S | core |
| Knife tool | Freehand cut through closed shapes, producing closed pieces; Alt for straight cuts, Alt+Shift for 45 degrees. | Split filled regions along the cut polyline using the boolean kernel. | Missing | M | next |

### Transform tools

| Feature | What Illustrator does (options that matter) | Nib plan | Status | Effort | Tier |
|---|---|---|---|---|---|
| Rotate tool (R) | Drag to rotate about the centre; click sets the reference point; Alt-click sets point and opens dialog; Shift constrains to 45 degrees; Alt-drag duplicates; ~ transforms pattern only. | Reference-point widget plus rotate command. | Missing | S | core |
| Rotate dialog | Angle, Options: Transform Objects, Transform Patterns, Preview, Copy, OK. | Dialog for the rotate command. | Missing | S | core |
| Reflect tool (O) | Click sets the axis point, drag to rotate the axis; Shift constrains; Alt-drag copies. | Reflect command with axis angle. | Missing | S | core |
| Reflect dialog | Axis: Horizontal, Vertical, Angle; Transform Objects/Patterns; Preview; Copy. | Dialog. | Missing | S | core |
| Scale tool (S) | Drag to scale about the reference point; Shift constrains proportions or axis; Alt-drag copies. | Scale command. | Missing | S | core |
| Scale dialog | Uniform (percent) or Non-Uniform (Horizontal, Vertical); Scale Corners; Scale Strokes & Effects; Transform Objects/Patterns; Preview; Copy. | Dialog; scale-strokes flag multiplies stroke width and effect parameters. | Missing | S | core |
| Shear tool | Drag to shear; Shift constrains; Alt copies. | Shear matrix command. | Missing | S | next |
| Shear dialog | Shear Angle; Axis: Horizontal, Vertical, Angle; Transform Objects/Patterns; Preview; Copy. | Dialog. | Missing | S | next |
| Reshape tool | Select anchors and drag to move them with smooth falloff on the rest of the path; Shift-click to add anchors to the set; can add an anchor on a segment. | Move selected anchors and propagate a weighted offset to neighbouring anchors. | Missing | M | later |
| Free Transform tool (E) | Bounding box transform with a widget offering Constrain, Free Transform, Perspective Distort, Free Distort; touch-friendly. | Shared transform box; four modes. | Missing | M | core |
| Free Transform: Constrain toggle | Keeps proportions or 45-degree angles while dragging. | Mode flag. | Missing | S | core |
| Free Transform: Free Transform mode | Scale, rotate, shear (drag side handles), reference-point move. | Matrix composition from handle drag. | Missing | S | core |
| Free Transform: Perspective Distort | Drag a corner to move it and its mirror in perspective (Ctrl+Alt+Shift drag classic shortcut). | Projective transform applied to every anchor and handle; Approximate: Bezier curves are mapped by control points, which is not exact under perspective, the same simplification Illustrator makes. | Missing | M | next |
| Free Transform: Free Distort | Drag any corner independently. | Bilinear or projective mapping of control points. | Missing | M | next |
| Reference point widget | Nine-point reference locator in Transform panel and Control bar; reference point in transform tools draggable. | Shared reference-point model. | Missing | S | core |
| Puppet Warp tool (v) | Click to add pins (some added automatically); drag pins to deform; Alt-drag a pin to rotate around it; Shift-click selects several pins. | Triangulate the art's outline (constrained Delaunay) and run as-rigid-as-possible deformation; map anchors and handles through the mesh. | Missing | L | later |
| Puppet Warp options: Show Mesh (v) | Show or hide the mesh overlay in the Control/Properties panel. | Overlay toggle. | Missing | S | later |
| Puppet Warp options: Expand Mesh (v) | Enlarge the mesh beyond the art to include gaps. | Offset outline before triangulation. | Missing | S | later |
| Puppet Warp: Select All Pins (v) | Quick Action in Properties; Delete removes pins. | Pin selection command. | Missing | S | later |

### Liquify tools (Width, Warp and friends)

| Feature | What Illustrator does (options that matter) | Nib plan | Status | Effort | Tier |
|---|---|---|---|---|---|
| Width tool (Shift+W) | Drag on a stroke to create width points and set width; drag a width point along the path; Alt for one side; Shift selects several; Delete removes. | Variable-width profile (offset t, left and right width) on strokes; outline evaluated at render. | Missing | L | next |
| Width Point Edit dialog | Double-click a point: Side 1, Side 2, Total Width, Adjust Adjoining Width Points; for discontinuous points both sides. | Dialog editing one profile point. | Missing | S | next |
| Width tool: Alt-drag duplicate point, Shift adjust adjoining | Alt-drag a width point copies it; Shift-drag moves adjoining points proportionally. | Profile edit modifiers. | Missing | S | next |
| Width profiles | Save and apply profiles from Stroke panel (Stroke area). | Profile presets stored in settings (Stroke area). | Missing | S | next |
| Warp tool (Shift+R) | Push path anchors with a brush; Alt-drag to change brush size. | Displace anchors and handles inside the brush by drag delta with falloff, adding anchors per Detail. | Missing | M | later |
| Twirl tool | Twists paths inside the brush around its centre. | Rotation proportional to dwell time and falloff. | Missing | M | later |
| Pucker tool | Pulls anchors towards the brush centre. | Radial contraction. | Missing | S | later |
| Bloat tool | Pushes anchors away from the centre. | Radial expansion. | Missing | S | later |
| Scallop tool | Adds curved arcs to the outline pulling towards centre. | Insert spikes with curved shape; Approximate. | Missing | M | later |
| Crystallize tool | Adds spiky details outward. | Insert outward spikes; Approximate. | Missing | M | later |
| Wrinkle tool | Adds wrinkle-like random details. | Random perpendicular displacement; Approximate. | Missing | M | later |
| Liquify global brush dimensions | Width, Height, Angle, Intensity, Use Pressure Pen (shared by all liquify tools). | Shared liquify options object. | Missing | S | later |
| Warp options | Detail (1-10), Simplify (0.2-100), Show Brush Size. | Anchor insertion density and refit tolerance. | Missing | S | later |
| Twirl options | Twirl Rate (-180 to 180 degrees), Detail, Simplify, Show Brush Size. | Parameters. | Missing | S | later |
| Pucker / Bloat options | Detail, Simplify, Show Brush Size. | Parameters. | Missing | S | later |
| Scallop options | Complexity, Detail, Brush Affects Anchor Points / In Tangent Handles / Out Tangent Handles. | Parameters. | Missing | S | later |
| Crystallize options | Complexity, Detail, Brush Affects Anchor Points / In / Out Tangent Handles. | Parameters. | Missing | S | later |
| Wrinkle options | Horizontal, Vertical (percent), Complexity, Detail, Brush Affects Anchor Points / In / Out Tangent Handles. | Parameters. | Missing | S | later |
| Liquify: Reset | Reset button in each dialog. | Reset. | Missing | S | later |

### Shape Builder and Live Paint

| Feature | What Illustrator does (options that matter) | Nib plan | Status | Effort | Tier |
|---|---|---|---|---|---|
| Shape Builder tool (Shift+M) | With shapes selected, drag across regions to merge them; Alt-drag or Alt-click to delete regions; edges can be deleted too; region highlight under the cursor. | Compute the planar arrangement of selected paths (shared with Pathfinder and Live Paint), merge or delete faces and edges. | Missing | L | core |
| Shape Builder options: Gap Detection + Gap Length (v) | Off by default; Small, Medium, Large or Custom length (max about 1 inch). | Extend open ends by snapping endpoints within the gap distance when building the arrangement. | Missing | M | next |
| Shape Builder options: Consider Open Filled Path as Closed (v) | Treat open filled paths as closed. | Implicit closing segment in arrangement. | Missing | S | next |
| Shape Builder options: In Merge Mode, Clicking Stroke Splits the Path | Clicking a stroke edge splits it. | Edge-split command. | Missing | S | later |
| Shape Builder options: Pick Color From (Color Swatches / Artwork) + Cursor Swatch Preview | Fill for merged shapes from swatches (with arrow keys) or from the artwork. | Option enum; cursor swatch preview with arrow-key cycling. | Missing | S | next |
| Shape Builder options: Selection (Freeform / Straight Line) | Drag style for selecting regions. | Hit test along a freeform or straight path. | Missing | S | later |
| Shape Builder options: Highlight (Fill, Highlight Stroke When Editable, Color) | Region and stroke highlight look. | Overlay styling settings. | Missing | S | next |
| Shape Builder: Shift marquee | Shift-drag a marquee merges all regions inside. | Rectangle region selection. | Missing | S | next |
| Live Paint Bucket tool (K) | Converts selection to a Live Paint group on click; paints faces and edges; Shift toggles to stroke painting; Alt picks colour (eyedropper); double-click fills adjacent faces of the same colour; triple-click fills all same-coloured faces. | Live Paint group storing source paths plus face/edge paint keyed by stable region signatures; recomputed arrangement on edit. | Missing | XL | later |
| Live Paint Bucket options | Paint Fills, Paint Strokes, Cursor Swatch Preview, Highlight (Color, Width). | Options object. | Missing | S | later |
| Live Paint gap options | Object > Live Paint > Gap Options: Gap Detection, Paint stops at (Small/Medium/Large/Custom gaps), Gap Preview Color, Close Gaps with Paths. | Same gap logic as Shape Builder, plus "close gaps" adding paths (detail in Object area). | Missing | M | later |
| Live Paint Selection tool (Shift+L) | Selects faces and edges of a Live Paint group; double-click selects connected same-paint faces; triple-click all same paint. | Selection over Live Paint regions. | Missing | M | later |
| Live Paint Selection options | Select Fills, Select Strokes, Highlight Color, Width. | Options object. | Missing | S | later |

### Perspective tools

| Feature | What Illustrator does (options that matter) | Nib plan | Status | Effort | Tier |
|---|---|---|---|---|---|
| Perspective Grid tool (Shift+P) | Shows a one-, two- or three-point grid; drag widgets to move vanishing points, horizon, ground level, grid extent, cell size and origin; plane switching widget (left, right, horizontal, none). | A grid object per document with vanishing points and planes, drawn in the overlay; widget handles edit it via commands. | Missing | L | later |
| Perspective grid presets | View > Perspective Grid > One/Two/Three Point Perspective, Define Grid (Units, Scale, Gridline every, Viewing Angle, Viewing Distance, Horizon Height, Third VP, colours, opacity), Save Grid as Preset, Lock Grid, Lock Station Point, Snap to Grid. | Presets in settings and a Define Grid dialog (View menu area for menu items). | Missing | M | later |
| Plane switching widget keys | 1 left, 2 horizontal, 3 right, 4 no plane; Shift+V cycles. | Keymap. | Missing | S | later |
| Drawing in perspective | Shape and line tools draw on the active plane while the grid is visible. | Shape tools map their geometry through the plane's homography. | Missing | M | later |
| Perspective Selection tool (Shift+V) | Drag objects onto planes; move objects in perspective; 5 moves perpendicular to plane; Alt-drag copies; Shift constrains. | Objects store plane and plane-space geometry; render through the homography. | Missing | L | later |
| Attach to Active Plane / Release with Perspective / Move Plane to Match Object / Edit Text | Object > Perspective menu commands. | Commands on perspective objects. | Missing | M | later |
| Perspective plane widget drag (move plane) | Drag the plane control to move a plane, Alt-drag copies objects with it. | Plane offset command. | Missing | S | later |

### Mesh and gradient tools

| Feature | What Illustrator does (options that matter) | Nib plan | Status | Effort | Tier |
|---|---|---|---|---|---|
| Mesh tool (U) | Click in a filled shape to add mesh lines and a point with the current fill colour; drag points and handles; Alt-click removes; Shift-click adds without changing colour. | Gradient mesh object: grid of Coons patches with colours per vertex; render by patch subdivision in a WebGL or 2D canvas renderer; Approximate: SVG export rasterises or approximates meshes. | Missing | XL | later |
| Mesh: colour points and patches | Select a point or patch with Direct Selection to colour it; opacity per point. | Per-vertex RGBA. | Missing | M | later |
| Create Gradient Mesh dialog | Object > Create Gradient Mesh: Rows, Columns, Appearance (Flat, To Center, To Edge), Highlight percent (Object area). | Covered in Object area. | Missing | S | later |
| Gradient tool (G) | Drag to set gradient start, end and angle on fills or strokes; annotator with stops, midpoints, ellipse handles for radial (aspect, angle); Shift constrains. | On-canvas gradient annotator editing the fill's gradient parameters. | Missing | M | core |
| Gradient annotator: add, move, delete stops | Click under the annotator to add a stop, drag off to delete, double-click to edit colour and opacity. | Annotator stop editing. | Missing | S | core |
| Freeform Gradient: Points mode | Click in a shape to add colour points; drag; Spread per point; delete. | Freeform gradient as scattered points interpolated (e.g. inverse-distance or Shepard weighting); Approximate: Adobe's interpolation is not documented. | Missing | L | next |
| Freeform Gradient: Lines mode | Draw lines of colour stops; colour flows along the line. | Points along polylines sampled into the same interpolator. | Missing | M | next |
| Gradient tool on strokes | Apply gradient within, along or across stroke (Gradient panel, Color area). | Covered in Color/Gradient area. | Missing | S | next |
| Show/Hide Gradient Annotator | View > Show/Hide Gradient Annotator. | View flag. | Missing | S | core |

### Eyedropper and Measure

| Feature | What Illustrator does (options that matter) | Nib plan | Status | Effort | Tier |
|---|---|---|---|---|---|
| Eyedropper tool (I) | Click an object to copy its attributes to the selection (or to default style); Shift-click samples only the colour under the cursor; Alt-click applies to the clicked object; can sample from anywhere on screen by dragging. | Attribute copy command with options mask. | Missing | M | core |
| Eyedropper: sample from outside the window | Drag from the canvas to anywhere on the screen to sample. | Electron `desktopCapturer` screen sample or the EyeDropper web API; Approximate. | Missing | S | next |
| Eyedropper options: Raster Sample Size | Point Sample, 3x3, 5x5 Average. | Average pixels when sampling placed images. | Missing | S | next |
| Eyedropper options: Eyedropper Picks Up | Tree of checkboxes: Appearance, Transparency, Focal Fill (Color, Transparency, Overprint), Focal Stroke (Color, Transparency, Overprint, Weight, Cap, Join, Miter Limit, Dash Pattern), Character Style (font, size, leading, tracking, etc.), Paragraph Style. | Mask object mirroring the tree. | Missing | M | core |
| Eyedropper options: Eyedropper Applies | Same tree for what is applied. | Second mask. | Missing | S | core |
| Measure tool | Drag between points; shows Info panel with X, Y, W, H, D, angle; Shift constrains to 45 degrees. | Temporary measure line in overlay feeding the Info panel. | Missing | S | next |
| Dimension tool (v) | Since 2025 (29.x): plot linear, angular and radial dimensions of objects as editable dimension objects; snaps to anchors and edges. | Dimension object type (anchor refs, offset, style) that updates when geometry changes. | Missing | L | next |
| Dimension: linear (v) | Horizontal, vertical, aligned measurements between two points. | Linear dimension variant. | Missing | M | next |
| Dimension: angular (v) | Angle between two edges. | Angular dimension variant. | Missing | M | next |
| Dimension: radial (v) | Radius or diameter of curves and circles. | Radial dimension variant fitting a circle to the curve. | Missing | M | next |
| Dimension Tool Options (v) | Double-click or Tool Options in the dimension taskbar: Units & Scale (units, scale such as 1:1, precision), Dimension Lines, Extension Lines, Dimension Text sections. | Options dialog storing default style; scale applies to new dimensions only. | Missing | M | next |
| Dimension editing in Properties (v) | Properties panel shows Dimension, Dimension Line, Extension Line and Dimension Text options for selected dimensions. | Properties section for dimension objects. | Missing | S | next |
| Dimension: expand to plain art (?) | Expand dimension objects to paths and text. | Expand command. | Missing | S | later |

### Blend tool

| Feature | What Illustrator does (options that matter) | Nib plan | Status | Effort | Tier |
|---|---|---|---|---|---|
| Blend tool (W) | Click objects (or specific anchors) in turn to blend between them; anchor clicks control alignment of the blend; Alt-click opens options. | Live blend object storing source keys and spine; intermediate steps interpolated (matching anchors after resampling to equal counts). | Missing | L | next |
| Blend options: Spacing | Smooth Color, Specified Steps (count), Specified Distance. | Step generator by colour difference, count or arc length. | Missing | S | next |
| Blend options: Orientation | Align to Page or Align to Path. | Rotate steps to spine tangent. | Missing | S | next |
| Blend panel (v) | Illustrator 30.7 replaced the modal Blend Options dialog with a Blend panel with live preview, collapsible Easing, Appearance and Spine Controls sections and a Make button. | Blend section in a panel editing the live blend object (Panels area for the panel shell). | Missing | M | next |
| Blend easing (v) | Ease In, Ease Out, Ease In/Out, Ease Out/In with a Ramp slider; only with Constant/Specified Steps; values saved per blend. | Easing curve mapping step index to interpolation t. | Missing | S | later |
| Blend on-canvas easing handles and smoothing (v) | Illustrator 31.0 adds blend smoothing options and on-canvas easing handles, plus extra spine options. | Overlay handles editing the easing curve; Approximate. | Missing | M | later |
| Blend colour shift (v) | Blend panel colour controls (Color Shift values stored per blend). | Colour interpolation options (RGB/Lab path, hue shift); Approximate. | Missing | S | later |
| Replace Spine, Reverse Spine, Reverse Front to Back | Object > Blend commands (also usable after drawing a path). | Commands on the blend object (Object area). | Missing | S | next |
| Blend: Expand / Release | Object > Blend > Expand, Release. | Commands (Object area). | Missing | S | next |

### Symbolism tools

| Feature | What Illustrator does (options that matter) | Nib plan | Status | Effort | Tier |
|---|---|---|---|---|---|
| Symbol Sprayer tool (Shift+S) | Spray instances of the selected symbol into a symbol set; Alt removes instances. | Symbol set object holding instance list (symbol ref, transform, tint, opacity, style); spray adds at a rate with jitter. | Missing | L | later |
| Symbol Shifter tool | Moves instances in the brush direction; Shift brings forward, Shift+Alt sends back. | Displace instance positions and reorder. | Missing | S | later |
| Symbol Scruncher tool | Pulls instances together; Alt pushes apart. | Radial displacement. | Missing | S | later |
| Symbol Sizer tool | Enlarges instances; Alt shrinks; Shift preserves density. | Scale instance transforms. | Missing | S | later |
| Symbol Spinner tool | Rotates instances towards the drag direction. | Orient instance rotation. | Missing | S | later |
| Symbol Stainer tool | Tints instances with the fill colour; Alt reduces tint; Shift keeps tint amount. | Per-instance tint colour and amount (colorize blend at render). | Missing | S | later |
| Symbol Screener tool | Increases transparency; Alt restores. | Per-instance opacity. | Missing | S | later |
| Symbol Styler tool | Applies the selected graphic style; Alt removes. | Per-instance graphic style with amount; Approximate: amount interpolation of styles. | Missing | M | later |
| Symbolism Tools Options: global | Diameter, Method (User Defined / Average / Random), Intensity with Use Pressure Pen, Symbol Set Density, tool buttons, Show Brush Size and Intensity. | Shared options object. | Missing | S | later |
| Symbolism Tools Options: Symbol Sprayer section | Scrunch, Size, Spin, Screen, Stain, Style, each Average or User Defined. | Spray defaults per attribute. | Missing | S | later |
| Symbolism Tools Options: Scrunch / Size options | Scrunch: Proportional Resizing / Resizing Affects Density options for Sizer. | Flags. | Missing | S | later |
| Symbolism: [ ] brush size, Shift+[ ] intensity | Bracket keys change diameter and intensity. | Keymap. | Missing | S | later |

### Graph tools

| Feature | What Illustrator does (options that matter) | Nib plan | Status | Effort | Tier |
|---|---|---|---|---|---|
| Column Graph tool (J) | Drag or click to set size; opens the Graph Data window. | Live graph object: data table plus type plus options, rendered to a group of paths and text. | Missing | L | later |
| Stacked Column Graph tool | Stacked columns. | Graph type renderer. | Missing | S | later |
| Bar Graph tool | Horizontal bars. | Graph type renderer. | Missing | S | later |
| Stacked Bar Graph tool | Stacked horizontal bars. | Graph type renderer. | Missing | S | later |
| Line Graph tool | Points connected by lines. | Graph type renderer. | Missing | S | later |
| Area Graph tool | Filled area under lines. | Graph type renderer. | Missing | S | later |
| Scatter Graph tool | X/Y points. | Graph type renderer. | Missing | S | later |
| Pie Graph tool | Pie wedges. | Graph type renderer. | Missing | S | later |
| Radar Graph tool | Radar (web) chart. | Graph type renderer. | Missing | S | later |
| Graph size dialog | Click opens Width and Height dialog. | Dialog. | Missing | S | later |
| Graph Data window | Spreadsheet-like cells, Import Data (tab-delimited text), Transpose row/column, Switch x/y (scatter), Cell Style (decimals, column width), Revert, Apply. | Grid editor component; CSV/TSV import. | Missing | M | later |
| Graph Type dialog: Graph Options | Type, Value Axis (On Left/Right/Both), Style (Add Drop Shadow, Add Legend Across Top, First Row in Front, First Column in Front), Options (Column Width, Cluster Width; Mark Data Points, Connect Data Points, Edge-to-Edge Lines, Draw Filled Lines; Legend, Sort, Position for pie). | Options object per graph. | Missing | M | later |
| Graph Type dialog: Value Axis | Tick Values (Override Calculated Values, Min, Max, Divisions), Tick Marks (None/Short/Full Width, Draw N tick marks per division), Add Labels (Prefix, Suffix). | Axis options. | Missing | S | later |
| Graph Type dialog: Category Axis | Tick Marks length and per-division count, Draw tick marks between labels. | Axis options. | Missing | S | later |
| Graph Design / Column design | Object > Graph > Design and Column (Vertically Scaled, Uniformly Scaled, Repeating, Sliding; Rotate Legend Design) and Marker. | Custom design symbols mapped to bars (Object area for menus). | Missing | M | later |
| Graph: Group Selection editing | Graph parts are restyled with Group Selection; graph stays live. | Per-series style overrides stored in the graph object. | Missing | M | later |

### Artboard tool

| Feature | What Illustrator does (options that matter) | Nib plan | Status | Effort | Tier |
|---|---|---|---|---|---|
| Artboard tool (Shift+O) | Drag to create artboards, drag to move, handles to resize, Alt-drag duplicates, Shift constrains, Delete removes; click to make active; Shift-click multiple. | Artboard records (name, rect, options) edited by commands; overlay handles. | Missing | M | core |
| Artboard: Move/Copy Artwork with Artboard | Control/Properties toggle; artwork moves with the artboard. | Flag that moves objects whose bounds are on the artboard. | Missing | S | core |
| Artboard Options dialog | Double-click tool or artboard: Name, Preset, Width, Height, Orientation, X, Y, Constrain proportions, Display (Show Center Mark, Show Cross Hairs, Show Video Safe Areas, Video Ruler Pixel Aspect Ratio), Global (Fade region outside Artboard, Update while dragging), Artboards count, Delete. | Dialog mapping to artboard and view settings. | Missing | M | core |
| Artboard presets | Letter, A4, web sizes, devices, Fit Artboard to Artwork / Selected Art bounds. | Preset list in settings; fit commands. | Missing | S | core |
| Artboard: Rearrange | Rearrange All Artboards dialog (Layout grid/row/column, Layout order L-R/R-L, Columns, Spacing, Move Artwork with Artboard). | Layout algorithm and command (Artboards panel area). | Missing | S | next |
| Artboard: Alt-drag inside artboard | Alt-drag or paste creates copies; Paste on Active / All Artboards. | Duplicate command with artwork copy. | Missing | S | core |
| Artboard enhancements in 2026 (v) | Illustrator 30.0 announced artboard enhancements (exact items not confirmed). | Track when details are known. | Missing | S | next |
| Artboard tool: Edit Artboards mode enter/exit | Esc or another tool exits; Shift+O enters. | Tool state. | Missing | S | core |

### Slice tools

| Feature | What Illustrator does (options that matter) | Nib plan | Status | Effort | Tier |
|---|---|---|---|---|---|
| Slice tool (Shift+K) | Drag to make user slices for web export; auto slices fill the rest. | Slice records with rect, name, URL, alt text, background; export later (Formats area for Save for Web). | Missing | M | later |
| Slice Selection tool | Select, move and resize slices. | Selection over slice records. | Missing | S | later |
| Slice Options dialog | Slice Type (Image, No Image, HTML Text), Name, URL, Target, Message, Alt, Background. | Dialog. | Missing | S | later |
| Object > Slice menu | Make, Release, Create from Selection, Create from Guides, Duplicate, Combine, Divide, Delete All, Slice Options, Clip to Artboard (Object area). | Covered in Object area. | Missing | S | later |

### Navigation tools

| Feature | What Illustrator does (options that matter) | Nib plan | Status | Effort | Tier |
|---|---|---|---|---|---|
| Hand tool (H) | Drag to pan; double-click fits artboard in window. | View offset; fit command. | Missing | S | core |
| Hand: animated / flick pan (?) | GPU flick panning when GPU performance is on. | Inertia on release. | Missing | S | later |
| Rotate View tool (Shift+H) | Rotate the canvas view; Shift snaps to 15 degrees; Rotate View field in Control bar; View > Reset Rotate View (Shift+Esc / Ctrl+1 on some versions). | View rotation matrix in the renderer; reset command. | Missing | M | next |
| Rotate View: Rotate View to Selection | View > Rotate View > Rotate View to Selected Art / angle presets. | Commands. | Missing | S | later |
| Print Tiling tool | Drag to move the printable page tiles relative to the artboard. | Print-tile offset stored per document (Printing area). | Missing | S | later |
| Zoom tool (Z) | Click zooms in, Alt-click out; drag marquee (or scrubby zoom when Animated Zoom on); double-click 100 percent. | View scale; animated zoom with GPU-style scrubby drag. | Missing | S | core |
| Animated Zoom / scrubby zoom | With GPU Performance on, drag left/right to zoom continuously. | Continuous zoom on drag; preference to fall back to marquee. | Missing | S | next |
| Zoom with scroll and pinch | Alt+scroll / Ctrl+scroll and trackpad pinch zoom; scroll pans. | Wheel and gesture handlers. | Missing | S | core |
| Navigator-driven zoom | Navigator panel (Panels area). | Covered in Panels area. | Missing | S | next |

### Type tools (pointer)

| Feature | What Illustrator does (options that matter) | Nib plan | Status | Effort | Tier |
|---|---|---|---|---|---|
| Type tool (T) | Point type on click, area type on drag. | See Type area. | Missing | L | core |
| Area Type tool | Type inside a path. | See Type area. | Missing | M | core |
| Type on a Path tool | Type along a path. | See Type area. | Missing | M | next |
| Vertical Type, Vertical Area Type, Vertical Type on a Path tools | Vertical (CJK) variants. | See Type area. | Missing | M | later |
| Touch Type tool (Shift+T) | Edit individual glyph positions, scale and rotation. | See Type area. | Missing | M | later |
| Retype (v) | Identify fonts in images and outlined text and suggest matching fonts. | Not feasible as Adobe's model and Adobe Fonts catalogue; substitute: see Type area (match against installed and user-supplied fonts with the user's own vision API). | Not feasible | M | n/a |

### Other tools and tool-like features

| Feature | What Illustrator does (options that matter) | Nib plan | Status | Effort | Tier |
|---|---|---|---|---|---|
| Objects on Path tool (v) | Since 29.0 (2024): select objects, pick the tool, click a path; objects attach to the path as an Objects on Path group; widgets control distribution, spacing, rotation, position; shuffle widget; detach objects; edit the path and objects re-flow. | Live group (path ref plus member list with offsets) laying out members along arc length at render. | Missing | L | next |
| Objects on Path options in Properties (v) | Object on Path Options section in Properties; Object > Objects on Path > Expand. | Properties section and expand command. | Missing | S | next |
| Objects on Path: Layers drag to attach (v) | Dragging objects into the group in the Layers panel attaches them to the end of the path. | Layers drop handler appends members. | Missing | S | later |
| Intertwine (v) | Object > Intertwine > Make: draw (lasso) over overlapping regions to bring parts of one object in front of another; Edit, Release. | Live intertwine group storing per-region stacking masks; render with clip regions (Object area holds the menu). | Missing | L | later |
| Mockup (v) | Mockup panel: place vector art onto a raster photo of an object, warped to its surface. | Not feasible as Adobe's surface-detection model; substitute: manual mockup by placing art with an envelope/perspective warp onto an image, or the user's own AI key for depth estimation. | Not feasible | L | n/a |
| Generative Shape Fill (v) | Firefly fills a selected shape with vector art from a prompt (Contextual Task Bar, Object menu, Properties Quick Actions); Generated Variations panel. | Not feasible with Firefly; substitute: call the user's own OpenAI or Gemini key for an SVG or raster then trace it, with variations listed in a panel, as Pigment 0.2 does. | Not feasible | L | n/a |
| Text to Vector Graphic (v) | Generate Vectors from a prompt: Scene, Subject, Icon, Pattern; style reference; detail slider. | Not feasible with Firefly; substitute: user's own AI key returning SVG, imported as editable paths. | Not feasible | L | n/a |
| Generative Recolor | Prompt-driven colour variations in Recolor Artwork. | Not feasible with Firefly; substitute: user's own AI key proposing palettes applied via Nib's Recolor (Color area). | Not feasible | M | n/a |
| Generative Expand (v) | Extends artwork beyond its bounds (29.6 / 30.4 references). | Not feasible with Firefly; substitute: user's own image model for raster outpainting. | Not feasible | M | n/a |
| Turntable (beta) (v) | Generates multiple rotated views of a 2D vector object. | Not feasible with Adobe's model; substitute: none faithful; possibly the user's own AI key for generated views. | Not feasible | L | n/a |
| Generate with Firefly in New Document (v) | 30.7 adds a Generate with Firefly option in New Document. | Not feasible; substitute: Nib's AI dialog with user's key. | Not feasible | S | n/a |
| Image Trace tool entry | Image Trace is a panel and Contextual Task Bar action, not a tool (29.0 enhanced: gradients, shapes, transparency, auto grouping) (v). | Covered in Object/Image Trace area. | Missing | XL | next |
| Global Edit (?) | Select similar objects and edit them together (Select > Start Global Edit). | Covered in Select area. | Missing | M | later |
| Snap and Smart Guides while using tools (v) | Tools snap to anchors, paths, grid, pixel grid, glyphs; 30.x adds Snap to Tangent, snapping restricted to the active artboard, and Smart Guides on rotated objects. | Shared snapping engine consulted by all tools (View area holds the settings). | Missing | L | core |

Counts: 285 rows. By status: Missing 275, Not feasible 10. By tier: core 90, next 87, later 98, n/a 10.
