// The 0.3 adjustments group (builder "adjust-more"): Color Lookup (dialog and adjustment layer, presets, loaded
// tables), HDR Toning, Match Color, Replace Color, Apply Image, Calculations, Matting, Export Color Lookup
// Tables and Merge to HDR.
import { test, expect } from '@playwright/test';
import { openApp, openFixture, newDoc, run, runAwait, pixel, layerPixel, confirmDialog, historyLength } from './helpers.mjs';
import { parseCube, parse3dl, writeCube, makeLut3d } from '../../src/shared/pixels/lut.js';
import { rgbToLab, labToRgb } from '../../src/shared/pixels/color.js';

const KINDS = ['color-lookup', 'hdr-toning', 'match-color', 'replace-color'];
const COMMANDS = ['image:apply-image', 'image:calculations', 'layer:matting', 'file:export-luts', 'file:automate-merge-hdr'];

const setNumber = async (page, key, value, scope = '.dialog') => {
  const input = page.locator(`${scope} input[type="number"][data-key="${key}"]`);
  await input.fill(String(value));
  await input.dispatchEvent('change');
};
const dialog = (page) => page.locator('.dialog-backdrop').last();
const expectNoDialog = (page) => expect(page.locator('.dialog-backdrop')).toHaveCount(0);

/** Fills the active layer of the active document with one colour (not an undo step: test setup). */
const paintLayer = (page, css) =>
  page.evaluate((c) => {
    const d = window.pigmentApp.doc, l = d.active;
    const ctx = l.canvas.getContext('2d');
    ctx.clearRect(0, 0, l.canvas.width, l.canvas.height);
    ctx.fillStyle = c;
    ctx.fillRect(0, 0, l.canvas.width, l.canvas.height);
    l.touch();
    d.changed('pixels', { layer: l });
  }, css);

/** Writes RGBA pixels (from a function of x, y evaluated in the page) into the active layer. */
const drawLayer = (page, fnSource) =>
  page.evaluate((src) => {
    const fn = new Function('x', 'y', `return (${src})(x, y);`);
    const d = window.pigmentApp.doc, l = d.active;
    const w = l.canvas.width, h = l.canvas.height;
    const img = new ImageData(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) img.data.set(fn(x, y), (y * w + x) * 4);
    l.canvas.getContext('2d').putImageData(img, 0, 0);
    l.touch();
    d.changed('pixels', { layer: l });
  }, fnSource);

const docId = (page) => page.evaluate(() => window.pigmentApp.doc.id);
const activate = (page, id) => page.evaluate((i) => window.pigmentApp.docs.activate(window.pigmentApp.docs.list().find((d) => d.id === i)), id);
const written = (page, path) => page.evaluate((p) => (window.__pigmentTest.written[p] ? Array.from(window.__pigmentTest.written[p]) : null), path);
const near = (actual, expected, tol = 1) => {
  for (let i = 0; i < expected.length; i++) expect(Math.abs(actual[i] - expected[i]), `channel ${i}: ${actual} vs ${expected}`).toBeLessThanOrEqual(tol);
};

test('the four adjustments and the five commands are real: registered, enabled, labelled, not stubbed', async ({ page }) => {
  const errors = await openApp(page);
  await openFixture(page, 'shapes.png');
  const info = await page.evaluate(([kinds, cmds]) => {
    const app = window.pigmentApp;
    const label = (id) => {
      const def = app.commands.commands.get(id);
      return typeof def?.label === 'function' ? def.label() : def?.label;
    };
    return {
      kinds: kinds.map((k) => ({ k, enabled: app.commands.isEnabled(`image:adjust-${k}`), label: label(`image:adjust-${k}`), editor: !!app.adjustEditors.get(k)?.editor })),
      cmds: cmds.map((c) => ({ c, has: app.commands.has(c), enabled: app.commands.isEnabled(c), stubbed: app.stubbed.includes(c), dialog: !!app.commands.commands.get(c)?.dialog })),
      layerKind: !!app.adjustments['color-lookup'],
    };
  }, [KINDS, COMMANDS]);
  for (const k of info.kinds) {
    expect(k.enabled, k.k).toBe(true);
    expect(k.editor, k.k).toBe(true);
    expect(k.label.endsWith('…'), k.k).toBe(true);
  }
  for (const c of info.cmds) {
    expect(c.has, c.c).toBe(true);
    expect(c.enabled, c.c).toBe(true);
    expect(c.stubbed, c.c).toBe(false);
  }
  expect(info.cmds.filter((c) => c.dialog).map((c) => c.c).sort()).toEqual(['file:automate-merge-hdr', 'file:export-luts', 'image:apply-image', 'image:calculations']);
  // Color Lookup is offered as an adjustment layer in the Adjustments panel
  await runAwait(page, 'window:panel-adjustments');
  await expect(page.locator('[data-panel="adjustments"].panel')).toContainText('Color Lookup');
  expect(errors).toEqual([]);
});

test('Color Lookup layer: a preset changes pixels and is undoable; a loaded .cube and dither work in Properties', async ({ page }) => {
  const errors = await openApp(page);
  await openFixture(page, 'shapes.png');
  expect(await pixel(page, 50, 50)).toEqual([255, 0, 0, 255]);
  const n0 = await historyLength(page);
  await runAwait(page, 'layer:new-adjustment', 'color-lookup');
  expect(await page.evaluate(() => [window.pigmentApp.doc.active.type, window.pigmentApp.doc.active.kind, window.pigmentApp.doc.active.params.preset])).toEqual(['adjustment', 'color-lookup', 'none']);
  expect(await historyLength(page)).toBe(n0 + 1);
  expect(await pixel(page, 50, 50)).toEqual([255, 0, 0, 255]); // "None" is the identity
  const props = '[data-panel="properties"].panel';
  const preset = page.locator(`${props} select[data-key="preset"]`);
  await expect(preset).toBeVisible();
  expect(await preset.locator('option').count()).toBeGreaterThanOrEqual(21); // None + at least 20 presets
  await preset.selectOption('Black & White');
  await expect.poll(() => pixel(page, 50, 50)).not.toEqual([255, 0, 0, 255]);
  const grey = await pixel(page, 50, 50);
  expect(grey[0]).toBe(grey[1]);
  expect(grey[1]).toBe(grey[2]);
  expect(grey[3]).toBe(255);
  expect(await pixel(page, 5, 5)).toEqual([0, 0, 0, 0]); // transparency stays
  expect(await page.evaluate(() => window.pigmentApp.doc.active.params.preset)).toBe('Black & White');
  expect(await historyLength(page)).toBe(n0 + 2);
  // undo the preset, then the layer; redo both
  await runAwait(page, 'edit:undo');
  expect(await pixel(page, 50, 50)).toEqual([255, 0, 0, 255]);
  expect(await page.evaluate(() => window.pigmentApp.doc.active.params.preset)).toBe('none');
  await runAwait(page, 'edit:redo');
  expect(await pixel(page, 50, 50)).toEqual(grey);
  // the editor follows the layer after undo/redo
  await expect(page.locator(`${props} select[data-key="preset"]`)).toHaveValue('Black & White');

  // Load 3D LUT…: a channel-swap .cube from the file dialog turns red into blue
  const cube = writeCube(makeLut3d(3, (r, g, b) => [b, g, r], 'Swap RB'));
  await page.evaluate((text) => {
    window.__pigmentTest.files['browser:/luts/swap.cube'] = new TextEncoder().encode(text);
    window.__pigmentTest.nextOpenFiles = ['browser:/luts/swap.cube'];
  }, cube);
  await page.locator(`${props} button[data-act="load-lut"]`).click();
  await expect.poll(() => pixel(page, 50, 50)).toEqual([0, 0, 255, 255]);
  await expect(page.locator(`${props} select[data-key="preset"]`)).toHaveValue('__custom');
  await expect(page.locator(`${props} [data-role="lut-info"]`)).toContainText('Swap RB');
  await expect(page.locator(`${props} [data-role="lut-info"]`)).toContainText('3 grid points');
  const stored = await page.evaluate(() => {
    const p = window.pigmentApp.doc.active.params;
    return { preset: p.preset, type: p.lut.type, size: p.lut.size, n: p.lut.data.length, array: Array.isArray(p.lut.data), json: JSON.parse(JSON.stringify(window.pigmentApp.doc.describe())).layers !== undefined };
  });
  expect(stored).toMatchObject({ preset: 'none', type: '3d', size: 3, n: 81, array: true });
  await page.locator(`${props} input[data-key="dither"]`).check();
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.active.params.dither)).toBe(true);
  expect(await pixel(page, 50, 50)).toEqual([0, 0, 255, 255]);
  // a preset replaces the loaded table
  await page.locator(`${props} select[data-key="preset"]`).selectOption('Sepia');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.active.params.lut)).toBe(null);
  const sepia = await pixel(page, 50, 50);
  expect(sepia[0]).toBeGreaterThan(sepia[2]);
  // a broken file reports an error and changes nothing
  await page.evaluate(() => {
    window.__pigmentTest.files['browser:/luts/bad.cube'] = new TextEncoder().encode('LUT_3D_SIZE 2\n0 0 0\n');
    window.__pigmentTest.nextOpenFiles = ['browser:/luts/bad.cube'];
  });
  errors.length = 0;
  await page.locator(`${props} button[data-act="load-lut"]`).click();
  await expect(page.locator('.toast.error')).toContainText('Could not load the lookup table');
  expect(await page.evaluate(() => window.pigmentApp.doc.active.params.preset)).toBe('Sepia');
  // reportError logs to the console: that is the only error allowed here
  expect(errors.every((e) => /Could not load the lookup table/.test(e))).toBe(true);
});

test('Color Lookup dialog: previews, commits one history entry, undoes; the loaded table is not kept in the settings', async ({ page }) => {
  const errors = await openApp(page);
  await openFixture(page, 'shapes.png');
  const n0 = await historyLength(page);
  await run(page, 'image:adjust-color-lookup');
  await expect(dialog(page)).toBeVisible();
  await page.locator('.dialog select[data-key="preset"]').selectOption('Black & White');
  await expect.poll(async () => (await layerPixel(page, 50, 50))[1]).toBeGreaterThan(20); // red is no longer pure
  const cube = writeCube(makeLut3d(2, (r, g, b) => [g, r, b], 'Swap RG'));
  await page.evaluate((text) => {
    window.__pigmentTest.files['browser:/luts/rg.cube'] = new TextEncoder().encode(text);
    window.__pigmentTest.nextOpenFiles = ['browser:/luts/rg.cube'];
  }, cube);
  await page.locator('.dialog button[data-act="load-lut"]').click();
  await expect.poll(() => layerPixel(page, 50, 50)).toEqual([0, 255, 0, 255]);
  await confirmDialog(page);
  await expect.poll(() => historyLength(page)).toBe(n0 + 1);
  expect(await layerPixel(page, 50, 50)).toEqual([0, 255, 0, 255]);
  expect((await layerPixel(page, 140, 90))[3]).toBe(128); // alpha of the half-transparent circle survives
  await expect.poll(() => page.evaluate(() => window.pigmentApp.settings.adjustLast?.['color-lookup']?.lut ?? null)).toBe(null);
  await runAwait(page, 'edit:undo');
  expect(await layerPixel(page, 50, 50)).toEqual([255, 0, 0, 255]);
  // cancel restores the preview
  await run(page, 'image:adjust-color-lookup');
  await page.locator('.dialog select[data-key="preset"]').selectOption('Sepia');
  await expect.poll(async () => (await layerPixel(page, 50, 50))[1]).toBeGreaterThan(20);
  await page.keyboard.press('Escape');
  await expectNoDialog(page);
  expect(await layerPixel(page, 50, 50)).toEqual([255, 0, 0, 255]);
  expect(await historyLength(page)).toBe(n0);
  // replay with parameters, as an action does
  await runAwait(page, 'image:adjust-color-lookup', { preset: 'Black & White' });
  const g = await layerPixel(page, 50, 50);
  expect(g[0]).toBe(g[2]);
  expect(await historyLength(page)).toBe(n0 + 1);
  expect(errors).toEqual([]);
});

test('Replace Color with a sampled red turns it green', async ({ page }) => {
  const errors = await openApp(page);
  await openFixture(page, 'shapes.png');
  const n0 = await historyLength(page);
  await run(page, 'image:adjust-replace-color');
  await expect(dialog(page)).toBeVisible();
  const preview = page.locator('.dialog canvas[data-role="replace-preview"]');
  await expect(preview).toBeVisible();
  // sample the red square in the preview (the fixture is 200 x 150, shown 1:1)
  const box = await preview.boundingBox();
  await preview.click({ position: { x: (50 / 200) * box.width, y: (50 / 150) * box.height } });
  await expect(page.locator('.dialog [data-role="replace-color"]')).toHaveAttribute('data-color', '#ff0000');
  await setNumber(page, 'hue', 120);
  await expect(page.locator('.dialog [data-role="replace-result"]')).toHaveAttribute('data-color', '#00ff00');
  await expect.poll(() => layerPixel(page, 50, 50)).toEqual([0, 255, 0, 255]);
  // the mask preview is white on the square and black elsewhere
  const maskAt = (x, y) => preview.evaluate((c, [px, py]) => Array.from(c.getContext('2d').getImageData(px, py, 1, 1).data), [x, y]);
  await expect.poll(() => maskAt(50, 50)).toEqual([255, 255, 255, 255]);
  expect(await maskAt(140, 90)).toEqual([0, 0, 0, 255]);
  // image view shows the picture instead
  await page.locator('.dialog select[data-key="view"]').selectOption('image');
  await expect.poll(() => maskAt(50, 50)).toEqual([255, 0, 0, 255]);
  await confirmDialog(page);
  await expect.poll(() => historyLength(page)).toBe(n0 + 1);
  expect(await layerPixel(page, 50, 50)).toEqual([0, 255, 0, 255]);
  expect(await layerPixel(page, 140, 90)).toEqual([0, 0, 255, 128]); // the blue circle is outside the fuzziness
  expect(await layerPixel(page, 5, 5)).toEqual([0, 0, 0, 0]);
  const last = await page.evaluate(() => window.pigmentApp.settings.adjustLast['replace-color']);
  expect(last.colors).toEqual([[255, 0, 0]]);
  expect(last.hue).toBe(120);
  await runAwait(page, 'edit:undo');
  expect(await layerPixel(page, 50, 50)).toEqual([255, 0, 0, 255]);

  // add and subtract eyedroppers: add the blue of the circle, then take the red away again
  await run(page, 'image:adjust-replace-color');
  await expect(dialog(page)).toBeVisible();
  const p2 = page.locator('.dialog canvas[data-role="replace-preview"]');
  await page.locator('.dialog button[data-tool="add"]').click();
  await p2.click({ position: { x: 140, y: 90 } });
  await setNumber(page, 'lightness', -100);
  await expect.poll(() => layerPixel(page, 50, 50)).toEqual([0, 0, 0, 255]);
  await expect.poll(async () => (await layerPixel(page, 140, 90)).slice(0, 3)).toEqual([0, 0, 0]);
  await page.locator('.dialog button[data-tool="subtract"]').click();
  await p2.click({ position: { x: 50, y: 50 } });
  await expect.poll(() => layerPixel(page, 50, 50)).toEqual([255, 0, 0, 255]);
  expect((await layerPixel(page, 140, 90)).slice(0, 3)).toEqual([0, 0, 0]);
  await page.keyboard.press('Escape');
  await expectNoDialog(page);
  expect(await layerPixel(page, 140, 90)).toEqual([0, 0, 255, 128]);
  expect(errors).toEqual([]);
});

test('Apply Image multiplies with another document, through a channel, a mask and as a replay', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 60, height: 40, name: 'A' });
  await paintLayer(page, 'rgb(200, 100, 50)');
  const idA = await docId(page);
  await newDoc(page, { width: 60, height: 40, name: 'B' });
  await paintLayer(page, 'rgb(128, 255, 0)');
  await newDoc(page, { width: 30, height: 30, name: 'Other size' });
  const idB = await page.evaluate(() => window.pigmentApp.docs.list().find((d) => d.name === 'B').id);
  await activate(page, idB);
  const n0 = await historyLength(page);
  await run(page, 'image:apply-image');
  await expect(dialog(page)).toBeVisible();
  const src = page.locator('.dialog select[data-key="src.source"]');
  // only documents of the same size are offered
  expect(await src.locator('option').allTextContents()).toEqual(['A', 'B (this document)']);
  await expect(src).toHaveValue('current');
  // default: this document's composite, multiplied with itself
  await expect.poll(() => layerPixel(page, 10, 10)).toEqual([Math.round((128 * 128) / 255), 255, 0, 255]);
  await src.selectOption(idA);
  const mult = [Math.round((128 * 200) / 255), 100, 0, 255];
  await expect.poll(() => layerPixel(page, 10, 10)).toEqual(mult);
  // a single channel of the source: red (200) as grey
  await page.locator('.dialog select[data-key="src.channel"]').selectOption('r');
  await expect.poll(() => layerPixel(page, 10, 10)).toEqual([Math.round((128 * 200) / 255), 200, 0, 255]);
  await page.locator('.dialog input[data-key="src.invert"]').check();
  await expect.poll(() => layerPixel(page, 10, 10)).toEqual([Math.round((128 * 55) / 255), 55, 0, 255]);
  await page.locator('.dialog input[data-key="src.invert"]').uncheck();
  await page.locator('.dialog select[data-key="src.channel"]').selectOption('rgb');
  // Add shows scale and offset
  await expect(page.locator('.dialog input[data-key="scale"]')).toBeHidden();
  await page.locator('.dialog select[data-key="blend"]').selectOption('add');
  await expect(page.locator('.dialog input[data-key="scale"]')).toBeVisible();
  await setNumber(page, 'scale', 2);
  await expect.poll(() => layerPixel(page, 10, 10)).toEqual([164, 178, 25, 255]);
  await page.locator('.dialog select[data-key="blend"]').selectOption('multiply');
  await setNumber(page, 'opacity', 50);
  await expect.poll(() => layerPixel(page, 10, 10)).toEqual([Math.round(128 + (mult[0] - 128) * 0.5), Math.round(255 + (100 - 255) * 0.5), 0, 255]);
  await setNumber(page, 'opacity', 100);
  await expect.poll(() => layerPixel(page, 10, 10)).toEqual(mult);
  await confirmDialog(page);
  await expect.poll(() => historyLength(page)).toBe(n0 + 1);
  expect(await layerPixel(page, 10, 10)).toEqual(mult);
  expect(await layerPixel(page, 59, 39)).toEqual(mult);
  await runAwait(page, 'edit:undo');
  expect(await layerPixel(page, 10, 10)).toEqual([128, 255, 0, 255]);
  // limited to a selection: only the left half is multiplied
  await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { Selection } = await import('/lib/selection.js');
    app.applySelection(Selection.fromRect(60, 40, { x: 0, y: 0, width: 30, height: 40 }), 'replace', 'Select');
  });
  await runAwait(page, 'image:apply-image', { source: idA, blend: 'multiply' });
  expect(await layerPixel(page, 10, 10)).toEqual(mult);
  expect(await layerPixel(page, 50, 10)).toEqual([128, 255, 0, 255]);
  await runAwait(page, 'edit:undo');
  expect(await layerPixel(page, 10, 10)).toEqual([128, 255, 0, 255]);
  await runAwait(page, 'select:none');
  // replay with a mask: the left half of a saved channel lets the result through
  await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    const mask = new Uint8ClampedArray(d.width * d.height);
    for (let y = 0; y < d.height; y++) for (let x = 0; x < d.width / 2; x++) mask[y * d.width + x] = 255;
    d.channels = [{ id: 'half', name: 'Left half', mask }];
  });
  await runAwait(page, 'image:apply-image', { source: idA, blend: 'normal', mask: { source: 'current', layer: 'merged', channel: 'alpha:half' } });
  expect(await layerPixel(page, 10, 10)).toEqual([200, 100, 50, 255]);
  expect(await layerPixel(page, 50, 10)).toEqual([128, 255, 0, 255]);
  expect(errors).toEqual([]);
});

test('Calculations adds a channel (undoable), makes a selection and opens a greyscale document', async ({ page }) => {
  const errors = await openApp(page);
  await openFixture(page, 'shapes.png');
  const n0 = await historyLength(page);
  await run(page, 'image:calculations');
  await expect(dialog(page)).toBeVisible();
  await expect(page.locator('.dialog canvas[data-role="calc-preview"]')).toBeVisible();
  await page.locator('.dialog select[data-key="a.channel"]').selectOption('r');
  await page.locator('.dialog select[data-key="b.channel"]').selectOption('a');
  await page.locator('.dialog select[data-key="blend"]').selectOption('multiply');
  // the preview shows red x alpha: white on the square, black on the circle (no red there)
  const prev = page.locator('.dialog canvas[data-role="calc-preview"]');
  const at = (x, y) => prev.evaluate((c, [px, py]) => Array.from(c.getContext('2d').getImageData(px, py, 1, 1).data), [x, y]);
  await expect.poll(() => at(50, 50)).toEqual([255, 255, 255, 255]);
  expect(await at(140, 90)).toEqual([0, 0, 0, 255]);
  await confirmDialog(page);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.channels.length)).toBe(1);
  expect(await historyLength(page)).toBe(n0 + 1);
  const ch = await page.evaluate(() => {
    const d = window.pigmentApp.doc, c = d.channels[0];
    return { name: c.name, n: c.mask.length, square: c.mask[50 * d.width + 50], circle: c.mask[90 * d.width + 140], empty: c.mask[5 * d.width + 5] };
  });
  expect(ch).toEqual({ name: 'Alpha 1', n: 200 * 150, square: 255, circle: 0, empty: 0 });
  // the Channels panel lists it
  await runAwait(page, 'window:panel-channels');
  await expect(page.locator('[data-panel="channels"].panel')).toContainText('Alpha 1');
  await runAwait(page, 'edit:undo');
  expect(await page.evaluate(() => window.pigmentApp.doc.channels.length)).toBe(0);
  await runAwait(page, 'edit:redo');
  expect(await page.evaluate(() => window.pigmentApp.doc.channels.length)).toBe(1);
  // the saved channel is now a source: difference with itself is black
  const black = await page.evaluate(async () => {
    const app = window.pigmentApp, d = app.doc;
    const id = `alpha:${d.channels[0].id}`;
    await app.commands.run('image:calculations', { a: { channel: id }, b: { channel: id }, blend: 'difference', result: 'new-channel' }, 'api');
    return Array.from(d.channels[1].mask).every((v) => v === 0);
  });
  expect(black).toBe(true);
  // result: selection (the alpha of the layer, inverted through Source 1's Invert)
  await runAwait(page, 'image:calculations', { a: { channel: 'a' }, b: { channel: 'a' }, blend: 'normal', result: 'selection' });
  const sel = await page.evaluate(() => {
    const d = window.pigmentApp.doc, s = d.selection;
    return { bounds: s.bounds, square: s.mask[50 * d.width + 50], circle: s.mask[90 * d.width + 140], empty: s.mask[5 * d.width + 5] };
  });
  expect(sel.square).toBe(255);
  expect(sel.circle).toBe(128);
  expect(sel.empty).toBe(0);
  expect(sel.bounds).toMatchObject({ x: 20, y: 20 });
  // result: new document (greyscale, same size)
  const docs0 = await page.evaluate(() => window.pigmentApp.docs.list().length);
  await runAwait(page, 'image:calculations', { a: { channel: 'r' }, b: { channel: 'r' }, blend: 'screen', result: 'new-document' });
  const made = await page.evaluate(() => {
    const app = window.pigmentApp, d = app.doc;
    return { count: app.docs.list().length, mode: d.mode, size: [d.width, d.height], name: d.name };
  });
  expect(made).toEqual({ count: docs0 + 1, mode: 'grayscale', size: [200, 150], name: 'Untitled (Calculations)' });
  expect(await layerPixel(page, 50, 50)).toEqual([255, 255, 255, 255]);
  expect(await layerPixel(page, 140, 90)).toEqual([0, 0, 0, 255]);
  expect(errors).toEqual([]);
});

/** A red block with a 1 px green rim on a transparent layer; the block spans x0..x1 / y0..y1 inclusive. */
const HALO = `(x, y) => {
  const inside = x >= 10 && x <= 39 && y >= 8 && y <= 31;
  if (!inside) return [0, 0, 0, 0];
  const rim = x === 10 || x === 39 || y === 8 || y === 31;
  return rim ? [0, 255, 0, 255] : [255, 0, 0, 255];
}`;

test('Defringe on a hard edge replaces the halo; the other matting commands run directly and undo', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 60, height: 40, name: 'Cutout', background: 'transparent' });
  await drawLayer(page, HALO);
  expect(await layerPixel(page, 10, 20)).toEqual([0, 255, 0, 255]);
  const n0 = await historyLength(page);
  await run(page, 'layer:matting', 'defringe');
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page)).toContainText('Defringe');
  await setNumber(page, 'width', 1);
  await confirmDialog(page);
  await expect.poll(() => historyLength(page)).toBe(n0 + 1);
  for (const [x, y] of [[10, 20], [39, 20], [25, 8], [25, 31], [10, 8], [39, 31]]) expect(await layerPixel(page, x, y), `rim ${x},${y}`).toEqual([255, 0, 0, 255]);
  expect(await layerPixel(page, 25, 20)).toEqual([255, 0, 0, 255]);
  expect(await layerPixel(page, 9, 20)).toEqual([0, 0, 0, 0]);
  expect(await page.evaluate(() => window.pigmentApp.settings.matting.width)).toBe(1);
  await runAwait(page, 'edit:undo');
  expect(await layerPixel(page, 10, 20)).toEqual([0, 255, 0, 255]);
  // replay form: no dialog
  await runAwait(page, 'layer:matting', { op: 'defringe', width: 1 });
  expect(await layerPixel(page, 10, 20)).toEqual([255, 0, 0, 255]);
  await runAwait(page, 'edit:undo');
  // cancel leaves the layer alone
  await run(page, 'layer:matting', 'defringe');
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expectNoDialog(page);
  expect(await historyLength(page)).toBe(n0);

  // a layer whose canvas ends inside the document: the canvas edge is an edge too
  await page.evaluate(() => {
    const app = window.pigmentApp, d = app.doc, l = d.active;
    const c = document.createElement('canvas');
    c.width = 20;
    c.height = 12;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#00ff00';
    ctx.fillRect(0, 0, 20, 12);
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(1, 1, 18, 10);
    l.canvas = c;
    l.x = 20;
    l.y = 14;
    l.touch();
    d.changed('pixels', { layer: l });
  });
  expect(await layerPixel(page, 20, 20)).toEqual([0, 255, 0, 255]);
  await runAwait(page, 'layer:matting', { op: 'defringe', width: 1 });
  expect(await layerPixel(page, 20, 20)).toEqual([255, 0, 0, 255]);
  expect(await layerPixel(page, 39, 25)).toEqual([255, 0, 0, 255]);
  await runAwait(page, 'edit:undo');

  // Remove White Matte: a half-covered pixel mixed with white gets its colour back
  await newDoc(page, { width: 60, height: 40, name: 'Mattes', background: 'transparent' });
  await drawLayer(page, `(x, y) => (x < 10 ? [228, 178, 153, 128] : [200, 100, 50, 255])`);
  const h0 = await historyLength(page);
  await runAwait(page, 'layer:matting', 'remove-white');
  near(await layerPixel(page, 5, 5), [200, 100, 50, 128], 3);
  expect(await layerPixel(page, 15, 5)).toEqual([200, 100, 50, 255]);
  expect(await historyLength(page)).toBe(h0 + 1);
  await runAwait(page, 'edit:undo');
  await runAwait(page, 'layer:matting', 'remove-black');
  expect((await layerPixel(page, 5, 5))[0]).toBe(255); // 228 / 0.5 clips: black matte removal brightens
  await runAwait(page, 'edit:undo');
  // Color Decontaminate asks for the amount and pulls the soft pixels to the solid colour
  await drawLayer(page, `(x, y) => (x < 2 ? [0, 0, 0, 0] : x < 4 ? [0, 255, 0, 64] : [255, 0, 0, 255])`);
  await run(page, 'layer:matting', 'decontaminate');
  await expect(dialog(page)).toContainText('Color Decontaminate');
  await setNumber(page, 'amount', 100);
  await confirmDialog(page);
  await expect.poll(async () => (await layerPixel(page, 3, 5))[0]).toBeGreaterThan(240);
  const soft = await layerPixel(page, 3, 5);
  expect(soft[1]).toBeLessThan(16);
  expect(soft[3]).toBe(64);
  expect(await layerPixel(page, 10, 5)).toEqual([255, 0, 0, 255]);
  expect(await page.evaluate(() => window.pigmentApp.settings.matting.amount)).toBe(100);
  // an unknown argument or a non-pixel layer is refused politely
  await runAwait(page, 'layer:matting', 'nope');
  await expect(page.locator('.toast.error').last()).toContainText('Matting');
  expect(errors).toEqual([]);
});

test('HDR Toning flattens after a confirm, previews its methods and commits; cancel keeps the layers', async ({ page }) => {
  const errors = await openApp(page);
  await openFixture(page, 'gradient.png');
  await runAwait(page, 'layer:new');
  expect(await page.evaluate(() => window.pigmentApp.doc.root.children.length)).toBe(2);
  const n0 = await historyLength(page);
  // declining the flatten leaves everything alone
  await run(page, 'image:adjust-hdr-toning');
  await expect(dialog(page)).toContainText('flattened image');
  await page.keyboard.press('Escape');
  await expectNoDialog(page);
  expect(await page.evaluate(() => window.pigmentApp.doc.root.children.length)).toBe(2);
  expect(await historyLength(page)).toBe(n0);
  // accepting flattens, then the HDR Toning dialog opens
  await run(page, 'image:adjust-hdr-toning');
  await expect(dialog(page)).toContainText('flattened image');
  await page.locator('.dialog-backdrop .dialog-buttons .btn.primary').last().click();
  await expect(page.locator('.dialog select[data-key="method"]')).toBeVisible();
  expect(await page.evaluate(() => window.pigmentApp.doc.root.children.length)).toBe(1);
  expect(await historyLength(page)).toBe(n0 + 1);
  const before = [0, 100, 128, 255]; // gradient.png at (0, 78): r = 0, g = 100
  // the default local adaptation already previews: the dark left edge is lifted
  await expect.poll(async () => (await layerPixel(page, 0, 78))[1]).toBeGreaterThan(before[1]);
  await expect(page.locator('.dialog input[data-key="radius"]')).toBeVisible();
  await expect(page.locator('.dialog [data-role="hdr-curve"]')).toBeVisible();
  // Exposure and Gamma: only those two controls, and +1 stop brightens by the sRGB amount
  await page.locator('.dialog select[data-key="method"]').selectOption('exposure-gamma');
  await expect(page.locator('.dialog input[data-key="radius"]')).toBeHidden();
  await expect(page.locator('.dialog [data-role="hdr-curve"]')).toBeHidden();
  await expect(page.locator('.dialog input[data-key="gamma"]')).toBeVisible();
  await expect.poll(() => layerPixel(page, 0, 78)).toEqual(before);
  await setNumber(page, 'exposure', 1);
  const lin = (v) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
  const enc = (c) => Math.round((c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055) * 255);
  await expect.poll(() => layerPixel(page, 0, 78)).toEqual([0, enc(lin(100) * 2), enc(lin(128) * 2), 255]);
  await page.locator('.dialog select[data-key="method"]').selectOption('equalize-histogram');
  await expect(page.locator('.dialog input[data-key="exposure"]')).toBeHidden();
  await expect(dialog(page)).toContainText('no settings');
  // back to local adaptation with a strong detail boost, then commit
  await page.locator('.dialog select[data-key="method"]').selectOption('local-adaptation');
  await setNumber(page, 'exposure', 0);
  await setNumber(page, 'detail', 100);
  await setNumber(page, 'saturation', 0);
  await expect.poll(() => layerPixel(page, 160, 78)).not.toEqual([128, 100, 128, 255]);
  const flatCurve = await layerPixel(page, 160, 78);
  // a point on the toning curve (input 64 -> output 191) brightens the result further
  const curve = page.locator('.dialog [data-role="hdr-curve"] canvas.curve-editor');
  await curve.scrollIntoViewIfNeeded();
  const cb = await curve.boundingBox();
  await curve.click({ position: { x: cb.width * 0.25, y: cb.height * 0.25 } });
  await expect.poll(async () => (await layerPixel(page, 160, 78))[1]).toBeGreaterThan(flatCurve[1] + 20);
  const previewed = await layerPixel(page, 160, 78);
  await confirmDialog(page);
  await expect.poll(() => historyLength(page)).toBe(n0 + 2);
  const after = await layerPixel(page, 160, 78);
  expect(after).toEqual(previewed);
  expect(after[3]).toBe(255);
  const last = await page.evaluate(() => window.pigmentApp.settings.adjustLast['hdr-toning']);
  expect(last).toMatchObject({ method: 'local-adaptation', detail: 100, saturation: 0, exposure: 0 });
  expect(last.curve).toHaveLength(3);
  expect(Math.abs(last.curve[1][0] - 64)).toBeLessThanOrEqual(3);
  expect(Math.abs(last.curve[1][1] - 191)).toBeLessThanOrEqual(3);
  await runAwait(page, 'edit:undo');
  expect(await layerPixel(page, 0, 78)).toEqual(before);
  await runAwait(page, 'edit:undo');
  expect(await page.evaluate(() => window.pigmentApp.doc.root.children.length)).toBe(2);
  expect(errors).toEqual([]);
});

test('Match Color takes its statistics from another document, saves and loads them, and uses the selections', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 40, height: 30, name: 'Warm' });
  await drawLayer(page, `(x, y) => (x < 20 ? [200, 100, 50, 255] : [220, 140, 90, 255])`);
  const warm = await docId(page);
  // the source's mean colour (the mean of its two tones in Lab): what a flat target turns into
  const labA = rgbToLab(200, 100, 50), labB = rgbToLab(220, 140, 90);
  const mean = labToRgb((labA[0] + labB[0]) / 2, (labA[1] + labB[1]) / 2, (labA[2] + labB[2]) / 2).map(Math.round);
  const off = (p) => Math.max(Math.abs(p[0] - mean[0]), Math.abs(p[1] - mean[1]), Math.abs(p[2] - mean[2]));
  await newDoc(page, { width: 50, height: 30, name: 'Cool' });
  // left half bluish, right half greenish: only the left half is selected below
  await drawLayer(page, `(x, y) => (x < 25 ? [60, 90, 200, 255] : [40, 180, 60, 255])`);
  const n0 = await historyLength(page);
  await run(page, 'image:adjust-match-color');
  await expect(dialog(page)).toBeVisible();
  const src = page.locator('.dialog select[data-key="source"]');
  await expect(src).toHaveValue('none');
  await expect(page.locator('.dialog [data-role="match-status"]')).toContainText('No source');
  await expect(page.locator('.dialog button[data-act="save-statistics"]')).toBeDisabled();
  expect(await layerPixel(page, 5, 5)).toEqual([60, 90, 200, 255]);
  await src.selectOption(warm);
  await expect(page.locator('.dialog [data-role="match-status"]')).toContainText('Source statistics');
  // the whole layer (two flat halves) takes the source's mean; each half keeps its offset from the layer mean
  await expect.poll(async () => (await layerPixel(page, 5, 5))[0]).toBeGreaterThan(60);
  // save the statistics
  await page.evaluate(() => (window.__pigmentTest.nextSavePath = 'browser:/stats/warm.json'));
  await page.locator('.dialog button[data-act="save-statistics"]').click();
  await expect.poll(() => written(page, 'browser:/stats/warm.json')).not.toBe(null);
  const saved = JSON.parse(Buffer.from(await written(page, 'browser:/stats/warm.json')).toString('utf8'));
  expect(saved.format).toBe('pigment-match-color-statistics');
  expect(saved.mean).toHaveLength(3);
  expect(saved.mean[0]).toBeGreaterThan(40);
  expect(saved.mean[1]).toBeGreaterThan(20); // a* of an orange
  near(saved.mean, [(labA[0] + labB[0]) / 2, (labA[1] + labB[1]) / 2, (labA[2] + labB[2]) / 2], 0.05);
  near(saved.std, [Math.abs(labA[0] - labB[0]) / 2, Math.abs(labA[1] - labB[1]) / 2, Math.abs(labA[2] - labB[2]) / 2], 0.05);
  await page.keyboard.press('Escape');
  await expectNoDialog(page);
  expect(await layerPixel(page, 5, 5)).toEqual([60, 90, 200, 255]);
  expect(await historyLength(page)).toBe(n0);

  // with a selection on the target: the selected half alone is matched and lands on the source colour
  await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { Selection } = await import('/lib/selection.js');
    app.applySelection(Selection.fromRect(50, 30, { x: 0, y: 0, width: 25, height: 30 }), 'replace', 'Select');
  });
  const n1 = await historyLength(page);
  await run(page, 'image:adjust-match-color');
  await expect(dialog(page)).toBeVisible();
  await expect(page.locator('.dialog input[data-key="useTargetSelection"]')).toBeEnabled();
  await expect(page.locator('.dialog input[data-key="useTargetSelection"]')).toBeChecked();
  // load the saved statistics instead of choosing a document
  await page.evaluate(() => (window.__pigmentTest.nextOpenFiles = ['browser:/stats/warm.json']));
  await page.locator('.dialog button[data-act="load-statistics"]').click();
  await expect(page.locator('.dialog select[data-key="source"]')).toHaveValue('__loaded');
  // the selected (flat) half has no spread of its own: it lands on the source's mean colour
  await expect.poll(async () => off(await layerPixel(page, 5, 5))).toBeLessThanOrEqual(2);
  expect(await layerPixel(page, 40, 5)).toEqual([40, 180, 60, 255]); // outside the selection
  // statistics of the whole layer instead: the selected half keeps its (scaled) offset from the layer mean, so it is no longer the source mean
  await page.locator('.dialog input[data-key="useTargetSelection"]').uncheck();
  await expect.poll(async () => off(await layerPixel(page, 5, 5))).toBeGreaterThan(6);
  expect(await layerPixel(page, 40, 5)).toEqual([40, 180, 60, 255]);
  await page.locator('.dialog input[data-key="useTargetSelection"]').check();
  await expect.poll(async () => off(await layerPixel(page, 5, 5))).toBeLessThanOrEqual(2);
  await setNumber(page, 'fade', 50);
  await expect.poll(async () => Math.abs((await layerPixel(page, 5, 5))[0] - (60 + mean[0]) / 2)).toBeLessThanOrEqual(2);
  await setNumber(page, 'fade', 0);
  await confirmDialog(page);
  await expect.poll(() => historyLength(page)).toBe(n1 + 1);
  near(await layerPixel(page, 5, 5), [...mean, 255], 2);
  expect(await layerPixel(page, 40, 5)).toEqual([40, 180, 60, 255]);
  // the remembered parameters keep the sliders but not the statistics of this image
  await expect.poll(() => page.evaluate(() => window.pigmentApp.settings.adjustLast['match-color'].source)).toBe(null);
  expect(await page.evaluate(() => 'target' in window.pigmentApp.settings.adjustLast['match-color'])).toBe(false);
  await runAwait(page, 'edit:undo');
  expect(await layerPixel(page, 5, 5)).toEqual([60, 90, 200, 255]);
  expect(errors).toEqual([]);
});

test('Export Color Lookup Tables bakes the adjustment layers into .cube and .3dl', async ({ page }) => {
  const errors = await openApp(page);
  await openFixture(page, 'gradient.png');
  // nothing to bake yet
  await runAwait(page, 'file:export-luts');
  await expect(page.locator('.toast.error').last()).toContainText('adjustment layers');
  await runAwait(page, 'layer:new-adjustment', 'invert');
  await runAwait(page, 'layer:new-adjustment', 'color-lookup');
  await page.locator('[data-panel="properties"].panel select[data-key="preset"]').selectOption('Black & White');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.active.params.preset)).toBe('Black & White');
  await page.evaluate(() => (window.__pigmentTest.nextSavePath = 'browser:/luts/grade.cube'));
  await run(page, 'file:export-luts');
  await expect(dialog(page)).toContainText('2 adjustment layers');
  await page.locator('.dialog select[data-key="size"]').selectOption('16');
  await page.locator('.dialog input[data-key="title"]').fill('Negative BW');
  await confirmDialog(page);
  await expect.poll(() => written(page, 'browser:/luts/grade.3dl')).not.toBe(null);
  const cube = parseCube(new Uint8Array(await written(page, 'browser:/luts/grade.cube')));
  expect(cube.type).toBe('3d');
  expect(cube.size).toBe(16);
  expect(cube.title).toBe('Negative BW');
  // invert then black & white: black -> white, white -> black, every entry grey
  expect(cube.data.slice(0, 3)).toEqual([1, 1, 1]);
  expect(cube.data.slice(-3)).toEqual([0, 0, 0]);
  for (let i = 0; i < cube.data.length; i += 3 * 97) {
    expect(cube.data[i]).toBeCloseTo(cube.data[i + 1], 5);
    expect(cube.data[i + 1]).toBeCloseTo(cube.data[i + 2], 5);
  }
  const threedl = parse3dl(new Uint8Array(await written(page, 'browser:/luts/grade.3dl')));
  expect(threedl.size).toBe(16);
  for (let i = 0; i < cube.data.length; i += 301) expect(Math.abs(threedl.data[i] - cube.data[i])).toBeLessThan(1 / 4095 + 1e-6);
  // the export does not touch the document
  expect(await page.evaluate(() => window.pigmentApp.doc.layers().length)).toBe(3);
  expect(await page.evaluate(() => window.pigmentApp.doc.layers().filter((l) => l.type === 'adjustment').length)).toBe(2);
  // a 50 % invert layer alone bakes to mid grey everywhere; replay form with a path, .cube only
  await runAwait(page, 'layer:delete');
  await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    const inv = d.layers().find((l) => l.kind === 'invert');
    inv.opacity = 0.5;
    inv.touch();
    d.changed('props', { layer: inv });
  });
  await runAwait(page, 'file:export-luts', { title: 'Half', size: 16, cube: true, threedl: false, path: 'browser:/luts/half.cube' });
  const half = parseCube(new Uint8Array(await written(page, 'browser:/luts/half.cube')));
  for (let i = 0; i < half.data.length; i += 3 * 113) expect(Math.abs(half.data[i] - 0.5)).toBeLessThan(0.01);
  expect(await written(page, 'browser:/luts/half.3dl')).toBe(null);
  expect(errors).toEqual([]);
});

test('Merge to HDR fuses the open documents into a new one and opens HDR Toning on it', async ({ page }) => {
  const errors = await openApp(page);
  const scene = (gain) => `(x, y) => {
    const s = 0.02 * Math.pow(200, x / 79) * (1 + 0.15 * (((x >> 2) + (y >> 2)) & 1)) * ${gain};
    const c = Math.min(1, s);
    const v = Math.round((c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055) * 255);
    return [v, v, v, 255];
  }`;
  await newDoc(page, { width: 80, height: 48, name: 'Dark' });
  await drawLayer(page, scene(0.25));
  await newDoc(page, { width: 80, height: 48, name: 'Bright' });
  await drawLayer(page, scene(4));
  const dark = await page.evaluate(() => {
    const d = window.pigmentApp.docs.list().find((x) => x.name === 'Dark');
    return Array.from(d.active.canvas.getContext('2d').getImageData(4, 24, 1, 1).data);
  });
  const bright = await layerPixel(page, 4, 24);
  // replay form: no dialogs, no toning
  await runAwait(page, 'file:automate-merge-hdr', { source: 'documents', toning: false });
  const made = await page.evaluate(() => {
    const app = window.pigmentApp, d = app.doc;
    return { count: app.docs.list().length, name: d.name, size: [d.width, d.height], layers: d.layers().length };
  });
  expect(made).toEqual({ count: 3, name: 'Merged HDR', size: [80, 48], layers: 1 });
  await expectNoDialog(page);
  // shadows come from the bright frame, clipped highlights from the dark one
  const left = await layerPixel(page, 4, 24), right = await layerPixel(page, 76, 24);
  expect(left[0]).toBeGreaterThan(dark[0] + 20);
  expect(left[0]).toBeLessThanOrEqual(bright[0] + 2);
  expect(right[0]).toBeLessThan(253);
  expect(left[3]).toBe(255);
  await expect(page.locator('.toast').last()).toContainText('Merged 2 exposures');
  await runAwait(page, 'file:close', undefined);
  // dialog flow: choose the two exposures, merge, HDR Toning opens on the new document
  await expect.poll(() => page.evaluate(() => window.pigmentApp.docs.list().length)).toBe(2);
  await run(page, 'file:automate-merge-hdr');
  await expect(dialog(page)).toContainText('exposure fusion');
  await expect(page.locator('.dialog input[type="checkbox"][data-key^="doc:"]')).toHaveCount(2);
  await page.locator('.dialog-backdrop .dialog-buttons .btn.primary').last().click(); // "Merge"; the HDR Toning dialog follows
  await expect(page.locator('.dialog select[data-key="method"]')).toBeVisible();
  expect(await page.evaluate(() => window.pigmentApp.doc.name)).toBe('Merged HDR');
  await page.keyboard.press('Escape');
  await expectNoDialog(page);
  // from files: the exposures are read through the bridge (PNG bytes), a frame of another size is scaled to the first
  await page.evaluate(async () => {
    const png = async (canvas) => new Uint8Array(await (await new Promise((r) => canvas.toBlob(r, 'image/png'))).arrayBuffer());
    const docs = window.pigmentApp.docs.list();
    const dark = docs.find((d) => d.name === 'Dark').active.canvas, bright = docs.find((d) => d.name === 'Bright').active.canvas;
    const half = document.createElement('canvas');
    half.width = 40;
    half.height = 24;
    half.getContext('2d').drawImage(bright, 0, 0, 40, 24);
    window.__pigmentTest.files['browser:/hdr/dark.png'] = await png(dark);
    window.__pigmentTest.files['browser:/hdr/bright-small.png'] = await png(half);
  });
  const before = await page.evaluate(() => window.pigmentApp.docs.list().length);
  await runAwait(page, 'file:automate-merge-hdr', { source: 'files', paths: ['browser:/hdr/dark.png', 'browser:/hdr/bright-small.png'], toning: false });
  const fromFiles = await page.evaluate(() => {
    const app = window.pigmentApp, d = app.doc;
    return { count: app.docs.list().length, name: d.name, size: [d.width, d.height] };
  });
  expect(fromFiles).toEqual({ count: before + 1, name: 'Merged HDR', size: [80, 48] });
  expect((await layerPixel(page, 4, 24))[0]).toBeGreaterThan(dark[0] + 20);
  await expect(page.locator('.toast').last()).toContainText('scaled to the first one');
  // one frame is not enough
  await runAwait(page, 'file:automate-merge-hdr', { source: 'documents', documents: [await docId(page)], toning: false });
  await expect(page.locator('.toast.error').last()).toContainText('at least two exposures');
  expect(errors).toEqual([]);
});
