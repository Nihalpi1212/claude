# REBASE-FU: group FU (F1, F2, F3, U1, U2, U3, U4) re-checked against Pigment on PhotoCraft 057297b

Read each section beside its package in `PORTS-A.md` (sections 4.1 to 4.5, 5.1 to 5.5, 6.1, 6.2, 8 and 9).
**Where the two disagree, this file wins.** The spec's intent and its tests' intent still hold. Where this file says
nothing about a point, the spec stands as written.

**Tree checked:** `/home/user/claude/pigment` on `claude/pigment-photocraft` at `03ccb71` (`UPSTREAM-REVISION` =
`057297b`). The spec was written against abb30df; upstream's change was compared in `/home/user/storytold/photocraft`
(`git diff abb30df 057297b`). craft-libs is pinned at `18ffc07` (`Cargo.toml:15`) and was read in the cargo checkout
`~/.cargo/git/checkouts/craft-libs-d830b991a08c6c3d/18ffc07`. Below, `CL/` means that folder's `crates/`. Paths
without a prefix are relative to `pigment/`. The JS references (`claude/fervent-newton-263lz3`) are still readable
with `git show`. No cargo was run and nothing in the repository was changed.

**Upstream's measured documents** (`docs/target-app-parity.md`, `docs/gaps.md`, `docs/scorecard.md`,
`docs/parity-checklist.md`, plus `docs/file-format-parity.md` and `docs/hardware-parity.md`) name these rows:
- AVIF read is still missing: `file-format-parity.md:35` ("no (#463)"), `gaps.md:423`, `target-app-parity.md:81`, `:160`.
- Targa is "R/W yes, 8-bit" (`file-format-parity.md:42`).
- Windows Ink still has no tilt or rotation, and macOS rotation is still not applied to the tip angle (#1301):
  `hardware-parity.md:36-37`, `:45`; `target-app-parity.md:84`.
- Insert Conditional is listed as recordable and playable (`gaps.md:179`). The documents do not mention a dialog for it.
- The documents say nothing about File Info tabs, Export As GIF, the LUT formats, the Info panel's readout modes,
  Default Actions, Similar Layers or the operating system's recent documents.

The code shows one row that upstream built in full: **Clear All Actions, Reset Actions and Replace Actions (row 39)**.
It is dropped from U2. Upstream also built most of two other rows: **the AVIF decoder (rows 27 and 28)**, which is in
craft-image-codecs but switched off in Pigment, and **most of Targa reading (row 29)**, which comes through the
`image` crate.

## What changed for every package

1. **Interface pieces come from the framework, and Pigment cannot change them.** craft-libs is a pinned git
   dependency. FORK.md treats a change to craft-libs as a question for the project's owner. In this group:
   - **Info panel:** the framework's `craft::color_ui::ui::InfoPanel` (`CL/color-ui/src/ui/info.rs:187`) draws fixed
     lines: 8-bit RGB, CMYK percent, position, size and samplers.
   - **Actions panel:** the panel and its menu come from `craft::automation::ui::actions`
     (`CL/automation/src/ui/actions/menu.rs:250`).
   - **Export As:** the dialog is `craft::ui::patterns::form_dialogs::HostedExportAs` (`ExportFormat::standard()` is in
     `CL/ui-patterns/src/patterns/form_dialogs/export.rs:117`).
   - **Form dialogs** are `ParamDialog`/`HostedParamDialog` with `Param` rows
     (`CL/ui-patterns/src/patterns/form_dialogs/param.rs`). The row kinds are `custom` (645), `read_only_text` (675),
     `section` (681), `visible_when` (737), `enabled_when` (745) and `multiline` (823). There is no tab row kind.
   - **Other widgets** to build from: `craft::ui::tabs::{Tab, TabKind, TabStrip}` (example:
     `crates/ui-egui/src/panels/variables_ui.rs:395-406`), `craft::ui::choice::Rating` (`CL/ui-widgets/src/choice/rating.rs:55`),
     `craft::ui::layout_components::{Grid, Stack}`, `craft::ui::display::Text`.
2. **Panel menus** are `PanelRow`s returned by the panel's entry in `crates/ui-egui/src/panels/registry.rs`
   (`rows`/`states`/`run`).
   - An app's own rows are a `#[derive(CommandSet)]` enum. The model is `BrushSettingsCommand` (`panels/brush_panel.rs:189-250`).
   - Mixing app rows with the framework's: `panels/layers_panel_ui.rs:128-140`.
   - `cargo xtask panel-commands` has an empty allow-list, so every click handler must dispatch a command.
3. **Dialogs** open on `app.framework.dialogs`.
   - Form dialogs go through `crate::dialogs::params::open_param` (`dialogs.rs:133`). Each is owned by a
     `ParamFamily` in `PARAM_FAMILIES` (`dialogs.rs:85-115`).
   - Results come back through `filter_dialog::command_params` (`dialogs/filter_dialog.rs:577`), which maps every
     field straight into the command's params. Per-command fix-ups go there (example: `image_processor_ui::nest`).
   - Tests set fields with `ui.dialog.set` or `app.framework.dialogs.set_json_field`, and close dialogs with
     `crate::dialogs::testing::{confirm, cancel}`.
4. **Menus.** An engine `CommandSpec` with a `menu` path becomes a menu row automatically (`menus/items.rs:181-210`).
   It is placed through `PLACE_AFTER` (`menus/items.rs:40`) or a Pigment place hook (there is one for AI:
   `ai_ui::place_after`, called at `menus/items.rs:201`). Do not add rows to `menu_catalog.rs`: it is Photoshop's tree,
   and `parity-checklist.md` is generated from it.
5. **Preferences live in `config.toml`** (`craft::settings::SettingsStore<SavedPrefs>`, `prefs.rs:1781-1810`; TOML has
   no null). The shell keeps its own panel options as JSON in `Preferences.dialogs` under a key. The Histogram panel
   does this: `panels/histogram_panel.rs:34` `OPTIONS_PREF`, `persist_options` at 157, `restore_options` at 166, and
   the restore is called at `app.rs:237`. That needs no new `Preferences` section, no validation and no scorecard
   change.
6. **`unsafe` is forbidden** in every crate (`Cargo.toml:107`) except `crates/tablet` (`macos.rs`, `windows.rs`;
   `crates/tablet/Cargo.toml:8-13`). This matters for U3 and for U4's Windows call.
7. **Integration tests** are one binary per crate: `crates/<crate>/tests/it/main.rs` lists the modules. Add each new
   test file there.
8. **Upstream tests must keep passing**: `scripts/upstream-test-failures.txt` is empty. Where a Pigment change has to
   alter an upstream test, the package below names the test. Change as little as you can and list the change in
   `docs/FORK.md` under "What Pigment added".
9. **The engine's place for Pigment command modules:** declare `pub mod <x>_cmds;` in `crates/engine/src/cmd.rs` and
   add `v.extend(crate::<x>_cmds::specs());` to the registry (`cmd.rs:1474`, beside the "Pigment: generative AI" hook).
   Mark both lines `// Pigment: …`.

---

## F1: File Info tabs, rating, IPTC, GPS, Camera Data (rows 33, 34, 35, 36)

### Status of each row

| Row | Now | Evidence |
|---|---|---|
| 33 Basic with Rating | **partly** | `file.fileInfo` edits title, author, authorTitle, description, keywords, copyright, copyrightStatus and copyrightUrl (`crates/engine/src/cmd/file_cmds.rs:356-363`; `file_cmds/info.rs` `INFO_FIELDS` :6, `read_file_info` :163, `write_file_info` :528, `file_info` :594). There is no rating, no Description Writer, and no created, modified, application or format read-outs. |
| 34 / 35 Origin, IPTC, IPTC Extension, GPS | **missing** | No such keys in the command. The dialog is one flat form (`menus/view_cmds/dialogs.rs:429-468` `file_info_form`). |
| 36 Camera Data | **partly** | 9 fields (`info.rs:196` `CAMERA_FIELDS`; `camera_data` :288, read through `photocraft_algo::exif::read`, which is now a facade over `craft_metadata::camera_fields`, `crates/algo/src/exif.rs:4`). Missing from JS's 17 tags: exposure program, exposure bias, metering, flash, white balance, software and lens make. GPS is also missing. |

No row is dropped. Upstream hardened its own XMP writer since abb30df: #11116 (non-canonical `rdf:RDF` endings and
prefixes) and #13821 (`xmpRights:Marked` in every attribute form). It also improved the exposure text (#6958). It
added no fields.

### Where things are now

| Spec names | Now |
|---|---|
| `file_cmds.rs` line 340 (the spec) | `crates/engine/src/cmd/file_cmds.rs:356-363` |
| `file_cmds/info.rs` `INFO_FIELDS` 6, `camera_data` 288, `write_file_info` 318, `file_info` 381 | still there: `INFO_FIELDS` :6, `read_file_info` :163, `CAMERA_FIELDS` :196, `camera_data` :288, `write_file_info` :528, `file_info` :594 |
| `photocraft_algo::exif` (`algo/src/exif.rs:113`) | now 30 lines: re-exports `craft_metadata::camera_fields::{CameraInfo, read, try_build}` |
| `Metadata { xmp, exif, psd_resources }` (`doc/src/lib.rs:876`) | unchanged, at `:876-892`. Resource 1028 (IPTC) survives PSD open and save raw (`io/src/psd_import.rs:1199`, `psd_export/document.rs:246`) |
| craft-metadata "not yet a Pigment dependency" | **now a workspace dependency** (`Cargo.toml:68`), used by `crates/algo` only. Add `craft-metadata = { workspace = true }` to `crates/engine/Cargo.toml` (and to `crates/io/Cargo.toml` for the IIM part). |
| `craft_metadata::parse_xmp` / `merge_xmp` | `parse_xmp`/`parse_xmp_with` (`CL/metadata/src/xmp.rs:1013/1018`) return `XmpData { properties, values: BTreeMap<String, XmpValue> }` (`:91`); `XmpValue` is Text, Array or Struct (`:208`). `merge_xmp(existing, fresh, MergeRules { owned, owned_if_present, namespaces })` (`CL/metadata/src/xmp_merge.rs:217`) keeps everything it does not own byte for byte. **There is no general writer for arbitrary properties** (`write_xmp_with` writes `Metadata` plus simple properties of one namespace). The `plus:`, `xmpDM:` and `Iptc4xmpExt` struct fields need a small serializer of Pigment's own. `plus:` is not among the standard namespaces (`xmp.rs:42-62`), so pass it in `MergeRules.namespaces`. |
| `craft_metadata::read_exif` | `CL/metadata/src/exif.rs:13` → `Metadata` with flash, bias, program, metering, white balance, software, serial, lens make and model, and `gps` (lat, lon, alt only, `lib.rs:59`). GPS time and direction come from `craft_metadata::tag_rows` (`tags.rs:338`, rows of group `"GPS"`). |
| `parse_iptc` | `CL/metadata/src/iptc.rs:79` (reader only). **There is no IIM writer in craft**, so `crates/io/src/iptc_iim.rs` stays as planned. |
| JPEG APP13 on export | craft-image-codecs reads APP13 into `Metadata.photoshop_resources` (`CL/image-codecs/src/codecs/jpeg.rs:529`) but **does not write it**. Splice the APP13 segment into the encoded bytes yourself (below). |
| UI `menus/view_cmds/dialogs.rs` line 142/458 | still a hosted form: `FORM_COMMANDS` (:13-37, holds `"file.fileInfo"`), `params_for` arm (:209), `file_info_form` (:429). The family is `view_cmds::dialogs::is_form` → `filter_dialog::run` (`dialogs.rs:106`). |
| "tabbed dialog `dialogs/file_info_ui.rs`" | new; see the plan for how it stays a `HostedParamDialog` |
| AI Describe Image | `ai_ui/describe.rs:98` writes `{"description": text}` through `file.fileInfo`. It does not write alt text. `assistant_tools.rs:276/304/1422` allow the command. |

### The plan, adjusted

**Engine** (Pigment file `crates/engine/src/cmd/file_cmds/info_more.rs`, `mod info_more;` in `file_cmds.rs`):
- Keep upstream's `read_file_info`/`write_file_info` for the eight keys they own, so upstream's fixes stay in one place.
  Pigment adds the spec's field table (`[(param, xmp_path, kind, tab)]`, every key the spec lists) for the rest:
  - **Read:** `craft_metadata::parse_xmp_with(x, &[plus, xmpDM])` → `values`.
  - **Write:** serialize the edited Pigment keys into a fresh packet of their own, then
    `merge_xmp(existing_after_upstream_write, fresh, MergeRules { owned: <the XMP names of the edited keys>, namespaces })`.
- Hook in `file_info` (`info.rs:594`), two lines marked `// Pigment:`:
  - after the upstream write, `info_more::write(&mut new, p)?`;
  - after `read_file_info`, `info_more::read(&mut info, d)`, which adds the new keys plus read-only `camera` (extended),
    `gps`, `raw`, `created`, `modified`, `application` and `format`.
  - The `edits` key list (`info.rs:595`) must also see Pigment's keys. Write it as
    `keys.contains(..) || info_more::KEYS.contains(..)`.
- **Camera Data:** extend in `info_more::camera` with `craft_metadata::read_exif`: program and metering as names, flash
  text, bias, white balance, software, lens make, serial, pixel dimensions and orientation. Merge these into the
  `camera` object after upstream's nine, so `CAMERA_FIELDS` and its UI consumer stay as they are. Add Pigment's labels
  in a `CAMERA_MORE` table beside it.
- **The params string** (`file_cmds.rs:361`): append the new keys. This is an upstream line, so mark the edit.
- **Rating:** 0–5, clamped; −1 (rejected) is read but not shown. **Urgency:** 1–8 or none.
- **IIM (`crates/io/src/iptc_iim.rs`, new):**
  - `encode(&XmpFields) -> Vec<u8>` with the datasets the spec lists, 1:90 = `ESC % G`;
  - `irb_1028(bytes)` and `insert_app13(jpeg: &[u8], irb: &[u8]) -> Vec<u8>` (after SOI/APP0/APP1, Photoshop 3.0
    header, split over 64 KB segments).
  - **PSD save:** replace resource 1028 in `doc.metadata.psd_resources` only when File Info changed. Set a flag on the
    `file_info` edit; the simplest form is to rewrite the resource inside the same `s.edit("File Info", …)`. Then the
    PSD writer needs no hook and an unchanged file stays byte-identical.
  - **JPEG export:** after the flat encoder runs, when the export's metadata setting is "all" and the document has a
    1028 resource, call `insert_app13`. The hook is one call in the flat export path for JPEG (`io/src/flat.rs`, where
    the JPEG bytes are returned).
  - **Reading:** in the flat import, when the codec image has `photoshop_resources` holding 1028 and the file has no
    XMP, seed `metadata.xmp` from `craft_metadata::parse_iptc` (written through the same serializer). The hook goes
    beside the guides read (`flat.rs:929` and `:1143`). Keep the raw 1028 in `psd_resources` too.

**UI** (`crates/ui-egui/src/dialogs/file_info_ui.rs`, new). It **stays a `HostedParamDialog`**, so upstream's tests that
drive it as one keep passing: `menus/view_cmds/tests.rs:201-204` (`open_form` + `set "title"`) and `dialogs/tests.rs:71-88`
(`get_by_id::<HostedParamDialog>` and the multiline `description`/`copyright`).
- `file_info_form` (`view_cmds/dialogs.rs:429`) is upstream's. Replace its body with one Pigment call,
  `crate::dialogs::file_info_ui::form(app)`, which returns `(Vec<Param>, DialogFields)` with upstream's eight rows first,
  under the same keys.
- **Tabs:** a first row `Param::custom("tab", …)` draws a `TabStrip` (as in `variables_ui.rs:395-406`) and writes the
  `tab` field (Basic, Camera Data, Origin, IPTC, IPTC Extension, GPS Data, Raw Data, and the read-only tabs only when
  their namespaces are present). Every other row gets `.visible_when("tab", "<tab>")`. `tab` defaults to `basic` and
  is `.not_remembered()`.
- **Rating:** `Param::custom("rating", …)` over `craft::ui::choice::Rating::new(bind, 5)`.
- **Structs** (creator contact info, location shown/created, licensor, …) become flat rows with slashed keys
  (`creatorContactInfo/CiAdrCity`), as Image Processor's `tiff/width` rows do. Lists (keywords-style Bags) are
  multiline text split on `;`.
- **The params:** `filter_dialog::command_params` (`filter_dialog.rs:577`) passes every field through.
  - Add one Pigment line there, `if command == "file.fileInfo" { crate::dialogs::file_info_ui::nest(&mut map) }`.
    `nest` drops `tab`, folds the slashed keys into objects and keeps the read-only `camera/…`, `gps/…` and `raw` rows
    out.
  - Without it, the engine would receive `tab` and the slashed keys. The engine ignores keys it does not know, but
    `nest` keeps the params clean for Actions.
- **Read-only tabs:** `Param::read_only_text` rows (as the camera rows do now, `view_cmds/dialogs.rs:457`). For Raw
  Data, one multiline read-only row plus a Copy button (`Param::custom` with `craft::ui::buttons::Button` that
  dispatches a command; `ui.clipboard.copyText` or the app's clipboard command, so `xtask panel-commands` stays clean).
- **Template Import…/Export… (.xmp files):** use the file pickers on the app (`file_dialog.rs` `pick_file_bytes_filtered`,
  `pick_save`). This part is optional, as the spec says.
- **Words:** `tl!` for every label the spec lists. "Camera Data" and the camera labels already go through
  `tr_ctx(lang, "cameraData", label)`; use the same context for the new camera labels.
- **The AI team:** `altText` is `Iptc4xmpCore:AltTextAccessibility`. Describe Image writes only `description` today
  (`ai_ui/describe.rs:98`), so nothing breaks. Tell them the key exists.

### Tests

The spec's tests stand.
- **Engine** (`crates/engine/src/cmd/file_cmds/tests.rs`, or a new `info_more_tests.rs` as `#[cfg(test)] mod`): every
  field reads back as set; an unknown property of the original packet survives (parse with
  `craft_metadata::parse_xmp`); rating 7 → 5; the IIM round trip with UTF-8 through `parse_iptc`; Camera Data on an
  EXIF with GPS gives JS's 17 tags plus GPS; upstream's eight keys still behave as upstream's tests say.
- **io** (`crates/io/tests/it/`, add the module to `main.rs`):
  - a PSD whose File Info is unchanged saves byte-identical;
  - a JPEG with only IIM seeds the fields;
  - a JPEG export with "all" metadata carries APP13 1028, which `craft_metadata::container::jpeg_segments` reads back.
- **ui:** open File Info, switch `tab` to `origin`, set `headline` with `ui.dialog.set`, confirm → one "File Info"
  history step and `file.fileInfo` reads it. Upstream's two File Info tests unchanged.

### Hooks to list in FORK.md

- `info.rs` `file_info` (2 lines plus the `edits` test);
- the `file_cmds.rs` params string;
- `view_cmds/dialogs.rs` `file_info_form` body;
- `filter_dialog.rs` `command_params` (1 line);
- `flat.rs` (IIM seed on read, APP13 splice on JPEG write);
- the `crates/engine/Cargo.toml` and `crates/io/Cargo.toml` dependency lines.

**Effort.** L, 2 days, as the spec said. The dependency is already in the tree. The struct serializer for
`merge_xmp`'s fresh packet costs what the text-search rewrite would have.

---

## F2: Targa variants, GIF in Export As, Color Lookup Table formats (rows 29, 30, 31, 32)

### Status of each row

| Row | Now | Evidence |
|---|---|---|
| 29 Targa 15/16-bit and colour-mapped | **mostly done** | Targa is still read by the `image` crate (`CL/image-codecs/src/codecs/tga.rs:1`), now 0.25.10 (`Cargo.lock`). Its decoder (`~/.cargo/registry/src/*/image-0.25.10/src/codecs/tga/decoder.rs:114-190`) reads colour-mapped images (8- or 16-bit indices, 15/16/24/32-bit entries), 15/16-bit 5-5-5, 24/32-bit, 8-bit grey and grey plus alpha, raw or RLE. **What is left:** a 16-bit file whose descriptor says one attribute bit opens with its alpha bit dropped (`decoder.rs:161-166` maps it to RGB). JS used it as alpha (`shared/pixels/tga.js:38`). Also, a colour map whose index is wider than its entry is refused (`decoder.rs:125`). |
| 30 Export As GIF | **missing** | `export_dialog.rs:27` `FORMATS` and `dialog_formats` (:222) list png, jpg, webp, tif, tga, ico and jxl. |
| 31 / 32 Color Lookup Tables | **partly** | Only `.cube` (`file_cmds.rs:434-441`; `file_cmds/export.rs` `bake_cube_layers` :153, `bake_cube` :190, `color_lookup_tables` :197; writer `craft_cms::lutfile::write_cube_export`, `CL/cms/src/lutfile.rs:648`). There is no copyright, no .3dl, .csp or ICC. **A bug to fix on the way:** the form offers Grid Size 2..256 (`view_cmds/dialogs.rs:316`) while the engine refuses more than 129 (`export.rs:205`, `MAX_SIZE` = 129, `CL/cms/src/lutfile.rs:29`). |

Nothing is dropped. For row 29, Photoshop-measured behaviour now exists upstream and must be kept: a 32-bit Targa
opens as an opaque Background plus an "Alpha 1" channel, even when the header declares no alpha bits
(`io/src/flat.rs:425-458` `tga_alpha_to_channel`, #2225; tests `io/tests/it/flat.rs:881-960`).

### Where things are now

| Spec names | Now |
|---|---|
| `io/src/flat.rs` `import_flat_with` (71), sniff, `tga_alpha_channel_to_transparency` (463) | the decode is `import_flat_impl_with_options` (`flat.rs:99-127`, `codecs::decode_as_with` at :121). The format's finishing step is `apply_flat_format` (:262-305; the Targa alpha channel at :282). `tga_alpha_channel_to_transparency` is at :463. |
| `craft-tga` | `CL/tga/src/lib.rs` (`sniff` :115, `decode` :287, `Picture { rgba, layout, has_alpha }`). **Not in Cargo.lock yet.** Add `craft-tga = { git = …craft-libs, rev = "18ffc07…" }` to the workspace and `crates/io/Cargo.toml`. It is the same repository and revision, so nothing new is fetched. **Note:** its 32-bit rule ("alpha bits unset and all alpha zero → opaque", `lib.rs:384-391`) differs from upstream's Photoshop-measured channel rule, so do not route 32-bit files through it. |
| `targa_options_ui.rs` "Bits/Pixel" | `crates/ui-egui/src/dialogs/targa_options_ui.rs` (74 lines). Export As's TGA bits are the framework's `[24, 32]` (`export.rs:118`). 16-bit write stays out, as the spec said. |
| `export_dialog.rs` line 19 `FORMATS`, `SETTINGS` line 28 | `export_dialog.rs:27` `FORMATS`, `:40` `SETTINGS`, `:62` `valid_setting`, `:222` `dialog_formats` (the framework's `ExportFormat::standard()` + JPEG XL), `:505` `export_document` (Transparency off flattens, `:525`), `:593` `settings`. The dialog is `HostedExportAs`. |
| `web_cmds/optimizer.rs` 232–296, `web_cmds/assets.rs` 149 | still there (`web_cmds/optimizer.rs`, 437 lines; `web_cmds/assets.rs`, 368 lines). **Not needed:** Export As writes through `app.services.export` → `photocraft_io::export(doc, "x.gif", …)` (`apps/photocraft/src/services.rs:476`), the same GIF encoder Save As GIF uses, which quantises to 256 colours (`CL/image-codecs/src/fidelity.rs:253`). |
| `file_cmds/export.rs` `bake_cube_layers` (151), `bake_cube` (204), `color_lookup_tables` (211) | `:153`, `:190`, `:197` |
| `craft_cms::lutfile` readers / writers | readers `parse_cube` (:289), `parse_3dl` (:367), `parse_look` (:571); writers `write_cube`, `write_cube_commented`, `write_cube_export` (:606-648). **Still no .3dl or .csp writer.** |
| `craft_cms::write::encode` | `CL/cms/src/write.rs:254`: writes `desc`, `cprt`, A2B/B2A `Lut`s (`LutKind::Ab` → mAB). `ProfileClass::DeviceLink` exists (`CL/cms/src/profile.rs:27`). |
| the CLUT dialog in `menus/view_cmds/dialogs.rs` | the form arm `"file.export.colorLookupTables"` at `view_cmds/dialogs.rs:301-320` (rows path, size, title, scope) |

### The plan, adjusted

**Targa (S, half a day):**
- In `flat.rs` `import_flat_impl_with_options`, before the generic decode (:121), add a Pigment hook:
  `if format == Some(Format::Tga) && let Some(img) = crate::tga_more::decode(bytes, &limits)? { … }`.
- `crates/io/src/tga_more.rs` (new) reads the header itself. It decodes with `craft_tga::decode` **only** when the
  `image` crate cannot do the file right:
  - true-colour 16-bit with one attribute bit (alpha);
  - a colour map whose index is wider than its entries;
  - and, as a fallback, when `codecs::decode_as_with` fails on a Targa.
- It returns a `codecs::Image` (RGBA8 when the picture has alpha, else RGB8). The rest of the path is unchanged, so
  `apply_flat_format` (:282) turns the alpha into "Alpha 1" as for 32-bit files, which keeps upstream's rule. Every
  other Targa goes the old way.
- Tests in `io/tests/it/flat.rs`: reuse the byte-by-byte helper `tga_file` (:864) and add:
  - type 2 16-bit with one attribute bit → RGB plus "Alpha 1";
  - type 1 with a 16-bit index and 15-bit entries;
  - type 9 RLE colour-mapped;
  - top-left origin.
  Existing Targa tests unchanged.

**Export As GIF (XS):**
- In `export_dialog.rs`, add `("gif", "GIF")` to `FORMATS` (:27, an array length change) and
  `formats.push(ExportFormat::new("gif", "GIF").transparency(true))` to `dialog_formats` (:222). That is two lines in
  an upstream file, marked. The framework shows Quality only for formats built with `.quality(true)`, so GIF shows
  Transparency only.
- Transparency off flattens (:525), which mattes on the background as Photoshop does. Nothing else is needed.
- Tests: next to upstream's export dialog tests, choosing `gif` keeps `quality` out of the settings; a 2-colour
  document exported to GIF decodes (`photocraft_codecs::decode`) to the same pixels; with Transparency off the
  transparent pixels are the matte.

**Color Lookup Tables (M, 1 day):**
- `file_cmds/export.rs`:
  - Split `bake_cube_layers` into `bake_table(size, layers, depth) -> Vec<[f32; 3]>` (blue-slowest rows, as now) and
    the writers. `write_cube_export` keeps its header, so upstream's `export_clut_cube_header_tests.rs` passes. Add the
    copyright as a `# Copyright: …` line after the header.
  - The new writers go in a Pigment file `file_cmds/lut_writers.rs`: `write_3dl` (port JS `write3dl`; check that
    `craft_cms::lutfile::parse_3dl` reads it back), `write_csp`, and `write_icc` (a `Profile` with
    `class: ProfileClass::DeviceLink`, RGB→RGB, `a2b[0]` = identity curves + `Clut` + identity curves as `LutKind::Ab`,
    `description`, `copyright`, through `craft_cms::write::encode`).
  - Refuse ICC for CMYK and Lab documents with a clear error, as the spec says.
- **Params:** keep every key and result upstream has. `{"size", "title", "scope", "layers", "path"}` and the result
  keys `cube`, `size`, `layerCount` are asserted in `engine/src/cmd/file_cmds/tests.rs:3383-3414` and
  `ui-egui/src/menus/view_cmds/tests.rs:557-559`. Add:
  - `"formats":["cube","3dl","csp","icc"]=["cube"]`, `"copyright":str?`, `"lowercase":bool=true`;
  - results `threeDl`, `csp` and `icc` (base64) without `path`, and `files:[…]` with `path`.
  - With several formats, `path` is the base: its extension is replaced per format.
- **Size:** writing takes 2..=256 (ICC ≤ 255, said in the error). Keep the 129 cap only where a table is parsed back.
  Change the check at `export.rs:205` (an upstream line, marked) to
  `2..=MAX_EXPORT_SIZE` with a Pigment `const MAX_EXPORT_SIZE: u64 = 256`. Stream the text writers. At 256³ the table
  is 16.7 M rows, so bake in bands if memory is a concern: `bake_table` composites an n²×n lattice (256² × 256 F32 RGBA
  ≈ 268 MB). If that is too much, cap at 129 and record it.
- **The form** (`view_cmds/dialogs.rs:301-320`): add rows `copyright` (text), `lowercase` (bool),
  `quality`/`size` as a choice of Photoshop's names (Poor 7, Low 17, Medium 33, High 64, Maximum 256; keep the key
  `size`, because the upstream test asserts `fields["size"] == 33`), and four format check boxes `formats/cube`,
  `formats/3dl`, `formats/csp`, `formats/icc`. Fold the check boxes into `formats` with a one-line Pigment fix-up in
  `filter_dialog::command_params`, beside the File Info one.
- Tests as in the spec: each format parses back (craft-cms for .cube and .3dl, a test parser for .csp); the ICC opens
  with craft-cms and maps a few colours like the table; the copyright is in each file; four files with lowercase
  extensions.

### Hooks to list in FORK.md

- `flat.rs` (Targa decode, 1 call);
- `export_dialog.rs` (`FORMATS`, `dialog_formats`);
- `file_cmds/export.rs` (the size check, the bake split);
- `view_cmds/dialogs.rs` (the CLUT rows);
- `filter_dialog.rs` (formats fold);
- `crates/io/Cargo.toml` and the workspace `Cargo.toml` (`craft-tga`).

Also update `docs/file-format-parity.md:42` (Targa) with a Pigment note.

**Effort.** S + XS + M, about 1.5 days (the spec said 1.5 days). Targa got smaller and the LUT part a little larger,
because the size cap and the bake memory need care.

---

## F3: AVIF open (rows 27, 28)

### Status of each row

**Missing in Pigment, but upstream's framework built the decoder.**
- craft-image-codecs at 18ffc07 has a full AVIF reader behind the non-default feature `avif-decode`
  (`CL/image-codecs/Cargo.toml:24`; `CL/image-codecs/src/codecs/avif_decode.rs`, 1357 lines).
- It handles the primary `av01` item or a `grid`; 8-, 10- and 12-bit; 4:2:0, 4:2:2, 4:4:4 and monochrome; full or
  limited range; `nclx` or the sequence header's colour; ICC from `prof`/`rICC`; alpha from `auxl` (with `prem`);
  Exif and XMP items; and `clap`, `irot` and `imir`. PQ and HLG files open as linear 32-bit float. Input is bounded
  for hostile files, and a decoder panic becomes an error (header, `:1-27`).
- It decodes through craft-video's AV1 decoder, whose conformance table is done and bit-exact, film grain included
  (`CL/video/src/av1/decode/README.md:15-40`).
- `decode_as_with(Format::Avif, …)` dispatches to it (`CL/image-codecs/src/lib.rs:143-145`).
- Pigment does not turn the feature on: `Cargo.toml:24`, `crates/io/Cargo.toml:15-16` and `apps/photocraft/Cargo.toml:17-19`
  forward only `heif`. So AVIF does not open, and an upstream test asserts that
  (`engine/src/cmd/file_cmds/tests.rs:4074-4075`, "PhotoCraft does not read AVIF").

The spec's own ISOBMFF reader (`crates/io/src/avif.rs`) is **dropped**: the framework's reader does all of it, with
the bounds the spec asked for. The row itself is not dropped; it becomes a switch-on.

### Where things are now

| Spec names | Now |
|---|---|
| `craft-image-codecs` `format.rs` line 294 caps | `Format::Avif` caps at `CL/image-codecs/src/format.rs:323`. They report read when `avif-decode` is on (native only). |
| `craft-video` feature `av1-decode`, `crates/video/src/av1/decode/` | used by craft-image-codecs' `avif-decode`. Pigment adds no direct dependency. |
| `craft-heif` `items.rs` | not needed |
| `crates/io/src/avif.rs` (new) | **not needed** |
| `crates/io/src/lib.rs` route table (~967–1050) | the routes are at `io/src/lib.rs:968-982`. AVIF needs no route: `photocraft_formats::detect` gives no document format for it, so it falls to the flat path (`flat.rs:99-127`), where `codecs::detect` names it. The `nclx` → profile tagging (`flat.rs:318-332` `cicp_profile`, `:309` `hdr_fallback`) already applies to any image with a CICP, as it does for HEIF. |
| the Open dialog's file types | `crates/ui-egui/src/file_dialog/filters.rs:12-16` (`OPEN_EXTS`) and `:24-58` (`OPEN_FILTERS`) list no `avif` |
| batch folder listing | `engine/src/cmd/file_cmds/paths.rs:94-98` `openable_name` asks `Format::caps().read`, so it follows the feature by itself |

### The plan, adjusted

1. **Switch it on.**
   - Add `avif = ["photocraft-codecs/avif-decode"]` to `crates/io/Cargo.toml` `[features]`, beside `heif`.
   - Make the desktop app depend on it, either through `photocraft-io = { workspace = true, features = ["avif"] }` in
     `apps/photocraft/Cargo.toml` and in `photocraft-cli`'s manifest, or through `default`.
   - The feature compiles to nothing on wasm32 (`CL/image-codecs/src/lib.rs:143`), so the web build is unaffected.
   - CI builds the workspace with `--features heif` (`.github/workflows/pigment-ci.yml:138-184`). A dependency feature
     in the app's manifest is unified into those builds, so CI tests AVIF without a workflow change. Check that
     `cargo tree -e features -p photocraft-io` shows `avif-decode` in the CI configuration.
   - Packaging scripts (`packaging/*/package.sh`, `package.ps1`) need no change for the same reason.
2. **Open dialog:** add `"avif"` to `OPEN_EXTS` and `("AVIF", &["avif"])` to `OPEN_FILTERS`
   (`file_dialog/filters.rs`, upstream lines, marked).
3. **The upstream test** `folder_listing_takes_every_format_photocraft_opens` (`file_cmds/tests.rs:4074-4075`) asserts
   that AVIF does not open. Change its last assertion to
   `assert_eq!(super::openable_name("a.avif"), photocraft_codecs::Format::Avif.caps().read)` and list the edit in
   FORK.md.
4. **Errors and words:** the decoder reports `CodecError::unsupported(Avif, …)` for what it does not read (image
   sequences, layered `lsel`/`a1lx`). The open path shows codec errors as they come, so no new string is needed. Add
   one `tl!` only if you wrap them ("This AVIF uses a feature Pigment cannot decode yet: {what}").
5. **Docs:** add a Pigment note to `docs/file-format-parity.md:35` (AVIF read: yes in Pigment) and the user guide's
   format list. Add a line in FORK.md "What Pigment added".

### Tests

The intent is unchanged; the fixtures are cheaper.
- `crates/io/tests/it/avif.rs` (add it to `main.rs`).
- Fixtures under `crates/io/tests/fixtures/avif/` with a README:
  - copy craft-libs' two (`CL/image-codecs/tests/fixtures/avif/quad-420-bt709.avif`, `quad-444-gbr-lossless.avif`,
    with their `.yuv`/`.rgb` oracles and README; same project and licence);
  - generate the rest once with the ffmpeg in this container (`ffmpeg -encoders` lists libaom-av1, librav1e and
    libsvtav1): 8-bit 4:2:0 opaque, 8-bit with alpha, 10-bit 4:4:4, a 2×2 grid, `irot` 90°. Record the exact
    commands. Check the alpha and grid outputs with `MP4Box -info` or a box dump. If ffmpeg cannot write a grid or
    alpha item, take those from craft-libs' own test data or note them as not covered.
- What to check:
  - pixels against the oracles, within ±1 for 8-bit;
  - a 10-bit file opens as a 16-bit document;
  - alpha opens as transparency;
  - `irot` is applied;
  - a truncation loop (every prefix errors, never panics);
  - an oversize `ispe` is refused by the limits (`ImportOptions` → `decode_limits`, `flat.rs:121`).

**Effort.** S, half a day to one day, instead of L.

---

## U1: Info panel readout modes and 16/32-bit values (rows 41, 42)

### Status of each row

| Row | Now | Evidence |
|---|---|---|
| 41 second colour readout modes | **missing** | `panels/info.rs:176-180` `info_panel` draws the framework's `InfoPanel` over `InfoReadings`. Its colour is `InfoColor { rgb: [u8; 3], cmyk: [u8; 4] }` (`CL/color-ui/src/ui/info.rs:57-80`), with fixed R/G/B and C/M/Y/K lines (`:241-288`). There is no mode, no Lab, HSB or Web, and no per-sampler mode. |
| 42 16-bit and 32-bit values | **missing** | `info.rs:85-88` `byte()` clamps to 0..255. Samplers come as 8-bit `rgb` from `view.colorSamplers.list` (`sampler_cmds.rs:57-59` `point_json`). |

Nothing is dropped. Since abb30df upstream moved the panel to the framework (243 lines of diff) and added the
ruler rows (#11991), the guide position (#5728), Sample Size averaging (#1649, #11751) and per-revision sampler
caching (#4528).

### Where things are now

| Spec names | Now |
|---|---|
| `panels/info.rs` `info_panel` (~35), `q()` | `info_panel` `:176`; `readings` `:95-140`; `byte` `:86` (the old `q()`); `pointer_sample` `:16` (floats 0..1, cached); `sampler_rows` `:153`; `sampler_readouts` `:197` |
| `sampler_cmds::device_cmyk`, `point_json` (57) | `sampler_cmds.rs:37` `device_cmyk`, `:48` `readout`, `:57` `point_json` |
| `photocraft_color::convert::srgb_to_lab` (201), `rgb_to_hsb` (251) | unchanged: `crates/color/src/convert.rs:201`, `:251`; `with_cmyk_space` `:78` |
| `crates/engine/src/proof_sim.rs` | still there (`display_lut_with` :153, `signature` :115). For a single colour, sample the proof through the same transform; there is no one-colour helper yet. |
| `Preferences.adjustments.info_panel` / `Preferences.info` (D3) | **not needed.** Store the options as shell JSON in `Preferences.dialogs["infoPanel"]`, as the Histogram panel does (`histogram_panel.rs:34`, `:157-172`; restored at `app.rs:237`). No `prefs.rs` or `validate.rs` edit, no scorecard regeneration. |
| "Panel Options…" panel menu | the Info panel has no menu rows yet: `registry.rs:147` is a plain `panel("info", …)`. The model for adding them is the Histogram entry (`registry.rs:140-145`) or `BrushSettingsCommand` (`brush_panel.rs:189-250`). |
| `InfoPanel` labels | the framework's `InfoWords` (`CL/color-ui/src/ui/info.rs:27-50`: R, G, B, C, M, Y, K, X, Y, W, H, A, L, L1, L2, "Doc: …", "No document"). Pigment adds L, a, b, H, S, B, #, Total Ink, Opacity, K (grey) through `tl!`. |

### The plan, adjusted

The framework panel cannot show modes, and Pigment cannot change it, so **Pigment draws its own grid** when the
readouts are not the framework's default.
1. **`crates/ui-egui/src/panels/info_readout.rs` (new, pure):**
   - `readout(mode, rgba: [f32; 4], depth: SampleType, doc_mode, cmyk_space, proof) -> Vec<(Label, String)>`, as the
     spec says. Depth scaling: 8-bit 0–255; 16-bit `round(v*32768)` or `round(v*65535)`; 32-bit `{v:.4}` unclamped.
   - Plus `show(ui, readings, options)`, which draws the same layout as the framework's `InfoPanel` (two columns of
     name and value pairs, then position and size, then `Doc: …` and the samplers). Build it from
     `craft::ui::layout_components::{Grid, Stack}` and `craft::ui::display::Text`, and use `InfoWords` for the shared
     labels (copy the 4-column `Grid` of `CL/color-ui/src/ui/info.rs:22-24`, 202-222).
2. **The hook in `info_panel` (`info.rs:176`, upstream):** one Pigment line,
   `if let Some(o) = crate::info_readout::custom(app) { return crate::info_readout::show_panel(app, ui, &samplers, o); }`.
   `custom` returns `None` when the first readout is Actual or RGB, the second is CMYK, the document is 8-bit and no
   sampler has its own mode. **The default look stays the framework's**, so upstream's Info tests
   (`info.rs:211-216`, `info_ruler_tests.rs`) keep passing.
3. **Deep values:**
   - The pointer already has floats (`pointer_sample`).
   - For samplers, add `"float": [r,g,b,a]` to `sampler_cmds::point_json` (`:59`, one upstream line) from the
     readout's average before rounding. `sampler_rows` reads it only in Pigment's grid.
4. **Menu:** add `rows`/`states`/`run` to the `info` entry (`registry.rs:147`, one upstream line), with a Pigment
   `InfoPanelCommand` `CommandSet` (prefix `infoPanel`, scope `app`) in `info_readout.rs`. Its rows:
   - "Panel Options…" opens a form through `open_param` with a `ParamFamily` of its own (register it in
     `PARAM_FAMILIES`, `dialogs.rs:85-115`; one line). The form has First Color Readout and Second Color Readout
     (choices of the ten modes) and the 16-bit range (radio). The mouse-coordinate unit is
     `Preferences › Units & Rulers`, so link to it rather than duplicating it.
   - The two readouts' mode menus (Photoshop's eyedropper icons) are two more rows, "First Readout ▸ …" and
     "Second Readout ▸ …". The framework's grid has no clickable label, so the panel menu is where the modes live.
     Per-sampler modes go in the same menu as "Sampler #n ▸ …" rows while samplers exist. That replaces the spec's
     right-click on a sampler row, which the framework's grid does not offer.
5. **Persistence:** `infoPanel` JSON in `prefs.dialogs`, as above: `{"first","second","sixteenBit","samplers":[…]}`.
   Restore it next to `histogram_panel::restore_options` (`app.rs:237`, one line).
6. **Words:** the spec's list, through `tl!`.

### Tests

The spec's tests stand.
- `info_readout` unit tests: 16-bit mid grey 16384 or 32768; 32-bit 1.5 → "1.5000"; HSB of red; Total Ink of black;
  Web hex.
- ui: the menu row "Second Readout ▸ Lab Color" fired through `run_fired` makes `show_panel` produce L/a/b labels.
  Read the labels from `info_readout::lines(app)`, a pure function `show` draws from, so the test does not have to
  scrape egui. The options survive `persist`/`restore`.
- The default 8-bit RGB document still goes through the framework panel (`custom` is `None`).
- If `point_json` grows `float`, the engine test is `sampler_cmds` tests: a 16-bit fill reads back unrounded.

### Hooks to list in FORK.md

`info.rs` `info_panel` (1 line), `registry.rs:147`, `sampler_cmds.rs:59`, `dialogs.rs` `PARAM_FAMILIES` (1 line),
`app.rs:237` (1 line).

**Effort.** M, 1–1.5 days (the spec said S–M, 1 day). The panel's grid has to be drawn by Pigment because the
framework's is fixed.

---

## U2: Actions: Default Actions and Insert Conditional (rows 37, 38, 40; row 39 dropped)

### Status of each row

| Row | Now | Evidence |
|---|---|---|
| 39 Clear All, Reset, Replace | **done upstream: dropped** | Engine: `actions.clearAll` (`actions_edit_cmds/library_commands.rs:123`), `actions.reset {"confirm":true,"mode":"replace"/"append"}` (`:145`), `actions.replace` (`atn_cmds`) and one library undo `actions.undoLibrary` (`:1-20`, `undo_library_label`); refused while recording or playing (`:44-59`). UI: the framework's menu group `[ClearAll, Reset, Load, Replace, Save]` (`CL/automation/src/ui/actions/menu.rs:258-264`), with Photoshop's questions (`LibraryPrompt`, OK / Cancel / Append) in `panels/actions/library.rs:83-140` and the events at `panels/actions.rs:365-367`. Tests: `actions_edit_cmds/library_commands/tests.rs`, `panels/actions/library_tests.rs`. This covers everything the spec asked for row 39, plus the undo. |
| 37 / 38 Default Actions set | **missing** | Reset restores "Pigment Basics" (`BASICS_SET`, `library_commands.rs:25`) with two actions, Invert Colors and Desaturate (`basics`, `:137-143`). A missing `actions.json` gives an empty list (`preset_store.rs:705-709`). |
| 40 Insert Conditional dialog | **missing** (engine done) | `actions.conditional` plays and round-trips .atn with 33 conditions (`actions_edit_cmds.rs:253-287` `CONDITIONS`, `:340` `conditional`, spec `:472`). Steps show as "Conditional: cond → then / else" (`panels/actions/host.rs:45-49`). The framework's `ActionsPanelCommands` has no Insert Conditional row (`CL/automation/src/ui/actions/menu.rs:80-130`, 258-264). |

### Where things are now

| Spec names | Now |
|---|---|
| `panels/actions.rs` `panel_menu` (1585) | gone. The menu is the framework's: `panels/actions/menu.rs:26` `panel_rows` → `craft::automation::ui::actions::panel_rows(facts, &offered)`, `states` :32, `run_fired` :48. Events are applied by `panels/actions.rs:348` `apply_event`. |
| `actions_edit_cmds.rs` `actions.clearAll` / `actions.reset` | built upstream, in `actions_edit_cmds/library_commands.rs` |
| `atn_cmds.rs` `actions.load {"replaceAll"}` | not needed; upstream has `actions.replace` |
| `atn_cmds::DEFAULT_SET = "Pigment Actions"` (105) | unchanged, `atn_cmds.rs:105` (Save Actions' set name) |
| `crates/engine/src/actions_default.rs` (new) | still to write. Put it in `crates/engine/src/cmd/actions_default.rs` beside the other command modules. |
| `panels/actions/conditional.rs` (new, beside `menu_item.rs`) | still to write; `menu_item.rs` is at `panels/actions/menu_item.rs`. The model for a dialog that inserts a step is Insert Stop: `panels/actions/dialogs.rs:66-104` (`insert_stop_dialog`, `run_insert_stop`, `INSERT_STOP_FAMILY` :21, registered in `dialogs.rs:110`). |
| "Insert Stop, `actions.rs` line 1032" | `actions.insert {"action","id","params","at"}` (`actions_edit_cmds.rs:452-458`), as `run_insert_stop` uses it |
| "double-clicking a conditional step re-opens the dialog" | the framework's list has no step double-click event (`CL/automation/src/ui/actions/panel.rs:357`: a double click renames or plays an action). What it has is **Record Again** on a selected step, `ActionsEvent::RecordAgain { action, step }` (`panels/actions.rs:403`). Use that. |

### The plan, adjusted

**Default Actions (M, 1 day):**
- `crates/engine/src/cmd/actions_default.rs` (new): `pub fn default_actions(set: &str) -> Vec<Action>`. It holds the
  JS ten, translated step by step as the spec says, plus Photoshop's three where the commands exist (Make Clip Path,
  Save As Photoshop PDF, Mixer Brush Cloning Paint Setup).
- **Hook:** `library_commands.rs` `basics()` (:137-143) builds its `ActionsFile` from `default_actions(set)` (two
  lines, marked).
- **The set's name:** `BASICS_SET` (:25) is already a Pigment-edited line (FORK.md:75, :127 record "PhotoCraft Basics" →
  "Pigment Basics"). Change it to **"Default Actions"**, the name JS users and Photoshop users know, and update FORK.md
  rows 75 and 127. Check `scripts/pigment-rebrand.py --check` afterwards: it maps "PhotoCraft Basics" to
  "Pigment Basics", so adjust its table if it insists.
- **Upstream tests that name the two old actions:** change `actions_edit_cmds/library_commands/tests.rs:86`
  (`["Invert Colors", "Desaturate", "Invert Colors 2", "Desaturate 2"]`) and `:238` (`["Invert Colors", "Desaturate"]`)
  to the first names of the new set, or better to `default_actions(BASICS_SET)`'s names. List both edits in FORK.md.
  `panels/actions/library_tests.rs:73/76` use the constant and need nothing.
- **First launch:** Photoshop and JS start with Default Actions. In `preset_store.rs` `load_actions`, the
  `missing_file` arm (:707) returns `ActionList::new()`. Make that arm (Pigment, marked) return a list loaded from
  `default_actions(BASICS_SET)` **only when the preset store's directory is new**, meaning no `index` file either, so
  a user who cleared all actions (the file then exists and is empty) keeps an empty panel.
  - The upstream test `a_store_directory_that_does_not_exist_yet_opens_without_warnings`
    (`preset_store/tests.rs:390-400`) opens a directory that does not exist yet and asserts an empty list. So the
    seeding **must** sit behind a `seed_default_actions` flag that only the desktop app sets (an `open` option or a
    field the app sets before the store loads). Tests and the CLI then start empty, and that test stays as it is.
  - Do not recreate the set when the user deletes it (spec §8.3).
- Words: the action and set names through `tl!` at display time, as the spec says (`host.rs` `step_label` shows steps,
  `label_of` the commands).

**Insert Conditional (S):**
- `crates/ui-egui/src/panels/actions/conditional.rs` (new), modelled on `insert_stop_dialog`:
  - `open(app, edit: Option<(action, step)>)` opens a `ParamDialog` with rows If Current (a choice over
    `actions_edit_cmds::CONDITIONS` with Photoshop's labels), Then Play Action and Else Play Action (choices of the
    panel's action names plus None, from `crate::actions::action_form_choices` (`actions.rs:132`)).
  - `run` inserts `actions.insert {"action", "at", "id": "actions.conditional", "params": {"if","then","else"}}` after
    the selected step, and selects it as `run_insert_stop` does.
  - To edit, `run` does `actions.delete` of the old step, then `actions.insert` at the same index, and keeps the
    selection. Both are list edits, not document history.
  - A `CONDITIONAL_FAMILY: ParamFamily`, registered in `dialogs.rs` `PARAM_FAMILIES` next to `INSERT_STOP_FAMILY`
    (one line).
- **Menu row:** `panels/actions/menu.rs` `panel_rows` (:26) appends a Pigment `ActionsExtraCommand::InsertConditional`
  row (a `#[derive(CommandSet)]` enum, prefix `actionsPanel.pigment`, scope `app`, label "Insert Conditional…").
  - Splice it after the framework's `InsertStop` row by finding that `CommandRef` in the returned rows.
  - `states` gives it the state of `InsertStop`: enabled on a selected action or step.
  - `run_fired` (:48) tries the Pigment enum first. These are three hooks in a 60-line upstream file. Alternatively put
    the enum and its three functions in `conditional.rs` and call them from `menu.rs` with one line each.
- **The upstream test helper** `panels/actions/menu_tests.rs:17-25` `rows()` does
  `C::from_ref(&command).expect("an Actions row")` on every row, which the Pigment row breaks. Change it to skip rows
  that are not `ActionsPanelCommands` (`filter_map`, one line) and list the edit in FORK.md.
- **Editing:** in `apply_event`'s `RecordAgain` arm (`actions.rs:403`), when the step's command is
  `actions.conditional`, open `conditional::open(app, Some((action, step)))` instead of Record Again (one Pigment
  line).
- Words: "Insert Conditional…", "Conditional Action", "If Current:", "Then Play Action:", "Else Play Action:", "None",
  and the 33 condition labels.

### Tests

- **Engine** (`crates/engine/src/cmd/actions_default.rs` `#[cfg(test)]`):
  - every step id exists in `command_specs()`;
  - every default action plays without error on a 400×300 RGB document with a type layer and a selection where it
    needs one;
  - `actions.reset {"mode":"replace"}` gives the Default Actions set; `"append"` keeps user actions and numbers the
    set.
- **Seeding:** a fresh store with the flag on opens with the set; an existing empty `actions.json` stays empty.
- **ui** (`panels/actions/conditional_tests.rs`, `#[path]` module like the others): fire the row, set `if`/`then`/`else`
  with `ui.dialog.set`, confirm → the step is inserted after the selection with those params; Record Again on it opens
  the dialog with the values; confirming changes the step. The engine already tests playback.

### Hooks to list in FORK.md

`library_commands.rs` `basics` and `BASICS_SET`; the two upstream engine test assertions; `preset_store.rs`
`load_actions` missing-file arm (and the flag); `menu.rs` (3 lines); `menu_tests.rs` `rows()`; `actions.rs:403`;
`dialogs.rs` `PARAM_FAMILIES`.

**Effort.** M, about 1.5 days instead of 2: row 39 is gone, and Default Actions and Insert Conditional remain.

---

## U3: Pen tablet: Windows Ink tilt and rotation, macOS rotation (rows 43, 44)

### Status of each row

**Both are still missing**, as `docs/hardware-parity.md:36-37` and `:45-46` say (last updated 2026-11-08):
- Windows Ink has no tilt and no rotation. Only WinTab, opt-in with Windows Ink off, gives them.
- macOS rotation is read but not applied to the tip angle (#1301).
- Native Wayland stays dropped (spec §8.1). The X11 path through Xwayland now gives tilt and the eraser end
  (`hardware-parity.md:83`).

Upstream added the Windows eraser end (#2285, `windows.rs` `is_eraser_end` :145, `take_pen_end` :333) and the opt-in
WinTab backend (`crates/tablet/src/wintab.rs`). The Windows Ink sample path is unchanged.

### Where things are now

| Spec names | Now |
|---|---|
| `crates/tablet/src/windows.rs` `read_pen_flags` (~227), `POINTER_PEN_INFO` 94–100 | `POINTER_PEN_INFO` `:90-98` (`pen_mask`, `rotation`, `tilt_x`, `tilt_y`); `read_pen_flags` `:219`; `handle_pointer_message` `:204`; `next_state` `:178`; hooks `:230`, `:247`; `Monitor::install` `:275` |
| "publish a `Sample` through the same callback the macOS monitor uses" | the callback is `apps/photocraft/src/tablet.rs:33` `sink(feed)`. macOS installs with it (`:111`); WinTab uses it (`:70-78`). **Windows' `install_windows()` (`:40`) takes no feed today** and is called from `apps/photocraft/src/main.rs:711`. |
| `macos.rs` line 84 | `crates/tablet/src/macos.rs:76-91` `read` (tilt and rotation only on tablet-point events, `:84-89`); the pure mapping is `appkit.rs` |
| `crates/ui-egui/src/input/stylus.rs` interpolation 302–308, push line 388 | `stylus.rs`: `PenSample` `:37-90` (rotation in degrees, `sanitized` :57); `record_point` `:287` (`[tilt_x, tilt_y, rotation]`); `stroke_points` `:312` (the `paint.stroke` columns) |
| `Control::PenTilt`, `Rotation`, `StylusWheel` (`brush.rs:28`, `dynamics.rs:461-463`) | `brush.rs:34-37`; `dynamics.rs:461-463` (scalar) and `:477-494` `control_angle` (`Control::Rotation => p.rotation`, counter-clockwise degrees by that function's doc, while `photocraft_tablet::Sample` documents rotation as clockwise, `lib.rs:47`). A sign mismatch is a likely cause of #1301; check it first. |
| stylus wheel / tangential pressure | **there is no wheel column anywhere** between the platform and the brush. `photocraft_tablet::Sample` (`lib.rs:47-58`) and `PenSample` have none; `craft::behavior::PointerSample` (`CL/behavior/src/press.rs:93-102`) has none, so the web path cannot carry it either; `stroke_points` writes no wheel. Only `dynamics.rs` reads `p.wheel`. |
| `docs/hardware-parity.md` | rows `:36-38`, notes `:42-46`, change log `:74-83` |

### The plan, adjusted

1. **Windows Ink tilt and rotation** (the core, as in the spec):
   - In `windows.rs`, add `read_pen_info(pointer_id) -> Option<PenInfo>` next to `read_pen_flags` (the same
     `GetPointerPenInfo` call; keep `read_pen_flags` as a thin wrapper so upstream's tests stay).
   - Add a pure `pub fn sample_from_pen_info(info: &PenInfo, eraser: bool) -> Option<Sample>`, which runs and is tested
     on every OS (move it to a non-cfg module such as `crates/tablet/src/ink.rs`, as `appkit`/`xi` are). It reads the
     `pen_mask` bits (PRESSURE 0x1, ROTATION 0x2, TILT_X 0x4, TILT_Y 0x8): pressure /1024; tilt in degrees with the
     crate's W3C sign; rotation 0..360 clockwise.
   - The hooks already see every `WM_POINTER*` (`handle_pointer_message` :204). Make it also call a stored sink with the
     sample: `Monitor::install_with_sink(sink)` alongside `install()`.
   - `apps/photocraft/src/tablet.rs` `install_windows(feed: &StylusFeed)` passes `sink(feed.clone())`;
     `main.rs:711` passes `&app.stylus.feed`. Both are Pigment-marked lines.
   - Keep winit's pressure when `PEN_MASK_PRESSURE` is clear (the sample's pressure is then `None`). That needs either
     an `Option` in the sample or a flag: do it in `PenInfo` → `Sample` mapping by reading winit's value in `stylus.rs`
     when the sample says "no pressure".
   - **Do not feed samples while WinTab is active** (`tablet_input == WinTab`, `main.rs:718`): the two would fight.
2. **macOS rotation (#1301):** a test first, as the spec says. Feed `appkit` samples with rotation 45° through
   `pen_sample` → `PenSample` → `record_point` → `stroke_points` → the engine's `paint.stroke` → `dynamics::control_angle`
   with `Control::Rotation`, and compare the tip angle.
   - The two candidates in the code: the sign convention above, and tablet-point-only rotation (`macos.rs:84`).
   - Fix it where it breaks. If the fix is in `dynamics.rs` (upstream), it is one marked line.
   - Confirm on hardware.
3. **Stylus wheel (optional; do it last or leave it for later and say so in the notes).** It needs a wheel value in
   `photocraft_tablet::Sample`, `PenSample`, `record_point`'s per-point array and a new optional column in `paint.stroke`'s
   points. That is an engine command format change: update its params string and run the panic hunt
   (`cargo test -p photocraft-engine --test panic_hunt -- --ignored`).
   - Sources: WinTab `pkTangentPressure` where the context has it, and macOS `NSEvent.tangentialPressure`.
   - Windows Ink has none.
   - The web path cannot supply it while `craft::behavior::PointerSample` lacks it.
   - About half a day more.
4. **Docs:** update `docs/hardware-parity.md:36-37` and `:45-46` and add a change-log row.

### Tests

The spec's tests stand.
- `sample_from_pen_info`: mask bits, ranges, degrees, eraser.
- The Windows hook pipeline with a synthetic `PenInfo`, through the existing `next_state`/`handle_pointer_message`
  test style (`windows.rs:345-480`; these run only on Windows CI if any, so keep the pure part separate).
- The rotation pipeline test of step 2.
- Manual check list on a Wacom or Surface pen (Windows Ink on) and a Mac.

### Hooks to list in FORK.md

`windows.rs` (new functions), `apps/photocraft/src/tablet.rs:40`, `main.rs:711`, the #1301 fix line, and the
`paint.stroke` column if step 3 is done.

**Effort.** M, 1 day plus the hardware check, as the spec said; +0.5 day for the optional wheel.

---

## U4: Select Similar Layers and OS recent documents (rows 45, 46)

### Status of each row

| Row | Now | Evidence |
|---|---|---|
| 45 Select Similar Layers | **missing** | no `select.similarLayers` anywhere. Select's layer group is All Layers, Deselect Layers, Find Layers, Isolate Layers (`menu_catalog.rs:544-547`; engine `layer_multi_cmds.rs:96-113`). |
| 46 OS recent documents | **missing** | no `SHAddToRecentDocs`, `noteNewRecentDocumentURL` or `recently-used.xbel` in the tree or in craft-libs. The in-app list is `app/files.rs:15` `push_recent` (prefs `fileHandling.recentFiles`; scorecard BUG-204-4/5 done). |

### Where things are now

| Spec names | Now |
|---|---|
| `selection_cmds.rs` line 785 `select.similar` | the pixel command is still there (`selection_cmds.rs`, 800 lines) |
| `layer_multi_cmds.rs` `select.allLayers` (96), `select_linked`, `set_selection` | the specs are in `layer_multi_cmds.rs:96-114`. The bodies moved to `layer_multi_cmds/selection.rs`: `select_all_layers` `:354`, `select_linked` `:389`. `set_selection` is `pub` (re-exported at `layer_multi_cmds.rs:35`). |
| `LayerContent::kind_name` | `crates/doc/src/lib.rs:617` (Pixel, Group, Adjustment, Fill, Type, Shape, Smart Object; adjustment and fill are each one kind, as the spec wants) |
| `menu_catalog.rs` row | **do not add** (see "What changed", 4). A spec with `&["Select"]` becomes a row by itself. Place it with `PLACE_AFTER` or a Pigment place hook after `select.deselectLayers`. |
| `app/files.rs` `push_recent` (11; called from 717 and `file_open.rs` 247) | `app/files.rs:15` `push_recent`, `:32` `clear_recent`, `:40` `remove_recent`. Callers: `app/files.rs:725` (save), `file_open.rs:241` (open; the file moved from `app/file_open.rs`), `control/dispatch.rs:1389`, `home_recent_ui.rs:496`. |
| `PhotocraftApp.os_recent: Option<fn(&Path)>` | put it in **`Services`** instead (`crates/ui-egui/src/services.rs:503`), where the app's other platform hooks live (`pen_end`, `right_button_down`, `tablet_poll`, `beep`, …). The desktop builds it in `apps/photocraft/src/services.rs:470-500`. The web app leaves it `None`. |
| `apps/photocraft/Cargo.toml` line 72–74 (AppKit features) | `apps/photocraft/Cargo.toml:74-76`. The `objc2-foundation` features need `NSURL` and `NSString`; `objc2-app-kit` needs `NSDocumentController`. In objc2-app-kit 0.3.2, `NSDocumentController::sharedDocumentController(mtm)` and `noteNewRecentDocumentURL(&self, &NSURL)` are **safe** functions (`~/.cargo/registry/src/*/objc2-app-kit-0.3.2/src/generated/NSDocumentController.rs:40`, `:316`), so macOS needs no `unsafe`. |
| Windows `SHAddToRecentDocs` "declare the extern like the tablet crate" | **`apps/photocraft` forbids `unsafe`** (workspace lint, `Cargo.toml:107`), and winsafe's wrapper is an `unsafe fn` (`winsafe-0.0.29/src/shell/funcs.rs:249`). The call must live in the one crate that allows `unsafe`: add `pub fn add_recent_document(path: &Path)` to `crates/tablet/src/windows.rs`, with a `SAFETY:` comment and `#[link(name = "shell32")]`. Note in its doc that the crate is the workspace's isolated `unsafe` helper. The Jump List needs an AppUserModelID; the process keeps Windows' implicit one (`apps/photocraft/src/app_icon.rs:12`, `:183-185`), so the system Recent list gets entries, but the Jump List may not. Check on Windows and record what you see. |

### The plan, adjusted

**Select › Similar Layers (S):**
- Pigment engine module `crates/engine/src/cmd/similar_layers_cmds.rs`, registered through "What changed", 9. It holds
  `spec!("select.similarLayers", "Similar Layers", &["Select"], None, "{}", has_layer, similar_layers)`.
- `similar_layers`: collect the `kind_name`s of `selected(s)`. Select every layer in `d.doc.walk()` (groups included)
  of those kinds, leaving out the Background as `select_all_layers` does. Keep the active layer when it is among them.
  Use `set_selection(s, ids, active, None)`.
- Placement: add `.or_else(|| crate::pigment_menus::place_after(&e.command.id))` beside the AI hook
  (`menus/items.rs:201`), or a one-line `PLACE_AFTER` tuple `("select.similarLayers", "select.deselectLayers")`
  (`menus/items.rs:40`). Either is one marked line. A shared Pigment place table lets A6 use it too.
- Tests: two text layers in different groups plus a pixel layer → the active text layer selects both text layers;
  an adjustment layer selects all adjustment layers of any kind; a fill layer selects fills; no history step.
- **Panic hunt:** it is a new engine command, so run `cargo test -p photocraft-engine --test panic_hunt -- --ignored`.

**OS recent documents (S):**
- `crates/ui-egui/src/services.rs`: add `pub note_recent: Option<Box<dyn Fn(&std::path::Path, bool /*clear*/) + Send>>`
  (or two closures, `note` and `clear_ours`). This is one field in an upstream struct; check whether `Services` has a
  `Default` derive or a manual one, and add the field there.
- `app/files.rs` `push_recent` (:15) calls it when the in-app list is on (`recent_cap() > 0`) and the path is not in
  the crash-recovery folder (the recovery dir from `app_dirs`). `clear_recent` (:32) calls it with `clear = true`.
  Both are marked lines.
- `apps/photocraft/src/os_recent.rs` (new, safe code only) holds `note(path)`:
  - macOS: `NSDocumentController::sharedDocumentController(MainThreadMarker::new()?)` and
    `noteNewRecentDocumentURL(&NSURL::fileURLWithPath(&NSString::from_str(path)))`. Skip it when not on the main
    thread; `push_recent` runs there.
  - Windows: `photocraft_tablet::windows::add_recent_document(path)`.
  - Linux/FreeBSD: the `recently-used.xbel` writer the spec describes, in safe Rust. Write atomically with the
    existing `write_atomic` in `services.rs`. Keep others' bookmarks byte-identical, keep at most 500 of ours, use
    `exec "pigment %u"`, and do nothing quietly when the file is not writable.
  - `clear_ours`: Linux only.
- `apps/photocraft/src/services.rs` sets `note_recent: Some(Box::new(os_recent::note))`.
- `mod os_recent;` in `main.rs`.
- Tests:
  - the Linux writer on a temp `XDG_DATA_HOME` (pass the directory in; do not set the process environment in tests):
    adds, de-duplicates, keeps others' entries byte-identical;
  - a ui-egui test that `push_recent` calls the service and `clear_recent` asks it to clear;
  - Windows and macOS smoke tests behind `cfg` that a missing file does not panic.

### Hooks to list in FORK.md

`cmd.rs` (module and registry lines), `menus/items.rs` (place), `services.rs` (field), `app/files.rs` (2 calls),
`apps/photocraft/src/main.rs` and `services.rs` (module and wiring), `apps/photocraft/Cargo.toml` (features),
`crates/tablet/src/windows.rs` (the shell call).

**Effort.** S, 1 day, as the spec said.

---

## Order and shared files, adjusted

The packages are still independent of each other and of groups A and P. One order that keeps the shared upstream
files simple: F3 (half a day) → F2 → F1 (F1 and F2 both add one line to `filter_dialog::command_params`; put them in
the same `match`) → U4 → U2 → U1 → U3 (hardware last).

| Shared file | Edited by (place) |
|---|---|
| `Cargo.toml` (workspace) | F2 (`craft-tga`) |
| `crates/io/Cargo.toml` | F1 (`craft-metadata`), F2 (`craft-tga`), F3 (`avif` feature) |
| `crates/engine/Cargo.toml` | F1 (`craft-metadata`) |
| `crates/io/src/flat.rs` | F1 (IIM seed on read near :929/:1143, APP13 on JPEG write), F2 (Targa decode before :121) |
| `crates/ui-egui/src/dialogs/filter_dialog.rs` `command_params` (:577) | F1 (`file_info_ui::nest`), F2 (LUT formats fold) |
| `crates/ui-egui/src/menus/view_cmds/dialogs.rs` | F1 (`file_info_form` body), F2 (the CLUT rows, :301-320) |
| `crates/ui-egui/src/dialogs.rs` `PARAM_FAMILIES` | U1 (Info Panel Options), U2 (Insert Conditional) |
| `crates/ui-egui/src/panels/registry.rs` | U1 (`info` entry, :147) |
| `crates/engine/src/cmd.rs` (module list and registry, :1474) | U2 (`actions_default`, if a module of its own), U4 (`similar_layers_cmds`) |
| `crates/ui-egui/src/menus/items.rs` | U4 (place after) |
| `crates/tablet/src/windows.rs` | U3 (pen info), U4 (`add_recent_document`) |
| `apps/photocraft/src/main.rs` | U3 (`install_windows(feed)`), U4 (`mod os_recent`) |
| `crates/ui-egui/src/services.rs` `Services` | U4 |
| `crates/engine/src/cmd/actions_edit_cmds/library_commands.rs`, `preset_store.rs` | U2 only |
| `menu_catalog.rs` | nobody |

Effort in all: F1 2, F2 1.5, F3 0.5–1, U1 1–1.5, U2 1.5, U3 1 (+0.5 optional wheel) plus hardware, U4 1. That is about
9 days; the spec said about 10.5. Before U2 starts, one choice goes to the project's owner: renaming the restored set
from "Pigment Basics" to "Default Actions", which changes a rebrand row and two upstream test assertions.
