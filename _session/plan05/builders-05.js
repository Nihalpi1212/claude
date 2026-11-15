export const meta = {
  name: 'pigment-0-5-builders',
  description: 'Build the fifteen Pigment 0.5 packages against the landed skeleton in two fixed sequences (two engineers at a time), then integrate and make the whole suite green',
  phases: [
    { title: 'Build', detail: 'two sequences of eight and seven packages run side by side; each package owns its files and tests' },
    { title: 'Integrate', detail: 'one integrator applies the hooks the packages asked for, removes the waiting gates and skips and makes unit, e2e and Electron green' },
  ],
}

const ROOT = '/home/user/claude/pigment'
const PLAN = '/tmp/claude-0/-home-user-claude/02aa60de-818c-5d38-b2f3-33055ac112a1/scratchpad/plan05'
const SMOKE = '/tmp/claude-0/-home-user-claude/02aa60de-818c-5d38-b2f3-33055ac112a1/scratchpad/smoke.mjs'

const COMMON = `You are a senior engineer building one package of **Pigment 0.5** ("Photoshop parity, stage 3"). Pigment is a free Photoshop-class image editor (Electron 44, plain ES modules, no bundler, sandboxed renderer) in ${ROOT}. The user asked for every Photoshop feature. 0.5 adds fifteen packages on top of a skeleton that has already landed and is committed: shared stores, registries and engines' facades, every 0.5 menu item and key binding, the capability flags, and a stub module at each package's entry path.

Your contract is in ${ROOT}/ARCHITECTURE.md, section "## 0.5 features (contracts)". Read, in this order: "### Rules for the parallel round" (rules 1 to 15), "### Behaviours split across packages (rule 12)", "### Ownership of existing files", "### Where the briefs are wrong about the code", "### New files", "### Extension points", your own package under "### Packages", every shared integration point (S1 to S15) that your package section or your files name, "### Tests expected from every 0.5 package", "### Review decisions", and the section that records how the skeleton landed where it differs from the text (step 13 of the skeleton's checklist wrote it; ${ROOT}/docs/0.5/README.md names the packages and ports). Your original brief is the section of ${PLAN}/p05.md headed with your package name: the features listed there are your scope; where the brief and the contract disagree, the contract wins. The skeleton hand-offs ${PLAN}/build/HANDOFF-1.md to HANDOFF-5.md (HANDOFF-5 ends with the fix pass) record where the code differs from the contract text; ${PLAN}/build/BASELINE.md gives the test counts at the start of this round and the known flaky tests. Then read the files you own, the stubs you replace, and the neighbouring modules whose patterns you follow.

How the round runs. Two engineers work at the same time in this one checkout, each on their own package and files. The packages are built in two fixed sequences, ordered so that what your package builds on from this release has normally landed before you start. Engineers who finished before you left notes in ${PLAN}/build/PKG-<package>.md (the API as built, deviations from the contract, tests that wait for another package, what they left for the integrator). Read every one that exists before you start, and where a package you depend on has landed, build on its real code, not on the stub the contract describes.

Rules.
- Ownership: edit only the files that the ownership table and the new-files table give your package, plus new files you create under your package's names. Never edit a file that another package or the skeleton owns, ARCHITECTURE.md, README.md, docs/USER-GUIDE.md, or an existing spec file (unless your section names it). When you need something in a file you do not own, use the extension point the table names; if none fits, build the closest sound alternative inside your own files and write the need into your report and your PKG notes for the integrator.
- One owner per behaviour (rule 12): for a behaviour split across packages, build your half against the other half's stub or real code; never write a private copy of the other half to make your tests pass.
- Register, do not patch (rule 3). Replace your stub module and stub commands by registering the real ones (a registration not marked stub removes the id from app.stubbed). Keep every export a stub's API lists. Keep every call the skeleton placed in files you own (the marker comments of rule 10). Set your capability flags of S15 when your real code lands, and keep the gated skeleton tests passing in their landed branch (rule 11): never delete or loosen a gated assertion.
- The five paths (rule 13): check your features through undo and redo, save and reopen as .pigment and PSD, action playback, 16/32-bit and non-RGB documents, and the Electron build, as your package section says.
- Settings go in your namespace object (rule 5), styles in styles/<your stylesheet>.css, icons through registerIcons, and user-guide text, release-note lines (every changed default or key), third-party notices and known gaps in docs/0.5/<your package>.md (rule 7).
- Do not run git commands that change anything (status, diff and log are fine). The integrator commits snapshots of the working tree while you work, so \`git diff HEAD\` may not show all of your changes: keep your own list of the files you changed. No npm dependencies beyond what rule 15 allows, installed only from the npm registry; no other network use. Code style: ES modules, 2-space indent, single quotes, comments that explain why, plain direct wording in user-visible strings. Every user action goes through the command registry and is undoable through history.
- Performance: pure pixel code uses typed arrays and plain loops; anything that can take more than a second on a 2000 x 1500 layer runs under app.busy (reduced previews while dragging are fine). Measure and report the cost of anything you add to the repaint or stroke path.
- If files you own already hold work for your package (an earlier attempt was interrupted by a usage limit), read it first, keep what is sound and finish it; do not start over blindly. Work in small verified steps and keep your tests runnable at every step, so that an interruption loses little.

Tests. Unit: \`cd ${ROOT} && node --test tests/unit/<file>.test.mjs\` for yours, \`node --test tests/unit/*.test.mjs\` for the whole unit suite. Browser: \`cd ${ROOT} && PIGMENT_E2E_PORT=<your port> PIGMENT_E2E_OUT=tests/e2e/.artifacts-<your package> npx playwright test -c tests/e2e/playwright.config.mjs [spec...] --trace off\`, with only your port and your artifacts directory. As you go, run your spec, tests/e2e/app.spec.mjs, skeleton-04.spec.mjs, skeleton-05.spec.mjs, brush-golden.spec.mjs and the existing specs that exercise your files (grep them for your command ids and functions). Before you finish, run the whole unit suite and the whole e2e suite once on your port (about 650 tests, 20 to 25 minutes) and fix every failure your package causes. A failure in code the other engineer is editing right now may be their work in progress: re-run that spec once at the end, and if it still fails, name it in your report. Run the Electron tests (\`cd ${ROOT} && xvfb-run -a npx playwright test -c tests/electron/playwright.config.mjs --output tests/e2e/.artifacts-<your package>/electron --trace off\`; the --output keeps your artifacts apart from the other engineer's) when your package changes what the packaged app loads (wasm, workers, fonts, IPC, the main process, the native menu or its accelerators). Re-run a single failure with --repeat-each 3 before you call it flaky. Known flake, fixed before this round: on Chromium 141 a page.evaluate could fail with "Execution context was destroyed, most likely because of a navigation". It is not a navigation: it is "Promise was collected" (V8 14.1's inspector holds an awaited evaluate promise weakly, and a GC in an app microtask after the promise settles loses it). tests/e2e/helpers.mjs runAwait settles from a fresh task, so await app commands and other app promises through runAwait (or its try/finally setTimeout pattern), never a bare page.evaluate that returns the promise. If the message still appears, copy the whole message into your report's otherFailures with the test name, and do not reinstall node_modules. For ad-hoc checks, copy ${SMOKE} into ${PLAN}/build/smoke-<your package>/ and run \`PORT=<your port + 100> timeout 300 node smoke.mjs $PWD/check.mjs\` there (its default export gets (page, logs); window.pigmentApp is the app). Leave no server or browser running when you finish.

Finish the whole package: every feature of your brief and every item of your contract section, with the tests it asks for, until your unit tests, your e2e spec, app.spec, skeleton-04.spec, skeleton-05.spec, brush-golden.spec and the whole suite pass. If something in the contract turns out impossible or unwise, build the closest sound alternative and report it. Last, write ${PLAN}/build/PKG-<your package>.md for the engineers after you (the API you provide as built, with names and arguments; deviations from the contract; tests that skip or gate until another package lands; anything the integrator must do), then give the structured report as your final answer.`

const REPORT = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'what the package delivers, in a few sentences' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    testsAdded: { type: 'array', items: { type: 'string' } },
    testResults: { type: 'string', description: 'exact pass/fail/skip counts of your unit file, your e2e spec, the whole unit suite, the whole e2e suite, and Electron if run' },
    notDone: { type: 'array', items: { type: 'string' }, description: 'features of the brief or items of the contract not done or done differently, with the reason' },
    deviations: { type: 'array', items: { type: 'string' }, description: 'every place the code differs from the contract: file, name, what differs, why' },
    behaviourChanges: { type: 'array', items: { type: 'string' }, description: 'changes to existing behaviour, defaults or keys, for the release notes' },
    fivePaths: { type: 'string', description: 'what you checked for undo, .pigment and PSD, actions, 16/32-bit and modes, and Electron, and what you found' },
    waitingSkips: { type: 'array', items: { type: 'string' }, description: 'tests that skip or gate until another package lands: test name, the capability it checks' },
    integratorNeeds: { type: 'array', items: { type: 'string' }, description: 'changes wanted in files you do not own: file, what, why' },
    repaintCost: { type: 'string', description: 'measured cost of anything on the repaint or stroke path, or "none"' },
    thirdParty: { type: 'array', items: { type: 'string' }, description: 'every bundled third-party package, file or data set with its licence and where it came from, or empty' },
    otherFailures: { type: 'array', items: { type: 'string' }, description: 'failures you saw that your package did not cause, with the full error text' },
  },
  required: ['summary', 'filesChanged', 'testsAdded', 'testResults', 'notDone', 'deviations', 'behaviourChanges', 'fivePaths', 'waitingSkips', 'integratorNeeds', 'repaintCost', 'thirdParty', 'otherFailures'],
}

// Two fixed sequences. A package starts after the packages it builds on (the brush packages after the engine,
// the type packages after the font catalog, psd-text after both, Camera Raw's panels after its workspace; the
// preset files after psd-layers' effect mappers, the preset panels after the preset files, the colour picker after
// the colour engine and the swatch formats). Every pairing across the sequences is gated on S15's flags, so
// timing between them only decides whether a test meets the real partner or its stub.
const SEQ_A = [
  ['brush-engine-core', 1, 8851, `This is the release's largest painting risk: every stroke of every tool goes through your engine. Keep the classic engine's output reachable for S2.3's goldens (equal while ENGINE.id is 'classic-0.4', within tolerance after) and run every existing paint spec (grep the specs for tool:brush, tool:pencil, tool:eraser, stamp, history-brush, mixer, dodge, burn, sponge, blur-tool, smudge, adjustment-brush) at every step, because the other engineer's tests paint through your files while you work. Measure the stroke path on a 2000 x 1500 layer against 0.4 (S2.8) and report it. Run the Electron tests (pen input and the packaged app).`],
  ['brush-settings-panel', 2, 8852, `brush-engine-core has landed: read its PKG notes and use ENGINE.features and the real modifier chain. For .abr test files, build them in the test or use freely licensed files whose licence you record; do not download Photoshop brush packs. Set ABR_REAL when your reader and writer land (preset-files-manager's .tpl dynamics gate on it).`],
  ['brush-painting-behaviours', 3, 8853, `brush-engine-core and brush-settings-panel have landed (read their PKG notes): use the real tipOutline and the real sections. The HUD colour picker gesture forwards to color-picker-swatches' HUD session, which lands later in the other sequence: until then the stub resolves null (review decision 2). Run the Electron tests (Shift+Alt through resolveKey, the native accelerators).`],
  ['type-fonts', 12, 8862, `For the OFL fixture fonts, this machine has Liberation Sans, Serif and Mono under /usr/share/fonts/truetype/liberation2/ and liberation/ (SIL Open Font License 1.1; licence text in /usr/share/doc/fonts-liberation2/copyright), and tests/fixtures/fonts/ already holds 0.4's test font: choose faces with the styles, axes and glyphs your tests need, and bundle every font file with its licence beside it (rule 15). Variable axes need a variable OFL font you can get offline or from an npm package; if none is available, test axes on the fixture you can get and report it. Keep 0.4's type specs green (type-*.spec.mjs, hunt5-type) and run the Electron tests (fonts inside the asar, local-fonts). Continuation: a first engineer on this package was stopped by the usage limit at 08:25 UTC, before writing the PKG notes or the report, and their work is in the tree. ${PLAN}/build/type-fonts-stopped-actions.md lists, in order, every file they wrote or edited (Write, Edit and the python heredocs they ran through Bash: font-tables.js, font-library.js, font-picker.js, missing-fonts.js, fonts.js, layout.js, shaper.js, type-fonts.css, the bundled fonts under src/renderer/fonts/, tests/unit/type-fonts.test.mjs, tests/e2e/type-fonts.spec.mjs, tests/electron/type-fonts.spec.mjs, docs/0.5/type-fonts.md), their notes and their test runs. Read it, check each of their files against your package section and S11, keep what is sound and fix what is not, then finish: the remaining steps were the PKG notes, the whole unit suite and the whole e2e suite once on your port, and the report. Their last runs: tests/e2e/type-fonts.spec.mjs 7/7; the type specs 46/46 (before their e2e spec existed); app.spec, skeleton-04, skeleton-05 and brush-golden with only icc-engine's two known skeleton-05 failures; Electron type-fonts and type-engine-core 2/2; faceFor 0.167 µs (static) and 0.451 µs (variable) per call, shapePiece of 900 cached characters about 0.85 ms.`],
  ['type-menu-commands', 13, 8863, `type-fonts has landed (read its PKG notes): use the real catalog and faces. Work paths and Convert to Shape need glyph outlines from the HarfBuzz engine 0.4 bundled; the Canvas fallback engine has none (show the message the contract names).`],
  ['psd-text', 6, 8856, `type-fonts and type-menu-commands have landed (read their PKG notes): fromPostScriptName and resolve are real, and warp draws. psd-layers works in the other sequence on its own files under lib/psd/: register through lib/psd/index.js only, keep S4.1's exports and Node-safe imports, and run tests/unit/psd-registry.test.mjs and the PSD goldens of skeleton-05.spec.mjs.`],
  ['camera-raw-workspace', 7, 8857, `Keep S8.3's DOM and the session preview that 0.4's Camera Raw specs drive (extras.spec.mjs, the camera-raw and smart-filter specs): run them at every step. camera-raw-panels comes right after you and builds its tabs, sections and tools on your DevelopWorkspace: put its API as built in your PKG notes.`],
  ['camera-raw-panels', 8, 8858, `camera-raw-workspace has landed (read its PKG notes): register your tabs, sections and tools into the real workspace, and keep your tools' tests on createFakeWorkspace as the contract says. Neutral params must give 0.4's output (tests/unit/fixtures/develop-04.mjs) and a neutral 12 MP develop must cost no more than 0.4's: measure and report it.`],
]
const SEQ_B = [
  ['icc-engine', 4, 8854, `This is the release's largest packaging risk. Rule 15 lets you add one npm dependency, LittleCMS 2 compiled to wasm under a permissive licence (MIT): find a package on the npm registry that ships it with its source and licence, vendor it the way 0.4 vendors HarfBuzz (a script under scripts/vendor/ that copies it into src/renderer/vendor/lcms2/, gitignored and rebuilt by postinstall; check that \`npm ci\` in .github/workflows/pigment-ci.yml and pigment-release.yml runs that step and that the electron-builder file list in package.json packages it), and record the package, version and licence in docs/0.5/icc-engine.md. If no such package exists, build the closest sound alternative inside your files (a pure-JS engine for matrix/TRC RGB and Gray profiles with exact sRGB round trips, LUT-based profiles reported as unsupported), report it, and keep the engine interface of S6.1 unchanged so lcms2 can replace it later. The wasm must load under the pigment:// protocol, inside the asar and under the CSP ('wasm-unsafe-eval' is allowed): run the Electron tests. Untagged and sRGB documents must stay byte- and pixel-identical to 0.4 (S6), and the display stage must meet S6.4's 60 ms target: measure and report it.`],
  ['psd-layers', 5, 8855, `psd-text works in the other sequence on its own file under lib/psd/: register through lib/psd/index.js only and keep S4.1's exports and Node-safe imports. You provide stylesFromPsd / stylesToPsd and pathFromPsd for preset-files-manager, which comes right after you: put their API as built in your PKG notes. S14.2's gated PSD lines must pass their landed branch, and the PSD goldens of skeleton-05.spec.mjs must hold while the flags of the mappers that could write them are false.`],
  ['preset-files-manager', 10, 8860, `psd-layers has landed (read its PKG notes): use its effect and path mappers for .asl and .csh. brush-settings-panel works in the other sequence and owns .abr; .tpl brushes go through S10.6 and its dynamics gate on ABR_REAL. Build every test file in the test or use freely licensed files whose licence you record; do not download Photoshop preset packs. presets-panels and color-picker-swatches come after you and import your formats: put the format ids and APIs as built in your PKG notes.`],
  ['presets-panels', 9, 8859, `preset-files-manager has landed (read its PKG notes): Import lists its formats. The brush packages have landed in the other sequence or are landing: check their PKG notes for the tool-preset brush API and test a tool preset with a sampled tip through export and import. Continuation: a first engineer on this package was stopped by the usage limit at 08:25 UTC after about 90 seconds of reading; they changed no files (${PLAN}/build/presets-panels-stopped-actions.md). Start from the beginning.`],
  ['color-picker-swatches', 11, 8861, `icc-engine and preset-files-manager have landed (read their PKG notes): use the real conversions for out-of-gamut warnings and Lab fields, and the real .aco / .ase readers. brush-painting-behaviours (other sequence) forwards the HUD colour picker gesture to your HUD session: check its PKG notes and test the gesture end to end if it has landed. The colour widget you land replaces the skeleton's at every call site: run the 0.4 colour specs and the dialog-heavy specs (adjust-more, filters-a, filters-b, layer-style, shape-paint, extras3).`],
  ['shortcuts-editor', 14, 8864, `Every key and menu reader goes through the skeleton's keymap store (S9.4): your dialog edits overlays only through app.keymap. Run the Electron tests, including your electron spec (native accelerators and hidden items), and every spec that presses keys (grep the specs for keyboard.press).`],
  ['move-tool-depth', 15, 8865, `0.4's open item about moving a Background layer stays open unless you solve it in one entry (review decision and package section). Run 0.4's Move, snapping, links and layers specs at every step (grep the specs for tool:move and layer-move).`],
]

const brief = ([name, number, port, notes], seq, i, n) =>
  `${COMMON}\n\nYour package: **${name}** (number ${number} under "### Packages", port ${port}, artifacts directory tests/e2e/.artifacts-${name}). It is package ${i + 1} of ${n} in sequence ${seq}. ${notes}`

// A package that ends without a report (a usage limit or an API error stopped its engineer) stops its
// sequence: the packages after it build on its work. Resuming the run re-runs that package (its files keep
// what it did) and continues from there; packages that reported come back from the cache.
const runSequence = async (seq, list) => {
  const out = []
  for (let i = 0; i < list.length; i++) {
    const name = list[i][0]
    const report = await agent(brief(list[i], seq, i, list.length), { label: `build:${name}`, phase: 'Build', schema: REPORT, effort: 'high' })
    out.push({ name, report: report ?? null })
    log(`${name}: ${report ? 'landed' : 'no report'}`)
    if (!report) {
      log(`sequence ${seq} stops after ${name}; resume the run to continue it`)
      break
    }
  }
  return out
}

phase('Build')
const [a, b] = await parallel([() => runSequence('A', SEQ_A), () => runSequence('B', SEQ_B)])
const built = [...(a ?? []), ...(b ?? [])]
const missing = [...SEQ_A, ...SEQ_B].map(([name]) => name).filter((name) => !built.some((p) => p.name === name && p.report))
if (missing.length) {
  log(`integration waits: no report yet from ${missing.join(', ')}`)
  return { built: built.map((p) => ({ name: p.name, landed: !!p.report })), missing, integrated: null }
}

const INTEGRATE_REPORT = {
  type: 'object',
  properties: {
    changes: { type: 'array', items: { type: 'string' }, description: 'each integration change: file, what, why' },
    skipsRemoved: { type: 'array', items: { type: 'string' } },
    fixed: { type: 'array', items: { type: 'string' }, description: 'failures found and their root-cause fixes' },
    open: { type: 'array', items: { type: 'string' }, description: 'problems left, by package, with the reason' },
    flaky: { type: 'array', items: { type: 'string' } },
    testResults: { type: 'string', description: 'final counts: unit, whole e2e, Electron' },
  },
  required: ['changes', 'skipsRemoved', 'fixed', 'open', 'flaky', 'testResults'],
}

phase('Integrate')
const integrated = await agent(`You are the integrator of **Pigment 0.5** ("Photoshop parity, stage 3"), a free Photoshop-class image editor (Electron 44, plain ES modules, no bundler, sandboxed renderer) in ${ROOT}. The contract is the section "## 0.5 features (contracts)" of ${ROOT}/ARCHITECTURE.md (read the rules, the behaviours split across packages, the ownership table, the extension points, S1 to S15 and the package sections). Fifteen packages have just been built in this checkout by engineers working two at a time; their notes are ${PLAN}/build/PKG-*.md and their reports follow (JSON; a null report means that engineer stopped without one: check what their files hold). The skeleton's hand-offs are ${PLAN}/build/HANDOFF-1.md to HANDOFF-5.md and the starting counts are in ${PLAN}/build/BASELINE.md. The lessons of 0.4's integration are in /tmp/claude-0/-home-user-claude/02aa60de-818c-5d38-b2f3-33055ac112a1/scratchpad/plan04/build/INTEGRATION-04.md and HUNT-04.md: most 0.4 hunt bugs were behaviours split between two packages that neither owned whole.

The round is over, so the ownership rules no longer bind you: you may edit any file, keeping each change minimal and in the style of the module it touches. Do not run git commands that change anything.

1. Work through every report's integratorNeeds and every PKG note's requests for the integrator: make the changes that are sound, and for the rest say why not.
2. Remove every skip and flip every gate that waits for another 0.5 package (the reports' waitingSkips; grep the new specs for skips and S15 flags) whose capability has now landed; the landed branch must then pass. Check that every S15 flag is true for a package that landed, and that app.stubbed holds only the 0.6 stubs.
3. Check every row of "Behaviours split across packages" end to end with both halves real, and the joins between packages that only met at integration: the brush engine with the Brush Settings panel, the painting behaviours, tool presets, .abr and .tpl; the colour engine with the picker, swatches, Info, Camera Raw, saves and exports in every format; PSD layers and PSD text together on one file, and .asl / .csh through the PSD mappers; fonts with the type commands, PSD text, missing fonts and the Character panel; Camera Raw's workspace with its nine tabs, smart filters and Last Filter; the preset files with every panel that imports them; the shortcuts editor over every key and menu reader, the native menu included; the Move tool's handles with Free Transform, snapping and links. Fix what is broken.
4. Run the whole unit suite, the whole e2e suite (\`cd ${ROOT} && PIGMENT_E2E_PORT=8850 PIGMENT_E2E_OUT=tests/e2e/.artifacts-integrate npx playwright test -c tests/e2e/playwright.config.mjs --trace off\`) and the Electron tests (\`xvfb-run -a npx playwright test -c tests/electron/playwright.config.mjs --output tests/e2e/.artifacts-integrate/electron --trace off\`). Fix every failure at its root: no skipping, no widened tolerances, no added retries or longer timeouts unless the timing really is the defect. Repeat until all three are green. A test that fails once and then passes with --repeat-each 3 is flaky: name it, with the full error text.
5. Start the app in the headless harness (copy ${SMOKE} into ${PLAN}/build/smoke-integrate/, \`PORT=8950 timeout 300 node smoke.mjs $PWD/check.mjs\`) and check for console errors on start-up, on opening every new panel and dialog, and on a typical edit in each package's area. Check the packaged build's extra files (wasm, fonts, vendor entries) are in the electron-builder file list and load in the Electron tests.
6. Write ${PLAN}/build/INTEGRATION-05.md: what you changed and why, the gates flipped and skips removed, the final counts, and what is still open, by package.

Final answer: the structured report only.

Reports:
${JSON.stringify(built)}`, { label: 'integrate', phase: 'Integrate', schema: INTEGRATE_REPORT, effort: 'high' })

return { built: built.map((p) => ({ name: p.name, landed: !!p.report, notDone: p.report?.notDone?.length ?? null, integratorNeeds: p.report?.integratorNeeds?.length ?? null })), integrated }
