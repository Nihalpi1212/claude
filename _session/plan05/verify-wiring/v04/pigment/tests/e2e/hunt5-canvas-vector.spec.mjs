// Regressions from the 0.4 cross-feature hunt, area "canvas-vector": a live shape aligns, transforms, rotates about
// and reveals by its drawn content (not its padded render box); a Properties mask slider starts its own history entry
// instead of folding into Add Vector Mask or a path move; Edit Selected Guides leaves an untouched position alone;
// the rulers have Picas.
import { test, expect } from '@playwright/test';
import { openApp, newDoc, run, runAwait, drag, confirmDialog } from './helpers.mjs';

/** A live rectangle (no stroke) made with the Rectangle tool's own builder. */
const addRect = (page, box) => page.evaluate((r) => {
  const app = window.pigmentApp;
  app.tools.setOpt('shape-rect', 'strokeOn', false, { silent: true });
  app.tools.activate('shape-rect');
  const t = app.tools.active;
  t.create(t.build(r));
}, box);
const shapeBox = (page) => page.evaluate(() => {
  const s = window.pigmentApp.doc.layers().find((l) => l.type === 'shape');
  return { x: s.shapeProps.x, y: s.shapeProps.y, width: s.shapeProps.width, height: s.shapeProps.height };
});
const labels = (page) => page.evaluate(() => {
  const h = window.pigmentApp.doc.history;
  return h.entries.slice(0, h.index + 1).map((e) => e.label);
});

test.beforeEach(async ({ page }) => {
  page.errors = await openApp(page);
});
test.afterEach(async ({ page }) => {
  expect(page.errors).toEqual([]);
});

test('a live shape rotates and flips about its own centre: four quarter turns or two flips give it back', async ({ page }) => {
  await newDoc(page, { width: 400, height: 300, background: 'white' });
  await addRect(page, { x: 50, y: 50, width: 150, height: 100 });
  for (let i = 0; i < 4; i++) await runAwait(page, 'edit:transform', 'rotate-90');
  expect(await shapeBox(page)).toEqual({ x: 50, y: 50, width: 150, height: 100 });
  for (let i = 0; i < 2; i++) await runAwait(page, 'edit:transform', 'flip-h');
  for (let i = 0; i < 2; i++) await runAwait(page, 'edit:transform', 'flip-v');
  for (let i = 0; i < 2; i++) await runAwait(page, 'edit:transform', 'rotate-180');
  expect(await shapeBox(page)).toEqual({ x: 50, y: 50, width: 150, height: 100 });
  // Free Transform hugs the path, not the render box padded 1 px left/top and 2 px right/bottom
  await run(page, 'edit:free-transform');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.transformTool.session?.box ?? null)).toEqual({ x: 50, y: 50, width: 150, height: 100 });
  await page.keyboard.press('Escape');
});

test('Align puts a live shape edge to edge with a raster layer, and Reveal All adds no empty column', async ({ page }) => {
  await newDoc(page, { width: 400, height: 300, background: 'white' });
  await runAwait(page, 'layer:new-no-dialog');
  await page.evaluate(() => {
    const L = window.pigmentApp.doc.active;
    L.name = 'Red';
    const c = L.canvas.getContext('2d');
    c.fillStyle = '#f00';
    c.fillRect(100 - L.x, 100 - L.y, 50, 50);
    L.touch();
  });
  await addRect(page, { x: 200, y: 160, width: 80, height: 40 });
  await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    d.selected = new Set(d.layers().filter((l) => l.name === 'Red' || l.type === 'shape'));
  });
  const redX = () => page.evaluate(() => window.pigmentApp.doc.layers().find((l) => l.name === 'Red').x);
  await runAwait(page, 'layer:align', 'left');
  expect((await shapeBox(page)).x).toBe(100);
  await runAwait(page, 'edit:undo');
  await runAwait(page, 'layer:align', 'top');
  expect((await shapeBox(page)).y).toBe(100);
  await runAwait(page, 'edit:undo');
  // the red square's right edge (x + 150) moves to the shape's right edge, 280
  const x0 = await redX();
  await runAwait(page, 'layer:align', 'right');
  expect((await redX()) - x0).toBe(130);
  expect((await shapeBox(page)).x).toBe(200);
  await runAwait(page, 'edit:undo');

  // Reveal All: a shape from x = -50 makes the canvas exactly 50 px wider
  await newDoc(page, { width: 300, height: 200, background: 'white' });
  await addRect(page, { x: -50, y: 20, width: 120, height: 60 });
  await runAwait(page, 'image:reveal-all');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.width)).toBe(350);
  expect(await page.evaluate(() => window.pigmentApp.doc.height)).toBe(200);
  expect((await shapeBox(page)).x).toBe(0);
});

test('a mask slider moved right after Add Vector Mask or a path move is its own history entry', async ({ page }) => {
  await newDoc(page, { width: 300, height: 200, background: 'white' });
  await runAwait(page, 'layer:new-no-dialog');
  await page.evaluate(() => {
    const L = window.pigmentApp.doc.active;
    const c = L.canvas.getContext('2d');
    c.fillStyle = '#0000ff';
    c.fillRect(0, 0, 4000, 4000);
    L.touch();
  });
  const path = { subpaths: [{ closed: true, points: [{ x: 50, y: 50 }, { x: 150, y: 50 }, { x: 150, y: 150 }, { x: 50, y: 150 }] }] };
  await runAwait(page, 'layer:vector-mask', { op: 'current-path', path });
  await page.evaluate(() => window.pigmentApp.panels.show('properties'));
  const vm = () => page.evaluate(() => {
    const m = window.pigmentApp.doc.active.vectorMask;
    return m ? { x: Math.round(m.path.subpaths[0].points[0].x), density: m.density, feather: m.feather } : null;
  });

  // a pointer drag on Density straight after Add Vector Mask: one new entry, and one Undo keeps the mask
  const range = page.locator('.props-mask [data-key="vectorDensityRange"]').first();
  await range.scrollIntoViewIfNeeded();
  const bb = await range.boundingBox();
  await page.mouse.move(bb.x + bb.width - 2, bb.y + bb.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(bb.x + bb.width - 2 - (i * bb.width) / 20, bb.y + bb.height / 2);
  await page.mouse.up();
  await expect.poll(() => labels(page)).toEqual(['New layer', 'Add Vector Mask', 'Vector Mask Density']);
  expect((await vm()).density).toBeLessThan(1);
  await runAwait(page, 'edit:undo');
  expect(await vm()).toEqual({ x: 50, density: 1, feather: 0 });

  // move the path, then nudge Feather at once: the path move survives one Undo
  await page.evaluate(() => window.pigmentApp.tools.activate('path-selection'));
  await drag(page, [100, 100], [140, 100]);
  await expect.poll(async () => (await vm()).x).toBe(90);
  const feather = page.locator('.props-mask [data-key="vectorFeatherRange"]').first();
  // the Properties panel redraws once the move is committed (history:changed, on the next frame): wait for both, so
  // the key goes to the slider the panel keeps (a focused input is not rebuilt)
  await expect.poll(async () => (await labels(page)).at(-1)).toBe('Move Path');
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await feather.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await vm()).feather).toBeCloseTo(0.1, 5);
  expect((await labels(page)).slice(-2)).toEqual(['Move Path', 'Vector Mask Feather']);
  await runAwait(page, 'edit:undo');
  expect(await vm()).toEqual({ x: 90, density: 1, feather: 0 });

  // a merging call never folds Feather into Density (the merge key names the setting)
  await runAwait(page, 'layer:mask-properties', { part: 'vector', density: 0.6 });
  await runAwait(page, 'layer:mask-properties', { part: 'vector', feather: 3, merge: true });
  expect((await labels(page)).slice(-2)).toEqual(['Vector Mask Density', 'Vector Mask Feather']);
});

test('Edit Selected Guides with only the colour changed leaves the guide where it is', async ({ page }) => {
  await newDoc(page, { width: 1200, height: 900, background: 'white', dpi: 300 });
  await runAwait(page, 'view:new-guide', { axis: 'x', pos: 101 });
  await runAwait(page, 'view:ruler-unit', 'in');
  await page.evaluate(async () => {
    const g = await import('/lib/guides.js');
    const app = window.pigmentApp;
    g.selectGuides(app, app.doc.view ?? app.view, app.doc.guides.map((x) => x.id));
  });
  await page.evaluate(() => {
    window.pigmentApp.commands.run('view:edit-selected-guides', undefined, 'menu'); // resolves when the dialog closes
  });
  const dlg = page.locator('.dialog-backdrop');
  await expect(dlg.locator('input[data-key="position"]')).toHaveValue('0.337');
  await page.evaluate(() => {
    const s = document.querySelector('.dialog-backdrop select');
    s.selectedIndex = 2;
    s.dispatchEvent(new Event('input', { bubbles: true }));
    s.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await confirmDialog(page);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.history.entries[window.pigmentApp.doc.history.index]?.label)).toBe('Edit Guides');
  const guides = await page.evaluate(() => window.pigmentApp.doc.guides.map((g) => ({ axis: g.axis, pos: g.pos, color: g.color ?? null })));
  expect(guides).toHaveLength(1);
  expect(guides[0].pos).toBe(101);
  expect(guides[0].color).not.toBeNull();
});

test('the rulers have Picas: the unit is kept, typed picas parse, an unknown unit is reported', async ({ page }) => {
  await newDoc(page, { width: 600, height: 400, background: 'white', dpi: 72 });
  await runAwait(page, 'view:ruler-unit', 'pt');
  await runAwait(page, 'view:ruler-unit', 'pica');
  expect(await page.evaluate(() => window.pigmentApp.settings.rulerUnit)).toBe('pica');
  expect(await page.evaluate(() => window.pigmentApp.rulers.format(window.pigmentApp.doc, 'x', 36))).toBe('3 pc');
  expect(await page.evaluate(() => window.pigmentApp.rulers.parse(window.pigmentApp.doc, 'x', '1pc'))).toBe(12);
  // the ruler context menu lists Picas
  const names = await page.evaluate(async () => (await import('/lib/rulers.js')).UNITS);
  expect(names).toContain('pica');
  expect(await runAwait(page, 'view:ruler-unit', 'furlong')).toBe(false);
  await expect(page.locator('.toast', { hasText: 'Unknown ruler unit' })).toHaveCount(1);
  expect(await page.evaluate(() => window.pigmentApp.settings.rulerUnit)).toBe('pica');
});
