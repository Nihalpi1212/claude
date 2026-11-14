// Regression tests for the second bug hunt: crop, Free Transform, canvas size, rotate, duplicate.
import { test, expect } from '@playwright/test';
import { openApp, newDoc, run, runAwait, pixel, drag, historyLength } from './helpers.mjs';

const paint = (page, color, rect) =>
  page.evaluate(([c, r]) => { const l = window.pigmentApp.doc.active; const ctx = l.canvas.getContext('2d'); ctx.fillStyle = c; ctx.fillRect(...r); l.touch(); window.pigmentApp.doc.changed('pixels', { layer: l }); }, [color, rect]);
/** Starts Free Transform (mode) and commits the session with its quad shifted / replaced. */
const transform = (page, mode, mutate) =>
  page.evaluate(async ([m, fn]) => {
    const app = window.pigmentApp;
    await app.commands.run('edit:transform', m, 'api');
    const s = app.transformTool.session;
    if (!s) throw new Error('no transform session');
    new Function('s', 'app', fn)(s, app);
    app.transformTool.update({ final: true });
    app.transformTool.commit();
  }, [mode, mutate]);

test('Undo works while the crop tool is active', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { background: 'white' });
  await page.keyboard.press('c');
  await drag(page, [30, 30], [130, 110]);
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => [window.pigmentApp.doc.width, window.pigmentApp.doc.height])).toEqual([100, 80]);
  await page.keyboard.press('Control+z');
  await expect.poll(() => page.evaluate(() => [window.pigmentApp.doc.width, window.pigmentApp.doc.height])).toEqual([400, 300]);
  expect(await page.evaluate(() => window.pigmentApp.tools.active.id)).toBe('crop');
  // Escape with a dragged, uncommitted box only resets the box
  await drag(page, [30, 30], [130, 110]);
  const n = await historyLength(page);
  await page.keyboard.press('Escape');
  expect(await historyLength(page)).toBe(n);
  expect(await page.evaluate(() => { const b = window.pigmentApp.tools.active.box; return [b.x, b.y, b.width, b.height]; })).toEqual([0, 0, 400, 300]);
  expect(errors).toEqual([]);
});

test('Free Transform moves the mask of a selected group with its children', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { background: 'transparent' });
  await paint(page, '#ff0000', [50, 50, 100, 100]);
  await runAwait(page, 'layer:group');
  await page.evaluate(async () => {
    const { createCanvas } = await import('/lib/document.js');
    const d = window.pigmentApp.doc;
    const g = d.active;
    const m = createCanvas(d.width, d.height);
    m.getContext('2d').fillStyle = '#fff';
    m.getContext('2d').fillRect(0, 0, 100, d.height); // hides x >= 100
    g.mask = { canvas: m, enabled: true, linked: true };
    g.touch();
    d.changed('props', { layer: g });
  });
  expect((await pixel(page, 75, 100))[3]).toBe(255);
  expect((await pixel(page, 125, 100))[3]).toBe(0);
  await transform(page, 'free', 's.quad = s.quad.map(([x, y]) => [x + 100, y]);');
  expect((await pixel(page, 175, 100))[3]).toBe(255);
  expect((await pixel(page, 225, 100))[3]).toBe(0);
  await runAwait(page, 'edit:undo');
  expect((await pixel(page, 75, 100))[3]).toBe(255);
  expect((await pixel(page, 125, 100))[3]).toBe(0);
  expect(errors).toEqual([]);
});

test('Transform Again repeats a plain move', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { background: 'transparent' });
  await paint(page, '#ff0000', [100, 100, 50, 50]);
  await transform(page, 'free', 's.quad = s.quad.map(([x, y]) => [x + 60, y]);');
  expect((await pixel(page, 185, 125))[3]).toBe(255);
  const n = await historyLength(page);
  await runAwait(page, 'edit:transform-again');
  expect(await historyLength(page)).toBe(n + 1);
  expect((await pixel(page, 245, 125))[3]).toBe(255);
  expect((await pixel(page, 185, 125))[3]).toBe(0);
  expect(errors).toEqual([]);
});

test('Canvas Size and Rotate Canvas keep a transparent image transparent and fill under a Background', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { background: 'transparent' });
  await runAwait(page, 'image:canvas-size', { width: 500, height: 300, anchor: 'c', color: '#ffffff' });
  expect(await page.evaluate(() => window.pigmentApp.doc.width)).toBe(500);
  expect((await pixel(page, 475, 150))[3]).toBe(0);
  await runAwait(page, 'image:rotate', 30);
  expect((await pixel(page, 2, 2))[3]).toBe(0);
  await newDoc(page, { background: 'white' });
  await runAwait(page, 'image:canvas-size', { width: 500, height: 300, anchor: 'c', color: '#00ff00' });
  expect((await pixel(page, 475, 150)).slice(0, 4)).toEqual([0, 255, 0, 255]);
  await runAwait(page, 'image:rotate', 30);
  expect((await pixel(page, 2, 2))[3]).toBe(255);
  expect(errors).toEqual([]);
});

test('Distort moves a linked layer mask with the pixels', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { background: 'transparent' });
  await paint(page, '#ff0000', [100, 100, 100, 100]);
  await page.evaluate(async () => {
    const { createCanvas } = await import('/lib/document.js');
    const d = window.pigmentApp.doc;
    const l = d.active;
    const m = createCanvas(d.width, d.height);
    m.getContext('2d').fillStyle = '#fff';
    m.getContext('2d').fillRect(0, 150, d.width, d.height - 150); // hides y < 150
    l.mask = { canvas: m, enabled: true, linked: true };
    l.touch();
    d.changed('props', { layer: l });
  });
  expect((await pixel(page, 150, 125))[3]).toBe(0);
  expect((await pixel(page, 150, 175))[3]).toBe(255);
  await transform(page, 'distort', 's.quad = [[110, 200], [190, 200], [200, 300], [100, 300]];');
  expect((await pixel(page, 150, 225))[3]).toBe(0); // the former top half stays hidden
  expect((await pixel(page, 150, 285))[3]).toBe(255);
  expect(errors).toEqual([]);
});

test('typed angle and size apply around the reference point', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { background: 'transparent' });
  await paint(page, '#ff0000', [100, 100, 100, 50]);
  await run(page, 'edit:free-transform');
  await page.evaluate(() => { const t = window.pigmentApp.transformTool; t.session.pivot = [100, 100]; t.fields.angle.value = '90'; t.fields.angle.dispatchEvent(new Event('change', { bubbles: true })); });
  const quad = await page.evaluate(() => window.pigmentApp.transformTool.session.quad.map(([x, y]) => [Math.round(x), Math.round(y)]));
  expect(quad[0]).toEqual([100, 100]);
  expect(quad[1]).toEqual([100, 200]);
  await page.evaluate(() => { const t = window.pigmentApp.transformTool; t.fields.w.value = '200'; t.fields.w.dispatchEvent(new Event('change', { bubbles: true })); });
  const quad2 = await page.evaluate(() => window.pigmentApp.transformTool.session.quad.map(([x, y]) => [Math.round(x), Math.round(y)]));
  expect(quad2[0]).toEqual([100, 100]);
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('Duplicate Image keeps layer locks', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { background: 'white' });
  await page.evaluate(() => { const d = window.pigmentApp.doc; d.active.locked.all = true; d.changed('props', { layer: d.active }); });
  await runAwait(page, 'image:duplicate', { name: 'copy', merged: false });
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.name)).toBe('copy');
  expect(await page.evaluate(() => window.pigmentApp.doc.layers()[0].locked.all)).toBe(true);
  expect(errors).toEqual([]);
});
