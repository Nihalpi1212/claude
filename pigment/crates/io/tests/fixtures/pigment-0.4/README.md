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

Layer ids hold the time of writing, so tests find layers by name.

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
```

Run it once per checkout with the matching set name. The files differ from run to run in their
layer ids and ZIP timestamps only. The script writes no ZIP and no `document.json` itself: for the
image modes, whose conversions are app commands that need the whole interface, it calls the same
pixel conversion the command calls and sets the fields the command sets.
