// Smart filters of kinds that bring their own dialog (0.3): the Filter Gallery, the texture-file and colour
// openers and Lens Blur edit pixels, so on a smart object they run on a temporary raster copy and only the
// parameters they resolve with are kept, as an editable smart filter (lib/smart-object.js customFilterDialog).
import { test, expect } from '@playwright/test';
import { openApp, openFixture, run, runAwait, pixel, confirmDialog, historyLength } from './helpers.mjs';

const state = (page) => page.evaluate(() => {
  const d = window.pigmentApp.doc, l = d.active;
  return { type: l.type, visible: l.visible, filters: (l.filters ?? []).map((f) => f.kind), layers: d.layers().map((x) => x.type), selection: !!d.selection && !d.selection.isEmpty };
});
const clickThumb = async (page, kind) => {
  await page.evaluate((k) => {
    for (const g of document.querySelectorAll('.gallery-dialog .fg-group')) {
      const head = g.querySelector('.fg-group-head');
      if (head.getAttribute('aria-expanded') !== 'true') head.click();
      if (g.querySelector(`.fg-thumb[data-kind="${k}"]`)) return;
    }
  }, kind);
  await page.locator(`.gallery-dialog .fg-thumb[data-kind="${kind}"]`).click();
};

test('Filter Gallery on a smart object: the session runs on a copy and leaves one editable smart filter', async ({ page }) => {
  const errors = await openApp(page);
  await openFixture(page, 'shapes.png'); // red square 20..80 on transparency
  await runAwait(page, 'layer:smart-convert');
  expect((await state(page)).type).toBe('smart');
  // a selection must not limit a smart filter (there are no per-filter masks), and it must come back afterwards
  await runAwait(page, 'select:all');
  const n0 = await historyLength(page);
  const before = await pixel(page, 50, 50);
  await run(page, 'filter:filter-gallery');
  await expect(page.locator('.gallery-dialog')).toBeVisible();
  const during = await state(page);
  expect(during.type).toBe('raster'); // the temporary copy is the edit target
  expect(during.layers).toEqual(['smart', 'raster']);
  expect(during.selection).toBe(false);
  await clickThumb(page, 'neon-glow');
  await confirmDialog(page);
  await expect.poll(async () => (await state(page)).filters).toEqual(['filter-gallery']);
  const after = await state(page);
  expect(after.type).toBe('smart');
  expect(after.visible).toBe(true);
  expect(after.layers).toEqual(['smart']); // the copy is gone
  expect(after.selection).toBe(true);
  expect(await historyLength(page)).toBe(n0 + 1); // only the smart filter: the copy's pixel edit left no entry
  expect(await page.evaluate(() => window.pigmentApp.doc.active.filters[0].params.effects.map((e) => e.kind))).toEqual(['neon-glow']);
  const glow = await pixel(page, 50, 50);
  expect(glow).not.toEqual(before);
  // re-editing opens the gallery again with the stored stack; Cancel keeps the filter as it was
  await page.evaluate(() => { window.pigmentApp.smartFilters.edit(window.pigmentApp.doc.active, 0); });
  await expect(page.locator('.gallery-dialog')).toBeVisible();
  expect(await page.locator('.gallery-dialog .fg-effect').evaluateAll((rows) => rows.map((r) => r.dataset.kind))).toEqual(['neon-glow']);
  await page.keyboard.press('Escape');
  await expect(page.locator('.gallery-dialog')).toHaveCount(0);
  await expect.poll(async () => (await state(page)).layers).toEqual(['smart']);
  expect(await historyLength(page)).toBe(n0 + 1);
  expect(await pixel(page, 50, 50)).toEqual(glow);
  // undo removes the smart filter and the original pixels are back
  await runAwait(page, 'edit:undo');
  expect((await state(page)).filters).toEqual([]);
  expect(await pixel(page, 50, 50)).toEqual(before);
  await runAwait(page, 'edit:redo');
  expect(await pixel(page, 50, 50)).toEqual(glow);
  expect(errors).toEqual([]);
});

test('cancelling a custom smart filter session leaves the document and its undo stack untouched', async ({ page }) => {
  const errors = await openApp(page);
  await openFixture(page, 'shapes.png');
  await runAwait(page, 'layer:smart-convert');
  // an undone step must still be redoable after a cancelled session
  await runAwait(page, 'image:adjust-invert');
  await runAwait(page, 'edit:undo');
  const n0 = await historyLength(page);
  const canRedo = () => page.evaluate(() => window.pigmentApp.doc.history.canRedo);
  expect(await canRedo()).toBe(true);
  const before = await pixel(page, 50, 50);
  await run(page, 'filter:filter-gallery');
  await expect(page.locator('.gallery-dialog')).toBeVisible();
  await clickThumb(page, 'poster-edges');
  await page.keyboard.press('Escape');
  await expect(page.locator('.gallery-dialog')).toHaveCount(0);
  await expect.poll(async () => (await state(page)).layers).toEqual(['smart']);
  const after = await state(page);
  expect(after.type).toBe('smart');
  expect(after.filters).toEqual([]);
  expect(await historyLength(page)).toBe(n0);
  expect(await canRedo()).toBe(true);
  expect(await pixel(page, 50, 50)).toEqual(before);
  expect(errors).toEqual([]);
});

test('a field filter with a colour opener (Stamp) and a plain params run both become smart filters', async ({ page }) => {
  const errors = await openApp(page);
  await openFixture(page, 'shapes.png');
  await runAwait(page, 'layer:smart-convert');
  await page.evaluate(() => window.pigmentApp.setColors({ foreground: '#0000ff', background: '#ffff00' }));
  const n0 = await historyLength(page);
  await run(page, 'filter:stamp');
  await expect(page.locator('.dialog-backdrop')).toHaveCount(1);
  await confirmDialog(page);
  await expect.poll(async () => (await state(page)).filters).toEqual(['stamp']);
  expect(await historyLength(page)).toBe(n0 + 1);
  // the smart filter carries the colours that were current when the dialog opened
  expect(await page.evaluate(() => window.pigmentApp.doc.active.filters[0].params.colors)).toEqual(['#0000ff', '#ffff00']);
  const px = await pixel(page, 50, 50);
  expect(px[3]).toBe(255);
  expect([[0, 0, 255], [255, 255, 0]]).toContainEqual(px.slice(0, 3));
  // direct params (what actions and the assistant send) add a smart filter without any dialog
  await runAwait(page, 'filter:wind', { method: 'blast', direction: 'left', seed: 3 });
  expect((await state(page)).filters).toEqual(['stamp', 'wind']);
  expect(await historyLength(page)).toBe(n0 + 2);
  expect(errors).toEqual([]);
});
