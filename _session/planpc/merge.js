export const meta = {
  name: 'pigment-upstream-merge',
  description: 'Merge the latest upstream PhotoCraft into Pigment: plan the merge in a scratch copy, do it on a merge branch, then verify and fast-forward the release branch',
  phases: [
    { title: 'Plan', detail: 'a trial apply in a scratch worktree; the hand-merge list; the API changes Pigment must follow' },
    { title: 'Merge', detail: 'the merge on claude/pigment-upstream-merge, built and tested' },
    { title: 'Verify', detail: 'CI green, the rebrand and Pigment features checked, then claude/pigment-photocraft fast-forwarded' },
  ],
}

// Restartable: args.steps lists the steps still to run (default: all), args.notes maps a step id
// ('plan', 'merge', 'verify') to a continuation note. The plan is written to
// planpc/build/MERGE-PLAN.md, the merge's notes to PKG-merge.md, the review's to REV-merge.md.
const SCR = '/tmp/claude-0/-home-user-claude/02aa60de-818c-5d38-b2f3-33055ac112a1/scratchpad'
const B = `${SCR}/planpc/build`
const BRIEF = `${SCR}/planpc/PORTS.md`
const A = args || {}
const STEPS = A.steps || ['plan', 'merge', 'verify']
const NOTES = A.notes || {}
const note = (id) => (NOTES[id] ? `\n\n${NOTES[id]}` : '')

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    newRevision: { type: 'string' },
    numbers: { type: 'string' },
    strategy: { type: 'string' },
    handMerge: { type: 'array', items: { type: 'string' } },
    apiChanges: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    estimate: { type: 'string' },
  },
  required: ['newRevision', 'numbers', 'strategy', 'handMerge', 'apiChanges', 'risks', 'estimate'],
}
const WORK_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    commits: { type: 'array', items: { type: 'string' } },
    tests: { type: 'string' },
    checks: { type: 'string' },
    notDone: { type: 'array', items: { type: 'string' } },
    forNext: { type: 'string' },
  },
  required: ['summary', 'commits', 'tests', 'checks', 'notDone', 'forNext'],
}
const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['merged', 'not merged'] },
    reasons: { type: 'string' },
    findings: { type: 'array', items: { type: 'object', properties: { severity: { type: 'string' }, where: { type: 'string' }, issue: { type: 'string' }, fixed: { type: 'boolean' }, how: { type: 'string' } }, required: ['severity', 'where', 'issue', 'fixed', 'how'] } },
    checks: { type: 'string' },
    commits: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'reasons', 'findings', 'checks', 'commits'],
}

const APP = `Pigment is the Rust app in /home/user/claude/pigment (repository /home/user/claude, release branch claude/pigment-photocraft, published as Pigment 0.5.0 from commit f4e3ffa). It is PhotoCraft (github.com/storytold/photocraft), imported at upstream revision abb30df (pigment/UPSTREAM-REVISION) as a plain copy into pigment/ in commit 15b8ea5 (no shared git history with upstream), then rebranded as Pigment, with Pigment's generative AI and its importer of Pigment 0.1–0.4 documents added: 67 commits since the import, 787 files changed. pigment/docs/FORK.md is the map: what the rebrand changed (by scripts/pigment-rebrand.py and by hand, in tables), every hook Pigment placed in an upstream file, and the section "Merging a later upstream revision", which is the method to follow. Upstream moves fast: on Nov 18 its main (6dbe43e) was 1,760 files, +127k and −278k lines past abb30df.`

function plan() {
  return agent(`You plan the merge of the latest upstream PhotoCraft into Pigment. ${APP}

**Don't change /home/user/claude's working tree or its branches**: a release has just been built from it, and another engineer will do the merge there after you. Work in the scratchpad:
- the upstream clone at /home/user/storytold/photocraft (shallow; \`git fetch origin main\` brings upstream's head; the diff needs only abb30df's and the new revision's trees, so don't unshallow it: the disk is tight, about 7 GB free);
- a scratch worktree of the release branch for trial applies: \`git -C /home/user/claude worktree add --detach ${SCR}/merge-trial claude/pigment-photocraft\` (about 85 MB). Remove it when you are done (\`git -C /home/user/claude worktree remove --force ${SCR}/merge-trial\`).
Don't run cargo.

1. Choose NEW, upstream main's head now, and record it.
2. Make the patch as FORK.md's step 2 says, and try \`git apply --3way --directory=pigment\` in the scratch worktree. Count the files applied cleanly, the files with conflicts, and the hunks that failed (renamed files, files Pigment deleted or renamed). List new and deleted crates; changes to Cargo.toml and Cargo.lock (new dependencies, a newer Rust toolchain or rust-version, new system libraries); and changes to the craft-libs pins, craft-i18n.rev and the craft-fonts commit that CI pins.
3. Sort the upstream files that Pigment also changed since the import (\`git diff --stat 15b8ea5..claude/pigment-photocraft -- pigment/\`, leaving out Pigment's new files) into two kinds. Files whose only Pigment change is what the rebrand script writes: take upstream's new version and run the script again. Files changed by hand (hooks, and the hand-done rebrand in FORK.md's tables): these need a three-way merge by hand. List each hand-changed file that upstream also changed, with what upstream changed there and how to merge it.
4. Check Pigment's own code against upstream's API changes: the AI (crates/engine/src/cmd/ai_cmds/, the generative seam, crates/genai, crates/ui-egui/src/ai_ui*, apps/photocraft-cli/src/ai.rs, the automation wiring), the importer (crates/io/src/legacy_pigment/, crates/engine/src/legacy_pigment_render.rs, crates/ui-egui/src/dialogs/legacy_save_prompt.rs) and every hook. Which upstream types, functions, modules and command ids they use changed, moved or disappeared at NEW? (Grep NEW's tree in the upstream clone.)
5. What else FORK.md's steps 5 to 9 ask of this merge: the rebrand pass and new strings that name the product, the version line (upstream's version at NEW), UPSTREAM-REVISION, new update paths or network requests, new files in the settings folder, the upstream test-failure list. And what upstream changed in what CI runs: .config/nextest.toml, the xtask checks (layers table, panel commands, scorecard), the panic hunt, new tests that need files or services.

Write ${B}/MERGE-PLAN.md for the engineer who does the merge: NEW; the numbers; the strategy; the hand-merge list with a note per file; the API changes Pigment's code must follow; the order of work, in steps that each end with something that builds; the risks; and an estimate of the work. Return the schema.${note('plan')}`, { label: 'plan', phase: 'Plan', schema: PLAN_SCHEMA, effort: 'high' })
}

function merge() {
  return agent(`You merge the latest upstream PhotoCraft into Pigment. ${APP}

Read ${B}/MERGE-PLAN.md first (the revision NEW, the strategy, the hand-merge list, the API changes Pigment's code must follow, the order of work), then FORK.md's "Merging a later upstream revision", then the rules in ${BRIEF} (section "Rules for every package": builds, disk, checks, commits with the two trailer lines, snapshots). They all apply, with these differences for this job:
- **Work on a new branch, claude/pigment-upstream-merge**, made from claude/pigment-photocraft in /home/user/claude (\`git checkout -b claude/pigment-upstream-merge claude/pigment-photocraft\`). Never push to claude/pigment-photocraft: the reviewer after you fast-forwards it once CI is green.
- Commit and push to the merge branch only states that build (\`cargo build --locked -p photocraft -p photocraft-cli -p xtask\`, -j 4, CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0). Pigment CI runs on every push to any branch; a red run on the merge branch is information for you, not a broken release. Between such commits, back up with snapshot.sh at least every 30 minutes.
- **Disk:** about 7 GB are free and the quota is about 39 GB in all. A merge this size rebuilds nearly everything, and the old build would stay beside the new one, so delete pigment/target once before the first build after applying the merge (the brief's "never cargo clean" is for warm builds; this one is cold anyway). A cold build takes 25 to 40 minutes here.
- Keep everything Pigment has: its names, ids, folders, links, the update behaviour (no request on its own), the agents gate, the generative AI and the importer. Take upstream's other changes. Fix Pigment's code where upstream's APIs moved.

Done means: the merge branch builds; \`cargo fmt --all -- --check\` and \`cargo clippy --workspace --all-targets --locked --features heif -- -D warnings\` are clean; \`python3 scripts/pigment-rebrand.py --check\` and FORK.md's step-5 checks are clean; the tests of every crate Pigment changed pass (genai, the engine's ai_cmds and generative and the panic hunt, ui-egui's ai, ai_assistant and legacy_pigment tests, io's legacy_pigment, automation, photocraft-cli, photocraft, format) apart from container-only failures; \`cargo xtask layers\`, \`panel-commands\` and \`scorecard --check\` pass; \`pigment --version\` and \`pigment-cli --version\` print the new upstream version in the version line; FORK.md, UPSTREAM-REVISION and scripts/upstream-test-failures.txt are updated; and all of it is pushed to the merge branch. Write ${B}/PKG-merge.md (what you did, every hand merge and why, what you changed in Pigment's code, what you could not do). Return the schema. Don't wait for CI on your last push: the reviewer checks it.${note('merge')}`, { label: 'merge', phase: 'Merge', schema: WORK_SCHEMA, effort: 'high' })
}

function verify() {
  return agent(`You check the upstream merge before it goes into Pigment's release branch. ${APP} The merge is on branch claude/pigment-upstream-merge in /home/user/claude; read ${B}/MERGE-PLAN.md and ${B}/PKG-merge.md, then the rules in ${BRIEF} (section "Rules for every package"; they apply to you).

Be a skeptic. Check:
1. **CI** on the merge branch (\`gh run list --branch claude/pigment-upstream-merge -L 5\`, \`gh run view <id> --log-failed\`): get it green. Fix what is red in commits on the merge branch; never skip a test (scripts/upstream-test-failures.txt is only for tests that fail on upstream's own tree at NEW, which you must show).
2. **The rebrand held:** FORK.md's step-5 checks, the version line, the folders and their clash table, links, the packaging files (desktop entry, metainfo, MIME, WiX, Info.plist, nfpm), and no PhotoCraft name in what a person sees.
3. **No request on its own:** FORK.md's step 7. Grep NEW's new code for HTTP clients, update checks, telemetry and downloads at launch.
4. **Pigment's features still work:** the AI and importer tests, the CLI smoke test of pigment-ci.yml run by hand, and a look at each hook FORK.md lists against the merged code.
5. **The hand merges** in PKG-merge.md: pick three of the riskiest and compare them with upstream's NEW and Pigment's old version line by line.
Fix what you find, with tests where they apply, in commits on the merge branch. When the merge branch's head is green in CI, bring it into the release branch **without rewriting history**: if claude/pigment-photocraft has no commits the merge branch lacks, \`git push origin claude/pigment-upstream-merge:claude/pigment-photocraft\` (a fast-forward); otherwise merge claude/pigment-photocraft into the merge branch, push, wait for CI to be green on that, then fast-forward. Then check out claude/pigment-photocraft in /home/user/claude at the new head. Write ${B}/REV-merge.md. Return the schema: merged or not merged, with the reasons.${note('verify')}`, { label: 'verify', phase: 'Verify', schema: VERIFY_SCHEMA, effort: 'high' })
}

const out = {}
if (STEPS.includes('plan')) { phase('Plan'); out.plan = await plan() }
if (STEPS.includes('merge')) { phase('Merge'); out.merge = await merge() }
if (STEPS.includes('verify')) { phase('Verify'); out.verify = await verify() }
return out
