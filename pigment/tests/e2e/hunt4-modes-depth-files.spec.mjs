// Regressions from the 0.3.1 cross-feature hunt, area "modes, depth, files": image modes, 16/32-bit depth and the
// file formats working together (undo of deep adjustments, Duotone and PSD, merges at 16 bits, damaged files,
// placing TIFF / TGA, duotone pixels read back into the document, indexed exports, mode checks on open).
import { test, expect } from '@playwright/test';
import { openApp, newDoc, run, runAwait, pixel, historyLength } from './helpers.mjs';
import { encodePng, decodePng, toRgba8 } from '../../src/shared/pixels/png.js';
import { encodeTiff, decodeTiff, toRgba } from '../../src/shared/pixels/tiff.js';
import { encodeTga } from '../../src/shared/pixels/tga.js';
import { encodeGif } from '../../src/shared/pixels/gif.js';
import { DUOTONE_PRESETS } from '../../src/shared/pixels/modes.js';

const putFile = (page, path, bytes) => page.evaluate(([p, b]) => (window.__pigmentTest.files[p] = new Uint8Array(b)), [path, Array.from(bytes)]);
const written = async (page, path) => {
  await expect.poll(() => page.evaluate((p) => !!window.__pigmentTest.written[p], path)).toBe(true);
  return new Uint8Array(await page.evaluate((p) => Array.from(window.__pigmentTest.written[p]), path));
};
const openPath = async (page, path) => {
  await runAwait(page, 'file:open-paths', [path]);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc?.path ?? null)).toBe(path);
};
const closeAll = (page) => page.evaluate(async () => {
  const app = window.pigmentApp;
  for (const d of app.docs.docs.slice()) await app.docs.close(d, { force: true });
});
const selectRect = (page, rect) => page.evaluate(async (r) => {
  const app = window.pigmentApp, d = app.doc;
  const { Selection } = await import('/lib/selection.js');
  d.selection = Selection.fromRect(d.width, d.height, r);
  d.changed('selection');
}, rect);

/** A 256 x 16 grey ramp with 4096 distinct 16-bit values (RGB samples) and its PNG. */
const RAMP = { width: 256, height: 16 };
function ramp16() {
  const { width, height } = RAMP;
  const data = new Uint16Array(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const v = Math.round(((x + y / height) / width) * 65535);
    data.set([v, v, v], (y * width + x) * 3);
  }
  return data;
}
const rampPng = () => encodePng({ width: RAMP.width, height: RAMP.height, channels: 3, depth: 16, data: ramp16() }, {});

/** Paints a test picture into the active layer (setup, not an undo step): a grey ramp or a colourful pattern. */
const paint = (page, kind = 'color') => page.evaluate((k) => {
  const app = window.pigmentApp, d = app.doc, l = d.active;
  const w = l.canvas.width, h = l.canvas.height;
  const img = new ImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    if (k === 'ramp') {
      const v = Math.round((x / (w - 1)) * 255);
      img.data.set([v, v, v, 255], o);
    } else img.data.set([Math.round((x / (w - 1)) * 255), Math.round((y / (h - 1)) * 255), (x * 7 + y * 3) & 255, 255], o);
  }
  l.canvas.getContext('2d').putImageData(img, 0, 0);
  l.touch();
  d.changed('pixels', { layer: l });
  app.deep?.sync(d);
}, kind);

/** The deep samples of the bottom layer (synced), as numbers. */
const deepData = (page) => page.evaluate(() => {
  const app = window.pigmentApp, l = app.doc.layers()[0];
  app.deep.sync(app.doc);
  return l.deep ? Array.from(l.deep.data) : null;
});
/** Distinct red values in the bottom layer's deep samples, and how many float samples lie above white. */
const deepStats = (page) => page.evaluate(() => {
  const app = window.pigmentApp, l = app.doc.layers()[0];
  app.deep.sync(app.doc);
  if (!l.deep) return null;
  const seen = new Set();
  let over = 0;
  for (let i = 0; i < l.deep.data.length; i += 4) {
    seen.add(l.deep.data[i]);
    if (l.deep.type === 'f32' && l.deep.data[i] > 1) over++;
  }
  return { distinct: seen.size, over, layers: app.doc.layers().length };
});
/** How many bytes of the composite differ from a snapshot taken with compositeData(). */
const compositeData = (page) => page.evaluate(() => {
  const d = window.pigmentApp.doc;
  return Array.from(d.view.compositor.composite(d).getContext('2d', { willReadFrequently: true }).getImageData(0, 0, d.width, d.height).data);
});
const maxDiff = (a, b) => {
  if (a.length !== b.length) return Infinity;
  let max = 0;
  for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i] - b[i]));
  return max;
};
const toDuotone = async (page, preset = 2) => {
  await runAwait(page, 'image:mode', { mode: 'grayscale', silent: true, flatten: true });
  await runAwait(page, 'image:mode', { mode: 'duotone', silent: true, options: { duotone: DUOTONE_PRESETS[preset] } });
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.mode)).toBe('duotone');
};

test('undo and redo of a subtle adjustment restore the 16-bit samples exactly, and the saved file is the original', async ({ page }) => {
  const errors = await openApp(page);
  await putFile(page, 'mem:/ramp16.png', await rampPng());
  await openPath(page, 'mem:/ramp16.png');
  const original = await deepData(page);
  expect(original.length).toBe(RAMP.width * RAMP.height * 4);
  // smaller than one 8-bit level for most pixels: the proxy alone cannot tell the edit from the original
  await runAwait(page, 'image:adjust-exposure', { exposure: 0.02, offset: 0, gamma: 1 });
  await expect.poll(() => historyLength(page)).toBe(1);
  const edited = await deepData(page);
  expect(edited.filter((v, i) => v !== original[i]).length).toBeGreaterThan(3000);
  await runAwait(page, 'edit:undo');
  await expect.poll(() => historyLength(page)).toBe(0);
  expect(await deepData(page)).toEqual(original);
  expect(await page.evaluate(() => window.pigmentApp.doc.history.dirty)).toBe(false);
  // what is saved after the undo is the file that was opened
  await page.evaluate(() => window.pigmentApp.docs.writeTo(window.pigmentApp.doc, 'mem:/after-undo.tif', { copy: true }));
  const tif = toRgba(await decodeTiff(await written(page, 'mem:/after-undo.tif')));
  expect(tif.depth).toBe(16);
  expect(Array.from(tif.data)).toEqual(original);
  await runAwait(page, 'edit:redo');
  await expect.poll(() => historyLength(page)).toBe(1);
  expect(await deepData(page)).toEqual(edited);
  expect(errors).toEqual([]);
});

test('undo of an adjustment in a 32-bit document brings back the values above white', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 60, height: 40, depth: 32 });
  await paint(page);
  await runAwait(page, 'image:adjust-exposure', { exposure: 1, offset: 0, gamma: 1 });
  const bright = await deepData(page);
  expect(bright.some((v) => v > 1.2)).toBe(true); // HDR headroom the 8-bit proxy shows as plain white
  await runAwait(page, 'image:adjust-exposure', { exposure: -1, offset: 0, gamma: 1 });
  await expect.poll(() => historyLength(page)).toBe(2);
  const darker = await deepData(page);
  await runAwait(page, 'edit:undo');
  expect(await deepData(page)).toEqual(bright);
  await runAwait(page, 'edit:redo');
  expect(await deepData(page)).toEqual(darker);
  expect(errors).toEqual([]);
});

test('a Duotone document saved as PSD opens looking as it did, and the save says the mode is not kept', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 80, height: 60 });
  await paint(page);
  await toDuotone(page, 1);
  // a second, translucent layer: the layers are written the way the mode shows them, not only a flat picture
  await runAwait(page, 'layer:duplicate');
  await runAwait(page, 'layer:opacity', 60);
  const shown = await compositeData(page);
  expect(shown[0] === shown[1] && shown[1] === shown[2] && shown[80] === shown[81] && shown[81] === shown[82]).toBe(false); // inks, not grey
  await page.evaluate(() => (window.__pigmentTest.nextSavePath = 'mem:/duo.psd'));
  await run(page, 'file:save-as');
  await written(page, 'mem:/duo.psd');
  await expect(page.locator('.toast', { hasText: 'PSD files are written as RGB' })).toHaveCount(1);
  await expect(page.locator('.toast', { hasText: 'Duotone mode' })).toHaveCount(1);
  await runAwait(page, 'file:save');
  await expect(page.locator('.toast', { hasText: 'PSD files are written as RGB' })).toHaveCount(1); // once per document
  await closeAll(page);
  await openPath(page, 'mem:/duo.psd');
  expect(await page.evaluate(() => ({ mode: window.pigmentApp.doc.mode, layers: window.pigmentApp.doc.layers().length }))).toEqual({ mode: 'rgb', layers: 2 });
  expect(maxDiff(await compositeData(page), shown)).toBeLessThanOrEqual(2);
  expect(errors).toEqual([]);
});

test('Merge Down, Merge Visible and Duplicate (merged) keep 16-bit samples and 32-bit highlights', async ({ page }) => {
  const errors = await openApp(page);
  await putFile(page, 'mem:/ramp16.png', await rampPng());
  await openPath(page, 'mem:/ramp16.png');
  const original = await deepData(page);
  expect((await deepStats(page)).distinct).toBe(4096);
  await runAwait(page, 'layer:new');
  await runAwait(page, 'layer:merge-down');
  expect(await deepStats(page)).toEqual({ distinct: 4096, over: 0, layers: 1 });
  expect(await deepData(page)).toEqual(original);
  // the merge is one undo step and the layers come back with their samples
  await runAwait(page, 'edit:undo');
  expect((await deepStats(page)).layers).toBe(2);
  expect(await deepData(page)).toEqual(original);
  await runAwait(page, 'edit:redo');
  expect(await deepStats(page)).toEqual({ distinct: 4096, over: 0, layers: 1 });
  await runAwait(page, 'layer:new');
  await runAwait(page, 'layer:merge-visible');
  expect(await deepStats(page)).toEqual({ distinct: 4096, over: 0, layers: 1 });
  await runAwait(page, 'image:duplicate', { name: 'copy', merged: true });
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.name)).toBe('copy');
  expect(await page.evaluate(() => window.pigmentApp.doc.depth)).toBe(16);
  expect(await deepData(page)).toEqual(original);

  // 32 bits: values above white survive the merges (they used to be clipped to 1.0)
  await closeAll(page);
  await newDoc(page, { width: 60, height: 40, depth: 32 });
  await paint(page);
  await runAwait(page, 'image:adjust-exposure', { exposure: 1, offset: 0, gamma: 1 });
  const before = await deepStats(page);
  expect(before.over).toBeGreaterThan(500);
  await runAwait(page, 'layer:new');
  await runAwait(page, 'layer:merge-visible');
  expect(await deepStats(page)).toEqual({ ...before, layers: 1 });
  await runAwait(page, 'layer:new');
  await runAwait(page, 'layer:merge-down');
  expect(await deepStats(page)).toEqual({ ...before, layers: 1 });
  expect(errors).toEqual([]);
});

test('damaged and truncated TIFF, TGA and GIF files are refused with an error instead of opening blank', async ({ page }) => {
  await openApp(page);
  const rgba = new Uint8ClampedArray(64 * 48 * 4);
  for (let i = 0; i < rgba.length; i++) rgba[i] = i % 4 === 3 ? 255 : (i * 37 + (i >> 3)) & 255;
  // a TIFF whose width field says 10 million pixels: it used to freeze the app and open a blank document
  const tiff = await encodeTiff({ width: 64, height: 48, channels: 4, depth: 8, data: new Uint8Array(rgba.buffer) }, { compression: 'deflate' });
  const huge = tiff.slice();
  const dv = new DataView(huge.buffer);
  const ifd = dv.getUint32(4, true);
  for (let i = 0; i < dv.getUint16(ifd, true); i++) {
    const e = ifd + 2 + i * 12;
    if (dv.getUint16(e, true) !== 256) continue;
    dv.setUint16(e + 2, 4, true);
    dv.setUint32(e + 8, 10616855, true);
  }
  const tga = encodeTga({ width: 64, height: 48, data: rgba }, { rle: true });
  const indices = new Uint8Array(64 * 48);
  for (let i = 0; i < indices.length; i++) indices[i] = (i * 7) % 4;
  const gif = encodeGif([{ indices, palette: [[0, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255]], transparentIndex: -1, delay: 0 }], 64, 48);
  const cases = [
    ['mem:/huge.tif', huge, /too large to open|truncated or damaged/],
    ['mem:/cut.tif', tiff.slice(0, Math.floor(tiff.length * 0.9)), /TIFF/],
    ['mem:/cut.tga', tga.slice(0, tga.length >> 1), /TGA file is truncated/],
    ['mem:/cut.gif', gif.slice(0, gif.length >> 1), /GIF file is truncated/],
  ];
  for (const [path, bytes, message] of cases) {
    await putFile(page, path, bytes);
    const t0 = Date.now();
    await runAwait(page, 'file:open-paths', [path]);
    await expect(page.locator('.toast.error').last()).toContainText(message);
    expect(Date.now() - t0, `${path} is refused quickly`).toBeLessThan(5000);
    expect(await page.evaluate(() => window.pigmentApp.docs.docs.length), `${path} opens no document`).toBe(0);
  }
  // the whole files still open
  await putFile(page, 'mem:/ok.tga', tga);
  await openPath(page, 'mem:/ok.tga');
  expect(await pixel(page, 10, 10)).toEqual(Array.from(rgba.subarray((10 * 64 + 10) * 4, (10 * 64 + 10) * 4 + 4)));
});

test('Place, Import Image, Open as Smart Object and Replace Contents read TIFF and TGA files', async ({ page }) => {
  const errors = await openApp(page);
  const rgba = new Uint8ClampedArray(40 * 30 * 4);
  for (let i = 0; i < rgba.length; i += 4) rgba.set([200, 40, 30, 255], i);
  await putFile(page, 'mem:/in.tif', await encodeTiff({ width: 40, height: 30, channels: 4, depth: 8, data: new Uint8Array(rgba.buffer) }, { compression: 'lzw' }));
  await putFile(page, 'mem:/in.tga', encodeTga({ width: 40, height: 30, data: rgba }, { rle: true }));
  for (const ext of ['tif', 'tga']) {
    const path = `mem:/in.${ext}`;
    await closeAll(page);
    await newDoc(page, { width: 80, height: 60 });
    const layers = () => page.evaluate(() => window.pigmentApp.doc.layers().map((l) => l.type));
    await runAwait(page, 'file:place', path);
    await expect.poll(layers).toEqual(['raster', 'smart']);
    expect(await pixel(page, 40, 30), `${ext} placed`).toEqual([200, 40, 30, 255]);
    await runAwait(page, 'file:import-image', path);
    await expect.poll(layers).toEqual(['raster', 'smart', 'raster']);
    await runAwait(page, 'file:open-smart', { paths: [path], into: 'active' });
    await expect.poll(layers).toEqual(['raster', 'smart', 'raster', 'smart']);
    // Replace Contents of a smart object made from the white background
    await page.evaluate(() => window.pigmentApp.doc.setActive(window.pigmentApp.doc.layers()[0]));
    for (const l of [3, 2, 1]) await page.evaluate((i) => window.pigmentApp.doc.remove(window.pigmentApp.doc.layers()[i]), l);
    await runAwait(page, 'layer:smart-convert');
    expect(await pixel(page, 40, 30)).toEqual([255, 255, 255, 255]);
    await runAwait(page, 'layer:smart-replace', path);
    // the new contents (40 x 30) start at the smart object's corner
    await expect.poll(() => pixel(page, 5, 5), `${ext} replaced the contents`).toEqual([200, 40, 30, 255]);
  }
  expect(errors).toEqual([]);
});

test('Duotone: Select and Mask output, Copy Merged + Paste, the eyedropper and Export Layers keep what is shown', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 80, height: 60 });
  await paint(page, 'ramp');
  await toDuotone(page, 2); // Cyanotype: a grey 128 shows as a blue
  const shown = await compositeData(page);
  const at = (data, x, y) => data.slice((y * 80 + x) * 4, (y * 80 + x) * 4 + 4);
  expect(at(shown, 40, 30)[2]).toBeGreaterThan(at(shown, 40, 30)[0] + 20);

  // Select and Mask > New Layer from all layers: the new layer holds stored greys, so nothing changes on screen
  await selectRect(page, { x: 20, y: 15, width: 40, height: 30 });
  await runAwait(page, 'select:select-mask', { output: 'layer', sampleAll: true, feather: 0 });
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.layers().length)).toBe(2);
  expect(maxDiff(await compositeData(page), shown)).toBe(0);
  await runAwait(page, 'edit:undo');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.layers().length)).toBe(1);

  // Copy Merged, Paste in Place
  await selectRect(page, { x: 20, y: 15, width: 40, height: 30 });
  await runAwait(page, 'edit:copy-merged');
  await runAwait(page, 'edit:paste-in-place');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.layers().length)).toBe(2);
  expect(maxDiff(await compositeData(page), shown)).toBe(0);
  // the merged copy itself is what the document shows (for other programs and RGB documents)
  expect(await page.evaluate(() => Array.from(window.pigmentApp.clipboard.canvas.getContext('2d').getImageData(20, 15, 1, 1).data))).toEqual(at(shown, 40, 30));
  await runAwait(page, 'edit:undo');

  // the eyedropper picks the stored grey: painting it back gives the colour that was clicked
  const picked = await page.evaluate(() => {
    const app = window.pigmentApp;
    app.tools.activate('eyedropper');
    app.tools.active.sampleAt({ x: 40.5, y: 30.5 });
    const l = app.doc.layers()[0];
    return { fg: app.settings.foreground, stored: Array.from(l.canvas.getContext('2d').getImageData(40, 30, 1, 1).data) };
  });
  const hex = (v) => v.toString(16).padStart(2, '0');
  expect(picked.fg.toLowerCase()).toBe(`#${hex(picked.stored[0])}${hex(picked.stored[1])}${hex(picked.stored[2])}`);

  // Export Layers to Files writes the layer in its inks, as Quick Export does
  await page.evaluate(() => (window.__pigmentTest.nextDirectory = 'mem:/layers'));
  await runAwait(page, 'file:export-layers', { format: 'png', visibleOnly: true, trim: false, prefix: 'L_', folder: 'mem:/layers' });
  const file = toRgba8(await decodePng(await written(page, 'mem:/layers/L_Background.png')));
  expect(maxDiff(Array.from(file.data), shown)).toBe(0);
  expect(errors).toEqual([]);
});

test('Select and Mask > New Document from a Multichannel document shows the picture, not white', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 80, height: 60 });
  await paint(page);
  await runAwait(page, 'image:mode', { mode: 'multichannel', silent: true, flatten: true });
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.mode)).toBe('multichannel');
  const shown = await pixel(page, 40, 30);
  expect(shown).not.toEqual([255, 255, 255, 255]);
  await selectRect(page, { x: 20, y: 15, width: 40, height: 30 });
  await runAwait(page, 'select:select-mask', { output: 'document', feather: 0 });
  await expect.poll(() => page.evaluate(() => window.pigmentApp.docs.docs.length)).toBe(2);
  const copy = await page.evaluate(() => ({ mode: window.pigmentApp.doc.mode, channels: window.pigmentApp.doc.channels.map((c) => c.name) }));
  expect(copy).toEqual({ mode: 'multichannel', channels: ['Cyan', 'Magenta', 'Yellow'] });
  expect(await pixel(page, 40, 30)).toEqual(shown);
  expect(errors).toEqual([]);
});

test('Export As PNG-8 and GIF from an Indexed Color document honour Transparency off and the Matte colour', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 64, height: 48, background: 'transparent' });
  await page.evaluate(() => {
    const d = window.pigmentApp.doc, l = d.active, c = l.canvas.getContext('2d');
    c.fillStyle = '#e02020';
    c.fillRect(8, 8, 30, 30);
    l.touch();
    d.changed('pixels', { layer: l });
  });
  await runAwait(page, 'image:mode', { mode: 'indexed', silent: true, flatten: true, options: { palette: 'adaptive', colors: 8, forced: 'none', transparency: true, matte: null, dither: 'none', ditherAmount: 0, preserveExactColors: false } });
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.mode)).toBe('indexed');
  expect((await pixel(page, 1, 1))[3]).toBe(0);
  const corner = async (path, opts) => {
    await runAwait(page, 'file:export', { path, format: 'png8', colors: 256, dither: 'none', ...opts });
    return Array.from(toRgba8(await decodePng(await written(page, path))).data.subarray(0, 4));
  };
  expect(await corner('mem:/idx-opaque.png', { transparency: false, matte: '#00ff00' })).toEqual([0, 255, 0, 255]);
  // with transparency the document's own table is kept and the corner stays clear
  expect((await corner('mem:/idx-clear.png', { transparency: true, matte: '#00ff00' }))[3]).toBe(0);
  await runAwait(page, 'file:export', { path: 'mem:/idx-opaque.gif', format: 'gif', colors: 256, dither: 'none', transparency: false, matte: '#00ff00' });
  await putFile(page, 'mem:/idx-opaque-copy.gif', await written(page, 'mem:/idx-opaque.gif'));
  await openPath(page, 'mem:/idx-opaque-copy.gif');
  expect(await pixel(page, 1, 1)).toEqual([0, 255, 0, 255]);
  expect(errors).toEqual([]);
});

test('saving a 16-bit document as GIF gives the 8-bit notice', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 40, height: 30, depth: 16 });
  await paint(page);
  await page.evaluate(() => window.pigmentApp.docs.writeTo(window.pigmentApp.doc, 'mem:/deep.gif', { copy: true }));
  await written(page, 'mem:/deep.gif');
  await expect(page.locator('.toast', { hasText: 'GIF files hold 8 bits/channel' })).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('Bitmap mode: an adjustment the mode takes back adds no history state; one that changes pixels does', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 80, height: 60 });
  await paint(page);
  await runAwait(page, 'image:mode', { mode: 'bitmap', silent: true, flatten: true });
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.mode)).toBe('bitmap');
  const steps = await historyLength(page);
  const before = await compositeData(page);
  await page.evaluate(() => window.pigmentApp.doc.history.markSaved());
  await runAwait(page, 'image:adjust-hue-saturation', { hue: 40, saturation: 20, lightness: 0, colorize: false, colorizeHue: 0, colorizeSat: 25, colorizeLight: 0, range: 'master' });
  await runAwait(page, 'image:adjust-levels', { perChannel: true, rgb: { inBlack: 0, inWhite: 255, gamma: 1.02, outBlack: 0, outWhite: 255 }, r: null, g: null, b: null });
  expect(maxDiff(await compositeData(page), before)).toBe(0);
  expect(await historyLength(page)).toBe(steps);
  expect(await page.evaluate(() => window.pigmentApp.doc.history.dirty)).toBe(false);
  await runAwait(page, 'image:adjust-invert');
  await expect.poll(() => historyLength(page)).toBe(steps + 1);
  expect(maxDiff(await compositeData(page), before)).toBe(255);
  expect(errors).toEqual([]);
});

test('a .pigment file with an unknown mode, or a mode that lost its colour table or channels, opens as RGB', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 40, height: 30 });
  await paint(page);
  const shown = await compositeData(page);
  await page.evaluate(async () => {
    const app = window.pigmentApp, files = window.__pigmentTest.files;
    await app.docs.writeTo(app.doc, 'mem:/src.pigment', { copy: true });
    const { readZip, writeZip, streamCodecs } = await import('/shared/zip.js');
    const entries = await readZip(files['mem:/src.pigment'], { inflate: streamCodecs.inflate });
    for (const [name, mode] of [['hsb', 'hsb'], ['indexed', 'indexed'], ['multichannel', 'multichannel']]) {
      const out = entries.map((e) => {
        if (e.name !== 'document.json') return { name: e.name, data: e.data };
        const d = JSON.parse(new TextDecoder().decode(e.data));
        d.mode = mode; // no colorTable, no meta.imageMode
        return { name: e.name, data: new TextEncoder().encode(JSON.stringify(d)), compress: true };
      });
      files[`mem:/${name}.pigment`] = await writeZip(out, { deflate: streamCodecs.deflate });
    }
  });
  for (const name of ['hsb', 'indexed', 'multichannel']) {
    await openPath(page, `mem:/${name}.pigment`);
    expect(await page.evaluate(() => window.pigmentApp.doc.mode), name).toBe('rgb');
    expect(maxDiff(await compositeData(page), shown), name).toBe(0);
  }
  expect(errors).toEqual([]);
});
