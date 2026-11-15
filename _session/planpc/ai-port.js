export const meta = {
  name: 'pigment-ai-port',
  description: 'Port the JavaScript Pigment\'s generative AI to the PhotoCraft base: engine seam and commands, pigment-genai, interface, Assistant, Sign in with ChatGPT, with reviews',
  phases: [
    { title: 'Engine and providers', detail: 'P1 engine seam and ai.* commands; P2 pigment-genai providers, keys, backend, CLI' },
    { title: 'Interface', detail: 'P3 menus, Generate window, AI Accounts, task bars; then a review of P1 to P3' },
    { title: 'Assistant and sign-in', detail: 'P4 the Assistant; P5 Sign in with ChatGPT; then a review of P4 and P5' },
    { title: 'Final check', detail: 'whole-change verification against the JavaScript parity list' },
  ],
}

const SCR = '/tmp/claude-0/-home-user-claude/02aa60de-818c-5d38-b2f3-33055ac112a1/scratchpad'
const BRIEF = `${SCR}/planpc/AI-PORT.md`

const PKG_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    commits: { type: 'array', items: { type: 'string' } },
    tests: { type: 'string' },
    checks: { type: 'string' },
    hooks: { type: 'array', items: { type: 'string' } },
    notDone: { type: 'array', items: { type: 'string' } },
    forNext: { type: 'string' },
  },
  required: ['summary', 'commits', 'tests', 'checks', 'hooks', 'notDone', 'forNext'],
}
const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    findings: { type: 'array', items: { type: 'object', properties: { severity: { type: 'string' }, where: { type: 'string' }, issue: { type: 'string' }, fixed: { type: 'boolean' }, how: { type: 'string' } }, required: ['severity', 'where', 'issue', 'fixed', 'how'] } },
    checks: { type: 'string' },
    commits: { type: 'array', items: { type: 'string' } },
    notDone: { type: 'array', items: { type: 'string' } },
  },
  required: ['findings', 'checks', 'commits', 'notDone'],
}

const PACKAGES = {
  P1: 'P1, the engine seam and the ai.* commands (headless, with the MockBackend)',
  P2: 'P2, pigment-genai: providers, keys, settings, the backend that implements the engine trait, and the CLI subcommands',
  P3: 'P3, the interface: menus, the Generate window, AI Accounts with consent, Describe\'s result window, the task bars, and the app wiring that installs the backend',
  P4: 'P4, the Assistant',
  P5: 'P5, Sign in with ChatGPT',
}

function build(id, prior) {
  return agent(`Read the brief ${BRIEF}, then ${SCR}/planpc/ai/INTEGRATION.md (the design: §6 for the details and §7 for your package) and the parts of ${SCR}/planpc/ai/PIGMENT-AI.md that your package covers (the spec for what users must get). Then build package ${PACKAGES[id]} in /home/user/claude/pigment, exactly as INTEGRATION.md §7 describes, with its tests. The brief's decisions settle the open questions; where something is still open, choose what keeps the JavaScript users' features and record it.
${prior.length ? `Earlier packages are committed on the branch. Read their notes before you start: ${prior.map((p) => `${SCR}/planpc/build/PKG-ai-${p}.md`).join(', ')}.` : 'You are the first package.'}
Follow the brief's rules: one cargo process at a time with -j 4; fmt, clippy -D warnings and your tests green; small hooks listed in FORK.md; local commits with the two trailer lines; no push. Write ${SCR}/planpc/build/PKG-ai-${id}.md for the next engineer. Return the schema: what you built, your commits (short sha and subject), the tests you added and their results, the checks you ran, every hook into an upstream file, what is not done, and what the next package should know.`, { label: `build:${id}`, phase: id === 'P1' || id === 'P2' ? 'Engine and providers' : id === 'P3' ? 'Interface' : 'Assistant and sign-in', schema: PKG_SCHEMA, effort: 'high' })
}

function review(ids, reports, phaseName) {
  return agent(`You review packages ${ids.join(', ')} of the AI port that other engineers just finished. Read the brief ${BRIEF}, then ${SCR}/planpc/ai/INTEGRATION.md and ${SCR}/planpc/ai/PIGMENT-AI.md. The work is the local commits on branch claude/pigment-photocraft in /home/user/claude (git log, git show), and the notes ${ids.map((p) => `${SCR}/planpc/build/PKG-ai-${p}.md`).join(', ')}. The engineers' reports follow, but judge from the code:
${JSON.stringify(reports)}

Be a skeptic. Check four things.
- **Parity.** Every flow, option and default in PIGMENT-AI.md that these packages cover is there and behaves the same, or the difference is a decision in the brief.
- **Safety.** A key or token never reaches a log, an error message, a settings file, the accessibility tree, ui.inspect, the command list or a status answer. Nothing is sent before consent or without a key. A cancelled or failed request leaves the document unchanged. Pixels outside the mask stay exact.
- **Robustness.** Hostile or odd answers are handled: wrong sizes, a decode failure, an empty result, safety blocks, timeouts.
- **Fit.** Hooks into upstream files are small and listed in FORK.md, and the tests really test what they claim.
Run the packages' tests and add a test for each real defect you find. Fix what you find in local commits with the two trailer lines from the brief (never push), one cargo process at a time with -j 4. Return the findings (severity blocker, major or minor; where; what; whether fixed and how), the checks you ran with their results, your commits, and what you could not fix.`, { label: `review:${ids.join('-')}`, phase: phaseName, schema: REVIEW_SCHEMA, effort: 'high' })
}

phase('Engine and providers')
const p1 = await build('P1', [])
const p2 = await build('P2', ['P1'])
phase('Interface')
const p3 = await build('P3', ['P1', 'P2'])
const r1 = await review(['P1', 'P2', 'P3'], { p1, p2, p3 }, 'Interface')
phase('Assistant and sign-in')
const p4 = await build('P4', ['P1', 'P2', 'P3'])
const p5 = await build('P5', ['P1', 'P2', 'P3', 'P4'])
const r2 = await review(['P4', 'P5'], { p4, p5 }, 'Assistant and sign-in')
phase('Final check')
const final = await agent(`You run the final check of the AI port on branch claude/pigment-photocraft in /home/user/claude (read the brief ${BRIEF} and its two documents, and the package notes ${SCR}/planpc/build/PKG-ai-P*.md). Verify the whole change as CI and a user would see it:
- cargo fmt --all -- --check;
- cargo clippy --workspace --all-targets --locked -- -D warnings (one cargo process, -j 4; this is long but required);
- the tests of photocraft-engine's ai_cmds, pigment-genai and ui-egui's AI tests;
- the CLI end to end against a localhost mock (ai status, set-key with a temporary config dir, and run --cmd ai.generativeFill with --allow-ai, producing an image);
- target/debug/pigment --version and pigment-cli --version still print the version line.
Then walk PIGMENT-AI.md feature by feature and say for each whether the Rust app has it (with the command id and menu place), differs by a decision in the brief, or is missing. Write that table to pigment/docs/generative-ai.md, the user-facing contract (keep the existing content there if a package wrote one, and merge). Fix small failures you find, in local commits with the brief's trailers (never push). Return the schema.`, { label: 'final-check', phase: 'Final check', schema: REVIEW_SCHEMA, effort: 'high' })

return { p1, p2, p3, r1, p4, p5, r2, final }
