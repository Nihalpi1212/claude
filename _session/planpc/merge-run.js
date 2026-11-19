export const meta = {
  name: 'pigment-upstream-merge-run',
  description: 'Merge upstream PhotoCraft 057297b into Pigment step by step on branch claude/pigment-merge-057297b, following planpc/build/MERGE-PLAN.md, then verify and fast-forward the release branch',
  phases: [
    { title: 'Merge', detail: 'one engineer per step of the plan (import, engine, automation, CLI, interface, app, AI interface in three parts, rebrand, CI)' },
    { title: 'Verify', detail: 'CI green, the rebrand and Pigment features checked, then claude/pigment-photocraft fast-forwarded' },
  ],
}

// Restartable: args.steps lists the steps still to run, in order (default: all), and args.notes maps a
// step id to a continuation note for a step that was cut off. Each step writes
// planpc/build/PKG-merge-<step>.md; the verifier writes REV-merge.md.
const SCR = '/tmp/claude-0/-home-user-claude/02aa60de-818c-5d38-b2f3-33055ac112a1/scratchpad'
const B = `${SCR}/planpc/build`
const BRIEF = `${SCR}/planpc/PORTS.md`
const PLAN = `${B}/MERGE-PLAN.md`
const BRANCH = 'claude/pigment-merge-057297b'
const A = args || {}
const ALL = ['import', 'engine', 'automation', 'cli', 'ui', 'app', 'ai-ui-1', 'ai-ui-2', 'ai-ui-3', 'rebrand', 'ci']
const STEPS = A.steps || [...ALL, 'verify']
const NOTES = A.notes || {}
const note = (id) => (NOTES[id] ? `\n\n${NOTES[id]}` : '')

const WORK_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    finished: { type: 'boolean' },
    commits: { type: 'array', items: { type: 'string' } },
    tests: { type: 'string' },
    checks: { type: 'string' },
    notDone: { type: 'array', items: { type: 'string' } },
    forNext: { type: 'string' },
  },
  required: ['summary', 'finished', 'commits', 'tests', 'checks', 'notDone', 'forNext'],
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

const APP = `Pigment is the Rust app in /home/user/claude/pigment (repository /home/user/claude). Its release branch is claude/pigment-photocraft; Pigment 0.5.0 was published from commit f4e3ffa. It is PhotoCraft (github.com/storytold/photocraft), imported at upstream revision abb30df as a plain copy into pigment/ (no shared git history), rebranded as Pigment, with Pigment's generative AI and its importer of Pigment 0.1–0.4 documents added. pigment/docs/FORK.md is the map of what Pigment changed and every hook it placed.

Upstream has since rebuilt much of its interface on the craft framework. You take part in merging upstream's main at **057297bb0b0872244ac0910e640db8d87e46572f** (NEW) into Pigment, on the branch **${BRANCH}**. The plan is ${PLAN}: read it whole before you start (the strategy in §3, the hand-merge list in §4, the API changes in §5, the order of work in §6 with what each step must build, FORK.md's steps 5–9 for this merge in §7, the risks in §8).`

const RULES = `Rules (the brief ${BRIEF}, section "Rules for every package", applies, with these differences for the merge):
- **Work on ${BRANCH} only.** Never push to claude/pigment-photocraft: the verifier fast-forwards it at the end, once CI is green.
- **Commit at the end of your step at the latest**, with the brief's two trailer lines, and push to ${BRANCH}; commit earlier whenever a coherent part builds. Pigment CI runs on every push; on the merge branch it is expected to stay red until the desktop app builds again (the 'app' step) and the AI tests run (the 'ai-ui' steps): don't chase it before then. Back up with snapshot.sh at least every 30 minutes.
- **Builds:** one cargo process at a time, -j 4, with CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_STRIP=symbols (upstream's test build is about 19 GB without stripping). Tests with TMPDIR=/dev/shm/pt (mkdir it if missing) and CI's CRAFT_I18N_DIR=/home/user/storytold/craft-i18n; CRAFT_FONTS_DIR must be craft-fonts at the commit the plan names for NEW (check out that commit in /home/user/storytold/craft-fonts if it isn't there yet; it is a git clone).
- **Disk:** the quota is about 39 GB in all and \`df\` misreports it; keep at least 5 GB free (\`df -h /\`). When less is free, delete the test executables in pigment/target/debug/deps (\`find pigment/target/debug/deps -maxdepth 1 -type f -perm -u+x -size +20M -delete\`) and pigment/target/debug/incremental.
- **Keep Pigment's promises** (FORK.md): its names, ids, folders, links, no network request on its own (no update check at launch, no self-update), the agents gate (off by default, never the ArtCraft Launcher), the generative AI, the importer, the legacy save prompt. Take upstream's other changes. Where upstream moved code onto the framework, place Pigment's hook on the new code rather than keeping the old block.
- **Decisions already taken** (by the orchestrator, Nov 19):
  - D1, the agents page: keep Pigment's own switch ("Let AI apps use this window", off by default) as its own row; draw the framework's page with \`mcp_flag(true)\` so the folders and When Closed stay reachable, and override its two words (\`agents.intro\`, \`agents.off\`) so nothing names the ArtCraft Launcher; never call \`agents::mcp_flag()\` or \`launcher_allows()\`, never start \`AgentSwitch::watch\`. AI Accounts… and "Allow agents to run AI commands" go into custom_rows.rs.
  - D2, feature names: keep the labels Pigment has (Generative Fill…, Generative Expand, …) for this merge; upstream's naming rule (AGENTS.md "Our features use our own names") is a question for the owner, asked separately. Ids never change.
  - D3, the version line: print the upstream revision too, as the plan suggests: \`Pigment 0.5.x (based on PhotoCraft 0.23.1+057297b)\`, keeping CI's smoke-test pattern true.
  - D4, the theme folder: Pigment's own (\`<settings folder>/Themes\` through \`SuiteDir::at\`), never ArtCraft's.
- **Hand-off:** write ${B}/PKG-merge-<your step>.md for the next engineer: what you did, every hand merge and why, what you changed in Pigment's code, the tests and checks with their results, what is left. Earlier steps' notes are ${B}/PKG-merge-*.md: read them first. If your step can't be finished in your session, commit what builds, push, write in the notes exactly where you stopped and what is in the tree, and return with finished=false: the next run continues from there.`

const STEP_TEXT = {
  import: `**Your step: §6 steps 0 and 1, the setup and the import commit.** Make ${BRANCH} from claude/pigment-photocraft (\`git -C /home/user/claude switch -c ${BRANCH} claude/pigment-photocraft\`; the tree must be clean first). Make the patch as the plan says (the upstream clone at /home/user/storytold/photocraft is shallow; fetch NEW by its sha). Apply it with the 13 exclusions of §4.1, \`git rm\` those 13, take upstream's blob for the 25 script-only conflicts, resolve the manifests (Cargo.lock from upstream, then let cargo add Pigment's packages without \`cargo update\`), and commit as §6 step 1 says: upstream's change alone, with the 34 hand-merge files resolved to upstream's side and a TODO list in your notes (or with their conflict markers, if you judge review needs them; say which), so the next steps merge each by hand. **Delete pigment/target once before the first build** (a merge this size rebuilds nearly everything, and the old build would stay beside the new one). Then make the lower layers build and test as §6 step 1 says (cargo metadata; cargo check of format, io and raw; the importer's tests: \`cargo test -p photocraft-io legacy_pigment\`).`,
  engine: `**Your step: §6 step 2, the engine.** lib.rs, shell_commands.rs, build_info::RELEASES pointing at Pigment's releases, then every engine hook of §4.2. Done when \`cargo test -p photocraft-engine --features testgen\` passes (with ai_cmds and generative) and the panic hunt passes (\`cargo test -p photocraft-engine --test panic_hunt -- --ignored\`).`,
  automation: `**Your step: §6 step 3, pigment-genai and automation.** agent_link.rs, live.rs, security.rs and args.rs (Pigment's own PIGMENT_* variable names stay; FORK.md lists them), genai.rs, and the agents decisions D1 where they reach automation. Done when \`cargo test -p pigment-genai -p photocraft-automation\` passes, the importer's tests in automation included.`,
  cli: `**Your step: §6 step 4, the command line.** automation.rs (keep Pigment's condition for live MCP), document.rs, and whatever else §4.2 lists for apps/photocraft-cli. Done when \`cargo build -p photocraft-cli\` works, \`pigment-cli --version\` prints Pigment's line, and \`cargo test -p photocraft-cli\` passes (ai, legacy_pigment, the man pages), and the steps of the "CLI smoke test" in .github/workflows/pigment-ci.yml pass when run by hand.`,
  ui: `**Your step: §6 step 5, the interface without the AI windows.** Resolve the ui-egui files of §4.2 on upstream's code. Turn ai_ui into a stub with the same hook signatures (no windows; None or false), so the rest builds; the three ai-ui steps after the 'app' step port it back. Port legacy_save_prompt (§5.2), About, links, the start screen, updates_ui (no check at launch, ever), the agents page (decision D1), the theme folder (D4). Done when \`cargo test -p photocraft-ui-egui\` passes apart from the AI tests the stub disables (list them), with the legacy_pigment interface test passing.`,
  app: `**Your step: §6 step 6, the desktop app.** main.rs, services.rs and its tests, PRESETS_DIR stays "Preset Library", no AgentSwitch::watch, no self-update, ai_ui::install kept. Done when \`cargo build -p photocraft\` works, \`pigment --version\` prints the line of decision D3, and a start on a scratch PIGMENT_CONFIG_DIR (headless where it must be) leaves only Pigment's files in that folder and nothing under any ArtCraft folder; record what you looked at.`,
  'ai-ui-1': `**Your step: §6 step 7, part 1 of 3: the AI interface's core.** Port, from the stub back to working code on the framework (§5.1): ai_ui.rs (menu items as craft::menu Rows, show, on_job_event, install, the control Reply), the Generate window (generate.rs), AI Accounts (accounts.rs, with D1's rows where they belong) and Describe Image, and the parts of crates/ui-egui/tests/it/ai.rs that drive them. Leave the task bars and the Assistant stubbed for parts 2 and 3. Done when those tests pass and \`cargo clippy -p photocraft-ui-egui --all-targets -- -D warnings\` is clean.`,
  'ai-ui-2': `**Your step: §6 step 7, part 2 of 3: the AI task bars.** Port ai_ui/task_bar.rs onto the framework: the selection bar's Generate, Generative Expand in the Crop tool's task bar (craft::ui::canvas_controls::TaskBar, as tools/crop_task_bar.rs does; the crop frame from crop_task_bar::eligible or the crop tool's frame), Generate Background after Remove Background; and the rest of crates/ui-egui/tests/it/ai.rs. Done when all of tests/it/ai.rs passes and clippy is clean.`,
  'ai-ui-3': `**Your step: §6 step 7, part 3 of 3: the Assistant.** Port ai_ui/assistant.rs and the interface parts of assistant_tools.rs (the dialog wait now asks app.dialog_open() or the dialog host; the model picker without craft_ui::ComboBox), and crates/ui-egui/tests/it/ai_assistant.rs. Done when \`cargo test -p photocraft-ui-egui --test it -- ai ai_assistant legacy_pigment\` and the ai_ui unit tests pass, nothing of the AI is stubbed any more, and clippy is clean.`,
  rebrand: `**Your step: §6 step 8, the rebrand pass and the documents.** FORK.md's step 5 (the script, --check, the two rg checks, new \`///\` in the clap and MCP files, new user messages that name .pcraft and should name .pigment too), §7's rebrand list (decide each named case and record it), step 6 (UPSTREAM-REVISION, FORK.md's revision and "Upstream after the import", every hook table updated for the hooks that moved), step 7 (the endpoint and the settings-folder clash tables, the new environment variables). Done when \`python3 scripts/pigment-rebrand.py --check\` is clean and \`cargo build -p photocraft -p photocraft-cli\` works.`,
  ci: `**Your step: §6 step 9, CI and the full gate.** .github/workflows/pigment-ci.yml and pigment-release.yml as the plan says (the craft-fonts pin, test stripping, the new xtask checks egui-fork and test-binaries, moving crates/genai/tests/genai/ to tests/it/, upstream's .config/nextest.toml), and FORK.md step 9 on scripts/upstream-test-failures.txt (drop the tests that no longer exist or now pass, and show it). Run the gate locally as far as this machine allows: fmt, \`cargo clippy --workspace --all-targets --locked --features heif -- -D warnings\`, the rebrand check, every xtask check CI runs, \`cargo test -p xtask\`, the tests of every crate Pigment changed, the panic hunt, the CLI smoke test. Push, then watch CI on ${BRANCH} until it is green, fixing what is red (\`gh run list --branch ${BRANCH} -L 4\`, \`gh run view <id> --log-failed\`).`,
}

function step(id) {
  return agent(`${APP}

${STEP_TEXT[id]}

${RULES}

Return the schema; finished is true only when your step's "done" holds.${note(id)}`, { label: `merge:${id}`, phase: 'Merge', schema: WORK_SCHEMA, effort: 'high' })
}

function verify() {
  return agent(`${APP}

**You are the verifier, after every step of the merge** (their notes are ${B}/PKG-merge-*.md). Be a skeptic. Check:
1. **CI** on ${BRANCH}: green on its head. Fix what is red, in commits on the merge branch; never skip a test (scripts/upstream-test-failures.txt is only for tests that fail on upstream's own tree at NEW, which you must show).
2. **The rebrand held:** FORK.md's step-5 checks, the version line, the folders and their clash table, links, the packaging files (desktop entry, metainfo, MIME, WiX, Info.plist, nfpm), and no PhotoCraft or ArtCraft name in what a person sees.
3. **No request on its own:** FORK.md's step 7; grep NEW's new code for HTTP clients, update checks, telemetry and downloads at launch, and trace each to whether it can run without the person asking.
4. **Pigment's features:** the AI and importer tests, the CLI smoke test of pigment-ci.yml by hand, and each hook FORK.md lists against the merged code.
5. **The hand merges:** pick three of the riskiest in the notes and compare them with upstream's NEW and Pigment's old version line by line.
Fix what you find, with tests where they apply, in commits on the merge branch (the rules below apply). When the merge branch's head is green in CI, bring it into the release branch **without rewriting history**: if claude/pigment-photocraft has no commits that ${BRANCH} lacks, \`git push origin ${BRANCH}:claude/pigment-photocraft\` (a fast-forward); otherwise merge claude/pigment-photocraft into ${BRANCH}, push, wait for CI to be green on that, then fast-forward. Then switch /home/user/claude to claude/pigment-photocraft at the new head. Write ${B}/REV-merge.md. Return the schema: merged or not merged, with the reasons.

${RULES}${note('verify')}`, { label: 'verify', phase: 'Verify', schema: VERIFY_SCHEMA, effort: 'high' })
}

const out = {}
phase('Merge')
for (const id of STEPS.filter((s) => s !== 'verify')) {
  const r = await step(id)
  out[id] = r
  if (!r || !r.finished) {
    log(`Step ${id} did not finish (${r ? 'finished=false' : 'no result'}); stopping so it can be continued with a note.`)
    return out
  }
}
if (STEPS.includes('verify')) {
  phase('Verify')
  out.verify = await verify()
}
return out
