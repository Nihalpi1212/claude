// Filter Gallery, part B (gallery-sketch.js + textures.js + lib/gallery-b-ui.js): the 23 kinds are registered
// and enabled, Sketch dialogs paint with the current colours, Texturizer loads a texture file, direct runs
// with params reproduce dialog results, every run is one undoable history entry.
import { test, expect } from '@playwright/test';
import { openApp, openFixture, newDoc, run, runAwait, layerPixel, confirmDialog, historyLength } from './helpers.mjs';

const SKETCH = ['bas-relief', 'chalk-charcoal', 'charcoal', 'chrome', 'conte-crayon', 'graphic-pen', 'halftone-pattern', 'note-paper', 'photocopy', 'plaster', 'reticulation', 'stamp', 'torn-edges', 'water-paper'];
const TEXTURE = ['craquelure', 'grain', 'mosaic-tiles', 'patchwork', 'stained-glass', 'texturizer'];
const DISTORT = ['diffuse-glow', 'glass', 'ocean-ripple'];
const KINDS = [...SKETCH, ...TEXTURE, ...DISTORT];

const settings = (page, path) => page.evaluate((p) => p.split('.').reduce((o, k) => o?.[k], window.pigmentApp.settings), path);
const setNumber = async (page, key, value) => {
  const input = page.locator(`.dialog input[type="number"][data-key="${key}"]`);
  await input.fill(String(value));
  await input.dispatchEvent('change');
};
const isRedOrWhite = (p) => (p[0] === 255 && p[1] === 0 && p[2] === 0) || (p[0] === 255 && p[1] === 255 && p[2] === 255);

test('every Sketch, Texture and Distort kind is registered, enabled, dialog-driven and in its gallery group', async ({ page }) => {
  const errors = await openApp(page);
  await openFixture(page, 'gradient.png');
  const info = await page.evaluate((kinds) => kinds.map((k) => {
    const app = window.pigmentApp, def = app.commands.commands.get(`filter:${k}`);
    return { k, has: app.commands.has(`filter:${k}`), enabled: app.commands.isEnabled(`filter:${k}`), label: typeof def?.label === 'function' ? def.label() : def?.label, dialog: !!def?.dialog };
  }), KINDS);
  for (const i of info) {
    expect(i.has, i.k).toBe(true);
    expect(i.enabled, i.k).toBe(true);
    expect(i.dialog, i.k).toBe(true);
    expect(i.label.endsWith('…'), `${i.k} label ${i.label}`).toBe(true);
  }
  const groups = await page.evaluate(async () => {
    const { GALLERY_GROUPS, FILTERS } = await import('/shared/pixels/filters.js');
    return { groups: Object.fromEntries(GALLERY_GROUPS.map((g) => [g.id, [...g.kinds]])), placeholders: Object.keys(FILTERS).filter((k) => FILTERS[k].placeholder && FILTERS[k].gallery && ['Sketch', 'Texture', 'Distort'].includes(FILTERS[k].gallery)) };
  });
  expect(groups.groups.sketch).toEqual([...SKETCH].sort());
  expect(groups.groups.texture).toEqual([...TEXTURE].sort());
  expect(groups.groups.distort).toEqual(expect.arrayContaining(DISTORT));
  expect(groups.placeholders).toEqual([]);
  // the dialog fields come from the registry metadata (sliders with Photoshop's ranges, selects for types)
  const fields = await page.evaluate(() => ({ stamp: window.pigmentApp.filterEditor.fields('stamp'), grain: window.pigmentApp.filterEditor.fields('grain'), ranges: window.pigmentApp.filterEditor.ranges('texturizer') }));
  expect(fields.stamp.map((f) => f.key)).toEqual(['lightDarkBalance', 'smoothness']);
  expect(fields.grain.find((f) => f.key === 'grainType').options.length).toBe(10);
  expect(fields.ranges).toEqual({ scaling: [50, 200], relief: [0, 50] });
  expect(errors).toEqual([]);
});

test('Stamp paints with the current foreground colour, commits one entry, and the committed params re-run it directly', async ({ page }) => {
  const errors = await openApp(page);
  await openFixture(page, 'gradient.png');
  await runAwait(page, 'tool:fg-color', '#ff0000');
  const n0 = await historyLength(page);
  await run(page, 'filter:stamp');
  const dialog = page.locator('.dialog-backdrop');
  await expect(dialog).toBeVisible();
  // the dialog shows the registry fields (no colour pickers: the colours come from the toolbox)
  await expect(page.locator('.dialog input[type="number"][data-key="smoothness"]')).toBeVisible();
  await expect(page.locator('.dialog input[type="color"]')).toHaveCount(0);
  await setNumber(page, 'smoothness', 2);
  await confirmDialog(page);
  await expect.poll(() => historyLength(page)).toBe(n0 + 1);
  const dark = await layerPixel(page, 10, 10), light = await layerPixel(page, 310, 190);
  expect(dark.slice(0, 3)).toEqual([255, 0, 0]);
  expect(light.slice(0, 3)).toEqual([255, 255, 255]);
  for (const [x, y] of [[50, 100], [160, 100], [250, 50], [100, 180]]) expect(isRedOrWhite(await layerPixel(page, x, y)), `${x},${y}`).toBe(true);
  const last = await settings(page, 'lastFilter');
  expect(last.kind).toBe('stamp');
  expect(last.params.colors).toEqual(['#ff0000', '#ffffff']);
  expect(last.params.smoothness).toBe(2);
  // undo restores, a direct run with the committed params reproduces the result (what actions and Last Filter do)
  await runAwait(page, 'edit:undo');
  await expect.poll(() => historyLength(page)).toBe(n0);
  expect((await layerPixel(page, 10, 10)).slice(0, 3)).not.toEqual([255, 0, 0]);
  await runAwait(page, 'tool:fg-color', '#000000'); // the params carry the colours: the toolbox no longer matters
  await runAwait(page, 'filter:stamp', last.params);
  await expect.poll(() => historyLength(page)).toBe(n0 + 1);
  expect((await layerPixel(page, 10, 10)).slice(0, 3)).toEqual([255, 0, 0]);
  expect((await layerPixel(page, 310, 190)).slice(0, 3)).toEqual([255, 255, 255]);
  // Last Filter re-runs it again from the remembered params
  await runAwait(page, 'edit:undo');
  await runAwait(page, 'filter:last'); // filter:last does not await its run: poll for the commit
  await expect.poll(() => historyLength(page)).toBe(n0 + 1);
  expect((await layerPixel(page, 10, 10)).slice(0, 3)).toEqual([255, 0, 0]);
  expect(errors).toEqual([]);
});

test('Cancel restores the pixels of a Sketch preview; Stained Glass leading takes the foreground colour', async ({ page }) => {
  const errors = await openApp(page);
  await openFixture(page, 'gradient.png');
  const before = await layerPixel(page, 160, 100);
  const n0 = await historyLength(page);
  await run(page, 'filter:graphic-pen');
  await expect(page.locator('.dialog-backdrop')).toBeVisible();
  await expect(page.locator('.dialog select[data-key="strokeDirection"]')).toBeVisible();
  // the preview is on the canvas while the dialog is open
  await expect.poll(async () => (await layerPixel(page, 160, 100)).join()).not.toBe(before.join());
  await page.locator('.dialog-backdrop .dialog-buttons .btn', { hasText: 'Cancel' }).click();
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0);
  expect(await layerPixel(page, 160, 100)).toEqual(before);
  await expect.poll(() => historyLength(page)).toBe(n0);
  await runAwait(page, 'tool:fg-color', '#00ff00');
  await run(page, 'filter:stained-glass');
  await expect(page.locator('.dialog input[type="number"][data-key="borderThickness"]')).toBeVisible();
  await setNumber(page, 'borderThickness', 6);
  await confirmDialog(page);
  await expect.poll(() => historyLength(page)).toBe(n0 + 1);
  const green = await page.evaluate(() => {
    const l = window.pigmentApp.doc.active;
    const d = l.canvas.getContext('2d').getImageData(0, 0, 320, 200).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] === 0 && d[i + 1] === 255 && d[i + 2] === 0) n++;
    return n / (d.length / 4);
  });
  expect(green).toBeGreaterThan(0.05);
  expect((await settings(page, 'lastFilter.params.borderColor'))).toBe('#00ff00');
  expect(errors).toEqual([]);
});

test('Texturizer loads a texture file: the relief follows it, the params remember the file but not the pixels', async ({ page }) => {
  const errors = await openApp(page);
  await openFixture(page, 'gradient.png');
  // an 8 x 8 tile: black top half, white bottom half, so a light from the top shades every 8th row
  await page.evaluate(async () => {
    const { encodeRgba8 } = await import('/shared/pixels/png.js');
    const data = new Uint8ClampedArray(8 * 8 * 4);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const i = (y * 8 + x) * 4, v = y < 4 ? 0 : 255;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
    window.__pigmentTest.files['browser:/tex.png'] = await encodeRgba8({ width: 8, height: 8, data });
    window.__pigmentTest.nextOpenFiles = ['browser:/tex.png'];
  });
  const flatRow = await layerPixel(page, 160, 98), stepUp = await layerPixel(page, 160, 100), stepDown = await layerPixel(page, 160, 103);
  const n0 = await historyLength(page);
  await run(page, 'filter:texturizer');
  const select = page.locator('.dialog select[data-key="texture"]');
  await expect(select).toBeVisible();
  expect(await select.locator('option').allTextContents()).toEqual(['Brick', 'Burlap', 'Canvas', 'Sandstone']);
  await page.locator('.dialog button[data-key="__load-texture"]').click();
  await expect(page.locator('.dialog [data-key="__texture-note"]')).toContainText('tex.png (8 × 8, tiled)');
  await expect(select).toHaveValue('file');
  await setNumber(page, 'relief', 30);
  await confirmDialog(page);
  await expect.poll(() => historyLength(page)).toBe(n0 + 1);
  // rows inside a flat part of the tile are untouched, the step facing the light is lit, the step away from it is shaded
  expect(await layerPixel(page, 160, 98)).toEqual(flatRow);
  const lit = await layerPixel(page, 160, 100), shaded = await layerPixel(page, 160, 103);
  expect(lit[0] + lit[1] + lit[2]).toBeGreaterThan(stepUp[0] + stepUp[1] + stepUp[2] + 30);
  expect(shaded[0] + shaded[1] + shaded[2]).toBeLessThan(stepDown[0] + stepDown[1] + stepDown[2] - 30);
  const last = await settings(page, 'lastFilter.params');
  expect(last.textureFile).toBe('browser:/tex.png');
  expect(last.textureImage ?? null).toBeNull();
  expect(last.texture).toBe('file');
  expect(last.relief).toBe(30);
  // reopening reloads the file from its path; choosing a procedural texture drops it
  await run(page, 'filter:texturizer');
  await expect(page.locator('.dialog [data-key="__texture-note"]')).toContainText('tex.png');
  await expect(select).toHaveValue('file');
  await select.selectOption('brick');
  await expect(page.locator('.dialog [data-key="__texture-note"]')).not.toContainText('tex.png');
  await confirmDialog(page);
  await expect.poll(() => historyLength(page)).toBe(n0 + 2);
  expect(await settings(page, 'lastFilter.params.texture')).toBe('brick');
  expect(await settings(page, 'lastFilter.params.textureFile')).toBeUndefined();
  expect(errors).toEqual([]);
});

test('Texture and Distort kinds run directly with params: Grain adds noise, Diffuse Glow spares the shadows, Glass and Ocean Ripple move pixels, undo restores', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { background: 'background', backgroundColor: '#808080' });
  const n0 = await historyLength(page);
  const stats = () => page.evaluate(() => {
    const l = window.pigmentApp.doc.active;
    const d = l.canvas.getContext('2d').getImageData(0, 0, l.canvas.width, l.canvas.height).data;
    let s = 0, n = 0, changed = 0;
    for (let i = 0; i < d.length; i += 4) {
      s += (d[i] - 128) ** 2;
      n++;
      if (d[i] !== 128) changed++;
    }
    return { std: Math.sqrt(s / n), changed: changed / n };
  });
  await runAwait(page, 'filter:grain', { intensity: 60, contrast: 50, grainType: 'regular', seed: 2 });
  await expect.poll(() => historyLength(page)).toBe(n0 + 1);
  const g = await stats();
  expect(g.std).toBeGreaterThan(20);
  expect(g.changed).toBeGreaterThan(0.9);
  await runAwait(page, 'edit:undo');
  expect((await stats()).changed).toBe(0);
  // Diffuse Glow leaves a mid grey alone (nothing above the clear level) and lightens a white patch
  await runAwait(page, 'filter:diffuse-glow', { glowAmount: 15, clearAmount: 15, graininess: 0 });
  await expect.poll(() => historyLength(page)).toBe(n0 + 1);
  expect((await stats()).changed).toBe(0);
  await runAwait(page, 'edit:undo');
  await page.evaluate(() => {
    const l = window.pigmentApp.doc.active;
    const ctx = l.canvas.getContext('2d');
    ctx.fillStyle = '#f0f0f0';
    ctx.fillRect(200, 100, 100, 100);
    l.touch?.();
    window.pigmentApp.doc.changed('pixels', { layer: l });
  });
  await runAwait(page, 'filter:diffuse-glow', { glowAmount: 15, clearAmount: 15, graininess: 0, glowColor: '#ffffff' });
  expect((await layerPixel(page, 250, 150))[0]).toBeGreaterThan(240);
  expect((await layerPixel(page, 20, 20))[0]).toBe(128);
  await runAwait(page, 'edit:undo');
  // Glass and Ocean Ripple displace the patch edge
  const edge = await layerPixel(page, 200, 150);
  expect(edge[0]).toBe(240);
  await runAwait(page, 'filter:glass', { distortion: 12, smoothness: 1, texture: 'blocks' });
  const edgeMoved = await page.evaluate(() => {
    const l = window.pigmentApp.doc.active, ctx = l.canvas.getContext('2d');
    let n = 0;
    for (let y = 100; y < 200; y++) if (ctx.getImageData(200, y, 1, 1).data[0] !== 240) n++;
    return n;
  });
  expect(edgeMoved).toBeGreaterThan(10);
  await runAwait(page, 'edit:undo');
  expect(await layerPixel(page, 200, 150)).toEqual(edge);
  await runAwait(page, 'filter:ocean-ripple', { rippleSize: 4, rippleMagnitude: 15, seed: 3 });
  const rippled = await page.evaluate(() => {
    const l = window.pigmentApp.doc.active, ctx = l.canvas.getContext('2d');
    let n = 0;
    for (let y = 100; y < 200; y++) if (ctx.getImageData(200, y, 1, 1).data[0] !== 240) n++;
    return n;
  });
  expect(rippled).toBeGreaterThan(10);
  await runAwait(page, 'edit:undo');
  await expect.poll(() => historyLength(page)).toBe(n0);
  expect(errors).toEqual([]);
});
