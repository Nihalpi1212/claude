// Smart object regressions (bug hunt 3): render clipping survives whole-document remaps, geometry
// filters see the whole object, the Layers panel lists filters last-applied first and Move Up moves
// up, converting a clipped layer keeps the clip, duplicated instances share their contents, and
// Rasterize keeps the part outside the canvas.
import { test, expect } from '@playwright/test';
import { openApp, newDoc, runAwait, pixel } from './helpers.mjs';

const paint = (page, color, rect) =>
  page.evaluate(([c, r]) => {
    const d = window.pigmentApp.doc;
    const l = d.active;
    d.history.pixels('Paint', l.canvas, { x: r[0] - l.x, y: r[1] - l.y, width: r[2], height: r[3] }, (ctx) => {
      ctx.fillStyle = c;
      ctx.fillRect(r[0] - l.x, r[1] - l.y, r[2], r[3]);
    }, { layer: l });
  }, [color, rect]);

const setTransform = (page, m) =>
  page.evaluate((t) => {
    const d = window.pigmentApp.doc;
    const l = d.active;
    l.transform = t;
    l.touch();
    d.changed('props', { layer: l });
  }, m);

const renderInfo = (page) =>
  page.evaluate(() => {
    const r = window.pigmentApp.doc.active.render();
    return { w: r.canvas.width, h: r.canvas.height, x: r.x, y: r.y };
  });

test('Image Size after a 40× smart object keeps the render clipped to the document (no gigantic canvas, nothing vanishes)', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 400, height: 300, background: 'transparent' });
  await paint(page, '#ff00ff', [0, 0, 400, 300]);
  await runAwait(page, 'layer:smart-convert');
  await setTransform(page, [40, 0, 0, 40, -7800, -5850]);
  expect(await pixel(page, 200, 150)).toEqual([255, 0, 255, 255]);
  await runAwait(page, 'image:size', { width: 200, height: 150, method: 'bilinear', scaleStyles: true });
  expect(await page.evaluate(() => [window.pigmentApp.doc.width, window.pigmentApp.doc.height])).toEqual([200, 150]);
  expect(await pixel(page, 100, 75)).toEqual([255, 0, 255, 255]);
  const r = await renderInfo(page);
  expect(r.w).toBeLessThanOrEqual(200);
  expect(r.h).toBeLessThanOrEqual(150);
  await runAwait(page, 'image:canvas-size', { width: 300, height: 150, anchor: 'w' });
  expect(await pixel(page, 100, 75)).toEqual([255, 0, 255, 255]);
  expect((await renderInfo(page)).w).toBeLessThanOrEqual(300);
  await runAwait(page, 'image:rotate-90');
  expect(await pixel(page, 75, 100)).toEqual([255, 0, 255, 255]);
  expect(errors).toEqual([]);
});

test('a geometry smart filter (vignette) gives the same pixels when the object is moved partly off the canvas', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 300, height: 300, background: 'transparent' });
  await paint(page, '#4080ff', [50, 50, 200, 200]);
  await runAwait(page, 'layer:smart-convert');
  await runAwait(page, 'filter:vignette', { amount: -100, size: 0.3, roundness: 0 });
  expect(await page.evaluate(() => window.pigmentApp.doc.active.filters.map((f) => f.kind))).toEqual(['vignette']);
  const edgeBefore = await pixel(page, 230, 150); // content (180, 100): 20 px inside the right edge, darkened
  const centreBefore = await pixel(page, 150, 150); // content (100, 100)
  expect(edgeBefore[2]).toBeLessThan(centreBefore[2]);
  // move the object 120 px left: its left part leaves the canvas; the same content points are now 120 px further left
  await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    const l = d.active;
    l.x = l.x - 120;
    l.touch();
    d.changed('props', { layer: l });
  });
  expect(await pixel(page, 30, 150)).toEqual(centreBefore);
  const edgeAfter = await pixel(page, 110, 150);
  expect(Math.abs(edgeAfter[2] - edgeBefore[2])).toBeLessThanOrEqual(2);
  expect(errors).toEqual([]);
});

test('the Layers panel lists smart filters last-applied first; Move Up moves the row up', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 100, height: 100, background: 'transparent' });
  await paint(page, '#ff0000', [0, 0, 100, 100]);
  await runAwait(page, 'layer:smart-convert');
  await runAwait(page, 'image:adjust-invert', {});
  await runAwait(page, 'filter:mosaic', { size: 10 });
  const kinds = () => page.evaluate(() => window.pigmentApp.doc.active.filters.map((f) => f.kind));
  expect(await kinds()).toEqual(['adjust:invert', 'mosaic']);
  const rows = page.locator('.layer-row.smart-filter-row .layer-name');
  await expect(rows).toHaveText(['Mosaic', 'Invert']);
  await runAwait(page, 'layer:smart-filter', { index: 0, op: 'up' });
  expect(await kinds()).toEqual(['mosaic', 'adjust:invert']);
  await expect(rows).toHaveText(['Invert', 'Mosaic']);
  await runAwait(page, 'layer:smart-filter', { index: 1, op: 'down' });
  expect(await kinds()).toEqual(['adjust:invert', 'mosaic']);
  expect(errors).toEqual([]);
});

test('Convert to Smart Object keeps a clipping mask and the composite', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 300, height: 300, background: 'transparent' });
  await paint(page, '#ff8800', [100, 100, 120, 80]);
  await runAwait(page, 'layer:new', { name: 'Clip' });
  await paint(page, '#0000ff', [80, 80, 80, 120]);
  await runAwait(page, 'layer:clip');
  expect((await pixel(page, 90, 90))[3]).toBe(0);
  expect(await pixel(page, 120, 120)).toEqual([0, 0, 255, 255]);
  await runAwait(page, 'layer:smart-convert');
  const info = await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    return { types: d.layers().map((l) => l.type), clip: d.active.clip, index: d.layers().indexOf(d.active) };
  });
  expect(info).toEqual({ types: ['raster', 'smart'], clip: true, index: 1 });
  expect((await pixel(page, 90, 90))[3]).toBe(0);
  expect(await pixel(page, 120, 120)).toEqual([0, 0, 255, 255]);
  expect(await pixel(page, 200, 150)).toEqual([255, 136, 0, 255]);
  expect(errors).toEqual([]);
});

test('Duplicate Layer makes a second instance: Edit Contents › Save updates both', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 100, height: 100, background: 'transparent' });
  await paint(page, '#ff0000', [0, 0, 100, 100]);
  await runAwait(page, 'layer:smart-convert');
  await runAwait(page, 'layer:duplicate');
  expect(await page.evaluate(() => {
    const [a, b] = window.pigmentApp.doc.layers();
    return a.source === b.source;
  })).toBe(true);
  await runAwait(page, 'layer:smart-edit');
  await expect(page.locator('.tab')).toHaveCount(2);
  await paint(page, '#0000ff', [0, 0, 60, 60]);
  await runAwait(page, 'file:save');
  await page.evaluate(() => window.pigmentApp.docs.activate(window.pigmentApp.docs.docs[0]));
  const both = await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    const px = (l) => Array.from(l.sourceCanvas().getContext('2d').getImageData(30, 30, 1, 1).data);
    const [a, b] = d.layers();
    return { shared: a.source === b.source, a: px(a), b: px(b) };
  });
  expect(both).toEqual({ shared: true, a: [0, 0, 255, 255], b: [0, 0, 255, 255] });
  await runAwait(page, 'edit:undo');
  expect(await page.evaluate(() => {
    const [a, b] = window.pigmentApp.doc.layers();
    const px = (l) => Array.from(l.sourceCanvas().getContext('2d').getImageData(30, 30, 1, 1).data);
    return [px(a), px(b)];
  })).toEqual([[255, 0, 0, 255], [255, 0, 0, 255]]);
  expect(errors).toEqual([]);
});

test('Rasterize keeps the part of a smart object that lies outside the canvas', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 400, height: 300, background: 'transparent' });
  await paint(page, '#ff0000', [100, 100, 100, 50]);
  await runAwait(page, 'layer:smart-convert');
  // the source is the whole 400 × 300 layer (red at 100..200 × 100..150); at 2× moved up-left the red spans -100..100 × -50..50
  const src = await page.evaluate(() => [window.pigmentApp.doc.active.sourceWidth, window.pigmentApp.doc.active.sourceHeight, window.pigmentApp.doc.active.transform]);
  expect(src).toEqual([400, 300, null]);
  await setTransform(page, [2, 0, 0, 2, -300, -250]);
  expect(await page.evaluate(() => window.pigmentApp.doc.active.bounds())).toEqual({ x: -300, y: -250, width: 800, height: 600 });
  await runAwait(page, 'layer:smart-rasterize');
  const l = await page.evaluate(() => {
    const a = window.pigmentApp.doc.active;
    const at = (x, y) => Array.from(a.canvas.getContext('2d').getImageData(x - a.x, y - a.y, 1, 1).data);
    return { type: a.type, x: a.x, y: a.y, w: a.canvas.width, h: a.canvas.height, offCanvas: at(-90, -40), onCanvas: at(50, 25) };
  });
  expect(l).toEqual({ type: 'raster', x: -300, y: -250, w: 800, h: 600, offCanvas: [255, 0, 0, 255], onCanvas: [255, 0, 0, 255] });
  expect(errors).toEqual([]);
});
