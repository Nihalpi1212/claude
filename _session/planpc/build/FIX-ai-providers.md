# FIX-ai-providers: the AI provider crate and the command line

CI before starting: the newest finished Pigment CI run on claude/pigment-photocraft with a result (44422796695) was green. The runs after it were cancelled because later pushes superseded them, so no run was red and no CI fix was needed. Earlier fixers' notes (FIX-ai-engine, FIX-ai-ui, FIX-cross, FIX-importer) cover none of these three findings.

An engineer who was cut off by a container restart (00:52 UTC, Nov 19) fixed and pushed AI-1 and AI-2. I fixed AI-3.

| Finding | Severity | Reproduced | Fixed | Commit |
|---|---|---|---|---|
| AI-1 | major | yes | yes | b62b14f |
| AI-2 | minor | yes | yes | 027ac85 |
| AI-3 | minor | yes | yes | c2a68b9 |

No engine command was added or changed, so the panic hunt was not needed.

## AI-1: a save of ai.json wrote back what another process had changed
- Reproduced: in `crates/genai/tests/genai/keys.rs::a_save_keeps_what_another_process_changed`, one `AiAccounts` turns agents on and a second one turns them off. Before the fix, the first one's next `set_default_provider`, `set_models`, `set_consented` or timeout save wrote `allowAgents: true` back. In the interface, `crates/ui-egui/tests/it/ai.rs::ai_accounts_left_open_keeps_what_the_command_line_changed` writes `allowAgents: false` from outside while AI Accounts is open, then clicks a Preferred provider. Before the fix the file said true again.
- Fix: `AiAccounts::update(f)` re-reads ai.json, applies the one change and saves. These all go through it:
  - the setters;
  - sign-in's hostId;
  - AI Accounts' timeout;
  - the Assistant's provider and Attach image;
  - the Generate window's last prompt and image provider.

## AI-2: `ai sign-out` left the ChatGPT tokens when Sign in with ChatGPT was off
- Reproduced: `apps/photocraft-cli/tests/it/ai.rs::sign_out_removes_tokens_the_feature_does_not_show` stores a sign-in record with `"chatgptSignIn": false`, and a second case adds an OpenAI key next to it. Before the fix, sign-out printed "Not signed in with ChatGPT." and the tokens stayed in the key store.
- Fix: the CLI goes by what is stored (`ChatGpt::has_stored()`), not by what is active. AI Accounts offers "Remove the stored ChatGPT sign-in" while the feature hides one (`crates/ui-egui/tests/it/ai.rs::ai_accounts_removes_a_sign_in_the_feature_hides`). docs/generative-ai.md was updated.

## AI-3: Ctrl+C at `ai set-key`'s no-echo prompt left the terminal's echo off
- Reproduced in two ways:
  - The pty script `scratchpad/ai3/ctrlc.py` (setsid, then TIOCSCTTY, then a typed `\x03`) reported "echo after Ctrl+C: False".
  - The new test `apps/photocraft-cli/tests/it/ai.rs::set_key_prompt_gives_the_terminal_its_echo_back`, which is Linux-only, failed on the old code: "the terminal's echo is still off after Ctrl+C (wait status 2)".
- Rejected first try, a child `sh` whose trap restores echo: I built it and checked it with the pty script. Echo did come back, but only after the CLI had already died of SIGINT, because the trap runs in an orphaned grandchild. In a job-control shell that is a race:
  - bash takes the terminal back as soon as the CLI exits, and readline can save the echo-off state before the trap runs;
  - the late `stty` now runs in a background process group, where SIGTTOU stops it.

  A first version of the test also hid this race: it killed the process group and polled for echo.
- Fix: no signal is involved, so nothing can kill the CLI while the terminal is changed.
  - `read_key` uses the new `hidden::Hidden` in `src/ai.rs`. It saves the terminal's settings with rustix's safe termios API, then turns off ECHO, ICANON, ISIG and IEXTEN (VMIN 1).
  - It reads the key byte by byte. Enter, Ctrl+D or end of input ends the line. Backspace removes one UTF-8 character and Ctrl+U clears the line. Ctrl+C arrives as a byte, and the command fails with "interrupted: no key was stored" (exit 1).
  - Drop puts the saved settings back before `read_key` returns, so the terminal is restored whether the line ended or not, and even on a panic.
  - On systems other than Unix there is a stub (an empty enum), and the key shows as before, with the prompt saying so.
- Test: it runs the CLI under `setsid --ctty` on a pty, so the pty is its controlling terminal and Ctrl+C is the keystroke a person types. It checks:
  - with Enter: echo is off during the prompt; the key is never shown; Backspace works (the stored key is exact); echo is back the moment the CLI exits;
  - with Ctrl+C halfway through the key: exit 1, "interrupted" shown, nothing stored, echo back at exit with no polling.

  `ctrlc.py` now also passes (exit 1, echo back).
- Hooks: `apps/photocraft-cli/Cargo.toml` adds `rustix` 1.1.5 (termios, std) under `cfg(unix)` dependencies, and with `pty` under `cfg(unix)` dev-dependencies for the test. That rustix is already in Cargo.lock; the lock only gains the edge. Recorded on FORK.md's `apps/photocraft-cli/Cargo.toml` row. docs/generative-ai.md says Ctrl+C cancels and leaves the terminal as it was.
- Checks: `cargo test -p photocraft-cli --test it -- ai::` (8/8), the full `cargo nextest run --profile ci -p photocraft-cli`, `cargo fmt --all -- --check`, `cargo clippy -p photocraft-cli --all-targets -- -D warnings`, and `pigment-rebrand.py --check`.
- Left for 0.6: a kill from outside (SIGTERM, or SIGHUP when the window closes) during the prompt still ends the CLI without restoring the terminal. The hunt did not report this, and handling it would need a signal handler. Windows still shows the key as it is typed; PKG-ai-final already lists that.
