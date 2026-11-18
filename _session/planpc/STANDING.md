# Pigment on PhotoCraft: standing orders (read first at every check-in)

SCR = /tmp/claude-0/-home-user-claude/02aa60de-818c-5d38-b2f3-33055ac112a1/scratchpad

## The user's instructions

- "i need all the features same as photoshop, dont leave anything". This is the goal.
- Nov 15, about 13:00 UTC: build Pigment on PhotoCraft (github.com/storytold/photocraft, Rust), keep the name Pigment, stop the JavaScript app (its history is on claude/fervent-newton-263lz3, its unfinished 0.5 on claude/fervent-newton-263lz3-wip05).
- Nov 15, about 20:10 UTC: "Once you hit the limit, just continue it from what you have done. Nobody is going to ask you, and I am giving you permission, and I am telling you that it doesn't even matter."
  - **Standing permission:** after any usage-limit stop, resume automatically from the work done. Never wait for the user and never ask.
  - Keep the user informed in a few lines at milestones, but don't block on them.
- Nov 17: the user switched the session to the model claude-fable-5-2 and said "Try again".
- Nov 18, about 17:40 UTC: Fable's weekly limit had stopped everything at 04:22 UTC ("resets Nov 23, 2pm (UTC)"). The user switched the session to claude-opus-5-5 and said "Try again". Workflow agents inherit the session's model. The commit trailer is now "Claude Opus 5.5" (the briefs and snapshot.sh were changed).
- Ultracode is on: use the Workflow tool for substantive work, one cargo build at a time on this 4-CPU machine.

## If the scratchpad or the build folder is gone (the container was replaced)

A cloud container is reclaimed after inactivity; a usage-limit stop of a few hours is enough. It happened between Nov 15 21:35 and Nov 17 11:20 UTC. Then only pushed things survive.

1. Restore the plan files and this file:
   ```
   cd /home/user/claude && git fetch -q origin '+refs/heads/claude/pigment-photocraft-wip:refs/remotes/origin/claude/pigment-photocraft-wip'
   mkdir -p "$SCR" && git archive origin/claude/pigment-photocraft-wip _session | tar -x -C "$SCR" --strip-components=1
   bash "$SCR/planpc/setup-container.sh"
   ```
   setup-container.sh fetches the branches, checks out claude/pigment-photocraft, installs the build libraries, and clones the references into /home/user/storytold (photocraft, craft-libs, craft-ai-integrations, craft-i18n, craft-fonts).
2. Put back unfinished work. The newest snapshot's message has "Base: <sha>". If the snapshot is newer than the branch head's commit and differs from it:
   `git diff --binary <base> origin/claude/pigment-photocraft-wip -- . ':(exclude)_session' | git apply --3way`
   (older snapshots have no Base line: use the branch head if it is older than the snapshot). Skip this when the branch head is newer than the snapshot.
3. Workflow journals and agent transcripts are gone, so nothing can be resumed by run id. Restart the workflow that was running with the steps or packages not yet done (see "State" below and `git log`), and give the step that was cut off a continuation note saying what is in the tree.
4. The first cargo build is cold (about 25 minutes). Start it in the background before launching agents:
   `cd pigment && CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 cargo build --locked -p photocraft -p photocraft-cli -p xtask -j 4`

## The plan, in order (the task list was reset with the container on Nov 17: #1 AI port, #2 other ports, #3 release)

1. **Rebrand.** Done.
2. **AI port (task #1).** Brief planpc/AI-PORT.md, specs planpc/ai/PIGMENT-AI.md and INTEGRATION.md.
   - Done and pushed: P1 (engine seam and ai.* commands), P2 (pigment-genai, CLI), P3 (interface). Notes in planpc/build/PKG-ai-P1.md, P2.md, P3.md.
   - Remaining, run by planpc/ai-port-2.js with args { steps: [...], notes: { "<step>": "continuation note" } }. The steps, in order: review123, P4 (Assistant), P5 (Sign in with ChatGPT), review45, final.
3. **Other ports (task #2).** The 93 rows where the JavaScript Pigment was ahead, minus the AI rows, plus the importer for Pigment 0.1 to 0.4 `.pigment` files (hook: IoError::LegacyPigment in crates/io/src/legacy_pigment.rs).
   - Brief planpc/PORTS.md, specs planpc/ports/PORTS-A.md and PORTS-B.md (40 packages), generic workflow planpc/ports.js, run once per group with the args listed in PORTS.md (after a restart: packages = those still to build, done = those already pushed).
   - Group order: L (legacy importer), A, P, FU, BT, BR1, BR2.
   - **Release 0.5.0 (task #3) comes right after the AI port and group L.** Groups A to BR2 then go into 0.6.0.
4. **Release (task #3).**
   - Docs: README, USER-GUIDE, release notes, and PARITY re-based on the new app. The row-by-row map of PhotoCraft's statuses (photocraft-eval/map/*.jsonl) was lost with the container on Nov 16: only the summaries survive (photocraft-eval/REPORT.md, area-table.md, pigment-ahead.md, map/*-beyond.md). The docs step re-audits the Rust tree against the JavaScript app's docs/parity pages and keeps the result in the repository (pigment/docs/parity/).
   - A cross-feature bug hunt with regression tests and an adversarial review.
   - Merge the latest upstream PhotoCraft first if it is cheap; pigment/docs/FORK.md has the steps.
   - CI green, then the release workflow (pigment-release.yml, tag pigment-v0.5.0) builds unsigned Windows, macOS and Linux packages. Publish as a pre-release and give the user the download links.
   - If pushing the tag is refused (403, as happened for Nib), run the release workflow by workflow_dispatch with the `tag` input through the GitHub MCP tools if they allow it. Otherwise tell the user the one step they must do.
5. **After 0.5.0.** Keep going toward full Photoshop parity: PhotoCraft's own Missing and Partial rows, in packages.

## Rules

- **Commits and pushes.** Agents commit each verified part and push it at once to claude/pigment-photocraft (the briefs say so), and run planpc/snapshot.sh at least every 30 minutes. I check CI after their pushes and fix what breaks. When the stop hook asks to commit while agents work, run planpc/snapshot.sh "what" and say so; never commit an agent's unfinished files.
- **Commit trailers** (changed with the model on Nov 17, and again on Nov 18):
  - Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  - Claude-Session: https://claude.ai/code/session_012irzNNBVSJyVqHJpCPbdwm
- **CI.** Pigment CI (.github/workflows/pigment-ci.yml) must end green on pushed heads. The tests run through cargo-nextest (since Nov 17), whose `ci` profile repeats every failure at the end: mcp__github__get_job_logs (job_id, return_content, tail_lines 2500) saves the log to a file; search it for " FAIL [", "Summary [", "panicked at" and "error:".
  - Never skip a test to get green. The one exception is pigment/scripts/upstream-test-failures.txt: 60 tests that fail on untouched upstream too.
- **Builds and tests.** CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0, -j 4, one cargo process at a time. Tests: TMPDIR=/dev/shm/pt CRAFT_I18N_DIR=/home/user/storytold/craft-i18n CRAFT_FONTS_DIR=/home/user/storytold/craft-fonts.
- **Disk.** The real quota is about 39 GB; `df` misreports the volume as 252 GB. Below 6 GB free, delete the test executables over 20 MB in pigment/target/debug/deps and target/debug/incremental. Never `cargo clean`.
- **GitHub.** Use only the mcp__github__* tools (repo Nihalpi1212/claude). The user's email is private. No PR unless the user asks.
- **Check-ins.** One recurring hourly scheduled task ("Pigment hourly check") fires into this session; it keeps firing through usage-limit stops, so work resumes by itself after a reset. Don't add one-shot check-ins on top of it. At each check-in: follow "Check-in procedure", then update "State" below and run snapshot.sh.

## Check-in procedure

1. If SCR/planpc is missing, the container was replaced: do the section above first.
2. CI: mcp__github__actions_list list_workflow_runs on branch claude/pigment-photocraft. If the newest completed run failed, find the cause, fix it (commit only those paths, with the trailers, and push), unless an agent's later push already fixed it.
3. Workflows: is one running (TaskList shows background tasks; the journal under /root/.claude/projects/-home-user-claude/02aa60de-818c-5d38-b2f3-33055ac112a1/subagents/workflows/<run id>/journal.jsonl shows results)? If it finished, read its results, verify, and launch the next item of the plan. If it stopped (usage limit, restart), restart it: same script, args.steps or args.packages = what remains, and a continuation note for the cut-off step.
4. Disk, then update "State", run snapshot.sh, and tell the user in a few lines when something changed.

## State (update at every check-in)

- Nov 18, 17:52 UTC. **The session now runs on claude-opus-5-5** (Fable's weekly limit stopped everything at 04:22 UTC and resets Nov 23 14:00 UTC; the user switched the model). The container was restarted at about 17:40 UTC and kept its files (/dev/shm/pt made again; test executables deleted: 14 GB free). The hourly check fires at :39 (trig_0177jAfVM7gN5HetzTvbeyX5).
- **AI port (task #1): done.** CI green on 753ccc2 (run 44228003299). **Release dry run 2 green on all three platforms** (44228377588, on 753ccc2): P5's macOS Keychain and Windows Credential Manager code compiles there. PKG-ai-final.md has the one list of everything left open.
- **L1 done and pushed:** d6247d8 (documents of Pigment 0.1 to 0.4 open: document, pixel layers, groups, masks, channels, selection, guides, paths, File Info; other layer kinds open empty and are reported; import-only, so Save goes to Save As) and ee0c526 (CI: the Type bar's toggle test waits for the font scan; it had failed run 44227954305 on a0e42ff). **CI green on ee0c526** (run 44235263910). Notes: planpc/build/PKG-port-L1.md.
- 19:41 UTC hourly check: **L3 done and pushed** (9adda5f: type layers and smart objects open, with smart filters, an import report and a question before the first save over the old file; CI run 44380051338 in progress). CI green on c2243fb (L2, run 44369700966). **The group's review is running** (agent ac595c367fc2dc1fc, probing with an uncommitted crates/io/src/legacy_pigment/review_probe_tests.rs). After it: verify, then task #3 (release 0.5.0).
- 18:41 UTC hourly check: **L2 done and pushed** (c2243fb: adjustment, fill and shape layers open, with vector masks, layer styles and blending; CI run 44369700966 in progress). L3 (agent a92b052d21cfd92f8) is generating text and smart-object fixtures, uncommitted. Disk 13 GB free.
- **Running since 17:51 UTC:** group L's remainder, planpc/ports.js with args {"group":"L","spec":"PORTS-A.md","done":["L1"],"packages":["L2","L3"],"notes":{L2: continuation note (the cut-off engineer left make-fixtures-layers.mjs, never run), L3: remove the JS worktrees at the end}} (run wf_6b819a2a-47b, task w2hlf4hzi), then the group's review. After a stop: launch again with packages = those still to build, done = those already pushed (PKG-port-L2.md and so on exist once a package is done), a continuation note for the cut-off one.
- The JavaScript app is checked out as git worktrees in the scratchpad (js-v1 at 3731508, js-v2 at b0e43cc, js-v3 at 99dbdee; fixgen holds the node modules). L3 is told to remove them; if a run ends without that, remove them: `git worktree remove --force <path>` each, then `git worktree prune`.
- **After group L: task #3, the release of 0.5.0.** Publishing: the workflow's version job refuses a manual publish from any ref but the default branch, and Pigment's code is not on the default branch. Before publishing, change that check to also accept the release branch claude/pigment-photocraft (a few lines in the "Read the version" step and the header comment), then dispatch with tag pigment-v0.5.0 on that branch. Runs 1 to 8 of that workflow id were the JavaScript app's releases, published by workflow_dispatch with a tag from branch claude/fervent-newton-263lz3. A tag push would publish from any commit, but tag pushes were refused (403) for Nib.
- The first dry run's packages (d361bd0: the AI up to the Assistant, without the sign-in and the importer) are on https://github.com/Nihalpi1212/claude/actions/runs/44182518122 until Feb 2027; the user was told on Nov 17 23:42 that they can try them.
- `gh` works in this container through the proxy for reading runs (`gh run list --branch claude/pigment-photocraft -L 5`, `gh run view <id> --log-failed`): the engineers use it, and it is much shorter than the MCP listing.
