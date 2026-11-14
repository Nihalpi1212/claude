// build-repaint-speed: the repaint caches of the view (compositor.js REPAINT, canvas-view.js PREVIEW; ARCHITECTURE.md
// "Repaint caches"). A large document repaints only what an edit can reach: nothing when nothing that draws changed,
// the edit's box when it is confined to one, else everything above a cached composite of the layers below the edit;
// consecutive adjustment layers share one pass. None of it may change a pixel, so every test compares the view's
// composite with a fresh composite that runs none of the caches. While a pointer is held on a slow document the view
// shows a view-scale preview, and composites exactly on release; nothing else ever sees the preview.
import { test, expect } from '@playwright/test';
import { openApp, newDoc, runAwait, drag } from './helpers.mjs';

/** window.__rp: the comparison with a fresh, uncached composite, and the compositor's run counters. */
async function kit(page) {
  await page.evaluate(async () => {
    const app = window.pigmentApp;
    const C = await import('/lib/compositor.js');
    const D = await import('/lib/document.js');
    const pixels = (c, w, h) => new Uint8ClampedArray(c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data);
    window.__rp = {
      C, D,
      /** Pixels that differ between the view's composite and a fresh one made without any repaint cache. */
      check(doc = app.doc) {
        const a = pixels(doc.view.compositor.composite(doc), doc.width, doc.height);
        const keep = { ...C.REPAINT };
        for (const k of Object.keys(C.REPAINT)) C.REPAINT[k] = false;
        try {
          const b = pixels(new C.Compositor().composite(doc), doc.width, doc.height);
          let n = 0;
          for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
          return n;
        } finally {
          Object.assign(C.REPAINT, keep);
        }
      },
      runs(doc = app.doc) {
        const c = doc.view.compositor;
        return { full: c.fullRuns, region: c.regionRuns, prefix: c.prefixHits, preview: c.previewRuns };
      },
      box(w, h, color) {
        const c = D.createCanvas(w, h);
        const g = c.getContext('2d');
        g.fillStyle = color;
        g.fillRect(0, 0, w, h);
        return c;
      },
    };
  });
}

/**
 * A document with every kind of layer and blending option the compositor draws: raster layers with a mask, a blend
 * mode, Blend If, Fill, knockout and effects in their own modes; text, shape, fill (with a feathered vector mask) and
 * smart object layers; a Pass Through group at 60 %, an isolated group with a styled child, a clipping group with a
 * clipped adjustment; a run of five adjustment layers (white mask, painted mask, Blend If, Clarity's margin, Grain)
 * and a layer above them.
 */
async function everything(page) {
  await newDoc(page, { width: 360, height: 240, background: 'white' });
  await kit(page);
  return page.evaluate(async () => {
    const app = window.pigmentApp, d = app.doc, rp = window.__rp, D = rp.D;
    const R = (id, arg) => app.commands.run(id, arg, 'api');
    const bg = d.root.children[0];
    const g0 = bg.canvas.getContext('2d');
    const grad = g0.createLinearGradient(0, 0, 360, 240);
    grad.addColorStop(0, '#203040');
    grad.addColorStop(1, '#e0c080');
    g0.fillStyle = grad;
    g0.fillRect(0, 0, 360, 240);
    bg.touch();
    const add = (l, parent = d.root) => {
      d.add(l, parent, parent.children.length);
      d.setActive(l);
      return l;
    };
    const mask = (w, h, fn) => {
      const c = D.createCanvas(w, h);
      const g = c.getContext('2d');
      g.fillStyle = '#fff';
      fn(g);
      return { canvas: c, enabled: true, linked: true };
    };
    const A = add(new D.RasterLayer({ name: 'A', canvas: rp.box(80, 60, '#ff6600'), x: 20, y: 20, blend: 'multiply', mask: mask(360, 240, (g) => g.fillRect(20, 20, 50, 60)) }));
    add(new D.TextLayer({ name: 'T', text: 'Repaint', x: 120, y: 20, font: { family: 'Arial', size: 28, color: '#103080', weight: 700 } }));
    const pts = [[200, 30], [260, 30], [260, 80], [200, 80]].map(([x, y]) => ({ x, y, anchor: { x, y }, in: { x, y }, out: { x, y } }));
    add(new D.ShapeLayer({ name: 'S', path: { subpaths: [{ closed: true, points: pts }] }, fill: { type: 'solid', color: '#20a040' }, stroke: { color: '#000000', width: 4, align: 'center' }, shapeKind: 'path' }));
    await R('layer:new-fill', { kind: 'gradient', paint: { type: 'gradient', gradient: { gradientVersion: 2, type: 'solid', interpolation: 'perceptual', smoothness: 1, kind: 'radial', from: [300, 180], to: [340, 180], stops: [{ pos: 0, mid: 0.5, color: '#ff0000' }, { pos: 1, mid: 0.5, color: '#0000ff' }], opacityStops: [{ pos: 0, mid: 0.5, opacity: 1 }, { pos: 1, mid: 0.5, opacity: 1 }] } } });
    const F = d.active;
    F.opacity = 0.5;
    await R('layer:vector-mask', { op: 'current-path', path: { subpaths: [{ closed: true, points: [{ x: 270, y: 140 }, { x: 350, y: 140 }, { x: 350, y: 230 }, { x: 270, y: 230 }] }] } });
    await R('layer:mask-properties', { part: 'vector', feather: 6 });
    const G = add(new D.GroupLayer({ name: 'G', blend: 'pass-through', opacity: 0.6 }));
    add(new D.RasterLayer({ name: 'B', canvas: rp.box(60, 50, '#00ccff'), x: 30, y: 120, blend: 'screen' }), G);
    const H = add(new D.GroupLayer({ name: 'H', blend: 'normal' }));
    add(new D.RasterLayer({ name: 'C', canvas: rp.box(50, 40, '#ffee00'), x: 110, y: 120, styles: { dropShadow: { enabled: true, color: '#ff0000', blend: 'multiply', opacity: 1, distance: 8, angle: 90, size: 4 }, outerGlow: { enabled: true, color: '#00ff00', blend: 'screen', opacity: 0.8, size: 6 } } }), H);
    const base = add(new D.RasterLayer({ name: 'Base', canvas: rp.box(70, 50, '#884422'), x: 180, y: 120 }));
    add(new D.RasterLayer({ name: 'E', canvas: rp.box(40, 80, '#22ff88'), x: 200, y: 100, clip: true, blend: 'overlay' }));
    add(new D.AdjustmentLayer({ name: 'Clipped curves', kind: 'curves', params: { rgb: [[0, 0], [128, 180], [255, 255]] }, clip: true }));
    add(new D.RasterLayer({ name: 'K', canvas: rp.box(60, 40, '#aa00aa'), x: 20, y: 170, fillOpacity: 0.7, blending: { blendIf: { gray: { this: [0, 0, 255, 255], under: [0, 40, 255, 255] } } }, styles: { stroke: { enabled: true, size: 3, position: 'outside', color: '#000000' } } }));
    add(new D.RasterLayer({ name: 'Knock', canvas: rp.box(30, 30, '#000000'), x: 90, y: 180, fillOpacity: 0, blending: { knockout: 'deep' } }));
    add(new D.RasterLayer({ name: 'SO', canvas: rp.box(40, 30, '#3366ff'), x: 140, y: 190 }));
    await R('layer:smart-convert');
    await R('layer:new-adjustment', { kind: 'levels', params: { rgb: { inBlack: 10, inWhite: 240, gamma: 1.1, outBlack: 0, outWhite: 255 } } });
    await R('layer:new-adjustment', { kind: 'curves', params: { rgb: [[0, 0], [64, 50], [190, 210], [255, 255]] } });
    const cm = d.active.mask?.canvas;
    if (cm) {
      const g = cm.getContext('2d');
      g.clearRect(0, 0, 120, 240);
      d.active.touch();
    }
    await R('layer:new-adjustment', { kind: 'hue-saturation', params: { hue: 15, saturation: 10, lightness: 0 } });
    d.active.blending = { blendIf: { gray: { this: [0, 0, 255, 255], under: [30, 90, 255, 255] } } };
    d.active.touch();
    await R('layer:new-adjustment', { kind: 'clarity-dehaze', params: { clarity: 40, dehaze: 20 } });
    await R('layer:new-adjustment', { kind: 'grain', params: { amount: 15, size: 25, seed: 3 } });
    add(new D.RasterLayer({ name: 'Top', canvas: rp.box(40, 40, '#ffffff'), x: 300, y: 20, opacity: 0.8 }));
    d.setActive(A);
    d.view.paint();
    return { layers: d.layers().length, base: !!base, H: !!H };
  });
}

test('every kind of change gives the pixels of a fresh composite', async ({ page }) => {
  const errors = await openApp(page);
  await everything(page);
  const steps = await page.evaluate(async () => {
    const app = window.pigmentApp, d = app.doc, rp = window.__rp, D = rp.D, v = d.view;
    const { setLayerProps, structural } = await import('/lib/layer-ops.js');
    const by = (n) => d.layers().find((l) => l.name === n);
    const adj = (k) => d.layers().find((l) => l.type === 'adjustment' && l.kind === k && !l.clip);
    const out = [];
    const step = async (label, fn) => {
      const before = rp.runs();
      await fn();
      v.dirty = true;
      v.paint();
      const after = rp.runs();
      out.push({ label, diff: rp.check(), full: after.full - before.full, region: after.region - before.region, prefix: after.prefix - before.prefix, path: v.compositor.lastPath });
    };
    await step('select another layer', () => d.setActive(by('T')));
    await step('a guide', () => app.commands.run('view:new-guide', { axis: 'v', pos: 100 }, 'api'));
    await step('raster opacity', () => setLayerProps(app, by('A'), { opacity: 0.7 }, 'o'));
    await step('text moved', () => setLayerProps(app, by('T'), { x: by('T').x + 12 }, 'm'));
    await step('shape opacity', () => setLayerProps(app, by('S'), { opacity: 0.5 }, 'o'));
    await step('blend mode', () => setLayerProps(app, by('K'), { blend: 'difference' }, 'b'));
    await step('Blend If', () => setLayerProps(app, by('K'), { blending: { blendIf: { gray: { this: [0, 0, 200, 240], under: [0, 0, 255, 255] } } } }, 'b'));
    await step('fill opacity', () => setLayerProps(app, by('K'), { fillOpacity: 0.4 }, 'f'));
    await step('styles in a group', () => setLayerProps(app, by('C'), { styles: { dropShadow: { enabled: true, color: '#0000ff', blend: 'multiply', opacity: 1, distance: 12, angle: 45, size: 2 } } }, 's'));
    await step('group hidden', () => setLayerProps(app, by('G'), { visible: false }, 'v'));
    await step('group shown', () => setLayerProps(app, by('G'), { visible: true }, 'v'));
    await step('group opacity', () => setLayerProps(app, by('G'), { opacity: 0.3 }, 'v'));
    await step('mask painted (brush hint)', () => {
      const A = by('A');
      const g = A.mask.canvas.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(70, 30, 10, 10);
      A.touch();
      v.invalidate({ x: 70, y: 30, width: 10, height: 10 }, A);
    });
    await step('pixels painted (brush hint)', () => {
      const bg = d.root.children[0];
      bg.canvas.getContext('2d').fillStyle = '#00ff00';
      bg.canvas.getContext('2d').fillRect(150, 100, 6, 6);
      bg.touch();
      v.invalidate({ x: 150, y: 100, width: 6, height: 6 }, bg);
    });
    await step('pixels painted, touched without a hint', () => {
      const bg = d.root.children[0];
      bg.canvas.getContext('2d').fillStyle = '#ff00ff';
      bg.canvas.getContext('2d').fillRect(10, 200, 30, 20);
      bg.touch();
    });
    await step('mask switched off', () => setLayerProps(app, by('A'), { mask: { ...by('A').mask, enabled: false } }, 'm'));
    await step('vector mask feather', async () => {
      d.setActive(d.layers().find((l) => l.type === 'fill'));
      await app.commands.run('layer:mask-properties', { part: 'vector', feather: 0 }, 'api');
    });
    await step('clipped layer unclipped', () => setLayerProps(app, by('E'), { clip: false }, 'c'));
    await step('clipped again', () => setLayerProps(app, by('E'), { clip: true }, 'c'));
    await step('clipped adjustment params', () => setLayerProps(app, d.layers().find((l) => l.name === 'Clipped curves'), { params: { rgb: [[0, 0], [128, 90], [255, 255]] } }, 'p'));
    await step('curves params', () => setLayerProps(app, adj('curves'), { params: { rgb: [[0, 0], [64, 30], [190, 220], [255, 255]] } }, 'p'));
    await step('curves params again (from the cached prefix)', () => setLayerProps(app, adj('curves'), { params: { rgb: [[0, 0], [64, 35], [190, 220], [255, 255]] } }, 'p'));
    await step('grain params', () => setLayerProps(app, adj('grain'), { params: { amount: 25, size: 25, seed: 3 } }, 'p'));
    await step('clarity params', () => setLayerProps(app, adj('clarity-dehaze'), { params: { clarity: 10, dehaze: 0 } }, 'p'));
    await step('adjustment Blend If', () => setLayerProps(app, adj('hue-saturation'), { blending: null }, 'b'));
    await step('adjustment Fill', () => setLayerProps(app, adj('hue-saturation'), { fillOpacity: 0.5 }, 'f'));
    await step('adjustment hidden', () => setLayerProps(app, adj('levels'), { visible: false }, 'v'));
    await step('adjustment mask painted (hint)', () => {
      const a = adj('curves');
      const g = a.mask.canvas.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(40, 40, 8, 8);
      a.touch();
      v.invalidate({ x: 40, y: 40, width: 8, height: 8 }, a);
    });
    await step('layer above the adjustments', () => setLayerProps(app, by('Top'), { y: 60 }, 'm'));
    await step('smart object moved', () => setLayerProps(app, d.layers().find((l) => l.type === 'smart'), { opacity: 0.5 }, 'o'));
    await step('layer moved in the stack', () => structural(app, 'move', () => d.move(by('K'), d.root, d.root.children.indexOf(by('Base')))));
    await step('layer added', () => structural(app, 'add', () => d.add(new D.RasterLayer({ name: 'New', canvas: rp.box(30, 30, '#123456'), x: 5, y: 5 }), d.root, 3)));
    await step('layer deleted', () => structural(app, 'delete', () => d.remove(by('New'))));
    await step('direct property change (no touch)', () => {
      by('S').visible = false;
      d.changed('props');
    });
    await step('direct blending change (no touch)', () => {
      by('A').blending = { blendIf: { gray: { this: [0, 0, 255, 255], under: [0, 0, 120, 200] } } };
      d.changed('props');
    });
    await step('Background renamed (knockout reveals transparency)', () => setLayerProps(app, d.root.children[0], { name: 'Layer 0' }, 'n'));
    await step('global light', () => app.commands.run('layer:global-light', { angle: 30, altitude: 50 }, 'api'));
    await step('undo', () => d.history.undo());
    await step('undo', () => d.history.undo());
    await step('redo', () => d.history.redo());
    await step('Dissolve layer (no partial repaint)', () => setLayerProps(app, by('Top'), { blend: 'dissolve', opacity: 0.6 }, 'b'));
    await step('Dissolve layer moved', () => setLayerProps(app, by('Top'), { x: 290 }, 'm'));
    await step('16 bits', () => app.commands.run('image:depth', 16, 'api'));
    await step('16 bits: raster opacity', () => setLayerProps(app, by('A'), { opacity: 0.9 }, 'o'));
    await step('8 bits', () => app.commands.run('image:depth', 8, 'api'));
    await step('grayscale', () => app.commands.run('image:mode', { mode: 'grayscale', silent: true }, 'api'));
    await step('grayscale: raster opacity', () => setLayerProps(app, by('A'), { opacity: 0.6 }, 'o'));
    await step('undo the mode', () => d.history.undo());
    await step('canvas size', () => app.commands.run('image:canvas-size', { width: 380, height: 250, anchor: 'c' }, 'api'));
    return out;
  });
  for (const s of steps) expect(s.diff, s.label).toBe(0);
  const of = (label) => steps.find((s) => s.label === label);
  // nothing composited for edits that draw nothing
  for (const label of ['select another layer', 'a guide']) {
    expect(of(label).full + of(label).region, label).toBe(0);
  }
  // confined edits repaint their box only
  for (const label of ['raster opacity', 'text moved', 'shape opacity', 'blend mode', 'mask painted (brush hint)', 'pixels painted (brush hint)', 'adjustment mask painted (hint)', 'layer above the adjustments']) {
    expect(of(label), label).toMatchObject({ full: 0, region: 1 });
  }
  // an adjustment's change is not confined: composited from the cached prefix below it
  expect(of('curves params again (from the cached prefix)')).toMatchObject({ full: 1, prefix: 1 });
  // a Dissolve layer's noise follows the repaint rect: its document is composited whole
  expect(of('Dissolve layer moved')).toMatchObject({ full: 1, region: 0 });
  expect(errors).toEqual([]);
});

test('chained adjustment layers give the unchained pixels, translucent backdrops included', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 256, height: 256, background: 'transparent' });
  await kit(page);
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp, d = app.doc, rp = window.__rp, D = rp.D, C = rp.C;
    const R = (id, arg) => app.commands.run(id, arg, 'api');
    // every colour at every alpha
    const c = D.createCanvas(256, 256);
    const g = c.getContext('2d');
    const img = g.createImageData(256, 256);
    for (let a = 0, p = 0; a < 256; a++) for (let v = 0; v < 256; v++, p += 4) {
      img.data[p] = v;
      img.data[p + 1] = 255 - v;
      img.data[p + 2] = (v * 7) & 255;
      img.data[p + 3] = a;
    }
    g.putImageData(img, 0, 0);
    const base = d.root.children[0];
    base.canvas = c;
    base.touch();
    await R('layer:new-adjustment', { kind: 'curves', params: { rgb: [[0, 0], [64, 90], [255, 255]] } });
    await R('layer:new-adjustment', { kind: 'hue-saturation', params: { hue: 30, saturation: 20, lightness: 0 } });
    d.active.fillOpacity = 0.6;
    d.active.touch();
    await R('layer:new-adjustment', { kind: 'levels', params: { rgb: { inBlack: 20, inWhite: 230, gamma: 0.9, outBlack: 0, outWhite: 255 } } });
    d.active.opacity = 0.5;
    d.active.touch();
    await R('layer:new-adjustment', { kind: 'invert', params: {} });
    const m = d.active.mask?.canvas;
    if (m) {
      m.getContext('2d').clearRect(0, 0, 128, 256);
      d.active.touch();
    }
    const keep = { ...C.REPAINT };
    const chains = [];
    const comp = (chain) => {
      for (const k of Object.keys(C.REPAINT)) C.REPAINT[k] = false;
      C.REPAINT.chain = chain;
      try {
        const c = new C.Compositor();
        const data = c.composite(d).getContext('2d').getImageData(0, 0, 256, 256).data;
        chains.push(c.chainRuns ?? 0);
        return data;
      } finally {
        Object.assign(C.REPAINT, keep);
      }
    };
    const a = comp(true), b = comp(false);
    let n = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
    // the canvas keeps an unchanged pixel: reading it back and writing it again is the same pixel (the region repaint
    // and the pass-through fade rely on it)
    const t = D.createCanvas(256, 256);
    const tg = t.getContext('2d', { willReadFrequently: true });
    tg.putImageData(img, 0, 0);
    const once = tg.getImageData(0, 0, 256, 256);
    tg.putImageData(once, 0, 0);
    const twice = tg.getImageData(0, 0, 256, 256).data;
    let m2 = 0;
    for (let i = 0; i < twice.length; i++) if (twice[i] !== once.data[i]) m2++;
    let translucent = 0;
    for (let p = 3; p < a.length; p += 4) if (a[p] > 0 && a[p] < 255) translucent++;
    return { n, m2, translucent, chains };
  });
  // the four layers ran as one chain, and without it as four passes
  expect(r.chains).toEqual([1, 0]);
  expect(r.translucent).toBeGreaterThan(30000);
  expect(r.n).toBe(0);
  expect(r.m2).toBe(0);
  expect(errors).toEqual([]);
});

test('a partial composite gives a full one\'s pixels for every adjustment kind that may repaint in part', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 300, height: 200, background: 'white' });
  await kit(page);
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp, d = app.doc, rp = window.__rp, C = rp.C, D = rp.D;
    const bg = d.root.children[0];
    const g = bg.canvas.getContext('2d');
    for (let i = 0; i < 40; i++) {
      g.fillStyle = `hsl(${i * 37}, 70%, ${30 + (i % 5) * 12}%)`;
      g.fillRect((i * 53) % 280, (i * 31) % 180, 30 + (i % 4) * 10, 20 + (i % 3) * 15);
    }
    bg.touch();
    const params = {
      'brightness-contrast': { brightness: 20, contrast: 30 },
      levels: { rgb: { inBlack: 10, inWhite: 240, gamma: 1.2, outBlack: 5, outWhite: 250 } },
      curves: { rgb: [[0, 0], [64, 40], [190, 220], [255, 255]] },
      exposure: { exposure: 0.5, offset: 0.02, gamma: 1.1 },
      vibrance: { vibrance: 30, saturation: 10 },
      'color-balance': { shadows: [10, 0, -10], midtones: [0, 10, 0], highlights: [-10, 0, 10], preserveLuminosity: true },
      invert: {},
      posterize: { levels: 5 },
      threshold: { level: 120 },
      'selective-color': null,
      desaturate: {},
      'hue-saturation': { hue: 20, saturation: 10, lightness: 5 },
      'black-white': null,
      'photo-filter': { color: '#ec8a00', density: 40, preserveLuminosity: true },
      'channel-mixer': null,
      'gradient-map': { stops: [{ offset: 0, color: '#000044' }, { offset: 1, color: '#ffee88' }], dither: true },
      'shadows-highlights': { shadows: 40, highlights: 30, radius: 12, shadowTone: 50, highlightTone: 50, shadowRadius: null, highlightRadius: null, color: 10, midtone: 5, blackClip: 0, whiteClip: 0 },
      'color-vibrance': { temperature: 15, tint: 5, vibrance: 20, saturation: 10 },
      'clarity-dehaze': { clarity: 50, dehaze: 40 },
      grain: { amount: 30, size: 40, roughness: 60 },
      'color-lookup': null,
    };
    const { adjustmentDef } = await import('/shared/pixels/adjust.js');
    const rect = { x: 70, y: 45, width: 90, height: 70 };
    const out = {};
    const keep = { ...C.REPAINT };
    for (const [kind, p] of Object.entries(params)) {
      const l = new D.AdjustmentLayer({ name: kind, kind, params: p ?? JSON.parse(JSON.stringify(adjustmentDef(kind).defaults)) });
      d.add(l, d.root, 1);
      for (const k of Object.keys(C.REPAINT)) C.REPAINT[k] = false;
      const full = new C.Compositor().composite(d).getContext('2d').getImageData(rect.x, rect.y, rect.width, rect.height).data;
      const part = new C.Compositor().composite(d, { rect }).getContext('2d').getImageData(0, 0, rect.width, rect.height).data;
      Object.assign(C.REPAINT, keep);
      let n = 0;
      for (let i = 0; i < full.length; i++) if (full[i] !== part[i]) n++;
      // and that the kind changes the picture at all (a test of nothing would pass too)
      l.visible = false;
      l.touch();
      const off = new C.Compositor().composite(d, { rect }).getContext('2d').getImageData(0, 0, rect.width, rect.height).data;
      let changed = 0;
      for (let i = 0; i < off.length; i++) if (off[i] !== part[i]) changed++;
      out[kind] = { n, changed };
      d.remove(l);
    }
    return out;
  });
  for (const [kind, v] of Object.entries(r)) expect(v.n, kind).toBe(0);
  for (const kind of ['curves', 'clarity-dehaze', 'grain', 'gradient-map', 'shadows-highlights']) expect(r[kind].changed, kind).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('a brush stroke under adjustment layers repaints its dabs only, and the end of the stroke repaints nothing', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 900, height: 600, background: 'white' });
  await kit(page);
  await page.evaluate(async () => {
    const app = window.pigmentApp, d = app.doc;
    const R = (id, arg) => app.commands.run(id, arg, 'api');
    await R('layer:new-adjustment', { kind: 'curves', params: { rgb: [[0, 0], [64, 40], [190, 220], [255, 255]] } });
    await R('layer:new-adjustment', { kind: 'clarity-dehaze', params: { clarity: 30, dehaze: 10 } });
    d.setActive(d.root.children[0]);
    app.tools.activate('brush');
    d.view.paint();
  });
  const before = await page.evaluate(() => window.__rp.runs());
  await drag(page, [200, 200], [500, 300], { steps: 10 });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const r = await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    d.view.paint();
    return { runs: window.__rp.runs(), diff: window.__rp.check(), entries: d.history.entries.length };
  });
  expect(r.runs.region - before.region).toBeGreaterThan(0);
  expect(r.runs.full - before.full).toBe(0);
  expect(r.diff).toBe(0);
  // undo and redo repaint the stroke's box and still match
  const u = await page.evaluate(() => {
    const d = window.pigmentApp.doc, rp = window.__rp;
    const out = [];
    for (const fn of [() => d.history.undo(), () => d.history.redo()]) {
      const r0 = rp.runs();
      fn();
      d.view.paint();
      const r1 = rp.runs();
      out.push({ diff: rp.check(), full: r1.full - r0.full, region: r1.region - r0.region });
    }
    return out;
  });
  expect(u).toEqual([{ diff: 0, full: 0, region: 1 }, { diff: 0, full: 0, region: 1 }]);
  expect(errors).toEqual([]);
});

test('while a pointer is held on a slow document the view shows a preview; the release, exports and readers get full resolution', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 600, height: 400, background: 'white' });
  await kit(page);
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp, d = app.doc, rp = window.__rp, v = d.view;
    const R = (id, arg) => app.commands.run(id, arg, 'api');
    const { setLayerProps } = await import('/lib/layer-ops.js');
    const { PREVIEW } = await import('/lib/canvas-view.js');
    const { flattenDocument } = rp.C;
    const bg = d.root.children[0];
    const g = bg.canvas.getContext('2d');
    for (let i = 0; i < 30; i++) {
      g.fillStyle = `hsl(${i * 47}, 60%, 50%)`;
      g.fillRect((i * 71) % 560, (i * 43) % 360, 40, 40);
    }
    bg.touch();
    await R('layer:new-adjustment', { kind: 'curves', params: { rgb: [[0, 0], [64, 40], [190, 220], [255, 255]] } });
    const curves = d.active;
    await R('layer:new-adjustment', { kind: 'clarity-dehaze', params: { clarity: 30, dehaze: 10 } });
    v.paint();
    const out = {};
    // the view finds the last composite slow (as on a large document) and a pointer goes down
    v.slow = true;
    window.dispatchEvent(new PointerEvent('pointerdown', { isPrimary: true }));
    out.gesture = v.gesture;
    const full0 = v.compositor.full.canvas;
    const runs0 = rp.runs();
    setLayerProps(app, curves, { params: { rgb: [[0, 0], [64, 20], [190, 230], [255, 255]] } }, 'p');
    v.paint();
    const runs1 = rp.runs();
    out.preview = runs1.preview - runs0.preview;
    out.fullDuring = runs1.full - runs0.full;
    out.shown = v.previewShown;
    out.fullKept = v.compositor.full.canvas === full0;
    // a reader during the gesture (export, the navigator) gets the exact pixels
    out.exportDiff = (() => {
      const a = flattenDocument(d, v.compositor).getContext('2d').getImageData(0, 0, d.width, d.height).data;
      const keep = { ...rp.C.REPAINT };
      for (const k of Object.keys(rp.C.REPAINT)) rp.C.REPAINT[k] = false;
      const b = new rp.C.Compositor().composite(d).getContext('2d').getImageData(0, 0, d.width, d.height).data;
      Object.assign(rp.C.REPAINT, keep);
      let n = 0;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
      return n;
    })();
    // another change while held, then the release: one exact composite
    setLayerProps(app, curves, { params: { rgb: [[0, 0], [64, 25], [190, 230], [255, 255]] } }, 'p');
    v.paint();
    window.dispatchEvent(new PointerEvent('pointerup', { isPrimary: true }));
    out.afterRelease = { gesture: v.gesture, dirty: v.dirty };
    v.paint();
    out.releaseShown = v.previewShown;
    out.releaseDiff = rp.check();
    // the switch: off, the held pointer composites exactly
    PREVIEW.enabled = false;
    v.slow = true;
    window.dispatchEvent(new PointerEvent('pointerdown', { isPrimary: true }));
    const runs2 = rp.runs();
    setLayerProps(app, curves, { params: { rgb: [[0, 0], [64, 30], [190, 230], [255, 255]] } }, 'p');
    v.paint();
    out.offPreview = rp.runs().preview - runs2.preview;
    window.dispatchEvent(new PointerEvent('pointerup', { isPrimary: true }));
    PREVIEW.enabled = true;
    out.offDiff = rp.check();
    // Proof Colors: the preview and the full composite under it are two canvases of one document version, each
    // processed for itself
    app.settings.proofColors = true;
    try {
      const a = rp.box(d.width, d.height, '#ff0000'), b = rp.box(d.width, d.height, '#0000ff');
      const pa = v.postProcess(a, v), pb = v.postProcess(b, v), pa2 = v.postProcess(a, v);
      const px = (c) => Array.from(c.getContext('2d').getImageData(5, 5, 1, 1).data);
      out.proof = { differ: JSON.stringify(px(pa)) !== JSON.stringify(px(pb)), cached: pa2 === pa };
    } finally {
      app.settings.proofColors = false;
    }
    return out;
  });
  expect(r.gesture).toBe(true);
  expect(r).toMatchObject({ preview: 1, fullDuring: 0, shown: true, fullKept: true, exportDiff: 0, releaseShown: false, releaseDiff: 0, offPreview: 0, offDiff: 0 });
  expect(r.afterRelease).toEqual({ gesture: false, dirty: true });
  expect(r.proof).toEqual({ differ: true, cached: true });
  expect(errors).toEqual([]);
});

test('a document-sized layer around a small subject repaints the subject\'s box, measured when idle or when it pays', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 1200, height: 900, background: 'white' });
  await kit(page);
  await page.evaluate(async () => {
    const app = window.pigmentApp, d = app.doc, rp = window.__rp, D = rp.D;
    const c = D.createCanvas(1200, 900);
    const g = c.getContext('2d');
    g.fillStyle = '#3060c0';
    g.fillRect(300, 200, 100, 80);
    const l = new D.RasterLayer({ name: 'Big', canvas: c, x: 0, y: 0 });
    d.add(l, d.root, 1);
    await app.commands.run('layer:new-adjustment', { kind: 'curves', params: { rgb: [[0, 0], [64, 40], [190, 220], [255, 255]] } }, 'api');
    await app.commands.run('layer:new-adjustment', { kind: 'clarity-dehaze', params: { clarity: 30, dehaze: 0 } }, 'api');
    d.setActive(l);
    d.view.paint();
    // a second composite gives the compositor a plan to measure against
    l.opacity = 0.95;
    l.touch();
    d.changed('props', { layer: l });
    d.view.paint();
  });
  // the user pauses: the layer's content box is measured while the app is idle
  await page.waitForTimeout(1300);
  const steps = await page.evaluate(async () => {
    const app = window.pigmentApp, d = app.doc, rp = window.__rp, v = d.view;
    const { setLayerProps } = await import('/lib/layer-ops.js');
    const l = d.layers().find((x) => x.name === 'Big');
    const out = [];
    const step = (label, fn) => {
      const r0 = rp.runs();
      fn();
      v.dirty = true;
      v.paint();
      const r1 = rp.runs();
      out.push({ label, diff: rp.check(), full: r1.full - r0.full, region: r1.region - r0.region });
    };
    step('opacity', () => setLayerProps(app, l, { opacity: 0.7 }, 'o'));
    step('pixels painted far off, no hint', () => {
      l.canvas.getContext('2d').fillStyle = '#c03060';
      l.canvas.getContext('2d').fillRect(700, 500, 60, 40);
      l.touch();
    });
    step('a dab with a hint', () => {
      l.canvas.getContext('2d').fillRect(320, 420, 20, 20);
      l.touch();
      v.invalidate({ x: 320, y: 420, width: 20, height: 20 }, l);
    });
    step('cleared', () => {
      l.canvas.getContext('2d').clearRect(0, 0, 1200, 900);
      l.touch();
    });
    return out;
  });
  expect(steps).toEqual([
    { label: 'opacity', diff: 0, full: 0, region: 1 },
    { label: 'pixels painted far off, no hint', diff: 0, full: 0, region: 1 },
    { label: 'a dab with a hint', diff: 0, full: 0, region: 1 },
    { label: 'cleared', diff: 0, full: 0, region: 1 },
  ]);
  expect(errors).toEqual([]);
});
