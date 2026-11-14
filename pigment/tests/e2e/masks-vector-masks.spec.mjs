// masks-vector-masks (Pigment 0.4, ARCHITECTURE.md "0.4 features", package 12): mask density and feather on both
// mask kinds (K.1), vector masks (Reveal All / Hide All / Current Path, delete, disable, link, rasterize, select, the
// path target edited with the path tools), the Properties mask controls, the Paths panel row, the Mask and Shape path
// buttons, the Layers panel row (L.15), the mask overlay and its options, .pigment, PSD and 16-bit flattening.
import { test, expect } from '@playwright/test';
import { openApp, newDoc, runAwait, run, pixel, historyLength, confirmDialog, drag } from './helpers.mjs';

/** A 100 x 80 document: white Background, a red layer "Red" over all of it (active). */
async function build(page) {
  await newDoc(page, { width: 100, height: 80, background: 'white' });
  await page.evaluate(async () => {
    const app = window.pigmentApp;
    const d = app.doc;
    const { RasterLayer, createCanvas } = await import('/lib/document.js');
    d.root.children[0].name = 'Background';
    const c = createCanvas(100, 80);
    const g = c.getContext('2d');
    g.fillStyle = '#ff0000';
    g.fillRect(0, 0, 100, 80);
    const layer = new RasterLayer({ name: 'Red', canvas: c, x: 0, y: 0 });
    d.add(layer);
    d.setActive(layer);
    d.changed('tree');
  });
}

/** A rectangle path (document space). */
const rect = (x, y, w, h, op) => ({ subpaths: [{ closed: true, ...(op ? { op } : {}), points: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }] }] });

/** Gives the active layer a raster mask: white (shows) on the left half, black (hides) on the right. */
const halfMask = (page) => page.evaluate(async () => {
  const app = window.pigmentApp;
  const d = app.doc;
  const { createCanvas } = await import('/lib/document.js');
  const { setLayerProps } = await import('/lib/layer-ops.js');
  const m = createCanvas(d.width, d.height);
  const g = m.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, d.width / 2, d.height);
  setLayerProps(app, d.active, { mask: { canvas: m, enabled: true, linked: true } }, 'Add mask');
});

const activeProp = (page, key) => page.evaluate((k) => JSON.parse(JSON.stringify(window.pigmentApp.doc.active[k] ?? null, (n, v) => (v instanceof HTMLCanvasElement ? '<canvas>' : v))), key);
const near = (a, b, tol = 3) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

test('the package replaces its stubs: commands registered, the Mask and Shape path buttons, the preference section', async ({ page }) => {
  const errors = await openApp(page);
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const ids = ['layer:vector-mask', 'layer:mask-overlay', 'layer:mask-overlay-options', 'path:make-mask', 'path:make-shape', 'layer:mask-properties'];
    const { pathTargetKinds } = await import('/lib/tools/vector.js');
    const pathSelect = app.tools.tools.get('path-selection');
    return {
      registered: ids.filter((id) => app.commands.has(id)),
      stubbed: ids.filter((id) => app.stubbed.includes(id) || app.commands.commands.get(id)?.stub),
      kinds: pathTargetKinds().map(([k]) => k),
      buttons: pathSelect.options.filter((o) => o.pathButton).map((o) => o.label),
      prefs: app.preferences.sections().map((s) => s.id),
    };
  });
  expect(r.registered).toHaveLength(6);
  expect(r.stubbed).toEqual([]);
  expect(r.kinds).toContain('vector-mask');
  expect(r.buttons).toEqual(expect.arrayContaining(['Mask', 'Shape']));
  expect(r.prefs).toContain('masks');
  expect(errors).toEqual([]);
});

test('density 50 % halves the mask, feather blurs it, both undoable; Apply bakes only the raster part and keeps the vector mask', async ({ page }) => {
  const errors = await openApp(page);
  await build(page);
  await halfMask(page);
  expect(await pixel(page, 80, 40)).toEqual([255, 255, 255, 255]); // hidden: the Background shows
  const n = await historyLength(page);
  await runAwait(page, 'layer:mask-properties', { part: 'raster', density: 0.5 });
  // half the mask: the red shows at half strength where the mask hid it
  expect(near(await pixel(page, 80, 40), [255, 127, 127, 255], 2)).toBe(true);
  expect(await pixel(page, 20, 40)).toEqual([255, 0, 0, 255]);
  // the mask's own pixels are untouched (non-destructive)
  const raw = await page.evaluate(() => window.pigmentApp.doc.active.mask.canvas.getContext('2d').getImageData(80, 40, 1, 1).data[3]);
  expect(raw).toBe(0);
  expect(await historyLength(page)).toBe(n + 1);
  await runAwait(page, 'layer:mask-properties', { part: 'raster', density: 1 });
  await runAwait(page, 'layer:mask-properties', { part: 'raster', feather: 10 });
  // feathered: a ramp across the edge at x = 50, still solid far away
  const edge = [await pixel(page, 46, 40), await pixel(page, 50, 40), await pixel(page, 54, 40)];
  expect(edge[0][1]).toBeGreaterThan(5);
  expect(edge[0][1]).toBeLessThan(edge[1][1]);
  expect(edge[1][1]).toBeLessThan(edge[2][1]);
  expect(edge[2][1]).toBeLessThan(250);
  expect(await pixel(page, 5, 40)).toEqual([255, 0, 0, 255]);
  expect(await pixel(page, 95, 40)).toEqual([255, 255, 255, 255]);
  await runAwait(page, 'edit:undo');
  expect((await activeProp(page, 'mask')).feather ?? 0).toBe(0);
  expect(await pixel(page, 46, 40)).toEqual([255, 0, 0, 255]);
  await runAwait(page, 'edit:redo');
  expect((await pixel(page, 46, 40))[1]).toBeGreaterThan(5);
  // add a vector mask hiding the bottom rows, then Apply: the raster part with its feather goes into the pixels
  await page.evaluate((p) => window.pigmentApp.commands.run('layer:vector-mask', { op: 'current-path', path: p }, 'api'), rect(0, 0, 100, 60));
  expect(await pixel(page, 20, 70)).toEqual([255, 255, 255, 255]);
  await runAwait(page, 'layer:mask', 'apply');
  const after = await page.evaluate(() => {
    const l = window.pigmentApp.doc.active;
    const px = (x, y) => Array.from(l.canvas.getContext('2d').getImageData(x - l.x, y - l.y, 1, 1).data);
    return { mask: l.mask, vector: !!l.vectorMask, a46: px(46, 40)[3], a5: px(5, 40)[3], a95: px(95, 40)[3], a20bottom: px(20, 70)[3] };
  });
  expect(after.mask).toBeNull();
  expect(after.vector).toBe(true);
  expect(after.a5).toBe(255);
  expect(after.a95).toBe(0);
  expect(after.a46).toBeGreaterThan(5);
  expect(after.a46).toBeLessThan(250);
  // the vector mask was not baked: the pixels below it are still there, and still hidden
  expect(after.a20bottom).toBe(255);
  expect(await pixel(page, 20, 70)).toEqual([255, 255, 255, 255]);
  expect(errors).toEqual([]);
});

test('Hide All and Reveal All differ; Current Path hides outside the path; disable, link, delete; density and feather of the vector mask', async ({ page }) => {
  const errors = await openApp(page);
  await build(page);
  await runAwait(page, 'layer:vector-mask', 'hide-all');
  expect(await activeProp(page, 'vectorMask')).toMatchObject({ initialFill: 'hide', enabled: true, linked: true, density: 1, feather: 0, path: { subpaths: [] } });
  expect(await pixel(page, 50, 40)).toEqual([255, 255, 255, 255]);
  // a second vector mask is refused
  await runAwait(page, 'layer:vector-mask', 'reveal-all');
  expect(await activeProp(page, 'vectorMask')).toMatchObject({ initialFill: 'hide' });
  await runAwait(page, 'layer:vector-mask', 'delete');
  expect(await activeProp(page, 'vectorMask')).toBeNull();
  await runAwait(page, 'layer:vector-mask', 'reveal-all');
  expect(await activeProp(page, 'vectorMask')).toMatchObject({ initialFill: 'reveal' });
  expect(await pixel(page, 50, 40)).toEqual([255, 0, 0, 255]);
  await runAwait(page, 'layer:vector-mask', 'delete');
  // the work path as the vector mask: the layer shows inside it only
  await page.evaluate(async (p) => {
    const app = window.pigmentApp;
    const { recordPaths, setActivePath } = await import('/lib/tools/vector.js');
    recordPaths(app.doc, 'Work path', { workPath: p });
    setActivePath(app, { kind: 'work' });
  }, rect(20, 20, 40, 30));
  expect(await page.evaluate(() => window.pigmentApp.commands.isEnabled('path:make-mask'))).toBe(true);
  await runAwait(page, 'layer:vector-mask', 'current-path');
  expect(await pixel(page, 40, 35)).toEqual([255, 0, 0, 255]);
  expect(await pixel(page, 10, 10)).toEqual([255, 255, 255, 255]);
  expect(await pixel(page, 70, 35)).toEqual([255, 255, 255, 255]);
  // density 25 %: outside the path the layer shows at 75 %
  await runAwait(page, 'layer:mask-properties', { part: 'vector', density: 0.25 });
  expect(near(await pixel(page, 10, 10), [255, 64, 64, 255], 2)).toBe(true);
  await runAwait(page, 'layer:mask-properties', { part: 'vector', density: 1, feather: 8 });
  const ramp = [await pixel(page, 16, 35), await pixel(page, 20, 35), await pixel(page, 24, 35)];
  expect(ramp[0][1]).toBeGreaterThan(ramp[1][1]);
  expect(ramp[1][1]).toBeGreaterThan(ramp[2][1]);
  expect(await pixel(page, 40, 35)).toEqual([255, 0, 0, 255]);
  await runAwait(page, 'layer:mask-properties', { part: 'vector', feather: 0 });
  // disable: everything shows; enable again
  await runAwait(page, 'layer:vector-mask', 'toggle');
  expect(await activeProp(page, 'vectorMask')).toMatchObject({ enabled: false });
  expect(await pixel(page, 10, 10)).toEqual([255, 0, 0, 255]);
  await runAwait(page, 'layer:vector-mask', 'toggle');
  expect(await pixel(page, 10, 10)).toEqual([255, 255, 255, 255]);
  await runAwait(page, 'layer:vector-mask', 'link');
  expect(await activeProp(page, 'vectorMask')).toMatchObject({ linked: false });
  await runAwait(page, 'layer:vector-mask', 'link');
  // the menu state follows
  expect(await page.evaluate(() => [window.pigmentApp.uiState.hasVectorMask, window.pigmentApp.uiState.vectorMaskEnabled])).toEqual([true, true]);
  // a subtracting component on a revealed mask cuts a hole
  await runAwait(page, 'layer:vector-mask', 'delete');
  await runAwait(page, 'layer:vector-mask', 'reveal-all');
  await page.evaluate((p) => {
    const app = window.pigmentApp;
    const l = app.doc.active;
    return import('/lib/layer-ops.js').then(({ setLayerProps }) => setLayerProps(app, l, { vectorMask: { ...l.vectorMask, path: p } }, 'Edit'));
  }, rect(10, 10, 20, 20, 'subtract'));
  expect(await pixel(page, 20, 20)).toEqual([255, 255, 255, 255]);
  expect(await pixel(page, 60, 50)).toEqual([255, 0, 0, 255]);
  expect(errors).toEqual([]);
});

test('a vector mask moves with the layer (linked) and stays when unlinked; rasterize puts it into the layer mask; select loads it', async ({ page }) => {
  const errors = await openApp(page);
  await build(page);
  await page.evaluate((p) => window.pigmentApp.commands.run('layer:vector-mask', { op: 'current-path', path: p }, 'api'), rect(10, 10, 30, 30));
  expect(await pixel(page, 20, 20)).toEqual([255, 0, 0, 255]);
  await page.evaluate(async () => {
    const { offsetLayers } = await import('/lib/layer-move.js');
    const app = window.pigmentApp;
    offsetLayers(app.doc, [app.doc.active], 20, 0, 'Move');
  });
  const firstX = () => page.evaluate(() => window.pigmentApp.doc.active.vectorMask.path.subpaths[0].points[0].x);
  expect(await firstX()).toBe(30);
  // the red now covers x >= 20; inside the moved square it shows, left of it not
  expect(await pixel(page, 35, 20)).toEqual([255, 0, 0, 255]);
  expect(await pixel(page, 25, 20)).toEqual([255, 255, 255, 255]);
  await runAwait(page, 'edit:undo');
  expect(await firstX()).toBe(10);
  // unlinked: the layer moves, the vector mask stays
  await runAwait(page, 'layer:vector-mask', 'link');
  await page.evaluate(async () => {
    const { offsetLayers } = await import('/lib/layer-move.js');
    const app = window.pigmentApp;
    offsetLayers(app.doc, [app.doc.active], 20, 0, 'Move');
  });
  expect(await firstX()).toBe(10);
  await runAwait(page, 'edit:undo');
  await runAwait(page, 'layer:vector-mask', 'link');
  // select: the selection is the path area
  await runAwait(page, 'layer:vector-mask', 'select');
  const sel = await page.evaluate(() => {
    const s = window.pigmentApp.doc.selection;
    return { b: s.bounds, inside: s.mask[20 * 100 + 20], outside: s.mask[5 * 100 + 5] };
  });
  expect(sel.b).toEqual({ x: 10, y: 10, width: 30, height: 30 });
  expect(sel.inside).toBe(255);
  expect(sel.outside).toBe(0);
  await runAwait(page, 'select:none');
  // rasterize: the same picture from a raster mask, no vector mask left, one entry
  await runAwait(page, 'layer:mask-properties', { part: 'vector', feather: 4 });
  const before = [await pixel(page, 10, 25), await pixel(page, 25, 25), await pixel(page, 60, 25)];
  const n = await historyLength(page);
  await runAwait(page, 'layer:vector-mask', 'rasterize');
  expect(await historyLength(page)).toBe(n + 1);
  expect(await activeProp(page, 'vectorMask')).toBeNull();
  expect(await activeProp(page, 'mask')).toMatchObject({ enabled: true, canvas: '<canvas>' });
  const after = [await pixel(page, 10, 25), await pixel(page, 25, 25), await pixel(page, 60, 25)];
  for (let i = 0; i < 3; i++) expect(near(after[i], before[i], 1)).toBe(true);
  await runAwait(page, 'edit:undo');
  expect(await activeProp(page, 'vectorMask')).toMatchObject({ feather: 4 });
  expect(await activeProp(page, 'mask')).toBeNull();
  expect(errors).toEqual([]);
});

test('a vector mask survives .pigment and exports to PSD baked into the layer mask', async ({ page }) => {
  const errors = await openApp(page);
  await build(page);
  await halfMask(page);
  await runAwait(page, 'layer:mask-properties', { part: 'raster', density: 0.5 });
  await page.evaluate((p) => window.pigmentApp.commands.run('layer:vector-mask', { op: 'current-path', path: p }, 'api'), rect(0, 0, 100, 40));
  const expected = [await pixel(page, 20, 20), await pixel(page, 80, 20), await pixel(page, 20, 60)];
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const d = app.doc;
    const { writePigment, readPigment, writePsdDocument, readPsdDocument } = await import('/lib/io.js');
    const back = await readPigment(await writePigment(d));
    const l = back.layers().find((x) => x.name === 'Red');
    // the PSD: one raster mask with the density and the vector mask baked in
    const psd = readPsdDocument(writePsdDocument(d, d.view.compositor));
    const pl = psd.layers().find((x) => x.name === 'Red');
    const m = pl.mask;
    const alpha = (x, y) => m.canvas.getContext('2d').getImageData(x, y, 1, 1).data[3];
    return { vm: l.vectorMask, density: l.mask.density, psdVector: pl.vectorMask, psdMask: { enabled: m.enabled, a: [alpha(20, 20), alpha(80, 20), alpha(20, 60)] } };
  });
  expect(r.vm).toMatchObject({ enabled: true, linked: true, initialFill: 'hide', density: 1, feather: 0 });
  expect(r.vm.path.subpaths[0].points[2]).toEqual({ x: 100, y: 40 });
  expect(r.density).toBe(0.5);
  expect(r.psdVector).toBeNull();
  expect(r.psdMask.enabled).toBe(true);
  expect(r.psdMask.a[0]).toBe(255); // left half, inside the path
  expect(Math.abs(r.psdMask.a[1] - 128)).toBeLessThanOrEqual(2); // right half: density 50 %
  expect(r.psdMask.a[2]).toBe(0); // below the path
  expect(expected[0]).toEqual([255, 0, 0, 255]);
  expect(near(expected[1], [255, 127, 127, 255], 2)).toBe(true);
  expect(expected[2]).toEqual([255, 255, 255, 255]);
  expect(errors).toEqual([]);
});

test('a 16-bit document with a vector mask flattens like the 8-bit one', async ({ page }) => {
  const errors = await openApp(page);
  await build(page);
  await page.evaluate((p) => window.pigmentApp.commands.run('layer:vector-mask', { op: 'current-path', path: p }, 'api'), rect(10, 10, 50, 40));
  await runAwait(page, 'layer:mask-properties', { part: 'vector', density: 0.6 });
  const eight = [await pixel(page, 30, 30), await pixel(page, 80, 70)];
  await runAwait(page, 'image:depth', 16);
  expect(await page.evaluate(() => window.pigmentApp.doc.depth)).toBe(16);
  const deep = await page.evaluate(() => {
    const app = window.pigmentApp;
    const f = app.deep.flatten(app.doc);
    const at = (x, y) => {
      const i = (y * f.width + x) * 4;
      return [0, 1, 2, 3].map((k) => Math.round((f.data[i + k] / 65535) * 255));
    };
    return { inside: at(30, 30), outside: at(80, 70) };
  });
  expect(near(deep.inside, eight[0], 1)).toBe(true);
  expect(near(deep.outside, eight[1], 1)).toBe(true);
  // and the 8-bit view of the 16-bit document agrees
  expect(near(await pixel(page, 80, 70), eight[1], 1)).toBe(true);
  expect(errors).toEqual([]);
});

test('the vector mask is a path target: the Paths panel row, editing with the path tools, path:delete; Mask and Shape buttons', async ({ page }) => {
  const errors = await openApp(page);
  await build(page);
  await page.evaluate((p) => window.pigmentApp.commands.run('layer:vector-mask', { op: 'current-path', path: p }, 'api'), rect(10, 10, 30, 30));
  await page.evaluate(() => window.pigmentApp.panels.show('paths'));
  const row = page.locator('.paths-panel .path-row.vector-mask-row');
  await expect(row).toHaveCount(1);
  await expect(row.locator('.path-name')).toHaveText('Red Vector Mask');
  // Layers panel: clicking the vector mask thumbnail targets it (L.15)
  await page.evaluate(() => window.pigmentApp.panels.show('layers'));
  await page.locator('.layer-row .vector-mask-thumb').first().click();
  expect(await page.evaluate(() => window.pigmentApp.ui.activePath)).toMatchObject({ kind: 'vector-mask' });
  await expect(row).toHaveClass(/selected/);
  // the path tools edit it: a Path Selection drag moves the vector mask's path (preview on the layer, one entry)
  await page.evaluate(() => window.pigmentApp.tools.activate('path-selection'));
  const n = await historyLength(page);
  await drag(page, [25, 10], [45, 10]);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.active.vectorMask.path.subpaths[0].points[0].x)).toBe(30);
  expect(await historyLength(page)).toBe(n + 1);
  expect(await pixel(page, 35, 20)).toEqual([255, 0, 0, 255]);
  expect(await pixel(page, 15, 20)).toEqual([255, 255, 255, 255]);
  // the Mask button with a work path, on a layer without a vector mask; the Shape button makes a shape layer
  await page.evaluate(async (p) => {
    const app = window.pigmentApp;
    const { recordPaths, setActivePath } = await import('/lib/tools/vector.js');
    recordPaths(app.doc, 'Work path', { workPath: p });
    setActivePath(app, { kind: 'work' });
  }, rect(50, 20, 20, 20));
  await page.locator('.options-bar button', { hasText: 'Shape' }).first().click();
  expect(await page.evaluate(() => window.pigmentApp.doc.active.type)).toBe('shape');
  await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    d.setActive(d.layers().find((l) => l.name === 'Background'));
  });
  await page.evaluate(() => window.pigmentApp.commands.run('path:select', { kind: 'work' }, 'api'));
  await page.locator('.options-bar button', { hasText: 'Mask' }).first().click();
  expect(await page.evaluate(() => window.pigmentApp.doc.active.vectorMask?.path.subpaths[0].points[0])).toEqual({ x: 50, y: 20 });
  // path:delete on the vector mask target deletes the vector mask
  await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    d.setActive(d.layers().find((l) => l.name === 'Red'));
  });
  await runAwait(page, 'layer:vector-mask', 'target');
  await runAwait(page, 'path:delete');
  expect(await activeProp(page, 'vectorMask')).toBeNull();
  await expect(page.locator('.paths-panel .path-row.vector-mask-row')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Properties: density and feather fields, the vector mask block, the overlay and its options; the Masks preference', async ({ page }) => {
  const errors = await openApp(page);
  await build(page);
  await page.evaluate(() => window.pigmentApp.panels.show('properties'));
  const box = page.locator('.props-mask');
  await expect(box.locator('[data-act="add-vector"]')).toBeVisible();
  await halfMask(page);
  await expect(box.locator('input[data-key="maskDensity"]')).toHaveValue('100');
  await box.locator('input[data-key="maskDensity"]').fill('40');
  await box.locator('input[data-key="maskDensity"]').dispatchEvent('change');
  await expect.poll(() => activeProp(page, 'mask').then((m) => m.density)).toBeCloseTo(0.4, 5);
  await box.locator('input[data-key="maskFeather"]').fill('6');
  await box.locator('input[data-key="maskFeather"]').dispatchEvent('change');
  await expect.poll(() => activeProp(page, 'mask').then((m) => m.feather)).toBe(6);
  // Invert through the section
  await box.locator('[data-act="invert"]').click();
  expect(await page.evaluate(() => window.pigmentApp.doc.active.mask.canvas.getContext('2d').getImageData(80, 40, 1, 1).data[3])).toBe(255);
  // the vector block
  await box.locator('[data-act="add-vector"]').click();
  await expect(box.locator('input[data-key="vectorDensity"]')).toBeVisible();
  expect(await activeProp(page, 'vectorMask')).toMatchObject({ initialFill: 'reveal' });
  await box.locator('input[data-key="vectorFeather"]').fill('3');
  await box.locator('input[data-key="vectorFeather"]').dispatchEvent('change');
  await expect.poll(() => activeProp(page, 'vectorMask').then((m) => m.feather)).toBe(3);
  await box.locator('[data-act="vector-delete"]').click();
  expect(await activeProp(page, 'vectorMask')).toBeNull();
  // the overlay (\ in Photoshop): the rubylith in the overlay colour
  await box.locator('[data-act="overlay"]').click();
  expect(await page.evaluate(() => window.pigmentApp.ui.showMaskOverlay)).toBe(true);
  await runAwait(page, 'layer:mask-overlay-options', { color: '#00ff00', opacity: 0.25 });
  expect(await page.evaluate(() => window.pigmentApp.settings.masks)).toMatchObject({ overlayColor: '#00ff00', overlayOpacity: 0.25 });
  await page.keyboard.press('Escape');
  await page.locator('canvas.view').first().hover();
  await page.keyboard.press('Backslash');
  expect(await page.evaluate(() => window.pigmentApp.ui.showMaskOverlay)).toBe(false);
  // the options dialog
  await run(page, 'layer:mask-overlay-options');
  await expect(page.locator('.dialog input[data-key="opacity"]').first()).toBeVisible();
  await confirmDialog(page);
  // the Preferences section reads the same settings
  const prefs = await page.evaluate(() => {
    const app = window.pigmentApp;
    const s = app.preferences.sections().find((x) => x.id === 'masks');
    return { read: s.read(app.settings), write: s.write({ maskOverlayColor: '#0000ff', maskOverlayOpacity: 80 }, app.settings) };
  });
  expect(prefs.read).toEqual({ maskOverlayColor: '#00ff00', maskOverlayOpacity: 25 });
  expect(prefs.write).toEqual({ masks: expect.objectContaining({ overlayColor: '#0000ff', overlayOpacity: 0.8 }) });
  expect(errors).toEqual([]);
});

test('the Background rules lock vector masks and mask settings', async ({ page }) => {
  const errors = await openApp(page);
  await build(page);
  const locks = await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    return window.pigmentApp.backgroundRules.lockedProps(d.layers().find((l) => l.name === 'Background'));
  });
  test.skip(!locks.includes('vectorMask'), 'waits for finish-layer-menu: app.backgroundRules.lockedProps does not lock the Background yet');
  await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    d.setActive(d.layers().find((l) => l.name === 'Background'));
  });
  await runAwait(page, 'layer:vector-mask', 'reveal-all');
  expect(await activeProp(page, 'vectorMask')).toBeNull();
  expect(errors).toEqual([]);
});

test('Properties: Select and Mask starts from the layer mask and writes its result back into it', async ({ page }) => {
  const errors = await openApp(page);
  await build(page);
  await halfMask(page);
  await page.evaluate(() => window.pigmentApp.panels.show('properties'));
  await page.locator('.props-mask [data-act="select-and-mask"]').click();
  await expect.poll(() => page.evaluate(() => window.pigmentApp.selectMask.active)).toBe(true);
  await page.evaluate(() => window.pigmentApp.selectMask.whenIdle());
  await page.evaluate(() => window.pigmentApp.selectMask.ok());
  await expect.poll(() => page.evaluate(() => window.pigmentApp.selectMask.active)).toBe(false);
  const r = await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    const l = d.active;
    const a = (x) => l.mask.canvas.getContext('2d').getImageData(x, 40, 1, 1).data[3];
    return { name: l.name, layers: d.layers().length, left: a(10), right: a(90) };
  });
  expect(r).toEqual({ name: 'Red', layers: 2, left: 255, right: 0 });
  expect(errors).toEqual([]);
});
