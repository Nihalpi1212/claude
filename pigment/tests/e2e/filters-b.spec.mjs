// Filters, part B: Displace (map chooser), the Render generators and the Stylize kinds through
// their dialogs and the history.
import { test, expect } from '@playwright/test';
import { openApp, newDoc, run, runAwait, layerPixel, confirmDialog, historyLength } from './helpers.mjs';

/** Paints a rectangle on the active layer of the current document. */
const paint = (page, color, x, y, w, h) =>
  page.evaluate(([c, px, py, pw, ph]) => {
    const app = window.pigmentApp;
    const l = app.doc.active;
    const ctx = l.canvas.getContext('2d');
    ctx.fillStyle = c;
    ctx.fillRect(px - l.x, py - l.y, pw, ph);
    l.touch();
    app.doc.changed('pixels');
  }, [color, x, y, w, h]);

/** The commit runs under app.busy after the dialog closes: wait for its history entry before reading pixels. */
const committed = (page, n) => expect.poll(() => historyLength(page)).toBe(n);

const setNumber = async (page, key, value) => {
  const input = page.locator(`.dialog input[type="number"][data-key="${key}"]`);
  await input.fill(String(value));
  await input.dispatchEvent('change');
};

test('Displace: the map comes from a second open document and shifts pixels by the scale', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { name: 'Target' });
  // a black bar at x 100..110 on white
  await paint(page, '#000000', 100, 0, 10, 300);
  // the map: a document filled with pure red (255 displaces x by the full scale, green 0 would pull y: we zero the vertical scale)
  await newDoc(page, { name: 'Map' });
  await paint(page, '#ff0000', 0, 0, 400, 300);
  await page.evaluate(() => window.pigmentApp.docs.activate(window.pigmentApp.docs.list()[0]));
  expect(await page.evaluate(() => window.pigmentApp.doc.name)).toBe('Target');
  const before = await historyLength(page);
  await run(page, 'filter:displace');
  const select = page.locator('.dialog select[data-key="__map"]');
  await expect(select).toBeVisible();
  // the other document is offered and chosen by default
  await expect(select).toHaveValue(/^doc:/);
  await expect(select.locator('option')).toContainText([/Document: Map/]);
  await expect(page.locator('.dialog [data-key="__map-note"]')).toContainText('Document: Map');
  await setNumber(page, 'horizontalScale', 10);
  await setNumber(page, 'verticalScale', 0);
  await confirmDialog(page);
  await committed(page, before + 1);
  // white displaces the image left by 10 px: the bar now sits at 90..100
  expect((await layerPixel(page, 95, 150)).slice(0, 3)).toEqual([0, 0, 0]);
  expect((await layerPixel(page, 105, 150)).slice(0, 3)).toEqual([255, 255, 255]);
  // Last Filter remembers the kind without the map's pixels in the settings
  const last = await page.evaluate(() => JSON.parse(JSON.stringify(window.pigmentApp.settings.lastFilter)));
  expect(last.kind).toBe('displace');
  expect(last.params.map).toBeNull();
  expect(last.params.horizontalScale).toBe(10);
  // undo restores the bar
  await runAwait(page, 'edit:undo');
  expect((await layerPixel(page, 105, 150)).slice(0, 3)).toEqual([0, 0, 0]);
  expect(errors).toEqual([]);
});

test('Displace: a layer of the same document and a file can be the map', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { name: 'Solo' });
  await paint(page, '#000000', 100, 0, 10, 300);
  await runAwait(page, 'layer:new');
  await page.evaluate(() => {
    window.pigmentApp.doc.active.name = 'Map layer';
    window.pigmentApp.doc.changed('props');
  });
  await paint(page, '#ff0000', 0, 0, 400, 300);
  // back to the background layer as the target
  await page.evaluate(() => {
    const app = window.pigmentApp;
    app.doc.setActive(app.doc.layers().find((l) => l.name !== 'Map layer'));
  });
  const h0 = await historyLength(page);
  await run(page, 'filter:displace');
  const select = page.locator('.dialog select[data-key="__map"]');
  await expect(select).toBeVisible();
  const layerValue = await select.locator('option', { hasText: 'Layer: Map layer' }).getAttribute('value');
  await select.selectOption(layerValue);
  await setNumber(page, 'horizontalScale', 20);
  await setNumber(page, 'verticalScale', 0);
  await expect(page.locator('.dialog [data-key="__map-note"]')).toContainText('Layer: Map layer');
  await confirmDialog(page);
  await committed(page, h0 + 1);
  expect((await layerPixel(page, 85, 150)).slice(0, 3)).toEqual([0, 0, 0]);
  expect((await layerPixel(page, 105, 150)).slice(0, 3)).toEqual([255, 255, 255]);
  // a file: the browser bridge hands the file dialog a prepared path
  await runAwait(page, 'edit:undo');
  await page.evaluate(async () => {
    const { encodeRgba8 } = await import('/shared/pixels/png.js');
    const data = new Uint8ClampedArray(8 * 8 * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 0; // 0 displaces the other way (the output samples to the left)
      data[i + 1] = 128;
      data[i + 3] = 255;
    }
    window.__pigmentTest.files['browser:/map.png'] = await encodeRgba8({ width: 8, height: 8, data });
    window.__pigmentTest.nextOpenFiles = ['browser:/map.png'];
  });
  await run(page, 'filter:displace');
  await expect(select).toBeVisible();
  await select.selectOption('file');
  await expect(page.locator('.dialog [data-key="__map-note"]')).toContainText('File: map.png');
  await setNumber(page, 'horizontalScale', 10);
  await setNumber(page, 'verticalScale', 0);
  await confirmDialog(page);
  await committed(page, h0 + 1);
  expect((await layerPixel(page, 115, 150)).slice(0, 3)).toEqual([0, 0, 0]);
  expect((await layerPixel(page, 105, 150)).slice(0, 3)).toEqual([255, 255, 255]);
  expect(errors).toEqual([]);
});

test('Tree renders onto an empty layer and undo clears it; the species select is offered', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { background: 'transparent' });
  expect(await layerPixel(page, 200, 285)).toEqual([0, 0, 0, 0]);
  const before = await historyLength(page);
  await run(page, 'filter:tree');
  const select = page.locator('.dialog select[data-key="type"]');
  await expect(select).toBeVisible();
  expect(await select.locator('option').count()).toBeGreaterThanOrEqual(8);
  await select.selectOption('maple');
  await confirmDialog(page);
  await committed(page, before + 1);
  // the trunk stands at the bottom centre, the corner stays transparent
  expect((await layerPixel(page, 200, 285))[3]).toBeGreaterThan(0);
  expect((await layerPixel(page, 5, 5))[3]).toBe(0);
  const opaque = await page.evaluate(() => {
    const l = window.pigmentApp.doc.active;
    const d = l.canvas.getContext('2d').getImageData(0, 0, l.canvas.width, l.canvas.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i]) n++;
    return n;
  });
  expect(opaque).toBeGreaterThan(400 * 300 * 0.02);
  await runAwait(page, 'edit:undo');
  expect(await layerPixel(page, 200, 285)).toEqual([0, 0, 0, 0]);
  expect(await page.evaluate(() => window.pigmentApp.settings.lastFilter?.params?.type)).toBe('maple');
  expect(errors).toEqual([]);
});

test('Flame refuses without a path and renders along a drawn work path', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { background: 'transparent' });
  await run(page, 'filter:flame');
  await expect(page.locator('.toast.error')).toContainText('Draw a path first');
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0);
  // a vertical work path down the middle
  await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    d.workPath = { subpaths: [{ closed: false, points: [{ x: 200, y: 260 }, { x: 200, y: 80 }] }] };
    d.changed('paths');
  });
  const before = await historyLength(page);
  await run(page, 'filter:flame');
  await expect(page.locator('.dialog select[data-key="flameType"]')).toBeVisible();
  await confirmDialog(page);
  await committed(page, before + 1);
  const onPath = await layerPixel(page, 200, 180);
  expect(onPath[3]).toBeGreaterThan(100);
  expect(onPath[0]).toBeGreaterThan(onPath[2]); // warm
  expect((await layerPixel(page, 20, 20))[3]).toBe(0);
  // the committed params carry the path as a point list (replayable, JSON-friendly)
  const params = await page.evaluate(() => JSON.parse(JSON.stringify(window.pigmentApp.settings.lastFilter.params)));
  expect(params.path.subpaths[0].points.length).toBe(2);
  // Last Filter replays it without a dialog
  await runAwait(page, 'edit:undo');
  expect((await layerPixel(page, 200, 180))[3]).toBe(0);
  await page.keyboard.press('Control+Alt+f');
  await expect.poll(() => layerPixel(page, 200, 180).then((p) => p[3])).toBeGreaterThan(100);
  expect(errors).toEqual([]);
});

test('Lighting Effects darkens the far side of a spot light and keeps the centre bright', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  const before = await historyLength(page);
  await run(page, 'filter:lighting-effects');
  await expect(page.locator('.dialog input[type="number"][data-key="lights.0.intensity"]')).toBeVisible();
  await confirmDialog(page);
  await committed(page, before + 1);
  const centre = await layerPixel(page, 200, 150), corner = await layerPixel(page, 8, 8);
  expect(centre[0]).toBeGreaterThan(200);
  expect(corner[0]).toBeLessThan(40);
  expect(corner[3]).toBe(255);
  expect(errors).toEqual([]);
});

test('Fibers, Picture Frame, Extrude, Tiles, Trace Contour and Wind open their dialogs and commit one entry each', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await paint(page, '#ff8800', 100, 60, 200, 180);
  for (const [kind, key] of [['fibers', 'variance'], ['picture-frame', 'size'], ['extrude', 'size'], ['tiles', 'count'], ['trace-contour', 'level'], ['wind', 'seed']]) {
    const before = await historyLength(page);
    await run(page, `filter:${kind}`);
    await expect(page.locator(`.dialog input[type="number"][data-key="${key}"]`)).toBeVisible();
    await confirmDialog(page);
    await committed(page, before + 1);
    expect(await page.evaluate(() => window.pigmentApp.settings.lastFilter?.kind)).toBe(kind);
    await runAwait(page, 'edit:undo');
  }
  // the picture frame leaves the middle alone and draws the edges
  const h1 = await historyLength(page);
  await run(page, 'filter:picture-frame');
  await confirmDialog(page);
  await committed(page, h1 + 1);
  expect(await layerPixel(page, 200, 150)).toEqual([255, 136, 0, 255]);
  const edgePixels = await page.evaluate(() => {
    // the vines frame is open-work: count the non-white pixels of the left band instead of probing one
    const l = window.pigmentApp.doc.active;
    const d = l.canvas.getContext('2d').getImageData(0, 0, 36, 300).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] !== 255 || d[i + 1] !== 255 || d[i + 2] !== 255) n++;
    return n;
  });
  expect(edgePixels).toBeGreaterThan(300);
  // every part-B command is enabled (no placeholder left)
  const disabled = await page.evaluate((ids) => ids.filter((id) => !window.pigmentApp.commands.isEnabled(id)), ['filter:displace', 'filter:fibers', 'filter:lighting-effects', 'filter:tree', 'filter:flame', 'filter:picture-frame', 'filter:extrude', 'filter:tiles', 'filter:trace-contour', 'filter:wind']);
  expect(disabled).toEqual([]);
  expect(errors).toEqual([]);
});
