# Pigment 0.4: live shapes

Package 13 of 0.4 ("Photoshop parity, stage 2"). Shapes keep their parameters: rectangles their corner radii, polygons
their sides and star options, lines their weight and arrowheads. Edit them in the Properties panel or on the canvas, and
the shape is redrawn from them. Fills and strokes take a solid colour, a gradient or a pattern. Strokes have caps,
corners, dashes and stroke presets. The release also adds the Triangle tool, the shape tools' gear menu, Create dialogs
and Copy / Paste Shape Attributes.

## User guide

### Shape tools

The shape tools are in one toolbox slot (key U; Shift+U steps through them): **Rectangle**, **Rounded Rectangle**,
**Ellipse**, **Triangle** (new), **Polygon**, **Line** and **Custom Shape**.

- **Drag** to draw. Shift keeps the proportions (a square, a circle, a custom shape's own proportions), Alt draws from
  the centre. The Line tool's Shift constrains to 45°.
- **Click** the canvas without dragging to open the **Create** dialog of the shape. It asks for the width and height,
  plus the shape's own values:
  - Rectangle: the four corner radii, linked or not.
  - Triangle: Equilateral and the corner radius.
  - Polygon: Symmetric, the number of sides, the corner radius, the star ratio and the smoothing.
  - Every shape: From Centre.

  The values you enter become the tool's options.
- The options bar shows **Fill** and **Stroke** swatches, the stroke width, the **Stroke Options** menu and the shape's
  own fields: Radius for the Rectangle, Rounded Rectangle and Triangle; Sides and Radius for the Polygon; Weight for the
  Line; the shape for the Custom Shape.
- The **gear** button opens the geometry options:
  - **Path Options**: the thickness and colour that paths are drawn with while you edit them.
  - **Constraints**: Unconstrained, Square (Circle), Fixed Size W × H, Proportional W : H, and From Center. The Custom
    Shape tool also has Defined Proportions and Defined Size.
  - Polygon: **Star ratio** (100 % is a plain polygon), **Smooth Star Indents** and **Smooth Corners**.
  - Line: **Arrowheads** at the start and/or end, with their **Width**, **Length** and **Concavity** in percent of the
    line weight.

Changing the fill or stroke in the options bar while a shape layer is selected restyles that layer. It is one step in
the History.

### Fill and stroke

Click the Fill or Stroke swatch (in the options bar or the Properties panel) to open its menu:

- **No Color**: no fill / no stroke (a red slash on the swatch).
- **Solid Color**: the Color Picker, your recently used colours, and the swatches.
- **Gradient**: the gradient presets, and a gradient bar that opens the Gradient Editor. Under the bar are Style,
  Angle, Scale, Reverse, Dither and Align with Layer. A shape's gradient is placed on the shape: it moves with the
  shape and stays put when the stroke gets wider.
- **Pattern**: the pattern presets, Scale and Angle. The pattern moves with the shape.

**Stroke Options** (the dashed-line button): the stroke presets (Solid, Dashed, Dotted and your own), **Align**
(Inside, Center, Outside), **Caps** (Butt, Round, Square) and **Corners** (Miter, Round, Bevel).

- **More Options…** opens the Stroke dialog, with up to three dash and gap lengths in stroke widths.
- **Save Preset…** names the current stroke style and adds it to the presets.

### Live Shape Properties

Select a shape layer and open Properties (Window › Properties). A live shape shows its own **W**, **H**, **X**, **Y** and
**Angle** instead of the Transform section. The link button keeps the width and height in proportion. X and Y count from
the ruler origin. The shape's own values follow:

- **Rectangle**: the four corner radii. With the link button on, every corner takes the value you type; with it off,
  only the corner you type in changes.
- **Triangle**: the corner radius.
- **Polygon**: Sides, the corner radius, the star ratio, Smooth corners and Smooth star indents.
- **Line**: the end points X1, Y1, X2, Y2, the Weight, and the arrowheads (Start, End) with their Width, Length and
  Concavity.
- **Custom Shape**: which shape.

Under them, **Appearance** has the Fill and Stroke swatches, the stroke width, Stroke Options, **Copy Attributes** and
**Paste Attributes**. Every change is one step in the History. A shape that is no longer live (its anchor points were
edited, or it was skewed) shows only Appearance and the Transform section.

### Corner widgets

With a shape tool or the Path Selection tool, a live rectangle shows a small circle inside each corner:

- Drag a circle to round **every** corner.
- **Alt**-drag a circle to round only that corner.

A triangle has a circle in each corner, and a polygon one in its top corner; dragging either sets the shape's corner
radius.

### Shapes stay live

Moving a shape (Move tool, Path Selection tool, arrow keys, Align and Distribute), Free Transform rotations and
scaling, Image Size, Canvas Size, Crop and Rotate Canvas keep a shape live. A rotation becomes the shape's Angle, and
a scale becomes its size and radii. A skew, a distortion or a perspective change turns the shape into a plain path.
So does a mirror of a custom shape. So does editing anchor points with the Direct Selection, Pen or Convert Point tools,
or combining shapes with a path operation (as in Photoshop).

### Copy / Paste Shape Attributes

**Copy Shape Attributes** remembers the fill and the whole stroke (paint, width, alignment, caps, corners and dashes) of
the active shape layer. **Paste Shape Attributes** applies them to every selected shape layer, as one step in the
History. Use the Copy Attributes / Paste Attributes buttons in Properties, or the commands `layer:copy-shape-attributes`
and `layer:paste-shape-attributes`.

## Release notes (changed defaults and behaviour)

- Shape tools' options bar: the "Fill (foreground)" and "Stroke" check boxes, the stroke colour and the alignment menu
  are replaced by Photoshop's Fill and Stroke swatches and the Stroke Options menu. The stored option keys are the same
  (`fillOn`, `strokeOn`, `strokeColor`, `strokeWidth`, `strokeAlign`), plus `fillPaint`, `strokePaint`, `strokeCap`,
  `strokeJoin` and `strokeDash`. A fill left at its default still uses the foreground colour.
- The Rectangle tool has a Radius field (default 0). The Polygon tool's Star check box and Indent field are replaced by
  the Star ratio in the gear menu; a star set in 0.3 is read as its ratio (100 − indent).
- The Line tool's arrowheads moved into the gear menu. A new arrowhead uses Photoshop's defaults: width 500 %, length
  1000 % of the weight (0.3 drew 5 × the weight, at least 6 px). Lines drawn in 0.3 keep their heads.
- Custom shapes are live shapes (`shapeKind: 'custom'`, the shape is a preset of the Shapes presets). Shift-drag keeps
  the custom shape's own proportions (0.3 drew it in a square). Custom shapes drawn in 0.3 stay plain paths.
- Clicking the canvas with a shape tool opens the shape's Create dialog with more fields. The Line tool still does
  nothing on a click.
- New shapes are written in the 0.4 form (rectangles: `radii` and `angle`; polygons: `starRatio` and the smoothing
  fields; lines: arrowheads as `{ width, length, concavity }`). 0.3 shapes are read without being rewritten until you edit
  them.
- A shape's render box is padded only as far as its stroke reaches: half the width for a centred stroke, the width
  outside, nothing inside, more for miter corners and square caps. 0.3 padded every stroke by its full width, so wide
  outside strokes and long miters were cut off.
- Miter corners use Photoshop's miter limit of 4 (0.3 drew with the browser's 10).
- Dashes are measured in stroke widths. In 0.3 they were in pixels, but no 0.3 tool could make one.
- A shape's gradient and pattern are placed against the shape's own bounds. 0.3 used the render box, which grew with
  the stroke.
- Free Transform, Image Size, Canvas Size, Crop, Rotate Canvas and placing into a smart object keep a shape live (0.3
  left its parameters behind after anything but a move). Rotation goes into the angle and scale into the size; skew and
  perspective make a path.
- Pattern fills and strokes of shapes keep their pixels in the document (`.pigment` files, actions), so they survive a
  save and reopen.

## Known gaps

- Copy / Paste Shape Attributes are not in the Layers panel's context menu yet. That menu belongs to the Layers panel
  work. Until then they are in the Properties panel (Copy Attributes, Paste Attributes).
- Corner widgets show with the shape tools and the Path Selection tool, not yet with the Move tool's transform
  controls.
- A non-uniform scale rounds corner radii by the smaller of the two factors, so the corners stay circular.
- The Line tool has no Create dialog (Photoshop has none either).
- PSD export writes shapes as pixels (as 0.3). The live parameters and stroke options go to PSD with psd-layers (0.5).
- The Stroke dialog has no "Align dashes to corners and path ends" option.
