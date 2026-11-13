// Regressions found in the review of the 0.3.1 hunt fixes, group "depth, modes, files": deep samples after undo and
// redo over several entries, Image > Duplicate with layers kept, merges across groups and inside hidden groups at
// 16 bits, long strips as TIFF / TGA / 16-bit PNG, the eyedropper in the grey modes, the memory of deep undo
// patches, and a Grayscale document with a colouring adjustment layer saved as PSD.
import { test, expect } from '@playwright/test';
import { openApp, newDoc, run, runAwait } from './helpers.mjs';
import { encodePng } from '../../src/shared/pixels/png.js';

const putFile = (page, path, bytes) => page.evaluate(([p, b]) => (window.__pigmentTest.files[p] = new Uint8Array(b)), [path, Array.from(bytes)]);
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
  d.selection = r ? Selection.fromRect(d.width, d.height, r) : null;
  d.changed('selection');
}, rect);

/** A 256 x 16 grey ramp with 16-bit samples, as PNG. */
function rampPng() {
  const width = 256, height = 16;
  const data = new Uint16Array(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const v = Math.round(((x + y / height) / width) * 65535);
    data.set([v, v, v], (y * width + x) * 3);
  }
  return encodePng({ width, height, channels: 3, depth: 16, data }, {});
}

/** Paints a colourful picture into the active layer (setup, not an undo step). */
const paint = (page) => page.evaluate(() => {
  const app = window.pigmentApp, d = app.doc, l = d.active;
  const w = l.canvas.width, h = l.canvas.height;
  const img = new ImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) img.data.set([Math.round((x / (w - 1)) * 255), Math.round((y / (h - 1)) * 255), (x * 7 + y * 3) & 255, 255], (y * w + x) * 4);
  l.canvas.getContext('2d').putImageData(img, 0, 0);
  l.touch();
  d.changed('pixels', { layer: l });
  app.deep?.sync(d);
});
const compositeData = (page) => page.evaluate(() => {
  const d = window.pigmentApp.doc;
  return Array.from(d.view.compositor.composite(d).getContext('2d', { willReadFrequently: true }).getImageData(0, 0, d.width, d.height).data);
});
const maxDiff = (a, b) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), a.length === b.length ? 0 : Infinity);

/**
 * What the canvas shows, what the deep samples say (as 8-bit values) and what a 16-bit export would hold (the float
 * composite), at one pixel of the bottom layer. The sync pass has run, as it has before every save and export.
 */
const threeViews = (page, x, y) => page.evaluate(([px, py]) => {
  const app = window.pigmentApp, d = app.doc, l = d.layers()[0];
  app.deep.sync(d);
  const o = (py * l.canvas.width + px) * 4;
  const flat = app.deep.flatten(d);
  const fo = (py * flat.width + px) * 4;
  const to8 = (v) => Math.round(v / 257);
  return {
    shown: Array.from(l.canvas.getContext('2d', { willReadFrequently: true }).getImageData(px, py, 1, 1).data.slice(0, 3)),
    deep: Array.from(l.deep.data.subarray(o, o + 3)).map(to8),
    exported: Array.from(flat.data.subarray(fo, fo + 3)).map(to8),
  };
}, [x, y]);

test('16-bit: stepping back and forward over a selection-limited adjustment and a fill next to it keeps the deep samples in step', async ({ page }) => {
  const errors = await openApp(page);
  await putFile(page, 'mem:/ramp16.png', await rampPng());
  await openPath(page, 'mem:/ramp16.png');
  await page.evaluate(() => window.pigmentApp.setColors({ foreground: '#ff0000' }));
  const LEVELS = { perChannel: true, rgb: { inBlack: 0, inWhite: 255, gamma: 1.5, outBlack: 0, outWhite: 255 }, r: null, g: null, b: null };
  const levels = async () => {
    await selectRect(page, { x: 0, y: 0, width: 64, height: 16 });
    await runAwait(page, 'image:adjust-levels', LEVELS);
  };
  const fill = async () => {
    await selectRect(page, { x: 128, y: 0, width: 128, height: 16 });
    await runAwait(page, 'edit:fill-foreground');
  };
  const jump = (by) => page.evaluate((n) => {
    const h = window.pigmentApp.doc.history;
    h.goTo(h.index + n); // what a click in the History panel does: several entries in one go
  }, by);
  const RED = [255, 0, 0];
  const GREY = (await threeViews(page, 200, 8)).shown; // the ramp where the fill goes
  expect(GREY[0]).toBeGreaterThan(150);
  expect(GREY[1]).toBe(GREY[0]);
  const all = (c) => ({ shown: c, deep: c, exported: c });

  // Levels, then Fill: both undone at once (the fill's undo is still waiting for the sync pass when Levels is undone)
  await levels();
  await fill();
  expect(await threeViews(page, 200, 8)).toEqual(all(RED));
  await jump(-2);
  expect(await threeViews(page, 200, 8)).toEqual(all(GREY));
  // ... and both redone at once
  await jump(2);
  expect(await threeViews(page, 200, 8)).toEqual(all(RED));
  // the adjustment's own rect came back exactly both times (the reason its entry carries deep patches)
  const lit = await threeViews(page, 30, 8);
  expect(lit.deep).toEqual(lit.shown);
  await jump(-2);

  // Fill, then Levels: the redo of both is where the fill used to go missing from the samples
  await fill();
  await levels();
  await jump(-2);
  expect(await threeViews(page, 200, 8)).toEqual(all(GREY));
  await jump(2);
  expect(await threeViews(page, 200, 8)).toEqual(all(RED));
  expect(errors).toEqual([]);
});

test('16/32-bit: Image > Duplicate with its layers kept is an exact copy (mask, hidden pixels, opacity)', async ({ page }) => {
  const errors = await openApp(page);
  for (const depth of [16, 32]) {
    await closeAll(page);
    await newDoc(page, { width: 120, height: 80, depth });
    await paint(page);
    // a mask that hides a small corner, and a layer at half opacity: the composite is not what the layer holds
    await selectRect(page, { x: 10, y: 10, width: 12, height: 12 });
    await runAwait(page, 'layer:mask', 'hide-selection');
    await selectRect(page, null);
    await runAwait(page, 'layer:opacity', 50);
    const state = () => page.evaluate(() => {
      const app = window.pigmentApp, d = app.doc, l = d.layers()[0];
      app.deep.sync(d);
      const o = (15 * l.canvas.width + 15) * 4;
      return {
        name: d.name,
        depth: d.depth,
        layers: d.layers().length,
        opacity: l.opacity,
        mask: !!l.mask?.enabled,
        hiddenPixel: Array.from(l.canvas.getContext('2d', { willReadFrequently: true }).getImageData(15, 15, 1, 1).data),
        hiddenDeep: Array.from(l.deep.data.subarray(o, o + 4)),
        visiblePixel: Array.from(l.canvas.getContext('2d', { willReadFrequently: true }).getImageData(60, 40, 1, 1).data),
      };
    });
    const original = await state();
    expect(original.hiddenPixel[3]).toBe(255);
    const shown = await compositeData(page);
    await runAwait(page, 'image:duplicate', { name: 'copy', merged: false });
    await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.name)).toBe('copy');
    expect(await state()).toEqual({ ...original, name: 'copy' });
    expect(maxDiff(await compositeData(page), shown)).toBe(0);
  }
  expect(errors).toEqual([]);
});

/** Document for the merge tests: a painted Background, a group G holding layer A (a small red square), layer B at the root. */
const groupedDoc = (page, depth, group) => page.evaluate(async ([bits, g]) => {
  const app = window.pigmentApp;
  const { RasterLayer, GroupLayer, createCanvas } = await import('/lib/document.js');
  for (const d of app.docs.docs.slice()) await app.docs.close(d, { force: true });
  const doc = app.newDocument({ width: 100, height: 100, name: 'merge', depth: bits });
  const bg = doc.active.canvas.getContext('2d');
  const grad = bg.createLinearGradient(0, 0, 100, 100);
  grad.addColorStop(0, '#102040');
  grad.addColorStop(1, '#e0c060');
  bg.fillStyle = grad;
  bg.fillRect(0, 0, 100, 100);
  doc.active.touch();
  const G = new GroupLayer({ name: 'G', opacity: g.opacity ?? 1 });
  doc.add(G, doc.root);
  if (g.hidden) G.visible = false;
  if (g.masked) {
    const m = createCanvas(100, 100);
    const mc = m.getContext('2d');
    mc.fillStyle = '#fff';
    mc.fillRect(50, 0, 50, 100); // the left half, where A's square is, is hidden
    G.mask = { canvas: m, enabled: true, linked: true };
  }
  const rect = (name, parent, color, x, y) => {
    const l = new RasterLayer({ name, width: 100, height: 100 });
    doc.add(l, parent);
    const c = l.canvas.getContext('2d');
    c.fillStyle = color;
    c.fillRect(x, y, 12, 12);
    l.touch();
    return l;
  };
  const A = rect('A', G, '#ff0000', 20, 20);
  const B = rect('B', doc.root, '#0000ff', 70, 70);
  doc.selected = new Set(g.down ? [A] : [A, B]);
  doc.active = g.down ? rect('A2', G, '#00ff00', 40, 40) : B;
  if (g.down) doc.selected = new Set([doc.active]);
  doc.changed('tree');
  app.deep?.sync(doc);
}, [depth, group]);
const layerNames = (page) => page.evaluate(() => window.pigmentApp.doc.layers().map((l) => l.name));

test('16-bit Merge Layers across groups shows the same picture as before, like the 8-bit merge', async ({ page }) => {
  const errors = await openApp(page);
  for (const depth of [8, 16]) {
    for (const group of [{ opacity: 0.5 }, { masked: true }]) {
      await groupedDoc(page, depth, group);
      const before = await compositeData(page);
      await runAwait(page, 'layer:merge-selected');
      expect(await layerNames(page), `${depth} bits, ${JSON.stringify(group)}`).toEqual(['Background', 'G', 'B']);
      // A's square was drawn at half strength, or not at all: merged at full strength it would be far off
      expect(maxDiff(await compositeData(page), before), `${depth} bits, ${JSON.stringify(group)}`).toBeLessThanOrEqual(2);
      if (depth > 8) {
        // the merged layer's samples describe its canvas
        const off = await page.evaluate(() => {
          const app = window.pigmentApp, d = app.doc, l = d.active;
          app.deep.sync(d);
          const px = l.canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, l.canvas.width, l.canvas.height).data;
          let n = 0;
          for (let i = 3; i < px.length; i += 4) if (Math.abs(Math.round(l.deep.data[i] / 257) - px[i]) > 1) n++;
          return n;
        });
        expect(off).toBe(0);
      }
      await runAwait(page, 'edit:undo');
      expect(await layerNames(page)).toEqual(['Background', 'G', 'A', 'B']);
      expect(maxDiff(await compositeData(page), before)).toBe(0);
    }
  }
  expect(errors).toEqual([]);
});

test('layers inside a hidden group are not merged into an empty layer: the merge is refused', async ({ page }) => {
  const errors = await openApp(page);
  for (const depth of [8, 16]) {
    // Merge Layers of a layer in a hidden group and a root layer
    await groupedDoc(page, depth, { hidden: true });
    await runAwait(page, 'layer:merge-selected');
    expect(await layerNames(page)).toEqual(['Background', 'G', 'A', 'B']);
    // Merge Down of two layers inside the hidden group
    await groupedDoc(page, depth, { hidden: true, down: true });
    const steps = await page.evaluate(() => window.pigmentApp.doc.history.entries.length);
    await runAwait(page, 'layer:merge-down');
    expect(await layerNames(page)).toEqual(['Background', 'G', 'A', 'A2', 'B']);
    expect(await page.evaluate(() => window.pigmentApp.doc.history.entries.length)).toBe(steps);
    const kept = await page.evaluate(() => {
      const [, , a, a2] = window.pigmentApp.doc.layers();
      const at = (l, x, y) => Array.from(l.canvas.getContext('2d', { willReadFrequently: true }).getImageData(x, y, 1, 1).data);
      return [at(a, 25, 25), at(a2, 45, 45)];
    });
    expect(kept).toEqual([[255, 0, 0, 255], [0, 255, 0, 255]]);
    await expect(page.locator('.toast', { hasText: 'Hidden layers cannot be merged' }).first()).toBeVisible();
    // shown again, the same Merge Down works and keeps the pixels
    await page.evaluate(() => {
      const d = window.pigmentApp.doc;
      d.layers()[1].visible = true;
      d.changed('tree');
    });
    await runAwait(page, 'layer:merge-down');
    expect(await layerNames(page)).toEqual(['Background', 'G', 'A', 'B']);
    const merged = await page.evaluate(() => {
      const l = window.pigmentApp.doc.layers()[2];
      const at = (x, y) => Array.from(l.canvas.getContext('2d', { willReadFrequently: true }).getImageData(x - l.x, y - l.y, 1, 1).data);
      return [at(25, 25), at(45, 45)];
    });
    expect(merged).toEqual([[255, 0, 0, 255], [0, 255, 0, 255]]);
  }
  expect(errors).toEqual([]);
});

test('a strip wider than 32767 px opens as TIFF, TGA and 16-bit PNG, like the same picture as 8-bit PNG', async ({ page }) => {
  const errors = await openApp(page);
  // encoded in the page: the files are small, their pixel arrays are not
  await page.evaluate(async () => {
    const { encodePng } = await import('/shared/pixels/png.js');
    const { encodeTiff } = await import('/shared/pixels/tiff.js');
    const { encodeTga } = await import('/shared/pixels/tga.js');
    const W = 33000, H = 4;
    const rgb8 = new Uint8Array(W * H * 3).fill(200);
    const rgb16 = new Uint16Array(W * H * 3).fill(40000);
    const rgba = new Uint8ClampedArray(W * H * 4).fill(255);
    const files = window.__pigmentTest.files;
    files['mem:/strip16.png'] = await encodePng({ width: W, height: H, channels: 3, depth: 16, data: rgb16 }, {});
    files['mem:/strip.tif'] = await encodeTiff({ width: W, height: H, channels: 3, depth: 8, data: rgb8 }, { compression: 'lzw' });
    files['mem:/strip.tga'] = encodeTga({ width: W, height: H, data: rgba }, { rle: true });
  });
  for (const [path, depth, value] of [['mem:/strip16.png', 16, 156], ['mem:/strip.tif', 8, 200], ['mem:/strip.tga', 8, 255]]) {
    await openPath(page, path);
    const got = await page.evaluate(() => {
      const d = window.pigmentApp.doc, l = d.layers()[0];
      return { size: `${d.width}x${d.height}`, depth: d.depth ?? 8, px: Array.from(l.canvas.getContext('2d', { willReadFrequently: true }).getImageData(32990, 2, 1, 1).data) };
    });
    expect(got, path).toEqual({ size: '33000x4', depth, px: [value, value, value, 255] });
    await closeAll(page);
  }
  expect(errors).toEqual([]);
});

test('the eyedropper in a Grayscale or Duotone document composites only the pixels it samples, and picks the stored colour', async ({ page }) => {
  const errors = await openApp(page);
  for (const mode of ['grayscale', 'duotone']) {
    await closeAll(page);
    await newDoc(page, { width: 300, height: 200 });
    await paint(page);
    await runAwait(page, 'image:mode', { mode: 'grayscale', silent: true, flatten: true });
    if (mode === 'duotone') {
      await page.evaluate(async () => {
        const { DUOTONE_PRESETS } = await import('/shared/pixels/modes.js');
        await window.pigmentApp.commands.run('image:mode', { mode: 'duotone', silent: true, options: { duotone: DUOTONE_PRESETS[2] } }, 'api');
      });
    }
    await runAwait(page, 'layer:new-adjustment', { kind: 'levels', params: { perChannel: false, rgb: { inBlack: 10, inWhite: 240, gamma: 1.3, outBlack: 0, outWhite: 255 } } });
    await runAwait(page, 'layer:new');
    const res = await page.evaluate(async () => {
      const app = window.pigmentApp, doc = app.doc;
      const { flattenStored } = await import('/lib/compositor.js');
      const tool = app.tools.get('eyedropper');
      app.tools.activate('eyedropper');
      const stored = flattenStored(doc, doc.view.compositor).getContext('2d', { willReadFrequently: true });
      // the average the tool takes (3 x 3 by default), from the whole stored composite
      const expected = (x, y) => {
        const x1 = Math.max(0, x - 1), y1 = Math.max(0, y - 1), x2 = Math.min(doc.width, x + 2), y2 = Math.min(doc.height, y + 2);
        const d = stored.getImageData(x1, y1, x2 - x1, y2 - y1).data;
        const sum = [0, 0, 0];
        for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) sum[c] += d[i + c];
        return sum.map((v) => Math.round(v / (d.length / 4)));
      };
      // every composite the tool asks for, by the number of pixels composited
      const compositor = doc.view.compositor;
      const composite = compositor.composite.bind(compositor);
      const areas = [];
      compositor.composite = (d, opts = {}) => {
        areas.push(opts.rect ? opts.rect.width * opts.rect.height : d.width * d.height);
        return composite(d, opts);
      };
      const out = { samples: [], areas };
      try {
        for (const [x, y] of [[150, 100], [40, 160], [0, 0], [299, 199]]) {
          const c = tool.sampleAt({ x: x + 0.5, y: y + 0.5 });
          out.samples.push({ got: c && c.slice(0, 3).map(Math.round), want: expected(x, y) });
        }
        out.outside = tool.sampleAt({ x: 400, y: 100 });
      } finally {
        compositor.composite = composite;
      }
      return out;
    });
    for (const s of res.samples) expect(s.got, mode).toEqual(s.want);
    expect(res.outside, mode).toBeNull();
    // a full composite of the document on every pointer move made dragging crawl on large documents
    expect(res.areas.length, mode).toBe(4);
    expect(Math.max(...res.areas), mode).toBeLessThanOrEqual(9);
  }
  expect(errors).toEqual([]);
});

test('deep undo patches count against the history memory, and Purge and Close let the last pixel edit go', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 200, height: 200, depth: 16 });
  await paint(page);
  // one Invert of this layer holds 320 kB of 8-bit pixels and 640 kB of 16-bit patches: room for two of them
  const MB = 1024 * 1024;
  await page.evaluate((limit) => (window.pigmentApp.doc.history.memoryLimit = limit), 2.5 * MB);
  const history = () => page.evaluate(() => {
    const h = window.pigmentApp.doc.history;
    return { entries: h.entries.length, bytes: h.entries.reduce((n, e) => n + (e.bytes ?? 0), 0), index: h.index };
  });
  for (let i = 0; i < 4; i++) {
    await runAwait(page, 'image:adjust-invert');
    const h = await history();
    expect(h.bytes, `after Invert ${i + 1}`).toBeLessThanOrEqual(2.5 * MB);
    expect(h.entries).toBe(Math.min(i + 1, 2));
    expect(h.index).toBe(h.entries - 1);
  }
  // the states that are left still undo exactly
  const before = await compositeData(page);
  await runAwait(page, 'edit:undo');
  await runAwait(page, 'edit:redo');
  expect(maxDiff(await compositeData(page), before)).toBe(0);

  const last = () => page.evaluate(() => (window.pigmentApp.lastPixelEdit ? window.pigmentApp.lastPixelEdit.label : null));
  expect(await last()).toBe('Invert');
  expect(await page.evaluate(() => window.pigmentApp.commands.isEnabled?.('edit:fade') ?? true)).toBe(true);
  await runAwait(page, 'edit:purge', { what: 'undo', confirm: false });
  expect(await last()).toBeNull();
  // a new edit after an undo replaces the entry: the old one cannot be faded any more and is dropped
  await runAwait(page, 'image:adjust-invert');
  expect(await last()).toBe('Invert');
  await runAwait(page, 'edit:undo');
  expect(await last()).toBe('Invert'); // still in the history: a redo makes it the current state again
  await runAwait(page, 'layer:new');
  expect(await last()).toBeNull();
  // closing the document frees the record as well
  await runAwait(page, 'layer:delete');
  await runAwait(page, 'image:adjust-invert');
  expect(await last()).toBe('Invert');
  await closeAll(page);
  expect(await last()).toBeNull();
  expect(errors).toEqual([]);
});

test('a Grayscale document with a colouring adjustment layer saved as PSD opens grey, as it looked', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 80, height: 60 });
  await paint(page);
  await runAwait(page, 'image:mode', { mode: 'grayscale', silent: true, flatten: false });
  await runAwait(page, 'layer:new-adjustment', { kind: 'photo-filter', params: { color: '#ec8a00', density: 80, preserveLuminosity: false } });
  const shown = await compositeData(page);
  expect(shown[40] === shown[41] && shown[41] === shown[42]).toBe(true); // the mode shows grey
  await page.evaluate(() => (window.__pigmentTest.nextSavePath = 'mem:/grey.psd'));
  await run(page, 'file:save-as');
  await expect.poll(() => page.evaluate(() => !!window.__pigmentTest.written['mem:/grey.psd'])).toBe(true);
  await closeAll(page);
  await openPath(page, 'mem:/grey.psd');
  // the layers are all there, with the mode's grey as a Channel Mixer on top of them
  expect(await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    return { mode: d.mode ?? 'rgb', layers: d.layers().map((l) => (l.type === 'adjustment' ? l.kind : l.type)), mono: d.layers().at(-1).params?.monochrome };
  })).toEqual({ mode: 'rgb', layers: ['raster', 'photo-filter', 'channel-mixer'], mono: true });
  expect(maxDiff(await compositeData(page), shown)).toBeLessThanOrEqual(2);
  expect(errors).toEqual([]);
});

test('a Duotone document with a translucent layer over another saved as PSD opens as it looked, layers kept', async ({ page }) => {
  const errors = await openApp(page);
  for (const two of [false, true]) {
    await closeAll(page);
    await newDoc(page, { width: 120, height: 80 });
    await paint(page);
    await runAwait(page, 'image:mode', { mode: 'grayscale', silent: true, flatten: true });
    await page.evaluate(async () => {
      const { DUOTONE_PRESETS } = await import('/shared/pixels/modes.js');
      await window.pigmentApp.commands.run('image:mode', { mode: 'duotone', silent: true, options: { duotone: DUOTONE_PRESETS[2] } }, 'api');
    });
    if (two) {
      await runAwait(page, 'layer:new');
      await page.evaluate(() => {
        const d = window.pigmentApp.doc, l = d.active;
        const c = l.canvas.getContext('2d');
        c.fillStyle = '#202020';
        c.fillRect(20, 20, 60, 40);
        l.opacity = 0.5;
        l.touch();
        d.changed('pixels', { layer: l });
      });
    }
    const shown = await compositeData(page);
    const path = `mem:/duo${two ? 2 : 1}.psd`;
    await page.evaluate((p) => (window.__pigmentTest.nextSavePath = p), path);
    await run(page, 'file:save-as');
    await expect.poll(() => page.evaluate((p) => !!window.__pigmentTest.written[p], path)).toBe(true);
    await closeAll(page);
    await openPath(page, path);
    const layers = await page.evaluate(() => window.pigmentApp.doc.layers().map((l) => (l.type === 'adjustment' ? l.kind : l.type)));
    // one layer is written through the inks; layers that meet keep their greys under a Gradient Map of the inks
    expect(layers).toEqual(two ? ['raster', 'raster', 'gradient-map'] : ['raster']);
    // inked layer by layer, the 50 % layer was up to 15 levels off where it covers the other
    expect(maxDiff(await compositeData(page), shown), `two layers: ${two}`).toBeLessThanOrEqual(1);
  }
  expect(errors).toEqual([]);
});
