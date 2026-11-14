// 16 and 32 bits per channel (builder "depth16"): Image > Mode > Bits/Channel, deep pixels kept in step with the
// 8-bit proxy (adjustments at full depth, 8-bit edits taken over, undo), 16-bit PNG / TIFF / TGA open and export,
// .pigment round trip, the float flatten, the Info panel readout.
import { test, expect } from '@playwright/test';
import { openApp, newDoc, run, runAwait, drag, confirmDialog, historyLength } from './helpers.mjs';
import { encodePng, decodePng, toRgba16, pngInfo } from '../../src/shared/pixels/png.js';
import { encodeTiff, decodeTiff, tiffInfo } from '../../src/shared/pixels/tiff.js';
import { encodeTga, decodeTga, tgaInfo } from '../../src/shared/pixels/tga.js';

const expectNoDialog = (page) => expect(page.locator('.dialog-backdrop')).toHaveCount(0);
const written = async (page, path) => {
  await expect.poll(() => page.evaluate((p) => !!window.__pigmentTest.written[p], path)).toBe(true);
  return new Uint8Array(await page.evaluate((p) => Array.from(window.__pigmentTest.written[p]), path));
};
const putFile = (page, path, bytes) => page.evaluate(([p, b]) => (window.__pigmentTest.files[p] = new Uint8Array(b)), [path, Array.from(bytes)]);

/** Paints a horizontal black-to-white ramp into the active layer (test setup, not an undo step) and syncs. */
const paintRamp = (page) =>
  page.evaluate(() => {
    const app = window.pigmentApp, d = app.doc, l = d.active;
    const w = l.canvas.width, h = l.canvas.height;
    const img = new ImageData(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = Math.round((x / (w - 1)) * 255);
      img.data.set([v, v, v, 255], (y * w + x) * 4);
    }
    l.canvas.getContext('2d').putImageData(img, 0, 0);
    l.touch();
    d.changed('pixels', { layer: l });
    app.deep.sync(d);
  });

/** Deep RGBA samples of the active layer at layer pixel (x, y), or null when the layer has none. */
const deepAt = (page, x, y = 0) =>
  page.evaluate(([px, py]) => {
    const app = window.pigmentApp, l = app.doc.active;
    app.deep.sync(app.doc);
    if (!l.deep) return null;
    const o = (py * l.canvas.width + px) * 4;
    return Array.from(l.deep.data.subarray(o, o + 4));
  }, [x, y]);

/** { type, proxyMatches, distinct }: whether the canvas is the rounded deep data everywhere, and red levels in use. */
const deepState = (page) =>
  page.evaluate(() => {
    const app = window.pigmentApp, l = app.doc.active;
    app.deep.sync(app.doc);
    if (!l.deep) return { type: null };
    const img = l.canvas.getContext('2d').getImageData(0, 0, l.canvas.width, l.canvas.height).data;
    const d = l.deep.data;
    const q = l.deep.type === 'f32' ? (v) => (v >= 1 ? 255 : v > 0 ? Math.floor(v * 255 + 0.5) : 0) : (v) => Math.floor((v + 128) / 257);
    let mismatches = 0;
    const seen = new Set();
    for (let i = 0; i < d.length; i += 4) {
      seen.add(d[i]);
      const a = img[i + 3];
      if (q(d[i + 3]) !== a) mismatches++;
      else if (a === 255) {
        if (q(d[i]) !== img[i] || q(d[i + 1]) !== img[i + 1] || q(d[i + 2]) !== img[i + 2]) mismatches++;
      } else if (a > 0) {
        // translucent pixels: a canvas keeps premultiplied 8-bit colour, so compare what it can hold
        for (let c = 0; c < 3; c++) if (Math.abs(Math.round((q(d[i + c]) * a) / 255) - Math.round((img[i + c] * a) / 255)) > 1) mismatches++;
      }
    }
    return { type: l.deep.type, length: d.length, proxyMatches: mismatches === 0, distinct: seen.size };
  });

test('image:depth is real: registered, not stubbed, mirrored to the menu state, refused where the mode forbids it', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  const info = await page.evaluate(() => {
    const app = window.pigmentApp;
    return { has: app.commands.has('image:depth'), stubbed: (app.stubbed ?? []).includes('image:depth'), enabled: app.commands.isEnabled?.('image:depth') ?? true, depth: app.doc.depth, deep: !!app.doc.active.deep, api: Object.keys(app.deep ?? {}).sort() };
  });
  expect(info.has).toBe(true);
  expect(info.stubbed).toBe(false);
  expect(info.enabled).toBe(true);
  expect(info.depth).toBe(8);
  expect(info.deep).toBe(false);
  expect(info.api).toEqual(expect.arrayContaining(['flatten', 'readout', 'setDepth', 'sync', 'toFloat']));
  await runAwait(page, 'image:depth', 16);
  expect(await page.evaluate(() => window.__pigmentTest.uiState?.depth ?? window.pigmentApp.doc.depth)).toBe(16);
  expect(await page.evaluate(() => window.pigmentApp.doc.depth)).toBe(16);
  // the same depth again is not a new history entry
  const n = await historyLength(page);
  await runAwait(page, 'image:depth', 16);
  expect(await historyLength(page)).toBe(n);
  // CMYK stops at 16 bits (the menu greys 32 out; the command says why)
  await page.evaluate(() => {
    window.pigmentApp.doc.mode = 'cmyk';
  });
  await runAwait(page, 'image:depth', 32);
  expect(await page.evaluate(() => window.pigmentApp.doc.depth)).toBe(16);
  await expect(page.locator('.toast.error')).toContainText('not available in this image mode');
  expect(errors).toEqual([]);
});

test('new 16-bit document: Levels changes the deep data without banding and the proxy matches it', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 1024, height: 40, depth: 16 });
  expect(await page.evaluate(() => window.pigmentApp.doc.depth)).toBe(16);
  const start = await deepState(page);
  expect(start).toMatchObject({ type: 'u16', length: 1024 * 40 * 4, proxyMatches: true });
  expect(await deepAt(page, 10)).toEqual([65535, 65535, 65535, 65535]);
  await paintRamp(page);
  expect((await deepState(page)).distinct).toBe(256);
  const before = await deepAt(page, 400);
  await runAwait(page, 'image:adjust-levels', { rgb: { inBlack: 20, inWhite: 235, gamma: 1.3, outBlack: 0, outWhite: 255 } });
  const after = await deepAt(page, 400);
  expect(after[0]).not.toBe(before[0]);
  // the 8-bit value 100 through Levels in float: ((100 - 20) / 215) ^ (1 / 1.3)
  const expected = Math.round(Math.pow((before[0] / 257 - 20) / 215, 1 / 1.3) * 65535);
  expect(after[0]).toBe(expected);
  expect(after[0] % 257).not.toBe(0); // a value no 8-bit pixel has
  expect(after[3]).toBe(65535);
  const state = await deepState(page);
  expect(state.proxyMatches).toBe(true);
  expect(await historyLength(page)).toBe(1);
  // undo brings back the exact 16-bit samples, redo the adjusted ones
  await runAwait(page, 'edit:undo');
  expect(await deepAt(page, 400)).toEqual(before);
  expect((await deepState(page)).proxyMatches).toBe(true);
  await runAwait(page, 'edit:redo');
  expect(await deepAt(page, 400)).toEqual(after);
  expect((await deepState(page)).proxyMatches).toBe(true);
  // a second adjustment works on the 16-bit result, not on the 8-bit proxy: two half-strength gammas equal one
  await runAwait(page, 'edit:undo');
  await runAwait(page, 'image:adjust-levels', { rgb: { inBlack: 0, inWhite: 255, gamma: 1.5, outBlack: 0, outWhite: 255 } });
  await runAwait(page, 'image:adjust-levels', { rgb: { inBlack: 0, inWhite: 255, gamma: 1.5, outBlack: 0, outWhite: 255 } });
  const twice = await deepAt(page, 400);
  const direct = Math.pow(before[0] / 65535, 1 / 2.25) * 65535;
  expect(Math.abs(twice[0] - direct)).toBeLessThanOrEqual(2);
  expect(errors).toEqual([]);
});

test('Levels through its dialog commits at full depth; a selection limits the deep edit', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 400, height: 60, depth: 16 });
  await paintRamp(page);
  const left = await deepAt(page, 100), right = await deepAt(page, 300);
  // select the right half, then Curves through its dialog and Invert (no dialog)
  await page.evaluate(async () => {
    const app = window.pigmentApp, d = app.doc;
    const { Selection } = await import('./lib/selection.js');
    d.selection = Selection.fromRect(d.width, d.height, { x: 200, y: 0, width: 200, height: 60 });
    d.changed('selection');
  });
  await run(page, 'image:adjust-curves');
  await expect(page.locator('.dialog')).toBeVisible();
  await confirmDialog(page); // the default curve is the identity: nothing moves, deep data stays put
  await expect.poll(() => historyLength(page)).toBe(1); // the commit follows the dialog
  expect(await deepAt(page, 300)).toEqual(right);
  await runAwait(page, 'image:adjust-invert');
  expect(await deepAt(page, 100)).toEqual(left);
  expect(await deepAt(page, 300)).toEqual([65535 - right[0], 65535 - right[1], 65535 - right[2], 65535]);
  expect((await deepState(page)).proxyMatches).toBe(true);
  await runAwait(page, 'select:none');
  // give the layer values only 16 bits can hold, then Brightness/Contrast through the real dialog: move the slider, OK
  await runAwait(page, 'image:adjust-levels', { rgb: { inBlack: 0, inWhite: 255, gamma: 1.37, outBlack: 0, outWhite: 255 } });
  const n = await historyLength(page);
  await run(page, 'image:adjust-brightness-contrast');
  const input = page.locator('.dialog input[type="number"][data-key="brightness"]');
  await input.fill('60');
  await input.dispatchEvent('change');
  await page.waitForTimeout(250); // let the debounced sync take over the 8-bit preview: the commit must still be 16-bit
  await confirmDialog(page);
  await expect.poll(() => historyLength(page)).toBe(n + 1);
  const lit = [await deepAt(page, 100), await deepAt(page, 37), await deepAt(page, 333)];
  expect(lit[0][0]).toBeGreaterThan(left[0] + 1000);
  expect(lit[0][0] % 257).not.toBe(0);
  expect((await deepState(page)).proxyMatches).toBe(true);
  // the dialog's result is the adjustment of the 16-bit pixels: the same as running it directly, without previews
  await runAwait(page, 'edit:undo');
  await runAwait(page, 'image:adjust-brightness-contrast', { brightness: 60, contrast: 0, legacy: false });
  expect([await deepAt(page, 100), await deepAt(page, 37), await deepAt(page, 333)]).toEqual(lit);
  expect(errors).toEqual([]);
});

test('8-bit edits are taken over where they changed pixels, the rest keeps its precision, undo restores it', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 300, height: 200, depth: 16 });
  await paintRamp(page);
  await runAwait(page, 'image:adjust-curves', { rgb: [[0, 0], [128, 150], [255, 255]] });
  const far = await deepAt(page, 250, 150), under = await deepAt(page, 100, 100);
  expect(under[0] % 257).not.toBe(0);
  // a brush stroke (8-bit work) across the middle
  await page.evaluate(() => {
    window.pigmentApp.setColors?.({ fg: '#ff0000' });
    window.pigmentApp.settings.foreground = '#ff0000';
  });
  await runAwait(page, 'tool:fg-color', '#ff0000');
  await runAwait(page, 'tool:brush');
  await drag(page, [60, 100], [140, 100]);
  await expect.poll(async () => (await deepAt(page, 100, 100))[0]).toBe(65535);
  const painted = await deepAt(page, 100, 100);
  expect(painted).toEqual([65535, 0, 0, 65535]);
  expect(await deepAt(page, 250, 150)).toEqual(far); // untouched pixels keep their 16-bit values
  expect((await deepState(page)).proxyMatches).toBe(true);
  await runAwait(page, 'edit:undo');
  expect(await deepAt(page, 100, 100)).toEqual(under); // the precise samples are back, not their 8-bit rounding
  // a filter runs at 8 bits: its result is taken from the proxy
  await runAwait(page, 'filter:apply', { kind: 'gaussian-blur', params: { radius: 3 } });
  const blurred = await deepState(page);
  expect(blurred.proxyMatches).toBe(true);
  await runAwait(page, 'edit:undo');
  expect(await deepAt(page, 100, 100)).toEqual(under);
  // a new layer gets deep pixels of its own; a transform that swaps the canvas and its undo keep both in step
  await runAwait(page, 'layer:new', { name: 'Top' });
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.active?.deep?.type ?? null)).toBe('u16');
  await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    d.setActive(d.root.children[0]);
  });
  await runAwait(page, 'image:rotate', 'flip-h');
  const flipped = await deepState(page);
  expect(flipped.proxyMatches).toBe(true);
  await runAwait(page, 'edit:undo');
  expect((await deepState(page)).proxyMatches).toBe(true);
  expect(await deepAt(page, 100, 100)).toEqual(under);
  expect(errors).toEqual([]);
});

test('crop, flips, quarter turns and Flatten Image keep the 16-bit samples; setPixels hands over float results', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 300, height: 200, depth: 16 });
  // a ramp in x with a little y in it, so every pixel is its own
  await page.evaluate(() => {
    const app = window.pigmentApp, d = app.doc, l = d.active;
    const img = new ImageData(300, 200);
    for (let y = 0; y < 200; y++) for (let x = 0; x < 300; x++) img.data.set([Math.round((x / 299) * 255), y, 90, 255], (y * 300 + x) * 4);
    l.canvas.getContext('2d').putImageData(img, 0, 0);
    l.touch();
    d.changed('pixels', { layer: l });
    app.deep.sync(d);
  });
  await runAwait(page, 'image:adjust-curves', { rgb: [[0, 0], [128, 150], [255, 255]] });
  const sample = await deepAt(page, 120, 50);
  expect(sample[0] % 257).not.toBe(0);
  // crop to a selection: the pixel moves to (20, 10) with its samples
  await page.evaluate(async () => {
    const d = window.pigmentApp.doc;
    const { Selection } = await import('./lib/selection.js');
    d.selection = Selection.fromRect(d.width, d.height, { x: 100, y: 40, width: 100, height: 80 });
    d.changed('selection');
  });
  await runAwait(page, 'image:crop');
  expect(await page.evaluate(() => [window.pigmentApp.doc.width, window.pigmentApp.doc.height])).toEqual([100, 80]);
  expect(await deepAt(page, 20, 10)).toEqual(sample);
  expect((await deepState(page)).proxyMatches).toBe(true);
  await runAwait(page, 'edit:undo');
  expect(await deepAt(page, 120, 50)).toEqual(sample);
  await runAwait(page, 'select:none');
  // flip and rotate the canvas
  await runAwait(page, 'image:rotate', 'flip-h');
  expect(await deepAt(page, 299 - 120, 50)).toEqual(sample);
  await runAwait(page, 'image:rotate', 'flip-v');
  expect(await deepAt(page, 299 - 120, 199 - 50)).toEqual(sample);
  await runAwait(page, 'image:rotate', 180);
  expect(await deepAt(page, 120, 50)).toEqual(sample);
  await runAwait(page, 'image:rotate', 90);
  expect(await page.evaluate(() => [window.pigmentApp.doc.width, window.pigmentApp.doc.height])).toEqual([200, 300]);
  expect(await deepAt(page, 199 - 50, 120)).toEqual(sample);
  await runAwait(page, 'image:rotate', -90);
  expect(await deepAt(page, 120, 50)).toEqual(sample);
  expect((await deepState(page)).proxyMatches).toBe(true);
  // Flatten Image with a 50% white layer on top: the float composite, not the 8-bit one
  await runAwait(page, 'layer:new', { name: 'Veil' });
  await page.evaluate(() => {
    const d = window.pigmentApp.doc, l = d.active;
    const ctx = l.canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, l.canvas.width, l.canvas.height);
    l.opacity = 0.5;
    l.touch();
    d.changed('pixels', { layer: l });
  });
  await runAwait(page, 'image:flatten');
  expect(await page.evaluate(() => window.pigmentApp.doc.root.children.length)).toBe(1);
  const flat = await deepAt(page, 120, 50);
  expect(flat).toEqual([Math.round((sample[0] + 65535) / 2), Math.round((sample[1] + 65535) / 2), Math.round((sample[2] + 65535) / 2), 65535]);
  expect((await deepState(page)).proxyMatches).toBe(true);
  await runAwait(page, 'edit:undo');
  expect(await page.evaluate(() => window.pigmentApp.doc.root.children.length)).toBe(2);
  await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    d.setActive(d.root.children[0]);
  });
  expect(await deepAt(page, 120, 50)).toEqual(sample);
  // a small layer that grows (as under a brush stroke that leaves its bounds) keeps the samples it had
  const grown = await page.evaluate(async () => {
    const app = window.pigmentApp, d = app.doc;
    const { RasterLayer } = await import('./lib/document.js');
    const layer = new RasterLayer({ name: 'Small', width: 50, height: 40, x: 100, y: 60 });
    const img = new ImageData(50, 40);
    for (let i = 0; i < 2000; i++) img.data.set([i % 50 * 5, 80, 200, 255], i * 4);
    layer.canvas.getContext('2d').putImageData(img, 0, 0);
    d.add(layer);
    d.setActive(layer);
    await app.commands.run('image:adjust-levels', { rgb: { inBlack: 0, inWhite: 255, gamma: 1.21, outBlack: 0, outWhite: 255 } }, 'api');
    const before = Array.from(layer.deep.data.subarray((10 * 50 + 20) * 4, (10 * 50 + 20) * 4 + 4));
    layer.ensureCovers({ x: 80, y: 40, width: 120, height: 100 });
    layer.touch();
    d.changed('pixels', { layer });
    app.deep.sync(d);
    const w = layer.canvas.width;
    const at = (x, y) => Array.from(layer.deep.data.subarray((y * w + x) * 4, (y * w + x) * 4 + 4));
    return { before, size: [layer.x, layer.y, w, layer.canvas.height], after: at(20 + 20, 10 + 20), margin: at(2, 2), length: layer.deep.data.length };
  });
  expect(grown.size).toEqual([80, 40, 120, 100]);
  expect(grown.length).toBe(120 * 100 * 4);
  expect(grown.before[0] % 257).not.toBe(0);
  expect(grown.after).toEqual(grown.before);
  expect(grown.margin).toEqual([0, 0, 0, 0]);
  await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    d.remove(d.active);
    d.setActive(d.root.children[0]);
  });
  // another module's float result goes in through app.deep.setPixels, as one undo step
  const n = await historyLength(page);
  const ok = await page.evaluate(() => {
    const app = window.pigmentApp, l = app.doc.active;
    const f = app.deep.toFloat(l);
    for (let i = 0; i < f.data.length; i += 4) f.data[i] = 0.123456;
    return app.deep.setPixels(l, f.data, 'Float edit');
  });
  expect(ok).toBe(true);
  expect(await historyLength(page)).toBe(n + 1);
  expect((await deepAt(page, 120, 50))[0]).toBe(Math.round(0.123456 * 65535));
  expect((await deepState(page)).proxyMatches).toBe(true);
  await runAwait(page, 'edit:undo');
  expect(await deepAt(page, 120, 50)).toEqual(sample);
  // Image > Duplicate gives a document of the same depth with the same samples
  await runAwait(page, 'image:duplicate', { name: 'Deep copy' });
  expect(await page.evaluate(() => [window.pigmentApp.doc.name, window.pigmentApp.doc.depth, window.pigmentApp.docs.list().length])).toEqual(['Deep copy', 16, 2]);
  await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    d.setActive(d.root.children[0]);
  });
  expect(await deepAt(page, 120, 50)).toEqual(sample);
  expect(errors).toEqual([]);
});

test('Image > Mode > 8 Bits drops the deep data (dithered), undo brings it back; 32 bits keeps highlights', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 512, height: 32 });
  await paintRamp(page);
  await runAwait(page, 'image:depth', 16);
  expect((await deepState(page)).type).toBe('u16');
  await runAwait(page, 'image:adjust-levels', { rgb: { inBlack: 0, inWhite: 255, gamma: 1, outBlack: 100, outWhite: 110 } }); // a ramp squeezed into 10 levels
  const squeezed = await deepState(page);
  expect(squeezed.distinct).toBeGreaterThan(200); // 256 inputs, almost all distinct at 16 bits
  const precise = await deepAt(page, 200);
  const n = await historyLength(page);
  await runAwait(page, 'image:depth', 8);
  expect(await page.evaluate(() => [window.pigmentApp.doc.depth, window.pigmentApp.doc.active.deep])).toEqual([8, null]);
  expect(await historyLength(page)).toBe(n + 1);
  // dithering: inside one 8-bit band of the squeezed ramp both neighbouring levels appear
  const band = await page.evaluate(() => {
    const l = window.pigmentApp.doc.active;
    const img = l.canvas.getContext('2d').getImageData(0, 0, l.canvas.width, l.canvas.height).data;
    const col = (x) => {
      const s = new Set();
      for (let y = 0; y < l.canvas.height; y++) s.add(img[(y * l.canvas.width + x) * 4]);
      return [...s].sort();
    };
    return { mid: col(230), all: new Set(Array.from({ length: l.canvas.width }, (_, x) => img[x * 4])).size };
  });
  expect(band.mid.length).toBe(2);
  expect(band.mid[1] - band.mid[0]).toBe(1);
  await runAwait(page, 'edit:undo');
  expect(await page.evaluate(() => window.pigmentApp.doc.depth)).toBe(16);
  expect(await deepAt(page, 200)).toEqual(precise);
  expect((await deepState(page)).proxyMatches).toBe(true);
  await runAwait(page, 'edit:redo');
  expect(await page.evaluate(() => window.pigmentApp.doc.active.deep)).toBe(null);
  await runAwait(page, 'edit:undo');
  // without dither the proxy stays as it is
  await runAwait(page, 'image:depth', { depth: 8, dither: false });
  expect(await page.evaluate(() => {
    const l = window.pigmentApp.doc.active;
    return new Set(Array.from(l.canvas.getContext('2d').getImageData(230, 0, 1, l.canvas.height).data.filter((_, i) => i % 4 === 0))).size;
  })).toBe(1);
  await runAwait(page, 'edit:undo');
  // 32 bits: +4 stops pushes the greys above white, -4 brings them back (16 bits would have clipped them)
  await runAwait(page, 'image:depth', 32);
  expect((await deepState(page)).type).toBe('f32');
  const f0 = await deepAt(page, 480);
  await runAwait(page, 'image:adjust-exposure', { exposure: 4, offset: 0, gamma: 1 });
  expect((await deepAt(page, 480))[0]).toBeGreaterThan(1);
  expect((await deepState(page)).proxyMatches).toBe(true); // the proxy clamps
  await runAwait(page, 'image:adjust-exposure', { exposure: -4, offset: 0, gamma: 1 });
  expect(Math.abs((await deepAt(page, 480))[0] - f0[0])).toBeLessThan(1e-4);
  await runAwait(page, 'image:depth', 16);
  await expect(page.locator('.toast').last()).toBeVisible();
  expect((await deepState(page)).type).toBe('u16');
  expect(errors).toEqual([]);
});

test('opening a 16-bit PNG gives a 16-bit document with the file\'s samples; an 8-bit PNG stays 8-bit', async ({ page }) => {
  const errors = await openApp(page);
  const w = 64, h = 48;
  const data = new Uint16Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set([x * 1000 + 7, y * 1300 + 3, 12345, x < 8 ? 30000 : 65535], (y * w + x) * 4);
  await putFile(page, 'mem:/deep16.png', await encodePng({ width: w, height: h, channels: 4, depth: 16, data }, { dpi: 300 }));
  await runAwait(page, 'file:open-paths', ['mem:/deep16.png']);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc?.path ?? null)).toBe('mem:/deep16.png');
  const doc = await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    return { depth: d.depth, width: d.width, height: d.height, dpi: d.dpi, type: d.active.deep?.type, uiDepth: window.__pigmentTest.uiState?.depth };
  });
  expect(doc).toMatchObject({ depth: 16, width: w, height: h, dpi: 300, type: 'u16' });
  expect(await deepAt(page, 20, 10)).toEqual([20 * 1000 + 7, 10 * 1300 + 3, 12345, 65535]);
  expect(await deepAt(page, 3, 10)).toEqual([3007, 13003, 12345, 30000]);
  expect((await deepState(page)).proxyMatches).toBe(true);
  // 16-bit greyscale
  const grey = new Uint16Array(w * h);
  for (let i = 0; i < grey.length; i++) grey[i] = i * 21;
  await putFile(page, 'mem:/grey16.png', await encodePng({ width: w, height: h, channels: 1, depth: 16, data: grey }));
  await runAwait(page, 'file:open-paths', ['mem:/grey16.png']);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc?.path ?? null)).toBe('mem:/grey16.png');
  expect(await deepAt(page, 5, 1)).toEqual([(w + 5) * 21, (w + 5) * 21, (w + 5) * 21, 65535]);
  // an 8-bit PNG keeps the browser path
  const small = new Uint8ClampedArray(16 * 16 * 4).fill(200);
  await putFile(page, 'mem:/plain.png', await encodePng({ width: 16, height: 16, channels: 4, depth: 8, data: small }));
  await runAwait(page, 'file:open-paths', ['mem:/plain.png']);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc?.path ?? null)).toBe('mem:/plain.png');
  expect(await page.evaluate(() => [window.pigmentApp.doc.depth, window.pigmentApp.doc.active.deep])).toEqual([8, null]);
  expect(errors).toEqual([]);
});

test('Export As "PNG 16-bit" writes a 16-bit file with the deep samples; Save keeps a 16-bit PNG at 16 bits', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 512, height: 24, depth: 16 });
  await paintRamp(page);
  await runAwait(page, 'image:adjust-curves', { rgb: [[0, 0], [128, 160], [255, 255]] });
  const sample = await deepAt(page, 300, 5);
  await page.evaluate(() => (window.__pigmentTest.nextSavePath = 'mem:/out16.png'));
  await run(page, 'file:export');
  await page.locator('.dialog select[data-key="format"]').selectOption('png16');
  await expect(page.locator('.dialog .depth-note:visible')).toContainText('Composited at 16 bits/channel');
  await confirmDialog(page);
  const bytes = await written(page, 'mem:/out16.png');
  expect(pngInfo(bytes)).toMatchObject({ width: 512, height: 24, bitDepth: 16 });
  const back = toRgba16(await decodePng(bytes));
  expect(Array.from(back.data.subarray((5 * 512 + 300) * 4, (5 * 512 + 300) * 4 + 4))).toEqual(sample);
  expect(sample[0] % 257).not.toBe(0);
  // the plain PNG format still writes 8 bits
  await runAwait(page, 'file:export', { path: 'mem:/out8.png', format: 'png' });
  expect(pngInfo(await written(page, 'mem:/out8.png')).bitDepth).toBe(8);
  // half size and a background colour go through the float pipeline too
  await runAwait(page, 'file:export', { path: 'mem:/half16.png', format: 'png16', width: 256, height: 12, background: '#ffffff' });
  const half = await decodePng(await written(page, 'mem:/half16.png'));
  expect([half.width, half.height, half.depth]).toEqual([256, 12, 16]);
  expect(new Set(toRgba16(half).data.filter((_, i) => i % 4 === 0)).size).toBeGreaterThan(200);
  // open the exported file, change it, File > Save: the .png on disk is still 16-bit
  await putFile(page, 'mem:/out16.png', bytes);
  await runAwait(page, 'file:open-paths', ['mem:/out16.png']);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc?.path ?? null)).toBe('mem:/out16.png');
  await runAwait(page, 'image:adjust-invert');
  await page.evaluate(() => delete window.__pigmentTest.written['mem:/out16.png']);
  await runAwait(page, 'file:save');
  const saved = await written(page, 'mem:/out16.png');
  expect(pngInfo(saved).bitDepth).toBe(16);
  const savedPx = toRgba16(await decodePng(saved));
  expect(savedPx.data[(5 * 512 + 300) * 4]).toBe(65535 - sample[0]);
  expect(await page.evaluate(() => window.pigmentApp.doc.history.dirty)).toBe(false);
  expect(errors).toEqual([]);
});

test('TIFF: export by document depth with LZW, reopen at 16 bits; open big-endian, 8-bit and float files; TGA both ways', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 320, height: 40, depth: 16 });
  await paintRamp(page);
  await runAwait(page, 'image:adjust-levels', { rgb: { inBlack: 10, inWhite: 250, gamma: 1.2, outBlack: 0, outWhite: 255 } });
  const sample = await deepAt(page, 200, 7);
  await page.evaluate(() => (window.__pigmentTest.nextSavePath = 'mem:/out.tif'));
  await run(page, 'file:export');
  await page.locator('.dialog select[data-key="format"]').selectOption('tiff');
  await expect(page.locator('.dialog select[data-key="compression"]')).toBeVisible();
  await expect(page.locator('.dialog .depth-note:visible')).toContainText('Composited at 16 bits/channel');
  await page.locator('.dialog select[data-key="tiffDepth"]').selectOption('8');
  await expect(page.locator('.dialog .depth-note:visible')).toContainText('8 bits/channel');
  await page.locator('.dialog select[data-key="tiffDepth"]').selectOption('0');
  await confirmDialog(page);
  const bytes = await written(page, 'mem:/out.tif');
  expect(tiffInfo(bytes)).toMatchObject({ width: 320, height: 40, bitDepth: 16, samples: 3, compression: 'lzw' });
  const dec = await decodeTiff(bytes);
  expect(Array.from(dec.data.subarray((7 * 320 + 200) * 3, (7 * 320 + 200) * 3 + 3))).toEqual(sample.slice(0, 3));
  // other options: 8-bit PackBits, float Deflate
  await runAwait(page, 'file:export', { path: 'mem:/out8.tif', format: 'tiff', tiffDepth: 8, compression: 'packbits' });
  expect(tiffInfo(await written(page, 'mem:/out8.tif'))).toMatchObject({ bitDepth: 8, compression: 'packbits' });
  await runAwait(page, 'file:export', { path: 'mem:/out32.tif', format: 'tiff', tiffDepth: 32, compression: 'deflate' });
  const f = await decodeTiff(await written(page, 'mem:/out32.tif'));
  expect([f.depth, f.float]).toEqual([32, true]);
  expect(Math.abs(f.data[(7 * 320 + 200) * 3] - sample[0] / 65535)).toBeLessThan(1e-6);
  // reopen the 16-bit export
  await putFile(page, 'mem:/out.tif', bytes);
  await runAwait(page, 'file:open-paths', ['mem:/out.tif']);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc?.path ?? null)).toBe('mem:/out.tif');
  expect(await page.evaluate(() => [window.pigmentApp.doc.depth, window.pigmentApp.doc.format, window.pigmentApp.doc.active.deep?.type])).toEqual([16, 'tif', 'u16']);
  expect(await deepAt(page, 200, 7)).toEqual([...sample.slice(0, 3), 65535]);
  // File > Save on a .tif writes a TIFF at the document depth again
  await runAwait(page, 'image:adjust-invert');
  await page.evaluate(() => delete window.__pigmentTest.written['mem:/out.tif']);
  await runAwait(page, 'file:save');
  expect(tiffInfo(await written(page, 'mem:/out.tif'))).toMatchObject({ bitDepth: 16 });
  // files from "elsewhere": big-endian 16-bit RGBA with PackBits, 8-bit grey, 32-bit float
  const w = 30, h = 20;
  const rgba16 = new Uint16Array(w * h * 4);
  for (let i = 0; i < w * h; i++) rgba16.set([i * 100, 65535 - i * 100, 4321, i % w < 5 ? 20000 : 65535], i * 4);
  await putFile(page, 'mem:/be.tiff', await encodeTiff({ width: w, height: h, channels: 4, depth: 16, data: rgba16 }, { compression: 'packbits', littleEndian: false, dpi: 150 }));
  await runAwait(page, 'file:open-paths', ['mem:/be.tiff']);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc?.path ?? null)).toBe('mem:/be.tiff');
  expect(await page.evaluate(() => [window.pigmentApp.doc.depth, window.pigmentApp.doc.dpi])).toEqual([16, 150]);
  expect(await deepAt(page, 7, 2)).toEqual([67 * 100, 65535 - 67 * 100, 4321, 65535]);
  expect(await deepAt(page, 2, 2)).toEqual([62 * 100, 65535 - 62 * 100, 4321, 20000]);
  const grey8 = new Uint8ClampedArray(w * h);
  for (let i = 0; i < grey8.length; i++) grey8[i] = i % 256;
  await putFile(page, 'mem:/grey.tif', await encodeTiff({ width: w, height: h, channels: 1, depth: 8, data: grey8 }, { compression: 'none' }));
  await runAwait(page, 'file:open-paths', ['mem:/grey.tif']);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc?.path ?? null)).toBe('mem:/grey.tif');
  expect(await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    return [d.depth, d.active.deep, Array.from(d.active.canvas.getContext('2d').getImageData(13, 1, 1, 1).data)];
  })).toEqual([8, null, [43, 43, 43, 255]]);
  const f32 = new Float32Array(w * h * 3);
  for (let i = 0; i < f32.length; i++) f32[i] = (i % 90) / 30; // up to 3x white
  await putFile(page, 'mem:/hdr.tif', await encodeTiff({ width: w, height: h, channels: 3, depth: 32, data: f32 }));
  await runAwait(page, 'file:open-paths', ['mem:/hdr.tif']);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc?.path ?? null)).toBe('mem:/hdr.tif');
  expect(await page.evaluate(() => [window.pigmentApp.doc.depth, window.pigmentApp.doc.active.deep?.type])).toEqual([32, 'f32']);
  const hdr = await deepAt(page, 25, 0);
  expect(Math.abs(hdr[0] - 75 / 30)).toBeLessThan(1e-6);
  expect((await deepState(page)).proxyMatches).toBe(true);
  // TGA: export (RLE), reopen as an 8-bit document, and open a 32-bit file with alpha
  await runAwait(page, 'file:export', { path: 'mem:/out.tga', format: 'tga' });
  const tga = await written(page, 'mem:/out.tga');
  expect(tgaInfo(tga)).toMatchObject({ width: w, height: h, rle: true });
  const tgaBack = decodeTga(tga);
  expect(Array.from(tgaBack.data.subarray(0, 4))).toEqual([0, 9, 17, 255]); // the float document's first pixel (0, 1/30, 2/30) at 8 bits
  const img = { width: 12, height: 9, data: new Uint8ClampedArray(12 * 9 * 4) };
  for (let i = 0; i < 12 * 9; i++) img.data.set([i * 2, 255 - i, 40, i < 12 ? 128 : 255], i * 4);
  await putFile(page, 'mem:/alpha.tga', encodeTga(img, { rle: false }));
  await runAwait(page, 'file:open-paths', ['mem:/alpha.tga']);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc?.path ?? null)).toBe('mem:/alpha.tga');
  expect(await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    const px = (x, y) => Array.from(d.active.canvas.getContext('2d').getImageData(x, y, 1, 1).data);
    return [d.width, d.height, d.depth, px(3, 0)[3], px(3, 2)]; // (the translucent pixel's colour is whatever the canvas keeps of it)
  })).toEqual([12, 9, 8, 128, [54, 228, 40, 255]]);
  // a file that only claims to be a TIFF fails with a message, not a broken document
  const count = await page.evaluate(() => window.pigmentApp.docs.list().length);
  await putFile(page, 'mem:/broken.tif', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
  await runAwait(page, 'file:open-paths', ['mem:/broken.tif']);
  expect(await page.evaluate(() => window.pigmentApp.docs.list().length)).toBe(count);
  await expect(page.locator('.dialog-backdrop, .toast.error').last()).toContainText(/TIFF/);
  expect(errors.filter((e) => !/Not a TIFF|Could not open/.test(e))).toEqual([]);
});

test('.pigment keeps the deep pixels; PSD is written at 8 bits and says so once', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 200, height: 100, depth: 16 });
  await paintRamp(page);
  await runAwait(page, 'image:adjust-levels', { rgb: { inBlack: 5, inWhite: 251, gamma: 0.9, outBlack: 0, outWhite: 255 } });
  // a second layer, painted after the last sync: saving must flush it into the file
  await runAwait(page, 'layer:new', { name: 'Paint' });
  await page.evaluate(() => {
    const d = window.pigmentApp.doc, l = d.active;
    const ctx = l.canvas.getContext('2d');
    ctx.fillStyle = 'rgb(10, 200, 30)';
    ctx.fillRect(0, 0, 50, 50);
    l.touch();
    d.changed('pixels', { layer: l });
  });
  const sample = await page.evaluate(() => {
    const d = window.pigmentApp.doc, l = d.root.children[0];
    window.pigmentApp.deep.sync(d);
    return Array.from(l.deep.data.subarray(150 * 4, 150 * 4 + 4));
  });
  expect(sample[0] % 257).not.toBe(0);
  await page.evaluate(() => (window.__pigmentTest.nextSavePath = 'mem:/deep.pigment'));
  await run(page, 'file:save-as');
  const bytes = await written(page, 'mem:/deep.pigment');
  await runAwait(page, 'file:close');
  await putFile(page, 'mem:/again.pigment', bytes);
  await runAwait(page, 'file:open-paths', ['mem:/again.pigment']);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc?.path ?? null)).toBe('mem:/again.pigment');
  const back = await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    const [bottom, top] = d.root.children;
    return { depth: d.depth, layers: d.root.children.length, bottom: Array.from(bottom.deep.data.subarray(150 * 4, 150 * 4 + 4)), top: Array.from(top.deep.data.subarray(0, 4)), topType: top.deep.type, clear: Array.from(top.deep.data.subarray(60 * 4, 60 * 4 + 4)) };
  });
  expect(back).toEqual({ depth: 16, layers: 2, bottom: sample, top: [10 * 257, 200 * 257, 30 * 257, 65535], topType: 'u16', clear: [0, 0, 0, 0] });
  // PSD: one notice, 8-bit file
  await page.evaluate(() => (window.__pigmentTest.nextSavePath = 'mem:/deep.psd'));
  await run(page, 'file:save-as');
  await written(page, 'mem:/deep.psd');
  await expect(page.locator('.toast', { hasText: 'PSD files are written at 8 bits/channel' })).toHaveCount(1);
  await runAwait(page, 'file:save');
  await expect(page.locator('.toast', { hasText: 'PSD files are written at 8 bits/channel' })).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('flattening in float: opacity, Multiply and a Curves adjustment layer keep 16-bit values; Overlay falls back to the 8-bit composite', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 256, height: 32, depth: 16, background: 'black' });
  // a white layer at 50% over black: 32768 in float, 128 * 257 = 32896 at 8 bits
  await runAwait(page, 'layer:new', { name: 'White' });
  await page.evaluate(() => {
    const app = window.pigmentApp, d = app.doc, l = d.active;
    const ctx = l.canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, l.canvas.width, l.canvas.height);
    l.opacity = 0.5;
    l.touch();
    d.changed('pixels', { layer: l });
  });
  const flat = () => page.evaluate(() => {
    const f = window.pigmentApp.deep.flatten();
    return { exact: f.exact, reason: f.reason, type: f.type, px: Array.from(f.data.subarray(40 * 4, 40 * 4 + 4)) };
  });
  expect(await flat()).toEqual({ exact: true, reason: null, type: 'u16', px: [32768, 32768, 32768, 65535] });
  await runAwait(page, 'file:export', { path: 'mem:/half.png', format: 'png16' });
  const half = toRgba16(await decodePng(await written(page, 'mem:/half.png')));
  expect(half.data[40 * 4]).toBe(32768);
  // Multiply stays in float
  await page.evaluate(() => {
    const d = window.pigmentApp.doc, l = d.active;
    l.blend = 'multiply';
    l.opacity = 1;
    d.root.children[0].canvas.getContext('2d').fillStyle = '#808080';
    const b = d.root.children[0];
    const ctx = b.canvas.getContext('2d');
    ctx.fillStyle = 'rgb(100, 100, 100)';
    ctx.fillRect(0, 0, b.canvas.width, b.canvas.height);
    b.touch();
    l.touch();
    d.changed('pixels', { layer: b });
  });
  expect(await flat()).toMatchObject({ exact: true, px: [100 * 257, 100 * 257, 100 * 257, 65535] });
  // a Curves adjustment layer is applied with deep maths: 100 -> the spline value, not an 8-bit level
  await runAwait(page, 'layer:new-adjustment', 'curves');
  await page.evaluate(() => {
    const d = window.pigmentApp.doc, l = d.active;
    l.params = { rgb: [[0, 0], [100, 130.4], [255, 255]] };
    l.touch();
    d.changed('props', { layer: l });
  });
  const curved = await flat();
  expect(curved.exact).toBe(true);
  expect(curved.px[0]).toBe(Math.round(130.4 * 257));
  // Overlay is composited at 8 bits: the plan says so, the dialog says so, the export still works
  await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    const white = d.root.children[1];
    white.blend = 'overlay';
    white.touch();
    d.changed('props', { layer: white });
  });
  const fallback = await flat();
  expect(fallback.exact).toBe(false);
  expect(fallback.reason).toContain('overlay blend mode');
  expect(fallback.px[0] % 257).toBe(0);
  await page.evaluate(() => (window.__pigmentTest.nextSavePath = 'mem:/overlay.png'));
  await run(page, 'file:export');
  await page.locator('.dialog select[data-key="format"]').selectOption('png16');
  await expect(page.locator('.dialog .depth-note:visible')).toContainText('8-bit composite');
  await confirmDialog(page);
  expect(pngInfo(await written(page, 'mem:/overlay.png')).bitDepth).toBe(16);
  await expectNoDialog(page);
  expect(errors).toEqual([]);
});

test('the Info panel shows 16-bit values (0..32768) under the pointer and float values at 32 bits', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 400, height: 300, depth: 16 });
  await paintRamp(page);
  await runAwait(page, 'image:adjust-levels', { rgb: { inBlack: 0, inWhite: 255, gamma: 1.7, outBlack: 0, outWhite: 255 } });
  await runAwait(page, 'window:panel-info');
  const sample = await deepAt(page, 200, 150);
  const r = await page.evaluate(() => window.pigmentApp.deep.readout(window.pigmentApp.doc, 200, 150));
  expect(r).toMatchObject({ depth: 16, precise: true, values: sample });
  expect(r.text[0]).toBe(String(Math.round((sample[0] * 32768) / 65535)));
  // move the pointer over the canvas: the panel block appears with those numbers
  const p = await page.evaluate(() => {
    const v = window.pigmentApp.view, s = v.toScreen(200.5, 150.5), b = v.canvas.getBoundingClientRect();
    return { x: b.left + s.x, y: b.top + s.y };
  });
  await page.mouse.move(p.x - 3, p.y - 3);
  await page.mouse.move(p.x, p.y);
  const block = page.locator('.info-panel .info-deep');
  await expect(block).toBeVisible();
  await expect(block.locator('[data-k="deep-title"]')).toContainText('16-bit (0–32768)');
  await expect(block.locator('[data-k="deep-r"]')).toHaveText(r.text[0]);
  await expect(block.locator('[data-k="deep-a"]')).toHaveText('100%');
  // 32 bits: floats
  await runAwait(page, 'image:depth', 32);
  await page.mouse.move(p.x + 2, p.y);
  await page.mouse.move(p.x, p.y);
  await expect(block.locator('[data-k="deep-title"]')).toContainText('32-bit (float)');
  await expect(block.locator('[data-k="deep-r"]')).toHaveText((sample[0] / 65535).toFixed(4));
  // back at 8 bits the block goes away
  await runAwait(page, 'image:depth', 8);
  await page.mouse.move(p.x + 2, p.y);
  await expect(block).toBeHidden();
  expect(errors).toEqual([]);
});
