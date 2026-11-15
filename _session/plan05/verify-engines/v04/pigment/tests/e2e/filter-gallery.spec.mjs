// Filter Gallery (src/shared/pixels/gallery-artistic.js + lib/filter-gallery.js): the command is live, the dialog
// stacks effects, reordering changes the result, OK commits one history entry that filter:filter-gallery
// reproduces from the committed params, Cancel restores, and Sketch effects paint with the foreground colour.
import { test, expect } from '@playwright/test';
import { openApp, openFixture, run, runAwait, layerPixel, confirmDialog, historyLength } from './helpers.mjs';

const ARTISTIC = ['colored-pencil', 'cutout', 'dry-brush', 'film-grain', 'fresco', 'neon-glow', 'paint-daubs', 'palette-knife', 'plastic-wrap', 'poster-edges', 'rough-pastels', 'smudge-stick', 'sponge', 'underpainting', 'watercolor'];
const BRUSH = ['accented-edges', 'angled-strokes', 'crosshatch', 'dark-strokes', 'ink-outlines', 'spatter', 'sprayed-strokes', 'sumi-e'];

/** Hash of the active layer's pixels. */
const layerHash = (page) => page.evaluate(() => {
  const l = window.pigmentApp.doc.active;
  const d = l.canvas.getContext('2d').getImageData(0, 0, l.canvas.width, l.canvas.height).data;
  let h = 0;
  for (let i = 0; i < d.length; i++) h = (Math.imul(h, 31) + d[i]) | 0;
  return h;
});
const settings = (page, path) => page.evaluate((p) => p.split('.').reduce((o, k) => o?.[k], window.pigmentApp.settings), path);
const stackKinds = (page) => page.locator('.gallery-dialog .fg-effect').evaluateAll((rows) => rows.map((r) => r.dataset.kind));
const openGallery = async (page) => {
  await run(page, 'filter:filter-gallery');
  await expect(page.locator('.gallery-dialog')).toBeVisible();
  await expect(page.locator('.gallery-dialog .fg-effect').first()).toBeVisible();
};
const clickThumb = async (page, kind) => {
  // the thumbnail's group may still be collapsed: expand the one that holds the kind
  await page.evaluate((k) => {
    const groups = [...document.querySelectorAll('.gallery-dialog .fg-group')];
    for (const g of groups) {
      const head = g.querySelector('.fg-group-head');
      if (head.getAttribute('aria-expanded') !== 'true') head.click();
      if (g.querySelector(`.fg-thumb[data-kind="${k}"]`)) return;
    }
  }, kind);
  await page.locator(`.gallery-dialog .fg-thumb[data-kind="${kind}"]`).click();
};

test('filter:filter-gallery is a live dialog command and every Artistic and Brush Strokes kind is registered', async ({ page }) => {
  const errors = await openApp(page);
  await openFixture(page, 'gradient.png');
  const info = await page.evaluate((kinds) => {
    const app = window.pigmentApp;
    const def = app.commands.commands.get('filter:filter-gallery');
    return {
      has: app.commands.has('filter:filter-gallery'),
      enabled: app.commands.isEnabled('filter:filter-gallery'),
      label: typeof def?.label === 'function' ? def.label() : def?.label,
      dialog: !!def?.dialog,
      stubbed: app.stubbed.includes('filter:filter-gallery'),
      kinds: kinds.map((k) => ({ k, enabled: app.commands.isEnabled(`filter:${k}`), dialog: !!app.commands.commands.get(`filter:${k}`)?.dialog })),
      groups: window.pigmentApp.filterGallery ? 'yes' : 'no',
    };
  }, [...ARTISTIC, ...BRUSH]);
  expect(info.has).toBe(true);
  expect(info.enabled).toBe(true);
  expect(info.label).toBe('Filter Gallery…');
  expect(info.dialog).toBe(true);
  expect(info.stubbed).toBe(false);
  for (const k of info.kinds) {
    expect(k.enabled, k.k).toBe(true);
    expect(k.dialog, k.k).toBe(true);
  }
  expect(info.groups).toBe('yes');
  expect(errors).toEqual([]);
});

test('the gallery stacks two effects, reorders them, commits one entry that the command reproduces', async ({ page }) => {
  const errors = await openApp(page);
  await openFixture(page, 'gradient.png');
  const n0 = await historyLength(page);
  const h0 = await layerHash(page);
  await openGallery(page);
  // the six groups are there; the first effect layer is selected and its group expanded
  await expect(page.locator('.gallery-dialog .fg-group')).toHaveCount(6);
  await expect(page.locator('.gallery-dialog .fg-effect')).toHaveCount(1);
  await expect(page.locator('.gallery-dialog .fg-thumb[aria-pressed="true"]')).toHaveCount(1);
  // zoom controls work
  await page.locator('.gallery-dialog [data-action="zoom-in"]').click();
  await expect(page.locator('.gallery-dialog .fg-zoom')).not.toHaveValue('fit');
  await page.locator('.gallery-dialog .fg-zoom').selectOption('fit');
  await expect(page.locator('.gallery-dialog .fg-zoom')).toHaveValue('fit');
  // first effect: Poster Edges with a stronger edge
  await clickThumb(page, 'poster-edges');
  expect(await stackKinds(page)).toEqual(['poster-edges']);
  const slider = page.locator('.gallery-dialog .fg-fields input[type="number"][data-key="edgeIntensity"]');
  await slider.fill('6');
  await slider.dispatchEvent('change');
  // second effect layer: Film Grain
  await page.locator('.gallery-dialog [data-action="new"]').click();
  await expect(page.locator('.gallery-dialog .fg-effect')).toHaveCount(2);
  await clickThumb(page, 'film-grain');
  expect(await stackKinds(page)).toEqual(['film-grain', 'poster-edges']); // top row = applied last
  // the eye hides an effect layer
  await page.locator('.gallery-dialog .fg-effect[data-kind="film-grain"] .fg-eye').click();
  await expect(page.locator('.gallery-dialog .fg-effect[data-kind="film-grain"] .fg-eye')).toHaveAttribute('aria-pressed', 'false');
  await page.locator('.gallery-dialog .fg-effect[data-kind="film-grain"] .fg-eye').click();
  await expect(page.locator('.gallery-dialog .fg-effect[data-kind="film-grain"] .fg-eye')).toHaveAttribute('aria-pressed', 'true');
  // reorder: move Film Grain below Poster Edges (applied first)
  await page.locator('.gallery-dialog .fg-effect[data-kind="film-grain"]').click();
  await page.locator('.gallery-dialog [data-action="down"]').click();
  expect(await stackKinds(page)).toEqual(['poster-edges', 'film-grain']);
  await page.locator('.gallery-dialog [data-action="up"]').click();
  expect(await stackKinds(page)).toEqual(['film-grain', 'poster-edges']);
  await confirmDialog(page);
  // one history entry, pixels changed, params remembered in order
  await expect.poll(() => historyLength(page)).toBe(n0 + 1); // the commit runs under app.busy after the dialog closes
  const h1 = await layerHash(page);
  expect(h1).not.toBe(h0);
  const params = await settings(page, 'filterParams.filter-gallery');
  expect(params.effects.map((e) => e.kind)).toEqual(['poster-edges', 'film-grain']);
  expect(params.effects[0].params.edgeIntensity).toBe(6);
  expect(params.effects.every((e) => e.enabled)).toBe(true);
  expect(await settings(page, 'lastFilter.kind')).toBe('filter-gallery');
  expect(await page.evaluate(() => window.pigmentApp.doc.history.entries[window.pigmentApp.doc.history.index].label)).toBe('Filter Gallery');
  // undo, then the command with the committed params reproduces the result without a dialog
  await runAwait(page, 'edit:undo');
  expect(await layerHash(page)).toBe(h0);
  await runAwait(page, 'filter:filter-gallery', params);
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0);
  await expect.poll(() => historyLength(page)).toBe(n0 + 1); // the commit runs under app.busy after the dialog closes
  expect(await layerHash(page)).toBe(h1);
  // the other order gives a different result
  await runAwait(page, 'edit:undo');
  const swapped = { effects: [params.effects[1], params.effects[0]] };
  await runAwait(page, 'filter:filter-gallery', swapped);
  expect(await layerHash(page)).not.toBe(h1);
  expect(await layerHash(page)).not.toBe(h0);
  // Last Filter re-runs the stack
  await runAwait(page, 'edit:undo');
  await runAwait(page, 'filter:last');
  await expect.poll(() => historyLength(page)).toBe(n0 + 1); // the commit runs under app.busy after the dialog closes
  expect(errors).toEqual([]);
});

test('Cancel restores the layer; delete empties the stack; the menu option is a setting', async ({ page }) => {
  const errors = await openApp(page);
  await openFixture(page, 'shapes.png');
  const n0 = await historyLength(page);
  const h0 = await layerHash(page);
  await openGallery(page);
  await clickThumb(page, 'sumi-e');
  await page.locator('.gallery-dialog [data-action="delete"]').click();
  await expect(page.locator('.gallery-dialog .fg-effect')).toHaveCount(0);
  await expect(page.locator('.gallery-dialog .fg-empty')).toBeVisible();
  await page.locator('.gallery-dialog [data-action="new"]').click();
  await expect(page.locator('.gallery-dialog .fg-effect')).toHaveCount(1);
  // the setting that lists the six groups in the Filter menu
  expect(await settings(page, 'showGalleryInMenu')).toBeFalsy();
  await page.locator('.gallery-dialog input[data-key="showGalleryInMenu"]').check();
  await expect.poll(() => settings(page, 'showGalleryInMenu')).toBe(true);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.uiState.showGalleryInMenu)).toBe(true);
  await page.locator('.gallery-dialog input[data-key="showGalleryInMenu"]').uncheck();
  await expect.poll(() => settings(page, 'showGalleryInMenu')).toBe(false);
  await page.keyboard.press('Escape');
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0);
  expect(await historyLength(page)).toBe(n0);
  expect(await layerHash(page)).toBe(h0);
  // the transparent background of shapes.png stays transparent after an effect
  await runAwait(page, 'filter:filter-gallery', { effects: [{ kind: 'poster-edges', params: {}, enabled: true }] });
  expect((await layerPixel(page, 5, 5))[3]).toBe(0);
  await expect.poll(() => historyLength(page)).toBe(n0 + 1); // the commit runs under app.busy after the dialog closes
  expect(errors).toEqual([]);
});

test('Sketch effects take the current foreground and background colours', async ({ page }) => {
  const errors = await openApp(page);
  await openFixture(page, 'gradient.png');
  await runAwait(page, 'tool:fg-color', '#ff0000');
  await runAwait(page, 'tool:bg-color', '#ffffff');
  const colors = await page.evaluate(() => window.pigmentApp.filterGallery.colorsFor('stamp'));
  expect(colors).toEqual(['#ff0000', '#ffffff']);
  expect(await page.evaluate(() => window.pigmentApp.filterGallery.colorsFor('poster-edges'))).toBeNull();
  // a Sketch effect added in the dialog carries the colours in its params
  const sketch = await page.evaluate(() => {
    const kinds = ['stamp', 'photocopy', 'graphic-pen', 'bas-relief', 'charcoal', 'chalk-charcoal', 'chrome', 'conte-crayon', 'halftone-pattern', 'note-paper', 'plaster', 'reticulation', 'torn-edges', 'water-paper'];
    return kinds.find((k) => window.pigmentApp.commands.isEnabled(`filter:${k}`)) ?? null;
  });
  const entry = await page.evaluate(() => window.pigmentApp.filterGallery.newEffect('stamp'));
  expect(entry.params.colors).toEqual(['#ff0000', '#ffffff']);
  if (sketch) {
    // gallery-b has landed: the effect paints with the foreground colour
    const h0 = await layerHash(page);
    await runAwait(page, 'filter:filter-gallery', { effects: [{ kind: sketch, params: { colors: ['#ff0000', '#ffffff'] }, enabled: true }] });
    expect(await layerHash(page)).not.toBe(h0);
    const red = await page.evaluate(() => {
      const l = window.pigmentApp.doc.active;
      const d = l.canvas.getContext('2d').getImageData(0, 0, l.canvas.width, l.canvas.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 180 && d[i + 1] < 90 && d[i + 2] < 90) n++;
      return n;
    });
    expect(red).toBeGreaterThan(0);
  }
  expect(errors).toEqual([]);
});
