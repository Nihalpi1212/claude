// finish-layer-menu (ARCHITECTURE.md "0.4 features", package 15): the New Layer, New Group, Duplicate Layer and Lock
// dialogs and when they open (M.3), the property commands on every selected layer, Arrange, Distribute, links, the
// merges and stamps behind Ctrl+E, layer navigation, the digit, `/` and blend-mode keys, Select Similar Layers, the
// Rasterize arguments and the Background rules (L.13).
import { test, expect } from '@playwright/test';
import { openApp, newDoc, runAwait, run, confirmDialog, pixel, historyLength } from './helpers.mjs';

const OWN_IDS = [
  'layer:merge', 'layer:merge-group', 'layer:new-no-dialog', 'layer:arrange-reverse', 'layer:lock-dialog', 'layer:lock-group',
  'layer:lock-transparency-toggle', 'layer:stamp-visible', 'layer:stamp-selected', 'layer:select-forward', 'layer:select-backward',
  'layer:select-front', 'layer:select-back', 'layer:select-add-forward', 'layer:select-add-backward', 'layer:select-similar',
  ...'0123456789'.split('').flatMap((d) => [`layer:opacity-digit-${d}`, `layer:fill-digit-${d}`]),
  'layer:blend-next', 'layer:blend-prev', 'layer:blend-mode-normal', 'layer:blend-mode-soft-light', 'layer:blend-mode-pass-through',
];

/** A document with a white Background and painted layers { name, color, x, y, w, h } (bottom to top). */
async function build(page, layers = [], size = { width: 200, height: 120 }) {
  await newDoc(page, size);
  await page.evaluate(async (list) => {
    const app = window.pigmentApp;
    const { RasterLayer, createCanvas } = await import('/lib/document.js');
    const d = app.doc;
    for (const s of list) {
      const c = createCanvas(d.width, d.height);
      const ctx = c.getContext('2d');
      ctx.fillStyle = s.color ?? '#ff0000';
      ctx.fillRect(s.x ?? 0, s.y ?? 0, s.w ?? 10, s.h ?? 10);
      const l = new RasterLayer({ name: s.name, canvas: c, x: 0, y: 0 });
      d.add(l, d.root, d.root.children.length);
      d.setActive(l);
    }
    d.history.markSaved();
  }, layers);
}

const names = (page) => page.evaluate(() => window.pigmentApp.doc.root.children.map((l) => l.name));
const active = (page) => page.evaluate(() => window.pigmentApp.doc.active?.name ?? null);
const select = (page, ...list) => page.evaluate((ns) => {
  const d = window.pigmentApp.doc;
  const ls = ns.map((n) => d.layers().find((l) => l.name === n));
  d.setActive(ls[ls.length - 1]);
  for (const l of ls) d.selected.add(l);
  d.changed('active', { layer: d.active });
}, list);
const prop = (page, name, key) => page.evaluate(([n, k]) => {
  const l = window.pigmentApp.doc.layers().find((x) => x.name === n);
  return JSON.parse(JSON.stringify(l[k] ?? null));
}, [name, key]);
/** Collects 'command:done' events from now on. */
const watchDone = (page) => page.evaluate(() => {
  window.__done = [];
  window.pigmentApp.on('command:done', (e) => window.__done.push({ id: e.id, arg: e.arg ?? null, replayId: e.replayId ?? null, cancelled: e.cancelled, source: e.source }));
});
const done = (page, id) => page.evaluate((i) => window.__done.filter((e) => e.id === i), id);
const dialogTitle = (page) => page.locator('.dialog-backdrop .dialog').last();
const notBusy = (page) => page.waitForFunction(() => !document.body.classList.contains('busy'));
/** Keys go to the document's shortcuts, not to a field. */
const unfocus = (page) => page.evaluate(() => document.activeElement?.blur?.());

test('every finish-layer-menu command is a real registration, not a stub', async ({ page }) => {
  const errors = await openApp(page);
  const r = await page.evaluate((ids) => ids.map((id) => [id, window.pigmentApp.commands.has(id), window.pigmentApp.stubbed.includes(id), !!window.pigmentApp.commands.commands.get(id)?.stub]), OWN_IDS);
  for (const [id, has, stubbed, stub] of r) expect([id, has, stubbed, stub]).toEqual([id, true, false, false]);
  expect(await page.evaluate(() => typeof window.pigmentApp.layerDialogs?.newLayer)).toBe('function');
  expect(errors).toEqual([]);
});

test('New Layer opens its dialog from the menu and the key only; the dialog sets name, clipping, colour, mode, opacity and a neutral fill', async ({ page }) => {
  const errors = await openApp(page);
  await build(page, [{ name: 'Base', x: 0, y: 0, w: 200, h: 120, color: '#336699' }]);
  // the API, an action and the panel create without asking (0.3 behaviour)
  for (const source of ['api', 'action', 'panel', 'toolbar']) {
    await page.evaluate((s) => window.pigmentApp.commands.run('layer:new', undefined, s), source);
    await expect(page.locator('.dialog-backdrop')).toHaveCount(0);
    await page.waitForTimeout(60); // the same command from two sources at once runs once (commands.js de-duplication)
  }
  expect(await names(page)).toEqual(['Background', 'Base', 'Layer 1', 'Layer 2', 'Layer 3', 'Layer 4']);
  await watchDone(page);
  // Shift+Ctrl+N from the keyboard opens it
  await unfocus(page);
  await page.keyboard.press('Control+Shift+N');
  await expect(dialogTitle(page)).toContainText('New Layer');
  await page.keyboard.press('Escape');
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0);
  await expect.poll(() => done(page, 'layer:new')).toEqual([{ id: 'layer:new', arg: null, replayId: null, cancelled: true, source: 'key' }]);
  expect((await names(page)).length).toBe(6);
  // from the menu: fill in every field
  await page.evaluate(() => window.pigmentApp.doc.setActive(window.pigmentApp.doc.layers().find((l) => l.name === 'Base')));
  // a menu command while a dialog is still open is ignored, and the same command from another source within 40 ms is
  // taken for the same key press (commands.js): wait for both
  await page.waitForFunction(() => !window.pigmentApp.dialogs.isOpen);
  await page.waitForTimeout(60);
  await page.evaluate(() => void window.pigmentApp.commands.run('layer:new', undefined, 'menu'));
  await expect(dialogTitle(page)).toContainText('New Layer');
  const dlg = dialogTitle(page);
  await dlg.locator('input[data-key="name"]').fill('Shade');
  await dlg.locator('input[data-key="clip"]').check();
  await dlg.locator('select[data-key="color"]').selectOption('green');
  await dlg.locator('select[data-key="blend"]').selectOption('overlay');
  await expect(dlg.locator('input[data-key="neutral"]')).toBeEnabled();
  await expect(dlg).toContainText('Fill with Overlay-neutral color (50% gray)');
  await dlg.locator('input[data-key="opacity"]').fill('60');
  await dlg.locator('input[data-key="opacity"]').press('Tab');
  await dlg.locator('input[data-key="neutral"]').check();
  await confirmDialog(page);
  await expect.poll(() => active(page)).toBe('Shade');
  const shade = await page.evaluate(() => {
    const l = window.pigmentApp.doc.active;
    return { blend: l.blend, opacity: l.opacity, clip: l.clip, color: l.color, px: Array.from(l.canvas.getContext('2d').getImageData(3, 3, 1, 1).data), above: l.parent.children[l.parent.children.indexOf(l) - 1].name };
  });
  expect(shade).toEqual({ blend: 'overlay', opacity: 0.6, clip: true, color: 'green', px: [128, 128, 128, 255], above: 'Base' });
  // a neutral overlay changes nothing on screen
  const seen = await pixel(page, 50, 50);
  expect(Math.max(...[0x33, 0x66, 0x99, 255].map((v, i) => Math.abs(v - seen[i])))).toBeLessThanOrEqual(1);
  // what the dialog applied is the replay argument: an action replays it without asking
  const recorded = (await done(page, 'layer:new')).at(-1);
  expect(recorded).toEqual({ id: 'layer:new', arg: { name: 'Shade', clip: true, color: 'green', blend: 'overlay', opacity: 60, neutral: true }, replayId: null, cancelled: false, source: 'menu' });
  // { dialog: true } asks from any source; below: true puts the layer under the active one
  await run(page, 'layer:new', { dialog: true, below: true });
  await expect(dialogTitle(page)).toContainText('New Layer');
  await expect(dialogTitle(page).locator('input[data-key="neutral"]')).toBeDisabled();
  await confirmDialog(page);
  await expect.poll(async () => (await names(page)).indexOf('Layer 5')).toBe((await names(page)).indexOf('Shade') - 1);
  // the replay argument creates without the dialog
  await runAwait(page, 'layer:new', recorded.arg);
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0);
  expect(await page.evaluate(() => [window.pigmentApp.doc.active.name, window.pigmentApp.doc.active.blend])).toEqual(['Shade', 'overlay']);
  expect(errors).toEqual([]);
});

test('New Group and Duplicate Layer dialogs: settings, destinations, replay', async ({ page }) => {
  const errors = await openApp(page);
  await build(page, [{ name: 'Red', color: '#ff0000', x: 10, y: 10, w: 30, h: 30 }]);
  await watchDone(page);
  await run(page, 'layer:new-group', { dialog: true });
  await expect(dialogTitle(page)).toContainText('New Group');
  const g = dialogTitle(page);
  await g.locator('input[data-key="name"]').fill('Set');
  await g.locator('select[data-key="blend"]').selectOption('multiply');
  await g.locator('select[data-key="color"]').selectOption('blue');
  await confirmDialog(page);
  await expect.poll(() => active(page)).toBe('Set');
  expect(await page.evaluate(() => [window.pigmentApp.doc.active.type, window.pigmentApp.doc.active.blend, window.pigmentApp.doc.active.color])).toEqual(['group', 'multiply', 'blue']);
  expect((await done(page, 'layer:new-group')).at(-1).arg).toEqual({ name: 'Set', color: 'blue', blend: 'multiply' });
  // the API never asks
  await runAwait(page, 'layer:new-group');
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0);

  // Duplicate Layer: As, into this document
  await select(page, 'Red');
  await page.evaluate(() => void window.pigmentApp.commands.run('layer:duplicate', undefined, 'menu'));
  await expect(dialogTitle(page)).toContainText('Duplicate Layer');
  await expect(dialogTitle(page)).toContainText('Duplicate: Red');
  await expect(dialogTitle(page).locator('input[data-key="name"]')).toHaveValue('Red copy');
  await dialogTitle(page).locator('input[data-key="name"]').fill('Red twin');
  await confirmDialog(page);
  await expect.poll(() => active(page)).toBe('Red twin');
  expect((await done(page, 'layer:duplicate')).at(-1).arg).toEqual({ name: 'Red twin' });
  // into a new document of the same size, holding only the copy
  const before = await page.evaluate(() => window.pigmentApp.docs.docs.length);
  await page.evaluate(() => void window.pigmentApp.commands.run('layer:duplicate', undefined, 'menu'));
  await dialogTitle(page).locator('select[data-key="destination"]').selectOption('new');
  await dialogTitle(page).locator('input[data-key="documentName"]').fill('Copies');
  await confirmDialog(page);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.docs.docs.length)).toBe(before + 1);
  const nd = await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    return { name: d.name, size: [d.width, d.height], layers: d.layers().map((l) => l.name) };
  });
  expect(nd).toEqual({ name: 'Copies', size: [200, 120], layers: ['Red twin copy'] });
  expect((await done(page, 'layer:duplicate')).at(-1).arg).toEqual({ name: 'Red twin copy', destination: 'new', documentName: 'Copies' });
  // into another open document by name, as an action replays it: the copy goes on top of its stack, with undo there
  await page.evaluate(() => window.pigmentApp.docs.activate(window.pigmentApp.docs.docs[0]));
  await select(page, 'Red');
  await runAwait(page, 'layer:duplicate', { destination: 'Copies' });
  const other = await page.evaluate(() => {
    const d = window.pigmentApp.docs.docs.find((x) => x.name === 'Copies');
    return { layers: d.layers().map((l) => l.name), undo: d.history.entries[d.history.index]?.label };
  });
  expect(other).toEqual({ layers: ['Red twin copy', 'Red'], undo: 'Duplicate layer' });
  expect(errors).toEqual([]);
});

test('New Fill Layer from the menu asks the New Layer questions first, then the paint', async ({ page }) => {
  const errors = await openApp(page);
  await build(page, [{ name: 'Base', color: '#00ff00', x: 0, y: 0, w: 200, h: 120 }]);
  await watchDone(page);
  await page.evaluate(() => void window.pigmentApp.commands.run('layer:new-fill', 'solid', 'menu'));
  await expect(dialogTitle(page)).toContainText('New Layer');
  await expect(dialogTitle(page).locator('input[data-key="name"]')).toHaveValue('Color Fill 1');
  await expect(dialogTitle(page).locator('input[data-key="neutral"]')).toHaveCount(0);
  await dialogTitle(page).locator('input[data-key="name"]').fill('Tint');
  await dialogTitle(page).locator('select[data-key="blend"]').selectOption('multiply');
  await page.locator('.dialog-backdrop .dialog-buttons .btn.primary').last().click();
  // the colour picker comes next
  await expect(dialogTitle(page)).toContainText('Solid Color Fill');
  await confirmDialog(page);
  await expect.poll(() => active(page)).toBe('Tint');
  expect(await page.evaluate(() => [window.pigmentApp.doc.active.type, window.pigmentApp.doc.active.blend])).toEqual(['fill', 'multiply']);
  const ev = (await done(page, 'layer:new-fill')).at(-1);
  expect(ev.arg).toMatchObject({ kind: 'solid', name: 'Tint', blend: 'multiply' });
  expect(ev.arg.paint).toBeTruthy();
  // replayed: no dialog at all
  await runAwait(page, 'layer:new-fill', ev.arg);
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0);
  expect(await page.evaluate(() => [window.pigmentApp.doc.active.name, window.pigmentApp.doc.active.blend])).toEqual(['Tint', 'multiply']);
  expect(errors).toEqual([]);
});

test('property commands act on every selected layer in one history entry; scrubbing merges; ids name the layers', async ({ page }) => {
  const errors = await openApp(page);
  await build(page, [{ name: 'A' }, { name: 'B' }, { name: 'C' }]);
  await select(page, 'A', 'C');
  const n = await historyLength(page);
  await runAwait(page, 'layer:opacity', 40);
  await runAwait(page, 'layer:opacity', 30); // a drag: merges into the same entry
  expect(await historyLength(page)).toBe(n + 1);
  expect([await prop(page, 'A', 'opacity'), await prop(page, 'B', 'opacity'), await prop(page, 'C', 'opacity')]).toEqual([0.3, 1, 0.3]);
  await runAwait(page, 'layer:fill-opacity', { ids: await page.evaluate(() => [window.pigmentApp.doc.layers().find((l) => l.name === 'B').id]), value: 20 });
  expect(await prop(page, 'B', 'fillOpacity')).toBe(0.2);
  await runAwait(page, 'layer:blend', 'screen');
  expect([await prop(page, 'A', 'blend'), await prop(page, 'B', 'blend'), await prop(page, 'C', 'blend')]).toEqual(['screen', 'normal', 'screen']);
  await runAwait(page, 'layer:lock', 'position');
  expect([(await prop(page, 'A', 'locked')).position, (await prop(page, 'C', 'locked')).position]).toEqual([true, true]);
  // Ctrl+, hides the selected layers (the opposite of the active one's state), and again shows them
  await unfocus(page);
  await select(page, 'A', 'C');
  const h = await historyLength(page);
  await page.keyboard.press('Control+,');
  await expect.poll(() => prop(page, 'A', 'visible')).toBe(false);
  expect([await prop(page, 'B', 'visible'), await prop(page, 'C', 'visible')]).toEqual([true, false]);
  expect(await historyLength(page)).toBe(h + 1);
  await page.keyboard.press('Control+z');
  await expect.poll(() => prop(page, 'C', 'visible')).toBe(true);
  expect(await prop(page, 'A', 'visible')).toBe(true);
  // the panel's eye passes one id: that layer alone toggles (0.3)
  const bid = await page.evaluate(() => window.pigmentApp.doc.layers().find((l) => l.name === 'B').id);
  await page.evaluate((id) => window.pigmentApp.commands.run('layer:visibility', id, 'panel'), bid);
  expect([await prop(page, 'A', 'visible'), await prop(page, 'B', 'visible')]).toEqual([true, false]);
  expect(errors).toEqual([]);
});

test('Arrange moves several layers together, Reverse turns them round; nothing goes below the Background', async ({ page }) => {
  const errors = await openApp(page);
  await build(page, [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }]);
  await select(page, 'A', 'C');
  await runAwait(page, 'layer:arrange-front');
  expect(await names(page)).toEqual(['Background', 'B', 'D', 'A', 'C']);
  await runAwait(page, 'layer:arrange-back');
  expect(await names(page)).toEqual(['Background', 'A', 'C', 'B', 'D']);
  // each one step up; a picked layer never jumps over another picked one
  await runAwait(page, 'layer:arrange-forward');
  expect(await names(page)).toEqual(['Background', 'B', 'A', 'C', 'D']);
  await runAwait(page, 'layer:arrange-backward');
  expect(await names(page)).toEqual(['Background', 'A', 'C', 'B', 'D']);
  // A is right above the Background: neither goes further down
  await runAwait(page, 'layer:arrange-backward');
  expect(await names(page)).toEqual(['Background', 'A', 'C', 'B', 'D']);
  await select(page, 'A', 'B', 'D');
  await runAwait(page, 'layer:arrange-reverse');
  expect(await names(page)).toEqual(['Background', 'D', 'C', 'B', 'A']);
  await unfocus(page);
  await page.keyboard.press('Control+z');
  await expect.poll(() => names(page)).toEqual(['Background', 'A', 'C', 'B', 'D']);
  // the Background does not move
  await select(page, 'Background');
  await runAwait(page, 'layer:arrange-front');
  expect(await names(page)).toEqual(['Background', 'A', 'C', 'B', 'D']);
  expect(await page.locator('.toast').last().textContent()).toContain('Background');
  expect(errors).toEqual([]);
});

test('Distribute: edges, centres and equal gaps; Align and Distribute move linked layers along', async ({ page }) => {
  const errors = await openApp(page);
  await build(page, [
    { name: 'L', x: 0, y: 0, w: 10, h: 10 },
    { name: 'M', x: 30, y: 40, w: 20, h: 20 },
    { name: 'R', x: 150, y: 80, w: 40, h: 10 },
    { name: 'Tag', x: 30, y: 100, w: 5, h: 5 },
  ]);
  const box = (n) => page.evaluate((name) => {
    const l = window.pigmentApp.doc.layers().find((x) => x.name === name);
    return l.x;
  }, n);
  await select(page, 'L', 'M', 'R');
  // left edges 0, 30, 150 -> 0, 75, 150
  await runAwait(page, 'layer:distribute', 'left');
  expect(await box('M')).toBe(45);
  await page.keyboard.press('Control+z');
  await expect.poll(() => box('M')).toBe(0);
  // equal gaps: span 0..190, widths 70 -> gaps 60: M starts at 70
  await runAwait(page, 'layer:distribute', 'horizontal');
  expect(await box('M')).toBe(40);
  await page.keyboard.press('Control+z');
  await expect.poll(() => box('M')).toBe(0);
  // top edges 0, 40, 80 are even already: nothing moves, nothing is recorded
  const n = await historyLength(page);
  await runAwait(page, 'layer:distribute', 'top');
  expect(await historyLength(page)).toBe(n);
  // link Tag to M: aligning M moves Tag by the same amount
  await select(page, 'M', 'Tag');
  await runAwait(page, 'layer:link');
  await select(page, 'L', 'M');
  await runAwait(page, 'layer:align', 'left');
  expect([await box('M'), await box('Tag')]).toEqual([-30, -30]);
  expect(errors).toEqual([]);
});

test('Lock Layers… (Ctrl+/) and Lock All Layers in Group…; / toggles Lock Transparent Pixels', async ({ page }) => {
  const errors = await openApp(page);
  await build(page, [{ name: 'A' }, { name: 'B' }]);
  await select(page, 'A', 'B');
  await watchDone(page);
  await unfocus(page);
  await select(page, 'A', 'B');
  await page.keyboard.press('Control+/');
  await expect(dialogTitle(page)).toContainText('Lock Layers');
  await dialogTitle(page).locator('input[data-key="position"]').check();
  await dialogTitle(page).locator('input[data-key="pixels"]').check();
  await confirmDialog(page);
  await expect.poll(() => prop(page, 'A', 'locked')).toEqual({ pixels: true, position: true, transparency: false, all: false });
  expect(await prop(page, 'B', 'locked')).toEqual({ pixels: true, position: true, transparency: false, all: false });
  expect((await done(page, 'layer:lock-dialog')).at(-1).arg).toEqual({ transparency: false, pixels: true, position: true, all: false });
  // a group's layers
  await runAwait(page, 'layer:group');
  await runAwait(page, 'layer:lock-group', { all: true, position: false, pixels: false });
  expect([(await prop(page, 'A', 'locked')).all, (await prop(page, 'B', 'locked')).all, (await prop(page, 'Group 1', 'locked')).all]).toEqual([true, true, false]);
  // `/` with the Move tool
  await runAwait(page, 'layer:lock-group', { all: false });
  await select(page, 'A');
  await page.evaluate(() => window.pigmentApp.tools.activate('move'));
  await page.keyboard.press('/');
  await expect.poll(async () => (await prop(page, 'A', 'locked')).transparency).toBe(true);
  await page.keyboard.press('/');
  await expect.poll(async () => (await prop(page, 'A', 'locked')).transparency).toBe(false);
  expect(errors).toEqual([]);
});

test('Ctrl+E merges the selected layers and an action records layer:merge-selected; Merge Group; Merge Down', async ({ page }) => {
  const errors = await openApp(page);
  await build(page, [{ name: 'A', x: 0, y: 0, color: '#ff0000' }, { name: 'B', x: 20, y: 0, color: '#00ff00' }, { name: 'C', x: 40, y: 0, color: '#0000ff' }]);
  await select(page, 'A', 'B');
  const action = await page.evaluate(() => {
    const a = window.pigmentApp.actions.newAction({ name: 'Merge test' });
    window.pigmentApp.actions.record(a);
    return a.id;
  });
  await unfocus(page);
  await page.keyboard.press('Control+e');
  await expect.poll(() => names(page)).toEqual(['Background', 'B', 'C']);
  const steps = await page.evaluate((id) => {
    const acts = window.pigmentApp.actions;
    acts.stopRecording();
    const found = acts.sets.flatMap((s) => s.actions).find((a) => a.id === id);
    return found.steps.map((s) => s.command);
  }, action);
  expect(steps).toEqual(['layer:merge-selected']);
  expect(await pixel(page, 5, 5)).toEqual([255, 0, 0, 255]);
  expect(await pixel(page, 25, 5)).toEqual([0, 255, 0, 255]);
  // Merge Group: the group becomes one layer of its name; its opacity stays live
  await select(page, 'C');
  await runAwait(page, 'layer:group');
  await runAwait(page, 'layer:opacity', 50);
  await watchDone(page);
  await page.keyboard.press('Control+e');
  await expect.poll(() => names(page)).toEqual(['Background', 'B', 'Group 1']);
  expect(await page.evaluate(() => [window.pigmentApp.doc.active.type, window.pigmentApp.doc.active.opacity])).toEqual(['raster', 0.5]);
  expect((await done(page, 'layer:merge')).map((e) => e.replayId)).toEqual(['layer:merge-group']);
  // one layer: Merge Down, as in 0.3
  await page.keyboard.press('Control+e');
  await expect.poll(() => names(page)).toEqual(['Background', 'B']);
  expect((await done(page, 'layer:merge')).map((e) => e.replayId)).toEqual(['layer:merge-group', 'layer:merge-down']);
  expect(errors).toEqual([]);
});

test('Stamp Visible and Stamp Layers keep the layers they read', async ({ page }) => {
  const errors = await openApp(page);
  await build(page, [{ name: 'A', x: 0, y: 0, color: '#ff0000' }, { name: 'B', x: 20, y: 0, color: '#00ff00' }]);
  await runAwait(page, 'layer:stamp-visible');
  expect(await names(page)).toEqual(['Background', 'A', 'B', 'Layer 1']);
  const stamp = await page.evaluate(() => {
    const ctx = window.pigmentApp.doc.active.canvas.getContext('2d');
    return [Array.from(ctx.getImageData(5, 5, 1, 1).data), Array.from(ctx.getImageData(25, 5, 1, 1).data), Array.from(ctx.getImageData(100, 100, 1, 1).data)];
  });
  expect(stamp).toEqual([[255, 0, 0, 255], [0, 255, 0, 255], [255, 255, 255, 255]]);
  await page.keyboard.press('Control+z');
  await expect.poll(() => names(page)).toEqual(['Background', 'A', 'B']);
  // several layers: a merged copy above the topmost
  await select(page, 'A', 'B');
  await runAwait(page, 'layer:stamp-selected');
  expect(await names(page)).toEqual(['Background', 'A', 'B', 'B (merged)']);
  await page.keyboard.press('Control+z');
  // one layer: stamped down into the layer below, which keeps its name; the layer stays
  await select(page, 'B');
  await runAwait(page, 'layer:stamp-selected');
  expect(await names(page)).toEqual(['Background', 'A', 'B']);
  const a = await page.evaluate(() => {
    const l = window.pigmentApp.doc.layers().find((x) => x.name === 'A');
    return Array.from(l.canvas.getContext('2d').getImageData(25, 5, 1, 1).data);
  });
  expect(a).toEqual([0, 255, 0, 255]);
  expect(await active(page)).toBe('B');
  // the keys
  await unfocus(page);
  await page.keyboard.press('Control+Alt+Shift+E');
  await expect.poll(() => names(page)).toEqual(['Background', 'A', 'B', 'Layer 1']);
  expect(errors).toEqual([]);
});

test('layer navigation keys, Select Similar Layers', async ({ page }) => {
  const errors = await openApp(page);
  await build(page, [{ name: 'A' }, { name: 'B' }, { name: 'C' }]);
  await runAwait(page, 'layer:new-fill', { kind: 'solid', paint: { type: 'solid', color: '#123456' } });
  await page.evaluate(() => window.pigmentApp.tools.activate('move'));
  await unfocus(page);
  await select(page, 'B');
  await page.keyboard.press('Alt+]');
  await expect.poll(() => active(page)).toBe('C');
  await page.keyboard.press('Alt+[');
  await page.keyboard.press('Alt+[');
  await expect.poll(() => active(page)).toBe('A');
  await page.keyboard.press('Alt+.');
  await expect.poll(() => active(page)).toBe('Color Fill 1');
  await page.keyboard.press('Alt+,');
  await expect.poll(() => active(page)).toBe('Background');
  await page.keyboard.press('Alt+[');
  await expect.poll(() => active(page)).toBe('Color Fill 1'); // wraps round
  await select(page, 'A');
  await page.keyboard.press('Shift+Alt+]');
  await page.keyboard.press('Shift+Alt+]');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.selectedLayers().map((l) => l.name))).toEqual(['C', 'B', 'A']);
  expect(await active(page)).toBe('C');
  await runAwait(page, 'layer:select-similar');
  expect(await page.evaluate(() => window.pigmentApp.doc.selectedLayers().map((l) => l.name))).toEqual(['C', 'B', 'A', 'Background']);
  await select(page, 'Color Fill 1');
  await runAwait(page, 'layer:select-similar');
  expect(await page.evaluate(() => window.pigmentApp.doc.selectedLayers().map((l) => l.name))).toEqual(['Color Fill 1']);
  expect(errors).toEqual([]);
});

test('opacity and fill digits (not while a painting tool is active), blend-mode keys and Shift+= / Shift+-', async ({ page }) => {
  const errors = await openApp(page);
  await build(page, [{ name: 'A' }, { name: 'B' }]);
  await page.evaluate(() => window.pigmentApp.tools.activate('move'));
  await unfocus(page);
  await select(page, 'A', 'B');
  const n = await historyLength(page);
  await page.keyboard.press('5');
  await expect.poll(() => prop(page, 'A', 'opacity')).toBe(0.5);
  expect(await prop(page, 'B', 'opacity')).toBe(0.5);
  // two quick digits: the exact value, in the same history entry
  await page.waitForTimeout(700);
  await page.keyboard.press('4');
  await page.keyboard.press('5');
  await expect.poll(() => prop(page, 'B', 'opacity')).toBe(0.45);
  expect(await historyLength(page)).toBe(n + 2);
  await page.waitForTimeout(700);
  await page.keyboard.press('0');
  await expect.poll(() => prop(page, 'B', 'opacity')).toBe(1);
  await page.keyboard.press('Shift+3');
  await expect.poll(() => prop(page, 'B', 'fillOpacity')).toBe(0.3);
  // a painting tool keeps the digits for itself (0.5): the layer does not change
  await page.evaluate(() => window.pigmentApp.tools.activate('brush'));
  await page.waitForTimeout(700);
  await page.keyboard.press('2');
  await page.waitForTimeout(100);
  expect(await prop(page, 'B', 'opacity')).toBe(1);
  // blend-mode keys and stepping through the modes
  await page.evaluate(() => window.pigmentApp.tools.activate('move'));
  await page.keyboard.press('Shift+Alt+M');
  await expect.poll(() => prop(page, 'B', 'blend')).toBe('multiply');
  expect(await prop(page, 'A', 'blend')).toBe('multiply');
  await page.keyboard.press('Shift+=');
  await expect.poll(() => prop(page, 'B', 'blend')).toBe('color-burn');
  await page.keyboard.press('Shift+-');
  await page.keyboard.press('Shift+-');
  await expect.poll(() => prop(page, 'B', 'blend')).toBe('darken');
  await page.keyboard.press('Shift+Alt+N');
  await expect.poll(() => prop(page, 'B', 'blend')).toBe('normal');
  // a text field keeps its digits
  await page.evaluate(() => {
    const i = document.createElement('input');
    i.id = 'probe';
    document.body.appendChild(i);
    i.focus();
  });
  await page.keyboard.press('3');
  await page.waitForTimeout(100);
  expect(await prop(page, 'B', 'opacity')).toBe(1);
  expect(errors).toEqual([]);
});

test('Rasterize honours its argument and the selected layers', async ({ page }) => {
  const errors = await openApp(page);
  await build(page, [{ name: 'Pix' }]);
  await runAwait(page, 'layer:new-fill', { kind: 'solid', paint: { type: 'solid', color: '#123456' } });
  await page.evaluate(async () => {
    const app = window.pigmentApp;
    await app.commands.run('layer:new-fill', { kind: 'solid', paint: { type: 'solid', color: '#654321' } }, 'api');
  });
  const types = () => page.evaluate(() => window.pigmentApp.doc.layers().map((l) => `${l.name}:${l.type}`));
  await select(page, 'Pix', 'Color Fill 1', 'Color Fill 2');
  await runAwait(page, 'layer:rasterize', 'type'); // no text layer selected: nothing
  expect(await types()).toEqual(['Background:raster', 'Pix:raster', 'Color Fill 1:fill', 'Color Fill 2:fill']);
  await runAwait(page, 'layer:rasterize', 'fill');
  expect(await types()).toEqual(['Background:raster', 'Pix:raster', 'Color Fill 1:raster', 'Color Fill 2:raster']);
  expect(await page.evaluate(() => window.pigmentApp.doc.history.entries[window.pigmentApp.doc.history.index].label)).toBe('Rasterize layers');
  expect(await page.evaluate(() => window.pigmentApp.doc.selectedLayers().map((l) => l.name))).toEqual(['Color Fill 2', 'Color Fill 1', 'Pix']);
  expect(errors).toEqual([]);
});

test('Background rules: it stays at the bottom, out of groups, with its opacity, mode and masks locked; Layer from Background and renaming lift them', async ({ page }) => {
  const errors = await openApp(page);
  await build(page, [{ name: 'A' }, { name: 'B' }]);
  const rules = await page.evaluate(() => {
    const app = window.pigmentApp, d = app.doc;
    const bg = d.root.children[0], a = d.layers().find((l) => l.name === 'A');
    return { locks: app.backgroundRules.lockedProps(bg), other: app.backgroundRules.lockedProps(a), up: app.backgroundRules.canPlace(d, [bg], a, 'above'), under: app.backgroundRules.canPlace(d, [a], bg, 'below'), over: app.backgroundRules.canPlace(d, [a], bg, 'above') };
  });
  expect(rules).toEqual({ locks: ['blend', 'opacity', 'fillOpacity', 'mask', 'vectorMask', 'styles', 'position'], other: [], up: false, under: false, over: true });
  const ids = await page.evaluate(() => Object.fromEntries(window.pigmentApp.doc.layers().map((l) => [l.name, l.id])));
  // moving below it, or moving it, is refused
  await runAwait(page, 'layer:move-to', { id: ids.B, target: ids.Background, mode: 'below' });
  await runAwait(page, 'layer:move-to', { id: ids.Background, target: ids.B, mode: 'above' });
  expect(await names(page)).toEqual(['Background', 'A', 'B']);
  // Send to Back stops above it
  await select(page, 'B');
  await runAwait(page, 'layer:arrange-back');
  expect(await names(page)).toEqual(['Background', 'B', 'A']);
  // grouping leaves it out
  await select(page, 'Background', 'A');
  await runAwait(page, 'layer:group');
  expect(await names(page)).toEqual(['Background', 'B', 'Group 1']);
  // its opacity and mode stay; a mask turns it into an ordinary layer first, in one step
  await select(page, 'Background');
  await runAwait(page, 'layer:opacity', 40);
  await runAwait(page, 'layer:blend', 'multiply');
  expect([await prop(page, 'Background', 'opacity'), await prop(page, 'Background', 'blend')]).toEqual([1, 'normal']);
  const n = await historyLength(page);
  await runAwait(page, 'layer:mask', 'reveal-all');
  expect(await names(page)).toEqual(['Layer 0', 'B', 'Group 1']);
  expect(await page.evaluate(() => !!window.pigmentApp.doc.root.children[0].mask)).toBe(true);
  expect(await historyLength(page)).toBe(n + 1);
  await page.keyboard.press('Control+z');
  await expect.poll(() => names(page)).toEqual(['Background', 'B', 'Group 1']);
  // renaming lifts the rules: now it may move
  const bg = await page.evaluate(() => window.pigmentApp.doc.root.children[0].id);
  await runAwait(page, 'layer:rename', { id: bg, name: 'Paper' });
  await runAwait(page, 'layer:opacity', 40);
  expect(await prop(page, 'Paper', 'opacity')).toBe(0.4);
  expect(await page.evaluate((id) => window.pigmentApp.backgroundRules.lockedProps(window.pigmentApp.doc.find(id)), bg)).toEqual([]);
  await select(page, 'Paper');
  await runAwait(page, 'layer:arrange-front');
  expect(await names(page)).toEqual(['B', 'Group 1', 'Paper']);
  await notBusy(page);
  expect(errors).toEqual([]);
});
