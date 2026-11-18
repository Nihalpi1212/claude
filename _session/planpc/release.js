export const meta = {
  name: 'pigment-release-0-5',
  description: 'Prepare Pigment 0.5.0 for release: a bug hunt by area with the docs and parity pass, fixes with tests, then a final review and the release workflow made ready to publish',
  phases: [
    { title: 'Hunt', detail: 'read-only bug finders by area, and the docs and parity writer' },
    { title: 'Fix', detail: 'one engineer per area, in order of severity: reproduce with a test, fix, push' },
    { title: 'Review', detail: 'the last checks, the docs against the code, the release workflow ready to publish' },
  ],
}

// Restartable: args.steps lists the steps still to run (default: all), args.areas the areas the
// fix step works through and in what order (default: by severity found), and args.notes maps a
// step id ('hunt-<area>', 'docs', 'fix-<area>', 'review') to a continuation note. The findings are
// also written to planpc/build/hunt-<area>.json, so a restarted fix step reads them from there.
const SCR = '/tmp/claude-0/-home-user-claude/02aa60de-818c-5d38-b2f3-33055ac112a1/scratchpad'
const B = `${SCR}/planpc/build`
const BRIEF = `${SCR}/planpc/PORTS.md`
const A = args || {}
const STEPS = A.steps || ['hunt', 'fix', 'review']
const NOTES = A.notes || {}
const note = (id) => (NOTES[id] ? `\n\n${NOTES[id]}` : '')

const AREAS = [
  { id: 'importer', title: 'the importer of Pigment 0.1–0.4 documents', scope: 'crates/io/src/legacy_pigment/ (container, layers, adjust, gradient, paint, styles, text, smart, filters, info, path, blend), crates/engine/src/legacy_pigment_render.rs, crates/ui-egui/src/dialogs/legacy_save_prompt.rs, and the open and save paths that reach them (File › Open, drag and drop, recent files, the command line, the control channel). The review of the importer left two of Pigment\'s own items open: closing or quitting a changed legacy document and choosing Save needs a second Save, and still_legacy reads the whole file at every Save. Report them as findings, with the fix, if you judge them worth fixing for 0.5.0.', notes: 'PKG-port-L1.md, PKG-port-L2.md, PKG-port-L3.md and PKG-port-review-L.md' },
  { id: 'ai-engine', title: 'the AI engine commands', scope: 'crates/engine/src/cmd/ai_cmds/ (every ai.* command and its params), the generative seam and its MockBackend (crates/engine/src/generative*), and how they use selections, masks, regions, layers, smart objects, undo, the document lock, cancellation and background jobs', notes: 'PKG-ai-P1.md, PKG-ai-review123.md and PKG-ai-final.md' },
  { id: 'ai-providers', title: 'the AI provider crate and the command line', scope: 'crates/genai (pigment-genai): the OpenAI and Gemini requests and answers, Sign in with ChatGPT (chatgpt.rs), the key store (keys.rs, the chunked Windows store), consent and settings (ai.json), redaction of keys and tokens, size bounds, timeouts, how the backend admits each caller; the automation wiring and apps/photocraft-cli/src/ai.rs', notes: 'PKG-ai-P2.md, PKG-ai-P5.md, PKG-ai-review45.md and PKG-ai-final.md' },
  { id: 'ai-ui', title: 'the AI interface and the Assistant', scope: 'crates/ui-egui/src/ai_ui.rs and ai_ui/ (the menu items, the Generate window, AI Accounts, Describe, the task bars, the Assistant window, its tools and its turn), the hooks into upstream interface files that FORK.md lists for them, and what synthetic input and agents can do there', notes: 'PKG-ai-P3.md, PKG-ai-P4.md, PKG-ai-review45.md and PKG-ai-final.md' },
  { id: 'cross', title: 'where the new features meet the rest of the editor', scope: 'the AI features and the importer used together with the rest of Pigment: 16- and 32-bit documents; Grayscale, CMYK, Lab, Indexed, Duotone and Bitmap modes; smart objects; layer and vector masks; artboards; history and undo (one step per action); actions and batch (recording and playback); the control channel and MCP tools (agents); several open documents; closing or switching a document while a job runs; autosave and crash recovery of documents with AI results or imported content; the web build (wasm) and what it must hide', notes: 'PKG-ai-final.md and PKG-port-review-L.md' },
  { id: 'release', title: 'the rebrand, the packages and the release', scope: 'what a person meets when they install and start Pigment 0.5.0: the binaries, the version line, the About box, the application id; the .pigment and .pcraft file associations, MIME types and icons on Windows (WiX), macOS (Info.plist, UTIs) and Linux (desktop entry, metainfo, shared-mime-info); the settings, cache, log and crash-recovery folders (nothing may be shared with an installed PhotoCraft); any network request made without the person asking (update checks, telemetry, crash upload, downloads at launch); links that still lead to upstream\'s issue tracker or update feed; packaging/; scripts/pigment-rebrand.py; .github/workflows/pigment-ci.yml and pigment-release.yml (which will publish 0.5.0: its version job, tags, notes, checksums)', notes: 'pigment/docs/FORK.md' },
]
const byId = Object.fromEntries(AREAS.map((a) => [a.id, a]))

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          where: { type: 'string' },
          issue: { type: 'string' },
          scenario: { type: 'string' },
          test: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['id', 'severity', 'where', 'issue', 'scenario', 'test', 'fix'],
      },
    },
    checked: { type: 'string' },
  },
  required: ['findings', 'checked'],
}
const DOCS_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    commits: { type: 'array', items: { type: 'string' } },
    sample: { type: 'string' },
    notDone: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'commits', 'sample', 'notDone'],
}
const FIX_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, reproduced: { type: 'boolean' }, fixed: { type: 'boolean' }, commit: { type: 'string' }, why: { type: 'string' } },
        required: ['id', 'reproduced', 'fixed', 'commit', 'why'],
      },
    },
    checks: { type: 'string' },
    commits: { type: 'array', items: { type: 'string' } },
  },
  required: ['results', 'checks', 'commits'],
}
const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['go', 'no-go'] },
    reasons: { type: 'string' },
    checks: { type: 'string' },
    commits: { type: 'array', items: { type: 'string' } },
    leftFor06: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'reasons', 'checks', 'commits', 'leftFor06'],
}

const APP = 'Pigment is the Rust app in /home/user/claude/pigment, on branch claude/pigment-photocraft: PhotoCraft 0.23.1 rebranded as Pigment, plus Pigment\'s generative AI and its importer of the documents Pigment 0.1–0.4 (the JavaScript app) wrote. pigment/docs/FORK.md lists what Pigment added and every hook into an upstream file.'
const NO_CARGO = 'Do not run cargo: other engineers build here, one build at a time on four CPUs. You may read, grep, use git, run python3, and run the binaries already built in pigment/target/debug (with TMPDIR=/dev/shm/pt).'

function hunt(a) {
  return agent(`You hunt for bugs before Pigment 0.5.0 is released. ${APP}

Your area: **${a.title}**: ${a.scope}.

Read FORK.md, then the notes for your area in ${B}/ (${a.notes}): they say what was built and tested, and what was left open on purpose. PKG-ai-final.md has the full list of known open items of the AI work; don't report those again unless you judge one must block the release, and then say why.

Find real defects that a person, a hostile or damaged file, or an odd answer from a provider can hit: crashes and panics, hangs, data loss, wrong pixels, an edit that Undo can't undo, a key or token that leaks, money spent without the person's consent, a file that opens wrong or not at all, a package that installs wrong. Trace each suspicion from a real entry point (a menu item, a command, a file, a provider's answer, an installer) to the failure in the code. ${NO_CARGO}

Report only what you can state concretely: where (file:line), what goes wrong, the scenario (inputs and steps, then the wrong result), how a test would show it, and the fix you propose, with a severity: blocker (must not ship), major (should be fixed for 0.5.0) or minor. Leave out style, naming and suspicions you could not trace. Write your findings, as the JSON you return, to ${B}/hunt-${a.id}.json (the engineer who fixes them reads that file). Return the schema; in 'checked', say what you examined and found sound.${note('hunt-' + a.id)}`, { label: `hunt:${a.id}`, phase: 'Hunt', schema: FINDINGS_SCHEMA, effort: 'high' })
}

function docs() {
  return agent(`You prepare the documents for the release of Pigment 0.5.0. ${APP}

1. **Parity page.** Write pigment/docs/parity/README.md: where Pigment 0.5.0 stands against Photoshop, honestly. Sources:
   - the audit of Nov 15 in ${SCR}/photocraft-eval/ (REPORT.md, area-table.md, pigment-ahead.md, map/*-beyond.md), which compared the JavaScript Pigment 0.4 and PhotoCraft at abb30df over 1,432 Photoshop entries, area by area (the JavaScript app's parity pages: \`git show claude/fervent-newton-263lz3:pigment/docs/PARITY.md\` and pigment/docs/parity/*.md on that branch). PhotoCraft at abb30df is still Pigment's base: nothing was merged from upstream since;
   - PhotoCraft's own measured documents in the repository: docs/target-app-parity.md, docs/gaps.md, docs/scorecard.md, docs/parity-checklist.md;
   - what Pigment added since: the generative AI (docs/generative-ai.md and its walk of Pigment 0.4's features) and the importer (README, the user guide page, ${B}/PKG-port-L*.md).
   Give the table per area for Pigment 0.5.0, the 93 entries where the JavaScript app was ahead with their status in 0.5.0 (done, or the 0.6 package that will port them: ${SCR}/planpc/PORTS.md, ports/PORTS-A.md and ports/PORTS-B.md name them), and a short section on method. The row-by-row map of the audit was lost: check a sample of at least 40 entries, spread over the areas, against the Rust tree, and say how many agreed, so readers know how far to trust the counts. Link upstream's documents for the detail rather than copying them.
2. **README.md, the user guide (docs/user/) and docs/RELEASE-NOTES-0.5.0.md**: one pass for consistency, written for a person who uses the app: what 0.5.0 has (PhotoCraft's editor, the generative AI, opening Pigment 0.1–0.4 documents), what differs from Pigment 0.4, honest known issues (the open lists in ${B}/PKG-ai-final.md and PKG-port-review-L.md; nothing was tried against live AI accounts; the builds are not code-signed), and a link to the parity page. Don't add a "## Downloads" section to the release notes: the release workflow writes it.
3. **docs/FORK.md**: record that upstream PhotoCraft moved a long way after the import (main at 6dbe43e on Nov 18: 1,760 files changed, +127k and −278k lines since abb30df), that it was not merged for 0.5.0, and that the merge is planned as its own step after the release.

Commit documentation only, with the two trailer lines in ${BRIEF} (section "Commits"), and push. ${NO_CARGO} Before you commit, run \`python3 pigment/scripts/pigment-rebrand.py --check\` and \`bash pigment/packaging/linux/package-docs-test.sh\` (from pigment/); neither needs cargo. Write ${B}/REL-docs.md. Return the schema; in 'sample', the entries you checked and the result.${note('docs')}`, { label: 'docs', phase: 'Hunt', schema: DOCS_SCHEMA, effort: 'high' })
}

function fix(a, findings) {
  const inline = findings ? `\nThe findings, as the hunt returned them:\n${JSON.stringify(findings)}\n` : ''
  return agent(`You fix the defects found in **${a.title}** before Pigment 0.5.0 ships. ${APP}

Read the rules in ${BRIEF} (section "Rules for every package"): one cargo process at a time with -j 4 and CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0; the test environment; the disk; fmt, clippy -D warnings and the rebrand check; small hooks listed in FORK.md; commits with the two trailer lines, each pushed at once; snapshots. They all apply to you.

The findings are in ${B}/hunt-${a.id}.json.${inline}
Earlier fixers' notes are ${B}/FIX-*.md, if any: skip what they already fixed.

Before you start, look at Pigment CI on the branch (\`gh run list --branch claude/pigment-photocraft -L 4\`). If the newest finished run is red, find out why and fix that first, in its own commit.

Take the findings in order of severity. For each:
1. **Reproduce it first**: a test that fails on the current code (where no test can reach it, a demonstration you record). A finding you can't reproduce is not a defect: drop it and say why.
2. **Fix it** in the smallest correct way, keep the test, and check that it passes and that the tests of the crate still pass. If you added or changed an engine command, run the panic hunt.
3. Commit the fix with its test (one commit per finding, or per closely related group) and push at once.
Blockers and majors must be fixed. Fix a minor when the fix is small and safe; otherwise record it for 0.6.

Write ${B}/FIX-${a.id}.md: each finding, reproduced or not, fixed or not, its commit, and why. Return the schema. When your work is pushed, return: don't wait for CI on your last push; the next engineer checks it first.${note('fix-' + a.id)}`, { label: `fix:${a.id}`, phase: 'Fix', schema: FIX_SCHEMA, effort: 'high' })
}

function review() {
  return agent(`You are the last engineer before Pigment 0.5.0 is published. ${APP} Read the rules in ${BRIEF} (section "Rules for every package"); they apply to you.

1. **CI.** Look at the newest runs on the branch (\`gh run list --branch claude/pigment-photocraft -L 6\`; \`gh run view <id> --log-failed\`). Fix what is red, in its own commit.
2. **Checks on the head**, one cargo process at a time: \`cargo fmt --all -- --check\`; \`cargo clippy --workspace --all-targets --locked --features heif -- -D warnings\`; \`python3 scripts/pigment-rebrand.py --check\`; \`cargo xtask layers\`, \`panel-commands\` and \`scorecard --check\`; \`cargo test -p xtask\`; the tests of every crate changed since 753ccc2 (\`git diff --stat 753ccc2..HEAD\`), not the whole workspace (CI runs it); the steps of the "CLI smoke test" in .github/workflows/pigment-ci.yml run by hand; \`pigment --version\` and \`pigment-cli --version\`.
3. **The fixes.** Read ${B}/hunt-*.json and ${B}/FIX-*.md: every blocker and major is fixed, or has a reason that holds. Re-check two of the fixes adversarially: does the test fail without the fix?
4. **The documents against the code.** README.md, docs/RELEASE-NOTES-0.5.0.md, docs/parity/README.md, docs/generative-ai.md and the user guide pages for the new features: every claim is true of the code. Fix what isn't.
5. **The release workflow.** .github/workflows/pigment-release.yml lets a manual run publish only from the repository's default branch, which is claude/fervent-newton-263lz3 (the JavaScript app's branch). Pigment's release branch is claude/pigment-photocraft. Change the check, and the comments that describe it, so a manual run with a tag publishes from the default branch or from claude/pigment-photocraft, and from nowhere else. Keep the rest of the workflow as it is.
6. **The version.** pigment/Cargo.toml's [workspace.package] version is 0.5.0; the release notes and the metainfo release entry (packaging/linux/*.metainfo.xml.in) agree with it. Where a file carries a release date, use today's date.

Commit and push. Write ${B}/REL-review.md. Return the schema: go or no-go for publishing, with the reasons; the checks and their results; your commits; and what is left for 0.6.${note('review')}`, { label: 'review', phase: 'Review', schema: REVIEW_SCHEMA, effort: 'high' })
}

const rank = (r) => (r ? r.findings.filter((f) => f.severity === 'blocker').length * 100 + r.findings.filter((f) => f.severity === 'major').length * 10 + r.findings.length : -1)
const out = { hunt: {}, docs: null, fix: {}, review: null }
let order = A.areas || AREAS.map((a) => a.id)

if (STEPS.includes('hunt')) {
  phase('Hunt')
  const ids = (A.huntAreas || AREAS.map((a) => a.id))
  // A barrier on purpose: the fix step orders the areas by what all the finders found.
  const results = await parallel([
    ...ids.map((id) => () => hunt(byId[id]).then((r) => { out.hunt[id] = r; return r })),
    () => (A.skipDocs ? Promise.resolve(null) : docs().then((r) => { out.docs = r; return r })),
  ])
  if (!A.areas) {
    order = ids.filter((id) => out.hunt[id] && out.hunt[id].findings.length > 0).sort((x, y) => rank(out.hunt[y]) - rank(out.hunt[x]))
    const empty = ids.filter((id) => !out.hunt[id] || out.hunt[id].findings.length === 0)
    if (empty.length) log(`No findings (or no result) for: ${empty.join(', ')}; the fix step skips them.`)
  }
  log(`Fix order: ${order.join(', ')}`)
}

if (STEPS.includes('fix')) {
  phase('Fix')
  for (const id of order) {
    out.fix[id] = await fix(byId[id], out.hunt[id] ? out.hunt[id].findings : null)
  }
}

if (STEPS.includes('review')) {
  phase('Review')
  out.review = await review()
}

return out
