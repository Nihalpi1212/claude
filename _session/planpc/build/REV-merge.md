# Review of the 057297b merge (verifier)

Branch `claude/pigment-merge-057297b`, reviewed at `9205833` (the ci step's head, CI run 45931901504
green: 14135 tests run, 14135 passed, 91 skipped = the `#[ignore]`d tests; known-failures step 0
tests; panic hunt 1 passed; repository checks, packaging, CLI smoke test, lockfile all green).
Notes read: PKG-merge-{import,engine,automation,cli,ui,app,ai-ui-1,ai-ui-2,ai-ui-3,rebrand-docs,ci}.md.
Upstream trees compared from the objects in /home/user/claude (NEW `057297b`, OLD `abb30df`).

**Result: merged.** One commit of mine, `03ccb71` (FORK.md only), on top of `9205833`; CI on
`03ccb71` (run 45944415974) green on every step (Tests: 14135 run, 14135 passed, 91 skipped;
panic hunt, doctests, repository checks, packaging, CLI smoke test, lockfile). The release branch
`claude/pigment-photocraft` had no commits the merge branch lacked (it was at `f4e3ffa`, an
ancestor), so it was fast-forwarded: `git push origin
claude/pigment-merge-057297b:claude/pigment-photocraft` (`f4e3ffa..03ccb71`). `/home/user/claude`
is on `claude/pigment-photocraft` at `03ccb71`, tree clean.

## 1. CI and the tests

- Head `9205833` green in CI (above). No test skipped: `scripts/upstream-test-failures.txt` is
  empty (the ci step ran its 53 entries, all passed; 7 deleted upstream), so the Tests step's
  filter is `all()`.
- Pigment's tree against NEW adds no `#[ignore]` (the same three Pigment ones as 0.5.0 against
  OLD: credential store, two by-hand dump tests). Tests of upstream's that Pigment's tree lacks:
  `agents_tests.rs::{with_the_flag_the_launcher_switch_alone_…, without_the_flag_the_launcher_switch_means_nothing}`
  and `updates_ui.rs::manual_check_works_when_automatic_checks_are_off_and_opens_status`, each
  replaced by Pigment's test of the behaviour Pigment keeps (no launcher, no check). Nothing
  else removed.
- Pigment's AI and importer tests are in the binaries CI ran: `ui-egui/tests/it/main.rs` has
  `mod ai; mod ai_assistant; mod legacy_pigment;` (31 + 31 + 2 tests), `genai/tests/it/`,
  `cli/tests/it/{ai,legacy_pigment}`, `automation/tests/it/legacy_pigment`, io's legacy_pigment.

## 2. The rebrand

- `pigment-rebrand.py --check`: clean.
- `rg 'PhotoCraft' --glob '*.rs'` outside comments: 33 lines; compared with the same search at
  `f4e3ffa`: the only differences are the version-line tests (`+057297b`), `links.rs`'s two lines
  moved into `ABOUT`/`credit()`, and fields.rs's test probe (`// upstream-ok`). All kept markers.
- `ArtCraft` outside comments: theme ids `craft.artcraft` (internal), the credit line, tests.
  getartcraft/discord/storytold: same file set as 0.5.0.
- Version line: `pigment --version` and `pigment-cli --version` print
  `Pigment 0.5.0 (based on PhotoCraft 0.23.1+057297b)` (D3), CI's `grep -qx` pattern matches.
- Packaging (desktop entry, metainfo, MIME, WiX + wxl, Info.plist, nfpm, Flatpak manifests):
  unchanged since 0.5.0 (upstream did not touch `packaging/`); names, ids
  (`io.github.nihalpi1212.pigment`), homepage and bug-tracker links are Pigment's. Viewport title
  "Pigment", `os_window::APP_ID`, host name "Pigment", About "Pigment" with Pigment's four links,
  no Discord; start screen rail Home / Learn (Pigment's guide) / Releases / Report an Issue /
  GitHub (icons exist in `icon_data.rs`). `pigment --help`/`pigment-cli --help`: only the kept
  `PHOTOCRAFT_*` variable names.
- Folders: settings in `config.toml` via `Location::Dir(<settings>)` (Memory without one), themes
  in `<settings>/Themes` (`SuiteDir::at`, never `resolve`), `Preset Library`; the clash table has
  them. The app step's strace start showed nothing under ArtCraft.
- **Found, not fixable in Pigment: the framework's built-in theme `craft.artcraft` is named
  "ArtCraft"** (craft-theme `themes/artcraft.json`, new with the framework). Preferences ›
  Interface's theme chips (craft's `AppearancePage`, `ThemeChip::new` → `.label(theme.name)`,
  `SHOWS_LABEL = false`) show it as the chip's tooltip and accessible name. The page takes
  `craft_theme::builtins()` directly and has no name override, and the label is a literal (no
  word lookup), so neither Pigment's catalogs nor `WordsOverride` reach it. Pigment's own
  Appearance menu names it "Pro (Medium Gray)". Recorded in FORK.md (decisions table and the
  classification table) as a question for the owner: a name override in craft-libs, or Pigment's
  own page. **Confirmed** with a throw-away kittest (not committed): on Preferences › Interface,
  `query_all_by_label_contains("ArtCraft")` finds two nodes (the theme's chip in the Light and the
  Dark row). It is the only ArtCraft/PhotoCraft name found in what a person sees; it does not
  name Pigment as anything else (a theme's credit-like name, as Adwaita and Breeze are), so it does
  not block the merge, but the owner should decide.

## 3. No request on its own

- Upstream's added code (OLD..NEW, `.rs`/`.toml` added lines) grepped for ureq, reqwest, hyper,
  TcpStream, http(s) URLs, telemetry, downloads, `check_at_start`/`check_now`/`enable_network`:
  the only callers are upstream's `updates_ui.rs` (`check_at_start` in `tick`, `check_now` for
  Check Now/Again) — replaced in Pigment's file — and loopback test clients. The URLs are XML
  namespaces and data URLs in tests.
- Pigment's tree: no call of `check_now(`, `check_at_start(`, `self_update::finish`,
  `enable_network(`, `AgentSwitch::watch`, `agents::mcp_flag(`, `launcher_allows(` outside tests
  that assert their absence.
- `cargo tree -i ureq`: craft-font-store (via craft-font-manager), craft-update, pigment-genai.
  Font store: nobody in Pigment or craft-libs builds `SuiteStore::for_user`/an `Installer`; the
  network needs `enable_network`, never called. craft-update: `Updater::new` reads only the
  pretend-version variable; `tick` polls channels only a check would create; `run` acts on a
  prompt only a check opens; `read_last_update` reads (and removes) craft-update's own record
  files `<data_local>/pigment/self-update-done.txt` and `logs/self-update-error.txt` (`Pigment`
  on macOS/Windows), which only craft-update's installer writes: local, never written by Pigment
  (now noted in FORK.md). reqwest/hyper: not in the app's or CLI's graph. No new HTTP crate
  besides `webpki-roots` through ureq.
- Agents: `main.rs` builds `AgentSwitch::fixed(false, false)`; `sync_agent_link` lets agents in
  on `agents_allowed(false, false, connect_agents)`; the connection file is written only with the
  switch on (app step's start check). The CLI's live MCP condition is Pigment's
  (`None if !a.headless`), no `mcp_flag()`.

## 4. Pigment's features

- Every hook of FORK.md's Generative AI and 0.1–0.4 importer tables checked against the merged
  files (grep of each named call/line): all present (headless.rs's spells `crate::genai::…`).
- Feature labels unchanged from 0.5.0 (D2) and the `ai.*` ids identical (compared with
  `f4e3ffa`).
- CLI smoke test of pigment-ci.yml run by hand (the step's script, scratch `RUNNER_TEMP`): exit 0
  — version pattern, new/convert/info round trip, `manifest.json`, the 0.4 fixtures (info, PNG,
  native), File Info, and the damaged file's typed error.

## 5. Three hand merges, line by line

1. **`crates/ui-egui/src/updates_ui.rs`** (6 conflict hunks): against NEW, `check` opens
   `links::RELEASES` instead of `updater.check_now()`; `tick` drops `check_at_start` and keeps
   `read_last_update` (local, above); Check Now/Again call `check`; upstream's result window,
   `status_message`, `preview_release` kept. Against 0.5.0: same behaviour (0.5.0's `check`
   returned `{"status":"opened"}`; kept, with the url), its two tests back. Correct.
2. **`crates/ui-egui/src/prefs/prefs_ui/agents.rs`** (3 hunks; D1): `sync_agent_link` is
   upstream's except the `allowed` line (`agents_allowed(false, false, connect_agents)`, never
   `agent_switch.allows`); `page` draws Pigment's switch (draft key `integrations.connectAgents`,
   off by default), then `AgentsPage::mcp_flag(true)` under `WordsOverride::Overlay` of
   `agents.intro`/`agents.off` (the only two words in craft's `agents/words.rs` naming the
   launcher; Overlay wins over every locale's catalog), then `ai_ui::preferences_rows`. Correct.
3. **`apps/photocraft/src/main.rs`** (4 hunks): against NEW, only Pigment's names
   (`PIGMENT_CONTROL_PORT`, `pigment:` lines, title, `run_native("Pigment")`), the version line in
   the log and the connection file, `self_update::finish` removed (unknown `--finish-update`,
   `launch_args::exit`), `ai_ui::install` after `background_jobs`, `AgentSwitch::fixed` for
   `watch`, and the packaging paths in tests. Against 0.5.0: the same promises. Correct.

Also read: `dialogs/legacy_save_prompt.rs` (framework `StandardPrompt`; Proceed/Alternate/Cancel
are all of `PromptChoice`'s variants, so the `(_, left_out)` arm is Alternate only; the one
behaviour change — "Don't show again" kept with Save only — is in the user guide and FORK.md),
`dialogs/credits.rs::about_info`, `canvas/start_screen.rs`, `links.rs`.

## Commits of this review

- `03ccb71` "Pigment merge 057297b, verification: FORK.md records the framework's ArtCraft theme
  name and the update record's folder" (docs/FORK.md: a row in the decisions table, a row in the
  classification table and its "0 left" row qualified, the `updates_ui::tick` local read named).
  No code changed: the probe test used to confirm the theme chip was reverted.

## Left

- The "ArtCraft" theme chip (above): owner's decision; nothing in Pigment can rename it at
  craft-libs `18ffc07`.
- `links::ABOUT`'s labels are translated at run time (`i18n::t`) but are not `tl!` literals, so a
  catalog extractor does not see them there (they exist as `tl!`s elsewhere). Cosmetic.
- Earlier notes' remarks still stand: the engine's cancel test is slow in this container (passes
  in CI), automation's `scratch_save` under plain `cargo test` (passes under nextest).
