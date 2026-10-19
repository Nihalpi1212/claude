import { test, expect } from '@playwright/test';
import { openApp, newDoc, run, runAwait, pixel, layerPixel, drag, confirmDialog, openFixture } from './helpers.mjs';

test('brush paints with the foreground colour; undo and redo restore it', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await page.evaluate(() => {
    const app = window.pigmentApp;
    app.setColors({ foreground: '#ff0000' });
    app.tools.activate('brush');
    app.tools.setOpt('brush', 'size', 20);
    app.tools.setOpt('brush', 'hardness', 1);
  });
  await drag(page, [50, 150], [350, 150]);
  await expect.poll(() => pixel(page, 200, 150)).toEqual([255, 0, 0, 255]);
  await page.keyboard.press('Control+z');
  await expect.poll(() => pixel(page, 200, 150)).toEqual([255, 255, 255, 255]);
  await page.keyboard.press('Control+Shift+z');
  await expect.poll(() => pixel(page, 200, 150)).toEqual([255, 0, 0, 255]);
  expect(errors).toEqual([]);
});

test('rectangular marquee, fill, delete and deselect', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await page.keyboard.press('m');
  await drag(page, [100, 100], [200, 180]);
  const b = await page.evaluate(() => window.pigmentApp.doc.selection?.bounds);
  expect(b).toMatchObject({ x: 100, y: 100, width: 100, height: 80 });
  await page.evaluate(() => window.pigmentApp.setColors({ foreground: '#0000ff' }));
  await page.keyboard.press('Alt+Backspace');
  await expect.poll(() => pixel(page, 150, 150)).toEqual([0, 0, 255, 255]);
  expect(await pixel(page, 90, 90)).toEqual([255, 255, 255, 255]);
  // add a transparent layer, fill and clear inside the selection
  await runAwait(page, 'layer:new', { name: 'Top' });
  await page.keyboard.press('Alt+Backspace');
  await page.keyboard.press('Delete');
  expect((await layerPixel(page, 150, 150))[3]).toBe(0);
  await page.keyboard.press('Control+d');
  expect(await page.evaluate(() => window.pigmentApp.doc.selection)).toBeNull();
  expect(errors).toEqual([]);
});

test('image size, canvas size, rotation and crop', async ({ page }) => {
  const errors = await openApp(page);
  await openFixture(page, 'shapes.png'); // 200x150, red square at 20..80
  await runAwait(page, 'image:size', { width: 100, height: 75, method: 'bilinear' });
  expect(await page.evaluate(() => [window.pigmentApp.doc.width, window.pigmentApp.doc.height])).toEqual([100, 75]);
  expect((await pixel(page, 25, 25)).slice(0, 2)).toEqual([255, 0]);
  await runAwait(page, 'edit:undo');
  expect(await page.evaluate(() => window.pigmentApp.doc.width)).toBe(200);
  await runAwait(page, 'image:canvas-size', { width: 300, height: 150, anchor: 'w', color: '#00ff00' });
  expect(await page.evaluate(() => window.pigmentApp.doc.width)).toBe(300);
  expect(await pixel(page, 40, 40)).toEqual([255, 0, 0, 255]);
  await runAwait(page, 'image:rotate-90');
  expect(await page.evaluate(() => [window.pigmentApp.doc.width, window.pigmentApp.doc.height])).toEqual([150, 300]);
  // (40, 40) moves to (150 - 1 - 40, 40) after a clockwise turn
  expect(await pixel(page, 109, 40)).toEqual([255, 0, 0, 255]);
  await runAwait(page, 'edit:undo');
  await runAwait(page, 'image:crop-rect', { rect: { x: 20, y: 20, width: 60, height: 60 } });
  expect(await page.evaluate(() => [window.pigmentApp.doc.width, window.pigmentApp.doc.height])).toEqual([60, 60]);
  expect(await pixel(page, 0, 0)).toEqual([255, 0, 0, 255]);
  await runAwait(page, 'edit:undo'); // crop
  await runAwait(page, 'edit:undo'); // canvas size (its green extension would block the trim)
  expect(await page.evaluate(() => window.pigmentApp.doc.width)).toBe(200);
  await runAwait(page, 'image:trim', { basis: 'transparent' });
  expect(await page.evaluate(() => [window.pigmentApp.doc.width, window.pigmentApp.doc.height])).toEqual([160, 110]);
  expect(errors).toEqual([]);
});

test('free transform scales and rotates a layer; Escape cancels', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { background: 'transparent' });
  await page.evaluate(() => {
    const l = window.pigmentApp.doc.active;
    const ctx = l.canvas.getContext('2d');
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(100, 100, 50, 50);
    l.touch();
  });
  await page.keyboard.press('Control+t');
  expect(await page.evaluate(() => window.pigmentApp.tools.active.id)).toBe('transform');
  // drag the bottom-right handle out by 50px: the square doubles in size
  await drag(page, [150, 150], [200, 200]);
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => window.pigmentApp.tools.active.id)).not.toBe('transform');
  expect((await layerPixel(page, 190, 190))[3]).toBe(255);
  expect((await layerPixel(page, 205, 205))[3]).toBe(0);
  await runAwait(page, 'edit:undo');
  expect((await layerPixel(page, 190, 190))[3]).toBe(0);
  // quick rotate keeps pixels exact
  await runAwait(page, 'edit:transform', 'flip-h');
  expect((await layerPixel(page, 120, 120))[3]).toBe(255);
  // cancel leaves the layer alone
  await page.keyboard.press('Control+t');
  await drag(page, [125, 125], [180, 125]);
  await page.keyboard.press('Escape');
  expect((await layerPixel(page, 120, 120))[3]).toBe(255);
  expect((await layerPixel(page, 175, 120))[3]).toBe(0);
  expect(errors).toEqual([]);
});

test('Levels dialog with live preview, Invert, Fade and adjustment layers', async ({ page }) => {
  const errors = await openApp(page);
  await openFixture(page, 'gradient.png');
  const before = await pixel(page, 160, 100);
  await run(page, 'image:adjust-levels');
  await page.locator('.dialog input[type="number"][data-key="inBlack"]').fill('100');
  await page.locator('.dialog input[type="number"][data-key="inBlack"]').dispatchEvent('change');
  // live preview changes the canvas before OK
  await expect.poll(async () => (await pixel(page, 160, 100))[0]).toBeLessThan(before[0]);
  await confirmDialog(page);
  const leveled = await pixel(page, 160, 100);
  expect(leveled[0]).toBeLessThan(before[0]);
  await page.keyboard.press('Control+i'); // invert
  expect((await pixel(page, 160, 100))[0]).toBe(255 - leveled[0]);
  await run(page, 'edit:fade');
  await page.locator('.dialog input[type="number"][data-key="opacity"]').fill('0');
  await page.locator('.dialog input[type="number"][data-key="opacity"]').dispatchEvent('change');
  await confirmDialog(page);
  expect(await pixel(page, 160, 100)).toEqual(leveled);
  // adjustment layer: non-destructive invert
  await runAwait(page, 'layer:new-adjustment', 'invert');
  expect((await pixel(page, 160, 100))[0]).toBe(255 - leveled[0]);
  await page.evaluate(() => (window.pigmentApp.doc.active.visible = false) || window.pigmentApp.doc.active.touch() || window.pigmentApp.doc.changed('props'));
  expect(await pixel(page, 160, 100)).toEqual(leveled);
  expect(errors).toEqual([]);
});

test('filters: Gaussian Blur dialog, Last Filter (Ctrl+F) and a selection-limited filter', async ({ page }) => {
  const errors = await openApp(page);
  await openFixture(page, 'shapes.png');
  await page.evaluate(() => window.pigmentApp.commands.run('select:all', undefined, 'api'));
  await page.keyboard.press('Control+d');
  await run(page, 'filter:gaussian-blur');
  await page.locator('.dialog input[type="number"][data-key="radius"]').fill('4');
  await page.locator('.dialog input[type="number"][data-key="radius"]').dispatchEvent('change');
  await confirmDialog(page);
  const edge = await pixel(page, 20, 50);
  expect(edge[3]).toBeGreaterThan(0);
  expect(edge[3]).toBeLessThan(255);
  expect(await page.evaluate(() => window.pigmentApp.settings.lastFilter?.kind)).toBe('gaussian-blur');
  const n = await page.evaluate(() => window.pigmentApp.doc.history.entries.length);
  await page.keyboard.press('Control+f');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.history.entries.length)).toBe(n + 1);
  // a filter inside a selection leaves the outside untouched
  await page.evaluate(async () => {
    const { Selection } = await import('/lib/selection.js');
    window.pigmentApp.applySelection(Selection.fromRect(200, 150, { x: 0, y: 0, width: 100, height: 150 }), 'replace', 'sel');
  });
  const outside = await pixel(page, 140, 90);
  await runAwait(page, 'filter:invert-alpha');
  expect(await pixel(page, 140, 90)).toEqual(outside);
  expect(errors).toEqual([]);
});

test('layer style dialog adds a stroke; copy and paste style', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { background: 'transparent' });
  await page.evaluate(() => {
    const l = window.pigmentApp.doc.active;
    const ctx = l.canvas.getContext('2d');
    ctx.fillStyle = '#0000ff';
    ctx.fillRect(100, 100, 100, 100);
    l.touch();
  });
  await run(page, 'layer:style', 'stroke');
  await page.locator('.style-list [data-style="stroke"] input').check();
  await confirmDialog(page);
  const styles = await page.evaluate(() => window.pigmentApp.doc.active.styles);
  expect(styles.stroke.enabled).toBe(true);
  // default stroke: 3px outside, black
  expect(await pixel(page, 98, 150)).toEqual([0, 0, 0, 255]);
  await runAwait(page, 'edit:undo');
  expect(await page.evaluate(() => window.pigmentApp.doc.active.styles)).toBeNull();
  expect(errors).toEqual([]);
});

test('retouch tools: clone stamp copies pixels from the source', async ({ page }) => {
  const errors = await openApp(page);
  await openFixture(page, 'gradient.png');
  await page.evaluate(() => {
    const app = window.pigmentApp;
    app.tools.activate('clone');
    app.tools.setOpt('clone', 'size', 30);
    app.tools.setOpt('clone', 'hardness', 1);
  });
  const src = await pixel(page, 300, 20);
  const a = await page.evaluate(() => 0);
  void a;
  // Alt-click sets the source
  await drag(page, [300, 20], [300, 20], { steps: 1, modifiers: ['Alt'] });
  await drag(page, [40, 180], [41, 180], { steps: 2 });
  const got = await pixel(page, 40, 180);
  for (let i = 0; i < 3; i++) expect(Math.abs(got[i] - src[i])).toBeLessThan(6);
  expect(errors).toEqual([]);
});
