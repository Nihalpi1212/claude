// Camera Raw filter (lib/develop-ui.js), printing (lib/print.js) and shape path operations
// (lib/path-ops.js + lib/tools/vector.js) driven through the real UI in the browser build.
import { test, expect } from '@playwright/test';
import { openApp, newDoc, run, runAwait, pixel, drag, confirmDialog, historyLength } from './helpers.mjs';

const paint = (page, color, rect) =>
  page.evaluate(([c, r]) => {
    const l = window.pigmentApp.doc.active;
    const ctx = l.canvas.getContext('2d');
    ctx.fillStyle = c;
    ctx.fillRect(...r);
    l.touch();
    window.pigmentApp.doc.changed('pixels', { layer: l });
  }, [color, rect]);

const red = (p) => p[0] > 200 && p[1] < 60 && p[2] < 60 && p[3] > 200;
const clear = (p) => p[3] === 0;
const cancelDialog = async (page) => {
  await page.locator('.dialog-backdrop .dialog-buttons button[data-value="null"]').last().click();
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0);
};

test('Camera Raw: the preview changes pixels, Cancel restores them, OK records one history entry', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await paint(page, '#808080', [0, 0, 400, 300]);
  expect(await pixel(page, 200, 150)).toEqual([128, 128, 128, 255]);
  const n = await historyLength(page);

  await run(page, 'filter:camera-raw');
  await expect(page.locator('.dialog .camera-raw')).toBeVisible();
  expect(await page.locator('.dialog .dialog-tab').allTextContents()).toEqual(['Basic', 'Detail', 'HSL', 'Effects']);
  await page.locator('.dialog input[type="number"][data-key="exposure"]').fill('2');
  // live preview: two stops brighter on the canvas while the dialog is open
  await expect.poll(async () => (await pixel(page, 200, 150))[0]).toBeGreaterThan(170);
  // Reset returns to neutral, Auto changes something again
  await page.locator('.dialog .camera-raw button[data-action="reset"]').click();
  await expect.poll(async () => (await pixel(page, 200, 150))[0]).toBe(128);
  await page.locator('.dialog .camera-raw button[data-action="reset"]').click();
  await page.locator('.dialog input[type="number"][data-key="exposure"]').fill('2');
  await expect.poll(async () => (await pixel(page, 200, 150))[0]).toBeGreaterThan(170);
  // the other tabs switch and expose their controls
  await page.locator('.dialog .dialog-tab[data-tab="hsl"]').click();
  await expect(page.locator('.dialog input[type="number"][data-key="hsl.reds.hue"]')).toBeVisible();
  await page.locator('.dialog .dialog-tab[data-tab="effects"]').click();
  await expect(page.locator('.dialog input[type="number"][data-key="vignette"]')).toBeVisible();
  await cancelDialog(page);
  expect(await pixel(page, 200, 150)).toEqual([128, 128, 128, 255]);
  expect(await historyLength(page)).toBe(n);

  await run(page, 'filter:camera-raw');
  await page.locator('.dialog input[type="number"][data-key="exposure"]').fill('2');
  await expect.poll(async () => (await pixel(page, 200, 150))[0]).toBeGreaterThan(170);
  await confirmDialog(page);
  expect((await pixel(page, 200, 150))[0]).toBeGreaterThan(170);
  expect(await historyLength(page)).toBe(n + 1);
  expect(await page.evaluate(() => window.pigmentApp.doc.history.entries[window.pigmentApp.doc.history.index].label)).toBe('Camera Raw');
  await runAwait(page, 'edit:undo');
  expect(await pixel(page, 200, 150)).toEqual([128, 128, 128, 255]);
  expect(errors).toEqual([]);
});

test('Print: the dialog previews the page, computes a fit-to-page scale and hands mm geometry to the bridge', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page); // 400 x 300 at 72 dpi = 141.11 x 105.83 mm
  await run(page, 'file:print');
  await expect(page.locator('.dialog .dialog-header h2')).toHaveText('Print');
  await expect(page.locator('.dialog .preview-box canvas')).toBeVisible();
  await page.locator('.dialog .opt-segment .seg-button[data-value="portrait"]').click();
  await expect(page.locator('.dialog select[data-key="paper"]')).toHaveValue('a4');
  // A4 portrait, 10 mm margins: printable 190 x 277 -> the width limits: scale 190 / 141.11 = 1.3466
  await expect(page.locator('.dialog .print-info')).toHaveText(/190 × 142\.5 mm at 135 %/);
  // 100 % shows the natural size
  await page.locator('.dialog .opt-segment .seg-button[data-value="actual"]').click();
  await expect(page.locator('.dialog .print-info')).toHaveText(/141\.11 × 105\.83 mm at 100 %/);
  await page.locator('.dialog .opt-segment .seg-button[data-value="fit"]').click();
  await page.locator('.dialog .dialog-buttons .btn.primary').click();
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0);
  const printed = await page.evaluate(() => window.__pigmentTest.printed);
  expect(printed.dataUrl).toBe('data:image/png;base64,');
  expect(printed.dataUrlLength).toBeGreaterThan(100);
  expect(printed.paper).toEqual({ width: 210, height: 297, name: 'a4' });
  expect(printed.landscape).toBe(false);
  expect(printed.marginsMm).toBe(10);
  expect(printed.widthMm).toBeCloseTo(190, 1);
  expect(printed.heightMm).toBeCloseTo(142.5, 1);
  expect(printed.offsetMm.x).toBeCloseTo(10, 1);
  expect(printed.offsetMm.y).toBeCloseTo(77.25, 1);
  expect(printed.copies).toBe(1);
  expect(printed.pdf).toBe(false);
  // the layout helper is exposed for other modules and agrees with the dialog
  const layout = await page.evaluate(() => window.pigmentApp.print.computePrintLayout({ docWidth: 400, docHeight: 300, dpi: 72, paper: 'a4', landscape: true, marginsMm: 10, scaleMode: 'fit' }));
  expect(layout.pageW).toBe(297);
  expect(layout.heightMm).toBeCloseTo(190, 1);
  expect(layout.fits).toBe(true);
  expect(errors).toEqual([]);
});

test('Path operations: subtract punches a hole, intersect keeps the overlap, exclude removes it, undo restores, Make Selection follows', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { background: 'transparent' });
  await runAwait(page, 'tool:fg-color', '#ff0000');
  await page.evaluate(() => {
    const t = window.pigmentApp.tools;
    for (const id of ['shape-rect', 'shape-ellipse']) {
      t.setOpt(id, 'mode', 'shape', { silent: true });
      t.setOpt(id, 'fillOn', true, { silent: true });
      t.setOpt(id, 'strokeOn', false, { silent: true });
    }
    t.setOpt('shape-rect', 'pathOp', 'new', { silent: true });
    t.activate('shape-rect');
  });
  await expect(page.locator('#options-bar select[data-key="pathOp"], #options-bar .opt[data-key="pathOp"] select')).toHaveValue('new');
  await drag(page, [50, 50], [250, 200]);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.layers().filter((l) => l.type === 'shape').length)).toBe(1);
  expect(red(await pixel(page, 150, 125))).toBe(true);
  expect(red(await pixel(page, 60, 60))).toBe(true);
  const n = await historyLength(page);

  // a second ellipse drawn with "subtract" goes into the same layer and punches a hole
  await page.evaluate(() => {
    window.pigmentApp.tools.setOpt('shape-ellipse', 'pathOp', 'subtract', { silent: true });
    window.pigmentApp.tools.activate('shape-ellipse');
  });
  await expect(page.locator('#options-bar .opt[data-key="pathOp"] select')).toHaveValue('subtract');
  await drag(page, [100, 80], [200, 170]);
  await expect.poll(async () => clear(await pixel(page, 150, 125))).toBe(true);
  expect(await page.evaluate(() => window.pigmentApp.doc.layers().filter((l) => l.type === 'shape').length)).toBe(1);
  expect(await page.evaluate(() => window.pigmentApp.doc.active.path.subpaths.map((s) => s.op ?? 'combine'))).toEqual(['combine', 'subtract']);
  expect(red(await pixel(page, 60, 60))).toBe(true);
  expect(red(await pixel(page, 240, 190))).toBe(true);
  expect(clear(await pixel(page, 20, 20))).toBe(true);
  expect(await historyLength(page)).toBe(n + 1);

  // intersect keeps only the overlap
  await runAwait(page, 'path:op', 'intersect');
  await expect.poll(async () => red(await pixel(page, 150, 125))).toBe(true);
  expect(clear(await pixel(page, 60, 60))).toBe(true);
  expect(clear(await pixel(page, 240, 190))).toBe(true);
  expect(await historyLength(page)).toBe(n + 2);
  // undo of path:op restores the hole
  await runAwait(page, 'edit:undo');
  await expect.poll(async () => clear(await pixel(page, 150, 125))).toBe(true);
  expect(red(await pixel(page, 60, 60))).toBe(true);
  expect(await historyLength(page)).toBe(n + 1);
  // exclude removes the overlap and keeps the rest
  await runAwait(page, 'path:op', 'exclude');
  await expect.poll(async () => clear(await pixel(page, 150, 125))).toBe(true);
  expect(red(await pixel(page, 60, 60))).toBe(true);
  expect(red(await pixel(page, 240, 190))).toBe(true);
  // combine fills everything again
  await runAwait(page, 'path:op', 'combine');
  await expect.poll(async () => red(await pixel(page, 150, 125))).toBe(true);
  await runAwait(page, 'edit:undo'); // back to exclude

  // Make Selection from the shape respects the operations
  await runAwait(page, 'path:make-selection', { op: 'replace' });
  const sel = await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    const at = (x, y) => d.selection.mask[y * d.width + x];
    return { hole: at(150, 125), rect: at(60, 60), outside: at(20, 20) };
  });
  expect(sel.hole).toBe(0);
  expect(sel.rect).toBe(255);
  expect(sel.outside).toBe(0);
  // select:from-layer too (path area, not the rendered stroke)
  await runAwait(page, 'select:none');
  await runAwait(page, 'select:from-layer');
  expect(await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    return [d.selection.mask[125 * d.width + 150], d.selection.mask[60 * d.width + 60]];
  })).toEqual([0, 255]);

  // merge components rasterises the area into plain outlines (hole kept, no ops left)
  await runAwait(page, 'path:merge-components');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.active.path.subpaths.every((s) => !s.op))).toBe(true);
  expect(await page.evaluate(() => window.pigmentApp.doc.active.path.subpaths.length)).toBe(2);
  expect(clear(await pixel(page, 150, 125))).toBe(true);
  expect(red(await pixel(page, 60, 60))).toBe(true);
  expect(errors).toEqual([]);
});
