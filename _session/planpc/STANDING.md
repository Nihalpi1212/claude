# Pigment on PhotoCraft: standing orders (read first at every check-in)

## The user's instructions

- "i need all the features same as photoshop, dont leave anything". This is the goal.
- At about 13:00 UTC on Nov 15, the user decided to:
  - build Pigment on PhotoCraft (github.com/storytold/photocraft, Rust);
  - keep the name Pigment;
  - stop the JavaScript app. Its 0.5 work is on claude/fervent-newton-263lz3-wip05 and in git stash@{0}.
- At about 20:10 UTC on Nov 15 the user said: "Once you hit the limit, just continue it from what you have done. Nobody is going to ask you, and I am giving you permission, and I am telling you that it doesn't even matter."
  - **Standing permission:** after any usage-limit stop, resume automatically from the work done, as soon as the reset passes. Never wait for the user and never ask.
  - Keep the user informed in a few lines at milestones, but don't block on them.
- Ultracode is on: use the Workflow tool for substantive work, one cargo build at a time on this 4-CPU machine.

## The plan, in order (task ids from the task list)

1. **Rebrand (#38).** Done and pushed. It stays open until Pigment CI is green on the branch head.
2. **AI port (#39).**
   - Workflow script scratchpad/planpc/ai-port.js, brief planpc/AI-PORT.md, specs planpc/ai/PIGMENT-AI.md and INTEGRATION.md.
   - The steps run in order: P1, P2, P3, a review, P4, P5, a review, then a final check. P1 is done and pushed.
3. **Other ports (#40).**
   - The 93 rows where Pigment was ahead (scratchpad/photocraft-eval/pigment-ahead.md), minus the AI rows #39 covers.
   - The importer for Pigment 0.1 to 0.4 `.pigment` files: the typed error IoError::LegacyPigment is the hook, in crates/io/src/legacy_pigment.rs.
   - Brief: planpc/PORTS.md. Specs: planpc/ports/PORTS-A.md and PORTS-B.md (40 packages).
   - Generic workflow: planpc/ports.js, run once per group with the args listed in PORTS.md.
   - Group order: L (legacy importer), A, P, FU, BT, BR1, BR2.
   - **Release 0.5.0 (#41) comes right after the AI port and group L.** Groups A to BR2 then go into the next release (0.6.0).
   - To resume a stopped package, pass args.notes = { "<id>": "continuation note" } with the same group args, and resumeFromRunId.
4. **Release (#41).**
   - Docs: README, USER-GUIDE, release notes, and PARITY re-based on the new app (PhotoCraft's statuses from photocraft-eval/map plus the ported rows).
   - A cross-feature bug hunt with regression tests and an adversarial review.
   - Merge the latest upstream PhotoCraft first if it is cheap; docs/FORK.md has the steps.
   - CI green, then the release workflow (pigment-release.yml, tag pigment-v0.5.0) builds unsigned Windows, macOS and Linux packages.
   - Publish as a pre-release and give the user the download links.
   - If pushing the tag is refused (403, as happened for Nib), create the release through the GitHub MCP tools if they allow it. Otherwise tell the user the one step they must do.
5. **After 0.5.0.** Keep going toward full Photoshop parity: PhotoCraft's own Missing and Partial rows (photocraft-eval/map), in packages like the JavaScript Pigment's 0.6 to 0.11 plan.

## Resuming after a stop (usage limit, worker restart, TaskStop)

- Back up: scratchpad/planpc/snapshot.sh "what". It pushes the working tree to claude/pigment-photocraft-wip and doesn't touch HEAD.
- Digest the stopped agent: python3 scratchpad/plan05/digest-agent.py <agent-*.jsonl> <out.md> <package> <agent id> <run id>.
- Add a continuation note to that agent's prompt only, in the workflow script (back the script up first). Then Workflow({ scriptPath, resumeFromRunId }); completed agents replay from the cache.
- If the reset hasn't passed, schedule a check-in (send_later) just after the reset time the error names.

## Rules

- **Pushing.** Agents commit locally and never push. I verify, then push claude/pigment-photocraft. Never commit an agent's uncommitted files. When the stop hook asks to commit while agents work, run snapshot.sh and say so.
- **Commit trailers:**
  - Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  - Claude-Session: https://claude.ai/code/session_012irzNNBVSJyVqHJpCPbdwm
- **CI.** Pigment CI (.github/workflows/pigment-ci.yml) must be green on pushed heads. The Tests step repeats failures at its end; read them with mcp__github__get_job_logs (job_id, return_content, tail_lines 3000).
  - Never skip a test to get green.
  - The one exception is pigment/scripts/upstream-test-failures.txt: 60 tests that fail on untouched upstream too; the 10 format ones were verified on /home/user/storytold/photocraft.
- **Disk.** The real quota is about 39 GB; `df` misreports it as 252 GB. Below 6 GB free, delete the test executables over 20 MB in pigment/target/debug/deps and target/debug/incremental. Never `cargo clean`.
- **GitHub.** Use only the mcp__github__* tools (repo Nihalpi1212/claude). The user's email is private. No PR unless the user asks.
