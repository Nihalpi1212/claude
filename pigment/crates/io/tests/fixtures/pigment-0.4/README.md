# Documents written by Pigment 0.1 to 0.4

These `.pigment` files were written by the JavaScript Pigment's own writer (`writePigment` in
`src/renderer/lib/io.js`), not by hand and not by the importer's authors' idea of the format.
`crates/io/src/legacy_pigment/tests.rs` opens every one of them and checks pixels and fields; the
fuzz test damages them.

The JavaScript app is on the branch `claude/fervent-newton-263lz3` of this repository. Each set
comes from the checkout that wrote that version of `document.json`:

| Files | `document.json` | Written by | Commit |
|---|---|---|---|
| `v1-*.pigment` | version 1 | Pigment 0.2 (the last commit before 0.3's work) | `3731508` |
| `v2-*.pigment` | version 2 | Pigment 0.3.1 (tag `pigment-v0.3.1`) | `b0e43cc` |
| `v3-*.pigment` | version 3 | Pigment 0.4.0 (tag `pigment-v0.4.0`) | `99dbdee` |
| `wip05-*.pigment` | version 3 with `profile` | the unfinished, never released 0.5 (`origin/claude/fervent-newton-263lz3-wip05`) | `e9845fc` |

What each holds (all between 4 × 4 and 32 × 24 pixels):

| File | Holds |
|---|---|
| `*-raster-offset` | a white background and three raster layers away from the origin (one partly left of the canvas, one past its right and bottom edges), with opacity, fill opacity, blend modes, locks, a clipped and hidden layer; 144 ppi |
| `*-groups` | a pass-through group holding a layer, an isolated half-opaque collapsed group (two layers, one in Screen) and an empty hidden group |
| `*-masks` | a layer mask that is a ramp (in `v3` with density 0.5 and feather 2.5), a disabled and unlinked mask, a mask on a group |
| `*-selection-channels` | a selection with a half-selected column, and two saved channels |
| `*-guides-paths` | guides (in `v3` through the document store, one coloured, one of an artboard, and the ruler origin), two saved paths (a triangle with a subtracted hole, an open curve with handles), a work path, the global light |
| `*-tags-info` | seven colour labels, two link sets and a link set of one, File Info (title, author, description, copyright, keywords, rating, credit, source, copyright status and URL) and camera data |
| `v2-`, `v3-deep-u16` | a 16-bit document: two layers with `layers/<id>.u16` and one with only its 8-bit PNG |
| `v2-`, `v3-deep-f32` | the same at 32 bits, with values above 1 |
| `v2-`, `v3-mode-grayscale`, `-indexed`, `-duotone`, `-bitmap`, `-multichannel` | one background converted from RGB by the app's own `convertPixels`, with the document fields `convertDocument` (lib/modes.js) sets |
| `v2-`, `v3-mode-cmyk`, `-lab` | RGB pixels with the mode flag, which is all those modes were in the app |
| `wip05-profile`, `wip05-profile-id-only` | a document profile with its bytes in `profile.icc` (Display P3), and one described only (Adobe RGB-compatible) |

Masks are white with the mask in their alpha channel, as the app made them (`Selection.toCanvas`,
`solidMask` in lib/layer-ops.js) and as its compositor reads them.

Adjustment, fill and shape layers, vector masks, layer styles and advanced blending
(`make-fixtures-layers.mjs`, `v2` and `v3` only: the 0.2 writer, `v1`, describes these layers
exactly as the 0.3 one does, and its compositor draws them the same). Next to each `<name>.pigment`
is `<name>.png`, the picture the app's own compositor (`flattenDocument` in lib/compositor.js) made
of the document; `crates/io/src/legacy_pigment/layer_kinds_tests.rs` compares the opened
document's picture with it.

| File | Holds |
|---|---|
| `*-adjust-<kind>` | a 24 × 24 photograph-like picture (hues across, saturation and value down, a grey ramp) under one adjustment layer of each kind with settings that are not the defaults: every kind 0.3 had, with 0.3's shapes (Levels' `perChannel: false`, one Hue/Saturation `range`, Black & White's tint), and in `v3` a drawn curve, Hue/Saturation ranges with their own bounds, a gradient map of 0.4's model, a built-in Color Lookup look and a table, Levels and Curves in the grey, CMYK and Lab spaces, and the three kinds 0.4 added |
| `*-adjust-masked` | an Invert layer at 50 % in Luminosity with a mask over half the picture |
| `*-fill-<paint>` | a solid colour; 0.3's gradients from one point to another (linear, radial, angle, reflected, diamond, and stops with their own transparency left to right); a pattern; in `v3` 0.4's gradients (midpoints, opacity stops, each interpolation method, Smoothness, noise) and placed and turned patterns |
| `*-shape-<what>` | path operations (subtract, intersect and exclude, and the inner subpath wound the other way), no fill with an inside stroke, an outside dashed stroke, a gradient fill, an open curve, 0.3's live rectangle; in `v3` every live shape (rectangle with four radii and turned, ellipse, triangle, polygon, star and smoothed star, line, arrow, custom), 0.4's stroke (a gradient paint, round caps and joins, dashes in stroke widths), a placed gradient and a pattern fill |
| `v3-vector-masks` | vector masks that hide and reveal (with subtracted shapes), with density and feather, disabled, empty and revealing, on a group, and together with a layer mask |
| `*-style-<effect>` | a disc with each effect alone and nothing at its default; several at once with one off; in `v3` several drop shadows and strokes, contours, noise, the glow techniques and gradient fill, the bevel's gloss contour, contour and texture, 0.4's gradient and pattern overlays, gradient and pattern strokes, Hide All Effects, styles on a group and a shape |
| `v3-blending-<what>` | channels left out, Blend If with split points on grey and on the channels, a shallow knockout through a black layer, and the other options with a deep knockout |

Layer ids hold the time of writing, so tests find layers by name.

Type layers and smart objects (`make-fixtures-l3.mjs`, `v2` and `v3`). Smart-object documents
have the app's picture next to them as above; type documents do not (the app drew type with the
fonts of the machine it ran on, so a picture would compare fonts): the tests check the text, the
runs and where the type sits. `crates/io/src/legacy_pigment/text_smart_tests.rs` opens them; the
engine compares the filtered smart object's picture (`crates/engine/src/legacy_pigment_render.rs`).

| File | Holds |
|---|---|
| `*-text-point` | point type with every 0.3 font field set: bold, italic, underline, colour, line height, letter spacing, a stroke (144 ppi, so 16 px is 8 pt) |
| `*-text-box` | a centred paragraph box with two paragraphs (in `v3` with its fixed height), and right-aligned point type turned and scaled by its matrix |
| `v3-text-runs` | 0.4's rich text: runs with font, PostScript name, size, tracking, baseline shift, faux bold, colour, kerning, scale, italic, underline, strikethrough, caps, superscript, language, OpenType features, leading, a stroke on one run, No Break; paragraphs with alignment, indents, spacing, hyphenation, a list, hanging punctuation and justification spacing; crisp anti-aliasing |
| `v3-text-vertical` | stacked vertical type in two columns, and 0.4's "vertical" (horizontal type turned a quarter) |
| `v3-text-path` | type on an open curve from a fifth of its length, and flipped and centred |
| `*-smart-instances` | a nested document placed twice: the second instance shares the first's source (`sourceRef`), turned and scaled, at 80 % |
| `*-smart-image` | an image source scaled twice, and one without a matrix |
| `*-smart-filters` | Gaussian Blur, Unsharp Mask and Levels as smart filters, and an Invert that is off |
| `*-smart-filters-unmapped` | Box Blur, Glowing Edges (Pigment has no counterpart) and Mosaic, with the whole stack off |
| `*-smart-deep` | smart objects nested ten deep |


## Making them again

`make-fixtures.mjs` builds the documents with the app's classes and calls its `writePigment`. The
app draws on a browser canvas; under Node, [`@napi-rs/canvas`](https://www.npmjs.com/package/@napi-rs/canvas)
(1.1.1; its prebuilt binary comes from the npm registry) stands in for it. Node 22 was used.

```sh
# outside this repository's working tree
git worktree add --detach /tmp/pigment-js 99dbdee          # or 3731508, b0e43cc, e9845fc
cd /tmp/pigment-js/pigment
npm install --ignore-scripts --no-save --omit=optional ag-psd@31.0.3 esbuild@0.25.10 harfbuzzjs@1.6.4
                                                           # no install scripts: nothing is downloaded but npm packages
mkdir /tmp/fixgen && cd /tmp/fixgen && npm init -y && npm install @napi-rs/canvas
node <this folder>/make-fixtures.mjs /tmp/pigment-js/pigment v3 <this folder>   # v1, v2, v3 or wip05
                                           # make-fixtures-layers.mjs and make-fixtures-l3.mjs run too
                                           # (keep them next to make-fixtures.mjs)
```

Run it once per checkout with the matching set name. The `v1` run writes the layer-kind documents
too; they are not kept (see above). For `v3` the script installs the gradient and pattern paint
renderers the app installs when it starts (lib/tools/fill.js, lib/panels/patterns.js), so the
pictures show 0.4's gradients and patterns. The files differ from run to run in their
layer ids and ZIP timestamps only. The script writes no ZIP and no `document.json` itself: for the
image modes, whose conversions are app commands that need the whole interface, it calls the same
pixel conversion the command calls and sets the fields the command sets.

## Tool presets (`wip05-tool-presets.tpl`)

`wip05-tool-presets.tpl` was written by the unfinished 0.5's own `.tpl` writer (`writeTplFile` in
`src/renderer/lib/preset-files/tpl.js`, checkout `e9845fc`) through `make-fixture-tpl.mjs`, with no
canvas: its one sampled tip is a 6 × 4 grey PNG (coverage `x * 40 + y * 10`) made by the app's own
PNG encoder. It holds eight presets: a brush with mode, opacity, flow and smoothing; a pencil with
that sampled tip and Auto Erase; an eraser in Pencil mode erasing to history; a radial gradient in
Overlay at 50 % with Include Color; a type preset (Inter, 36); a Spot Healing Brush; a Dodge on the
highlights; and an Adjustment Brush, a tool Pigment 0.5 does not have yet.
`crates/io/src/tpl_map/tests.rs` reads it with its `pigmentData`, and with `pigmentData` taken out
(the keys a Photoshop file holds).

```sh
# the wip05 checkout as above, with ag-psd 31.0.3 installed
node <this folder>/make-fixture-tpl.mjs /tmp/pigment-js/pigment <this folder>
```
