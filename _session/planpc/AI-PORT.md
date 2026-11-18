# Pigment on PhotoCraft: porting the generative AI

PhotoCraft has no generative AI. The JavaScript Pigment (0.2 to 0.4) had:
- Generative Fill, Generative Expand and Generate Image;
- AI Remove Background, Replace Background (Generate Background) and Replace Sky;
- Describe Image;
- an Assistant chat that edits the document;
- AI Accounts with OpenAI and Gemini keys, Sign in with ChatGPT and model choice.

This port rebuilds all of it in Rust, so nobody who used Pigment loses a feature.

## Read first

- `planpc/ai/PIGMENT-AI.md` is the exact inventory of the JavaScript features: flows, options, request shapes, masks, results, the Assistant's prompt and 14 tools, Sign in with ChatGPT, errors and tests. It is the spec for what users must get.
- `planpc/ai/INTEGRATION.md` is the design. Follow it:
  - the engine seam `photocraft_engine::generative` with a `MockBackend`;
  - the `ai.*` engine commands in `crates/engine/src/cmd/ai_cmds/`;
  - the new crate `crates/genai` (package `pigment-genai`), ported from Nib's `nib-genai`;
  - the interface in `crates/ui-egui/src/ai_ui*`;
  - the CLI subcommands;
  - the package order P1 to P5 (§7).

Both are in `/tmp/claude-0/-home-user-claude/02aa60de-818c-5d38-b2f3-33055ac112a1/scratchpad`.

Sources:
- the Rust tree, `/home/user/claude/pigment` on branch `claude/pigment-photocraft` (rebranded to Pigment; `pigment/docs/FORK.md` says what the rebrand changed and kept);
- the JavaScript app, `git show claude/fervent-newton-263lz3:pigment/...`;
- Nib, `git show origin/claude/nib-vector-editor:nib/...` (crates/genai, crates/ui-egui/src/ai.rs and src/ai/, tests/ai.rs, docs/generative-ai.md).

## Decisions (already made, from the open questions in both documents)

1. **Remove Background.** PhotoCraft's classical `layer.removeBackground` stays as it is. `ai.removeBackground` takes a `method` of `local` or `provider`. Both put a mask on the layer in place, as Photoshop and PhotoCraft do (not the JavaScript copy-and-hide). The menu default is `local`, since it needs no key.
2. **Placement: Photoshop's places, as Nib did.**
   - Edit menu: Generative Fill…, Generate Image…, Sky Replacement…, and AI Accounts….
   - Generative Expand: in the Crop tool's task-bar slot and its options.
   - Generate Background: a contextual action after Remove Background, and in the Layer menu next to Remove Background.
   - Describe Image: File › File Info's neighbourhood (or Image, if INTEGRATION.md's placement says so), and the command palette.
   - Window › Assistant.
   - Every feature is in the command palette. There is no top-level AI menu: PhotoCraft's menu tree mirrors Photoshop's.
3. **Consent.** Nib's one-time agreement in AI Accounts, with the billing and privacy wording (a request stopped by the user is still billed by the provider). Nothing is sent before it.
4. **Providers.** The own crate `pigment-genai`, ported from Nib, as INTEGRATION.md §0 recommends. craft-ai-integrations is not adopted now; the engine trait keeps that door open (P6 later).
5. **Sign in with ChatGPT (P5).**
   - Build it, isolated so that one setting or constant turns it off without touching API-key users.
   - Mark it "experimental" in AI Accounts, because the flow is undocumented and was never verified against the live service.
   - Images still need an API key, as in the JavaScript app.
6. **Locking.** v1 accepts `lock_document` for the length of a request, as INTEGRATION.md P1 says. The job shows in the status bar with Cancel. Other documents stay editable. Note the non-blocking JavaScript behaviour as a follow-up in docs/generative-ai.md.
7. **Actions and agents.**
   - AI commands are not recorded into Actions (record: false), so a replay never spends money by surprise.
   - MCP and CLI callers must opt in (`allowAgents` in Pigment's settings, `--allow-ai` on the CLI).
   - The in-app Assistant may call only `ai.generativeFill` among the `ai.*` commands, as in JS.
8. **Replace Sky** uses PhotoCraft's `select.sky` for the mask and the provider for the new sky, composited through the mask.
9. **No migration from the Electron app.** Keys and the ChatGPT sign-in are entered again; the release notes say so. The last prompt per feature may be kept in Pigment's settings, as in JS. Keys never go there.
10. **No live keys exist here.** Every test uses the MockBackend or a localhost mock server. Nothing in the test suite or CI touches the network.

## Rules for every package

- **One build at a time.** Machine: 4 CPUs and a shared target directory. Run one cargo process at a time with `-j 4`, and never `cargo clean`. The whole workspace test suite is too long here; run the tests of the crates and files you touched (CI runs everything).
- **Disk.** The real quota is about 39 GB in all; `df` reports 252 GB, which is misleading. Always build with `CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0`. Test runs use `TMPDIR=/dev/shm/pt CRAFT_I18N_DIR=/home/user/storytold/craft-i18n CRAFT_FONTS_DIR=/home/user/storytold/craft-fonts` (the translations and fonts CI uses, at the same commits).
  - Before a big test build, check `df -h /`. If less than 6 GB is free, delete the test executables in `target/debug/deps` (`find pigment/target/debug/deps -maxdepth 1 -type f -perm -u+x -size +20M -delete`) and `target/debug/incremental`. Cargo rebuilds them when needed.
  - Tests that only fail in this container, so don't chase them: PhotoCraft's scratch-disk check misreads the 252 GB volume unless `TMPDIR=/dev/shm/pt` is set; permission tests can't pass as root; a few type-tool font tests can pick up a font installed here. The known upstream failures are listed in `pigment/scripts/upstream-test-failures.txt`.
- **Keep CI green** (`.github/workflows/pigment-ci.yml`): `cargo fmt --all -- --check`, clippy with `-D warnings` on what you touched, and your tests. If you added or changed an engine command, also run the panic hunt (upstream's rule 9: no command may panic or hang on adversarial parameters): `cargo test -p photocraft-engine --test panic_hunt -- --ignored`. If you added a crate, a preference or a panel command, run `cargo xtask layers`, `cargo xtask panel-commands` and `cargo xtask scorecard --check` (regenerate with `cargo xtask scorecard`), and `cargo test -p xtask`: CI runs all of these, and the tests through cargo-nextest (`cargo nextest run --profile ci ...`, installed here too), which runs each test in its own process. Add an `upstream-ok` marker or a FORK.md entry where the rebrand script or the merge notes need one.
- **Hooks into upstream files stay small** (a line or two each). List every one in `pigment/docs/FORK.md` under "What Pigment added", as Nib does.
- **New interface strings** go through PhotoCraft's i18n catalogues: English, with the other languages left to their usual fallback unless the catalogue tooling requires rows.
- **Commits.** Commit locally after each verified part, with messages ending in these two lines:

  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_012irzNNBVSJyVqHJpCPbdwm
  ```

  **Push each verified commit at once:** `git push origin claude/pigment-photocraft` (retry up to 4 times on a network error). The container can be reclaimed at any moment, and an unpushed commit is then lost. Commit and push only work that builds and passes its tests, fmt and clippy: CI runs on every push. Never rewrite history. Put no model names in the repository other than in those trailers.
- **Back up as you go.** Run `bash /tmp/claude-0/-home-user-claude/02aa60de-818c-5d38-b2f3-33055ac112a1/scratchpad/planpc/snapshot.sh "<package>: <what>"` at least every 30 minutes while you have uncommitted work, and after you write or update your notes. It pushes the working tree and the plan files to a backup branch without touching HEAD or the index. The container can be reclaimed at any moment, and whatever is neither pushed nor in a snapshot is lost.
- **Hand-off notes.** Write a short note to `planpc/build/PKG-<package>.md` for the next engineer: what you built, the files, the hooks, the tests, and anything left.
