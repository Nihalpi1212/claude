export const meta = {
  name: 'pigment-ai-port-2',
  description: 'Finish the generative AI port on the PhotoCraft base: review of the engine, provider and interface packages, the Assistant, Sign in with ChatGPT, their review, and a final check',
  phases: [
    { title: 'Review 1', detail: 'a skeptic reviews P1 to P3 (engine commands, pigment-genai, interface) and fixes what it finds' },
    { title: 'Assistant and sign-in', detail: 'P4 the Assistant; P5 Sign in with ChatGPT; then their review' },
    { title: 'Final check', detail: 'whole-change verification against the JavaScript parity list' },
  ],
}

// Restartable: args.steps lists the steps still to run, in order (default: all of them), and
// args.notes maps a step id to a continuation note for a step that was stopped part-way. The
// journal is lost when the container is replaced, so a restart passes the remaining steps.
const SCR = '/tmp/claude-0/-home-user-claude/02aa60de-818c-5d38-b2f3-33055ac112a1/scratchpad'
const BRIEF = `${SCR}/planpc/AI-PORT.md`
const A = args || {}
const STEPS = A.steps || ['review123', 'P4', 'P5', 'review45', 'final']
const NOTES = A.notes || {}
const note = (id) => (NOTES[id] ? `\n\n${NOTES[id]}` : '')

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
  P4: 'P4, the Assistant',
  P5: 'P5, Sign in with ChatGPT',
}
const DOCS = `Read the brief ${BRIEF} first (its rules section says how to build, test, commit, push and back up here), then ${SCR}/planpc/ai/INTEGRATION.md (the design: §6 for the details and §7 for the packages) and ${SCR}/planpc/ai/PIGMENT-AI.md (the spec for what users must get).`
const notesOf = (ids) => ids.map((p) => `${SCR}/planpc/build/PKG-ai-${p}.md`).join(', ')

function build(id, prior) {
  return agent(`${DOCS} Then build package ${PACKAGES[id]} in /home/user/claude/pigment, exactly as INTEGRATION.md §7 describes, with its tests. The brief's decisions settle the open questions; where something is still open, choose what keeps the JavaScript users' features and record it.
Earlier packages are committed and pushed on branch claude/pigment-photocraft, and a review of P1 to P3 followed them. Read their notes before you start: ${notesOf(prior)}, and ${SCR}/planpc/build/PKG-ai-review123.md if it exists.
Write ${SCR}/planpc/build/PKG-ai-${id}.md for the next engineer. Return the schema: what you built, your commits (short sha and subject), the tests you added and their results, the checks you ran, every hook into an upstream file, what is not done, and what the next package should know.${note(id)}`, { label: `build:${id}`, phase: 'Assistant and sign-in', schema: PKG_SCHEMA, effort: 'high' })
}

function review(stepId, ids, phaseName) {
  return agent(`You review packages ${ids.join(', ')} of the generative AI port, which other engineers finished. ${DOCS} The work is the commits on branch claude/pigment-photocraft in /home/user/claude (git log, git show; the AI port starts at 093b6f0) and the engineers' notes ${notesOf(ids)}. Judge from the code, not from the notes.

Be a skeptic. Check four things.
- **Parity.** Every flow, option and default in PIGMENT-AI.md that these packages cover is there and behaves the same, or the difference is a decision in the brief.
- **Safety.** A key or token never reaches a log, an error message, a settings file, the accessibility tree, ui.inspect, the command list or a status answer. Nothing is sent before consent or without a key. An agent or the command line can't spend the person's money without the opt-in, by any route (MCP, control channel, CLI, actions.play, synthetic input). A cancelled or failed request leaves the document unchanged. Pixels outside the mask stay exact.
- **Robustness.** Hostile or odd answers are handled: wrong sizes, a decode failure, an empty result, safety blocks, timeouts.
- **Fit.** Hooks into upstream files are small and listed in FORK.md, and the tests really test what they claim.
Run the packages' tests and add a test for each real defect you find. Fix what you find, in commits made and pushed as the brief says. Write ${SCR}/planpc/build/PKG-ai-${stepId}.md: what you found and fixed, and what the next engineer should know. Return the findings (severity blocker, major or minor; where; what; whether fixed and how), the checks you ran with their results, your commits, and what you could not fix.${note(stepId)}`, { label: `review:${ids.join('-')}`, phase: phaseName, schema: REVIEW_SCHEMA, effort: 'high' })
}

const out = {}
for (const step of STEPS) {
  if (step === 'review123') {
    phase('Review 1')
    out.review123 = await review('review123', ['P1', 'P2', 'P3'], 'Review 1')
  } else if (step === 'P4') {
    phase('Assistant and sign-in')
    out.P4 = await build('P4', ['P1', 'P2', 'P3'])
  } else if (step === 'P5') {
    phase('Assistant and sign-in')
    out.P5 = await build('P5', ['P1', 'P2', 'P3', 'P4'])
  } else if (step === 'review45') {
    phase('Assistant and sign-in')
    out.review45 = await review('review45', ['P4', 'P5'], 'Assistant and sign-in')
  } else if (step === 'final') {
    phase('Final check')
    out.final = await agent(`You run the final check of the generative AI port on branch claude/pigment-photocraft in /home/user/claude. ${DOCS} Also read the package and review notes ${SCR}/planpc/build/PKG-ai-*.md. Verify the whole change as CI and a user would see it:
- cargo fmt --all -- --check;
- cargo clippy --workspace --all-targets --locked --features heif -- -D warnings (one cargo process, -j 4; this is long but required: it is what CI runs);
- python3 scripts/pigment-rebrand.py --check, cargo xtask layers, cargo xtask panel-commands and cargo xtask scorecard --check;
- the tests of photocraft-engine's ai_cmds and generative modules, pigment-genai, ui-egui's AI tests and xtask;
- the CLI end to end against a localhost mock (ai status, set-key with a temporary config dir, and run --cmd ai.generativeFill with --allow-ai, producing an image);
- target/debug/pigment --version and pigment-cli --version still print the version line.
Then walk PIGMENT-AI.md feature by feature and say for each whether the Rust app has it (with the command id and menu place), differs by a decision in the brief, or is missing. Write that table into pigment/docs/generative-ai.md, the user-facing contract (merge with what is there). Fix small failures you find, in commits made and pushed as the brief says. Write ${SCR}/planpc/build/PKG-ai-final.md with the results. Return the schema.${note('final')}`, { label: 'final-check', phase: 'Final check', schema: REVIEW_SCHEMA, effort: 'high' })
  }
}
return out
