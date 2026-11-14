# Edit, Object and Select menus; path editing and construction

This page lists the Illustrator features in the Edit, Object and Select menus, the panels that go with them (Pathfinder, Align, Transform, Image Trace, Blend), and the ways of editing and building paths: anchor point editing, live corners, compound paths and clipping masks, Live Paint, blends, envelopes, Puppet Warp, Global Edit, Repeat, Intertwine and Objects on Path. It is dated November 2026 and is checked against Illustrator 2025/2026 (versions 29 and 30, up to 30.8). Nib has no code yet, so every row is Missing unless it is Not feasible. The page was written from knowledge of Illustrator, and a few search-result snippets were used to check features, because helpx.adobe.com is blocked from the audit container. "(v)" marks a row confirmed by a search snippet; "(?)" marks a row that may not exist in the current version in this form. Tools that live only in the toolbar (Pen, Shape Builder, Width, Knife, Eraser and so on), the Type menu, the Effect menu, the Paint area (Recolor Artwork, Swatches, Gradients) and the document area (artboards, File menu, Preferences) are covered in their own pages; this page links to them where a menu command is only a pointer.

Columns: Status is Missing or Not feasible. Effort: S (under a day), M (a few days), L (a week or more), XL (a subsystem). Tier: core (first usable release), next (professional work), later (specialised), n/a (not feasible).

### Edit menu: history and clipboard

| Feature | What Illustrator does (options that matter) | Nib plan | Status | Effort | Tier |
|---|---|---|---|---|---|
| Undo / Redo | Ctrl+Z / Shift+Ctrl+Z; menu item names the last action ("Undo Move"); unlimited levels limited by memory; works after save | Every action is a command in the registry with apply/revert; menu label comes from the command's name. | Missing | M | core |
| History panel (?) | Window > History (added 2020s, ?) lists states, click to revert, number of states set in Preferences | A list view over the command stack; clicking a row reverts to that state. | Missing | S | core |
| Cut / Copy / Paste | Ctrl+X/C/V; paste centres in the view; clipboard carries AI/PDF and SVG for other apps; Preferences > Clipboard on Quit (PDF, AICB, Preserve Paths/Appearance) | Internal clipboard of serialized Nib nodes, plus SVG and PNG on the system clipboard via Electron's clipboard module. | Missing | M | core |
| Paste of SVG text from other apps | Pasting SVG markup or vectors from browsers/Figma creates editable paths | Parse SVG from the clipboard with the same importer as File > Open. | Missing | S | core |
| Paste in Front / Paste in Back | Ctrl+F / Ctrl+B: pastes at the original position directly above/below the selected object (or top/bottom of the layer if nothing selected) | Insert the clipboard nodes adjacent to the selection's z-index at the original coordinates. | Missing | S | core |
| Paste in Place | Shift+Ctrl+V: pastes at the original position on the active artboard | Paste at stored coordinates, top of the active layer. | Missing | S | core |
| Paste on All Artboards (v) | Alt+Shift+Ctrl+V: pastes at the same position relative to every artboard | Loop over artboards, offset by each artboard's origin. | Missing | S | next |
| Paste on selected artboards (v)(?) | 29.5 beta onwards: paste the same element onto several selected artboards | Same as Paste on All Artboards, limited to the artboard selection. | Missing | S | next |
| Paste without Formatting (v) | Pastes text as plain text in the current character style; only for Illustrator text content | Strip character attributes from clipboard text runs; see the Type page. | Missing | S | next |
| Clear | Delete/Backspace removes the selection; with Direct Selection on anchors, deletes the anchors and splits the path | Delete command; with anchors selected, remove anchors and split the path at the gaps. | Missing | S | core |
| Paste Remembers Layers | Layers panel flyout option: paste into the layers the objects came from | Option stored per document; clipboard nodes carry source layer ids. | Missing | S | next |
| Drag and drop between documents and apps | Drag selection to another window copies it; drop SVG/PNG files to place | Use HTML5 drag-and-drop with Electron file paths; SVG goes through the importer. | Missing | M | next |
| Alt-drag duplicate | Alt while dragging with Selection copies the objects; Shift constrains to 45° | Move tool modifier creates copies in one undoable command. | Missing | S | core |

### Edit menu: find, spelling and definitions

| Feature | What Illustrator does (options that matter) | Nib plan | Status | Effort | Tier |
|---|---|---|---|---|---|
| Find and Replace | Searches text objects: Find, Replace With, Match Case, Find Whole Word, Search Backwards, Check Hidden Layers, Check Locked Layers; Find, Replace, Replace & Find, Replace All; special-character menu | Dialog walking text nodes in document order; regex off by default. Details on the Type page. | Missing | M | next |
| Find Next | Repeats the last Find | Reuse the stored query. | Missing | S | next |
| Spelling > Check Spelling / Auto Spell Check | Dialog with Ignore, Change, Change All, Add, language; inline red underline | Pointer to the Type page (Hunspell dictionaries). | Missing | M | next |
| Edit Custom Dictionary | Add, remove, change user words | Pointer to the Type page; a word list stored in user data. | Missing | S | later |
| Define Pattern | Opens Pattern Options with the selection as a new pattern swatch | Enter pattern editing mode with the selection as the tile; see Pattern submenu below. | Missing | M | next |
| Edit Colors submenu | Recolor Artwork, Adjust Color Balance, Blend Front to Back, Blend Horizontally, Blend Vertically, Convert to CMYK/Grayscale/RGB, Invert Colors, Overprint Black, Saturate, Generative Recolor | Listed here as commands; built on the Paint page. | Missing | L | next |
| Edit Colors > Generative Recolor (v) | Firefly recolors artwork from a prompt and sample prompts | Not feasible with Firefly; substitute: send the palette and prompt to the user's own OpenAI or Gemini key and apply the returned colours through Recolor (as Pigment 0.2 does). | Not feasible | M | n/a |
| Edit Original | Opens a linked image in its source app (Photoshop) | shell.openPath on the linked file; reload on file change. | Missing | S | next |
| Edit Contents (envelope/symbol) | Context command entering envelope or symbol contents | See Envelope Distort and Symbols. | Missing | S | next |

### Edit menu: presets, settings and shortcuts

| Feature | What Illustrator does (options that matter) | Nib plan | Status | Effort | Tier |
|---|---|---|---|---|---|
| Transparency Flattener Presets | Manage presets: Raster/Vector Balance, line art and text resolution, gradient and mesh resolution, convert all text to outlines, convert all strokes to outlines, clip complex regions, anti-alias rasters; New, Edit, Delete, Import, Export | Preset list stored as JSON used by Flatten Transparency and PDF/EPS export; see formats page. | Missing | M | later |
| Print Presets | Manage print presets | Pointer to the printing page. | Missing | S | later |
| Adobe PDF Presets | Manage PDF presets (High Quality Print, PDF/X-1a, X-3, X-4, Press Quality, Smallest File Size) | Pointer to the PDF export page; presets as JSON. | Missing | M | next |
| SWF Presets (?) | Flash export presets; Flash export was removed in recent versions | Not planned; SWF is obsolete. | Missing | S | later |
| Perspective Grid Presets | Name, type (1/2/3-point), units, scale, gridline every, viewing angle/distance, horizon height, third vanishing point, grid colours and opacity | Pointer to the Perspective page; presets as JSON. | Missing | S | later |
| Color Settings | Working spaces RGB/CMYK, color management policies, profile mismatch prompts, conversion engine and intent, black point compensation; Synchronize via Bridge | Pointer to the colour management page; Nib uses lcms2 (wasm) with a settings dialog. | Missing | L | next |
| Assign Profile | Don't Color Manage, working profile, or a chosen profile | Pointer to the colour management page. | Missing | S | next |
| Keyboard Shortcuts | Sets (Illustrator Defaults, custom), Tools and Menu Commands lists, search, conflicts warning, Export Text, Save set | Shortcut editor over the command registry; sets stored as JSON; import of Illustrator .kys (?) | Missing | M | core |
| My Settings / Sync Settings | Sync preferences, presets, shortcuts through Creative Cloud | Not feasible (Adobe cloud); substitute: Export/Import Settings to a file the user can put in any synced folder. | Not feasible | S | n/a |
| Preferences | Edit > Preferences (Windows) / Illustrator > Settings (macOS) | Pointer to the document/application page. | Missing | M | core |

### Object > Transform

| Feature | What Illustrator does (options that matter) | Nib plan | Status | Effort | Tier |
|---|---|---|---|---|---|
| Transform Again | Ctrl+D repeats the last transform (including a copy) on the current selection | Store the last transform command and its parameters; replay. | Missing | S | core |
| Move dialog | Horizontal, Vertical, Distance, Angle; Transform Objects / Transform Patterns; Preview; Copy. Opened by double-clicking Selection tool or Enter | Dialog building a translate matrix; pattern-only option shifts the fill's pattern transform. | Missing | S | core |
| Rotate dialog | Angle; Transform Objects/Patterns; Preview; Copy; origin from the Rotate tool click or bounding box centre | Rotate matrix around the chosen origin. | Missing | S | core |
| Reflect dialog | Axis Horizontal, Vertical, or Angle; Objects/Patterns; Preview; Copy | Scale(-1) about an axis through the origin. | Missing | S | core |
| Scale dialog | Uniform %, Non-Uniform horizontal/vertical %; Scale Corners; Scale Strokes & Effects; Objects/Patterns; Preview; Copy | Scale matrix; options scale stroke widths, corner radii and effect parameters. | Missing | S | core |
| Shear dialog | Shear Angle; Axis Horizontal/Vertical/Angle; Objects/Patterns; Preview; Copy | Skew matrix around origin. | Missing | S | next |
| Transform Each | Scale H/V, Move H/V, Rotate angle, Options (Transform Objects/Patterns, Scale Strokes & Effects), Reflect X, Reflect Y, reference point, Random, Preview, Copy | Apply the composed matrix to each object about its own reference point; Random uses a seeded generator within the given limits. | Missing | M | next |
| Reset Bounding Box | Realigns the bounding box with the page axes after rotation | Each node keeps a box orientation; reset sets it to the identity. | Missing | S | core |
| Bounding box rotation retained | After rotating, the bounding box stays rotated with the object | Store a box rotation on each node separate from the path geometry. | Missing | M | core |
| Transform Patterns only (~ drag) | Holding ~ while transforming moves only the pattern fill | Modifier sets transform target to fill pattern transform. | Missing | S | next |
| Rotate tool / Scale / Reflect / Shear tools | Click to set origin, drag; Alt-click opens dialog with that origin; Shift constrains | Tools in the toolbar page; they emit the same commands as the dialogs. | Missing | M | core |
| Free Transform tool and widget | Constrain, Free Transform, Perspective Distort, Free Distort | Toolbar page; perspective/free distort converts to an envelope-like distortion of points. | Missing | M | next |

### Object > Arrange, Group, Lock, Hide

| Feature | What Illustrator does (options that matter) | Nib plan | Status | Effort | Tier |
|---|---|---|---|---|---|
| Bring to Front / Bring Forward / Send Backward / Send to Back | Shift+Ctrl+], Ctrl+], Ctrl+[, Shift+Ctrl+[; within the layer; Forward/Backward skips non-overlapping objects (?) | Reorder in the parent's child list; Forward/Backward step to the next overlapping sibling. | Missing | S | core |
| Send to Current Layer | Moves the selection to the layer highlighted in the Layers panel | Reparent nodes to the active layer, keeping z-order. | Missing | S | core |
| Group / Ungroup | Ctrl+G / Shift+Ctrl+G; groups nest; ungroup releases one level | Group node in the scene tree; ungroup lifts children, keeping transforms and appearance. | Missing | S | core |
| Isolation mode | Double-click a group, symbol, path or layer to edit it alone; breadcrumb bar; Esc exits | Edit context stack; dim everything outside; breadcrumb bar above the canvas. | Missing | M | core |
| Lock > Selection | Ctrl+2 | Locked flag on nodes, honoured by hit-testing. | Missing | S | core |
| Lock > All Artwork Above | Locks every object above the selected one that overlaps it (?) | Lock nodes higher in the stack whose bounds intersect. | Missing | S | next |
| Lock > Other Layers | Locks every layer but the one with the selection | Toggle locked on sibling layers. | Missing | S | next |
| Unlock All | Alt+Ctrl+2; unlocked objects become selected | Clear locked flags in the current context and select them. | Missing | S | core |
| Hide > Selection / All Artwork Above / Other Layers | Ctrl+3 and variants | Hidden flag, like Lock. | Missing | S | core |
| Show All | Alt+Ctrl+3; reveals and selects hidden objects | Clear hidden flags and select. | Missing | S | core |

### Object > Expand, Rasterize and conversions

| Feature | What Illustrator does (options that matter) | Nib plan | Status | Effort | Tier |
|---|---|---|---|---|---|
| Expand | Expand: Object, Fill, Stroke; Expand Gradient To: Gradient Mesh or Specify N objects; for symbols, blends, live paint, envelopes, text | Per-type expand functions turning live objects into plain paths and groups. | Missing | M | core |
| Expand Appearance | Converts effects, multiple fills/strokes and brushes into real objects | Render the appearance stack to geometry (stroke outline, offset, effects) and replace the node with a group. | Missing | L | next |
| Crop Image | Crop widget on a placed raster with W/H fields; embeds the cropped pixels; PPI option; Apply/Cancel | Crop rectangle stored on image nodes; Apply resamples and embeds via canvas. | Missing | S | next |
| Rasterize | Color Model (CMYK/RGB/Grayscale/Bitmap), Resolution (Screen 72/Medium 150/High 300/Other/Use Document Raster Effects Resolution), Background White/Transparent, Anti-aliasing (None/Art Optimized/Type Optimized), Create Clipping Mask, Add N around object, Preserve spot colours | Render the selection with the canvas renderer at the chosen ppi and replace it with an embedded image node. | Missing | M | next |
| Create Gradient Mesh | Rows, Columns, Appearance (Flat, To Center, To Edge), Highlight % | Coons-patch mesh node; see the Paint page for mesh editing. | Missing | L | later |
| Create Object Mosaic | Current/New size, Tile spacing, Number of tiles, Options: Constrain ratio, Result Color/Gray, Resize using percentages, Delete raster, Use Ratio | Sample the raster in cells and emit a grid of filled rectangles. | Missing | S | later |
| Create Trim Marks | Adds editable crop marks around the selection (Japanese/Roman style from Preferences) | Generate stroke paths at the bounds with the configured offset and length. | Missing | S | later |
| Flatten Transparency | Preset, Raster/Vector Balance, resolutions, Convert All Text/Strokes to Outlines, Clip Complex Regions, Anti-alias Rasters, Preserve Alpha/Overprints/spot colours, Preview | Approximate: planar-map the overlapping transparent areas and rasterize the complex regions; only for PDF/EPS without transparency. | Missing | L | later |
| Make Pixel Perfect (v)(?) | Aligns the selected vector paths to the pixel grid (Object > Make Pixel Perfect); search did not confirm it in the current menu | Snap anchors and stroke widths to whole or half pixels depending on stroke parity. | Missing | S | next |
| Align to Pixel Grid (object property) | Per-object flag in the Transform panel; new objects aligned when the document is pixel-aligned | Flag on nodes enforced after each transform. | Missing | S | next |

### Object > Slice

| Feature | What Illustrator does (options that matter) | Nib plan | Status | Effort | Tier |
|---|---|---|---|---|---|
| Slice > Make | Makes object slices from the selection | Slice nodes in the document tree bound to an object or rectangle. | Missing | M | later |
| Slice > Release | Removes slice from the object | Delete the slice node. | Missing | S | later |
| Slice > Create from Guides / Create from Selection | Slices from guides or from selection bounds | Generate rect slices. | Missing | S | later |
| Slice > Duplicate Slice, Combine Slices, Divide Slices | Divide horizontally/vertically into N or by pixel size | Rect operations on slice nodes. | Missing | S | later |
| Slice > Delete All / Slice Options / Clip to Artboard | Slice Options: type Image/No Image/HTML Text, name, URL, target, Alt, background colour | Store options; used by the export page. | Missing | S | later |
| Collect for Export (v) | Object > Collect for Export > As Single Asset / As Multiple Assets; adds to Asset Export panel | Asset list stored in the document; exported by the Export for Screens page. | Missing | S | next |

### Object > Path

| Feature | What Illustrator does (options that matter) | Nib plan | Status | Effort | Tier |
|---|---|---|---|---|---|
| Join | Ctrl+J; with two endpoints selected, joins with a segment; with whole open paths, joins nearest ends; coincident points merge; Alt+Shift+Ctrl+J joins with a smooth/corner dialog (?) | Match endpoints by distance; append subpaths; merge points within tolerance. | Missing | S | core |
| Average | Alt+Ctrl+J; Horizontal, Vertical, or Both | Move selected anchors to their mean x and/or y. | Missing | S | next |
| Outline Stroke | Converts strokes into filled paths respecting caps, joins, miter limit, dashes, arrowheads and variable width | Stroke-to-outline using Bezier offsetting (like paper.js / Skia stroker) then a boolean union to clean overlaps. | Missing | L | core |
| Offset Path | Offset distance (negative allowed), Joins (Miter, Round, Bevel), Miter limit, Preview | Bezier offset per segment, join handling, then union to remove self-intersections. | Missing | L | core |
| Reverse Path Direction | Reverses point order (also in Attributes panel for compound path fill rule) | Reverse segment arrays. | Missing | S | core |
| Simplify | Slider (fewer/more anchors), Auto-Simplify; More Options: Simplify Curve %, Corner Point Angle Threshold, Convert to Straight Lines, Show Original, Keep Preview; on-canvas slider widget | Sample the path and refit with Schneider's curve fitting at the slider's tolerance; corners kept by angle threshold. | Missing | M | next |
| Smooth tool | Pointer: Toolbar page | See tools page. | Missing | S | next |
| Add Anchor Points | Adds one anchor midway in each segment | Split every segment at t=0.5. | Missing | S | core |
| Remove Anchor Points | Removes selected anchors without breaking the path, reshaping neighbours | Delete anchors and refit the adjacent segments to approximate the old shape. | Missing | S | core |
| Divide Objects Below (v) | Uses the selected path as a cookie cutter on everything below it; the cutter is discarded | Boolean divide of each underlying object with the cutter path. | Missing | M | next |
| Split Into Grid (v) | Rows/Columns: Number, Height, Gutter, Total; Add Guides; Preview; topmost object's appearance | Generate a grid of rectangles within the bounds; optional guides. | Missing | S | next |
| Clean Up | Delete: Stray Points, Unpainted Objects, Empty Text Paths | Walk the tree and delete matching nodes. | Missing | S | core |
| Path > Cut path at selected anchor | Control/Properties panel button splits at selected anchors | Split command on anchors (see Anchor point editing). | Missing | S | core |

### Object > Shape (Live Shapes)

| Feature | What Illustrator does (options that matter) | Nib plan | Status | Effort | Tier |
|---|---|---|---|---|---|
| Shape > Convert to Shapes | Turns rectangle-, ellipse- and polygon-like paths into live shapes | Recognise exact rect/ellipse/regular polygon geometry and swap in a parametric node. | Missing | S | next |
| Shape > Expand Shape | Turns a live shape into a plain path | Generate path geometry from parameters. | Missing | S | core |
| Live rectangle / rounded rectangle | W, H, rotation, per-corner radius and type (Round, Inverted Round, Chamfer); Link corner radii; Scale Rectangle Corners | Parametric rect node with four corner records. | Missing | M | core |
| Live ellipse and pie | W, H, rotation, Pie Start Angle, Pie End Angle, Constrain pie angles, Invert Pie; pie widgets on canvas | Parametric ellipse node with start/end angles. | Missing | S | core |
| Live polygon | Number of sides, side length, radius, rotation, corner types; Make Sides Equal; side widget on canvas | Parametric polygon node. | Missing | S | core |
| Live line | Length, angle | Parametric line node. | Missing | S | core |
| Star tool shapes (not live) | Radius 1, Radius 2, Points; becomes plain path | Toolbar page; generate path. | Missing | S | core |
| Shaper tool live shapes | Shaper-drawn shapes and Shaper Groups | See the tools page (Shaper and Shape Builder). | Missing | L | later |

### Object > Pattern

| Feature | What Illustrator does (options that matter) | Nib plan | Status | Effort | Tier |
|---|---|---|---|---|---|
| Pattern > Make | Enters pattern editing mode and opens Pattern Options | Pattern edit context with live tile preview drawn by repeating the tile. | Missing | L | next |
| Pattern Options panel | Name; Tile Type (Grid, Brick by Row, Brick by Column, Hex by Column, Hex by Row); Brick Offset; Width/Height; Size Tile to Art; Move Tile with Art; H/V Spacing; Overlap (Left/Right/Top/Bottom in front); Copies (1x1 to 9x9); Dim Copies to %; Show Tile Edge; Show Swatch Bounds; Save a Copy, Done, Cancel | Pattern swatch stores tile geometry and layout; rendering uses an SVG pattern / canvas pattern for grid and computed offsets for brick and hex. | Missing | L | next |
| Pattern Tile tool | Drag the tile bounds in pattern edit mode | Handles on the tile rectangle. | Missing | S | next |
| Pattern > Edit Pattern | Edits the pattern in the selected fill | Reopen pattern edit context for that swatch. | Missing | S | next |
| Pattern > Tile Edge Color | Colour of tile edge display | Preference. | Missing | S | later |
| Transform patterns with objects | Preferences option and per-transform checkbox | Pattern transform on each fill, updated when the option is on. | Missing | S | next |
| Text to Pattern (v) | Firefly generates seamless vector patterns from a prompt (29.5) | Not feasible with Firefly; substitute: the user's own OpenAI or Gemini key returns an image or SVG tile, traced or used as a pattern. | Not feasible | M | n/a |

### Object > Repeat

| Feature | What Illustrator does (options that matter) | Nib plan | Status | Effort | Tier |
|---|---|---|---|---|---|
| Repeat > Radial (v) | Live radial repeat around a centre; on-canvas handles for radius and instance count; splitter to remove instances | Repeat node with a source group and parameters; instances drawn as transformed references. | Missing | M | next |
| Radial options (v) | Number of instances (default 8), Radius, Reverse Overlap | Parameters on the repeat node. | Missing | S | next |
| Repeat > Grid (v) | Live grid repeat with drag handles for spacing and extent | Repeat node with rows/cols computed from the bounding box. | Missing | M | next |
| Grid options (v) | Horizontal and vertical spacing, Grid Type (Grid, Brick by Row, Brick by Column), Flip Row, Flip Column (horizontal/vertical axis) | Parameters on the repeat node. | Missing | S | next |
| Repeat > Mirror (v) | Live mirror across an adjustable axis (default 90°); edit one half in isolation | Mirror node drawing the reflected copy of its source. | Missing | S | next |
| Repeat > Release | Turns the repeat back into the source art | Remove the repeat wrapper. | Missing | S | next |
| Repeat > Options | Dialog for the type's options | Shared options dialog. | Missing | S | next |
| Editing repeat source in isolation | Double-click enters isolation mode on the source; changes update instances live | Isolation context on the repeat's source group. | Missing | S | next |
| Expand repeat | Object > Expand turns instances into plain groups (and clip group for mirror) | Generate real copies. | Missing | S | next |

### Object > Blend and the Blend panel

| Feature | What Illustrator does (options that matter) | Nib plan | Status | Effort | Tier |
|---|---|---|---|---|---|
| Blend > Make | Alt+Ctrl+B; interpolates shape, colour and position between selected objects | Blend node holding the key objects and a spine; intermediates computed by matching anchor counts and interpolating. | Missing | L | next |
| Blend > Release | Alt+Shift+Ctrl+B | Remove blend wrapper, keep keys and spine. | Missing | S | next |
| Blend > Expand | Turns steps into a group of paths | Generate the intermediate paths. | Missing | S | next |
| Blend Options: Spacing | Smooth Color, Specified Steps (N), Specified Distance | Step count derived from colour distance, number or spine length. | Missing | S | next |
| Blend Options: Orientation | Align to Page, Align to Path | Rotate steps by spine tangent when aligned to path. | Missing | S | next |
| Blend > Replace Spine | Uses a selected path as the blend's spine | Swap the spine path. | Missing | S | next |
| Blend > Reverse Spine | Reverses the order of the key objects along the spine | Reverse key order. | Missing | S | next |
| Blend > Reverse Front to Back | Reverses stacking order of the steps | Flip draw order. | Missing | S | next |
| Blend tool | Click anchor to anchor to control the correspondence; double-click opens options | Toolbar page; the tool records chosen anchor correspondences on the blend. | Missing | S | next |
| Editing blend keys and spine live | Direct Selection on keys or spine updates the blend | Blend recalculates on child change. | Missing | M | next |
| Blend panel (v) | 30.7: dedicated panel with Make, Expand, Release, Reverse Spine, Replace Spine and live on-canvas preview | A panel over the blend node parameters. | Missing | S | next |
| Blend easing (v) | 30.7: Ease In, Ease Out, Ease In/Out, Ease Out/In with a Ramp slider 0-100%; only with Specified Steps; needs a spine | Map step parameter t through an easing curve whose strength is the ramp value. | Missing | S | later |
| Blend Color Shift (v) | 30.7: Shift slider changes how fast colours change without moving steps; not with Smooth Color | Separate easing applied to colour interpolation only. | Missing | S | later |

### Object > Envelope Distort

| Feature | What Illustrator does (options that matter) | Nib plan | Status | Effort | Tier |
|---|---|---|---|---|---|
| Make with Warp | Alt+Shift+Ctrl+W; Style (Arc, Arc Lower, Arc Upper, Arch, Bulge, Shell Lower, Shell Upper, Flag, Wave, Fish, Rise, Fisheye, Inflate, Squeeze, Twist), Horizontal/Vertical, Bend %, Distortion Horizontal/Vertical %, Preview | Warp styles defined as mesh deformations; contents' anchors mapped through the mesh and segments subdivided for accuracy. | Missing | L | next |
| Make with Mesh | Alt+Ctrl+M; Rows, Columns | Envelope node with a bicubic mesh of control points edited with Direct Selection. | Missing | L | next |
| Make with Top Object | Alt+Ctrl+C; the top path becomes the envelope shape | Approximate: build a Coons patch from the top path split into four sides and map contents through it. | Missing | L | next |
| Release | Returns contents and the envelope (as a mesh object or path) | Unwrap the node. | Missing | S | next |
| Envelope Options | Rasters: Anti-Alias, Preserve Shape Using Clipping Mask/Transparency; Fidelity %; Distort Appearance; Distort Linear Gradients; Distort Pattern Fills | Fidelity sets subdivision tolerance; flags decide whether appearance is expanded before mapping. | Missing | M | next |
| Expand | Applies the distortion permanently | Bake mapped geometry. | Missing | S | next |
| Edit Contents / Edit Envelope | Shift+Ctrl+V toggle between editing the contents and the envelope | Edit target flag on the envelope node. | Missing | S | next |
| Reset with Warp / Reset with Mesh | Changes the envelope type and parameters on an existing envelope | Regenerate the mesh from the new style. | Missing | S | next |
| Envelope with raster contents | Distorts placed images | Render the image through the mesh with WebGL texture mapping. | Missing | M | later |

### Object > Perspective

| Feature | What Illustrator does (options that matter) | Nib plan | Status | Effort | Tier |
|---|---|---|---|---|---|
| Perspective > Attach to Active Plane | Attaches selected art to the current grid plane | Store plane id and plane coordinates on the node. | Missing | M | later |
| Perspective > Release with Perspective | Detaches the art, keeping its current look | Clear the plane binding. | Missing | S | later |
| Perspective > Move Plane to Match Object | Moves the plane to the object's depth | Compute plane offset from object. | Missing | S | later |
| Perspective > Edit Text | Edits text attached to a plane | Isolation on the source text. | Missing | S | later |
| Perspective Grid and Perspective Selection tool | View > Perspective Grid, 1/2/3-point, plane widget, keys 1/2/3/4 to switch planes | Pointer to the tools and view page. | Missing | XL | later |

### Object > Live Paint

| Feature | What Illustrator does (options that matter) | Nib plan | Status | Effort | Tier |
|---|---|---|---|---|---|
| Live Paint > Make | Alt+Ctrl+X; turns selected paths into a Live Paint group whose faces and edges can be coloured | Planar graph (arrangement) of all path segments; faces and edges carry fills and strokes, recomputed on edit. | Missing | XL | later |
| Live Paint > Merge | Adds more paths to an existing group | Insert segments into the arrangement. | Missing | M | later |
| Live Paint > Release | Back to plain paths with 0.5 pt black stroke, no fill | Emit original paths. | Missing | S | later |
| Live Paint > Gap Options | Gap Detection, Paint stops at Small/Medium/Large/Custom gaps, Gap Preview Color, Close Gaps with Paths, Preview, gaps found count | Approximate: close gaps by adding virtual edges between endpoints within the gap distance. | Missing | M | later |
| Live Paint > Expand | Converts faces and edges into separate filled/stroked paths | Emit faces as paths grouped, edges as strokes. | Missing | M | later |
| Live Paint Bucket / Live Paint Selection tools | Paint Fills, Paint Strokes, Cursor Swatch Preview, Highlight colour/width; Shift for strokes; double-click fills adjacent same-colour | Pointer to the tools page; they act on the arrangement. | Missing | M | later |
| Live Paint face colours preserved on edit | Editing paths keeps fills where faces still exist | Track faces by sample points and reassign after recompute. | Missing | M | later |

### Object > Image Trace and the Image Trace panel

| Feature | What Illustrator does (options that matter) | Nib plan | Status | Effort | Tier |
|---|---|---|---|---|---|
| Image Trace > Make | Traces a placed raster with the Default preset; live trace object | Trace node keeping the source image and options; vectorise with a potrace-style algorithm (black and white) and colour quantisation plus region tracing (colour). | Missing | L | next |
| Image Trace > Make and Expand | Traces and expands at once | Make then Expand in one command. | Missing | S | next |
| Image Trace > Release | Back to the image | Unwrap. | Missing | S | next |
| Image Trace > Expand | Turns the trace into paths | Bake output. | Missing | S | next |
| Presets (v) | Default, High Fidelity Photo, Low Fidelity Photo, 3 Colors, 6 Colors, 16 Colors, Shades of Gray, Black and White Logo, Sketched Art, Silhouettes, Line Art, Technical Drawing; Custom | Preset JSON files mapping to the options below. | Missing | S | next |
| Enhanced presets (v) | 29.3: enhanced presets with built-in Gradients, Shapes, Transparency and Auto Grouping; Enhanced Presets toggle versus Legacy | Approximate: gradient fitting per region, shape detection (circle/rect fitting) and grouping by colour. | Missing | L | later |
| Auto Grouping (v) | Groups trace paths logically | Group output regions by colour and adjacency. | Missing | M | later |
| Manage Presets (v) | Save as new, delete, rename, import/export presets | User presets folder. | Missing | S | next |
| View | Tracing Result, Tracing Result with Outlines, Outlines, Outlines with Source Image, Source Image; eye toggle | Render modes on the trace node. | Missing | S | next |
| Mode | Color, Grayscale, Black and White | Branches of the tracer. | Missing | S | next |
| Palette | Limited, Full Tone, Automatic, Document Library (a swatch library) | Quantise with k-means/median cut to N colours, or to the given swatch set. | Missing | M | next |
| Colors / Grays / Threshold | Colors slider (Limited/Automatic), Grays %, Threshold 0-255 for B&W | Parameters of quantisation and binarisation. | Missing | S | next |
| Advanced: Paths, Corners, Noise | Paths % (fitting tightness), Corners % (corner likelihood), Noise px (ignored area) | Curve fit tolerance, corner angle threshold, minimum region area (despeckle). | Missing | M | next |
| Advanced: Method | Abutting (cutout) or Overlapping (stacked) | Stacked output fills holes beneath lighter regions. | Missing | M | next |
| Advanced: Create Fills / Strokes, Max stroke width | Strokes trace thin lines as centrelines up to the max width | Centreline tracing via skeletonisation for thin regions. | Missing | L | later |
| Advanced: Snap Curves To Lines | Straightens nearly straight curves | Post-process segments under a curvature threshold. | Missing | S | next |
| Advanced: Ignore White | Drops white regions | Skip regions whose colour is white. | Missing | S | next |
| Information readout | Paths, Anchors, Colors counts | Counts from output. | Missing | S | next |
| Trace from Contextual Task Bar and Properties (v) | Default preset from the Contextual Task Bar; presets in Properties | Quick action buttons. | Missing | S | next |
| Image Trace on raster in place of copy | Tracing preserves the image for retracing; Preview toggle | Trace node retains image. | Missing | S | next |

### Object > Text Wrap, Clipping Mask, Compound Path

| Feature | What Illustrator does (options that matter) | Nib plan | Status | Effort | Tier |
|---|---|---|---|---|---|
| Text Wrap > Make / Release | Wraps area text around the object above it | Wrap flag on nodes; area-type layout subtracts the offset outline (Type page). | Missing | M | next |
| Text Wrap Options | Offset, Invert Wrap, Preview | Offset path of the wrap object. | Missing | S | next |
| Clipping Mask > Make | Ctrl+7; topmost object clips the rest; clip group | Clip group node; the first child's geometry is the clip path; rendered with canvas clip / SVG clipPath. | Missing | M | core |
| Clipping Mask > Release | Alt+Ctrl+7; mask path loses fill and stroke | Unwrap; restore clip path as a no-paint path. | Missing | S | core |
| Clipping Mask > Edit Mask / Edit Contents | Toggle between mask and contents (also in Control panel) | Select the clip path or the content children. | Missing | S | core |
| Layer clipping masks | Make/Release Clipping Mask in the Layers panel flyout clips the whole layer | Layer flag making its first child a clip. | Missing | S | next |
| Clip with compound path or text | Compound paths and text objects can act as masks | Clip path built from compound geometry or text outlines. | Missing | S | next |
| Draw Inside / Draw Behind / Draw Normal | Shift+D cycles; Draw Inside creates a clip group on the selected object | Drawing-mode state that inserts new art into a clip group. | Missing | S | next |
| Compound Path > Make | Ctrl+8; combines paths, holes where overlapping per the fill rule | Compound path node with subpaths sharing one appearance. | Missing | S | core |
| Compound Path > Release | Alt+Shift+Ctrl+8 | Split subpaths into separate paths keeping appearance. | Missing | S | core |
| Fill rule: Non-Zero / Even-Odd | Attributes panel; Reverse Path Direction toggles holes in non-zero | fillRule on path nodes, maps to canvas and SVG fill-rule. | Missing | S | core |
| Attributes panel extras | Overprint Fill/Stroke, Show Center, Image Map, URL, Browser | Per-node attributes, overprint used in PDF export. | Missing | S | later |

### Object > Graph

| Feature | What Illustrator does (options that matter) | Nib plan | Status | Effort | Tier |
|---|---|---|---|---|---|
| Graph tools | Column, Stacked Column, Bar, Stacked Bar, Line, Area, Scatter, Pie, Radar; drag or click for W/H | Graph node holding data and type; draws groups of shapes. | Missing | L | later |
| Graph > Type | Type, Value Axis position, Style (Add Drop Shadow, Add Legend Across Top, First Row in Front, First Column in Front), Options (Column Width, Cluster Width, Mark Data Points, Connect Data Points, Edge-to-Edge, Draw Filled Lines, Legend, Sort, Position) | Options on the graph node. | Missing | M | later |
| Graph > Data | Spreadsheet window: import data, transpose, switch X/Y, cell style, revert, apply | Grid editor; import CSV. | Missing | M | later |
| Graph > Design / Column / Marker | Define a graph design from art; column design types Vertically Scaled, Uniformly Scaled, Repeating, Sliding | Design references by symbol id. | Missing | M | later |
| Graph axis options | Tick values (min/max/divisions), tick marks length, labels prefix/suffix | Axis settings. | Missing | S | later |

### Object > Intertwine, Objects on Path, Mockup, and other recent commands

| Feature | What Illustrator does (options that matter) | Nib plan | Status | Effort | Tier |
|---|---|---|---|---|---|
| Intertwine > Make (v) | Non-destructively interweaves overlapping objects; draw around an overlap to bring one object forward there; not with Live Paint, Repeat, graphs | Intertwine node: original objects plus a list of zones (closed paths) with a chosen front object; render by clipping the front object to each zone and drawing it on top. | Missing | M | next |
| Intertwine > Edit (v) | Edit zones; Alt to send back; zone editing via lasso-like drawing | Edit mode adding or removing zones. | Missing | S | next |
| Intertwine > Release (v) | Back to original objects | Unwrap. | Missing | S | next |
| Objects on Path (v) | Select objects, choose Objects on Path, click a path; objects arranged and rotated along it; options for spacing, offset, rotation (?) | Live node placing children at equal arc-length steps with tangent rotation; options for start offset and alignment. | Missing | M | next |
| Mockup (v) | Places artwork onto product photos with perspective and warp, using Adobe's model to fit the surface | Not feasible with Adobe's model; substitute: Approximate: user places a photo, adjusts a four-corner perspective or mesh envelope, art drawn with Multiply blend. | Not feasible | M | n/a |
| Generative Shape Fill (v) | Prompt fills a shape with vector detail (Firefly Vector model), Contextual Task Bar | Not feasible; substitute: user's own OpenAI or Gemini key generates an SVG or image, traced and clipped into the shape. | Not feasible | M | n/a |
| Text to Vector Graphic (v) | Generates Scenes, Subjects, Icons, Patterns from a prompt, style reference, detail level; Auto Select chooses or compares partner models (30.2-30.3) | Not feasible; substitute: user's own API key with SVG or image output plus Image Trace. | Not feasible | M | n/a |
| Generative Expand (v) | 30.4: extends artwork beyond its bounds | Not feasible; substitute: own-key image outpainting for raster content. | Not feasible | M | n/a |
| Turntable (v) | 30.0 beta: generates rotated views of 2D vector art | Not feasible (Adobe model); no faithful substitute. | Not feasible | S | n/a |
| Contextual Task Bar | Floating bar under the selection with next actions (Image Trace, Repeat, Recolor, Generate, Mask, Lock, etc.) | Context-sensitive bar fed by the command registry's "suggested next" list. | Missing | M | next |
| Properties panel Quick Actions | Per-selection buttons: Expand, Make Clipping Mask, Start Global Edit, Recolor, Arrange, Pathfinder, Align | Panel showing registry commands enabled for the selection. | Missing | M | core |
| Puppet Warp tool | Adds pins (auto-placed), drag to deform, rotate around pin, Alt-click delete, Show Mesh, Expand Mesh, Select All Pins | Approximate: ARAP deformation of a triangulated mesh over the selection, then map anchors through the mesh. | Missing | L | later |
| Dimension tool (v) | Linear, angular and radial dimension annotations that update with the object | Pointer to the tools page. | Missing | M | later |
| Retype (v) | Identifies fonts in images and outlined text (Adobe model and Adobe Fonts) | Not feasible (Adobe model and Adobe Fonts); substitute: user-supplied font files and manual font choice; pointer to the Type page. | Not feasible | M | n/a |

### Object > Artboards (pointer)

| Feature | What Illustrator does (options that matter) | Nib plan | Status | Effort | Tier |
|---|---|---|---|---|---|
| Artboards > Convert to Artboards | Turns selected rectangles into artboards | Pointer to the document page. | Missing | S | core |
| Artboards > Rearrange All | Layout, columns, spacing, move artwork with artboard | Pointer to the document page. | Missing | S | next |
| Artboards > Fit to Artwork Bounds / Fit to Selected Art | Resize the artboard to art | Pointer to the document page. | Missing | S | core |

### Select menu

| Feature | What Illustrator does (options that matter) | Nib plan | Status | Effort | Tier |
|---|---|---|---|---|---|
| All | Ctrl+A; selects everything unlocked and visible in the current context | Walk the active context. | Missing | S | core |
| All on Active Artboard | Alt+Ctrl+A | Filter by intersection with the artboard. | Missing | S | core |
| Deselect | Shift+Ctrl+A | Clear the selection. | Missing | S | core |
| Reselect | Ctrl+6; repeats the last Same or Object selection command | Store the last select command and replay. | Missing | S | next |
| Inverse | Selects every unselected unlocked object | Set complement. | Missing | S | core |
| Next Object Above / Below | Alt+Ctrl+] / Alt+Ctrl+[; steps the selection through the stacking order | Move to next sibling in z-order (flattened). | Missing | S | next |
| Same > Appearance (v) | Same appearance stack (fills, strokes, effects); can select broadly | Compare serialised appearance stacks. | Missing | S | next |
| Same > Appearance Attribute | Same effect/attribute picked in the Appearance panel | Compare that appearance item. | Missing | S | later |
| Same > Blending Mode | Same blend mode | Compare property. | Missing | S | next |
| Same > Fill & Stroke | Same fill and stroke colour and stroke weight | Compare paints and weight. | Missing | S | core |
| Same > Fill Color | Same fill (tints of same spot colour count as same) | Compare fill paint; option to include tints. | Missing | S | core |
| Same > Opacity | Same opacity | Compare property. | Missing | S | next |
| Same > Stroke Color | Same stroke colour | Compare stroke paint. | Missing | S | core |
| Same > Stroke Weight | Same stroke weight | Compare property. | Missing | S | core |
| Same > Graphic Style | Same graphic style | Compare style id. | Missing | S | next |
| Same > Shape | Same live shape type (rect, ellipse, polygon) (?) | Compare live shape type. | Missing | S | later |
| Same > Symbol Instance | Instances of the same symbol | Compare symbol reference. | Missing | S | next |
| Same > Link Block Series | Threaded text frames of the same story | Compare story id. | Missing | S | later |
| Same > Text: Font Family, Font Family & Style, Font Family Style & Size, Font Size, Text Fill Color, Text Stroke Color, Text Fill & Stroke Color | Text attribute matches | Compare text run attributes; see Type page. | Missing | S | next |
| Select Similar Options (Magic Wand panel) | Fill Color, Stroke Color, Stroke Weight, Opacity, Blending Mode with tolerances; Use All Layers | Pointer to the tools page (Magic Wand); same comparison functions with tolerance. | Missing | S | next |
| Object > All on Same Layers | Everything on the layers of the selection | Filter by layer. | Missing | S | core |
| Object > Direction Handles | Selects all handles of selected paths | Select every handle in Direct Selection state. | Missing | S | next |
| Object > Bristle Brush Strokes | All paths with bristle brushes | Filter by brush type. | Missing | S | later |
| Object > Brush Strokes | All paths with brushes | Filter by brush presence. | Missing | S | next |
| Object > Clipping Masks | All clipping paths | Filter clip paths. | Missing | S | core |
| Object > Stray Points | Single-anchor paths | Filter paths with one anchor. | Missing | S | core |
| Object > All Text Objects / Point Text Objects / Area Text Objects | Text by kind | Filter text kinds. | Missing | S | core |
| Object > Not Aligned to Pixel Grid | Pixel-grid misaligned objects | Test anchors against the grid. | Missing | S | later |
| Object > Text Objects with Overflow | Overset text frames (?) | Filter frames with overflow flag. | Missing | S | next |
| Object > Unpainted Objects (?) | Objects with no fill or stroke | Filter. | Missing | S | next |
| Start Global Edit (v) | Selects all objects similar to the selected one so edits apply to all; options Match Appearance / Size, Include artboards (all, selected, same orientation...), stop with Esc; not for images, text, masks, links | Find objects with the same geometry (normalised path compare) and optional appearance/size; mirror every command on the reference object to the matches with their own transforms. | Missing | M | next |
| Global Edit Options (v) | Match: Appearance, Size; Artboards: All, Selected Artboards, Same orientation and so on; Include objects on canvas (?) | Options on the Global Edit session. | Missing | S | next |
| Save Selection | Names and stores the current selection | Named selection sets stored in the document as node id lists. | Missing | S | next |
| Edit Selection | Rename or delete saved selections | Small dialog. | Missing | S | next |
| Saved selections listed at bottom of Select menu | Choosing one restores it | Dynamic menu items. | Missing | S | next |

### Selection behaviour and modifiers

| Feature | What Illustrator does (options that matter) | Nib plan | Status | Effort | Tier |
|---|---|---|---|---|---|
| Selection tool (V) | Click, Shift-click add/remove, marquee, Alt-drag copy, Shift constrain, bounding box handles | Toolbar page; hit testing on rendered geometry. | Missing | M | core |
| Direct Selection (A) | Select anchors and segments; marquee anchors; Alt-click selects whole path; drag segments | Toolbar page; anchor-level selection model. | Missing | M | core |
| Group Selection | Alt+Direct Selection: each click selects the next group up | Toolbar page. | Missing | S | core |
| Lasso (Q) and Magic Wand (Y) | Freeform anchor selection; similar-attribute selection | Toolbar page. | Missing | S | next |
| Object Selection by Path Only | Preference: select only by clicking the path, not fill | Preference changes hit testing. | Missing | S | next |
| Selection in Outline mode | Clicking only on paths | Hit-testing on outlines in outline view. | Missing | S | core |
| Hidden / locked object exclusion | Locked and hidden objects never selectable | Honour flags. | Missing | S | core |
| Select behind (Ctrl+click) | Ctrl+click selects the object behind (preference "Select Behind") | Cycle through hits at the point. | Missing | S | next |
| Bounding box show/hide | View > Show/Hide Bounding Box (Shift+Ctrl+B) | View option. | Missing | S | core |
| Layers panel target circle | Click the circle to select or target a layer or object | Layers page. | Missing | S | core |

### Pathfinder panel

| Feature | What Illustrator does (options that matter) | Nib plan | Status | Effort | Tier |
|---|---|---|---|---|---|
| Shape Mode: Unite | Union of selected shapes, takes the top object's paint | Boolean union with a robust polygon-clipper on flattened Bezier curves refitted to curves, or a Bezier boolean library (paper.js-style). | Missing | L | core |
| Shape Mode: Minus Front | Subtracts upper objects from the bottom one | Boolean difference. | Missing | S | core |
| Shape Mode: Intersect | Keeps the overlapping area | Boolean intersection. | Missing | S | core |
| Shape Mode: Exclude | Keeps non-overlapping areas | Boolean XOR. | Missing | S | core |
| Compound shapes (Alt+click shape mode) | Alt-click creates a live compound shape; modes editable per component | Compound shape node storing children and per-child mode; result recomputed live. | Missing | M | next |
| Expand (compound shape) | Bakes a compound shape into a path | Bake result. | Missing | S | next |
| Pathfinder: Divide | Splits into all faces; result grouped | Planar arrangement of all paths, each face a path filled from the top covering object. | Missing | M | core |
| Pathfinder: Trim | Removes hidden parts, no merging of same colour, strokes removed | Successive differences from the top down. | Missing | M | core |
| Pathfinder: Merge | Like Trim, but merges adjacent same-fill objects | Trim then union same-fill neighbours. | Missing | S | core |
| Pathfinder: Crop | Clips everything to the top object; top object removed | Intersect each lower object with the top. | Missing | S | core |
| Pathfinder: Outline | Divides into unfilled stroke segments coloured by the fill | Arrangement edges output as strokes. | Missing | S | next |
| Pathfinder: Minus Back | Subtracts lower objects from the top one | Boolean difference reversed. | Missing | S | core |
| Pathfinder Options | Precision (pt), Remove Redundant Points, Divide and Outline Will Remove Unpainted Artwork | Tolerance for curve flattening and merging; post-processing flags. | Missing | S | next |
| Repeat Pathfinder | Ctrl+4 (?) repeats the last pathfinder | Replay last pathfinder command. | Missing | S | next |
| Make Compound Shape / Release Compound Shape / Expand Compound Shape (flyout) | Flyout items | Commands on compound shape node. | Missing | S | next |
| Pathfinder Effects | Effect > Pathfinder (live, on groups) | Pointer to the Effects page. | Missing | M | next |
| Shape Builder tool | Merge/erase regions by dragging | Pointer to the tools page; built on the same arrangement as Divide. | Missing | L | next |

### Align panel

| Feature | What Illustrator does (options that matter) | Nib plan | Status | Effort | Tier |
|---|---|---|---|---|---|
| Align Objects: Left, Horizontal Center, Right, Top, Vertical Center, Bottom | Aligns the selection's bounds | Compute bounds and translate each object. | Missing | S | core |
| Distribute Objects: Top, Vertical Center, Bottom, Left, Horizontal Center, Right | Equal spacing between edges or centres | Sort by position, space evenly between extremes. | Missing | S | core |
| Distribute Spacing: Vertical, Horizontal, with Auto or a value | Equal gaps; with a key object and a value, exact gaps | Compute gaps; with a value, lay out from the key object outward. | Missing | S | core |
| Align To: Selection | Default | Bounds of the selection. | Missing | S | core |
| Align To: Key Object | Click an object to make it the key (thick outline); others align to it | Key object id in selection state. | Missing | S | core |
| Align To: Artboard | Align to the active artboard | Use artboard bounds. | Missing | S | core |
| Use Preview Bounds | Panel flyout/Preferences: align with stroke and effects included | Bounds function with appearance extent. | Missing | S | core |
| Align Key Anchor / anchor point alignment | With Direct Selection anchors selected, aligns anchors (last selected is key) | Align selected anchors instead of objects. | Missing | S | next |
| Align to Pixel Grid in Align panel (?) | Align selected art to pixel grid button | Pixel snap command. | Missing | S | next |
| Align Glyph Bounds for text (Point Text/Area Text) | Flyout: align by glyph bounds, not font metrics | Use outlined glyph bounds for text nodes. | Missing | S | next |
| Align in Properties and Control panels | Compact align buttons with more options | Same commands, compact layout. | Missing | S | core |

### Transform panel and Properties transform section

| Feature | What Illustrator does (options that matter) | Nib plan | Status | Effort | Tier |
|---|---|---|---|---|---|
| Reference point locator | Nine-point origin for X/Y and transforms | Reference point stored in UI state. | Missing | S | core |
| X, Y, W, H fields with math | Accept expressions and units (e.g. 10mm*2); constrain proportions link | Unit-aware expression parser. | Missing | S | core |
| Rotate and Shear fields | Angle presets dropdown | Apply rotation/shear about reference point. | Missing | S | core |
| Flip Horizontal / Vertical (flyout) | Mirror about reference point | Reflect command. | Missing | S | core |
| Scale Strokes & Effects | Option in panel flyout and Preferences | Global option consulted by transforms. | Missing | S | core |
| Scale Corners / Scale Rectangle Corners | Scales live corner radii with transform | Global option. | Missing | S | core |
| Align to Pixel Grid | Per-object checkbox | Object flag. | Missing | S | next |
| Transform Object Only / Pattern Only / Both (flyout) | What transforms affect | Transform target option. | Missing | S | next |
| Show Options | Expands to live shape properties | Panel sections. | Missing | S | core |
| Rectangle Properties | W, H, angle, corner type and radius for each corner, link corners | Bound to live rect node. | Missing | S | core |
| Ellipse Properties | W, H, angle, pie start/end, constrain pie angles, invert pie | Bound to live ellipse node. | Missing | S | core |
| Polygon Properties | Sides, angle, corner type and radius, radius, side length, Make Sides Equal | Bound to live polygon node. | Missing | S | core |
| Line Properties | Length, angle | Bound to live line node. | Missing | S | core |
| Info panel readout | X/Y, W/H, D, angle, colour values while transforming | Status overlay / Info panel. | Missing | S | next |

### Anchor points, segments and Bezier editing

| Feature | What Illustrator does (options that matter) | Nib plan | Status | Effort | Tier |
|---|---|---|---|---|---|
| Path data model | Anchors with in/out handles, smooth or corner, open/closed paths, compound paths | Path node: array of segments {point, handleIn, handleOut, type}, closed flag; subpaths in compound nodes. | Missing | M | core |
| Convert selected anchor to Corner / Smooth | Control/Properties panel buttons | Collapse handles or make them collinear with sensible lengths. | Missing | S | core |
| Anchor Point tool (Shift+C) | Click smooth to make corner, drag corner to pull handles, drag handle to break, drag a segment to reshape | Toolbar page; commands shared with panel buttons. | Missing | S | core |
| Alt drag handle breaks symmetry; Alt with Pen | Pen with Alt toggles anchor conversion | Modifier mapping in tools. | Missing | S | core |
| Show handles for multiple selected anchors | Control panel buttons; Preferences > Selection & Anchor Display: show handles when multiple anchors selected | Option in rendering of selection. | Missing | S | core |
| Hide/show bounding box and anchor styles | Preferences: anchor size, handle style, highlight anchors on mouse over | Preferences for overlay drawing. | Missing | S | next |
| Remove selected anchor points (panel button) | Removes without breaking path | Same as Remove Anchor Points with refit. | Missing | S | core |
| Cut path at selected anchor points | Splits the path at the anchor | Split into two open paths, or open a closed path. | Missing | S | core |
| Connect selected end points | Joins two endpoints (Join) | Join command. | Missing | S | core |
| Delete anchor / segment with Direct Selection | Delete anchor removes adjacent segments | Split behaviour. | Missing | S | core |
| Dragging segments directly | Direct Selection drag on a curve segment reshapes it | Solve handle offsets so the grabbed point follows the cursor. | Missing | S | core |
| Reshape tool | Drag selected anchors and segments with falloff across a path | Pointer to tools page. | Missing | S | later |
| Arrow-key nudging | Moves selection by Keyboard Increment (Preferences); Shift x10 | Nudge command with preference value. | Missing | S | core |
| Corner widgets (live corners) | Circles inside corners; drag to round; Alt-click cycles Round, Inverted Round, Chamfer; double-click opens Corners dialog | Corner records on any path anchor (not only shapes); rendered as generated geometry. | Missing | M | core |
| Corners dialog | Corner type, Radius, Rounding: Relative or Absolute | Corner record parameters; Absolute uses exact arcs, Relative uses circle tangent to segments. | Missing | S | core |
| Hide Corner Widget below angle | Preferences / View > Hide Corner Widget; hides for angles above a threshold | View toggle and preference. | Missing | S | next |
| Max radius indication | Widget turns red when corner can't round further | Clamp radius to segment lengths and show state. | Missing | S | next |
| Live corners on paths after expansion | Corners stay live until Expand or edit | Keep corners as parameters. | Missing | S | core |
| Smart Guides: anchor/path/intersect labels | View > Smart Guides (Ctrl+U): anchor, path, intersect, center, alignment guides, measurement labels, object highlighting, transform tools, construction guides (angles 0/45/90 and custom), snapping tolerance | Pointer to the view/snapping page; anchor editing uses its snap service. | Missing | M | core |
| Snap to Point / Snap to Pixel / Snap to Glyph | View menu options | Pointer to view page. | Missing | S | core |
| Snap to tangents (v)(?) | 30.x snapping to curve tangents (from 2026 review) | Snap service computing tangent points from a point to a curve. | Missing | S | next |
| Path segment info (length) | Document Info / Measure; Info panel | Arc length by Gaussian quadrature. | Missing | S | next |
| Join tool | Scrub over overlapping or gapped paths to join and trim | Pointer to tools page. | Missing | M | next |
| Scissors / Knife / Eraser | Cut paths | Pointer to tools page. | Missing | M | core |
| Width tool profiles | Variable width strokes | Pointer to the Paint/Stroke page. | Missing | L | next |

### Construction helpers and miscellaneous object features

| Feature | What Illustrator does (options that matter) | Nib plan | Status | Effort | Tier |
|---|---|---|---|---|---|
| Symbols: Place, Break Link, Redefine, Dynamic Symbols, 9-slice | Symbols panel and Object > Expand; Edit Symbol | Pointer to the Symbols page; symbol instance nodes referencing definitions. | Missing | L | next |
| Expand on text (Create Outlines) | Type > Create Outlines (Shift+Ctrl+O) | Pointer to Type page. | Missing | M | core |
| Group isolation for editing patterns, symbols, repeats, envelopes, clip groups | Shared isolation-mode infrastructure | One isolation context model. | Missing | S | core |
| Hide edges | View > Hide Edges (Ctrl+H) | View option. | Missing | S | core |
| Outline mode | Ctrl+Y | Pointer to view page. | Missing | M | core |
| Locate Object | Layers panel finds selected object | Pointer to Layers page. | Missing | S | core |
| Recolor-adjacent selection: Select Same Fill Color for spot tints | Select > Same > Fill Color includes tints of the same global swatch | Compare swatch reference, not resolved colour. | Missing | S | next |
| Recolor Artwork "Select colours on art" (?) | Recolor dialog's colour wheel lets you find objects using a colour | Pointer to Paint page; uses Same Fill Color matching. | Missing | S | later |
| Object > Arrange keyboard repeat in isolation | Arrange limited to the isolated group | Arrange works within the isolation context. | Missing | S | core |
| Transform with Selection tool: Shift, Alt, Shift+Alt | Constrain proportions, scale from centre, both; rotate with Shift 45° | Toolbar page modifiers. | Missing | S | core |
| Generate actions in Actions panel for menu commands | Insert Menu Item records commands | Pointer to automation page; every registry command is recordable. | Missing | M | later |

**Counts:** 318 rows. By status: Missing 309, Not feasible 9. By tier: core 121, next 138, later 50, n/a 9.
