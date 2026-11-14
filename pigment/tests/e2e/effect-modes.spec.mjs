// Effect blend modes against the backdrop (0.4, the hunt's deferred design item). Photoshop composites each exterior
// effect (drop shadow, outer glow, outer bevel, outer stroke) onto the layers below with its own mode and opacity,
// then the layer's content and interior effects with the layer's mode, and the layer's opacity fades all of it as one.
// These tests check that model on every kind of layer, in groups, clipping masks, knockout, Blend If and 16 bits, that
// Create Layers, Merge Down, Flatten, Stamp Visible and a .pigment round trip keep the picture, and that Rasterize
// Layer Style and Convert to Smart Object say when they cannot.
import { test, expect } from '@playwright/test';
import { openApp, newDoc, runAwait } from './helpers.mjs';

/** In-page helpers on window.__fx: layers, pixels and comparisons (installed once per page). */
async function kit(page) {
  await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { RasterLayer, GroupLayer, ShapeLayer, TextLayer, FillLayer, createCanvas } = await import('/lib/document.js');
    const box = (w, h, color, shape = 'rect') => {
      const c = createCanvas(w, h);
      const g = c.getContext('2d');
      g.fillStyle = color;
      if (shape === 'rect') g.fillRect(0, 0, w, h);
      else {
        g.beginPath();
        g.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
        g.fill();
      }
      return c;
    };
    window.__fx = {
      RasterLayer, GroupLayer, ShapeLayer, TextLayer, FillLayer, createCanvas, box,
      /** Paints the Background (or the bottom layer) one colour. */
      background(color) {
        const bg = app.doc.root.children[0];
        const g = bg.canvas.getContext('2d');
        g.fillStyle = color;
        g.fillRect(0, 0, bg.canvas.width, bg.canvas.height);
        bg.touch();
        app.doc.changed('pixels', { layer: bg });
      },
      /** A raster layer of one colour at x, y, added on top of `parent` (the root by default) and made active. */
      raster(props, { w = 60, h = 40, color = '#ff8800', shape = 'rect', parent = null } = {}) {
        const d = app.doc;
        const l = new RasterLayer({ name: 'L', canvas: box(w, h, color, shape), x: 50, y: 40, ...props });
        const p = parent ?? d.root;
        d.add(l, p, p.children.length);
        d.setActive(l);
        return l;
      },
      composite() {
        const d = app.doc;
        return d.view.compositor.composite(d).getContext('2d').getImageData(0, 0, d.width, d.height).data;
      },
      px(x, y) {
        const d = app.doc;
        return Array.from(d.view.compositor.composite(d).getContext('2d').getImageData(x, y, 1, 1).data);
      },
      maxDiff(a, b) {
        let m = 0;
        for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
        return m;
      },
      /** How many pixels are within 2 levels of rgb. */
      count(data, rgb) {
        let n = 0;
        for (let p = 0; p < data.length; p += 4) if (Math.abs(data[p] - rgb[0]) <= 2 && Math.abs(data[p + 1] - rgb[1]) <= 2 && Math.abs(data[p + 2] - rgb[2]) <= 2) n++;
        return n;
      },
    };
  });
}

// a hard red Multiply shadow 30 px straight down: below the layer it is shadow alone
const RED_MULTIPLY = { dropShadow: { enabled: true, color: '#ff0000', blend: 'multiply', opacity: 1, distance: 30, angle: 90, size: 0 } };

async function greyDoc(page, opts = {}) {
  await newDoc(page, { width: 200, height: 160, background: 'white', ...opts });
  await kit(page);
  await page.evaluate(() => window.__fx.background('#808080'));
}

const toast = (page, text) => page.locator('#toasts .toast', { hasText: text });

test('a red Multiply shadow multiplies with grey, a Screen glow is invisible on white, opacity fades it all as one', async ({ page }) => {
  const errors = await openApp(page);
  await greyDoc(page);
  const r = await page.evaluate(() => {
    const fx = window.__fx;
    const out = {};
    const l = fx.raster({ styles: { dropShadow: { enabled: true, color: '#ff0000', blend: 'multiply', opacity: 1, distance: 30, angle: 90, size: 0 } } });
    out.shadow = fx.px(80, 95);
    out.layer = fx.px(80, 60);
    l.opacity = 0.5;
    l.touch();
    out.halfShadow = fx.px(80, 95);
    out.halfLayer = fx.px(80, 60);
    // the layer's own mode applies to its content only: a Normal stroke on a Multiply layer stays blue
    l.opacity = 1;
    l.blend = 'multiply';
    l.styles = { stroke: { enabled: true, size: 4, position: 'outside', color: '#0000ff', blend: 'normal' } };
    l.touch();
    out.strokeOnMultiply = fx.px(48, 60);
    out.contentMultiplied = fx.px(80, 60);
    // a yellow Screen glow over white changes nothing
    fx.background('#ffffff');
    l.blend = 'normal';
    l.styles = { outerGlow: { enabled: true, color: '#ffff00', blend: 'screen', opacity: 1, size: 10, spread: 50 } };
    l.touch();
    const data = fx.composite();
    let changed = 0;
    for (let p = 0; p < data.length; p += 4) {
      const i = p / 4, x = i % 200, y = Math.floor(i / 200);
      const inLayer = x >= 50 && x < 110 && y >= 40 && y < 80;
      if (!inLayer && (data[p] !== 255 || data[p + 1] !== 255 || data[p + 2] !== 255)) changed++;
    }
    out.glowChanged = changed;
    // a Normal shadow under 50 % opacity matches the one-fade model: 50 % black over grey 128 at 50 % = 96
    fx.background('#808080');
    l.opacity = 0.5;
    l.styles = { dropShadow: { enabled: true, color: '#000000', blend: 'normal', opacity: 0.5, distance: 30, angle: 90, size: 0 } };
    l.touch();
    out.normalHalf = fx.px(80, 95);
    return out;
  });
  expect(r.shadow).toEqual([128, 0, 0, 255]);
  expect(r.layer).toEqual([255, 136, 0, 255]);
  // shadow and layer fade back towards the grey together
  expect(r.halfShadow.slice(0, 3).map((v, i) => Math.abs(v - [128, 64, 64][i]) <= 1)).toEqual([true, true, true]);
  expect(r.halfLayer.slice(0, 3).map((v, i) => Math.abs(v - [192, 132, 64][i]) <= 1)).toEqual([true, true, true]);
  expect(r.strokeOnMultiply).toEqual([0, 0, 255, 255]);
  expect(r.contentMultiplied).toEqual([128, 68, 0, 255]);
  expect(r.glowChanged).toBe(0);
  expect(r.normalHalf.slice(0, 3).map((v) => Math.abs(v - 96) <= 1)).toEqual([true, true, true]);
  expect(errors).toEqual([]);
});

test('every kind of layer takes the model: text, shape, fill, smart object', async ({ page }) => {
  const errors = await openApp(page);
  await greyDoc(page);
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const fx = window.__fx;
    const d = app.doc;
    const styles = { dropShadow: { enabled: true, color: '#ff0000', blend: 'multiply', opacity: 1, distance: 30, angle: 90, size: 0 } };
    const out = {};
    const measure = (name) => {
      const data = fx.composite();
      out[name] = { dark: fx.count(data, [128, 0, 0]), red: fx.count(data, [255, 0, 0]) };
    };
    const only = (l) => {
      for (const c of d.root.children.slice(1)) d.remove(c);
      d.add(l, d.root, 1);
      d.setActive(l);
    };
    only(new fx.TextLayer({ name: 'T', text: 'IIII', x: 40, y: 30, font: { family: 'Arial', size: 40, color: '#000000', weight: 700 }, styles }));
    measure('text');
    const pts = [[50, 30], [120, 30], [120, 70], [50, 70]].map(([x, y]) => ({ x, y, anchor: { x, y }, in: { x, y }, out: { x, y } }));
    only(new fx.ShapeLayer({ name: 'S', path: { subpaths: [{ closed: true, points: pts }] }, fill: { type: 'solid', color: '#000000' }, shapeKind: 'path', styles }));
    measure('shape');
    // a fill layer is the whole canvas: its mask shapes it (the mask applies before the effects)
    const m = fx.createCanvas(200, 160);
    const mg = m.getContext('2d');
    mg.fillStyle = '#fff';
    mg.fillRect(50, 30, 70, 40);
    only(new fx.FillLayer({ name: 'F', paint: { type: 'solid', color: '#000000' }, mask: { canvas: m, enabled: true, linked: true }, styles }));
    measure('fill');
    // a smart object made from a raster layer, then styled
    only(new fx.RasterLayer({ name: 'R', canvas: fx.box(70, 40, '#000000'), x: 50, y: 30 }));
    await app.commands.run('layer:smart-convert', undefined, 'api');
    const so = d.active;
    so.styles = styles;
    so.touch();
    out.smartType = so.type;
    measure('smart');
    return out;
  });
  expect(r.smartType).toBe('smart');
  for (const kind of ['text', 'shape', 'fill', 'smart']) {
    // shadow-alone pixels are grey × red; none is drawn as plain red
    expect(r[kind].dark, kind).toBeGreaterThan(40);
    expect(r[kind].red, kind).toBe(0);
  }
  expect(errors).toEqual([]);
});

test('groups: Pass Through and a styled group blend with what is below; an isolated group keeps its children apart', async ({ page }) => {
  const errors = await openApp(page);
  await greyDoc(page);
  const r = await page.evaluate(() => {
    const app = window.pigmentApp;
    const fx = window.__fx;
    const d = app.doc;
    const styles = { dropShadow: { enabled: true, color: '#ff0000', blend: 'multiply', opacity: 1, distance: 30, angle: 90, size: 0 } };
    const out = {};
    const g = new fx.GroupLayer({ name: 'G', blend: 'pass-through' });
    d.add(g, d.root, 1);
    fx.raster({ styles }, { parent: g });
    out.passThrough = fx.px(80, 95);
    g.opacity = 0.5;
    g.touch();
    out.passThroughHalf = fx.px(80, 95);
    // a Normal group is isolated: inside it, the shadow multiplies with transparency (it shows as red)
    g.opacity = 1;
    g.blend = 'normal';
    g.touch();
    out.isolated = fx.px(80, 95);
    // the group's own Multiply shadow blends with the grey below the group
    const kid = g.children[0];
    kid.styles = null;
    kid.touch();
    g.blend = 'pass-through';
    g.styles = styles;
    g.touch();
    out.groupShadow = fx.px(80, 95);
    return out;
  });
  expect(r.passThrough).toEqual([128, 0, 0, 255]);
  expect(r.passThroughHalf.slice(0, 3).map((v, i) => Math.abs(v - [128, 64, 64][i]) <= 1)).toEqual([true, true, true]);
  expect(r.isolated).toEqual([255, 0, 0, 255]);
  expect(r.groupShadow).toEqual([128, 0, 0, 255]);
  expect(errors).toEqual([]);
});

test('clipping masks: a styled base blends with the backdrop; a clipped layer\'s glow screens over the base and stays inside it', async ({ page }) => {
  const errors = await openApp(page);
  await greyDoc(page);
  const r = await page.evaluate(() => {
    const fx = window.__fx;
    const out = {};
    const base = fx.raster({ styles: { dropShadow: { enabled: true, color: '#ff0000', blend: 'multiply', opacity: 1, distance: 30, angle: 90, size: 0 } } });
    const clipped = fx.raster({ clip: true, x: 70, y: 50 }, { w: 20, h: 10, color: '#00ff00' });
    out.baseShadow = fx.px(80, 95);
    out.clippedContent = fx.px(80, 55);
    // the base without effects, dark blue; the clipped layer gets a yellow Screen glow: screened with the base's blue
    base.styles = null;
    base.canvas.getContext('2d').fillStyle = '#000080';
    base.canvas.getContext('2d').fillRect(0, 0, 60, 40);
    base.touch();
    clipped.styles = { outerGlow: { enabled: true, color: '#ffff00', blend: 'screen', opacity: 1, size: 4, spread: 100 } };
    clipped.touch();
    out.glowOnBase = fx.px(67, 55);
    // outside the base the glow is cut off: the grey shows
    clipped.x = 52;
    clipped.touch();
    out.glowOutside = fx.px(48, 55);
    // Blend Clipped Layers as Group off: the clipped layer composites with the backdrop, cut to the base's shape
    clipped.x = 70;
    base.blending = { clippedAsGroup: false };
    base.touch();
    clipped.touch();
    out.glowNotGrouped = fx.px(67, 55);
    return out;
  });
  expect(r.baseShadow).toEqual([128, 0, 0, 255]);
  expect(r.clippedContent).toEqual([0, 255, 0, 255]);
  expect(r.glowOnBase).toEqual([255, 255, 128, 255]);
  expect(r.glowOutside).toEqual([128, 128, 128, 255]);
  expect(r.glowNotGrouped).toEqual([255, 255, 128, 255]);
  expect(errors).toEqual([]);
});

test('knockout cuts through to the Background for the content; Blend If hides the layer but not its shadow', async ({ page }) => {
  const errors = await openApp(page);
  await greyDoc(page);
  const r = await page.evaluate(() => {
    const app = window.pigmentApp;
    const fx = window.__fx;
    const d = app.doc;
    const out = {};
    // a white layer between the grey Background and the knockout layer
    d.add(new fx.RasterLayer({ name: 'White', canvas: fx.box(200, 160, '#ffffff'), x: 0, y: 0 }), d.root, 1);
    const l = fx.raster({ fillOpacity: 0, blending: { knockout: 'deep' }, styles: { dropShadow: { enabled: true, color: '#ff0000', blend: 'multiply', opacity: 1, distance: 30, angle: 90, size: 0 } } });
    out.knocked = fx.px(80, 50);
    out.shadowOnWhite = fx.px(80, 95);
    out.outside = fx.px(20, 20);
    // Blend If: the black layer hides itself (This Layer hides 0..49); its Multiply shadow stays whole
    d.remove(d.root.children[1]);
    l.fillOpacity = 1;
    l.blending = { blendIf: { gray: { this: [50, 50, 255, 255] } } };
    l.canvas.getContext('2d').fillStyle = '#000000';
    l.canvas.getContext('2d').fillRect(0, 0, 60, 40);
    l.touch();
    out.blendIfLayer = fx.px(80, 50);
    out.blendIfShadow = fx.px(80, 95);
    // channels: only red written, by the shadow too
    l.blending = { channels: { r: true, g: false, b: false } };
    l.touch();
    out.channelsShadow = fx.px(80, 95);
    return out;
  });
  expect(r.knocked).toEqual([128, 128, 128, 255]);
  expect(r.shadowOnWhite).toEqual([255, 0, 0, 255]);
  expect(r.outside).toEqual([255, 255, 255, 255]);
  expect(r.blendIfLayer).toEqual([128, 128, 128, 255]);
  expect(r.blendIfShadow).toEqual([128, 0, 0, 255]);
  // red 128 × 255 = 128, green and blue keep the grey's 128
  expect(r.channelsShadow).toEqual([128, 128, 128, 255]);
  expect(errors).toEqual([]);
});

test('Create Layers leaves the picture unchanged with effects in their own modes, warns only where it cannot match; undo restores', async ({ page }) => {
  const errors = await openApp(page);
  await greyDoc(page);
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const fx = window.__fx;
    const d = app.doc;
    const out = {};
    fx.raster({
      blend: 'multiply',
      styles: {
        dropShadow: { enabled: true, color: '#ff0000', blend: 'multiply', opacity: 0.8, distance: 12, size: 4 },
        outerGlow: { enabled: true, color: '#ffff60', blend: 'screen', opacity: 0.9, size: 8 },
        stroke: { enabled: true, size: 3, position: 'center', color: '#2040ff', blend: 'overlay' },
        innerGlow: { enabled: true, color: '#00ffff', blend: 'normal', size: 6 },
      },
    }, { shape: 'ellipse' });
    const before = fx.composite();
    await app.commands.run('layer:style-create-layers', undefined, 'api');
    out.layers = d.layers().slice(1).map((l) => `${l.name.replace("L's ", '')}:${l.blend}${l.clip ? ':clip' : ''}`);
    out.diff = fx.maxDiff(before, fx.composite());
    await app.commands.run('edit:undo', undefined, 'api');
    out.undone = { layers: d.layers().length, styles: !!d.active.styles, diff: fx.maxDiff(before, fx.composite()) };
    return out;
  });
  expect(r.layers).toEqual(['Drop Shadow:multiply', 'Outer Glow:screen', 'Outer Stroke:overlay', 'L:multiply', 'Inner Glow:normal:clip', 'Inner Stroke:overlay:clip']);
  expect(r.diff).toBeLessThanOrEqual(2);
  await expect(toast(page, 'cannot be reproduced with layers')).toHaveCount(0);
  expect(r.undone).toEqual({ layers: 2, styles: true, diff: 0 });
  // 50 % layer opacity fades the layer and its shadow as one, which separate layers cannot do: Photoshop warns
  await page.evaluate(async () => {
    const app = window.pigmentApp;
    const l = app.doc.active;
    l.opacity = 0.5;
    l.touch();
    await app.commands.run('layer:style-create-layers', undefined, 'api');
  });
  await expect(toast(page, 'cannot be reproduced with layers')).toBeVisible();
  expect(errors).toEqual([]);
});

test('Merge Down, Merge Visible, Stamp Visible and Flatten match the canvas', async ({ page }) => {
  const errors = await openApp(page);
  await greyDoc(page);
  const styles = {
    dropShadow: { enabled: true, color: '#ff0000', blend: 'multiply', opacity: 0.9, distance: 10, size: 3 },
    outerGlow: { enabled: true, color: '#ffff00', blend: 'screen', opacity: 0.8, size: 6 },
  };
  const setup = (s) => page.evaluate((st) => {
    const app = window.pigmentApp;
    const fx = window.__fx;
    const d = app.doc;
    for (const c of d.root.children.slice(1)) d.remove(c);
    // an opaque lower layer under the styled one: what Merge Down composites onto
    d.add(new fx.RasterLayer({ name: 'Lower', canvas: fx.box(200, 160, '#3080c0'), x: 0, y: 0 }), d.root, 1);
    fx.raster({ blend: 'hard-light', styles: st }, { shape: 'ellipse' });
    return Array.from(fx.composite());
  }, s);
  const after = () => page.evaluate(() => Array.from(window.__fx.composite()));
  const diff = (a, b) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);
  for (const cmd of ['layer:merge-down', 'layer:merge-visible', 'layer:stamp-visible', 'image:flatten']) {
    const before = await setup(styles);
    await runAwait(page, cmd);
    expect(diff(before, await after()), cmd).toBeLessThanOrEqual(2);
  }
  expect(errors).toEqual([]);
});

test('Rasterize Layer Style and Convert to Smart Object keep the look where one layer can, and say so where it cannot', async ({ page }) => {
  const errors = await openApp(page);
  await greyDoc(page);
  const run = (styles, cmd) => page.evaluate(async ([st, c]) => {
    const app = window.pigmentApp;
    const fx = window.__fx;
    const d = app.doc;
    for (const l of d.root.children.slice(1)) d.remove(l);
    document.querySelectorAll('#toasts .toast').forEach((t) => t.remove());
    fx.raster({ styles: st });
    const before = fx.composite();
    await app.commands.run(c, undefined, 'api');
    return fx.maxDiff(before, fx.composite());
  }, [styles, cmd]);
  // a black Multiply shadow over transparency is what a Normal one is: kept exactly, no notice
  const black = { dropShadow: { enabled: true, color: '#000000', blend: 'multiply', opacity: 0.75, distance: 10, size: 4 } };
  expect(await run(black, 'layer:rasterize-style')).toBeLessThanOrEqual(2);
  await expect(toast(page, 'a mode of their own')).toHaveCount(0);
  // a Screen glow over grey cannot be kept by one Normal layer
  const glow = { outerGlow: { enabled: true, color: '#ffff00', blend: 'screen', opacity: 1, size: 8 } };
  expect(await run(glow, 'layer:rasterize-style')).toBeGreaterThan(2);
  await expect(toast(page, 'which one layer cannot keep')).toBeVisible();
  expect(await run(black, 'layer:smart-convert')).toBeLessThanOrEqual(2);
  await expect(toast(page, 'which the smart object cannot keep')).toHaveCount(0);
  expect(await run(glow, 'layer:smart-convert')).toBeGreaterThan(2);
  await expect(toast(page, 'which the smart object cannot keep')).toBeVisible();
  expect(errors).toEqual([]);
});

test('a 16-bit document, an undone mode change and a .pigment round trip keep the model', async ({ page }) => {
  const errors = await openApp(page);
  await greyDoc(page, { depth: 16 });
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const fx = window.__fx;
    const { setLayerProps } = await import('/lib/layer-ops.js');
    const { writePigment, readPigment } = await import('/lib/io.js');
    const { Compositor } = await import('/lib/compositor.js');
    const out = {};
    const l = fx.raster({ styles: { dropShadow: { enabled: true, color: '#ff0000', blend: 'multiply', opacity: 1, distance: 30, angle: 90, size: 0 } } });
    out.depth = app.doc.depth;
    out.deep = fx.px(80, 95);
    // the shadow's mode set to Normal as a command, then undone
    setLayerProps(app, l, { styles: { dropShadow: { ...l.styles.dropShadow, blend: 'normal' } } }, 'Layer style');
    out.normal = fx.px(80, 95);
    await app.commands.run('edit:undo', undefined, 'api');
    out.undone = fx.px(80, 95);
    const before = fx.composite();
    const back = await readPigment(await writePigment(app.doc));
    const c = new Compositor().composite(back).getContext('2d').getImageData(0, 0, back.width, back.height).data;
    out.roundTrip = fx.maxDiff(before, c);
    return out;
  });
  expect(r.depth).toBe(16);
  expect(r.deep).toEqual([128, 0, 0, 255]);
  expect(r.normal).toEqual([255, 0, 0, 255]);
  expect(r.undone).toEqual([128, 0, 0, 255]);
  expect(r.roundTrip).toBe(0);
  expect(errors).toEqual([]);
});
