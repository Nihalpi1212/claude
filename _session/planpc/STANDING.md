# Pigment on PhotoCraft: standing orders (read first at every check-in)

SCR = /tmp/claude-0/-home-user-claude/02aa60de-818c-5d38-b2f3-33055ac112a1/scratchpad

## The user's instructions

- "i need all the features same as photoshop, dont leave anything". This is the goal.
- Nov 15, about 13:00 UTC: build Pigment on PhotoCraft (github.com/storytold/photocraft, Rust), keep the name Pigment, stop the JavaScript app (its history is on claude/fervent-newton-263lz3, its unfinished 0.5 on claude/fervent-newton-263lz3-wip05).
- Nov 15, about 20:10 UTC: "Once you hit the limit, just continue it from what you have done. Nobody is going to ask you, and I am giving you permission, and I am telling you that it doesn't even matter."
  - **Standing permission:** after any usage-limit stop, resume automatically from the work done. Never wait for the user and never ask.
  - Keep the user informed in a few lines at milestones, but don't block on them.
- Nov 17: the user switched the session to the model claude-fable-5-2 and said "Try again".
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
- **Commit trailers** (changed on Nov 17 with the model):
  - Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>
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

- Nov 17, 23:42 UTC, hourly check. The limit window that began at 21:10 UTC is in use; the one before it ran out after about two hours of one engineer. The hourly check fires at :39 (trig_0177jAfVM7gN5HetzTvbeyX5).
- **AI port.** Done and pushed: P1, P2, P3, review123, P4 (the Assistant, d39ce30..d361bd0) and **P5, Sign in with ChatGPT** (8a526b7, 9811c96, fe3e942, 3a4f755; notes planpc/build/PKG-ai-P5.md). CI: green on 8a526b7 (run 184); run 186 on the head 3a4f755 was in progress at 23:42 and the P5 engineer was only waiting for it.
- **Running since 21:43:** planpc/ai-port-2.js with args {"steps":["P5","review45","final"]} (run wf_32ac36c7-d2a, task wnijpu0cx). review45 and final follow by themselves. If the workflow stops, launch it again with the steps not yet done (planpc/build/PKG-ai-review45.md and PKG-ai-final.md exist once those are done), with a continuation note for the cut-off step. P5 needs no rerun.
- **Release dry run: green on all three platforms** (run 44182518122 on d361bd0, 68 minutes, the first run ever of pigment-release.yml on the Rust app): macOS universal DMG and CLI zip (artifact 408 MB), Windows MSI, portable zip and symbols (277 MB), Linux AppImage, deb and tar.gz (427 MB), each with its checks. The artifacts are on https://github.com/Nihalpi1212/claude/actions/runs/44182518122 until Feb 2027. The user was told at 23:42 that they can try this build.
- **For task #3 (publishing):** the workflow's version job refuses a manual publish from any ref but the default branch, and Pigment's code is not on the default branch. Before publishing 0.5.0, change that check to also accept the release branch claude/pigment-photocraft (a few lines in the "Read the version" step and the header comment), then dispatch with tag pigment-v0.5.0 on that branch. Runs 1 to 8 of that workflow id were the JavaScript app's releases, published by workflow_dispatch with a tag from branch claude/fervent-newton-263lz3. A tag push would publish from any commit, but tag pushes were refused (403) for Nib.
- Left open on purpose or small, from the review of P1 to P3: a script the person runs can send after consent; Stop doesn't abort a sent HTTP request; memory for document-size results on very large canvases; no model list in the Generate window. P4's and P5's "Not done" lists are in their notes (no i18n rows; the release notes and README still say the AI is not in 0.5.0, for the docs step of task #3; the sign-in was never checked against the live service).
- Next after the AI port: group L (legacy .pigment importer) with planpc/ports.js, then release 0.5.0.
