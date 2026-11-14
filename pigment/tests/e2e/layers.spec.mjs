import { test, expect } from '@playwright/test';
import { openApp, newDoc, run, runAwait, pixel, layerPixel, drag, confirmDialog } from './helpers.mjs';

const names = (page) => page.evaluate(() => window.pigmentApp.doc.layers().map((l) => l.name));

test('new, duplicate, group, ungroup, merge down and flatten', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await runAwait(page, 'layer:new', { name: 'A' });
  await page.evaluate(() => {
    const l = window.pigmentApp.doc.active;
    const ctx = l.canvas.getContext('2d');
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(10, 10, 50, 50);
    l.touch();
  });
  await page.keyboard.press('Control+j'); // layer via copy (no selection = duplicate)
  expect((await names(page)).length).toBe(3);
  await runAwait(page, 'layer:select', 'all');
  await page.keyboard.press('Control+g');
  expect(await page.evaluate(() => window.pigmentApp.doc.root.children.some((l) => l.isGroup))).toBe(true);
  await page.keyboard.press('Control+Shift+g');
  expect(await page.evaluate(() => window.pigmentApp.doc.root.children.some((l) => l.isGroup))).toBe(false);
  const count = (await names(page)).length;
  await page.evaluate(() => window.pigmentApp.doc.setActive(window.pigmentApp.doc.root.children.at(-1)));
  await page.keyboard.press('Control+e'); // merge down
  expect((await names(page)).length).toBe(count - 1);
  await runAwait(page, 'image:flatten');
  expect((await names(page)).length).toBe(1);
  expect(await pixel(page, 20, 20)).toEqual([255, 0, 0, 255]);
  await runAwait(page, 'edit:undo');
  expect((await names(page)).length).toBe(count - 1);
  expect(errors).toEqual([]);
});

test('layer mask hides pixels, painting the mask black hides more, and blend modes composite', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await runAwait(page, 'layer:new', { name: 'Blue' });
  await page.evaluate(() => {
    const l = window.pigmentApp.doc.active;
    const ctx = l.canvas.getContext('2d');
    ctx.fillStyle = '#0000ff';
    ctx.fillRect(0, 0, 400, 300);
    l.touch();
  });
  await page.keyboard.press('m');
  await drag(page, [0, 0], [200, 300]);
  await runAwait(page, 'layer:mask', 'reveal-selection');
  await page.keyboard.press('Control+d');
  expect(await pixel(page, 100, 100)).toEqual([0, 0, 255, 255]);
  expect(await pixel(page, 300, 100)).toEqual([255, 255, 255, 255]);
  // paint black on the mask with the brush
  await page.evaluate(() => {
    const app = window.pigmentApp;
    app.setEditingMask(true);
    app.setColors({ foreground: '#000000' });
    app.tools.activate('brush');
    app.tools.setOpt('brush', 'size', 30);
    app.tools.setOpt('brush', 'hardness', 1);
  });
  await drag(page, [100, 50], [100, 250]);
  await expect.poll(() => pixel(page, 100, 150)).toEqual([255, 255, 255, 255]);
  expect(await pixel(page, 50, 150)).toEqual([0, 0, 255, 255]);
  await page.evaluate(() => window.pigmentApp.setEditingMask(false));
  // multiply blue over white keeps blue; screen turns white
  await runAwait(page, 'layer:blend', 'screen');
  expect(await pixel(page, 50, 150)).toEqual([255, 255, 255, 255]);
  await runAwait(page, 'layer:blend', 'difference');
  expect(await pixel(page, 50, 150)).toEqual([255, 255, 0, 255]);
  await runAwait(page, 'layer:opacity', 50);
  const half = await pixel(page, 50, 150);
  expect(Math.abs(half[2] - 128)).toBeLessThan(3);
  expect(errors).toEqual([]);
});

test('magic wand, inverse, feather dialog, quick mask and color range', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await page.evaluate(() => {
    const l = window.pigmentApp.doc.active;
    const ctx = l.canvas.getContext('2d');
    ctx.fillStyle = '#00aa00';
    ctx.fillRect(50, 50, 100, 100);
    l.touch();
  });
  await page.keyboard.press('w');
  await page.evaluate(() => window.pigmentApp.tools.activate('wand'));
  await drag(page, [100, 100], [100, 100], { steps: 1 });
  expect(await page.evaluate(() => window.pigmentApp.doc.selection?.bounds)).toMatchObject({ x: 50, y: 50, width: 100, height: 100 });
  await page.keyboard.press('Control+Shift+i');
  expect(await page.evaluate(() => window.pigmentApp.doc.selection.bounds)).toMatchObject({ x: 0, y: 0, width: 400, height: 300 });
  await page.keyboard.press('Control+Shift+i');
  await run(page, 'select:feather');
  await page.locator('.dialog input[type="number"]').first().fill('5');
  await page.locator('.dialog input[type="number"]').first().dispatchEvent('change');
  await confirmDialog(page);
  const edge = await page.evaluate(() => {
    const s = window.pigmentApp.doc.selection;
    return [s.mask[100 * 400 + 50], s.mask[100 * 400 + 100]];
  });
  expect(edge[0]).toBeGreaterThan(40);
  expect(edge[0]).toBeLessThan(220);
  expect(edge[1]).toBe(255);
  await page.keyboard.press('q');
  expect(await page.evaluate(() => !!window.pigmentApp.view.quickMask)).toBe(true);
  await page.keyboard.press('q');
  expect(await page.evaluate(() => !!window.pigmentApp.view.quickMask)).toBe(false);
  expect(await page.evaluate(() => !!window.pigmentApp.doc.selection)).toBe(true);
  await page.keyboard.press('Control+d');
  await page.evaluate(() => window.pigmentApp.setColors({ foreground: '#00aa00' }));
  await run(page, 'select:color-range');
  await confirmDialog(page);
  expect(await page.evaluate(() => window.pigmentApp.doc.selection?.bounds)).toMatchObject({ x: 50, y: 50, width: 100, height: 100 });
  expect(errors).toEqual([]);
});

test('move tool drags a layer; crop tool crops; gradient tool fills', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { background: 'transparent' });
  await page.evaluate(() => {
    const l = window.pigmentApp.doc.active;
    const ctx = l.canvas.getContext('2d');
    ctx.fillStyle = '#ff00ff';
    ctx.fillRect(10, 10, 40, 40);
    l.touch();
  });
  await page.keyboard.press('v');
  await drag(page, [30, 30], [130, 80]);
  expect((await pixel(page, 120, 70))[3]).toBe(255);
  expect((await pixel(page, 20, 20))[3]).toBe(0);
  await page.keyboard.press('c');
  await drag(page, [100, 50], [300, 250]);
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => [window.pigmentApp.doc.width, window.pigmentApp.doc.height])).toEqual([200, 200]);
  expect(await pixel(page, 20, 20)).toEqual([255, 0, 255, 255]);
  await runAwait(page, 'layer:new', { name: 'G' });
  await page.evaluate(() => {
    const app = window.pigmentApp;
    app.setColors({ foreground: '#000000', background: '#ffffff' });
    app.tools.activate('gradient');
  });
  await drag(page, [0, 100], [199, 100]);
  const left = await layerPixel(page, 2, 100), right = await layerPixel(page, 197, 100);
  expect(left[0]).toBeLessThan(20);
  expect(right[0]).toBeGreaterThan(235);
  expect(errors).toEqual([]);
});
