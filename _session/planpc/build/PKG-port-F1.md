# PKG-port-F1: File Info tabs, rating, IPTC, GPS, Camera Data (rows 33, 34, 35, 36)

Built on `claude/pigment-photocraft` after `aacdf9b` (F2; PhotoCraft 057297b, craft-libs 18ffc07). Spec: PORTS-A §4.5
and §9 F1; REBASE-FU "F1" (it wins). Third package of group FU.

**CI first.** At the start (03:16 UTC) the newest finished run was 46094674708 (`1c7c73b`, F3), **green**; F2's runs
were still going. 46101890525 (`aacdf9b`, F2's last) then finished **green**. Nothing red, so no CI commit. The run on
this package's first commit (46106173806, `51dedef`) was in progress when I finished, and the run on the second commit
was not looked at (the brief says not to wait): **the next engineer checks both first**.

## Commits (pushed)

- `51dedef` Pigment File Info tabs (F1), engine and io: Rating, Origin, IPTC, IPTC Extension, GPS, Raw Data, fuller
  Camera Data, IPTC-IIM in resource 1028 and JPEG APP13
- `2ca195b` Pigment File Info tabs (F1), interface: Photoshop's tabs, the Rating stars, the structure rows and Raw Data's
  Copy (also the parity page and the user guide)

## What was built

### Engine (`crates/engine/src/cmd/file_cmds/info_more.rs`, new; `pub mod info_more;`)

Upstream's `info.rs` keeps its eight keys and its own XMP reader/writer (REBASE-FU). Pigment's keys sit beside them:
- `FIELDS` (44): Basic `rating` (−1..5; 0 clears; 7 → 5; −3 → −1), `descriptionWriter`; Origin `dateCreated`, `city`,
  `state`, `country`, `credit`, `source`, `headline`, `instructions`, `transmissionReference`, `urgency` (0 none..8);
  IPTC `creatorContactInfo` (struct, the eight `Ci*` fields), `subjectCode`, `intellectualGenre`, `scene`,
  `sublocation`, `countryCode`, `usageTerms`, `altText`, `extDescrAccessibility`; IPTC Extension `personInImage`,
  `locationShown`/`locationCreated` (Bag of `LocationDetails`), organisation name/code, `event`, model/property release
  status and ids, `modelAge`, `additionalModelInfo`, `licensor`/`imageSupplier`/`imageCreator`/`copyrightOwner`
  (`plus:` Seq of structs), `digitalSourceType`, `maxAvailWidth`/`Height`, `registryId`, `artworkOrObject` (with
  Alt/Seq sub-fields), `imageSupplierImageId`, `minorModelAgeDisclosure`. The last two and `extDescrAccessibility` are
  beyond the spec's list (IPTC Extension/Core fields Photoshop shows); recorded.
- Params: lists take `[str]` or one string split on `;` (**not** on commas, unlike upstream's keywords: names like
  "Smith, Ann"); structs take `{local: str}`; a list of structs takes `[{..}]`, or **one object, which edits the first
  item and keeps the others** (what the dialog sends). Bad types → `BadParams`.
- Write: only keys whose normalized value differs from what the packet reads are written, as a fresh packet
  (`photocraft_io::file_info_xmp::packet`) merged with `craft_metadata::merge_xmp` (owned = the changed properties,
  namespaces `plus`, `xmpDM`, `DICOM`). Unchanged → the packet stays byte for byte (tested through the dialog). A
  packet craft-metadata cannot parse makes a Pigment-key edit fail with a clear `BadParams` (upstream's keys alone still
  write as before).
- Read adds every key plus read-only `created`/`modified`/`application`/`format`, `gps`
  (`latitude`, `longitude`, `altitude`, `time`, `direction`, `speed`, `mapDatum`: EXIF GPS IFD through
  `craft_metadata::read_exif` + `file_tag_rows`, else XMP `exif:GPS*`), `raw` (the packet, cut at 1 MiB with
  `rawTruncated`), `history` (`photoshop:History`), `dynamicMedia` (`xmpDM:*`), `dicom`.
- Camera Data: `CAMERA_MORE` (11) after upstream's nine, from `craft_metadata::read_exif` else XMP: program, metering,
  flash (fired / mode / return / red-eye words), bias ("-0.67 EV"), white balance, lens make, serial number, software,
  IFD0 Date/Time, pixel dimensions, orientation. With upstream's nine that is JS's 17 tags and more.
- Hooks in `info.rs` `file_info`: the `edits` test asks `info_more::owns`; `info_more::write(new, p)?` after upstream's
  write; `iptc_iim::sync_resource(..)` inside the "File Info" edit; `info_more::read(&mut info, &d.doc)` after the read.
  The params string in `file_cmds.rs` lists the new keys and results.

### io

- `crates/io/src/file_info_xmp.rs` (new, `pub mod`): `Out` (Text, Alt, Seq, Bag, Struct) and `packet(props)`, one
  `rdf:Description` declaring dc, xmp, xmpRights, photoshop, Iptc4xmpCore, Iptc4xmpExt, plus, xmpDM, DICOM; structs as
  `rdf:parseType="Resource"`; XML-illegal control characters dropped. `EXTRA_NAMESPACES`.
- `crates/io/src/iptc_iim.rs` (new, `pub mod`): Photoshop's record-2 map (2:05, 10, 25, 40, 55/60, 80, 85, 90, 92, 95,
  100, 101, 103, 105, 110, 115, 116, 120, 122) ⇄ XMP; `encode` writes 1:90 `ESC % G`, 2:00 version 4, the fields in
  dataset order, **keeps the old stream's unmapped datasets** (record 1, record-2 datasets File Info does not own,
  records 3+; Latin-1 text converted to UTF-8); extended lengths above 32767 bytes; no truncation to IIM's nominal
  lengths (recorded). `sync_resource` rewrites 1028 only when a mapped field changed (add / replace / remove), so an
  unchanged PSD saves byte-identical. `on_import` (hook in `flat.rs`, beside both guide reads) keeps a flat file's
  1028 in `psd_resources` and seeds an XMP packet when the file has IIM but no XMP. `insert_app13` puts the IRB in
  APP13 "Photoshop 3.0" segment(s) after APP0/APP1 (split above 64 KB); `with_app13` (hook on the flat export's result
  in `lib.rs` `export_with`) does it for JPEG when `embed_metadata` and Metadata is All.
- **Found in the code:** craft-metadata's `parse_iptc` reads only six fields and keeps the **last** By-line; its JPEG
  reader takes only the first APP13 segment. So Pigment decodes IIM itself (`iptc_iim::decode`) for the seed and the
  tests, and `parse_iptc` is used where the spec asked for it (title, keywords, caption, copyright, date).
- Not done: TIFF export does not write 1028 (DocSource's codec metadata leaves `photoshop_resources` out; the spec named
  JPEG only). PNG/WebP keep writing XMP only.

### Interface (`crates/ui-egui/src/dialogs/file_info_ui.rs`, new)

Still upstream's hosted parameter form (upstream's two File Info tests pass unchanged). `file_info_form`'s body is
`file_info_ui::form(app)`. A first `Param::custom("tab")` row draws a `TabStrip` (full width, not remembered, opens on
`basic`); every other row is `visible_when("tab", ..)`. Tabs: Basic, Camera Data, Origin, IPTC, IPTC Extension, GPS
Data, Raw Data always; Audio/Video Data, DICOM, Photoshop (history log) only when present. Basic: upstream's rows (same
keys), Rating (`craft::ui::choice::Rating`, 5 stars; a rejected −1 stays unless a star is clicked), Description
Writer, read-outs. Structures are flat rows `key/Field` under a section (a list shows its first item, with a note when
the file lists more); lists are one text field split on `;`; Urgency is a menu (None, 1 (High) … 8 (Low)). Raw Data:
the packet (first 64 KB shown) and a Copy button (`ui.ctx().copy_text`). `nest` (an arm of F2's `match` in
`dialogs/filter_dialog/pigment.rs` `command_params_of`) drops `tab` and every read-only row and folds the slashed keys.
- **Found in the code:** automation (`set_json_field`) keeps a custom row's key as `FieldValue::Json`, and refuses
  fields of hidden rows ("takes no input now"). The tab row turns a JSON string back into text so `visible_when`
  matches; tests switch the tab before setting a field of it.
- Not built: the bottom-left Template Folder / Import… / Export… (.xmp templates) menu (spec: optional, not a
  Pigment-ahead row).

### Words

All new labels through `tl!` (English); the new Camera Data labels go through `tr_ctx(lang, "cameraData", ..)` as
upstream's do, GPS labels through `tr_ctx(lang, "gpsData", ..)`. No catalogue rows added (fallback to English).

## Spec rows

- Row 33 Basic with Rating: **done** (rating, Description Writer, created/modified/application/format read-outs).
- Rows 34/35 Origin, IPTC, IPTC Extension, GPS: **done**; Raw Data done with Copy; Audio/Video, DICOM and the history log
  read-only when present (one Audio/Video Data tab for `xmpDM:`, not Photoshop's two). Lists of structures edit their
  first entry in the dialog (the command edits all). Template Import/Export not built (optional).
- Row 36 Camera Data: **done** (JS's 17 tags, serial, pixel size, orientation, GPS).
- IIM: PSD 1028 and JPEG APP13 **done**; reading IIM-only files **done**.

## Tests

- `crates/engine/src/cmd/file_cmds/info_more_tests.rs` (9): every key read back as set, one "File Info" step, through
  PSD, undo/redo; an unknown `crs:` property survives, unchanged values leave the packet alone, clearing removes,
  upstream's and Pigment's keys in one call; rating/urgency clamped, `;` lists, bad types refused; one object edits a
  list's first item; read-outs, raw, history, `xmpDM`; Camera Data of a hand-built EXIF with GPS (JS's 17 tags + GPS);
  flash words; IIM written in UTF-8 and read by `parse_iptc`, untouched by a non-IIM field, undone with the packet; an
  IIM-only JPEG seeds the fields, keeps 2:15, exports APP13 (and not with Metadata None).
- `crates/io/tests/it/file_info_iim.rs` (5) and unit tests in `iptc_iim.rs` (4) / `file_info_xmp.rs` (1): unchanged
  PSD byte-identical (with a Latin-1 1028); IIM-only JPEG seeds XMP (Latin-1, date/time); XMP wins over IIM; JPEG
  export APP13 read back by `jpeg_segments`, pixels unchanged, none with Metadata None or for PNG; >64 KB split.
- `crates/ui-egui/src/dialogs/file_info_ui_tests.rs` (4): tabs, rating, urgency, a struct row and a list through OK in
  one step, reopened values, tab not remembered, hidden rows refuse input; an unchanged OK keeps the packet byte for
  byte and a second location survives editing the first; `nest`; optional tabs and Copy.

Results (nextest, CI's env):
- `photocraft-io --features heif --lib --bins --tests --profile ci`: 1470 passed, 14 skipped.
- `photocraft-engine --features photocraft-io/heif --lib --bins --tests --profile ci`: 5025 passed, 1 failed (the known
  container-only `legacy_pigment_render::tests::cancelling_the_open_stops_the_smart_filters`), 26 skipped.
- Panic hunt: 1 passed.
- `photocraft-ui-egui` whole suite (`-j 3 --profile ci --lib --bins --tests`): 3804 passed, 6 skipped.
- fmt, clippy `-D warnings` (io, engine, ui-egui, all targets, `--locked --features heif`), rebrand check: clean.

## Hooks into upstream files (FORK.md, "File Info: Rating, Origin, IPTC, …")

- `crates/engine/Cargo.toml`, `crates/io/Cargo.toml`, `Cargo.lock`: `craft-metadata`.
- `crates/engine/src/cmd/file_cmds.rs`: `pub mod info_more;`, `mod info_more_tests;`, the `file.fileInfo` params string.
- `crates/engine/src/cmd/file_cmds/info.rs` `file_info`: the `edits` test, `info_more::write`, `iptc_iim::sync_resource`,
  `info_more::read` (four marked lines).
- `crates/io/src/lib.rs`: `pub mod file_info_xmp;`, `pub mod iptc_iim;`, `iptc_iim::with_app13` on the flat export.
- `crates/io/src/flat.rs`: `iptc_iim::on_import` beside the two guide reads.
- `crates/io/tests/it/main.rs`: `mod file_info_iim;`.
- `crates/ui-egui/src/menus/view_cmds/dialogs.rs`: `file_info_form`'s body.
- `crates/ui-egui/src/dialogs.rs`: `pub(crate) mod file_info_ui;`.
- Pigment file: `dialogs/filter_dialog/pigment.rs` `command_params_of`, a File Info arm (no line in `filter_dialog.rs`).
- Docs: `docs/parity/README.md` (four rows), `docs/user/guides/open-and-save-files.md` (a File Info section), FORK.md.

## For the next package

- **CI**: check the runs on `51dedef` and `2ca195b` first.
- **AI team**: `altText` (`Iptc4xmpCore:AltTextAccessibility`) and `extDescrAccessibility` are `file.fileInfo` keys now;
  Describe Image (`ai_ui/describe.rs:98`) still writes only `description`. `ai_cmds/generate.rs` stamps `description`
  through upstream's `write_file_info` directly, so its edit does not resync IIM 1028 (harmless: it is a new layer's
  document metadata; noted, not changed).
- The legacy `.pigment` importer (L-group, `legacy_pigment/info.rs`) already writes `xmp:Rating`, `photoshop:Credit`
  and `photoshop:Source`; File Info now shows them.
- A flat file's IIM is now in `psd_resources` (1028) after open, so a PSD saved from such a JPEG keeps its IPTC, as
  Photoshop does. No upstream test minded.
- Disk: ~9 GB free during this package; the ui-egui test build re-compiles the engine for its feature set (~15 min).
