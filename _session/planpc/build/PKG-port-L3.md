# PKG port L3: legacy `.pigment`, type, smart objects, smart filters, report, save prompt

Package L3 of `planpc/ports/PORTS-A.md` (section 7). Branch `claude/pigment-photocraft`. The importer
is now finished: every layer kind of Pigment 0.1–0.4 opens.

## Commits

| Commit | Subject |
|---|---|
| `9adda5f` | Pigment: type layers and smart objects of Pigment 0.1 to 0.4 open, with their smart filters, an import report and a question before the first save over the old file |

Pushed. CI was **not** waited for on `9adda5f`: check it first. CI on L2's `c2243fb` (run
44369700966) finished green while I worked; no CI repair was needed.

## What opens now

`crates/io/src/legacy_pigment/` (all Pigment's own files):

| File | Holds |
|---|---|
| `text.rs` (new) | `text_layer(desc, dpi, mode, notes) -> Converted { text, stroke }`. 0.4 `content` (runs over UTF-16 units → UTF-8 bytes; sparse styles over `CHAR_DEFAULTS`/`PARA_DEFAULTS`), 0.1–0.3 `text` + `font` read as `fromLegacy` read it. px → pt by the document dpi. Point, box, path, stacked vertical. |
| `filters.rs` (new) | `smart_filters(list, notes)`: JS filter kind → PhotoCraft command + params (table in `filter()`), `adjust:<kind>` → `adjust::to_adjustment` → `image.adjustments.<kind>` params (a copy of the engine's `adjust_params::to_params` for the kinds that have params). Unmapped kinds named in one warning. |
| `smart.rs` (new) | `LayerReader::smart`: `sourceRef` sharing (one `SmartContentsId` and one `Arc` of bytes per source), nested `smart/<id>.pigment` opened by `import_at` at depth+1 (max 8, `MAX_SMART_DEPTH`) and kept as `<name>.pcraft` (`photocraft_format::save_to_bytes`), `smart/<id>.png` kept as is. `render()`: draws every smart object after the document is read, through the engine's renderer (`set_smart_object_renderer`) or, without one, the source placed by `place_source` (no filters). |
| `mod.rs` | `import` → `import_at(name, bytes, ctl, depth, &mut Budget)`; type drawn by `text_import::prepare_within`; smart objects by `smart::render`; the import report (`Metadata::import_conversion`, `SOURCE_FORMAT = "pigment-0.1-0.4"`, one entry per warning line, disposition by its wording); `came_from_legacy(doc)`; `source_read_only: false` now. |
| `container.rs` | `Budget { bytes, pixels }` shared by nested documents (`Container::open(bytes, budget)`, `budget()`, `spent_nested()`); reads count against it. |
| `layers.rs` | `text` and `smart` arms; fields `dpi`, `depth`, `smart_sources`; the type's stroke becomes the first layer effect. |
| `text_smart_tests.rs` (new) | the L3 tests. |

Engine: `crates/engine/src/legacy_pigment_render.rs` (new, Pigment's own) installs
`smart_cmds::refresh_layer` as the renderer, from `jobs::import_options` and
`file_cmds::open::import_result_for_open` (every open path calls one of them before importing).

UI: `crates/ui-egui/src/dialogs/legacy_save_prompt.rs` (+ `_tests.rs`): the first File › Save over a
file that is still a Pigment 0.1–0.4 document asks "Save in the new Pigment format? Pigment 0.4 will
no longer be able to open this file." Save / Cancel / Save As…, "Don't show again"
(`prefs.dialogs["file.save.legacyPigment"]`).

## Where the spec was wrong, or where I chose

1. **No `from_legacy_pigment` flag on Document/DocState.** The upstream document already has an
   import report (`Metadata::import_conversion`, `ConversionReport`, saved in the native format and
   unused by any importer). The legacy importer fills it (that is also "the report"), so the
   document says where it came from even after a save. The prompt asks when the document's report
   says Pigment 0.1–0.4 **and** the file at its path is still a legacy file (read from disk at Save;
   on wasm never). After the first save the file is native, so it never asks twice. No engine
   struct changed.
2. **The path is kept** (L1 left this to me): `source_read_only` is false, and L1's two hooks in
   `ui-egui/src/app/files.rs` are gone (that code is upstream's again). Consequence: the engine's
   `file.save` (CLI, MCP, scripts, actions) writes the new format over a legacy file without asking,
   as other saves do; only the interface asks.
3. **Smart filters need the engine.** io cannot run filters; a hook (`set_smart_object_renderer`, a
   `OnceLock<fn>`) lets the engine draw them. Without the engine (io's own tests) smart objects are
   placed without filters; io's picture test skips `*-smart-filters` and the engine test compares it.
4. **0.4's "vertical" orientation was horizontal type turned a quarter** by `transform`
   (`setOrientation` in lib/text-path.js). It stays horizontal type with that matrix (looks the same).
   Only `vertical-stacked` becomes `Orientation::Vertical` (anchor: first column's centre, top).
5. **Type placement**: first baseline at `y + 0.8 × largest size of the first line` (layout.js). Point
   type with center/right alignment: PhotoCraft aligns about the anchor, the app within the widest
   line from `x`, so the anchor moves by width/2 or width (measured with PhotoCraft's layout of a
   left-aligned copy, first paragraph's alignment). Box type: the box's transform is shifted so
   PhotoCraft's first baseline lands where the app's was; a box that grew (`height: null`, all 0.3
   boxes) gets the laid-out text's height.
6. **Type stroke**: the app stroked under the fill, so what showed is the outer half: an Outside
   Stroke effect of width/2. Different strokes per run: the first one, warned.
7. **Language `en-US`** (the app's default) maps to `None` (PhotoCraft's default). `liga`/`clig`/`dlig`
   features set `ligatures`/`discretionary_ligatures`; other 4-letter tags become `features`.
8. **`rotation`** on JS text layers is written but never used by the app; ignored.
9. **Smart filters had no blend/opacity in 0.4** (`normaliseFilter` drops them); read if present.
   JS Sharpen (with an amount) is Unsharp Mask radius 1, as the app computed it.
10. **Nested source file name**: `<source.name>.pcraft` as Edit Contents names it; image sources
    `<name>.png`.
11. **Warnings → report dispositions** by wording: "changes nothing" → RetainedUnapplied; "could not",
    "not in the file", "is missing", "has no id" → SkippedNonessential/ResourceUnavailable; "left out",
    "empty layer", "nothing is drawn", "not known" … → SkippedNonessential/MissingMapping; the rest
    NativeApproximation. New warning texts should keep to these words.
12. **The user guide**: `docs/user` is upstream's PhotoCraft guide; I added Pigment's own page
    `docs/user/guides/open-pigment-0-4-documents.md` and one link line in `guides/index.md`.

## Fixtures

`crates/io/tests/fixtures/pigment-0.4/`: `make-fixtures-l3.mjs` (called by `make-fixtures.mjs` for
`v2`/`v3`), 7 v2 and 10 v3 `.pigment` files plus `.png` pictures for the smart ones (~120 KB). README
updated. The generator imports `lib/type/api.js` (sets the text backend, canvas engine) and calls
`text-path.js` `install` with a stub app (the extension registers before the commands throw).
`v1` writes no L3 fixtures (0.2's text describes as 0.3's).

## Tests and results

| Where | Tests | Result |
|---|---|---|
| `cargo test -p photocraft-io --lib legacy_pigment` | 67 (+2 ignored) | pass |
| `cargo test -p photocraft-io --lib --tests` | lib 749, it 595 | pass except the 3 known `svg::` failures (`upstream-test-failures.txt`) |
| `cargo test -p photocraft-engine --lib legacy_pigment_render` | 1 | pass |
| `cargo test -p photocraft-ui-egui --lib -- legacy_save_prompt dialogs:: file_dialog file_open open_prompt save_identity disk_change` | 1270 / 1372 | pass |
| `cargo test -p photocraft-ui-egui --test it legacy_pigment` | 2 | pass |

New tests: `text_smart_tests.rs` (point type of 0.3 and 0.4; paragraph and turned type; mixed runs;
vertical and path type; smart instances share one source; image sources; smart filters mapped and
reported, with report dispositions; nesting stops at 8; save to native and reopen; hostile type and
smart objects), unit tests in `text.rs` (3) and `filters.rs` (2), the engine's
`smart_filters_are_drawn_when_a_pigment_0_4_document_opens` (mean difference to the JS picture < 3
levels and less than half of the unfiltered one), `legacy_save_prompt_tests.rs` (asks once, Cancel,
Save writes native and does not ask again; Save As opens the save dialog; Don't show again).
`every_fixture_draws_as_the_app_drew_it` covers the smart pictures (bounds for the resampled ones in
`DIFFERENT_BY_DESIGN`). The fuzz loop runs over the L3 fixtures too. The L1 test of unconverted
kinds became `every_layer_kind_keeps_its_place_and_what_is_not_one_is_reported`.

Checks: `cargo fmt --all -- --check` clean; `cargo clippy -p photocraft-io -p photocraft-engine
-p photocraft-ui-egui --all-targets -- -D warnings` clean; `python3 pigment/scripts/pigment-rebrand.py
--check` clean. Not run: workspace-wide tests/clippy (CI), the panic hunt and xtask checks (no
command, crate, preference field or panel command added; the save prompt's "Don't show again" is a
`prefs.dialogs` map entry).

## Hooks into upstream files (all in `docs/FORK.md`, "Opening documents from Pigment 0.1–0.4")

| File | Hook |
|---|---|
| `crates/engine/src/lib.rs` | `mod legacy_pigment_render;` |
| `crates/engine/src/jobs.rs` | `crate::legacy_pigment_render::install();` at the top of `import_options` |
| `crates/engine/src/cmd/file_cmds/open.rs` | the same line in `import_result_for_open` |
| `crates/ui-egui/src/app/files.rs` | `save_in_place` asks `legacy_save_prompt::intercept` first; the old body is `save_in_place_unasked`. L1's two `is_legacy` hooks removed. |
| `crates/ui-egui/src/dialogs.rs` | `pub mod legacy_save_prompt;`; `save_prompt`/`save_prompt_body`/`save_prompt_confirm` replace the disk-change prompt's arms in `command_body` and `confirm_command` (cognitive-complexity limit 30 was hit otherwise); the 3-button arm; `ROUTES`; `file_command` |
| `crates/ui-egui/src/lib.rs` | `pub use dialogs::legacy_save_prompt;` |
| `docs/user/guides/index.md` | one link |

## Docs

`README.md` ("Pigment 0.4 and earlier"), `docs/RELEASE-NOTES-0.5.0.md` (new section "Documents from
Pigment 0.1 to 0.4", the old Known issue removed), `docs/FORK.md`, and the new user-guide page say
what is converted exactly, approximated and reported, and the save prompt.

## Left for later, or worth knowing

- The active layer is still not carried (`ImportResult` has no field).
- Type pictures are not compared with the app's (fonts differ by machine); positions are checked.
- Vertical stacked type's columns and box type's lines are PhotoCraft's layout; differences warned.
- Distort filters' `edge` option of the app is ignored (PhotoCraft's own edge handling).
- Smart objects of a smart object's contents are drawn by the engine before the contents are encoded
  (each nesting level runs `smart::render`), so nested caches are in the `.pcraft` bytes.
- A6 (new adjustments) should also give `filters.rs::adjustment` arms for its three kinds.
- The JS worktrees `js-v1/v2/v3` were removed and pruned; `fixgen` (node_modules with
  `@napi-rs/canvas`) is still in the scratchpad.
