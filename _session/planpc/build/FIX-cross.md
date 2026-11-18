# FIX-cross: where the new features meet the rest of the editor

CI before starting: the newest finished Pigment CI run on claude/pigment-photocraft (44380051338) was green; two later runs were still pending. No earlier FIX-*.md notes existed.

| Finding | Severity | Reproduced | Fixed | Commit |
|---|---|---|---|---|
| CROSS-1 | blocker | yes | yes | 8746d49 |
| CROSS-2 | major | yes | yes | 83a02b6 |
| CROSS-3 | minor | yes | yes | b7b746c |
| CROSS-4 | minor | yes | yes | 285f160 |
| CROSS-5 | minor | yes | yes | 83a02b6 (grouped with CROSS-2: same file, same open path) |

## CROSS-1: Generative Expand from the Crop bar panics on documents over 30,000 px
- Reproduced: `crates/ui-egui/tests/it/ai.rs::expand_from_crop_on_a_very_wide_document` (40,000 x 100 document, crop frame reaching 100 px to the left) panicked with `min > max ... min = 40000.0, max = 30000.0`.
- Fix: new `photocraft_engine::ai_cmds::EXPAND_MAX_SIDE` (300,000, Canvas Size's limit, now also used by `expand.rs`). `task_bar::expand_from_crop` computes `.min(max).max(w)`, so min <= max always holds. The Generate window's New width and New height DragValues now range from `w0` to `max.max(w0)` instead of the inverted `w0..=30_000`. egui's `clamp_existing_to_range` defaults to on, so the old range would have cut the value back each frame. The test draws the window for 3 frames and checks that width stays 40,100 and that the command params carry 40,100.

## CROSS-2: CLI and MCP open 0.4 smart objects without their smart filters
- Reproduced: `apps/photocraft-cli/tests/it/legacy_pigment.rs` runs `pigment-cli convert` on v2 and v3 `-smart-filters.pigment` in a fresh process and compares the PNG with the app's picture. The mean difference was 13.27 (needs < 3). `crates/automation/tests/it/legacy_pigment.rs::files_open_draws_the_smart_filters_of_a_pigment_0_4_document` failed the same way.
- Fix: `legacy_pigment_render` is now `pub mod` and `install` is `pub`. `files::open_with_options` and `files::open_bytes_with_options` call it first, one hook line each. All automation open paths (convert, run, info, batch, MCP, headless and workspace) go through these two. When `smart::render` (io) has to place a source without its enabled smart filters, a layer warning now says so ("the smart filters could not be drawn; ..."), and that warning goes into the import report as well. The io test `smart_filters_map_to_pigments_and_the_others_are_reported` checks it (io alone has no renderer).
- FORK.md: the lib.rs row became `pub mod`; I added rows for automation `files.rs`, `crates/automation/tests/it/main.rs` and `apps/photocraft-cli/tests/it/main.rs` (`mod legacy_pigment;`), and updated the prose.
- I did not add a call in `genai::session`. Every automation open goes through `files`, so it was not needed. The desktop's `services.import` closures are always preceded by `jobs::import_options`, which installs the renderer.

## CROSS-3: Describe Image's answer has no length limit
- Reproduced: `ai.rs::describe_shows_a_bounded_answer` (the mock answers with 1,000,000 x "é") failed the at-most-20,000-characters assert.
- Fix: the engine's `ai.describe` cuts the text with `bounded()`. The cap is `ai_cmds::DESCRIBE_LIMIT` = 20,000 characters, the ellipsis included, cut at a character boundary. It also drops control characters other than `\n` and `\t`. The CLI, MCP, the window and Use as Document Description all get the same text. Engine test: `ai_cmds::tests::describe_bounds_the_answer`, which also checks the control characters. docs/generative-ai.md is updated.

## CROSS-4: the bar's Generate sends the window's last variation count
- Reproduced: `ai.rs::the_bar_generate_sends_one_request` made 3 edit calls after the window had been set to 3 variations and closed.
- Fix: `generate::open` now resets `variations` to 1 each time the window opens anew (closed, or switched to another feature). It clears `model` when the feature changes. If the window is already open on Fill, the bar's Generate uses the count shown in that window, so nothing is hidden. docs/generative-ai.md is updated.

## CROSS-5: a 0.4 document named .pcraft fails through the workspace byte path
- Reproduced: `crates/automation/tests/it/legacy_pigment.rs::a_pigment_0_4_document_named_pcraft_opens_from_bytes` failed with "corrupt .pcraft bundle: ... missing manifest".
- Fix: the native shortcut in `files::open_bytes_with_options` is now taken only when `!photocraft_format::brand::is_legacy_pigment(bytes)`. It is a `// Pigment:` hook, listed in FORK.md.

## Checks run
- New tests: each failed before its fix and passes after.
- `cargo nextest run -p photocraft-automation -p photocraft-cli`: 391 of 391 passed.
- `cargo test -p photocraft-io --lib legacy_pigment`: 69 passed.
- `cargo test -p photocraft-engine --lib ai_cmds`: 38 passed.
- `cargo test -p photocraft-ui-egui --test it -- ai crop legacy`: 165 passed.
- `cargo test -p photocraft-ui-egui --lib ai`: 749 passed.
- Panic hunt (`--ignored`): passed.
- `cargo fmt --check`: clean. Clippy with `-D warnings` on io, engine, automation, cli and ui-egui (all targets): clean. `pigment-rebrand.py --check`: clean.
- I did not wait for CI on the last push (285f160).

## Left for 0.6
- Nothing from these findings. The Assistant's `canvas_size` tool (`assistant_tools.rs:1112`) still caps sizes at 30,000. That is a constant range, so it cannot panic, but it is smaller than the engine's 300,000.
