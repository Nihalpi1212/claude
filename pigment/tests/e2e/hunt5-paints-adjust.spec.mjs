// Regressions from the 0.4 cross-feature hunt, area "paints-adjust": Gradient Map stops through PSD (smoothness 0,
// midpoints, opacity stops), OK in the Gradient Fill section's editor as one undoable edit, View previous
// state as a display only, gradient presets without placement, Cancel in New Fill Layer, and Reset as its own step.
import { test, expect } from '@playwright/test';
import { openApp, newDoc, runAwait } from './helpers.mjs';

const labels = (page) => page.evaluate(() => {
  const h = window.pigmentApp.doc.history;
  return h.entries.slice(0, h.index + 1).map((e) => e.label);
});

/** Adds a colourful raster layer 'Img' to the active document (no history). */
const colorLayer = (page) => page.evaluate(async () => {
  const d = window.pigmentApp.doc;
  const { RasterLayer, createCanvas } = await import('/lib/document.js');
  const c = createCanvas(d.width, d.height);
  const g = c.getContext('2d');
  for (let x = 0; x < d.width; x++) {
    const gr = g.createLinearGradient(0, 0, 0, d.height);
    gr.addColorStop(0, `hsl(${(x * 3) % 360},90%,50%)`);
    gr.addColorStop(1, `hsl(${(x * 3) % 360},40%,${15 + (x % 7) * 10}%)`);
    g.fillStyle = gr;
    g.fillRect(x, 0, 1, d.height);
  }
  const l = new RasterLayer({ name: 'Img', canvas: c, x: 0, y: 0 });
  d.add(l);
  d.setActive(l);
  d.changed('tree');
});

test('a Gradient Map keeps its stops, midpoints, opacity stops and smoothness through PSD', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 120, height: 80, background: 'white' });
  await colorLayer(page);
  const out = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { writePsdDocument, readPsdDocument } = await import('/lib/io.js');
    const { readPsd } = await import('ag-psd');
    const read = (d) => (d.view?.compositor ?? app.view.compositor).composite(d).getContext('2d').getImageData(0, 0, d.width, d.height).data;
    const defs = {
      // Spectrum-like: classic, smoothness 0 (the 0.3 upgrade value and most built-in presets)
      spectrum: { gradientVersion: 2, type: 'solid', interpolation: 'classic', smoothness: 0, stops: [{ pos: 0, mid: 0.5, color: '#ff0000' }, { pos: 0.2, mid: 0.5, color: '#00ff00' }, { pos: 1, mid: 0.5, color: '#0000ff' }], opacityStops: [{ pos: 0, mid: 0.5, opacity: 1 }, { pos: 1, mid: 0.5, opacity: 1 }] },
      rich: { gradientVersion: 2, type: 'solid', interpolation: 'classic', smoothness: 0.8, stops: [{ pos: 0, mid: 0.5, color: '#101060' }, { pos: 0.4, mid: 0.3, color: '#f0a000' }, { pos: 1, mid: 0.7, color: '#ffffff' }], opacityStops: [{ pos: 0, mid: 0.5, opacity: 1 }, { pos: 1, mid: 0.5, opacity: 0.5 }] },
    };
    const res = {};
    for (const [name, def] of Object.entries(defs)) {
      const d = app.doc;
      await app.commands.run('layer:new-adjustment', { kind: 'gradient-map', params: def }, 'api');
      const before = read(d);
      const bytes = writePsdDocument(d, app.view.compositor);
      // the file holds the locations out of 4096 whatever the smoothness, as Photoshop reads them
      const raw = readPsd(bytes, { skipThumbnail: true, skipLayerImageData: true, skipCompositeImageData: true });
      const a = raw.children.find((c) => c.adjustment?.type === 'gradient map').adjustment;
      const back = readPsdDocument(bytes);
      const dd = back.doc ?? back;
      app.docs.add(dd, { activate: false });
      const L = dd.layers().find((l) => l.type === 'adjustment');
      const after = read(dd);
      let max = 0;
      for (let i = 0; i < before.length; i++) max = Math.max(max, Math.abs(before[i] - after[i]));
      res[name] = { fileLocations: a.colorStops.map((s) => Math.round(s.location * a.smoothness * 1000) / 1000), params: L.params, max };
      await app.commands.run('edit:undo', undefined, 'api');
    }
    return res;
  });
  expect(out.spectrum.fileLocations).toEqual([0, 0.2, 1]);
  expect(out.spectrum.params.stops.map((s) => Math.round((s.pos ?? s.offset) * 1000) / 1000)).toEqual([0, 0.2, 1]);
  expect(out.spectrum.max).toBeLessThanOrEqual(3);
  expect(out.rich.fileLocations).toEqual([0, 0.4, 1]);
  expect(out.rich.params).toMatchObject({ gradientVersion: 2, interpolation: 'classic' });
  expect(out.rich.params.smoothness).toBeCloseTo(0.8, 3);
  expect(out.rich.params.stops.map((s) => s.mid)).toEqual([0.5, 0.3, 0.7]);
  expect(out.rich.params.opacityStops.map((s) => Math.round(s.opacity * 100) / 100)).toEqual([1, 0.5]);
  expect(out.rich.max).toBeLessThanOrEqual(3);
  expect(errors).toEqual([]);
});

test('OK in the Gradient Editor of a Gradient Fill layer\'s Properties is one undoable edit and dirties the document', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 120, height: 80, background: 'white' });
  await colorLayer(page);
  await page.evaluate(async () => {
    const app = window.pigmentApp;
    await app.commands.run('layer:new-fill', { kind: 'gradient', paint: { type: 'gradient', gradient: { gradientVersion: 2, type: 'solid', interpolation: 'classic', smoothness: 1, stops: [{ pos: 0, mid: 0.5, color: '#ff0000' }, { pos: 1, mid: 0.5, color: '#0000ff' }], opacityStops: [{ pos: 0, mid: 0.5, opacity: 1 }, { pos: 1, mid: 0.5, opacity: 1 }], kind: 'linear', from: [10, 10], to: [110, 70] } } }, 'api');
    app.panels.show('properties', { reveal: true });
    app.doc.history.markSaved();
  });
  const interp = () => page.evaluate(() => window.pigmentApp.doc.layers().find((l) => l.type === 'fill')?.paint.gradient.interpolation ?? null);
  const bar = page.locator('[data-panel="properties"] .gw-bar').first();
  // Cancel takes the preview back and records nothing
  await bar.click();
  await page.locator('.dialog select[data-key="interpolation"]').last().selectOption('stripes');
  await expect.poll(interp).toBe('stripes');
  await page.keyboard.press('Escape');
  await expect.poll(interp).toBe('classic');
  expect(await labels(page)).toEqual(['New fill layer']);
  // OK commits one entry and dirties the document
  await bar.click();
  await page.locator('.dialog select[data-key="interpolation"]').last().selectOption('stripes');
  await page.locator('.dialog .dialog-buttons .btn.primary').last().click();
  await expect.poll(() => labels(page)).toEqual(['New fill layer', 'Edit gradient fill']);
  expect(await interp()).toBe('stripes');
  expect(await page.evaluate(() => window.pigmentApp.doc.history.dirty)).toBe(true);
  // Undo takes the edit back, not the layer
  await runAwait(page, 'edit:undo');
  expect(await interp()).toBe('classic');
  expect(errors).toEqual([]);
});

test('View previous state is a display only: Save As and Duplicate take the layer\'s own settings', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 120, height: 80, background: 'white' });
  await colorLayer(page);
  await runAwait(page, 'layer:new-adjustment', 'hue-saturation');
  await page.evaluate(() => window.pigmentApp.panels.show('properties', { reveal: true }));
  const sat = page.locator('[data-panel="properties"] input[type="number"][data-key="saturation"]').first();
  await sat.click();
  await sat.fill('-100');
  await page.keyboard.press('Tab');
  const sats = () => page.evaluate(() => window.pigmentApp.doc.layers().filter((l) => l.type === 'adjustment').map((l) => l.params.saturation));
  await expect.poll(sats).toEqual([-100]);
  const prev = page.locator('[data-panel="properties"] [data-act="previous"]');
  await prev.click();
  await expect.poll(sats).toEqual([0]);
  // Save As while the previous state shows writes the real settings
  await page.evaluate(() => {
    window.__pigmentTest.nextSavePath = '/tmp/hunt5-previous.pigment';
  });
  await runAwait(page, 'file:save-as');
  await expect.poll(() => page.evaluate(() => Object.keys(window.__pigmentTest.written).includes('/tmp/hunt5-previous.pigment'))).toBe(true);
  const saved = await page.evaluate(async () => {
    const { readPigment } = await import('/lib/io.js');
    const d = await readPigment(window.__pigmentTest.written['/tmp/hunt5-previous.pigment']);
    return d.layers().filter((l) => l.type === 'adjustment').map((l) => l.params.saturation);
  });
  expect(saved).toEqual([-100]);
  expect(await sats()).toEqual([-100]);
  await expect(prev).toHaveAttribute('aria-pressed', 'false');
  // Duplicate while previewing copies the real settings
  await prev.click();
  await expect.poll(sats).toEqual([0]);
  await runAwait(page, 'layer:duplicate');
  await expect.poll(sats).toEqual([-100, -100]);
  expect(errors).toEqual([]);
});

test('a gradient preset made from a Gradient Fill layer holds no placement, and a drop is placed across the document', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 120, height: 80, background: 'white' });
  await colorLayer(page);
  await page.evaluate(async () => {
    const app = window.pigmentApp;
    await app.commands.run('layer:new-fill', { kind: 'gradient', paint: { type: 'gradient', gradient: { gradientVersion: 2, type: 'solid', interpolation: 'perceptual', smoothness: 1, stops: [{ pos: 0, mid: 0.5, color: '#ff0000' }, { pos: 1, mid: 0.5, color: '#0000ff' }], opacityStops: [{ pos: 0, mid: 0.5, opacity: 1 }, { pos: 1, mid: 0.5, opacity: 1 }], kind: 'radial', reverse: true, from: [30, 30], to: [50, 30] } } }, 'api');
    app.panels.show('gradients', { reveal: true });
  });
  await page.locator('.gradients-panel [data-act="new"]').click();
  await page.locator('.dialog input[type="text"]').last().fill('FromLayer');
  await page.keyboard.press('Enter');
  const data = () => page.evaluate(() => window.pigmentApp.presets.list('gradients').find((x) => x.name === 'FromLayer')?.data ?? null);
  await expect.poll(data).not.toBeNull();
  const d = await data();
  for (const k of ['kind', 'reverse', 'from', 'to']) expect(d[k]).toBeUndefined();
  expect(d.stops.map((s) => s.color)).toEqual(['#ff0000', '#0000ff']);
  // a preset that still holds a layer's placement (made by an earlier build) is placed across the new document
  await newDoc(page, { width: 300, height: 200, background: 'white' });
  const g = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { dropGradient } = await import('/lib/gradient-paint.js');
    await dropGradient(app, JSON.stringify({ gradientVersion: 2, type: 'solid', interpolation: 'classic', smoothness: 0, stops: [{ pos: 0, mid: 0.5, color: '#ff0000' }, { pos: 1, mid: 0.5, color: '#0000ff' }], opacityStops: [{ pos: 0, mid: 0.5, opacity: 1 }, { pos: 1, mid: 0.5, opacity: 1 }], from: [30, 30], to: [50, 30] }));
    const p = app.doc.active.paint.gradient;
    return { type: app.doc.active.type, from: p.from, to: p.to };
  });
  expect(g).toEqual({ type: 'fill', from: [0, 100], to: [300, 100] });
  expect(errors).toEqual([]);
});

test('Cancel in the Gradient Fill or Pattern Fill dialog of New Fill Layer cancels the whole command', async ({ page }) => {
  const errors = await openApp(page);
  const names = () => page.evaluate(() => window.pigmentApp.doc.layers().map((l) => l.name));
  for (const kind of ['gradient', 'pattern']) {
    await newDoc(page, { width: 120, height: 80, background: 'white' });
    await colorLayer(page);
    await page.evaluate(() => window.pigmentApp.patterns?.ready?.());
    await page.evaluate((k) => {
      window.__fillDone = false;
      Promise.resolve(window.pigmentApp.commands.run('layer:new-fill', k, 'menu')).then(() => { window.__fillDone = true; });
    }, kind);
    // New Layer: OK; then the fill's own dialog: Cancel
    await expect(page.locator('.dialog')).toHaveCount(1);
    await page.locator('.dialog .dialog-buttons .btn.primary').last().click();
    await expect.poll(() => page.locator('.dialog .dialog-title, .dialog h2').last().innerText().catch(() => '')).toMatch(/Gradient Fill|Pattern Fill/);
    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => window.__fillDone)).toBe(true);
    expect(await names()).toEqual(['Background', 'Img']);
    expect(await labels(page)).toEqual([]);
    expect(await page.evaluate(() => window.pigmentApp.doc.active?.name)).toBe('Img');
  }
  // OK keeps the layer
  await page.evaluate(() => {
    window.__fillDone = false;
    Promise.resolve(window.pigmentApp.commands.run('layer:new-fill', 'gradient', 'menu')).then(() => { window.__fillDone = true; });
  });
  await expect(page.locator('.dialog')).toHaveCount(1);
  await page.locator('.dialog .dialog-buttons .btn.primary').last().click();
  await expect.poll(() => page.locator('.dialog .dialog-title, .dialog h2').last().innerText().catch(() => '')).toMatch(/Gradient Fill/);
  await page.locator('.dialog .dialog-buttons .btn.primary').last().click();
  await expect.poll(() => page.evaluate(() => window.__fillDone)).toBe(true);
  expect(await names()).toEqual(['Background', 'Img', 'Gradient Fill 1']);
  expect(errors).toEqual([]);
});

test('an eyedropper pick in Properties right after Reset is its own undo step', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 120, height: 80, background: 'white' });
  await colorLayer(page);
  await runAwait(page, 'layer:new-adjustment', 'levels');
  await page.evaluate(() => window.pigmentApp.panels.show('properties', { reveal: true }));
  const pick = async (which) => {
    await page.locator(`[data-panel="properties"] [data-eyedropper="${which}"]`).first().click();
    const s = await page.evaluate(() => {
      const v = window.pigmentApp.view;
      const p = v.toScreen(40.5, 50.5);
      const r = v.canvas.getBoundingClientRect();
      return { x: r.left + p.x, y: r.top + p.y };
    });
    await page.mouse.click(s.x, s.y);
  };
  const tail = async (n) => (await labels(page)).slice(-n);
  await pick('white');
  await expect.poll(() => tail(1)).toEqual(['Edit Levels']);
  await page.locator('[data-panel="properties"] [data-act="reset"]').first().click();
  await expect.poll(() => tail(1)).toEqual(['Reset Levels']);
  await pick('black');
  await expect.poll(() => tail(3)).toEqual(['Edit Levels', 'Reset Levels', 'Edit Levels']);
  const afterBlack = await page.evaluate(() => JSON.stringify(window.pigmentApp.doc.active.params));
  // two picks in a row are two steps as well
  await pick('white');
  await expect.poll(() => tail(4)).toEqual(['Edit Levels', 'Reset Levels', 'Edit Levels', 'Edit Levels']);
  // one Undo takes back the last pick only
  await runAwait(page, 'edit:undo');
  expect(await tail(1)).toEqual(['Edit Levels']);
  expect(await page.evaluate(() => JSON.stringify(window.pigmentApp.doc.active.params))).toBe(afterBlack);
  expect(errors).toEqual([]);
});
