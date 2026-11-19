# FIX-ai-ui: the AI interface and the Assistant

CI before starting: the newest finished Pigment CI runs on claude/pigment-photocraft were cancelled (superseded by later pushes), not red. The newest finished run with a result (44407769869) was green, so no CI fix was needed. Earlier notes: FIX-cross.md (CROSS-1 is AIUI-1) and FIX-importer.md (nothing here).

| Finding | Severity | Reproduced | Fixed | Commit |
|---|---|---|---|---|
| AIUI-1 | major | already fixed (CROSS-1) | yes, by FIX-cross | (8746d49, earlier) |
| AIUI-2 | minor | yes | yes | 1d17dd3 |
| AIUI-3 | minor | yes | yes | c84a1a6 |
| AIUI-4 | minor | yes | yes | 896bcfc |
| AIUI-5 | minor | yes | yes | b948ba8 |
| AIUI-6 | minor | yes (1.57 s per frame) | yes | b5f7445 |
| AIUI-7 | minor | yes | yes | b72c5bc |
| AIUI-8 | minor | yes | yes | 178635c |

All changes are in Pigment's own files (`crates/ui-egui/src/ai_ui*`, `tests/it/ai*.rs`, `docs/generative-ai.md`). No upstream file was touched, so FORK.md is unchanged. No engine command was added or changed, so I did not run the panic hunt.

## AIUI-1: Generative Expand from the Crop bar panics above 30,000 px
FIX-cross fixed this as CROSS-1 (`EXPAND_MAX_SIDE`, `.min(max).max(w)`, DragValue ranges `w0..=max.max(w0)`). I checked the code; test `ai.rs::expand_from_crop_on_a_very_wide_document`. Nothing more to do.

## AIUI-2: synthetic input chose the models and the provider
- Reproduced: `ai.rs::synthetic_input_chooses_neither_the_models_nor_the_provider`. The agent synthetic-clicks Image model, sends `ui.type "gpt-image-1"`, then clicks Done. Before the fix, `models(OpenAi).image_model` was `Some("gpt-image-1")`.
- Fix: `accounts::show` snapshots `chat_model`, `image_model` and `timeout` before drawing. When `automation_input` is set, it puts them back before the acts run, so Switch and Close save only what the person typed. Synthetic input in AI Accounts was already limited to Switch and Close whether or not agents are allowed, and this keeps that rule. `generate::show` puts back `provider` and `model` when synthetic input changed them and "Allow agents" is off. `generate::start` calls `super::gate` before it saves `image_provider` and the last prompt, and writes the refusal to the window's error. The test also checks the Gemini click, the refused Generate (nothing sent, `image_provider` unchanged), and that the person's own typing and clicks still work.

## AIUI-3: Generative Expand was live where Expand is disabled and threw the frame away
- Reproduced: `ai.rs::expand_from_crop_keeps_the_frame_where_expand_is_disabled` (Indexed Color). Before the fix the item was enabled. Clicking it dropped `crop_rect` and left the status empty.
- Fix: `crop_item` adds the button with `add_enabled(disabled_reason(EXPAND).is_none())` and shows the engine's reason as its disabled hover text. `expand_from_crop` calls `generate::open` before `crop_ui::dismiss`, and writes the Err to `app.ui.status`.

## AIUI-4: Generate Background was offered on the active tab, not the job's document
- Reproduced: `ai.rs::generate_background_follows_the_document_the_job_ran_on`. It runs a background job on A and switches to B. Before the fix `after_remove` held B's id.
- Fix: `removed_background(app, doc)` looks up the document in `session.documents()`. `on_job_event` passes `e.document`, and the inline (non-job) path passes the active document.

## AIUI-5: a failed model list could not be asked for again
- Reproduced: `ai_assistant.rs::a_model_list_that_failed_can_be_asked_for_again`. The mock is scripted with a non-list answer, so the first list fails. Before the fix there was no "List models" link afterwards.
- Fix: the Failed arm shows the error and the "List models" link, which needs no new string. New `assistant::forget_models` drops the lists read, but not those still loading. AI Accounts calls it when a Connect, Test or Sign-in ends, on Remove Key and on Sign out.

## AIUI-6: every frame serialized every step's arguments
- Reproduced: `ai_assistant.rs::a_turn_of_large_steps_keeps_the_window_quick` runs 12 rounds x 32 `apply_filter` steps with 60 KB `kind` each. On the old code one frame took 1.57 s and the whole test took 344 s.
- Fix: `Call` no longer holds `args`. It keeps `label` (from `describe_call`, worked out once in `Call::new`) and `detail` (the arguments' JSON, at most 400 characters). The full arguments stay in `turn.history`. `Call::shown()` gives the line ("Failed: ..." comes from new `tools::failed_label`). The hover text is built inside `on_hover_ui`. `describe_call` also cuts each value it puts into a label to 60 characters, because a 60 KB `kind` became a 60 KB label. With the fix the test passes in 7 s. Its frame limit is 250 ms (the old code was over 1.5 s), so CI load does not make it flaky. One existing test now uses `calls[0].shown()` instead of `describe_call(.., &calls[0].args, true)`.
- API change: `assistant::Call.args` is gone; use `label`, `detail` and `shown()`. Nothing outside ui-egui used it.

## AIUI-7: Done with an invalid Chat model lost both models, and the error
- Reproduced: `ai.rs::done_with_a_model_that_is_not_a_model_id_says_so`. It types 'gpt 5.5' and 'gpt-image-1.5' and clicks Done. Before the fix the dialog closed and neither model was saved.
- Fix: `save_models` saves each changed field with its own `set_models` call (`(Some(chat), None)`, `(None, Some(image))`) and returns `false` when one fails. `close` and `switch` keep the dialog, and the error shown in it, when it fails. A person who left an invalid model there has to fix or clear it to close. docs/generative-ai.md says so.

## AIUI-8: run_command could change the spelling dictionary and the favourite fonts
- Reproduced: unit test `assistant_tools::tests::the_spelling_dictionary_and_the_favourite_fonts_are_the_persons`. Before the fix `blocked("edit.checkSpelling", {action: addToDictionary})` was Ok.
- Fix: `type.font.favorite` is in `BLOCKED_IDS`. New `changes_dictionary` refuses `edit.checkSpelling` with `action` `add`, `addToDictionary` or `removeFromDictionary`; `{}`, `list`, `changeAll` and `suggest` stay allowed. docs/generative-ai.md lists both. I did not add the integration test the finding suggested: `run_command` asks `blocked()` before it runs anything, and the unit test covers that.

## Checks run
- Each new test failed before its fix and passes after.
- `cargo test -p photocraft-ui-egui --test it -- ai` (ai.rs and ai_assistant.rs): 93 passed. `-- ai crop`: 163 passed (after AIUI-3).
- `cargo test -p photocraft-ui-egui --lib -- ai_ui crop task_bar`: passed.
- `cargo fmt --all -- --check`, `cargo clippy -p photocraft-ui-egui --all-targets -- -D warnings` and `python3 scripts/pigment-rebrand.py --check` are clean.
- I did not wait for CI on the last push (b5f7445).
