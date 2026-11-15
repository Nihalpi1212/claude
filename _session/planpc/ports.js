export const meta = {
  name: 'pigment-ports',
  description: 'Port one group of the JavaScript Pigment\'s extras to the PhotoCraft base, one package at a time, then review the group',
  phases: [
    { title: 'Build', detail: 'one engineer per package, in order' },
    { title: 'Review', detail: 'a skeptic checks the group against its spec and fixes what it finds' },
  ],
}

const SCR = '/tmp/claude-0/-home-user-claude/02aa60de-818c-5d38-b2f3-33055ac112a1/scratchpad'
const BRIEF = `${SCR}/planpc/PORTS.md`
const G = args || {}
const SPEC = `${SCR}/planpc/ports/${G.spec}`
const PKGS = G.packages || []
// Continuation notes for a package stopped mid-way (added by the orchestrator only, before a resume): { "<id>": "text" }.
const NOTES = G.notes || {}

const PKG_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    commits: { type: 'array', items: { type: 'string' } },
    rowsDone: { type: 'array', items: { type: 'string' } },
    rowsNotDone: { type: 'array', items: { type: 'string' } },
    tests: { type: 'string' },
    checks: { type: 'string' },
    hooks: { type: 'array', items: { type: 'string' } },
    forNext: { type: 'string' },
  },
  required: ['summary', 'commits', 'rowsDone', 'rowsNotDone', 'tests', 'checks', 'hooks', 'forNext'],
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

const reports = {}
phase('Build')
for (let i = 0; i < PKGS.length; i++) {
  const id = PKGS[i]
  const prior = PKGS.slice(0, i)
  const note = NOTES[id] ? `\n\n${NOTES[id]}` : ''
  reports[id] = await agent(`Read the brief ${BRIEF}. Then read package ${id} in ${SPEC}: its section, and every row it lists in full. Build package ${id} in /home/user/claude/pigment, with its tests, exactly as the spec says. The spec is the plan; where it is wrong about the code you find, follow the code and record it.
${prior.length ? `Earlier packages of this group are committed on the branch. Read their notes first: ${prior.map((p) => `${SCR}/planpc/build/PKG-port-${p}.md`).join(', ')}.` : 'You are the first package of this group.'} Other packages from earlier groups and the AI port are also committed; git log shows them.
Follow the brief's rules:
- one cargo process at a time, with -j 4 and CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0;
- fmt, clippy -D warnings, your tests and the rebrand check green;
- small hooks, listed in FORK.md;
- local commits with the two trailer lines; never push.
Write ${SCR}/planpc/build/PKG-port-${id}.md for the next engineer. Return the schema: what you built, your commits (short sha and subject), the spec rows done and not done (with why), the tests and their results, the checks, every hook into an upstream file, and what the next package should know.${note}`, { label: `build:${id}`, phase: 'Build', schema: PKG_SCHEMA, effort: 'high' })
}

phase('Review')
const review = await agent(`You review group ${G.group} of the port of the JavaScript Pigment's extras: packages ${PKGS.join(', ')}, which other engineers just finished. Read the brief ${BRIEF} and those packages' sections in ${SPEC}. The work is the local commits on branch claude/pigment-photocraft in /home/user/claude (git log, git show) and the notes ${PKGS.map((p) => `${SCR}/planpc/build/PKG-port-${p}.md`).join(', ')}. The engineers' reports follow, but judge from the code:
${JSON.stringify(reports)}

Be a skeptic. Check:
- every row the spec gives these packages: does a user get what the JavaScript Pigment gave them, and what Photoshop does, or is the gap recorded with a reason?
- PSD and .pigment round trips, undo and redo as one step, 8, 16 and 32-bit documents and the colour modes where the feature applies;
- hostile or odd input in any new reader (truncated files, huge sizes, bad values);
- small hooks listed in FORK.md, and tests that really test what they claim.
Run the packages' tests and add a test for each real defect you find. Fix what you find in local commits with the two trailer lines (never push), one cargo process at a time with -j 4 and CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0. Return the findings (severity: blocker, major or minor; where; what; whether fixed and how), the checks you ran with their results, your commits, and what you could not fix.`, { label: `review:${G.group}`, phase: 'Review', schema: REVIEW_SCHEMA, effort: 'high' })

return { group: G.group, reports, review }
