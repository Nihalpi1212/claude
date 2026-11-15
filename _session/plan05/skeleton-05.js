export const meta = {
  name: 'pigment-0-5-skeleton',
  description: 'Land the Pigment 0.5 skeleton from CONTRACT-05.md Part 2 in sequential chunks (each keeps the whole suite green), check it against the contract and fix the gaps',
  phases: [
    { title: 'Build', detail: 'implementers in sequence over Part 2, steps 0 to 13' },
    { title: 'Verify', detail: 'three reviewers check the landed skeleton against Part 1 of the contract' },
    { title: 'Fix', detail: 'one engineer closes the confirmed gaps and runs every suite' },
  ],
}

const ROOT = '/home/user/claude/pigment'
const PLAN = '/tmp/claude-0/-home-user-claude/02aa60de-818c-5d38-b2f3-33055ac112a1/scratchpad/plan05'
const SCRATCH = '/tmp/claude-0/-home-user-claude/02aa60de-818c-5d38-b2f3-33055ac112a1/scratchpad'
const PORT = 8850

const CONTEXT = `**Pigment** is a free Photoshop-class image editor (Electron 44, plain ES modules, no bundler, sandboxed renderer) in ${ROOT}; ${ROOT}/ARCHITECTURE.md describes it, including the 0.4 section whose mechanisms 0.5 reuses by name. Release 0.5 is built like 0.4: an integrator lands a **skeleton** (shared stores, contracts, extension points, every new menu item and key binding, stub modules), then fifteen engineers build fifteen packages in parallel against it, each in its own files. The skeleton's contract is ${PLAN}/CONTRACT-05.md (the final version; ${PLAN}/CONTRACT-05.draft.md is the reviewed draft, history only): Part 1 is the text of the new ARCHITECTURE.md section "## 0.5 features (contracts)" (the rules for the parallel round, which package owns each behaviour, the ownership table for existing files, where the package briefs are wrong about the code, the new files and the module order, the extension points, the shared integration points S1 to S15, the package contracts and the review decisions); **Part 2 is the implementation checklist in fourteen steps (0 to 13)**, each of which must leave the app working and the whole existing suite green; it says which tests to run after each step, and to run the whole browser suite and the Electron tests after steps 3, 4, 6, 9 and 12. The package briefs are in ${PLAN}/p05.md. Nothing of the skeleton has landed yet; the repository is at Pigment 0.4.0 (commit 99dbdee) and the working tree is clean.

Tools and rules. Unit tests: \`cd ${ROOT} && node --test tests/unit/*.test.mjs\` (878 pass at 0.4.0). Browser tests: \`cd ${ROOT} && PIGMENT_E2E_PORT=${PORT} PIGMENT_E2E_OUT=tests/e2e/.artifacts-skeleton npx playwright test -c tests/e2e/playwright.config.mjs [spec...] --trace off\` (the whole suite has 611 tests and takes about 19 minutes on one worker; nobody else runs the whole suite on this machine while you work, so you may run all of it). Electron tests: \`cd ${ROOT} && xvfb-run -a npx playwright test -c tests/electron/playwright.config.mjs --output tests/e2e/.artifacts-skeleton/electron --trace off\` (6 at 0.4.0). Known flaky tests at 0.4.0: an "Execution context was destroyed, most likely because of a navigation" failure that has hit \`actions.spec.mjs:574\`, \`content-aware-lens.spec.mjs:543\` and \`skeleton-04.spec.mjs:96\` about once in a few full runs (cause still unknown, being investigated separately: it is not a navigation, Playwright gives that text to any protocol error, and the local Playwright has been patched to append the underlying error as "[original: …]"; if you see it, re-run that test, copy the whole message with its "[original: …]" part into your hand-off with the test and the run it happened in, keep the trace, and do not add a retry for it; do not reinstall node_modules); drags in \`hunt2-layers.spec.mjs\`; timing-sensitive previews. Re-run a single failure with --repeat-each 3 before you call it flaky; a test that fails every time is a regression. Code style: ES modules, 2-space indent, single quotes, comments that explain why, plain direct wording in user-visible strings. Do not run git commands that change anything (status, diff, log, show and \`git archive HEAD\` into a scratch directory are fine); the integrator commits. Do not use the network except for npm packages the contract names, and then only from the npm registry. Keep the contract's names, data shapes and file locations; when the code forces a deviation, make the smallest one, and record it. Leave no test server or browser running when you finish.

Hand-off. Each implementer writes ${PLAN}/build/HANDOFF-<n>.md (create the directory if needed): the steps and items done, every deviation from the contract with its reason (file, name, what differs), anything left undone and why, the exact test counts at the end (unit, e2e, Electron when run), and tips for the next implementer. Read every earlier HANDOFF file before you start.`

// Part 2's steps, split so that each implementer ends on a step after which Part 2 runs every suite (3, 4, 6, 9,
// 12), so the next one starts from a green tree. Step 0 records the goldens on the untouched 0.4.0 tree, so it must
// come before any other change.
const CHUNKS = [
  { n: 1, steps: '0 to 3 (the goldens, recorded on the untouched 0.4.0 tree before anything else changes; settings and styles; the stub modules and the module order; keys and menus, with the spec edits S14.2 puts in those steps)' },
  { n: 2, steps: '4 (the brush: the preset schema and the tool brush, the engine facade with 0.4\'s brush code moved under it, the paint gesture, press claims, cursors and right-button drags; the brush goldens must hold exactly while the classic engine is in place)' },
  { n: 3, steps: '5 and 6 (the PSD mapper registries, with the PSD goldens holding; container chunks, the colour pipeline, the document profile, display stages, saving and opening hooks)' },
  { n: 4, steps: '7 to 9 (Camera Raw stages and registry, equal to 0.4\'s develop.js, and Last Filter; the colour picker stub and the colour widget at its call sites; type: the model, the api, the font library stub and the text tool)' },
  { n: 5, steps: '10 to 13 (preset files; toolbox and transform; the spec table checked line by line, skeleton-05.spec.mjs complete and gated, every suite and a clean headless start; documentation: ARCHITECTURE.md gets Part 1 as the 0.5 section, docs/0.5/README.md and "The skeleton as landed")' },
]
const LAST = CHUNKS.length

const build = (c) => `You are implementer ${c.n} of ${LAST} for the **Pigment 0.5 skeleton**. ${CONTEXT}

Your part: **Part 2, steps ${c.steps}**. Read Part 1 in full first (the sections your steps implement in detail), then your steps in Part 2, the section on where the briefs are wrong about the code, and the hand-offs of the implementers before you. ${c.n === 1 ? 'You are first: before you change anything, run the whole suite once (unit, browser, Electron) and record the baseline counts and any failures in your hand-off; then record the goldens of step 0 on that untouched tree.' : 'The implementers before you have landed the earlier steps (uncommitted, in the working tree); check their hand-offs for deviations that affect your steps.'}

Work through your steps in order. After each item run the tests the step names; after each step run the unit tests and the specs the step names, and the whole browser suite and the Electron tests where Part 2 says so (your part ends on such a step, so you finish with all three suites green and the next implementer starts from a green tree). Fix every regression before you go on: a skeleton step must not change behaviour that 0.4.0 has, except the deliberate changes the contract lists (and where it changes a default key, the specs that press the old key change in the same step, so the suite stays green). Write the unit tests and specs the steps name. When a step's instructions turn out to be wrong about the code, decide the smallest sound change that keeps the contract's intent and record it. Do not build package features beyond what the skeleton lands (stubs, defaults, hooks with today's behaviour). Finish with the hand-off file ${PLAN}/build/HANDOFF-${c.n}.md. Final answer: a short summary (steps done, deviations, test counts, anything the next implementer must know).`

const VERIFY = [
  { key: 'engines', port: PORT + 20, focus: 'S1 to S6 and S8, the engines and stores the packages build on: the brush preset schema, its normalisation and migration, splitStrokeSettings and its precedence, the tool brush, prepareBrush and the brushes kind; the engine facade with 0.4\'s brush code moved under it (hooks, normalizeSample, traceDabs, tips, strokeReach, the stroke preview, the dab pixel budget); the paint gesture split, press claims, the pen eraser and button 5, the brush cursor, right-button drags; the renames in retouch.js and adjustment-brush.js; the brush goldens (run tests/unit/brush-golden.test.mjs and tests/e2e/brush-golden.spec.mjs, and check that the recorded goldens really came from the 0.4.0 tree: compare a few cases with strokes you trace yourself in a 0.4.0 copy made by `git archive HEAD pigment | tar -x -C <scratch dir>`); the PSD mapper registries (order, the builtin rule, claims, notices, convert.js, writePsdDocument with Maximize Compatibility, the #ag-psd key and the import map) and the PSD goldens; container chunks on every file kind; the colour pipeline (engine slot, open, display and export hooks, the document profile, takeDamage and the display stages converting only the damage, byte-identical saves and exports of untagged documents with the stub engine, the open hooks and their interactive flag); the Camera Raw stages and registry (equal to 0.4\'s develop.js for every control, planes with alpha, the process version, owned keys and defaults)' },
  { key: 'modules', port: PORT + 22, focus: 'S7, S9 to S12 and S15, the new UI modules and the stubs: the colour picker stub, swatchColors, the HUD session stub, the pick-foreground and pick-background tools, the colour widget and every call site that now uses it, sampleMerged options; the keymap store (keysFor, set with placement, conflicts and force, resolvedOverlay, FIXED_KEYS) and every reader of the key tables going through it, the shortcuts dialog moved into lib/shortcuts-editor.js; the preset formats (both registries, blob references and extraBlobs, the bundle settings list, the 0.5 kinds, the aco-ase and abr stubs, opening and dropping); type (the catalog slot, render stages, setEditing, styleKey and stylePatch, typeTools and registerTypeTool, the font library stub); the toolbox title slots, resetOptions, setOptions, previewBox and the handle grab, Last Filter with the repeat source and filter:last-dialog, the Move tool hooks; every stub file of "New files" and every capability flag of S15: does it exist with the listed API, does the app run with it, can its owning package replace it and be tested before the others land, and does each skeleton test that pins a stub read the flag so that it holds after the package lands' },
  { key: 'wiring', port: PORT + 24, focus: 'S13, S14 and everything placed in existing files: the ownership table (for every package-owned file, did the skeleton land exactly what Part 1 says it lands first, and nothing more?), the behaviours split across packages (is the skeleton\'s half or stub of each in place?), the menu template, every new command id with its menu place, key binding and stub, every changed default key binding and every S14.2 spec edit (checked line by line against the specs), the native menu built from settings, coloured items and the devtools key, the MODULES order, the settings namespaces and their defaults, the stylesheets linked in index.html, the CSP hash and the vendor entries, the IPC added to main, preload and the browser bridge, the .pigment format and the reading of 0.4 files (open 0.4 documents with text, guides, styles, gradients, fill layers, smart objects and brush presets and compare them pixel for pixel with 0.4.0: `git stash` is not allowed, so run a 0.4.0 copy made by `git archive HEAD pigment | tar -x -C <scratch dir>` on its own port), app.stubbed, a headless start with no console error or warning, ARCHITECTURE.md\'s 0.5 section, docs/0.5/README.md and "The skeleton as landed"' },
]

const FINDINGS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          area: { type: 'string', description: 'contract section, step or extension point (e.g. "S4.2", "E41", "Step 6")' },
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'], description: 'blocker: a package cannot be built against it, or 0.4 behaviour broke' },
          issue: { type: 'string', description: 'what the contract says, what the code does, with file and function' },
          evidence: { type: 'string', description: 'what you read or ran' },
          fix: { type: 'string' },
        },
        required: ['area', 'severity', 'issue', 'evidence', 'fix'],
      },
    },
    sound: { type: 'string' },
  },
  required: ['findings', 'sound'],
}

const verify = (v) => `You are reviewing the freshly landed **Pigment 0.5 skeleton** against its contract. ${CONTEXT}

Correction to the above: the skeleton has now been landed by ${LAST} implementers (uncommitted, in the working tree; \`cd /home/user/claude && git status\` and \`git diff\` show it). Their hand-offs are ${PLAN}/build/HANDOFF-1.md to HANDOFF-${LAST}.md: read them, including the deviations they recorded.

Your job: check that what landed matches Part 1 of the contract closely enough that fifteen engineers can build their packages against it without guessing, and that 0.4.0 behaviour is intact. Look at: ${v.focus}. For each extension point or integration point in your area, check that it exists with the specified names, arguments, return values, events and defaults, and that its stub lets the owning package be tested before the others land; run small checks in Node or in the real app where reading is not enough (copy ${SCRATCH}/smoke.mjs into ${PLAN}/verify-${v.key}/ and run \`PORT=${v.port} timeout 180 node smoke.mjs ./check.mjs\`; its default export gets (page, logs); window.pigmentApp is the app). Use only port ${v.port} and the ones above it up to ${v.port + 1} for anything you start, because two reviewers work at the same time; do not run the whole browser suite (the next step does). A recorded deviation is fine when it is sound and Part 1 can simply be updated to say what the code does; report it only when it would mislead a builder (then the fix is to correct ARCHITECTURE.md's 0.5 section). Do not edit any file in the repository. At most 15 findings, blockers first. Final answer: the structured report only.`

const FIXES = {
  type: 'object',
  properties: {
    fixed: { type: 'array', items: { type: 'string' } },
    rejected: { type: 'array', items: { type: 'string' }, description: 'finding: why it was not a problem' },
    deferred: { type: 'array', items: { type: 'string' } },
    testResults: { type: 'string' },
  },
  required: ['fixed', 'rejected', 'deferred', 'testResults'],
}

const fix = (found) => `You are the integrator finishing the **Pigment 0.5 skeleton**. ${CONTEXT}

Correction to the above: the skeleton has now been landed by ${LAST} implementers (uncommitted, in the working tree); their hand-offs are ${PLAN}/build/HANDOFF-1.md to HANDOFF-${LAST}.md. Three reviewers checked it against the contract (findings below, JSON). For each finding: verify it against the code; fix what is real with the smallest sound change (a code fix, or a correction of ARCHITECTURE.md's 0.5 section where the code is right and the text would mislead a builder); reject what is not real, with the reason. Then run the unit tests, the whole browser suite and the Electron tests, and fix any regression. Append a "Fix pass" section to ${PLAN}/build/HANDOFF-${LAST}.md. Final answer: the structured report only.

Findings:
${JSON.stringify(found)}`

phase('Build')
const built = []
for (const c of CHUNKS) {
  const r = await agent(build(c), { label: `build:steps-${c.n}`, phase: 'Build', effort: 'high' })
  built.push(r)
  if (!r) { log(`implementer ${c.n} returned nothing; stopping here (resume the run to continue)`); return { built } }
  log(`implementer ${c.n} done`)
}

phase('Verify')
const reviews = (await parallel(VERIFY.map((v) => () =>
  agent(verify(v), { label: `verify:${v.key}`, phase: 'Verify', schema: FINDINGS, effort: 'high' })
    .then((r) => (r ? { key: v.key, ...r } : null))))).filter(Boolean)
if (reviews.length < VERIFY.length) {
  log('a reviewer stopped without a report; resume the run to continue')
  return { built, reviews: reviews.map((r) => r.key), fixed: null }
}
const findings = reviews.flatMap((r) => r.findings.map((f) => ({ reviewer: r.key, ...f })))
log(`${findings.length} findings (${findings.filter((f) => f.severity === 'blocker').length} blockers)`)

phase('Fix')
const fixed = findings.length ? await agent(fix(findings), { label: 'fix:skeleton', phase: 'Fix', schema: FIXES, effort: 'high' }) : null
if (findings.length && !fixed) log('the fix pass stopped before finishing; resume the run to continue')
return { built, reviews: reviews.map((r) => ({ key: r.key, findings: r.findings.length, blockers: r.findings.filter((f) => f.severity === 'blocker').length, sound: r.sound })), fixed }
