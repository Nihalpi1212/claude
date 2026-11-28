# PKG-port-F2: Targa variants, GIF in Export As, Color Lookup Table formats (rows 29, 30, 31, 32)

Built on `claude/pigment-photocraft` after `1c7c73b` (F3; PhotoCraft 057297b, craft-libs 18ffc07). Spec: PORTS-A
§4.2, §4.3, §4.4 and §9 F2; REBASE-FU "F2" (it wins). Second package of group FU.

**CI first.** At the start (about 01:50 UTC) the newest finished runs were 46090349536 (`fb7ecac`, review P),
*cancelled* (superseded by the push of `1c7c73b`, not a failure), and 46084412661 (`31d2422`), green. 46089736315
(`e44d7b9`) finished green later. Nothing red, so no CI commit. The runs on F3's `1c7c73b` (46094674708) and on this
package's commits were still running when I finished: **the next engineer checks them first**.

## Commits (pushed)

COMMITS

## What was built

### Targa (row 29), io

REBASE-FU was right: the `image` crate reads nearly every Targa. Two variants it gets wrong now go through craft-tga
(`craft-tga`, craft-libs at the pinned revision; no new fetch):
- `crates/io/src/tga_more.rs` (new): `decode(format, bytes, limits, decode)` sends a **16-bit true-colour file whose
  descriptor says one attribute bit** (alpha; the `image` crate drops it) and a **colour map with indices wider than
  its entries** (16-bit index into 15-bit entries; the `image` crate refuses it) to `craft_tga::decode`, and falls back
  to craft-tga when the `image` crate fails on any other Targa (the `image` crate's error is kept when craft-tga fails
  too; a `LimitExceeded` is never retried). Output: RGBA8 when a pixel is not opaque, else RGB8 (Gray/GrayA in the
  fallback for grey files), so upstream's `apply_flat_format` makes "Alpha 1" as for 32-bit files. 32-bit files keep
  upstream's path and its Photoshop-measured "Alpha 1" rule (#2225).
- **Found in the code, not in REBASE-FU:** `codecs::detect` (`CL/image-codecs/src/format.rs:464` `looks_like_tga`)
  accepts only 8-bit indices for colour-mapped files, so a footerless file with 16-bit indices was not even recognised
  (`UnknownFormat`). `tga_more::sniff(name, bytes)` (craft-tga's sniff, which needs a Targa extension, and only for the
  two variants) names it. Hence two hook lines in `flat.rs`, not one.
- craft-tga widens 5-bit values as `(c << 3) | (c >> 2)` (the `image` crate and the JS app round `c·255/31`; they
  differ by at most 1 in 255). Colour maps with 16-bit entries and an attribute bit still go the `image` crate's way
  (alpha dropped), as in the JS app, which also ignored that bit for map entries.
- Writing 16-bit Targa: left out (craft-tga writes 8-bit layouts only; JS did not write it), as the spec allowed.
- Tests went into a new Pigment file `crates/io/tests/it/targa_variants.rs` instead of upstream's `flat.rs` (REBASE-FU
  suggested reusing `flat.rs`'s private `tga_file` helper; a file of our own keeps upstream's test file untouched).

### GIF in Export As (row 30), interface

`export_dialog.rs`: `("gif", "GIF")` in `FORMATS` and `ExportFormat::new("gif", "GIF").transparency(true)` inserted after
JPG in `dialog_formats` (Photoshop's order). The framework shows Quality only for `.quality(true)` formats. The export
is upstream's (`photocraft_io::export(doc, "x.gif")`, the Save As GIF encoder, 256 colours); Transparency off
flattens on white.
- **Found in the code:** the engine's Export As presets (`crates/engine/src/cmd/export_preset_cmds.rs` `FORMATS`) did
  not list GIF, so saving an Export As preset with GIF would fail validation and a saved one would be dropped on
  load. Added `"gif"` there and to `file.export.presets.save`'s params string. (Upstream's list also lacks `jxl`,
  which Export As offers: an upstream bug, not touched; worth an issue.)

### Color Lookup Tables (rows 31, 32), engine and interface

- `file_cmds/export.rs`: `bake_table(size, layers) -> Vec<[f32; 3]>` (red fastest) split out of `bake_cube_layers`,
  **baked in bands** of blue slices of at most 4 Mpx (`BAKE_BAND_PIXELS`), so 256 points never build a 268 MB
  lattice. `bake_cube_layers` = `bake_table` + upstream's `write_cube_export` (byte-identical output; upstream's
  `export_clut_cube_header_tests.rs` passes). The size check is now `2..=lut_writers::MAX_EXPORT_SIZE` (256).
- `file_cmds/lut_writers.rs` (new): params `formats` (`["3dl"|"cube"|"csp"|"icc",…]`, default `["cube"]`, written in
  Photoshop's order, repeats once), `copyright`, `lowercase` (default true); writers:
  - `.cube`: upstream's writer; `#Copyright: …` under `#Created by:` only when there is a copyright.
  - `.3dl`: JS `write3dl` (10-bit ramp, 12-bit codes, blue fastest) plus `3DMESH` / `Mesh <k> 12` for 2^k + 1 grids
    (3, 5, 9, 17, 33, 65, 129), what `parse_3dl` honours (declared 12-bit scale). Other sizes are headerless like the
    JS file; `parse_3dl` infers 4095 from the largest code (a table whose codes are all ≤ 1, i.e. nearly black, would
    be misread by that inference; Photoshop's own files have the same ambiguity). Title and copyright as `#` lines.
  - `.csp`: `CSPLUTV100`, `3D`, metadata (title, `Copyright: …`), three identity pre-LUTs, `N N N`, red fastest.
  - ICC: RGB → RGB DeviceLink, A2B0 `mAB` = identity curves, CLUT (red slowest, per ICC), identity curves; `desc`,
    `cprt`. **Found in the code:** craft-cms's `write::encode` (private; reached through `Profile::to_bytes`) writes the
    PCS field as `XYZ ` or `Lab ` only, so the header's bytes 20..24 are set to `RGB ` after encoding and the profile
    ID re-stamped with `craft_cms::profile_id`. `Profile::parse` reads it back as a DeviceLink with 3→3 A2B0.
    craft-cms cannot use an RGB DeviceLink in a `Transform` (link.rs refuses it), so the test evaluates the parsed
    A2B0 through `Pipeline::new(3, stages)`.
  - **ICC grid cap is 177, not 255:** `Clut::MAX_VALUES` = 16 Mi values, 177³ × 3 fits, 178³ × 3 does not. A larger
    table is resampled trilinearly to 177 points and the result's `iccSize` says so; the user guide says it too.
  - ICC refused for CMYK and Lab documents (clear error); every other mode gets the RGB link (the lattice is RGB).
  - Results: without `path`, `cube`/`threeDl`/`csp`/`icc` (base64) for the chosen formats, plus `size`, `layerCount`,
    `iccSize`; with `path`, `path` (the first file), `files`, `size`, `layerCount`. With one format and a path that
    already has that format's extension, the path is written as given (upstream's behaviour); otherwise a LUT
    extension (`cube`, `3dl`, `csp`, `icc`, `icm`) is replaced per format, other dots are kept.
  - Text writers build one `String` per format (no streaming to disk): `write_file` is upstream's atomic write of the
    whole buffer. At 256 points the table is ~200 MB and the `.cube` text ~450 MB, one format at a time. Recorded,
    not built further.
- The form (`crates/ui-egui/src/dialogs/lut_export_ui.rs`, new; the arm in `menus/view_cmds/dialogs.rs` calls
  `rows(..)`): File, Description (upstream's `title` key), Copyright, Use lowercase file extensions, Quality (Poor 7,
  Low 17, Medium 33, High 64, Maximum 256, Custom), Grid Points (upstream's `size` key, enabled for Custom; the
  upstream test's `fields["size"] == 33` holds), a Formats section with 3DL, CUBE (on), CSP, ICC Profile, and Scope.
  `fold` turns Quality and the boxes into `size` and `formats` (and drops an empty copyright).
- **`command_params` is a match now**: REBASE-FU predates A7, which had already put a Pigment hook in
  `filter_dialog::command_params` (`pigment::command_params_of`, in the Pigment file
  `dialogs/filter_dialog/pigment.rs`). I turned that function into a `match command { MATCH_COLOR => …,
  lut_export_ui::COMMAND => lut_export_ui::fold(map), _ => {} }`, so **F1 adds its File Info arm there** and needs no
  new line in upstream's `filter_dialog.rs`.
- **Upstream test changed:** `file_cmds/tests.rs` `selected_cube_validation_is_explicit_and_never_mutates_the_document`
  asserted `{"size": 130}` is refused; it is accepted now, so the case is `{"size": 257}` (marked, in FORK.md).
- Upstream's bug REBASE-FU named (form 2..256, engine ≤ 129) is gone: both say 256.

## Spec rows

- Row 29 Targa 15/16-bit and colour-mapped: **done** (reading). 16-bit writing not done (spec: optional; craft-tga has
  no 16-bit writer; JS did not write it).
- Row 30 Export As GIF: **done**.
- Rows 31/32 Color Lookup Tables .3dl/.csp/ICC, copyright, Quality, lowercase: **done**, with the ICC capped at 177
  points (craft-cms limit) and no Lab/abstract profile for CMYK/Lab documents (spec: refuse there).

## Tests

TESTS

## Hooks into upstream files (all in FORK.md, "Targa variants, GIF in Export As, Color Lookup Table formats")

HOOKS

## For the next package

- **F1**: add your File Info fix-up as an arm of `command_params_of`'s `match` in
  `crates/ui-egui/src/dialogs/filter_dialog/pigment.rs` (no upstream line needed). `crates/io/Cargo.toml` now lists
  `craft-tga` after `craft-zip`; the workspace `Cargo.toml` has it after `craft-zip` too.
- `menus/view_cmds/dialogs.rs`: the CLUT arm is now one call; F1's `file_info_form` body is elsewhere in that file.
- Disk: about 7.7 GB free during this package; the ui-egui test build took ~25 minutes from a cold-ish cache.
- Possible upstream issue: Export As offers JPEG XL but the engine's export presets refuse `jxl`.
