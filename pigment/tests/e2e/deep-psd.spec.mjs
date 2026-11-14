// Clipping masks in 16/32-bit documents (lib/depth.js planFlatten / flattenDeep with pixels/deep.js clipGroupDeep):
// the float composite of a clipping group matches the 8-bit one and keeps the extra bits through Merge Clipping Mask,
// Merge Down onto the base, Merge Visible, Stamp Visible and Flatten Image, with Blend Clipped Layers as Group on and
// off. And the Gradient Map's interpolation method through PSD (Classic, Perceptual, Linear, Smooth), with the
// vendored ag-psd's grdm fix (scripts/vendor-entries/ag-psd-grdm.js).
import { test, expect } from '@playwright/test';
import { openApp, newDoc, runAwait } from './helpers.mjs';

/**
 * A clipping scene in a new deep document: a 16-bit grey-blue ramp, a disc 'base' with a slow 16-bit gradient
 * (soft-edged, or hard with `hard`), 'c1' (Multiply, 70 %) and 'c2' (Screen, fill 60 %) clipped to it, an optional
 * clipped adjustment layer and a translucent 'top' layer. `q8` keeps every sample on an 8-bit level (then the float
 * and the canvas composite have the same inputs). Layer fields come from `o.base`, `o.c1`, `o.c2`.
 */
const scene = (page, o = {}) => page.evaluate(async (o) => {
  const app = window.pigmentApp;
  const { RasterLayer, AdjustmentLayer, GroupLayer } = await import('/lib/document.js');
  const W = 96, H = 64;
  app.newDocument({ width: W, height: H, name: 'clip', depth: o.depth ?? 16 });
  const d = app.doc;
  const type = d.depth === 32 ? 'f32' : 'u16';
  const add = (name, fn, extra = {}) => {
    const l = new RasterLayer({ name, width: W, height: H, x: 0, y: 0, ...extra });
    const data = type === 'f32' ? new Float32Array(W * H * 4) : new Uint16Array(W * H * 4);
    const img = new ImageData(W, H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let v = fn(x, y);
      if (!v) continue;
      if (o.q8) v = v.map((c) => Math.round(Math.max(0, Math.min(1, c)) * 255) / 255);
      for (let c = 0; c < 4; c++) {
        const i = (y * W + x) * 4 + c;
        data[i] = type === 'f32' ? v[c] : Math.round(Math.max(0, Math.min(1, v[c])) * 65535);
        img.data[i] = Math.round(Math.max(0, Math.min(1, v[c])) * 255);
      }
    }
    d.add(l);
    l.deep = { type, data };
    l.canvas.getContext('2d').putImageData(img, 0, 0);
    l.touch();
    return l;
  };
  for (const l of d.layers()) d.remove(l);
  add('ramp', (x) => [(x / (W - 1)) * 0.6 + 0.2, 0.5, 1 - x / (W - 1), 1]);
  add('base', (x, y) => {
    const r = Math.hypot(x - 48, y - 32);
    const a = o.hard ? (r < 24 ? 1 : 0) : Math.max(0, Math.min(1, (26 - r) / 6));
    return a > 0 ? [0.3 + (y / (H - 1)) * 0.004 * (o.hdr ?? 1), 0.6, 0.2 + (x / (W - 1)) * 0.003, a] : null;
  }, o.base ?? {});
  add('c1', (x, y) => (x > 30 ? [0.9, 0.2 + x / 400, 0.4, y > 20 ? 1 : 0.5] : null), { clip: true, blend: 'multiply', opacity: 0.7, ...(o.c1 ?? {}) });
  add('c2', (x, y) => (y < 40 ? [0.1, 0.8, 0.9 - y / 200, 0.8] : null), { clip: true, blend: 'screen', fillOpacity: 0.6, ...(o.c2 ?? {}) });
  if (o.adjust) d.add(new AdjustmentLayer({ name: 'adj', kind: o.adjust.kind, params: o.adjust.params ?? {}, opacity: o.adjust.opacity ?? 1, clip: true }));
  add('top', (x, y) => (x < 20 && y < 20 ? [1, 1, 0, 0.5] : null));
  for (const n of o.remove ?? []) d.remove(d.layers().find((l) => l.name === n));
  if (o.group) {
    // the base inside a Normal group at 80 % (the group is the base), or 'c1' inside a clipped Pass Through group
    const l = d.layers().find((x) => x.name === o.group);
    const g = new GroupLayer(o.group === 'base' ? { name: 'G', blend: 'normal', opacity: 0.8 } : { name: 'G', clip: true, opacity: 0.6 });
    const i = d.root.children.indexOf(l);
    d.remove(l);
    l.clip = false;
    d.add(g, d.root, i);
    d.add(l, g, 0);
  }
  if (o.mask) {
    const m = document.createElement('canvas');
    m.width = W;
    m.height = H;
    const g = m.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#000';
    g.fillRect(0, 0, 50, 30);
    g.fillStyle = '#808080';
    g.fillRect(50, 30, 46, 34);
    const target = d.layers().find((l) => l.name === o.mask);
    target.mask = { canvas: m, enabled: true, linked: true };
    target.touch();
  }
  d.setActive(d.layers().find((l) => l.name === (o.active ?? 'top')));
  d.history.clear?.();
  d.changed('tree');
  app.deep.sync(d);
}, o);

/**
 * The float flatten against the 8-bit composite: the largest difference in 8-bit levels of what a pixel shows
 * (premultiplied colour and alpha), with the float samples rounded the way the proxy rounds them.
 */
const compare = (page) => page.evaluate(() => {
  const app = window.pigmentApp, d = app.doc;
  const f = app.deep.flatten(d);
  const comp = d.view.compositor.composite(d).getContext('2d', { willReadFrequently: true }).getImageData(0, 0, d.width, d.height).data;
  const one = f.type === 'f32' ? 1 : 65535;
  const q = (v) => Math.round(Math.min(1, Math.max(0, v / one)) * 255) / 255;
  let max = 0;
  for (let p = 0; p < comp.length; p += 4) {
    const af = q(f.data[p + 3]), a8 = comp[p + 3] / 255;
    for (let c = 0; c < 4; c++) {
      const vf = c === 3 ? af : q(f.data[p + c]) * af, v8 = c === 3 ? a8 : (comp[p + c] / 255) * a8;
      max = Math.max(max, Math.abs(vf - v8) * 255);
    }
  }
  return { exact: f.exact, reason: f.reason, max: Math.round(max * 100) / 100 };
});

/** Per layer: how many samples say more than 8 bits can (u16: not a multiple of 257; f32: not k / 255 or above 1). */
const precision = (page) => page.evaluate(() => {
  const app = window.pigmentApp, d = app.doc;
  app.deep.sync(d);
  const out = {};
  for (const l of d.layers()) {
    if (!l.deep) continue;
    let n = 0, over = 0;
    for (let i = 0; i < l.deep.data.length; i++) {
      const v = l.deep.data[i];
      if (l.deep.type === 'f32') {
        if (v > 1) over++;
        if (Math.abs(v * 255 - Math.round(v * 255)) > 1e-3) n++;
      } else if (v % 257) n++;
    }
    out[l.name] = l.deep.type === 'f32' ? { n, over } : n;
  }
  return out;
});
const composite = (page) => page.evaluate(() => {
  const d = window.pigmentApp.doc;
  return Array.from(d.view.compositor.composite(d).getContext('2d', { willReadFrequently: true }).getImageData(0, 0, d.width, d.height).data);
});
const maxDiff = (a, b) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};
const names = (page) => page.evaluate(() => window.pigmentApp.doc.layers().map((l) => `${l.name}${l.clip ? '*' : ''}`));

test('clipping masks composite in float: the 8-bit picture to within a level, for every clipping setup', async ({ page }) => {
  const errors = await openApp(page);
  // samples on 8-bit levels and a hard-edged base: both composites have the same inputs, only rounding differs
  const hard = { hard: true, q8: true };
  for (const o of [
    { ...hard, remove: ['c2', 'top'], c1: { blend: 'normal' } },
    { ...hard },
    { ...hard, adjust: { kind: 'invert', opacity: 0.6 } },
    { ...hard, mask: 'base', base: { opacity: 0.6, fillOpacity: 0.8, blend: 'multiply' } },
    { ...hard, mask: 'c1' },
    { ...hard, base: { blending: { clippedAsGroup: false }, fillOpacity: 0.5 }, adjust: { kind: 'invert', opacity: 0.7 } },
    { ...hard, depth: 32 },
  ]) {
    await scene(page, o);
    expect(await page.evaluate(() => window.pigmentApp.deep.plan().exact), JSON.stringify(o)).toBe(true);
    const r = await compare(page);
    expect(r.exact).toBe(true);
    expect(r.max, JSON.stringify(o)).toBeLessThanOrEqual(1);
  }
  // soft edges and 16-bit inputs: the canvas rounds a translucent base and each blend step at 8 bits, as it does for
  // layers that are not clipped (Merge Down's adopt check allows 3 levels)
  // (a Levels gamma steepens the darks: the 8-bit rounding of its input grows with it)
  const levels = { kind: 'levels', params: { rgb: { inBlack: 0, inWhite: 255, gamma: 1.6, outBlack: 0, outWhite: 255 } } };
  for (const o of [{}, { base: { blending: { clippedAsGroup: false } } }, { depth: 32, mask: 'base' }, { adjust: levels }, { adjust: levels, base: { blending: { clippedAsGroup: false } } }]) {
    await scene(page, o);
    const r = await compare(page);
    expect(r.exact).toBe(true);
    expect(r.max, JSON.stringify(o)).toBeLessThanOrEqual(3);
  }
  // groups as the base and as a clipped layer composite their layers on their own first; the group's opacity is
  // one more 8-bit rounding on the canvas
  for (const group of ['base', 'c1']) {
    await scene(page, { ...hard, group });
    const r = await compare(page);
    expect(r.exact, group).toBe(true);
    expect(r.max, group).toBeLessThanOrEqual(2);
  }
  // what stays at 8 bits says why
  await scene(page, { c1: { blend: 'overlay' } });
  expect(await page.evaluate(() => window.pigmentApp.deep.plan())).toEqual({ exact: false, reason: '“c1” uses the overlay blend mode' });
  expect(errors).toEqual([]);
});

test('Merge Clipping Mask keeps the 16-bit samples of a clipping group, as one undo step', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await scene(page, { active: 'base' });
  const before = await precision(page);
  expect(before.base).toBeGreaterThan(1000);
  const shown = await composite(page);
  const baseDeep = await page.evaluate(() => Array.from(window.pigmentApp.doc.layers().find((l) => l.name === 'base').deep.data));
  // Ctrl+E on a clipping base is Merge Clipping Mask
  await runAwait(page, 'layer:merge');
  expect(await names(page)).toEqual(['ramp', 'base', 'top']);
  const after = await precision(page);
  expect(after.base).toBeGreaterThan(1000); // through 8 bits it would be 0
  expect(maxDiff(await composite(page), shown)).toBeLessThanOrEqual(2);
  await runAwait(page, 'edit:undo');
  expect(await names(page)).toEqual(['ramp', 'base', 'c1*', 'c2*', 'top']);
  expect(await page.evaluate(() => Array.from(window.pigmentApp.doc.layers().find((l) => l.name === 'base').deep.data))).toEqual(baseDeep);
  await runAwait(page, 'edit:redo');
  expect((await precision(page)).base).toBe(after.base);
  // Blend Clipped Layers as Group off, and a base whose Blend If stays live on the result
  for (const base of [{ blending: { clippedAsGroup: false } }, { blending: { blendIf: { gray: { this: [0, 0, 255, 255], under: [30, 60, 255, 255] } } } }]) {
    await scene(page, { active: 'base', base });
    await runAwait(page, 'layer:merge-clipping');
    expect(await names(page)).toEqual(['ramp', 'base', 'top']);
    expect((await precision(page)).base, JSON.stringify(base)).toBeGreaterThan(1000);
  }
  // 32 bits: highlights above white in the base survive the merge
  await scene(page, { active: 'base', depth: 32, hdr: 600, remove: ['c1'] });
  const hdr = (await precision(page)).base.over;
  expect(hdr).toBeGreaterThan(100);
  await runAwait(page, 'layer:merge-clipping');
  expect(await names(page)).toEqual(['ramp', 'base', 'top']);
  expect((await precision(page)).base.over).toBeGreaterThan(100);
  expect(errors).toEqual([]);
});

test('Merge Down onto a clipping base, Merge Visible, Stamp Visible and Flatten Image keep the extra bits', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  const cases = [
    ['layer:merge-down', 'c1', ['ramp', 'base', 'c2*', 'top'], 'base'],
    ['layer:merge-visible', 'top', ['ramp'], 'ramp'],
    ['layer:stamp-visible', 'top', ['ramp', 'base', 'c1*', 'c2*', 'top', 'Layer 1'], 'Layer 1'],
    ['image:flatten', 'top', ['Background'], 'Background'],
  ];
  for (const [cmd, active, layers, result] of cases) {
    await scene(page, { active });
    const shown = await composite(page);
    await runAwait(page, cmd);
    expect(await names(page), cmd).toEqual(layers);
    expect((await precision(page))[result], cmd).toBeGreaterThan(1000);
    expect(maxDiff(await composite(page), shown), cmd).toBeLessThanOrEqual(2);
  }
  // Stamp Layers: several selected layers stamped on a new layer, and one layer stamped down into its base
  await scene(page, { active: 'c2' });
  await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    d.selected.clear();
    for (const l of d.layers()) if (['base', 'c1', 'c2'].includes(l.name)) d.selected.add(l);
  });
  await runAwait(page, 'layer:stamp-selected');
  expect(await names(page)).toEqual(['ramp', 'base', 'c1*', 'c2*', 'c2 (merged)', 'top']);
  expect((await precision(page))['c2 (merged)']).toBeGreaterThan(1000);
  await scene(page, { active: 'c1' });
  await runAwait(page, 'layer:stamp-selected');
  expect(await names(page)).toEqual(['ramp', 'base', 'c1*', 'c2*', 'top']);
  expect((await precision(page)).base).toBeGreaterThan(1000);
  expect(errors).toEqual([]);
});

test('a Gradient Map keeps its interpolation method through PSD, written with the codes Photoshop reads', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 120, height: 40, background: 'white' });
  const out = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { RasterLayer, createCanvas } = await import('/lib/document.js');
    const { writePsdDocument, readPsdDocument } = await import('/lib/io.js');
    const { readPsd, grdmPatched } = await import('ag-psd');
    const d = app.doc;
    const c = createCanvas(d.width, d.height);
    const g = c.getContext('2d');
    const gr = g.createLinearGradient(0, 0, d.width, 0);
    gr.addColorStop(0, '#000');
    gr.addColorStop(1, '#fff');
    g.fillStyle = gr;
    g.fillRect(0, 0, d.width, d.height);
    d.add(new RasterLayer({ name: 'Ramp', canvas: c, x: 0, y: 0 }));
    const read = (doc) => (doc.view?.compositor ?? app.view.compositor).composite(doc).getContext('2d').getImageData(0, 0, doc.width, doc.height).data;
    const res = { grdmPatched };
    for (const interpolation of ['classic', 'perceptual', 'linear', 'smooth']) {
      const def = { gradientVersion: 2, type: 'solid', interpolation, smoothness: 1, stops: [{ pos: 0, mid: 0.5, color: '#0020ff' }, { pos: 1, mid: 0.5, color: '#ffd000' }], opacityStops: [{ pos: 0, mid: 0.5, opacity: 1 }, { pos: 1, mid: 0.5, opacity: 1 }] };
      await app.commands.run('layer:new-adjustment', { kind: 'gradient-map', params: def }, 'api');
      const before = read(d);
      const bytes = writePsdDocument(d, app.view.compositor);
      const raw = readPsd(bytes, { skipThumbnail: true, skipLayerImageData: true, skipCompositeImageData: true });
      const a = raw.children.find((ch) => ch.adjustment?.type === 'gradient map').adjustment;
      const back = readPsdDocument(bytes);
      const dd = back.doc ?? back;
      app.docs.add(dd, { activate: false });
      const L = dd.layers().find((l) => l.type === 'adjustment');
      const after = read(dd);
      let max = 0;
      for (let i = 0; i < before.length; i++) max = Math.max(max, Math.abs(before[i] - after[i]));
      res[interpolation] = { code: a.methodCode, interpolation: L.params.interpolation, max };
      await app.docs.close(dd, { force: true });
      await app.commands.run('edit:undo', undefined, 'api');
    }
    return res;
  });
  expect(out.grdmPatched).toBe(true);
  expect(out.classic).toEqual({ code: 'Gcls', interpolation: 'classic', max: expect.any(Number) });
  expect(out.perceptual).toMatchObject({ code: 'Perc', interpolation: 'perceptual' });
  expect(out.linear).toMatchObject({ code: 'Lnr ', interpolation: 'linear' });
  expect(out.smooth).toMatchObject({ code: 'Smoo', interpolation: 'smooth' });
  // the reopened map draws the same picture (each method looks different on this ramp, so a wrong one shows)
  for (const k of ['classic', 'perceptual', 'linear', 'smooth']) expect(out[k].max, k).toBeLessThanOrEqual(3);
  expect(errors).toEqual([]);
});
