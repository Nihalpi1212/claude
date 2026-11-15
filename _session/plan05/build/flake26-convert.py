#!/usr/bin/env python3
"""Flake #26 fix: runAwait settles from a fresh task, and the direct command evaluates go through it.

Usage: python3 flake26-convert.py <pigment root> [--check]
--check reports what would change without writing. Every replacement must match exactly the expected number
of times, or nothing is written.

Root cause (verified, workflow wf_3fcad5ac-a15): Chromium 141's V8 14.1 inspector holds the promise that an
awaiting Runtime.callFunctionOn waits for weakly. CommandRegistry.dispatch (src/renderer/lib/commands.js) attaches
`.finally(() => app.emit('commands:changed'))` to a command's promise. That job runs after Playwright's
utility-script promise fulfils and before the inspector's reaction does, and its listeners allocate. A GC in that
gap collects the fulfilled promise and page.evaluate fails with "Promise was collected", which Playwright reports
as "Execution context was destroyed, most likely because of a navigation". runAwait now awaits the command and
then waits one macrotask, so the evaluate settles after the app's microtasks have drained. commands.run's own
default source is 'api', so a call that passed no source keeps it.
"""
import sys, pathlib

root = pathlib.Path(sys.argv[1])
check = '--check' in sys.argv[2:]
E2E = root / 'tests' / 'e2e'

OLD_RUN_AWAIT = "export const runAwait = (page, cmd, arg) => page.evaluate(([c, a]) => window.pigmentApp.commands.run(c, a, 'api'), [cmd, arg]);"
NEW_RUN_AWAIT = """export const runAwait = (page, cmd, arg, source = 'api') =>
  page.evaluate(async ([c, a, s]) => {
    try {
      return await window.pigmentApp.commands.run(c, a, s);
    } finally {
      // V8 14.1 (Chromium 141) holds an awaited evaluate promise weakly: a GC in an app microtask after it settles
      // (dispatch's .finally -> 'commands:changed') fails it with "Promise was collected". Settle from a fresh task.
      await new Promise((r) => setTimeout(r, 0));
    }
  }, [cmd, arg, source]);"""

R = "window.pigmentApp.commands.run"
# (file, old text, new text, expected count)
EDITS = [
    ('helpers.mjs', OLD_RUN_AWAIT, NEW_RUN_AWAIT, 1),
    ('actions.spec.mjs',
     f"const play = (page, name) => page.evaluate((n) => {R}('actions:play', {{ action: n }}, 'api'), name);",
     "const play = (page, name) => runAwait(page, 'actions:play', { action: name });", 1),
    ('conventions-shortcuts-fields.spec.mjs',
     f"await page.evaluate(() => {R}('view:zoom-out', undefined, 'menu-key'));",
     "await runAwait(page, 'view:zoom-out', undefined, 'menu-key');", 1),
    ('editing.spec.mjs',
     f"await page.evaluate(() => {R}('select:all', undefined, 'api'));",
     "await runAwait(page, 'select:all');", 1),
    ('extras3.spec.mjs',
     f"await page.evaluate((p) => {R}('select:find-layers', p), patch);",
     "await runAwait(page, 'select:find-layers', patch);", 1),
    ('finish-layer-menu.spec.mjs',
     f"await page.evaluate((s) => {R}('layer:new', undefined, s), source);",
     "await runAwait(page, 'layer:new', undefined, source);", 1),
    ('finish-layer-menu.spec.mjs',
     f"await page.evaluate((id) => {R}('layer:visibility', id, 'panel'), bid);",
     "await runAwait(page, 'layer:visibility', bid, 'panel');", 1),
    ('guides-snapping.spec.mjs',
     f"await page.evaluate(() => {R}('view:clear-selected-guides', undefined, 'menu'));",
     "await runAwait(page, 'view:clear-selected-guides', undefined, 'menu');", 1),
    ('hunt4-review-sessions.spec.mjs',
     f"await page.evaluate(() => {R}('layer:new', undefined, 'panel'));",
     "await runAwait(page, 'layer:new', undefined, 'panel');", 1),
    ('hunt4-review-sessions.spec.mjs',
     f"await page.evaluate(() => {R}('layer:opacity', 40, 'panel'));",
     "await runAwait(page, 'layer:opacity', 40, 'panel');", 1),
    ('hunt5-files-history.spec.mjs',
     f"await page.evaluate(() => {R}('layer:shape-properties', {{ props: {{ radii: [10, 10, 10, 10] }} }}, 'menu'));",
     "await runAwait(page, 'layer:shape-properties', { props: { radii: [10, 10, 10, 10] } }, 'menu');", 1),
    ('hunt5-files-history.spec.mjs',
     f"const played = await page.evaluate(() => {R}('actions:play', {{ action: 'Make layers' }}, 'api'));",
     "const played = await runAwait(page, 'actions:play', { action: 'Make layers' });", 1),
    ('masks-vector-masks.spec.mjs',
     f"await page.evaluate((p) => {R}('layer:vector-mask', {{ op: 'current-path', path: p }}, 'api'), rect(0, 0, 100, 60));",
     "await runAwait(page, 'layer:vector-mask', { op: 'current-path', path: rect(0, 0, 100, 60) });", 1),
    ('masks-vector-masks.spec.mjs',
     f"await page.evaluate((p) => {R}('layer:vector-mask', {{ op: 'current-path', path: p }}, 'api'), rect(10, 10, 30, 30));",
     "await runAwait(page, 'layer:vector-mask', { op: 'current-path', path: rect(10, 10, 30, 30) });", 2),
    ('masks-vector-masks.spec.mjs',
     f"await page.evaluate((p) => {R}('layer:vector-mask', {{ op: 'current-path', path: p }}, 'api'), rect(0, 0, 100, 40));",
     "await runAwait(page, 'layer:vector-mask', { op: 'current-path', path: rect(0, 0, 100, 40) });", 1),
    ('masks-vector-masks.spec.mjs',
     f"await page.evaluate((p) => {R}('layer:vector-mask', {{ op: 'current-path', path: p }}, 'api'), rect(10, 10, 50, 40));",
     "await runAwait(page, 'layer:vector-mask', { op: 'current-path', path: rect(10, 10, 50, 40) });", 1),
    ('masks-vector-masks.spec.mjs',
     f"await page.evaluate(() => {R}('path:select', {{ kind: 'work' }}, 'api'));",
     "await runAwait(page, 'path:select', { kind: 'work' });", 1),
    ('modes.spec.mjs',
     f"expect(await page.evaluate(() => {R}('image:mode', 'grayscale', 'action'))).toBe(true);",
     "expect(await runAwait(page, 'image:mode', 'grayscale', 'action')).toBe(true);", 1),
    ('modes.spec.mjs',
     f"expect(await page.evaluate(() => {R}('image:mode', 'bitmap', 'action'))).toBe(true);",
     "expect(await runAwait(page, 'image:mode', 'bitmap', 'action')).toBe(true);", 1),
    ('review5.spec.mjs',
     f"const played = await page.evaluate(() => {R}('actions:play', {{ action: 'Bold type' }}, 'api'));",
     "const played = await runAwait(page, 'actions:play', { action: 'Bold type' });", 1),
    ('skeleton-05.spec.mjs',
     f"await page.evaluate(() => {R}('edit:undo', undefined, 'api'));",
     "await runAwait(page, 'edit:undo');", 1),
    ('type-editing.spec.mjs',
     f"await page.evaluate(() => {R}('image:auto-tone', undefined, 'menu-key'));",
     "await runAwait(page, 'image:auto-tone', undefined, 'menu-key');", 1),
    ('type-editing.spec.mjs',
     f"await page.evaluate(() => {R}('edit:undo', undefined, 'menu'));",
     "await runAwait(page, 'edit:undo', undefined, 'menu');", 1),
]

texts, bad = {}, []
for name, old, new, n in EDITS:
    p = E2E / name
    s = texts.setdefault(name, p.read_text())
    found = s.count(old)
    if found != n:
        bad.append(f'{name}: expected {n}, found {found}: {old[:110]}')
        continue
    texts[name] = s.replace(old, new)

# every spec that now calls runAwait must import it
for name, s in texts.items():
    if name != 'helpers.mjs' and 'runAwait(' in s:
        imp = [l for l in s.splitlines() if l.startswith('import ') and "from './helpers.mjs'" in l]
        if not imp or 'runAwait' not in imp[0]:
            bad.append(f'{name}: does not import runAwait from ./helpers.mjs')

# what is left: direct evaluates that still return a command promise
import re
left = []
for p in sorted(E2E.glob('*.mjs')):
    s = texts.get(p.name, p.read_text())
    for i, l in enumerate(s.splitlines(), 1):
        if re.search(r"evaluate\(\s*(\([^)]*\)|\w+)\s*=>\s*(window\.)?pigmentApp\.commands\.run\(", l):
            left.append(f'{p.name}:{i}: {l.strip()[:140]}')

if bad:
    print('NOT APPLIED, mismatches:'); print('\n'.join(bad)); sys.exit(1)
changed = [n for n in texts if texts[n] != (E2E / n).read_text()]
print(f'{"would change" if check else "changed"} {len(changed)} files, {sum(n for *_, n in EDITS)} sites: {", ".join(changed)}')
if left:
    print('direct command evaluates still left:'); print('\n'.join(left))
if not check:
    for n in changed:
        (E2E / n).write_text(texts[n])
