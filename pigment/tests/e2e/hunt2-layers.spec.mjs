// Regression tests for the second bug hunt: layers, compositing and the Layers panel.
import { test, expect } from '@playwright/test';
import { openApp, newDoc, run, runAwait, pixel, historyLength } from './helpers.mjs';
const near = (got, want, tol = 3) => got.every((v, i) => Math.abs(v - want[i]) <= tol);

/** Adds a raster layer named `name` on top of the stack filled with `color` inside rect (whole canvas by default). */
const addLayer = (page, name, color, rect = null) =>
  page.evaluate(async ([n, c, r]) => {
    const { RasterLayer, createCanvas } = await import('/lib/document.js');
    const d = window.pigmentApp.doc;
    const l = new RasterLayer({ name: n, canvas: createCanvas(d.width, d.height), x: 0, y: 0 });
    if (c) {
      const ctx = l.canvas.getContext('2d');
      ctx.fillStyle = c;
      if (r) ctx.fillRect(...r);
      else ctx.fillRect(0, 0, d.width, d.height);
    }
    d.add(l, d.root, d.root.children.length);
    d.setActive(l);
    d.changed('tree');
    return l.id;
  }, [name, color, rect]);
const byName = (page, name) => page.evaluate((n) => window.pigmentApp.doc.layers().find((l) => l.name === n)?.id ?? null, name);
const activateLayer = (page, name) => page.evaluate((n) => { const d = window.pigmentApp.doc; d.setActive(d.layers().find((l) => l.name === n)); }, name);
const names = (page) => page.evaluate(() => { const walk = (g) => g.children.map((l) => (l.isGroup ? `${l.name}[${walk(l).join(',')}]` : l.name + (l.clip ? '*' : ''))); return walk(window.pigmentApp.doc.root); });
const opaqueCount = (page, name) => page.evaluate((n) => { const l = window.pigmentApp.doc.layers().find((x) => x.name === n); const d = l.canvas.getContext('2d').getImageData(0, 0, l.canvas.width, l.canvas.height).data; let k = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) k++; return k; }, name);

test('merging and rasterizing clipped layers keeps their pixels', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { background: 'white' });
  await addLayer(page, 'Base', '#00ff00', [50, 50, 100, 100]);
  await addLayer(page, 'Blue', '#0000ff');
  await runAwait(page, 'layer:clip');
  await addLayer(page, 'Red', '#ff0000', [0, 0, 400, 100]);
  await runAwait(page, 'layer:clip');
  expect(await names(page)).toEqual(['Background', 'Base', 'Blue*', 'Red*']);
  expect((await pixel(page, 75, 75)).slice(0, 3)).toEqual([255, 0, 0]);
  expect((await pixel(page, 75, 125)).slice(0, 3)).toEqual([0, 0, 255]);
  expect((await pixel(page, 10, 10)).slice(0, 3)).toEqual([255, 255, 255]);
  // Merge Down of a clipped layer onto a clipped layer: one clipped layer with both contents
  await runAwait(page, 'layer:merge-down');
  expect(await names(page)).toEqual(['Background', 'Base', 'Blue*']);
  expect(await opaqueCount(page, 'Blue')).toBeGreaterThan(1000);
  expect((await pixel(page, 75, 75)).slice(0, 3)).toEqual([255, 0, 0]);
  expect((await pixel(page, 75, 125)).slice(0, 3)).toEqual([0, 0, 255]);
  expect((await pixel(page, 10, 10)).slice(0, 3)).toEqual([255, 255, 255]);
  // merging onto the base releases the clip and keeps the composite
  await runAwait(page, 'layer:merge-down');
  expect(await names(page)).toEqual(['Background', 'Base']);
  expect((await pixel(page, 75, 75)).slice(0, 3)).toEqual([255, 0, 0]);
  expect((await pixel(page, 10, 10)).slice(0, 3)).toEqual([255, 255, 255]);
  expect(errors).toEqual([]);
});

test('Rasterize Layer Style bakes the effects and keeps blend mode, opacity and mask', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { background: 'white' });
  await page.evaluate(() => { const l = window.pigmentApp.doc.active; const c = l.canvas.getContext('2d'); c.fillStyle = '#ffff00'; c.fillRect(0, 0, 400, 300); l.touch(); });
  await addLayer(page, 'Box', '#0000ff', [100, 100, 100, 100]);
  await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    const l = d.active;
    l.blend = 'multiply';
    l.styles = { stroke: { enabled: true, size: 6, position: 'outside', color: '#ff0000', opacity: 1, blend: 'normal' } };
    l.touch();
    d.changed('props', { layer: l });
  });
  const inside = await pixel(page, 150, 150), edge = await pixel(page, 97, 150);
  expect(inside.slice(0, 3)).toEqual([0, 0, 0]); // blue × yellow
  expect(edge.slice(0, 3)).toEqual([255, 0, 0]); // red stroke × yellow (multiply keeps red)
  await runAwait(page, 'layer:rasterize-style');
  const info = await page.evaluate(() => { const l = window.pigmentApp.doc.active; return [l.type, l.blend, l.styles, l.name]; });
  expect(info).toEqual(['raster', 'multiply', null, 'Box']);
  expect(await pixel(page, 150, 150)).toEqual(inside);
  expect(await pixel(page, 97, 150)).toEqual(edge);
  expect(errors).toEqual([]);
});

test('merging inside a group applies the group opacity once; a Normal group isolates its children', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { background: 'white' });
  await addLayer(page, 'Left', '#ff0000', [0, 0, 200, 300]);
  await addLayer(page, 'Right', '#0000ff', [200, 0, 200, 300]);
  await page.evaluate(() => { const d = window.pigmentApp.doc; d.selected.clear(); for (const n of ['Left', 'Right']) d.selected.add(d.layers().find((l) => l.name === n)); });
  await runAwait(page, 'layer:group');
  await page.evaluate(() => { const d = window.pigmentApp.doc; const g = d.layers().find((l) => l.isGroup); g.opacity = 0.5; g.touch(); d.changed('props', { layer: g }); });
  const half = (await pixel(page, 50, 50)).slice(0, 3);
  expect(near(half, [255, 128, 128])).toBe(true);
  await activateLayer(page, 'Right');
  await runAwait(page, 'layer:merge-down');
  expect((await pixel(page, 50, 50)).slice(0, 3)).toEqual(half);
  expect(near((await pixel(page, 300, 50)).slice(0, 3), [128, 128, 255])).toBe(true);
  // Normal (not Pass Through) group: a Multiply child only blends inside the group
  await newDoc(page, { background: 'white' });
  await addLayer(page, 'RedBg', '#ff0000');
  await addLayer(page, 'Blue', '#0000ff', [100, 100, 100, 100]);
  await runAwait(page, 'layer:group');
  await page.evaluate(() => { const d = window.pigmentApp.doc; const g = d.layers().find((l) => l.isGroup); g.blend = 'normal'; const b = d.layers().find((l) => l.name === 'Blue'); b.blend = 'multiply'; b.touch(); g.touch(); d.changed('props', { layer: g }); });
  expect((await pixel(page, 150, 150)).slice(0, 3)).toEqual([0, 0, 255]);
  await page.evaluate(() => { const d = window.pigmentApp.doc; const g = d.layers().find((l) => l.isGroup); g.blend = 'pass-through'; g.touch(); d.changed('props', { layer: g }); });
  expect((await pixel(page, 150, 150)).slice(0, 3)).toEqual([0, 0, 0]);
  expect(errors).toEqual([]);
});

test('adjustment layers keep the alpha of semi-transparent pixels', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { background: 'transparent' });
  await page.evaluate(() => { const l = window.pigmentApp.doc.active; const c = l.canvas.getContext('2d'); c.fillStyle = 'rgba(255,0,0,0.5)'; c.fillRect(0, 0, 400, 300); l.touch(); });
  await runAwait(page, 'layer:new-adjustment', 'invert');
  const p = await pixel(page, 50, 50);
  expect(p[3]).toBe(128);
  expect(p.slice(0, 3)).toEqual([0, 255, 255]);
  await page.evaluate(() => { const d = window.pigmentApp.doc; const a = d.active; a.opacity = 0.5; a.touch(); d.changed('props', { layer: a }); });
  const q = await pixel(page, 50, 50);
  expect(q[3]).toBe(128);
  expect(Math.abs(q[0] - 128)).toBeLessThanOrEqual(1);
  expect(Math.abs(q[1] - 128)).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});

test('layer styles follow the mask edge', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { background: 'white' });
  await addLayer(page, 'Rect', '#ff0000', [50, 50, 100, 50]);
  await page.evaluate(async () => {
    const { createCanvas } = await import('/lib/document.js');
    const d = window.pigmentApp.doc;
    const l = d.active;
    const m = createCanvas(d.width, d.height);
    const mc = m.getContext('2d');
    mc.fillStyle = '#fff';
    mc.fillRect(0, 0, 100, d.height); // hides x >= 100
    l.mask = { canvas: m, enabled: true, linked: true };
    l.styles = { stroke: { enabled: true, size: 6, position: 'outside', color: '#000000', opacity: 1, blend: 'normal' } };
    l.touch();
    d.changed('props', { layer: l });
  });
  expect((await pixel(page, 45, 75)).slice(0, 3)).toEqual([0, 0, 0]); // left edge stroke
  expect((await pixel(page, 103, 75)).slice(0, 3)).toEqual([0, 0, 0]); // stroke along the mask edge
  expect((await pixel(page, 120, 75)).slice(0, 3)).toEqual([255, 255, 255]); // masked-out part stays hidden
  expect(errors).toEqual([]);
});

test('double-clicking a layer name renames it', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await runAwait(page, 'window:panel-layers');
  const name = page.locator('[data-panel="layers"] .layer-row .layer-name').first();
  await name.dblclick();
  const input = page.locator('[data-panel="layers"] .layer-row .layer-name input');
  await expect(input).toBeVisible();
  await input.fill('Renamed');
  await input.press('Enter');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.active.name)).toBe('Renamed');
  await expect(page.locator('[data-panel="layers"] .layer-row .layer-name').first()).toHaveText('Renamed');
  expect(await page.evaluate(() => window.pigmentApp.tools.active.id)).not.toBe('eraser');
  expect(errors).toEqual([]);
});

test('a clipped layer that loses its base stays visible and is released', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { background: 'white' });
  await addLayer(page, 'Base', '#00ff00', [50, 50, 100, 100]);
  await addLayer(page, 'Blue', '#0000ff');
  await runAwait(page, 'layer:clip');
  expect((await pixel(page, 10, 10)).slice(0, 3)).toEqual([255, 255, 255]);
  await runAwait(page, 'layer:arrange-back');
  expect(await names(page)).toEqual(['Blue', 'Background', 'Base']);
  // Group a lone clipped layer: it becomes an ordinary layer inside the group
  await runAwait(page, 'edit:undo');
  expect(await names(page)).toEqual(['Background', 'Base', 'Blue*']);
  await runAwait(page, 'layer:group');
  expect(await names(page)).toEqual(['Background', 'Base', 'Group 1[Blue]']);
  expect((await pixel(page, 10, 10)).slice(0, 3)).toEqual([0, 0, 255]);
  expect(errors).toEqual([]);
});

test('Show only this layer on a group keeps the group contents', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { background: 'white' });
  await addLayer(page, 'Red', '#ff0000', [0, 0, 200, 300]);
  await runAwait(page, 'layer:group');
  await addLayer(page, 'Top', '#0000ff', [300, 0, 100, 300]);
  const g = await page.evaluate(() => window.pigmentApp.doc.layers().find((l) => l.isGroup).id);
  await runAwait(page, 'layer:solo', g);
  const vis = await page.evaluate(() => Object.fromEntries(window.pigmentApp.doc.layers().map((l) => [l.name, l.visible])));
  expect(vis).toEqual({ Background: false, 'Group 1': true, Red: true, Top: false });
  expect((await pixel(page, 50, 50)).slice(0, 4)).toEqual([255, 0, 0, 255]);
  expect((await pixel(page, 350, 50))[3]).toBe(0);
  expect(errors).toEqual([]);
});

test('dropping on the lower part of an expanded group row moves the layer into the group', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { background: 'white' });
  await addLayer(page, 'Inner', '#ff0000', [0, 0, 10, 10]);
  await runAwait(page, 'layer:group');
  await addLayer(page, 'Loose', '#0000ff', [0, 0, 10, 10]);
  await runAwait(page, 'window:panel-layers');
  const groupRow = page.locator('[data-panel="layers"] .layer-row').filter({ hasText: 'Group 1' }).first();
  const box = await groupRow.boundingBox();
  const cls = await page.evaluate(([x, y]) => {
    const row = [...document.querySelectorAll('[data-panel="layers"] .layer-row')].find((r) => r.textContent.includes('Group 1'));
    const d = window.pigmentApp.doc;
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: x, clientY: y });
    // start a drag of the loose layer through the panel's own dragstart handler
    const loose = [...document.querySelectorAll('[data-panel="layers"] .layer-row')].find((r) => r.textContent.includes('Loose'));
    loose.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
    row.dispatchEvent(over);
    const c = [...row.classList].filter((k) => k.startsWith('drop-'));
    row.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: new DataTransfer() }));
    return [c, d.layers().find((l) => l.name === 'Loose').parent.name];
  }, [box.x + box.width / 2, box.y + box.height * 0.85]);
  expect(cls).toEqual([['drop-into'], 'Group 1']);
  expect(await names(page)).toEqual(['Background', 'Group 1[Inner,Loose]']);
  expect(errors).toEqual([]);
});

// ---- panels and dialogs ----

test('a modal keeps the keyboard: shortcuts do not reach the document behind Liquify', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { background: 'white' });
  await page.evaluate(() => { const l = window.pigmentApp.doc.active; const c = l.canvas.getContext('2d'); c.fillStyle = '#ff0000'; c.fillRect(150, 100, 100, 100); l.touch(); });
  await runAwait(page, 'image:adjust-invert');
  const n = await historyLength(page);
  await page.evaluate(() => window.pigmentApp.tools.activate('marquee-rect'));
  await run(page, 'filter:liquify');
  const canvas = page.locator('.liquify-canvas');
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.press('Control+z');
  await page.keyboard.press('b');
  await page.keyboard.press('Delete');
  expect(await historyLength(page)).toBe(n);
  expect(await page.evaluate(() => [window.pigmentApp.tools.active.id, window.pigmentApp.doc.layers().length])).toEqual(['marquee-rect', 1]);
  await page.keyboard.press('Escape');
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0);
  expect(await historyLength(page)).toBe(n);
  expect(errors).toEqual([]);
});

test('New Document keeps the physical size while the resolution is typed', async ({ page }) => {
  const errors = await openApp(page);
  await run(page, 'file:new');
  await page.locator('.dialog select[data-key="preset"]').selectOption('a4');
  const dpi = page.locator('.dialog input[data-key="dpi"]');
  await dpi.click();
  await dpi.press('Control+a');
  await dpi.pressSequentially('150');
  await expect(page.locator('.dialog .newdoc-summary')).toContainText('1240 × 1754 px');
  await page.locator('.dialog .dialog-buttons .btn.primary').click();
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc && [window.pigmentApp.doc.width, window.pigmentApp.doc.height, window.pigmentApp.doc.dpi])).toEqual([1240, 1754, 150]);
  expect(errors).toEqual([]);
});

test('panels hidden with Tab show current content when revealed again', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { background: 'white' });
  await runAwait(page, 'window:panel-history');
  await expect(page.locator('[data-panel="history"] .history-item')).toHaveCount(1);
  await runAwait(page, 'window:toggle-panels');
  await expect(page.locator('#panels')).toBeHidden();
  await runAwait(page, 'image:adjust-invert');
  await runAwait(page, 'window:toggle-panels');
  await expect(page.locator('#panels')).toBeVisible();
  await expect(page.locator('[data-panel="history"] .history-item')).toHaveCount(2);
  expect(errors).toEqual([]);
});

test('cancelling a live preview in the same frame as a change restores the pixels', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { background: 'white' });
  await page.evaluate(() => { const l = window.pigmentApp.doc.active; const c = l.canvas.getContext('2d'); c.fillStyle = '#ff0000'; c.fillRect(100, 100, 100, 100); l.touch(); });
  const before = await pixel(page, 100, 100);
  const n = await historyLength(page);
  await run(page, 'filter:gaussian-blur');
  await page.waitForSelector('.dialog-backdrop input[type="range"]');
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    const r = document.querySelector('.dialog-backdrop input[type="range"]');
    r.value = '30';
    r.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('.dialog-backdrop .dialog-buttons button[data-value="null"]').click();
  });
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0);
  await page.waitForTimeout(100);
  expect(await pixel(page, 100, 100)).toEqual(before);
  expect(await historyLength(page)).toBe(n);
  expect(errors).toEqual([]);
});

test('a merged slider change after undo drops the redo entries', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { background: 'white' });
  await page.evaluate(async () => {
    const { setLayerProps } = await import('/lib/layer-ops.js');
    const app = window.pigmentApp;
    const l = app.doc.active;
    setLayerProps(app, l, { opacity: 0.5 }, 'Opacity', { merge: true });
    setLayerProps(app, l, { visible: false }, 'Hide layer');
    setLayerProps(app, l, { visible: true }, 'Show layer');
    app.doc.history.undo();
    app.doc.history.undo();
    setLayerProps(app, l, { opacity: 0.3 }, 'Opacity', { merge: true });
  });
  const h = await page.evaluate(() => ({ labels: window.pigmentApp.doc.history.entries.map((e) => e.label), index: window.pigmentApp.doc.history.index, canRedo: window.pigmentApp.doc.history.canRedo, opacity: window.pigmentApp.doc.active.opacity }));
  expect(h).toEqual({ labels: ['Opacity'], index: 0, canRedo: false, opacity: 0.3 });
  expect(errors).toEqual([]);
});

test('clicking a tab of a collapsed panel group expands it', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await page.evaluate(() => window.pigmentApp.panels.setCollapsed('bottom', true));
  expect(await page.evaluate(() => window.pigmentApp.panels.isVisible('navigator'))).toBe(false);
  await page.locator('.panel-tab[data-panel="navigator"]').click();
  await expect.poll(() => page.evaluate(() => window.pigmentApp.panels.isVisible('navigator'))).toBe(true);
  await expect(page.locator('[data-panel="navigator"].panel')).toBeVisible();
  expect(errors).toEqual([]);
});
