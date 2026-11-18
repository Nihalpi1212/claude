# FIX-importer: the importer of Pigment 0.1–0.4 documents

CI before starting: the newest finished Pigment CI runs on claude/pigment-photocraft were cancelled (superseded by later pushes), not red; the newest finished run with a result (44389163385) was green. No CI fix was needed. FIX-cross.md (the only earlier notes) fixed nothing in these findings.

| Finding | Severity | Reproduced | Fixed | Commit |
|---|---|---|---|---|
| IMP-1 | major | yes | yes | 63675de |
| IMP-2 | major | yes | yes | ea735de |
| IMP-3 | major | yes | yes | 7ff9a54 |
| IMP-4 | minor | yes (by inspection, see below) | yes | 43d242b |
| IMP-5 | minor | yes | no, left for 0.6 | none |
| IMP-6 | minor | yes | yes | a76c2ea |

## IMP-1: pixel memory was priced only after the pixels were read and converted
- Reproduced: `crates/io/src/legacy_pigment/tests.rs::pixels_that_cannot_be_kept_are_refused_before_they_are_read` (1000 x 1000 at 32 bits, through `import_at` with a small `Budget`). It failed on the old code: the 1 MB channel had been read (1,000,121 bytes) before the refusal.
- Fix: `Container::price(rect, fmt)` refuses before the work starts. It runs in `plane()`, after the declared-size check, for each channel and for the selection. It runs in `place()` before `encode`, in the deep branch of `raster()` before the deep plane is read, and in `mask()` before `encode_gray`. `Container::price_png(name, cost)` reads only the PNG's first 24 bytes (`read_head`, IHDR) and refuses a layer image or mask that cannot be kept before it is inflated or decoded. `decode_png` no longer copies samples that are already 8-bit RGBA.
- Behaviour change: a layer PNG whose header claims more than the 2 GiB budget now refuses the whole document as "too large", even if its data is bogus. Before, the decoder failed and the layer opened empty with a warning. A valid image that large was already refused, so the importer is now consistent. `hostile_sizes_are_refused_by_the_limits` was updated for this. A mask whose claimed size fits the budget still decodes, fails, and is left out with a warning, as before.
- The test checks five cases: a channel, the selection, a PNG layer, a deep layer sized by its description, and a deep layer sized by its PNG, plus a mask. In each case only document.json and at most one PNG header are read, and the pixel budget is untouched.

## IMP-2: smart objects drawn by the engine did not take from the 2 GiB budget
- Reproduced: engine `legacy_pigment_render::tests::smart_objects_drawn_when_a_pigment_0_4_document_opens_take_from_its_pixel_memory`. It opens 16 instances of an opaque 64 px PNG at scale 35, each about 20 MB and within the engine's 20 MB test limit, with a 100 MB pixel budget. With the old renderer path restored temporarily, all 16 were drawn and kept 380 MB.
- Fix: `smart::render` prices each placement before drawing it, whether the engine renderer or the fallback draws it. The price is the tiles of the unclipped placed stage, (ceil(w/T)+1) x (ceil(h/T)+1) tiles with alpha, so tile alignment cannot exceed it. The cost is charged once the placement is drawn. One that does not fit stays undrawn, with "could not be drawn". The source size comes from `Shared.bounds`: a nested document's canvas, or an image's PNG header. Nothing is decoded to learn it.
- New test entry point: `photocraft_io::legacy_pigment::import_within(name, bytes, ctl, pixels)`, which is `#[doc(hidden)]`.

## IMP-3: smart filters drawn at open could not be cancelled
- Reproduced: engine `legacy_pigment_render::tests::cancelling_the_open_stops_the_smart_filters`. It has 8 x median radius 500 on a 1024 px placement. Run against the old importer (io changes stashed), the open had not returned after about 6 minutes, although cancel was requested at the start. I killed the test process.
- Fix: `Renderer` is now `fn(&Document, &mut Layer, &Interrupt) -> Result<bool, Cancelled>`. `smart::render` checks `ctl` before each smart object and returns `IoError::Cancelled`. The engine's `render` draws with a new hook, `smart_cmds::refresh_layer_with(doc, layer, &JobCtx)`, under a `JobCtx`. A scoped watcher thread polls the interrupt every 10 ms and cancels that `JobCtx` when the interrupt is cancelled; it ends at once when drawing finishes, through a dropped channel. The test cancels immediately, and again 300 ms into the filters. Both return Cancelled within 2 s.
- Hooks: `crates/engine/src/cmd/smart_cmds/rendering.rs` (`refresh_layer_with`) and `crates/engine/src/cmd/smart_cmds.rs` (`pub use`), listed in FORK.md, whose prose is updated. I added no engine command, so I did not run the panic hunt.

## IMP-4: every Save read the whole file on the UI thread
- Reproduced by inspection: the old `still_legacy` was `std::fs::read(path)` followed by `is_legacy`, so it read the whole file on every Save of a document that came from 0.4. No byte counter could be put on that call.
- Fix: `photocraft_format::brand::is_legacy_pigment_reader(Read + Seek)` applies the same rule as `is_legacy_pigment` (a document.json entry and no manifest). It reads only the first 4 bytes, the end record (ZIP64 locator and record included) and the central directory, up to 256 MB. It returns `None` when the directory cannot be read that way, and `still_legacy` then falls back to reading the whole file.
- Test: `brand::tests::a_legacy_document_is_told_from_its_directory_alone`. Three fixtures come out true. A 64 MB archive with a manifest comes out false after reading less than 80 KB, counted through a wrapper. A real `save_to_bytes` document comes out false. A truncated file gives `None`.

## IMP-5: with inline saves, Save in the legacy prompt does not release the close prompt
- Reproduced with a temporary ui-egui test, which I did not commit because it fails. The setup is inline jobs, as in the lib tests: a dirty 0.4 document, file.close, then `answer_choice("save")`, then confirm the legacy prompt. The file is written and the document is clean, but after two frames of `discard_ui::show` the close prompt was still up.
- Not fixed, left for 0.6. Only `background_jobs = false` reaches it, which means `PHOTOCRAFT_INLINE_JOBS`, a debug variable, and tests. The desktop default saves in the background, and `jobs_ui` then calls `saved_document`. The web build never shows the legacy prompt, because `still_legacy` is false on wasm. A fix needs an `egui::Context` in `dialogs::confirm`, or a parked DocId consumed in `discard_ui::show`. Both mean plumbing through upstream code, and the upstream disk-change prompt has the same gap. So the fix should cover both prompts, which is not small for 0.5.0.

## IMP-6: the first Save over a 0.4 file silently dropped what the import left out
- Reproduced: `legacy_save_prompt_tests.rs::saving_over_a_file_whose_import_left_parts_out_says_so`. The document has an unknown `store` key, so the report has a SkippedNonessential entry. Before the fix, with "Don't show again" ticked, File > Save overwrote the file without asking.
- Fix: when the report has SkippedNonessential entries, `intercept` asks whatever "Don't show again" says. It sets `choice: "saveAs"`, so Enter keeps the old file, and `leftOut: true`. It does not offer the "Don't show again" box. `body` adds the line "Parts of this document could not be opened and were left out (they are listed in the import warnings). Saving over the file loses them for good." The buttons moved into `legacy_save_prompt::buttons`, which makes Save As... the Default role in that case. The `dialogs.rs` hook is now one call, and FORK.md is updated. A document that lost nothing keeps today's prompt; the test checks this with v3-groups. The user guide (`docs/user/guides/open-pigment-0-4-documents.md`) says so. The new string is English only, with the other languages falling back.

## Checks run
- `cargo test -p photocraft-io --lib legacy_pigment`: 70 passed.
- `cargo test -p photocraft-engine --lib legacy_pigment_render`: 3 passed. `--lib smart`: 232 passed.
- `cargo test -p photocraft-format --lib brand`: 4 passed.
- `cargo test -p photocraft-ui-egui --lib legacy_save_prompt`: 4 passed. `--test it legacy`: 4 passed.
- `cargo test -p photocraft-automation --test it legacy_pigment`: 2 passed. `cargo test -p photocraft-cli --test it legacy`: 1 passed.
- `cargo fmt --check`: clean. Clippy with `-D warnings` (all targets) on io, engine, format and ui-egui: clean. `pigment-rebrand.py --check`: clean.
- I did not wait for CI on the last push (a76c2ea).

## Left for 0.6
- IMP-5 (see above), together with the same gap in the upstream disk-change prompt.
