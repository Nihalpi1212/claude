# Pigment on PhotoCraft: porting the JavaScript Pigment's other extras

Task #2. The old JavaScript Pigment (0.1 to 0.4) was ahead of PhotoCraft on 93 Photoshop rows. The generative-AI rows go through planpc/AI-PORT.md. This brief covers the rest, plus opening the `.pigment` files that Pigment 0.1 to 0.4 wrote, so nobody who used Pigment loses a feature or a file.

## The base moved (Nov 27)

Pigment now runs on PhotoCraft 057297b (FORK.md, "Upstream after the import"; the merge notes are planpc/build/PKG-merge-*.md and MERGE-PLAN.md). Upstream rebuilt its interface on the craft framework: dialogs, widgets, task bars, menus (craft::menu Rows), prompts, preferences and the canvas chrome now come from the framework. The specs below were written before that; **planpc/ports/REBASE-<group>.md** re-checks each package against the new tree (what upstream now does, where the files went, the adjusted plan) and wins where they differ. scripts/upstream-test-failures.txt is now empty: every test must pass.

## The specs (read your package's section and every row it lists)

Both are in `/tmp/claude-0/-home-user-claude/02aa60de-818c-5d38-b2f3-33055ac112a1/scratchpad/planpc/ports/`.

- **`PORTS-A.md`**, 22 packages:
  - L1 to L3: the legacy `.pigment` importer;
  - A1 to A7: adjustment presets, Auto options, Curves display, on-image tools, new adjustments, HDR, Match and Replace Color;
  - P1a to P4: Preset Manager, Export/Import, .tpl, noise gradients, migration;
  - F1 to F3: File Info, Targa, GIF, LUT formats, AVIF;
  - U1 to U4: Info panel, Actions, pen tablet, Select Similar Layers and recent documents.
- **`PORTS-B.md`**, 18 packages:
  - B1 to B8: typography (model and PSD, Character UI, composer and hyphenation through craft-text, justification and hanging punctuation, Paragraph UI and lists, editing, fonts, spelling through craft-proof);
  - B9 to B18: smart-guide spacing, Blur Gallery effects, Path Blur, the Lens Correction workspace, Shake Reduction, Focus Area and Object Aware, shapes, Object Selection modes, Adjustment Brush and leash, scripted patterns.

Each row in the specs says:
- what Photoshop does;
- what the JavaScript app did, with file references on branch `claude/fervent-newton-263lz3`;
- what PhotoCraft has now;
- exactly what to build, with its tests and effort.

The specs' recommendations and their dropped items (sections "dropped") are accepted as written. Where a spec leaves a choice, keep what the JavaScript users had and record the choice.

## Order (one workflow per group, run one after another: one cargo build at a time)

Launch each group with `Workflow({ scriptPath: '/tmp/claude-0/-home-user-claude/02aa60de-818c-5d38-b2f3-33055ac112a1/scratchpad/planpc/ports.js', args: <the group's object> })`.

1. Group L, legacy importer; Pigment 0.5.0 ships after it, task #3: `{"group":"L","spec":"PORTS-A.md","packages":["L1","L2","L3"]}`
2. Group A, adjustments: `{"group":"A","spec":"PORTS-A.md","packages":["A1","A2","A3","A4","A5","A6","A7"]}`
3. Group P, presets: `{"group":"P","spec":"PORTS-A.md","packages":["P1a","P1b","P2","P3","P4"]}`
4. Group FU, formats and panels: `{"group":"FU","spec":"PORTS-A.md","packages":["F1","F2","F3","U1","U2","U3","U4"]}`
5. Group BT, typography: `{"group":"BT","spec":"PORTS-B.md","packages":["B1","B2","B3","B4","B5","B6","B7","B8"]}`
6. Group BR1, filters and guides: `{"group":"BR1","spec":"PORTS-B.md","packages":["B9","B10","B11","B12","B13"]}`
7. Group BR2, selection, shapes, brushes, fills: `{"group":"BR2","spec":"PORTS-B.md","packages":["B14","B15","B16","B17","B18"]}`

After each group: read its reports and review, verify the commits (build, the group's tests, the rebrand check), push, and get Pigment CI green before launching the next group. Mark task #2 done after group BR2.

## Rules for every package

- **Builds.** 4 CPUs and one shared target directory. Run one cargo process at a time with `-j 4`, and never `cargo clean`. Always set `CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_STRIP=symbols` (since the merge with PhotoCraft 057297b on Nov 27, a test build without stripping is about 19 GB; one cargo call without these variables starts a full debug rebuild). craft-fonts for tests is at cc9269c (/home/user/storytold/craft-fonts), as CI pins it. Test runs use `TMPDIR=/dev/shm/pt CRAFT_I18N_DIR=/home/user/storytold/craft-i18n CRAFT_FONTS_DIR=/home/user/storytold/craft-fonts` (the translations and fonts CI uses, at the same commits); without that TMPDIR, PhotoCraft's scratch-disk check misreads the 252 GB volume. Run the tests of the crates and files you touched; CI runs the whole workspace.
- **Disk.** The real quota is about 39 GB. Before a big test build, check `df -h /`. If less than 6 GB is free, delete the test executables over 20 MB in `pigment/target/debug/deps` (`find pigment/target/debug/deps -maxdepth 1 -type f -perm -u+x -size +20M -delete`) and `target/debug/incremental`.
- **Container-only failures.** These fail only in this container, so don't chase them:
  - permission tests, which can't pass as root;
  - a few type-tool font tests that can pick up a font installed here.

  Known upstream failures are listed in `pigment/scripts/upstream-test-failures.txt`.
- **Keep CI green** (`.github/workflows/pigment-ci.yml`): `cargo fmt --all -- --check`, clippy with `-D warnings` on what you touched, your tests, and `python3 pigment/scripts/pigment-rebrand.py --check`. If you added or changed an engine command, also run the panic hunt (upstream's rule 9: no command may panic or hang on adversarial parameters): `cargo test -p photocraft-engine --test panic_hunt -- --ignored`. If you added a crate, a preference or a panel command, run `cargo xtask layers`, `cargo xtask panel-commands` and `cargo xtask scorecard --check` (regenerate with `cargo xtask scorecard`), and `cargo test -p xtask`: CI runs all of these, and the tests through cargo-nextest (`cargo nextest run --profile ci ...`, installed here too), which runs each test in its own process.
- **Photoshop compatibility.** Photoshop's file formats are the target. Read and write PSD where Photoshop stores a feature. Round-trip through `.pigment` (PhotoCraft's native format inside) and through undo and redo. Every user action is one history entry.
- **Hooks into upstream files stay small.** List each one in `pigment/docs/FORK.md` under "What Pigment added", so upstream merges stay easy.
- **New interface strings** go through the i18n catalogues: English, with the other languages left to their fallback unless the tooling requires rows.
- **No network.** Nothing in the app or its tests touches the network, except the AI provider calls the AI port added.
- **Commits.** Commit locally after each verified part, with messages ending in these two lines:

  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_012irzNNBVSJyVqHJpCPbdwm
  ```

  **Push each verified commit at once:** `git push origin claude/pigment-photocraft` (retry up to 4 times on a network error). The container can be reclaimed at any moment, and an unpushed commit is then lost. Commit and push only work that builds and passes its tests, fmt and clippy: CI runs on every push. Never rewrite history. Put no model names in the repository other than in those trailers.
- **Back up as you go.** Run `bash /tmp/claude-0/-home-user-claude/02aa60de-818c-5d38-b2f3-33055ac112a1/scratchpad/planpc/snapshot.sh "<package>: <what>"` at least every 30 minutes while you have uncommitted work, and after you write or update your notes. It pushes the working tree and the plan files to a backup branch without touching HEAD or the index. The container can be reclaimed at any moment, and whatever is neither pushed nor in a snapshot is lost.
- **Hand-off notes.** Write `planpc/build/PKG-port-<id>.md` for the next engineer: what you built, the files, the hooks, the tests, and anything left.
