// Regression tests for the bugs found by the bug hunt.
import { test, expect } from '@playwright/test';
import { openApp, newDoc, run, runAwait, pixel, layerPixel, drag, confirmDialog, screenPoint } from './helpers.mjs';

const paintSquare = (page, color, x, y, w, h) =>
  page.evaluate(([c, px, py, pw, ph]) => {
    const l = window.pigmentApp.doc.active;
    const ctx = l.canvas.getContext('2d');
    ctx.fillStyle = c;
    ctx.fillRect(px - l.x, py - l.y, pw, ph);
    l.touch();
    window.pigmentApp.doc.changed('pixels', { layer: l });
  }, [color, x, y, w, h]);

const selectRect = (page, r) =>
  page.evaluate(async (rect) => {
    const { Selection } = await import('/lib/selection.js');
    const d = window.pigmentApp.doc;
    window.pigmentApp.applySelection(Selection.fromRect(d.width, d.height, rect), 'replace', 'sel');
  }, r);

test('a mouse paints at the full brush size and slow strokes are continuous', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await page.evaluate(() => {
    const app = window.pigmentApp;
    app.setColors({ foreground: '#ff0000' });
    app.tools.activate('brush');
    app.tools.setOpt('brush', 'size', 40);
    app.tools.setOpt('brush', 'hardness', 1);
    app.tools.setOpt('brush', 'pressureSize', true);
  });
  // a single click: the dab must be ~40 px wide, not 20
  await drag(page, [200, 100], [200, 100], { steps: 1 });
  await expect.poll(() => pixel(page, 200, 100)).toEqual([255, 0, 0, 255]);
  expect((await pixel(page, 217, 100))[0]).toBe(255);
  expect((await pixel(page, 183, 100))[0]).toBe(255);
  // a slow stroke (one screen pixel per event) paints the whole line
  const a = await screenPoint(page, 50, 200), b = await screenPoint(page, 350, 200);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: Math.round(b.x - a.x) });
  await page.mouse.up();
  for (const x of [100, 200, 300, 345]) expect((await pixel(page, x, 200))[0]).toBe(255);
  expect(errors).toEqual([]);
});

test('paint bucket and gradient work on a layer smaller than the document', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { background: 'transparent' });
  await runAwait(page, 'layer:new', { name: 'Small' });
  await paintSquare(page, '#00ff00', 100, 100, 50, 50);
  await page.evaluate(() => {
    // shrink the layer canvas to its content
    const l = window.pigmentApp.doc.active;
    const c = document.createElement('canvas');
    c.width = 50;
    c.height = 50;
    c.getContext('2d').drawImage(l.canvas, -100, -100);
    l.canvas = c;
    l.x = 100;
    l.y = 100;
    l.touch();
    window.pigmentApp.setColors({ foreground: '#0000ff' });
    window.pigmentApp.tools.activate('bucket');
  });
  await drag(page, [300, 250], [300, 250], { steps: 1 });
  await expect.poll(() => pixel(page, 300, 250)).toEqual([0, 0, 255, 255]);
  await runAwait(page, 'edit:undo');
  await page.evaluate(() => window.pigmentApp.tools.activate('gradient'));
  await drag(page, [0, 20], [399, 20]);
  await expect.poll(async () => (await pixel(page, 380, 20))[3]).toBe(255);
  expect(errors).toEqual([]);
});

test('fill lands on the selection after Rotate 90 and Flip (no leaked canvas transform)', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await runAwait(page, 'image:rotate-90');
  await selectRect(page, { x: 20, y: 30, width: 60, height: 30 });
  await page.evaluate(() => window.pigmentApp.setColors({ foreground: '#ff0000' }));
  await page.keyboard.press('Alt+Backspace');
  await expect.poll(() => pixel(page, 50, 45)).toEqual([255, 0, 0, 255]);
  expect(await pixel(page, 250, 45)).toEqual([255, 255, 255, 255]);
  await runAwait(page, 'edit:transform', 'flip-h');
  await selectRect(page, { x: 100, y: 100, width: 40, height: 40 });
  await page.keyboard.press('Alt+Backspace');
  await expect.poll(() => pixel(page, 120, 120)).toEqual([255, 0, 0, 255]);
  expect(errors).toEqual([]);
});

test('Reselect after Image Size brings back a selection of the new size', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await selectRect(page, { x: 100, y: 100, width: 200, height: 100 });
  await page.keyboard.press('Control+d');
  await runAwait(page, 'image:size', { width: 200, height: 150, method: 'bilinear' });
  await page.keyboard.press('Control+Shift+d');
  const s = await page.evaluate(() => {
    const sel = window.pigmentApp.doc.selection;
    return sel ? { w: sel.width, h: sel.height, b: sel.bounds } : null;
  });
  expect([s.w, s.h]).toEqual([200, 150]);
  // resampled edges may be one pixel soft
  expect(Math.abs(s.b.x - 50)).toBeLessThanOrEqual(1);
  expect(Math.abs(s.b.y - 50)).toBeLessThanOrEqual(1);
  expect(Math.abs(s.b.width - 100)).toBeLessThanOrEqual(2);
  expect(Math.abs(s.b.height - 50)).toBeLessThanOrEqual(2);
  expect(errors).toEqual([]);
});

test('Edit > Fill with black on a layer mask hides, with white reveals', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await runAwait(page, 'layer:new', { name: 'Red' });
  await paintSquare(page, '#ff0000', 0, 0, 400, 300);
  await runAwait(page, 'layer:mask', 'reveal-all');
  await page.evaluate(() => window.pigmentApp.setEditingMask(true));
  await selectRect(page, { x: 20, y: 20, width: 60, height: 60 });
  await runAwait(page, 'edit:fill', { use: 'black' });
  await expect.poll(() => pixel(page, 50, 50)).toEqual([255, 255, 255, 255]);
  expect(await pixel(page, 150, 150)).toEqual([255, 0, 0, 255]);
  await runAwait(page, 'edit:fill', { use: 'grey' });
  const half = await pixel(page, 50, 50);
  expect(Math.abs(half[1] - 128)).toBeLessThan(6);
  await runAwait(page, 'edit:fill', { use: 'white' });
  await expect.poll(() => pixel(page, 50, 50)).toEqual([255, 0, 0, 255]);
  expect(errors).toEqual([]);
});

test('marquee: Shift adds without forcing a square; Alt subtracts without centring', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await page.keyboard.press('m');
  await drag(page, [50, 50], [150, 100]);
  await drag(page, [200, 50], [300, 80], { modifiers: ['Shift'] });
  expect(await page.evaluate(() => window.pigmentApp.doc.selection.bounds)).toMatchObject({ x: 50, y: 50, width: 250, height: 50 });
  await drag(page, [60, 60], [100, 90], { modifiers: ['Alt'] });
  const sel = await page.evaluate(() => {
    const s = window.pigmentApp.doc.selection;
    return [s.at(55, 55) > 0, s.at(70, 70) > 0, s.at(110, 70) > 0];
  });
  expect(sel).toEqual([true, false, true]);
  expect(errors).toEqual([]);
});

test('quick selection stays inside a hard edge', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 200, height: 150 });
  await paintSquare(page, '#ff0000', 20, 20, 60, 60);
  await page.evaluate(() => {
    window.pigmentApp.tools.activate('quick-select');
    window.pigmentApp.tools.setOpt('quick-select', 'size', 30);
  });
  await drag(page, [30, 30], [70, 70]);
  const b = await page.evaluate(() => window.pigmentApp.doc.selection?.bounds);
  expect(b).toMatchObject({ x: 20, y: 20, width: 60, height: 60 });
  expect(errors).toEqual([]);
});

test('Select All + Stroke Inside frames the image; Paste Into is one undo step', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await page.keyboard.press('Control+a');
  await run(page, 'edit:stroke');
  await page.locator('.dialog input[type="number"][data-key="width"]').fill('10');
  await page.locator('.dialog input[type="number"][data-key="width"]').dispatchEvent('change');
  await page.locator('.dialog .opt-segment .seg-button[data-value="inside"]').click();
  await page.locator('.dialog input[type="color"]').evaluate((el) => {
    el.value = '#ff0000';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await confirmDialog(page);
  await expect.poll(() => pixel(page, 2, 2)).toEqual([255, 0, 0, 255]);
  expect(await pixel(page, 200, 150)).toEqual([255, 255, 255, 255]);
  // paste into
  await selectRect(page, { x: 0, y: 0, width: 50, height: 50 });
  await page.keyboard.press('Control+c');
  await selectRect(page, { x: 200, y: 200, width: 80, height: 80 });
  const n = await page.evaluate(() => window.pigmentApp.doc.history.index);
  await runAwait(page, 'edit:paste-into');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.layers().length)).toBe(2);
  expect(await page.evaluate(() => window.pigmentApp.doc.history.index)).toBe(n + 1);
  await runAwait(page, 'edit:undo');
  expect(await page.evaluate(() => [window.pigmentApp.doc.layers().length, !!window.pigmentApp.doc.selection])).toEqual([1, true]);
  expect(errors).toEqual([]);
});

test('quick mask: painting white outside the old selection adds to it', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await selectRect(page, { x: 20, y: 20, width: 80, height: 60 });
  await page.keyboard.press('q');
  await page.evaluate(() => {
    const app = window.pigmentApp;
    app.setColors({ foreground: '#ffffff' });
    app.tools.activate('brush');
    app.tools.setOpt('brush', 'size', 30);
    app.tools.setOpt('brush', 'hardness', 1);
  });
  await drag(page, [200, 150], [260, 150]);
  await page.keyboard.press('q');
  const at = await page.evaluate(() => {
    const s = window.pigmentApp.doc.selection;
    return [s.at(50, 50) > 0, s.at(230, 150) > 0, s.at(300, 250) > 0];
  });
  expect(at).toEqual([true, true, false]);
  expect(errors).toEqual([]);
});

test('diamond gradient, pencil hardness, lock-transparency alpha and a non-canvas blend mode', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { background: 'transparent' });
  await page.evaluate(() => {
    const app = window.pigmentApp;
    app.setColors({ foreground: '#000000', background: '#ffffff' });
    app.tools.activate('gradient');
    app.tools.setOpt('gradient', 'kind', 'diamond');
    app.tools.setOpt('gradient', 'dither', false);
  });
  await drag(page, [200, 150], [300, 150]);
  // L1 distance: (250,200) is at |50|+|50| = 100 = the full length -> white
  await expect.poll(async () => (await layerPixel(page, 250, 200))[0]).toBeGreaterThan(250);
  expect((await layerPixel(page, 250, 150))[0]).toBeLessThan(140);
  await runAwait(page, 'edit:undo');
  // pencil at 1 px: fully opaque pixels
  await page.evaluate(() => {
    window.pigmentApp.tools.activate('pencil');
    window.pigmentApp.tools.setOpt('pencil', 'size', 1);
  });
  await drag(page, [20, 20], [120, 20]);
  // the 1 px line lands on one row: every painted pixel is fully opaque, none partial
  await expect.poll(() => page.evaluate(() => {
    const l = window.pigmentApp.doc.active;
    const d = l.canvas.getContext('2d').getImageData(60 - l.x, 15 - l.y, 1, 10).data;
    const alphas = [];
    for (let i = 3; i < d.length; i += 4) alphas.push(d[i]);
    return [alphas.includes(255), alphas.some((a) => a > 0 && a < 255)];
  })).toEqual([true, false]);
  await runAwait(page, 'edit:undo');
  // lock transparency keeps alpha at 128 exactly when painting at 50% opacity
  await page.evaluate(() => {
    const l = window.pigmentApp.doc.active;
    const ctx = l.canvas.getContext('2d');
    ctx.fillStyle = 'rgba(255,0,0,0.5)';
    ctx.fillRect(50, 50, 100, 100);
    l.touch();
    window.pigmentApp.commands.run('layer:lock', 'transparency', 'api');
    window.pigmentApp.setColors({ foreground: '#0000ff' });
    window.pigmentApp.tools.activate('brush');
    window.pigmentApp.tools.setOpt('brush', 'size', 30);
    window.pigmentApp.tools.setOpt('brush', 'hardness', 1);
    window.pigmentApp.tools.setOpt('brush', 'opacity', 0.5);
  });
  await drag(page, [100, 100], [110, 100]);
  await expect.poll(async () => (await layerPixel(page, 100, 100))[3]).toBe(128);
  expect((await layerPixel(page, 100, 100))[2]).toBeGreaterThan(100);
  await runAwait(page, 'edit:undo');
  // linear burn (no Canvas 2D equivalent) darkens instead of painting normally
  await page.evaluate(() => {
    window.pigmentApp.commands.run('layer:lock', 'transparency', 'api');
    const l = window.pigmentApp.doc.active;
    const ctx = l.canvas.getContext('2d');
    ctx.fillStyle = 'rgb(200,200,200)';
    ctx.fillRect(0, 0, 400, 300);
    l.touch();
    window.pigmentApp.setColors({ foreground: '#646464' });
    window.pigmentApp.tools.setOpt('brush', 'opacity', 1);
    window.pigmentApp.tools.setOpt('brush', 'blend', 'linear-burn');
  });
  await drag(page, [200, 200], [220, 200]);
  await expect.poll(async () => (await layerPixel(page, 210, 200))[0]).toBeLessThan(60);
  expect(errors).toEqual([]);
});
