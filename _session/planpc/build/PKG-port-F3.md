# PKG-port-F3: AVIF open (rows 27, 28)

Built on `claude/pigment-photocraft` after `fb7ecac` (review P; PhotoCraft 057297b, craft-libs 18ffc07). Spec:
PORTS-A §4.1 and §9 F3; REBASE-FU "F3" (it wins). First package of group FU.

**CI first.** At the start (01:00 UTC) the newest finished run was 46084412661 (`31d2422`, P4), **green**; the runs on
`e44d7b9` (46089736315) and `fb7ecac` (46090349536, group P's review) were still running (in progress / pending at
01:40). Nothing red, so no CI commit. **The next engineer checks CI first**: those two runs and the run on this
package's commit (COMMIT_SHA). Not waited for, as the brief says.

## Commit (pushed)

- COMMIT_LINE

## What was built

F3 is a switch-on, not a reader (REBASE-FU): craft-image-codecs at 18ffc07 has a full AVIF decoder (`avif-decode`,
`CL/image-codecs/src/codecs/avif_decode.rs`) over craft-video's pure-Rust AV1 decoder. The spec's own ISOBMFF reader
(`crates/io/src/avif.rs`) and a direct `craft-video` dependency are **not built** (dropped by REBASE-FU: the framework's
reader does all of it, with the bounds).

1. **`crates/io/Cargo.toml`**: `avif = ["photocraft-codecs/avif-decode"]` and `default = ["avif"]`. REBASE-FU left
   "app and CLI manifests, or `default`"; I chose `default` (the PORTS-A spec asked for a default-on feature): the app,
   the CLI, the engine and ui tests and `cargo test -p photocraft-io` all get it with no manifest per app. On wasm32 the
   codecs crate compiles the decoder out (`cfg(not(target_arch = "wasm32"))`, craft-video is a native-only dependency),
   so the web build is unchanged (and its own `OPEN_EXTS` in `apps/photocraft-web/src/web.rs` was left without `avif`).
   `Cargo.lock` gains `craft-video` and `craft-media` (same craft-libs revision, no new crates.io crates).
   `cargo tree -e features --workspace --features heif -i craft-video` (CI's configuration) shows
   `craft-image-codecs feature "avif-decode"` ← `photocraft-io feature "avif"` ← `default`, unified into
   `photocraft`, `photocraft-cli` and the rest. `cargo metadata --locked` passes.
2. **`Cargo.toml`** (workspace): `[workspace.metadata.cl.expected_features]` `photocraft-io` now
   `["avif", "default", "pdf-editable", "testgen"]` (craft-libs' `cl doctor` compares it; CI does not run it).
3. **No route**: checked against the tree: `photocraft_formats::detect` gives AVIF no document format, so
   `io/src/lib.rs` (routes 968-982, unchanged by groups A and P) sends it to the flat path, `flat.rs:105`
   `codecs::detect` names it by its `ftyp` brand (a `.png` name still opens as AVIF; tested), `decode_limits`
   (`flat.rs:56`) bounds it, and `cicp_profile`/`hdr_fallback` (`flat.rs:309-332`) tag its colour as for HEIF.
   `import_preflight` returns `Flat`; `memory_gate.rs:82` `probe_size` works for AVIF.
4. **Open dialog** (`crates/ui-egui/src/file_dialog/filters.rs`): `"avif"` in `OPEN_EXTS` after HEIF and
   `("AVIF", &["avif"])` in `OPEN_FILTERS` after Amiga IFF (the list is sorted by lower-case name; the upstream test
   `save_types_list_the_document_formats_then_the_rest_by_name` checks it).
5. **Upstream test** `folder_listing_takes_every_format_photocraft_opens` (`engine/src/cmd/file_cmds/tests.rs:4074`):
   `assert_eq!(openable_name("a.avif"), Format::Avif.caps().read)`. `same_format` (Batch "same format") now saves an
   AVIF as PSD by itself (read only), and its upstream test loop covers it.
6. **Errors and words**: no new string. The decoder's `CodecError::unsupported(Avif, …)` (animated AVIF, layered
   `lsel`/`a1lx`, YCgCo/ICtCp matrices) reaches the open error as it comes; no `tl!` wrapper was added (REBASE-FU: only
   if wrapped).
7. **Docs**: `docs/file-format-parity.md` AVIF row (Pigment reads it; upstream no, #463), `README.md` (the formats
   sentence), the user guide (`docs/user/guides/open-and-save-files.md`), the parity page (`docs/parity/README.md`, both
   AVIF rows "Done in 0.6", as P4 marked its row), FORK.md "Opening AVIF" with the hook table.
   The packaging already registered `.avif` (`pigment.desktop` `image/avif`, `pigment.wxs`, `Info.plist.in`
   `public.avif`, from the JS app): no change. `docs/RELEASE-NOTES-0.5.0.md` and the README's "not in 0.5 yet" list
   are about 0.5.0 and were left as they are (no earlier package changed them).

## Tests

`crates/io/tests/it/avif.rs` (9 tests, `mod avif;` in `tests/it/main.rs`), fixtures in
`crates/io/tests/fixtures/avif/` with a README (generator FFmpeg 6.1.1 + libaom; exact commands) and
`make-containers.py`:
- `an_8_bit_420_avif_opens_with_libdav1d_s_pixels`: craft-libs' `quad-420-bt709.avif` against its libdav1d YUV
  oracle converted with BT.709 limited range and libavif's 3:1 bilinear chroma, ±1 (8-bit); untagged, Background.
- `a_lossless_444_avif_opens_exactly` (craft-libs' GBR file = `quad-source.rgb`, exact).
- `a_10_bit_avif_opens_as_a_16_bit_document`: lossless 10-bit GBR from a 10-bit planar source, U16, v/1023 ±1/65535.
- `an_avif_with_alpha_opens_with_its_transparency`: lossless colour + lossless monochrome `auxl` alpha item, exact
  alpha and colour, "Layer 0" unlocked. (First attempt fed the alpha through `alphaextract`→`gray`, which changed
  247 to 248; the fixture now takes the alpha as its own raw input. Recorded in the README.)
- `a_grid_avif_opens_as_one_image_of_its_tiles`: 2×2 `grid` of four different lossless tiles, 64×32 crop, exact.
- `irot_is_applied_and_the_xmp_item_reaches_the_document`: `irot` 1 → 17×33, exact; `mime` XMP via `cdsc` →
  `Document.metadata.xmp`.
- `an_oversized_ispe_is_refused_before_decoding`: `ispe` 2^20 × 2^20 → `IoError::Codec(LimitExceeded)`;
  `flat_max_pixel_bytes: 1024` refuses the 33×17 file; preflight `Flat`; `probe_size` of the grid.
- `every_truncated_avif_is_an_error_not_a_panic`: every prefix of four files is an error.
- `avif_is_detected_by_its_contents_and_stays_read_only`: a `.png` name opens as AVIF; export to `.avif` errors.

FFmpeg 6.1 writes neither grids, `irot` nor XMP items, and no MP4Box is installed: `make-containers.py` builds those
three containers around FFmpeg's AV1 data (all item data in `idat`, `iloc` method 1, where FFmpeg uses `mdat`), and a
small box dump checked the alpha and grid layouts. Not covered by a fixture: ICC (`colr prof`), Exif, 12-bit and
PQ/HLG (craft-libs' own unit tests cover the decoder side; the flat path's ICC and CICP tagging is upstream's and shared
with HEIF).

Results: RESULTS

## Hooks into upstream files

`crates/io/Cargo.toml` (features), `Cargo.toml` (cl expected_features), `Cargo.lock`,
`crates/ui-egui/src/file_dialog/filters.rs` (two lines, marked), `crates/engine/src/cmd/file_cmds/tests.rs` (one
assertion, marked), `crates/io/tests/it/main.rs` (`mod avif;`, marked), `docs/file-format-parity.md`, `README.md`,
`docs/user/guides/open-and-save-files.md`. All listed in FORK.md "Opening AVIF".

## For the next package

- **Disk**: a `cargo nextest run -p photocraft-ui-egui` without `--lib --bins --tests` also builds the crate's
  examples (about 8.5 GB of example binaries in `target/debug/examples`) and filled the disk once here. Pass
  `--lib --bins --tests` as CI does, and clear `target/debug/examples` executables over 20 MB too when space is low.
- `photocraft-engine` has no `heif` feature: run its tests with `--features photocraft-io/heif`.
- The io feature `avif` means *decode* here; craft-image-codecs' own `avif` feature is the (off) *encoder*. Nobody
  should forward `photocraft-codecs/avif` thinking it reads.
- F2 and F1 touch `crates/io/Cargo.toml` next (`craft-tga`, `craft-metadata`): the `[features]` block now has
  `default`, keep it.
