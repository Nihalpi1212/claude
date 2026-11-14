// Filters, part A (filters-more-a.js + lib/filters-a-ui.js): the kinds are registered and enabled, direct kinds
// apply at once, dialog kinds preview and commit one history entry, Lens Blur reads its depth map from the document.
import { test, expect } from '@playwright/test';
import { openApp, openFixture, run, runAwait, layerPixel, confirmDialog, historyLength } from './helpers.mjs';

const KINDS = ['average', 'blur', 'blur-more', 'lens-blur', 'shape-blur', 'smart-blur', 'sharpen-edges', 'sharpen-more', 'shake-reduction',
  'color-halftone', 'facet', 'mezzotint', 'de-interlace', 'ntsc-colors', 'hsb-hsl'];
const DIALOG = ['lens-blur', 'shape-blur', 'smart-blur', 'shake-reduction', 'color-halftone', 'mezzotint', 'de-interlace', 'hsb-hsl'];

const setNumber = async (page, key, value) => {
  const input = page.locator(`.dialog input[type="number"][data-key="${key}"]`);
  await input.fill(String(value));
  await input.dispatchEvent('change');
};
const settings = (page, path) => page.evaluate((p) => p.split('.').reduce((o, k) => o?.[k], window.pigmentApp.settings), path);

test('every part A kind is registered, enabled and placeholder-free; dialog kinds are marked', async ({ page }) => {
  const errors = await openApp(page);
  await openFixture(page, 'shapes.png');
  const info = await page.evaluate((kinds) => kinds.map((k) => {
    const app = window.pigmentApp, def = app.commands.commands.get(`filter:${k}`);
    return { k, has: app.commands.has(`filter:${k}`), enabled: app.commands.isEnabled(`filter:${k}`), label: typeof def?.label === 'function' ? def.label() : def?.label, dialog: !!def?.dialog };
  }), KINDS);
  for (const i of info) {
    expect(i.has, i.k).toBe(true);
    expect(i.enabled, i.k).toBe(true);
    expect(i.dialog, i.k).toBe(DIALOG.includes(i.k));
    expect(i.label.endsWith('…'), `${i.k} label ${i.label}`).toBe(DIALOG.includes(i.k));
  }
  const cats = await page.evaluate(() => Object.fromEntries(window.pigmentApp.filterCategories.map((c) => [c.id, [...c.kinds]])));
  expect(cats.blur).toEqual(expect.arrayContaining(['average', 'blur', 'blur-more', 'lens-blur', 'shape-blur', 'smart-blur']));
  expect(cats.sharpen).toEqual(expect.arrayContaining(['sharpen-edges', 'sharpen-more', 'shake-reduction']));
  expect(cats.pixelate).toEqual(expect.arrayContaining(['color-halftone', 'facet', 'mezzotint']));
  expect(cats.video).toEqual(['de-interlace', 'ntsc-colors']);
  expect(cats.other).toContain('hsb-hsl');
  expect(errors).toEqual([]);
});

test('direct kinds apply at once with one history entry each and undo cleanly', async ({ page }) => {
  const errors = await openApp(page);
  await openFixture(page, 'shapes.png');
  const n0 = await historyLength(page);
  const edge = await layerPixel(page, 20, 50); // left edge of the red square
  expect(edge).toEqual([255, 0, 0, 255]);
  await runAwait(page, 'filter:blur');
  expect(await historyLength(page)).toBe(n0 + 1);
  const soft = await layerPixel(page, 20, 50);
  expect(soft[3]).toBeGreaterThan(0);
  expect(soft[3]).toBeLessThan(255);
  expect(soft[0]).toBe(255); // premultiplied: no black bleeds in from the transparent side
  await runAwait(page, 'edit:undo');
  expect(await layerPixel(page, 20, 50)).toEqual(edge);
  expect(await historyLength(page)).toBe(n0);
  // Average: every pixel takes the layer's mean colour, alpha kept
  await runAwait(page, 'filter:average');
  expect(await historyLength(page)).toBe(n0 + 1);
  const inside = await layerPixel(page, 50, 50), circle = await layerPixel(page, 140, 90), outside = await layerPixel(page, 5, 5);
  // the half-transparent circle reads back through the canvas's premultiplied storage: allow a level of rounding
  for (let c = 0; c < 3; c++) expect(Math.abs(inside[c] - circle[c])).toBeLessThanOrEqual(1);
  expect(inside[3]).toBe(255);
  expect(circle[3]).toBe(128);
  expect(outside[3]).toBe(0);
  for (const k of ['blur-more', 'facet', 'sharpen-edges', 'sharpen-more', 'ntsc-colors']) {
    const n = await historyLength(page);
    await runAwait(page, `filter:${k}`);
    expect(await historyLength(page), k).toBe(n + 1);
  }
  expect(await settings(page, 'lastFilter.kind')).toBe('ntsc-colors');
  expect(errors).toEqual([]);
});

test('dialog kinds preview on the canvas, commit one entry, remember their params and re-run as Last Filter', async ({ page }) => {
  const errors = await openApp(page);
  await openFixture(page, 'shapes.png');
  let n = await historyLength(page);
  // Smart Blur in Edge Only mode: the flat square previews black
  await run(page, 'filter:smart-blur');
  await expect(page.locator('.dialog-backdrop')).toBeVisible();
  await page.locator('.dialog select[data-key="mode"]').selectOption('edge-only');
  await setNumber(page, 'radius', 4);
  await expect.poll(() => layerPixel(page, 50, 50)).toEqual([0, 0, 0, 255]);
  await confirmDialog(page);
  await expect.poll(() => historyLength(page)).toBe(++n);
  expect(await settings(page, 'filterParams.smart-blur.mode')).toBe('edge-only');
  expect(await settings(page, 'filterParams.smart-blur.radius')).toBe(4);
  expect(await settings(page, 'lastFilter.kind')).toBe('smart-blur');
  await runAwait(page, 'edit:undo');
  expect(await layerPixel(page, 50, 50)).toEqual([255, 0, 0, 255]);
  n--;
  // Last Filter re-runs the remembered params without a dialog
  await run(page, 'filter:last');
  await expect.poll(() => historyLength(page)).toBe(++n);
  expect(await page.locator('.dialog-backdrop').count()).toBe(0);
  expect(await layerPixel(page, 50, 50)).toEqual([0, 0, 0, 255]);
  await runAwait(page, 'edit:undo');
  n--;
  // HSB/HSL: red stored as H 0, S 255, B 255
  await run(page, 'filter:hsb-hsl');
  await expect(page.locator('.dialog-backdrop')).toBeVisible();
  await confirmDialog(page);
  await expect.poll(() => historyLength(page)).toBe(++n);
  expect(await layerPixel(page, 50, 50)).toEqual([0, 255, 255, 255]);
  await runAwait(page, 'edit:undo');
  n--;
  // Shape Blur with a star kernel softens the alpha edge
  await run(page, 'filter:shape-blur');
  await expect(page.locator('.dialog-backdrop')).toBeVisible();
  await page.locator('.dialog select[data-key="shape"]').selectOption('star');
  await setNumber(page, 'radius', 6);
  await confirmDialog(page);
  await expect.poll(() => historyLength(page)).toBe(++n);
  const starEdge = await layerPixel(page, 20, 50);
  expect(starEdge[3]).toBeGreaterThan(0);
  expect(starEdge[3]).toBeLessThan(255);
  expect(await settings(page, 'filterParams.shape-blur.shape')).toBe('star');
  // Color Halftone, Mezzotint, Shake Reduction: open, commit, one entry each
  for (const [k, change] of [
    ['color-halftone', null],
    ['mezzotint', () => page.locator('.dialog select[data-key="type"]').selectOption('long-lines')],
    ['shake-reduction', () => setNumber(page, 'traceBounds', 20)],
  ]) {
    await run(page, `filter:${k}`);
    await expect(page.locator('.dialog-backdrop')).toBeVisible();
    if (change) await change();
    await confirmDialog(page);
    await expect.poll(() => historyLength(page), k).toBe(++n);
  }
  expect(await settings(page, 'filterParams.mezzotint.type')).toBe('long-lines');
  expect(await settings(page, 'filterParams.shake-reduction.traceBounds')).toBe(20);
  const halftoned = await layerPixel(page, 50, 50);
  expect(halftoned[3]).toBe(255);
  // De-Interlace with explicit params runs without a dialog: eliminating even rows copies row 19 (transparent) over row 20
  // (back to the untouched square first: shake, mezzotint, halftone and the star blur are undone)
  for (let k = 0; k < 4; k++) await runAwait(page, 'edit:undo');
  n -= 4;
  expect(await layerPixel(page, 50, 20)).toEqual([255, 0, 0, 255]);
  await runAwait(page, 'filter:de-interlace', { eliminate: 'even', method: 'duplication' });
  await expect.poll(() => historyLength(page)).toBe(++n);
  expect((await layerPixel(page, 50, 20))[3]).toBe(0);
  expect(await layerPixel(page, 50, 21)).toEqual([255, 0, 0, 255]);
  expect(errors).toEqual([]);
});

test('Lens Blur: depth map from the layer transparency or a saved channel, one entry, params remembered without the map', async ({ page }) => {
  const errors = await openApp(page);
  await openFixture(page, 'shapes.png');
  let n = await historyLength(page);
  await run(page, 'filter:lens-blur');
  await expect(page.locator('.dialog-backdrop')).toBeVisible();
  const source = page.locator('.dialog select[data-key="source"]');
  await expect(source).toBeVisible();
  expect(await source.locator('option').allTextContents()).toEqual(['None', 'Transparency']);
  await source.selectOption('transparency');
  await setNumber(page, 'radius', 10);
  // depth = alpha, focal distance 0: the transparent surroundings stay in focus (untouched), the opaque square blurs.
  // Wait for that preview itself: under load the dialog's first preview (a uniform blur, source None) can still be
  // on the layer when the edge has started to soften
  await expect
    .poll(async () => {
      const [edge, outside] = [await layerPixel(page, 20, 50), await layerPixel(page, 15, 50)];
      return edge[3] < 255 && outside[3] === 0;
    })
    .toBe(true);
  await confirmDialog(page);
  await expect.poll(() => historyLength(page)).toBe(++n);
  const edge = await layerPixel(page, 20, 50);
  expect(edge[3]).toBeGreaterThan(0);
  expect(edge[3]).toBeLessThan(255);
  expect((await layerPixel(page, 15, 50))[3]).toBe(0);
  expect(await layerPixel(page, 50, 50)).toEqual([255, 0, 0, 255]);
  const saved = await settings(page, 'filterParams.lens-blur');
  expect(saved.source).toBe('transparency');
  expect(saved.radius).toBe(10);
  expect('depthMap' in saved).toBe(false);
  expect(await settings(page, 'lastFilter.kind')).toBe('lens-blur');
  // Last Filter runs the pure kind without the map: a uniform blur now reaches the transparent side
  await run(page, 'filter:last');
  await expect.poll(() => historyLength(page)).toBe(++n);
  expect((await layerPixel(page, 15, 50))[3]).toBeGreaterThan(0);
  await runAwait(page, 'edit:undo');
  await runAwait(page, 'edit:undo');
  n -= 2;
  // a saved alpha channel is offered as a depth source and remembered as 'alpha' + channel name
  await page.evaluate(() => {
    const d = window.pigmentApp.doc, mask = new Uint8ClampedArray(d.width * d.height);
    for (let y = 0; y < d.height; y++) mask.fill(y < 50 ? 0 : 255, y * d.width, (y + 1) * d.width);
    d.channels.push({ id: 'depth-1', name: 'Depth', mask });
  });
  await run(page, 'filter:lens-blur');
  await expect(page.locator('.dialog-backdrop')).toBeVisible();
  expect(await source.locator('option').allTextContents()).toEqual(['None', 'Transparency', 'Depth']);
  await source.selectOption('channel:depth-1');
  await setNumber(page, 'radius', 8);
  await confirmDialog(page);
  await expect.poll(() => historyLength(page)).toBe(++n);
  // rows above 50 are in focus (depth 0): the top edge of the square stays hard; the bottom edge (depth 255) blurs
  expect(await layerPixel(page, 50, 20)).toEqual([255, 0, 0, 255]);
  expect((await layerPixel(page, 50, 19))[3]).toBe(0);
  const bottom = await layerPixel(page, 50, 79);
  expect(bottom[3]).toBeGreaterThan(0);
  expect(bottom[3]).toBeLessThan(255);
  const saved2 = await settings(page, 'filterParams.lens-blur');
  expect(saved2.source).toBe('alpha');
  expect(saved2.channel).toBe('Depth');
  expect(errors).toEqual([]);
});
