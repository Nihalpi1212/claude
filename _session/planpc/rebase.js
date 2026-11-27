export const meta = {
  name: 'pigment-ports-rebase',
  description: 'Re-check the 0.6 port packages (groups A, P, FU, BT, BR1, BR2) against Pigment on PhotoCraft 057297b: what upstream now has, where the files moved, what is left to build',
  phases: [
    { title: 'Rebase', detail: 'one read-only auditor per group writes planpc/ports/REBASE-<group>.md' },
  ],
}

// Restartable: args.groups lists the groups still to audit (default: all six).
const SCR = '/tmp/claude-0/-home-user-claude/02aa60de-818c-5d38-b2f3-33055ac112a1/scratchpad'
const A = args || {}
const GROUPS = [
  { id: 'A', spec: 'PORTS-A.md', packages: ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'] },
  { id: 'P', spec: 'PORTS-A.md', packages: ['P1a', 'P1b', 'P2', 'P3', 'P4'] },
  { id: 'FU', spec: 'PORTS-A.md', packages: ['F1', 'F2', 'F3', 'U1', 'U2', 'U3', 'U4'] },
  { id: 'BT', spec: 'PORTS-B.md', packages: ['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8'] },
  { id: 'BR1', spec: 'PORTS-B.md', packages: ['B9', 'B10', 'B11', 'B12', 'B13'] },
  { id: 'BR2', spec: 'PORTS-B.md', packages: ['B14', 'B15', 'B16', 'B17', 'B18'] },
].filter((g) => !A.groups || A.groups.includes(g.id))

const SCHEMA = {
  type: 'object',
  properties: {
    packages: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          status: { type: 'string', enum: ['unchanged', 'reduced', 'done-upstream', 'blocked'] },
          summary: { type: 'string' },
          rowsDropped: { type: 'array', items: { type: 'string' } },
          newLocations: { type: 'string' },
          effort: { type: 'string' },
        },
        required: ['id', 'status', 'summary', 'rowsDropped', 'newLocations', 'effort'],
      },
    },
    groupNotes: { type: 'string' },
  },
  required: ['packages', 'groupNotes'],
}

function audit(g) {
  return agent(`You re-check group ${g.id} of the 0.6 port before its engineers start: packages ${g.packages.join(', ')}.

The specs were written on Nov 15 against PhotoCraft abb30df: ${SCR}/planpc/ports/${g.spec}, one section per package, each listing its rows (what Photoshop does, what the JavaScript Pigment did, what PhotoCraft had then, what to build, tests, effort). The brief for the port is ${SCR}/planpc/PORTS.md. Since then Pigment was merged with PhotoCraft **057297b** (Nov 27; release branch claude/pigment-photocraft at 03ccb71, checked out in /home/user/claude). Upstream rebuilt its interface on the craft framework in between (crates/ui-egui lost about 280 files; dialogs, widgets, task bars, menus, preferences and the canvas chrome moved to the framework, craft::ui and friends; ${SCR}/planpc/build/MERGE-PLAN.md §5 lists the big moves), and upstream may have built some of these features itself.

For each package, read its section and every row it lists in full, then look at the current tree (/home/user/claude/pigment) and at upstream's own measured documents there (docs/target-app-parity.md, docs/gaps.md, docs/scorecard.md, docs/parity-checklist.md):
1. **Status of each row now:** done, partly done or missing in Pigment as it is now, with evidence (file:line, command id, test name). A row upstream now does well enough is dropped; say why.
2. **Where things are now:** every file, type, function, command and dialog the section names: still there, moved (where to), renamed, or gone; and what the package must use instead on the framework (for interface work, name the framework's pieces upstream's own similar features use, with an example file).
3. **The package's plan, adjusted:** what is left to build, in which files, the hooks into upstream files, the tests, and the effort. Keep the spec's intent and its tests' intent; change what the new tree requires.
Don't run cargo, and don't change the repository. Write ${SCR}/planpc/ports/REBASE-${g.id}.md, one section per package, written so the engineer who builds it can follow it beside the spec (it wins where they differ). Return the schema.`, { label: `rebase:${g.id}`, phase: 'Rebase', schema: SCHEMA, effort: 'high' })
}

phase('Rebase')
const results = await parallel(GROUPS.map((g) => () => audit(g).then((r) => ({ group: g.id, r }))))
return results
