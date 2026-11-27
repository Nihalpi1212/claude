# Merge 057297b, step "ai-ui part 2" (§6 step 7, part 2 of 3: the AI task bars)

Branch `claude/pigment-merge-057297b`, commit **`ab3c8c7`** "Pigment merge 057297b, AI interface part 2:
the task bars on the framework", on top of part 1's `56b1f41`. Pushed; tree clean after it. Only
`pigment/crates/ui-egui` changed (`src/ai_ui.rs`, `src/ai_ui/task_bar.rs`, `tests/it/ai.rs`,
`tests/it/main.rs`, `tests/it/ai_task_bar.rs` deleted).

## What I did

1. **`src/ai_ui/task_bar.rs` ported** (0.5.0's file, compiled again: `pub mod task_bar;` in `ai_ui.rs`,
   non-wasm) onto `craft::ui::canvas_controls::TaskBar`, as `tools/crop_task_bar.rs` does:
   - `which(app) -> Option<Bar>` (`Selection`, `AfterRemove`): 0.5.0's rule with `app.dialog_open()`
     for `app.ui.dialogs`, and **`Tool::Frame` added** to Crop/Perspective Crop: upstream's new Frame
     tool has its own bar on the same place (`frame_tool/task_bar.rs`), so one bar shows at a time.
   - `draw(app, ui, area)`: `TaskBar::new("Contextual Task Bar", &anchor, Bind::bound(&mut place))
     .show(ui, area, …)`; the anchor is the selection's bounds (or the canvas) as four document
     points: the framework maps them through the pass's view, so `ViewXform` and the `CanvasSpace` the
     hook passes are not needed (`task_bars(app, ui, rect, _space)` keeps the hook's signature). Same
     place, pin and Hide as the Crop/Frame bars (`app.ui.panels.task_bar`, Hide unticks Window ›
     Contextual Task Bar), `app.ui.task_bar_shown` set as the crop bar does (`ui.inspect` still
     reports only the crop bar's, as in 0.5.0). More menu after the members (`cx.more_menu`).
   - Selection bar: framework `TextField` bound to `app.ai.bar_prompt` (accessible name and placeholder
     "Describe what to generate", `.limit(PROMPT_LIMIT)`, `.submits()` so Enter is the field's), then a
     framework `Button` "Generate"; Enter with a non-empty prompt or the button → `fill_from_bar`
     (0.5.0's code). After Remove Background: `Button` "Generate Background…" → `generate::open(BACKGROUND)`.
   - Crop bar slot (`crop_item`, from `crop_task_bar_item`): `Button` "Generative Expand",
     `.enabled(false).tooltip(<engine's reason>)` where `disabled_reason(EXPAND)` says so; only once a
     provider has a key (`fits(Image)`).
   - `expand_from_crop(app)`: the frame is `crop_ui::frame(app)` (= `app.canvas_tools.crop.tool.frame()`,
     the drawn or the default frame); a turned frame counts by the bounds of its `corners()`; the size and
     anchor math is 0.5.0's (`open_expand`). On success the frame is let go with `crop_ui::discard`
     (0.5.0's `crop_ui::dismiss`); when the window can't open the frame stays and the status bar says why.
   - `ai_ui.rs`: `bar_prompt` field back on `AiUi`; `task_bars` → `task_bar::draw`,
     `crop_task_bar_item` → `task_bar::crop_item`; module doc updated. No upstream file touched: the
     hooks in `canvas/document_display.rs` and `tools/crop_task_bar.rs` were placed in step 5.
   - No new interface strings (all five are 0.5.0's).
2. **Tests: the five task bar tests are back in `tests/it/ai.rs`** (where 0.5.0 had them, after
   `describe_without_a_provider_opens_ai_accounts`); `ai_task_bar.rs` is deleted and `main.rs`'s comment
   names only `ai_assistant` as waiting. `app.ui.crop_rect` is gone, so the tests make the frame as a
   person does: `crop_tool(h)` (Classic Mode, **Delete Cropped Pixels off** — upstream's framework keeps
   the frame inside the canvas while it is on — snapping off, `ui.set tool crop`) and
   `drag_crop_frame(h, from, to)` (an agent's `ui.pointer` drag of the left edge, document px);
   `crop_frame(h)` reads `crop_ui::frame`. Changes against 0.5.0's bodies:
   - `task_bar_items_appear_only_with_a_key`: the bar's Generate is pressed with a pointer click
     (`pointer_click`), the prompt field is found by name, Generate Background… is clicked and opens its
     window, the untouched frame is checked to be the canvas, the left edge dragged to −50, Generative
     Expand clicked (kittest), "the frame is let go" = `!crop_ui::pending`.
   - `expand_from_crop_on_a_very_wide_document`: `ui.set zoom 1, center [200, 50]` so the 40,000 px
     document's left edge is under the pointer; the drag gives `[-100, 0, 40000, 100]`.
   - `expand_from_crop_keeps_the_frame_where_expand_is_disabled`: the kept frame is `crop_frame` + `pending`.
   - `generate_background_follows_the_document_the_job_ran_on`, `the_bar_generate_sends_one_request`:
     as they were (plus label checks).
   - **New** `the_bar_s_prompt_runs_on_enter`: Enter in an empty bar field sends nothing; typed prompt +
     Enter sends one request with it.
   - `generative_fill_sends_nothing_before_generate_and_lands_as_one_step`: mock delay 600 ms → 2,500 ms.
     It failed once in the 30-test parallel run (the job ended before "Stop" was read: 3 steps + 350 ms
     sleep + 3 steps under load); it passed alone 4 times. The longer delay keeps the job running when
     the window is read; `until_idle` waits for it anyway.

## Hand merges / changes to Pigment's code

| File | Change | Why |
|---|---|---|
| `src/ai_ui/task_bar.rs` | `widgets::task_bar` → framework `TaskBar`; egui `TextEdit`/`Button` → framework `TextField`/`Button`; `ViewXform` → document-point anchor; `crop_rect` → `crop_ui::frame`; `dismiss` → `discard`; `ui.dialogs` → `dialog_open()`; Frame tool excluded | §5.1 |
| `src/ai_ui.rs` | `pub mod task_bar`, `bar_prompt`, the two hooks call it | part 2 |
| `tests/it/ai.rs`, `main.rs` | above | |

Behaviour changes against 0.5.0: the AI bar does not show with upstream's new Frame tool; a turned crop
frame expands to its bounds (0.5.0's `crop_rect` was never turned); the Generative Expand item's disabled
reason is the framework's tooltip.

## Tests and checks (CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_STRIP=symbols, TMPDIR=/dev/shm/pt, CRAFT_I18N_DIR, CRAFT_FONTS_DIR at cc9269c)

| Command | Result |
|---|---|
| `cargo nextest run --profile ci -p photocraft-ui-egui --test it -E 'test(/^ai::/) \| test(/crop_task_bar::/) \| test(/^legacy_pigment::/)'` | **40 run: 40 passed**, twice, before the Enter test was added: 30 `ai::` (0.5.0's 30 minus the Assistant sign-in test moved to `ai_assistant.rs`, plus part 1's Preferences test), the crop task bar's and legacy_pigment's. ai.rs now has 31 tests; after the commit, `-E 'test(/^ai::/)'`: **31 run: 31 passed** |
| same, `test(/^ai::the_bar/)` after adding the Enter test | 2 passed |
| `cargo clippy -p photocraft-ui-egui --all-targets -- -D warnings` | clean |
| `cargo fmt --all -- --check` | clean |
| `cargo xtask panel-commands` | OK (0 direct mutations) |
| `pigment-rebrand.py --check` | only `crates/raw/src/shared.rs` (step 8, as before) |

Not run: the whole ui-egui suite (no file outside `ai_ui*` and the AI tests changed; without a provider key
`which` is `None` and `crop_item` returns at once, so upstream's tests draw nothing new; the crop task bar's
own tests ran above), the wasm build (the `web` module's signatures are unchanged), `apps/photocraft`.

## Left

- **Part 3 (Assistant):** as part 1's notes say (`assistant`, `assistant_tools`, `NOT_PORTED`, `checked`,
  `forget_assistant_models`, `mod ai_assistant;`, the sign-in test at the end of `ai_assistant.rs`).
- **Step 8 (FORK.md):** the hook table: the AI task bars are drawn by `ai_ui::task_bars(app, ui, rect, space)`
  in `canvas/document_display.rs::canvas_controls` (active tile, after the Frame tool's bar) and
  `ai_ui::crop_task_bar_item(app, ui)` in `tools/crop_task_bar.rs`'s `TaskBar` body, before `preset_list`.
  The user guide may say the AI bar does not show with the Frame tool and that Generative Expand from the
  Crop tool needs a frame past the canvas, which upstream's Crop tool allows only with Delete Cropped
  Pixels off.

Disk at the end: about 7 GB free (`df -h /`).
