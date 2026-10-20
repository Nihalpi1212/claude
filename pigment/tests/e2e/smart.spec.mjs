// Smart objects (lib/smart-object.js): converting layers, sharp Free Transform, Edit Contents with
// write-back, non-destructive smart filters, .pigment round trip, rasterizing, placing and undo.
import { test, expect } from '@playwright/test';
import { openApp, newDoc, runAwait, pixel, historyLength } from './helpers.mjs';

/** Paints a rectangle on the active layer through the history (so the document is dirty like a real edit). */
const paint = (page, color, rect) =>
  page.evaluate(([c, r]) => {
    const d = window.pigmentApp.doc;
    const l = d.active;
    d.history.pixels('Paint', l.canvas, { x: r[0] - l.x, y: r[1] - l.y, width: r[2], height: r[3] }, (ctx) => {
      ctx.fillStyle = c;
      ctx.fillRect(r[0] - l.x, r[1] - l.y, r[2], r[3]);
    }, { layer: l });
  }, [color, rect]);

const types = (page) => page.evaluate(() => window.pigmentApp.doc.layers().map((l) => l.type));
const activeInfo = (page) =>
  page.evaluate(() => {
    const l = window.pigmentApp.doc.active;
    return { type: l.type, name: l.name, transform: l.transform, filters: l.filters ?? null, source: l.source ? { kind: l.source.kind, width: l.sourceWidth, height: l.sourceHeight, layers: l.source.doc?.layers().length ?? null } : null };
  });

/** Two painted layers (red on the first, blue on a second) selected together. */
async function twoLayers(page) {
  await newDoc(page, { background: 'transparent' });
  await paint(page, '#ff0000', [100, 100, 100, 50]);
  await runAwait(page, 'layer:new', { name: 'B' });
  await paint(page, '#0000ff', [150, 120, 100, 50]);
  await runAwait(page, 'layer:select', 'all');
}

test('Convert to Smart Object keeps the composite, nests the layers in a source document, and undo/redo restore both states', async ({ page }) => {
  const errors = await openApp(page);
  await twoLayers(page);
  const before = [await pixel(page, 120, 110), await pixel(page, 200, 140), await pixel(page, 50, 50)];
  expect(before).toEqual([[255, 0, 0, 255], [0, 0, 255, 255], [0, 0, 0, 0]]);
  const n = await historyLength(page);
  await runAwait(page, 'layer:smart-convert');
  expect(await types(page)).toEqual(['smart']);
  expect(await historyLength(page)).toBe(n + 1);
  const info = await activeInfo(page);
  expect(info.type).toBe('smart');
  expect(info.source).toEqual({ kind: 'document', width: 400, height: 300, layers: 2 });
  expect(info.filters).toEqual([]);
  expect([await pixel(page, 120, 110), await pixel(page, 200, 140), await pixel(page, 50, 50)]).toEqual(before);
  // the Layers panel shows the smart badge and the menu state follows the layer type
  await expect(page.locator('.layer-row .layer-smart-badge')).toHaveCount(1);
  expect(await page.evaluate(() => window.__pigmentTest.uiState.layerType)).toBe('smart');
  await runAwait(page, 'edit:undo');
  expect(await types(page)).toEqual(['raster', 'raster']);
  expect([await pixel(page, 120, 110), await pixel(page, 200, 140), await pixel(page, 50, 50)]).toEqual(before);
  await runAwait(page, 'edit:redo');
  expect(await types(page)).toEqual(['smart']);
  expect([await pixel(page, 120, 110), await pixel(page, 200, 140)]).toEqual(before.slice(0, 2));
  expect(errors).toEqual([]);
});

test('Free Transform at 200% keeps the smart object sharp: the render equals the source drawn directly through the matrix', async ({ page }) => {
  const errors = await openApp(page);
  await twoLayers(page);
  await runAwait(page, 'layer:smart-convert');
  await runAwait(page, 'edit:free-transform');
  await page.evaluate(() => {
    const t = window.pigmentApp.transformTool;
    for (const k of ['w', 'h']) {
      t.fields[k].value = '200';
      t.fields[k].dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => !window.pigmentApp.transformTool.session)).toBe(true);
  const info = await activeInfo(page);
  expect(info.type).toBe('smart');
  expect(info.transform.map((v) => Math.round(v * 100) / 100)).toEqual([2, 0, 0, 2, -200, -150]);
  // the red box (100..200 × 100..150) scaled about the centre now covers 0..200 × 50..150
  const check = await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    const l = d.active;
    const composite = d.view.compositor.composite(d).getContext('2d', { willReadFrequently: true });
    // direct render: the untouched source through the final matrix in one step
    const direct = document.createElement('canvas');
    direct.width = d.width;
    direct.height = d.height;
    const ctx = direct.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    const m = l.transform;
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    ctx.drawImage(l.sourceCanvas(), 0, 0);
    // row y = 60 crosses the scaled red box's right edge at x = 200 (the blue box starts lower, at y = 90)
    const row = (c, y) => Array.from(c.getImageData(194, y, 12, 1).data);
    return { composite: row(composite, 60), direct: row(ctx, 60), inside: Array.from(composite.getImageData(198, 60, 1, 1).data), outside: Array.from(composite.getImageData(201, 60, 1, 1).data) };
  });
  expect(check.composite).toEqual(check.direct);
  expect(check.inside).toEqual([255, 0, 0, 255]); // 2 px inside the scaled edge: solid
  expect(check.outside[3]).toBe(0); // 1 px outside: nothing (no blur from scaling a scaled bitmap)
  // Reset Transform puts the source back at its original place
  await runAwait(page, 'layer:smart-reset');
  expect((await activeInfo(page)).transform).toBeNull();
  expect(await pixel(page, 120, 110)).toEqual([255, 0, 0, 255]);
  expect(errors).toEqual([]);
});

test('Edit Contents opens the source in a tab; File › Save writes it back into the host (undoable) and closing the tab asks nothing', async ({ page }) => {
  const errors = await openApp(page);
  await twoLayers(page);
  await runAwait(page, 'layer:smart-convert');
  const hostId = await page.evaluate(() => window.pigmentApp.doc.id);
  await runAwait(page, 'layer:smart-edit');
  await expect(page.locator('.tab')).toHaveCount(2);
  const edit = await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    return { name: d.name, host: d.smartHost?.hostDoc?.id ?? null, layers: d.layers().length, dirty: d.history.dirty };
  });
  expect(edit).toEqual({ name: 'Layer 2 (smart object)', host: hostId, layers: 2, dirty: false });
  await paint(page, '#00ff00', [0, 0, 60, 60]);
  expect(await page.evaluate(() => window.pigmentApp.doc.history.dirty)).toBe(true);
  // the host is untouched until Save
  expect(await page.evaluate(() => {
    const d = window.pigmentApp.docs.docs[0];
    return Array.from(d.view.compositor.composite(d).getContext('2d').getImageData(30, 30, 1, 1).data);
  })).toEqual([0, 0, 0, 0]);
  const n = await page.evaluate(() => window.pigmentApp.docs.docs[0].history.index + 1);
  await runAwait(page, 'file:save');
  expect(await page.evaluate(() => window.pigmentApp.doc.history.dirty)).toBe(false);
  expect(await page.evaluate(() => Object.keys(window.__pigmentTest.written))).toEqual([]); // nothing went to disk
  await page.evaluate(() => window.pigmentApp.docs.activate(window.pigmentApp.docs.docs[0]));
  expect(await pixel(page, 30, 30)).toEqual([0, 255, 0, 255]);
  expect(await pixel(page, 120, 110)).toEqual([255, 0, 0, 255]);
  expect(await historyLength(page)).toBe(n + 1);
  expect(await page.evaluate(() => window.pigmentApp.doc.history.entries.at(-1).label)).toBe('Edit smart object contents');
  await runAwait(page, 'edit:undo');
  expect(await pixel(page, 30, 30)).toEqual([0, 0, 0, 0]);
  await runAwait(page, 'edit:redo');
  expect(await pixel(page, 30, 30)).toEqual([0, 255, 0, 255]);
  // a second Edit Contents brings the open tab back instead of opening another one
  await runAwait(page, 'layer:smart-edit');
  await expect(page.locator('.tab')).toHaveCount(2);
  expect(await page.evaluate(() => window.pigmentApp.doc.name)).toBe('Layer 2 (smart object)');
  await runAwait(page, 'file:close');
  await expect(page.locator('.tab')).toHaveCount(1);
  expect(await page.evaluate(() => window.__pigmentTest.messages?.length ?? 0)).toBe(0);
  expect(errors).toEqual([]);
});

test('Gaussian Blur on a smart object becomes a smart filter: hiding it restores the exact pixels, the Layers panel lists it', async ({ page }) => {
  const errors = await openApp(page);
  await twoLayers(page);
  await runAwait(page, 'window:panel-layers');
  await runAwait(page, 'layer:smart-convert');
  const edge = await pixel(page, 100, 110);
  const corner = await pixel(page, 96, 110);
  expect(edge).toEqual([255, 0, 0, 255]);
  expect(corner[3]).toBe(0);
  const n = await historyLength(page);
  await runAwait(page, 'filter:gaussian-blur', { radius: 6 });
  expect(await historyLength(page)).toBe(n + 1);
  const info = await activeInfo(page);
  expect(info.type).toBe('smart');
  expect(info.filters).toEqual([{ kind: 'gaussian-blur', params: { radius: 6 }, enabled: true }]);
  const blurred = await pixel(page, 100, 110);
  expect(blurred[3]).toBeLessThan(250); // the hard edge softened
  expect((await pixel(page, 96, 110))[3]).toBeGreaterThan(0); // and spread outwards
  await expect(page.locator('.layer-row.smart-filter-head')).toHaveCount(1);
  await expect(page.locator('.layer-row.smart-filter-row')).toHaveCount(1);
  await expect(page.locator('.layer-row.smart-filter-row .layer-name')).toHaveText('Gaussian Blur');
  // the eye of the filter row hides the filter (undoable), the pixels come back exactly
  await page.locator('.layer-row.smart-filter-row .eye').click();
  await expect.poll(() => pixel(page, 100, 110)).toEqual(edge);
  expect(await pixel(page, 96, 110)).toEqual(corner);
  expect(await page.evaluate(() => window.pigmentApp.doc.active.filters[0].enabled)).toBe(false);
  await runAwait(page, 'edit:undo');
  expect(await pixel(page, 100, 110)).toEqual(blurred);
  // adjustments become smart filters too, and Clear removes them all
  await runAwait(page, 'image:adjust-invert');
  expect((await activeInfo(page)).filters.map((f) => f.kind)).toEqual(['gaussian-blur', 'adjust:invert']);
  // the middle of the red-only area (25 px from every edge, far beyond the blur) is now cyan
  const inverted = await pixel(page, 125, 125);
  for (const [i, v] of [0, 255, 255, 255].entries()) expect(Math.abs(inverted[i] - v)).toBeLessThanOrEqual(2);
  await runAwait(page, 'layer:smart-filters-toggle');
  expect(await pixel(page, 100, 110)).toEqual(edge);
  await runAwait(page, 'layer:smart-filters-toggle');
  await runAwait(page, 'layer:smart-filters-clear');
  expect((await activeInfo(page)).filters).toEqual([]);
  expect(await pixel(page, 100, 110)).toEqual(edge);
  expect(errors).toEqual([]);
});

test('a .pigment file keeps the smart object, its source document, transform and smart filters', async ({ page }) => {
  const errors = await openApp(page);
  await twoLayers(page);
  await runAwait(page, 'layer:smart-convert');
  await runAwait(page, 'filter:gaussian-blur', { radius: 4 });
  await page.evaluate(() => {
    const t = window.pigmentApp.doc.active;
    t.transform = [1.5, 0, 0, 1.5, 10, 20];
    t.touch();
    window.pigmentApp.doc.changed('props', { layer: t });
    window.__pigmentTest.nextSavePath = 'mem:/smart.pigment';
  });
  const before = await Promise.all([[160, 170], [120, 150], [40, 40]].map(([x, y]) => pixel(page, x, y)));
  await runAwait(page, 'file:save-as');
  await expect.poll(() => page.evaluate(() => !!window.__pigmentTest.written['mem:/smart.pigment'])).toBe(true);
  await page.evaluate(() => {
    window.__pigmentTest.files['mem:/again.pigment'] = window.__pigmentTest.written['mem:/smart.pigment'];
  });
  await runAwait(page, 'file:open-paths', ['mem:/again.pigment']);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.path)).toBe('mem:/again.pigment');
  const info = await activeInfo(page);
  expect(info.type).toBe('smart');
  expect(info.transform).toEqual([1.5, 0, 0, 1.5, 10, 20]);
  expect(info.filters).toEqual([{ kind: 'gaussian-blur', params: { radius: 4 }, enabled: true }]);
  expect(info.source).toEqual({ kind: 'document', width: 400, height: 300, layers: 2 });
  expect(await Promise.all([[160, 170], [120, 150], [40, 40]].map(([x, y]) => pixel(page, x, y)))).toEqual(before);
  expect(await page.evaluate(() => window.pigmentApp.doc.history.dirty)).toBe(false);
  // the source is editable again after reopening
  await runAwait(page, 'layer:smart-edit');
  expect(await page.evaluate(() => window.pigmentApp.doc.layers().map((l) => l.type))).toEqual(['raster', 'raster']);
  expect(errors).toEqual([]);
});

test('Rasterize turns the smart object into a pixel layer with the same pixels; Place creates a smart object fitted to the canvas', async ({ page }) => {
  const errors = await openApp(page);
  await twoLayers(page);
  await runAwait(page, 'layer:smart-convert');
  await runAwait(page, 'filter:gaussian-blur', { radius: 3 });
  const before = await Promise.all([[100, 110], [150, 130], [250, 170], [50, 50]].map(([x, y]) => pixel(page, x, y)));
  const n = await historyLength(page);
  await runAwait(page, 'layer:smart-rasterize');
  expect(await types(page)).toEqual(['raster']);
  expect(await historyLength(page)).toBe(n + 1);
  expect(await Promise.all([[100, 110], [150, 130], [250, 170], [50, 50]].map(([x, y]) => pixel(page, x, y)))).toEqual(before);
  await runAwait(page, 'edit:undo');
  expect(await types(page)).toEqual(['smart']);
  // Place: an 800 × 200 magenta PNG lands as a smart object scaled to fit the 400 × 300 canvas
  await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 800;
    c.height = 200;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ff00ff';
    ctx.fillRect(0, 0, 800, 200);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    window.__pigmentTest.files['mem:/logo.png'] = new Uint8Array(await blob.arrayBuffer());
  });
  await runAwait(page, 'file:place', 'mem:/logo.png');
  const placed = await activeInfo(page);
  expect(placed.type).toBe('smart');
  expect(placed.name).toBe('logo');
  expect(placed.source).toEqual({ kind: 'image', width: 800, height: 200, layers: null });
  expect(placed.transform).toEqual([0.5, 0, 0, 0.5, 0, 100]);
  expect(await pixel(page, 200, 150)).toEqual([255, 0, 255, 255]);
  expect(await pixel(page, 200, 50)).toEqual([0, 0, 0, 0]);
  expect(await types(page)).toEqual(['smart', 'smart']);
  // with the preference off, Place creates a plain pixel layer
  await page.evaluate(() => (window.pigmentApp.settings.placeAsSmart = false));
  await runAwait(page, 'file:place', 'mem:/logo.png');
  expect((await activeInfo(page)).type).toBe('raster');
  expect(errors).toEqual([]);
});
