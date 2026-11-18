# PKG port L1: legacy `.pigment`, container, document, pixels

Package L1 of `planpc/ports/PORTS-A.md` (section 7). Branch `claude/pigment-photocraft`.

## Commits (both pushed)

| Commit | Subject |
|---|---|
| `d6247d8` | Pigment: documents of Pigment 0.1 to 0.4 open (document, pixel layers, groups, masks) |
| `ee0c526` | Pigment CI: the Type bar's toggle test waits for the font scan (it failed once in CI) |

CI was not waited for on `ee0c526` (run 44235263910 was pending behind the run of `753ccc2`). **Check it first.** The run of `d6247d8` alone shows "cancelled": the newer push replaced it in the queue; `ee0c526` contains it.

## What a Pigment 0.1–0.4 file opens as now

`crates/io/src/legacy_pigment/` (it was `legacy_pigment.rs`, one function that always failed):

| File | Holds |
|---|---|
| `mod.rs` | `import`, `is_legacy`, `damaged()`; document size, dpi, image mode and depth (`model_of`), channels and selection, guides and ruler origin, paths and global light, profile |
| `container.rs` | the ZIP (`craft_zip::Archive`), `document.json`, PNG decoding, the limits, the pixel budget, `Container::write` |
| `layers.rs` | `LayerReader` (the tree), raster layers, deep planes, masks, `Tone`, `encode`, `encode_gray`, layer tags, link sets |
| `path.rs` | `to_path` (JS PathData to `photocraft_doc::vector::Path`) |
| `blend.rs` | `blend_mode` (JS names to `BlendMode`) |
| `info.rs` | `xmp_packet` (File Info and camera data as an XMP packet) |
| `tests.rs` | the tests |

Converted:

- **Document:** size, dpi, modes, depth 8/16/32, colour table with its transparent index, duotone inks, the 0.5 profile (`profile.icc`, or a craft-cms built-in by `wellKnown`/`id`).
- **Layers:** raster and group, with name, visible, opacity, fill opacity, blend, locks, clip, `expanded`. Layer masks with enabled, linked, density and feather. Colour labels and link sets from `meta.layerTags` (a set of one links nothing, as in the app).
- **Document data:** `selection.bin`, `channels/<id>.bin`, guides (store or the old list, colours kept), ruler origin, saved paths, work path, global light, File Info and `meta.exif`.

Not converted yet, each reported in `ImportResult.warnings`:

- `adjustment`, `fill`, `shape`, `text`, `smart` and unknown layer types open as an **empty raster layer in their place** with the common properties (`layers.rs`, the `other =>` arm of `LayerReader::layers`). L2 and L3 replace arms there.
- `vectorMask`, `styles` and `blending` are warned about in `LayerReader::common` (three `if` blocks at its end). L2 replaces them.

## Where the spec was wrong, or where I chose

1. **Path points are `{x, y, inX, inY, outX, outY}`**, absolute, not `in`/`out` objects. Subpaths carry `op`. Points may also be `[x, y]`.
2. **Duotone curves are in 0–100** (ink percent), not 0–255.
3. **The version 1 writer is not `726b605`'s only**: the local clone was shallow and that commit was missing. I deepened the JS branch (`git fetch --depth=120 origin claude/fervent-newton-263lz3`), which brought the 0.1/0.2 history. Version 1 fixtures come from `3731508` (the last 0.2 commit).
4. **`profile` was never in a released version.** 0.4.0 writes none. The fixtures for it come from the unfinished 0.5 (`origin/claude/fervent-newton-263lz3-wip05`, `e9845fc`), whose engine can make profile bytes.
5. **The JS unit tests do not run `writePigment` under Node** (only the browser tests do). It runs under Node with `@napi-rs/canvas` standing in for the canvas; see "Fixtures".
6. **Multichannel: the spec is right, my first idea was wrong.** I first mapped it to PhotoCraft's Multichannel mode (no layers, ink channels). The flattened picture came out much darker (PhotoCraft's spot-ink preview is not the app's plain multiply). RGB with the kept pixel layer and the inks as spot channels (solidity 0, planes inverted to ink density) flattens to exactly the app's picture. A test asserts it.
7. **Document name:** the file name, as every other importer and the JS reader itself did. `d.name` is used only when the importer gets an empty name.
8. **`active` is not carried.** `ImportResult` has no field for it. `LayerReader.ids` (file id to `LayerId`, in tree order) is filled and unused, for whoever adds it (and for L3's `sourceRef`).
9. **File Info:** I did not move the engine's XMP writer into io (a large hook in an upstream file). `info.rs` writes a packet with the properties `file_cmds::info` reads. Checked end to end: `pigment-cli run <fixture> --cmd file.fileInfo` returns every field and the camera data; the CI smoke test asserts two of them. Rating, credit and source go to `xmp:Rating`, `photoshop:Credit` and `photoshop:Source`, which today's File Info dialog does not show (F1 adds them).
10. **Saving:** the result is `source_read_only: true`, so the path is not kept and File › Save goes to Save As. The spec's save prompt is L3's; until then no open path can put the new format over the old file. **L3:** when you add the prompt, decide whether to keep the path (then drop `source_read_only` and the two hooks in `crates/ui-egui/src/app/files.rs`).
11. **Errors:** `IoError::LegacyPigment(String)` for a file that is recognised but unreadable ("This Pigment 0.4 file is damaged: …"). Files over a limit fail with `IoError::Unsupported("this Pigment 0.4 document is too large to open: …")`, except an oversized `document.json`, which is "damaged". A missing or undecodable layer PNG, mask, channel or selection is a warning, not an error.
12. **Group depth:** `MAX_DEPTH` is 64 as the spec says, but serde_json's own nesting limit (128, two levels per group) stops `document.json` at about 62 groups, with the "damaged" error. Sixty levels open (tested).
13. **32-bit:** values are kept. PhotoCraft reads an untagged document as sRGB at any depth, so the picture is the same; the note in the report only says the values were not linear.
14. **Locks:** PhotoCraft's Lock Image Pixels includes transparency (`Locks::set`), so a JS layer with both ends with `pixels` only.

## Limits (`container.rs`)

| Limit | Value |
|---|---|
| Entries | 65,535 |
| All entries read, inflated | 4 GiB |
| `document.json` | 64 MiB |
| One PNG file or raw plane | 1 GiB |
| Canvas or layer side | 300,000 px |
| Pixel memory (tiles kept) | 2 GiB (the sibling importers use 1 GiB; I chose more so that real documents open) |
| Layers and groups | 8,192 |
| Channels, paths, guides | 512, 4,096, 16,384 (silently cut) |

## Hooks into upstream files (all in `docs/FORK.md`, "Opening documents from Pigment 0.1–0.4")

| File | Hook |
|---|---|
| `crates/io/src/lib.rs` | `IoError::LegacyPigment` became `LegacyPigment(String)` with the new message. The module line and the routing lines were there already. |
| `crates/io/Cargo.toml` | `craft-zip` moved from dev-dependencies to dependencies (`Cargo.lock` unchanged) |
| `crates/format/src/brand.rs` (Pigment's own file) | `LEGACY_PIGMENT_MESSAGE` became `LEGACY_PIGMENT_DAMAGED` |
| `crates/ui-egui/src/app/files.rs` | two lines: the places that mark an Affinity source read-only also ask `legacy_pigment::is_legacy` (these open paths do not go through the engine's open job) |
| `crates/ui-egui/tests/it/main.rs` | `mod legacy_pigment;` |
| `crates/ui-egui/src/tools/type_tool/panels_toggle_tests.rs` | one line in `bare_app()` (the CI repair, below) |
| `.github/workflows/pigment-ci.yml` | the smoke test's legacy part |

## Fixtures

`crates/io/tests/fixtures/pigment-0.4/`: 38 `.pigment` files (156 KB), `make-fixtures.mjs`, `README.md` (commits, contents, how to run).

- Four writers: `3731508` (version 1), tag `pigment-v0.3.1` (2), tag `pigment-v0.4.0` (3), `e9845fc` (profile).
- Setup that worked here: `git worktree add --detach <scratch>/js-v3 pigment-v0.4.0`; in its `pigment/` folder `npm install --ignore-scripts --no-save --omit=optional ag-psd@31.0.3 esbuild@0.25.10 harfbuzzjs@1.6.4`; in another folder `npm install @napi-rs/canvas`; run `node make-fixtures.mjs <checkout>/pigment v3 <out>` from that other folder. One `node_modules` can be symlinked into the other checkouts.
- The worktrees are removed. The `fixgen` folder with `@napi-rs/canvas` is still in the scratchpad (`<SCR>/fixgen`).
- **For L2:** the app's compositor runs under Node too (`writePigment` calls `flattenDocument` for the thumbnail). So the JS render the spec wants next to each L2 fixture can come from `flattenDocument(doc)` in `renderer/lib/compositor.js` and `io.canvasToPng`. Add your documents to `make-fixtures.mjs` as new functions and new set entries; layer ids hold the time, so find layers by name.
- Mode conversions are app commands that need the whole interface. The script calls the same `convertPixels` and sets the fields `convertDocument` sets.

## Tests and results

| Where | Tests | Result |
|---|---|---|
| `cargo test -p photocraft-io --lib legacy_pigment` | 25 (blend 1, path 2, info 3, importer 19) | 25 pass |
| `cargo test -p photocraft-io` (all) | 707 lib, 595 integration | pass, except 3 `svg::` tests that are in `scripts/upstream-test-failures.txt` |
| `cargo test -p photocraft-format` | lib 93 | pass; 10 integration failures, all in `upstream-test-failures.txt` (permissions as root and others) |
| `cargo test -p photocraft-ui-egui --test it legacy_pigment` | 2 | pass |
| `cargo test -p photocraft-ui-egui --lib file_open psd_open` | 113 | pass |
| CLI smoke lines, run by hand | info, convert to PNG and `.pigment`, `file.fileInfo`, damaged file | pass |

The 19 importer tests: raster offset, groups (with a flattened-picture check), masks, selection and channels, guides and paths, tags and File Info, 16-bit, 32-bit, grayscale and indexed, duotone and bitmap, CMYK/Lab/Multichannel, the profile, save to the native format and reopen (7 fixtures compared whole), unconverted layer kinds, newer version and missing pieces, the damaged-file error under four names, hostile sizes, the fuzz loop (more than 5,000 damaged files), native round trip.

Checks: `cargo fmt --all -- --check` clean; `cargo clippy -p photocraft-io -p photocraft-format -p photocraft-ui-egui --all-targets -- -D warnings` clean; `python3 pigment/scripts/pigment-rebrand.py --check` clean. Not run: workspace-wide clippy and tests (CI does), the panic hunt and the xtask checks (no command, crate, preference or panel command was added).

## The CI repair (`ee0c526`)

Run 44227954305 (commit `a0e42ff`, a CLI-only change) failed on one upstream test: `photocraft-ui-egui` `tools::type_tool::panels_toggle_tests::without_a_document_it_opens_and_closes_the_group`.

- Cause: the Type options bar draws "Loading fonts…" until the installed fonts' background scan ends, then its buttons move. The test clicks a button found in the frame before. Only this test has no type layer (creating one waits for the scan), and only alone in its process (nextest).
- Measured here with 16 processes on 4 cores: 7 failures in 64 before, 0 in 288 after.
- Fix: `bare_app()` calls `photocraft_text::shared()` first.
- Other ui-egui tests that click in the Type options bar without a type layer could have the same race. I did not look for them.

## Docs

`README.md` ("Pigment 0.4 and earlier"), `docs/RELEASE-NOTES-0.5.0.md` (Known issues) and `docs/FORK.md` say what opens and what waits. **L2:** move adjustment, fill and shape layers, styles, vector masks and blending from "not converted yet" to converted in all three. **L3:** finish them.

## Left for later, or worth knowing

- The duotone picture: PhotoCraft evaluates ink curves piecewise-linearly, the app used a spline (`curveLut`). Mid-curve tones can differ slightly. L2's render comparison would show it.
- An Indexed or Bitmap document with more than one layer (the app flattened on conversion, but layers could be added after) opens with all its layers. PhotoCraft may expect one.
- A Multichannel document split from Lab has channels without a colour: they open as plain alpha channels.
- `brush.rs` (P4) and `text.rs`, `filters.rs`, `adjust.rs`, `gradient.rs`, `styles.rs` (L2, L3) do not exist yet.
- The git clone is still shallow, deeper on the JS branch than before.
- Disk: 8.1 GB free at the end.
