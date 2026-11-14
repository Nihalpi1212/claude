// Regression tests for bugs found in review.
import { test, expect } from '@playwright/test';
import { openApp, newDoc, run, runAwait, pixel, layerPixel, drag, confirmDialog } from './helpers.mjs';

test('quick mask belongs to its document and ends cleanly when undo removes it', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { name: 'A' });
  await page.keyboard.press('q');
  expect(await page.evaluate(() => !!window.pigmentApp.view.quickMask)).toBe(true);
  await newDoc(page, { name: 'B' });
  // Q in B starts B's own quick mask; A keeps its own
  await page.keyboard.press('q');
  const state = await page.evaluate(() => window.pigmentApp.docs.list().map((d) => [d.name, d.layers().map((l) => l.name), !!d.view.quickMask]));
  expect(state).toEqual([['A', ['Background', 'Quick Mask'], true], ['B', ['Background', 'Quick Mask'], true]]);
  await page.keyboard.press('q');
  expect(await page.evaluate(() => window.pigmentApp.doc.layers().map((l) => l.name))).toEqual(['Background']);
  // saving A never writes the quick mask layer
  await page.evaluate(() => window.pigmentApp.docs.activate(window.pigmentApp.docs.list()[0]));
  const described = await page.evaluate(() => window.pigmentApp.doc.describe().layers.map((l) => l.name));
  expect(described).toEqual(['Background']);
  // structural changes and undo while quick mask is on keep the mask layer on top and active
  await runAwait(page, 'layer:new', { name: 'L1' });
  await page.evaluate(() => window.pigmentApp.doc.setActive(window.pigmentApp.doc.layers().find((l) => l.quickMask)));
  await runAwait(page, 'edit:undo');
  expect(await page.evaluate(() => window.pigmentApp.doc.layers().map((l) => l.name))).toEqual(['Background', 'Quick Mask']);
  expect(await page.evaluate(() => window.pigmentApp.doc.active.quickMask)).toBe(true);
  await page.keyboard.press('q');
  expect(await page.evaluate(() => window.pigmentApp.doc.layers().some((l) => l.quickMask))).toBe(false);
  // nothing brings it back afterwards
  await runAwait(page, 'edit:undo');
  await runAwait(page, 'edit:redo');
  expect(await page.evaluate(() => window.pigmentApp.doc.layers().some((l) => l.quickMask))).toBe(false);
  expect(errors).toEqual([]);
});

test('Fade is not offered after undo and a new action', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await runAwait(page, 'image:adjust-invert');
  expect(await page.evaluate(() => window.pigmentApp.commands.isEnabled('edit:fade'))).toBe(true);
  await runAwait(page, 'edit:undo');
  await runAwait(page, 'layer:new', { name: 'X' });
  expect(await page.evaluate(() => window.pigmentApp.commands.isEnabled('edit:fade'))).toBe(false);
  expect(errors).toEqual([]);
});

test('redo after a transform keeps a stroke that grew the layer', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 300, height: 300, background: 'transparent' });
  await page.evaluate(() => {
    const l = window.pigmentApp.doc.active;
    l.canvas.getContext('2d').fillStyle = '#00ff00';
    l.canvas.getContext('2d').fillRect(0, 0, 200, 200);
    l.touch();
  });
  await page.keyboard.press('Control+t');
  await drag(page, [200, 200], [100, 100]);
  await page.keyboard.press('Enter');
  await page.evaluate(() => {
    const app = window.pigmentApp;
    app.setColors({ foreground: '#ff0000' });
    app.tools.activate('brush');
    app.tools.setOpt('brush', 'size', 20);
    app.tools.setOpt('brush', 'hardness', 1);
  });
  await drag(page, [150, 150], [160, 160]);
  await expect.poll(() => pixel(page, 155, 155)).toEqual([255, 0, 0, 255]);
  for (const c of ['edit:undo', 'edit:undo', 'edit:redo', 'edit:redo']) await runAwait(page, c);
  expect(await pixel(page, 155, 155)).toEqual([255, 0, 0, 255]);
  expect(errors).toEqual([]);
});

test('commands during Free Transform apply it first; undo cancels it', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { background: 'transparent' });
  await page.evaluate(() => {
    const l = window.pigmentApp.doc.active;
    l.canvas.getContext('2d').fillStyle = '#0000ff';
    l.canvas.getContext('2d').fillRect(10, 10, 50, 50);
    l.touch();
  });
  await page.keyboard.press('Control+t');
  await drag(page, [30, 30], [130, 30]);
  await runAwait(page, 'layer:new', { name: 'After' });
  const names = await page.evaluate(() => window.pigmentApp.doc.layers().map((l) => l.name));
  expect(names).not.toContain('Transform');
  expect(await page.evaluate(() => window.pigmentApp.tools.active.id)).not.toBe('transform');
  // the move was applied
  expect((await pixel(page, 120, 30))[2]).toBe(255);
  // Ctrl+T then Undo only cancels the transform
  await page.evaluate(() => window.pigmentApp.doc.setActive(window.pigmentApp.doc.layers()[0]));
  const before = await page.evaluate(() => window.pigmentApp.doc.history.index);
  await page.keyboard.press('Control+t');
  await page.keyboard.press('Control+z');
  expect(await page.evaluate(() => window.pigmentApp.doc.history.index)).toBe(before);
  expect(errors).toEqual([]);
});

test('canvas size keeps a selection where it was', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 200, height: 200 });
  await page.evaluate(async () => {
    const { Selection } = await import('/lib/selection.js');
    window.pigmentApp.applySelection(Selection.fromRect(200, 200, { x: 0, y: 0, width: 20, height: 20 }), 'replace', 's');
  });
  await runAwait(page, 'image:canvas-size', { width: 300, height: 300, anchor: 'nw' });
  expect(await page.evaluate(() => window.pigmentApp.doc.selection.bounds)).toMatchObject({ x: 0, y: 0, width: 20, height: 20 });
  expect(errors).toEqual([]);
});

test('global light and the work path are saved', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    d.globalLight = { angle: 30, altitude: 60 };
    d.workPath = { subpaths: [{ closed: true, points: [{ x: 1, y: 1 }, { x: 50, y: 1 }, { x: 50, y: 50 }] }] };
    window.__pigmentTest.nextSavePath = 'mem:/gl.pigment';
  });
  await runAwait(page, 'file:save-as');
  await page.evaluate(() => (window.__pigmentTest.files['mem:/gl2.pigment'] = window.__pigmentTest.written['mem:/gl.pigment']));
  await runAwait(page, 'file:open-paths', ['mem:/gl2.pigment']);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.path)).toBe('mem:/gl2.pigment');
  expect(await page.evaluate(() => [window.pigmentApp.doc.globalLight, window.pigmentApp.doc.workPath?.subpaths?.[0]?.points.length])).toEqual([{ angle: 30, altitude: 60 }, 3]);
  expect(errors).toEqual([]);
});

test('moving a group moves its children and undo puts them back', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { background: 'transparent' });
  await page.evaluate(() => {
    const l = window.pigmentApp.doc.active;
    l.canvas.getContext('2d').fillStyle = '#ff00ff';
    l.canvas.getContext('2d').fillRect(10, 10, 20, 20);
    l.touch();
    window.pigmentApp.commands.run('layer:group', undefined, 'api');
  });
  await page.keyboard.press('v');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  expect((await pixel(page, 40, 20))[3]).toBe(255);
  await runAwait(page, 'edit:undo');
  await runAwait(page, 'edit:undo');
  expect((await pixel(page, 40, 20))[3]).toBe(0);
  expect((await pixel(page, 20, 20))[3]).toBe(255);
  expect(errors).toEqual([]);
});
