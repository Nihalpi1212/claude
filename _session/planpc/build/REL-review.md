# REL-review: the last check before Pigment 0.5.0 is published

Reviewer's run, Nov 19 2026, 01:40 to about 03:00 UTC, on `claude/pigment-photocraft`.

## Verdict

**Go**, once CI on the head (f4e3ffa) is green. Publish with a manual run of "Pigment release" on
`claude/pigment-photocraft` with `tag: pigment-v0.5.0` (now allowed, see 5), or by pushing the tag.
Every blocker and major from the hunt is fixed, each fix has a test that fails without it (two
re-checked here by mutation), the only CI failure was a race in a test (fixed), and the documents
now match the code. What is left is minor and listed below for 0.6.

## My commits (all pushed)

| Commit | What |
|---|---|
| 2023dba | Release workflow: a manual run with a tag publishes from the default branch or from `claude/pigment-photocraft`, nowhere else |
| aa128ca | Docs: IMP-6's prompt in the release notes and README; a false known issue dropped; uninstall 0.4 first on Windows; Ctrl+F |
| f4e3ffa | CI fix: `set_key_prompt_gives_the_terminal_its_echo_back` waits for the CLI's last line |

## 1. CI

- 44434978381 (66a6dff): green. 44437035412 (c588cb4): cancelled (superseded while queued, not red).
- 44438666631 (9cb5b51): **red**, Tests step only: `photocraft-cli::it ai::set_key_prompt_gives_the_terminal_its_echo_back`
  panicked at ai.rs:631. The CLI exited with success, but the thread reading the pty had not read
  "OpenAI key stored" yet, so `shown` held only the prompt. A race in the test, not in the CLI.
  Fixed in f4e3ffa: `Pty::shown_with(text)` polls up to 10 s for the expected line, after Enter and
  after Ctrl+C. 25 stress iterations of `photocraft-cli::it ai::` pass; fmt and workspace clippy clean.
  Every other step of that run passed (clippy, panic hunt, doctests, repository checks, packaging
  tests, CLI smoke test, lockfile).
- aa128ca (docs) and f4e3ffa were still running when I wrote this; the next engineer checks them first.

## 2. Checks on the head (one cargo process at a time)

| Check | Result |
|---|---|
| `cargo fmt --all -- --check` | clean |
| `cargo clippy --workspace --all-targets --locked --features heif -- -D warnings` | clean (before and after f4e3ffa) |
| `python3 scripts/pigment-rebrand.py --check` | clean |
| `cargo xtask layers`, `panel-commands`, `scorecard --check` | all exit 0 |
| `cargo test -p xtask` | 101 passed |
| Tests of the crates changed since 753ccc2 (format, genai, automation, photocraft-cli, photocraft, io, engine, ui-egui), nextest `--profile ci` with CI's upstream filter | lib+bins: 12,751 run, 12,748 passed, 3 failed: `ui-egui tools::type_tool::font_commit_tests::selected_fonts_commit_pattern_{0,2,3}` (got "Inter Display" for "Inter": a font installed in this container, the known container-only type-tool failure; untouched by Pigment, and green in CI). Integration tests in 6 batches: 2,203 run, all passed |
| CLI smoke test of pigment-ci.yml, run by hand | passed (all steps, `set -euo pipefail`) |
| `pigment --version`, `pigment-cli --version` | both `Pigment 0.5.0 (based on PhotoCraft 0.23.1)` |
| `bash packaging/linux/package-docs-test.sh` after the doc edits | passed |

The first combined test run filled the disk (0 bytes free) while linking the engine's and
ui-egui's test binaries; I deleted the test executables over 20 MB and ran the tests in batches,
deleting them between batches.

## 3. The fixes

29 findings: 1 blocker, 9 majors, 19 minors. All six FIX notes read.

| Finding | Severity | State |
|---|---|---|
| CROSS-1 (= AIUI-1) | blocker | fixed, 8746d49 |
| CROSS-2 | major | fixed, 83a02b6 |
| AIE-1 | major | fixed, 4934ed8 |
| AI-1 | major | fixed, b62b14f |
| AIUI-1 | major | fixed by CROSS-1 |
| IMP-1, IMP-2, IMP-3 | major | fixed, 63675de, ea735de, 7ff9a54 |
| REL-1 | major | fixed, c588cb4 |
| minors | minor | all fixed except IMP-5 (left for 0.6; reason holds, see below) |

IMP-5's reason holds: `write_document` saves in the background whenever `background_jobs` is set
and `services.save_file` exists, which is the desktop's default (`apps/photocraft/src/main.rs`:
off only with `PHOTOCRAFT_INLINE_JOBS`); the background save calls `saved_document`, which moves
the close prompt on. The release notes listed it as a known issue for everyone, which was wrong; I
removed that item.

Adversarial re-checks (does the test fail without the fix?):

- **CROSS-1, the blocker.** With `task_bar::expand_from_crop`'s old `.clamp(w, 30_000.0)` put back,
  `ui-egui::it ai::expand_from_crop_on_a_very_wide_document` panics ("min > max ... min = 40000.0,
  max = 30000.0"). With only the Generate window's old `w0..=30_000` DragValue ranges put back,
  the same test fails its width assert (ai.rs:515). Both halves of the fix are covered. Restored:
  passes.
- **AI-1.** With `self.reload()` taken out of `AiAccounts::update`, `genai keys::a_save_keeps_what_another_process_changed`
  fails at keys.rs:188 ("set_default_provider brought back the old consent or agents"). Restored: passes.

## 4. The documents against the code

Checked against the code: menu places and labels (`ai_ui.rs` FEATURES table, accounts, task bar,
prefs field "Let AI apps use this window"), Help › Check for Updates (`updates_ui.rs`), the settings
folder (`app_dirs.rs`), the CLI's `ai` subcommands and `run --allow-ai` (`pigment-cli ai --help`),
the AI limits in generative-ai.md (1536/2048/1024 px, 20,000 characters, 4000-character prompts,
30 listed commands, 12 rounds, 40 messages, 32 calls, 64 KiB, 12,000-character results), the task
bar's visibility rule, the 0.4 save prompt's strings and its left-out rule, "nested more than 8
deep", the AppImage's `--cli`, the parity page's arithmetic (every area row sums, the totals are
1,432 = 907 + 304 + 153 + 68 for 0.5.0 and the other two columns), and the anchors the notes link.

Fixed (aa128ca):
- **Release notes, README:** the first-Save question over a 0.4 file whose import left parts out
  is asked even after "Don't show again", with Save As… as its default (IMP-6 changed this; the
  user guide said so, the notes and README did not). README now also says actions don't ask.
- **Release notes:** dropped the known issue "the close prompt needs Save a second time" (only with
  the debug variable, see 3).
- **Release notes, README, user guide install page:** the MSI writes into 0.4's folder
  (`%LOCALAPPDATA%\Programs\Pigment`, electron-builder's NSIS per-user default) but 0.4 stays in
  Settings › Apps, and its uninstaller, run later, deletes the folder with 0.5 in it (FORK.md
  already said so). The docs said only "replaces it"; they now say to uninstall 0.4 first.
  FORK.md no longer claims the docs tell users to export their documents first.
- **use-generative-ai.md:** the command palette is ⌘F on macOS and Ctrl+F on Windows and Linux.

Not checked line by line: the upstream-derived user guide pages (adjustments, selections, type)
and every row of generative-ai.md's 0.4 comparison; REL-docs checked the guide's labels and a
48-entry parity sample.

## 5. The release workflow

`.github/workflows/pigment-release.yml` (2023dba): the version step gets `RELEASE_BRANCH:
claude/pigment-photocraft`, and a manual run with a `tag` passes only when the ref is a branch
named the default branch or `claude/pigment-photocraft`. The header comment and the step's comment
and error say so. Nothing else changed. Checked by running the step's script with the
workflow's env: tag + `claude/pigment-photocraft` passes; tag + default branch passes; tag + any
other branch, a branch with that name as a prefix (`claude/pigment-photocraftx`) or a tag ref
fails; no tag on another branch builds only; tag push passes; a tag that does not match
Cargo.toml fails.

What the notes say about the publication holds: version 0.5.0 gives `prerelease=false` (only a
version with a `-` suffix is a pre-release) and the release step sets `prerelease: false` and
`make_latest: 'true'`; the notes say 0.5.0 is Pigment's latest release and 0.4.0 stays
downloadable from its page; `target_commitish: github.sha` creates the `pigment-v0.5.0` tag the
in-app links and the metainfo point at. The notes have no "## Downloads", so the workflow adds the
downloads table and the first-launch steps the notes' Known issues refer to ("below").

## 6. The version

`[workspace.package] version = "0.5.0"`. The metainfo's release entry is `@VERSION@`/`@DATE@`,
filled at packaging time from Cargo.toml and the build date (CI substitutes 0.0.0 to validate it);
the release notes say 0.5.0 throughout and carry no date. No file in the tree carries a fixed
release date, so nothing needed today's date written in; the packages get it from the build.
The tag `pigment-v0.5.0` does not exist yet; `pigment-v0.4.0` does.

## Left for 0.6

- IMP-5: with inline saves (`PHOTOCRAFT_INLINE_JOBS`), Save in the legacy prompt does not release
  the close prompt; the upstream disk-change prompt has the same gap.
- The Assistant's `canvas_size`/`resize_image` tools cap sizes at 30,000 px (the engine allows 300,000).
- `ai set-key`: a kill from outside (SIGTERM, SIGHUP) during the no-echo prompt leaves echo off;
  on Windows the key still shows as typed.
- Windows install over 0.4: the MSI and 0.4's NSIS install share a folder; changing the default
  folder (or removing 0.4 on install) is a decision for a later release. Documented for now.
- `docs/user/faq/is-photocraft-free.md` links `tree/claude/pigment-photocraft/...` (breaks if the
  branch goes); the release-tag links only resolve once the tag exists.
- The upstream merge (PhotoCraft main since `abb30df`), the 83 Pigment 0.4 features, code signing,
  more platforms, live-account testing of the AI providers and the key stores on real macOS/Windows.
- The WiX `$(var.DisplayVersion)` URL and nfpm's `@VERSION@` substitution are first exercised by the
  release workflow itself; check the packages' homepage URLs after the release, and
  `gh api repos/Nihalpi1212/claude/releases/tags/pigment-v0.5.0` for `prerelease: false`, and that
  it is the latest release.
