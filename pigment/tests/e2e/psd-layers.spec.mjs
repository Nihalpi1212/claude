// psd-layers (ARCHITECTURE.md "0.5 features", package 5; port 8855): PSD fidelity for layer effects, Blending Options,
// vector masks and layer masks, shape layers, fill layers, adjustment layers, colour labels, linked layers and the
// global light, both ways, on documents and on PSDs the tests build as Photoshop writes them; Maximize Compatibility
// as a save option and a preference; mode documents through asShown.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openApp, newDoc, runAwait, run } from './helpers.mjs';
import { pagePsdGolden } from './goldens.mjs';

const PSD_GOLDEN = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'psd-golden');

/** Page helpers: round trips, composites, raw records. */
async function helpers(page) {
  await page.evaluate(async () => {
    const app = window.pigmentApp;
    const D = await import('/lib/document.js');
    const io = await import('/lib/io.js');
    const { readPsd, writePsdUint8Array } = await import('ag-psd');
    const { livePath } = await import('/lib/path-ops.js');
    const comp = (d) => (d.view?.compositor ?? app.view.compositor).composite(d).getContext('2d').getImageData(0, 0, d.width, d.height).data;
    window.__psd = {
      D,
      io,
      readPsd,
      writePsdUint8Array,
      livePath,
      fill(w, h, color, rect = null) {
        const c = D.createCanvas(w, h);
        const x = c.getContext('2d');
        x.fillStyle = color;
        if (rect) x.fillRect(rect[0], rect[1], rect[2], rect[3]);
        else x.fillRect(0, 0, w, h);
        return c;
      },
      rect: (x, y, w, h, op) => ({ closed: true, points: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map(([px, py]) => ({ x: px, y: py })), ...(op ? { op } : {}) }),
      /** Writes the active document to PSD and reads it back into a second document (not activated). */
      roundTrip(opts = {}) {
        const d = app.doc;
        const bytes = io.writePsdDocument(d, d.view.compositor, { notices: false, ...opts });
        const back = io.readPsdDocument(bytes);
        app.docs.add(back, { activate: false });
        const raw = readPsd(bytes, { skipThumbnail: true, skipCompositeImageData: true });
        return { back, raw, bytes };
      },
      /** The largest channel difference of two documents' composites. */
      maxDiff(a, b) {
        const x = comp(a), y = comp(b);
        let m = 0;
        for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i] - y[i]));
        return m;
      },
      layer: (d, name) => d.layers().find((l) => l.name === name),
      rec: (raw, name) => {
        const find = (list) => {
          for (const c of list ?? []) {
            if (c.name === name) return c;
            const inner = find(c.children);
            if (inner) return inner;
          }
          return null;
        };
        return find(raw.children);
      },
    };
  });
}

test('layer effects and Blending Options come back from the PSD, every instance, without the "saved without them" toast', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 200, height: 150, background: 'white' });
  await helpers(page);
  await page.evaluate(() => {
    const { D, fill } = window.__psd;
    const d = window.pigmentApp.doc;
    d.globalLight = { angle: 60, altitude: 40 };
    const l = new D.RasterLayer({ name: 'Box', canvas: fill(80, 60, '#3070c0'), x: 40, y: 30, styles: {
      dropShadow: [{ enabled: true, distance: 8, size: 6, spread: 2, color: '#000000', opacity: 0.6, useGlobalLight: true }, { enabled: true, distance: 3, size: 1, angle: 30, color: '#ff0000' }],
      outerGlow: { enabled: true, size: 10, spread: 3, color: '#ffff00' },
      innerShadow: { enabled: true, distance: 4, size: 4 },
      bevel: { enabled: true, size: 6, depth: 150, technique: 'chisel-soft', useGlobalLight: true },
      satin: { enabled: true, size: 10, distance: 8 },
      colorOverlay: { enabled: true, color: '#00ff00', opacity: 0.3 },
      gradientOverlay: { enabled: true, opacity: 0.5, angle: 45, gradient: { gradientVersion: 2, type: 'solid', interpolation: 'perceptual', smoothness: 1, stops: [{ pos: 0, mid: 0.5, color: '#ff00ff' }, { pos: 1, mid: 0.5, color: '#00ffff' }], opacityStops: [{ pos: 0, mid: 0.5, opacity: 1 }, { pos: 1, mid: 0.5, opacity: 1 }] } },
      stroke: [{ enabled: true, size: 3, color: '#ffffff' }, { enabled: true, size: 2, color: '#000000', position: 'inside' }],
    }, blending: { knockout: 'shallow', interiorAsGroup: true, channels: { r: true, g: false, b: true } } });
    d.add(l);
    d.setActive(l);
  });
  await page.evaluate(() => (window.__pigmentTest.nextSavePath = 'mem:/fx.psd'));
  await runAwait(page, 'file:save-as');
  await expect.poll(() => page.evaluate(() => !!window.__pigmentTest.written['mem:/fx.psd'])).toBe(true);
  await expect(page.locator('#toasts .toast', { hasText: 'saved without them' })).toHaveCount(0);
  const r = await page.evaluate(async () => {
    const { io, readPsd, maxDiff, layer } = window.__psd;
    const app = window.pigmentApp;
    const bytes = window.__pigmentTest.written['mem:/fx.psd'];
    const raw = readPsd(bytes, { skipThumbnail: true, skipLayerImageData: true, skipCompositeImageData: true });
    const back = io.readPsdDocument(bytes);
    app.docs.add(back, { activate: false });
    const b = layer(back, 'Box');
    return {
      raw: { lmfx: Array.isArray(raw.children.find((c) => c.name === 'Box').effects.dropShadow), angle: raw.imageResources.globalAngle, knock: raw.children.find((c) => c.name === 'Box').knockoutMode },
      keys: Object.keys(b.styles).sort(),
      shadows: b.styles.dropShadow.length,
      strokes: b.styles.stroke.map((s) => s.position),
      blending: b.blending,
      light: back.globalLight,
      diff: maxDiff(app.doc, back),
      notices: back.openNotices ?? null,
    };
  });
  expect(r.raw).toEqual({ lmfx: true, angle: 60, knock: 'shallow' });
  expect(r.keys).toEqual(['bevel', 'colorOverlay', 'dropShadow', 'gradientOverlay', 'innerShadow', 'outerGlow', 'satin', 'stroke']);
  expect(r.shadows).toBe(2);
  expect(r.strokes).toEqual(['outside', 'inside']);
  expect(r.blending).toMatchObject({ knockout: 'shallow', interiorAsGroup: true, channels: { r: true, g: false, b: true } });
  expect(r.light).toEqual({ angle: 60, altitude: 40 });
  expect(r.diff).toBeLessThanOrEqual(2);
  expect(r.notices).toBeNull();
  expect(errors).toEqual([]);
});

test('a PSD with effects Pigment does not have opens with them approximated or dropped, and says so by name', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 60, height: 40 });
  await helpers(page);
  await page.evaluate(() => {
    const { writePsdUint8Array, fill } = window.__psd;
    const canvas = fill(60, 40, '#808080');
    window.__pigmentTest.files['mem:/ps-fx.psd'] = writePsdUint8Array({
      width: 60, height: 40, canvas,
      children: [{
        name: 'Styled', canvas: fill(30, 20, '#ff0000'), left: 10, top: 10,
        effects: {
          bevel: { enabled: true, present: true, style: 'stroke emboss', size: { units: 'Pixels', value: 4 } },
          stroke: [{ enabled: true, present: true, overprint: true, size: { units: 'Pixels', value: 2 }, position: 'outside', fillType: 'color', blendMode: 'normal', opacity: 1, color: { r: 0, g: 0, b: 255 } }],
          dropShadow: [{ enabled: true, present: true, size: { units: 'Pixels', value: 5 }, distance: { units: 'Pixels', value: 5 }, choke: { units: 'Pixels', value: 20 }, color: { r: 0, g: 0, b: 0 }, opacity: 0.75, angle: 120, blendMode: 'multiply' }],
        },
      }],
    }, { noBackground: true });
  });
  await runAwait(page, 'file:open-paths', ['mem:/ps-fx.psd']);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.path)).toBe('mem:/ps-fx.psd');
  const r = await page.evaluate(() => {
    const l = window.pigmentApp.doc.layers().find((x) => x.name === 'Styled');
    return { bevel: l.styles.bevel.style, stroke: l.styles.stroke.color, shadow: { spread: l.styles.dropShadow.spread, size: l.styles.dropShadow.size }, notices: window.pigmentApp.doc.openNotices };
  });
  expect(r.bevel).toBe('emboss');
  expect(r.stroke).toBe('#0000ff');
  // Photoshop's 20 % spread of a 5 px shadow: 1 px of hard edge and 4 px of blur
  expect(r.shadow).toEqual({ spread: 1, size: 4 });
  expect(r.notices).toEqual(['2 layer effect settings Pigment does not have were approximated or dropped: Bevel & Emboss (Stroke Emboss, read as Emboss), Stroke (Overprint)']);
  await expect(page.locator('#toasts .toast', { hasText: '2 layer effect settings Pigment does not have' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('vector masks keep their path, operations, start, density and feather; the layer mask keeps its own pixels and settings', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 120, height: 90, background: 'white' });
  await helpers(page);
  const r = await page.evaluate(() => {
    const { D, fill, rect, roundTrip, maxDiff, layer, rec } = window.__psd;
    const d = window.pigmentApp.doc;
    d.add(new D.RasterLayer({ name: 'VM', canvas: fill(120, 90, '#ff0000'), x: 0, y: 0, vectorMask: { path: { subpaths: [rect(10, 10, 80, 60), rect(30, 30, 20, 20, 'subtract')] }, density: 0.6, feather: 3, linked: false }, mask: { canvas: fill(120, 90, '#ffffff', [0, 0, 60, 90]), enabled: true, linked: true, density: 0.5, feather: 2 } }));
    d.add(new D.RasterLayer({ name: 'Reveal', canvas: fill(120, 90, '#0000ff'), x: 0, y: 0, opacity: 0.5, vectorMask: { path: { subpaths: [rect(60, 0, 30, 90, 'subtract')] }, initialFill: 'reveal' } }));
    d.add(new D.RasterLayer({ name: 'Plain mask', canvas: fill(120, 90, '#00ff00'), x: 0, y: 0, opacity: 0.4, mask: { canvas: fill(120, 90, '#ffffff', [0, 0, 120, 30]), enabled: false, linked: true } }));
    const { back, raw } = roundTrip();
    const vm = rec(raw, 'VM');
    const L = layer(back, 'VM');
    const R = layer(back, 'Reveal');
    const P = layer(back, 'Plain mask');
    const alpha = (m, x, y) => m.canvas.getContext('2d').getImageData(x, y, 1, 1).data[3];
    return {
      raw: { paths: vm.vectorMask.paths.map((p) => p.operation), notLink: vm.vectorMask.notLink, density: Math.round(vm.mask.userMaskDensity * 100), vDensity: Math.round(vm.mask.vectorMaskDensity * 100), feather: vm.mask.userMaskFeather, vFeather: vm.mask.vectorMaskFeather },
      vm: { ops: L.vectorMask.path.subpaths.map((s) => s.op ?? 'combine'), linked: L.vectorMask.linked, density: Math.round(L.vectorMask.density * 100), feather: L.vectorMask.feather, start: R.vectorMask.initialFill },
      mask: { density: Math.round(L.mask.density * 100), feather: L.mask.feather, full: [alpha(L.mask, 20, 50), alpha(L.mask, 90, 50)] },
      plain: { enabled: P.mask.enabled, a: [alpha(P.mask, 10, 10), alpha(P.mask, 10, 60)] },
      diff: maxDiff(d, back),
    };
  });
  expect(r.raw).toEqual({ paths: ['combine', 'subtract'], notLink: true, density: 50, vDensity: 60, feather: 2, vFeather: 3 });
  expect(r.vm).toEqual({ ops: ['combine', 'subtract'], linked: false, density: 60, feather: 3, start: 'reveal' });
  // the raster mask's own pixels at full strength: its density is a setting
  expect(r.mask).toEqual({ density: 50, feather: 2, full: [255, 0] });
  expect(r.plain).toEqual({ enabled: false, a: [255, 0] });
  expect(r.diff).toBeLessThanOrEqual(2);
  expect(errors).toEqual([]);
});

test('a PSD as Photoshop writes it: vector-rendered first mask and the user mask second, an inverted vector mask', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 40, height: 40 });
  await helpers(page);
  const r = await page.evaluate(() => {
    const { io, writePsdUint8Array, fill } = window.__psd;
    const k = (x, y) => ({ linked: false, points: [x, y, x, y, x, y] });
    const paths = [{ open: false, operation: 'combine', fillRule: 'non-zero', knots: [k(10, 10), k(30, 10), k(30, 30), k(10, 30)] }];
    const bytes = writePsdUint8Array({
      width: 40, height: 40, canvas: fill(40, 40, '#ffffff'),
      children: [
        { name: 'Both', canvas: fill(40, 40, '#ff0000'), left: 0, top: 0, vectorMask: { paths },
          mask: { left: 0, top: 0, canvas: fill(40, 40, '#000000', null), fromVectorData: true, userMaskDensity: 0.8 },
          realMask: { left: 0, top: 0, canvas: (() => { const c = fill(40, 40, '#000000'); c.getContext('2d').fillStyle = '#ffffff'; c.getContext('2d').fillRect(0, 0, 20, 40); return c; })() } },
        { name: 'Inverted', canvas: fill(40, 40, '#0000ff'), left: 0, top: 0, vectorMask: { paths, invert: true } },
      ],
    }, { noBackground: true });
    const back = io.readPsdDocument(bytes);
    window.pigmentApp.docs.add(back, { activate: false });
    const both = back.layers().find((l) => l.name === 'Both');
    const inv = back.layers().find((l) => l.name === 'Inverted');
    const px = (x, y) => Array.from(back.view.compositor.composite(back).getContext('2d').getImageData(x, y, 1, 1).data);
    return { userMask: [both.mask.canvas.getContext('2d').getImageData(5, 5, 1, 1).data[3], both.mask.canvas.getContext('2d').getImageData(35, 5, 1, 1).data[3]], density: Math.round(both.mask.density * 100), vm: both.vectorMask.path.subpaths.length, invSubpaths: inv.vectorMask.path.subpaths.map((s) => s.op ?? 'combine'), inside: px(20, 20), outside: px(2, 2), notices: back.openNotices };
  });
  expect(r.userMask).toEqual([255, 0]);
  expect(r.density).toBe(80);
  expect(r.vm).toBe(1);
  expect(r.invSubpaths).toEqual(['combine', 'exclude']);
  // the inverted mask hides the square and shows the rest: blue outside, the red layer (masked to its square) inside
  expect(r.outside).toEqual([0, 0, 255, 255]);
  expect(r.inside[2]).toBeLessThan(255);
  expect(r.notices).toEqual(['1 vector setting Pigment does not have was approximated: an inverted vector mask (read as its path excluded from the canvas)']);
  expect(errors).toEqual([]);
});

test('shape layers stay live shapes: rectangles with radii and rotation, ellipses, strokes, gradient fills; editable after reopening', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 200, height: 150, background: 'white' });
  await helpers(page);
  const r = await page.evaluate(() => {
    const { D, livePath, roundTrip, maxDiff, layer, rec } = window.__psd;
    const d = window.pigmentApp.doc;
    const props = { x: 20, y: 20, width: 90, height: 60, angle: 15, radii: [10, 0, 20, 5] };
    d.add(new D.ShapeLayer({ name: 'Rect', path: livePath('rect', props), shapeKind: 'rect', shapeProps: props, fill: { type: 'gradient', gradient: { kind: 'linear', angle: 30, stops: [{ pos: 0, color: '#ff0000' }, { pos: 1, color: '#0000ff' }] } }, stroke: { width: 4, align: 'outside', cap: 'round', join: 'round', miterLimit: 4, dash: [2, 1], dashOffset: 0, color: '#00aa00', paint: { type: 'solid', color: '#00aa00' } } }));
    const e = { x: 120, y: 60, width: 60, height: 50, angle: 0 };
    d.add(new D.ShapeLayer({ name: 'Ellipse', path: livePath('ellipse', e), shapeKind: 'ellipse', shapeProps: e, fill: { type: 'solid', color: '#ffaa00' }, stroke: null }));
    const tri = { subpaths: [{ closed: true, points: [{ x: 150, y: 10 }, { x: 190, y: 50 }, { x: 140, y: 40, inX: 160, inY: 50 }] }] };
    const outline = new D.ShapeLayer({ name: 'Path', path: tri, stroke: { width: 2, align: 'center', cap: 'butt', join: 'miter', miterLimit: 4, dash: [], dashOffset: 0, color: '#000000', paint: { type: 'solid', color: '#000000' } } });
    outline.fill = null; // no fill (the constructor's default is a colour)
    d.add(outline);
    const { back, raw } = roundTrip();
    const rr = rec(raw, 'Rect');
    const R = layer(back, 'Rect'), E = layer(back, 'Ellipse'), P = layer(back, 'Path');
    window.__shape = R;
    return {
      raw: { fill: rr.vectorFill.type, stroke: rr.vectorStroke.strokeEnabled, origin: rr.vectorOrigination.keyDescriptorList[0].keyOriginType, dash: rr.vectorStroke.lineDashSet.map((x) => x.value) },
      rect: { kind: R.shapeKind, props: R.shapeProps, stroke: { width: R.stroke.width, align: R.stroke.align, cap: R.stroke.cap, join: R.stroke.join, dash: R.stroke.dash, color: R.stroke.color }, fill: R.fill.type },
      ellipse: { kind: E.shapeKind, props: E.shapeProps, fill: E.fill },
      path: { kind: P.shapeKind, fill: P.fill, points: P.path.subpaths[0].points.length },
      diff: maxDiff(d, back),
    };
  });
  expect(r.raw).toEqual({ fill: 'solid', stroke: true, origin: 2, dash: [2, 1] });
  expect(r.rect.kind).toBe('rect');
  expect(r.rect.props).toEqual({ x: 20, y: 20, width: 90, height: 60, angle: 15, radii: [10, 0, 20, 5] });
  expect(r.rect.stroke).toEqual({ width: 4, align: 'outside', cap: 'round', join: 'round', dash: [2, 1], color: '#00aa00' });
  expect(r.rect.fill).toBe('gradient');
  expect(r.ellipse).toEqual({ kind: 'ellipse', props: { x: 120, y: 60, width: 60, height: 50, angle: 0 }, fill: { type: 'solid', color: '#ffaa00' } });
  expect(r.path).toEqual({ kind: 'path', fill: null, points: 3 });
  expect(r.diff).toBeLessThanOrEqual(2);
  // the reopened rectangle is a live shape: Properties edits it, one entry, undo and redo
  const edited = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const back = app.docs.docs.find((dd) => dd.layers().includes(window.__shape));
    app.docs.activate(back);
    back.setActive(window.__shape);
    const n = back.history.index;
    await app.commands.run('layer:shape-properties', { props: { width: 120 } }, 'api');
    const after = { entries: back.history.index - n, width: window.__shape.shapeProps.width };
    await app.commands.run('edit:undo', undefined, 'api');
    const undone = window.__shape.shapeProps.width;
    await app.commands.run('edit:redo', undefined, 'api');
    return { ...after, undone, redone: window.__shape.shapeProps.width };
  });
  expect(edited).toEqual({ entries: 1, width: 120, undone: 90, redone: 120 });
  expect(errors).toEqual([]);
});

test('fill layers stay Solid Color, Gradient and Pattern fills, with their placement and the pattern\'s scale', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 200, height: 150, background: 'white' });
  await helpers(page);
  const r = await page.evaluate(() => {
    const { D, fill, roundTrip, maxDiff, layer, rec } = window.__psd;
    const d = window.pigmentApp.doc;
    d.add(new D.FillLayer({ name: 'Radial', paint: { type: 'gradient', gradient: { kind: 'radial', stops: [{ pos: 0, color: '#ffffff' }, { pos: 1, color: '#000000' }], from: [100, 75], to: [180, 75] } }, docWidth: 200, docHeight: 150, opacity: 0.6 }));
    d.add(new D.FillLayer({ name: 'Solid', paint: { type: 'solid', color: '#204080' }, docWidth: 200, docHeight: 150, opacity: 0.3 }));
    const pc = fill(8, 8, '#ff0000');
    pc.getContext('2d').fillStyle = '#ffffff';
    pc.getContext('2d').fillRect(0, 0, 4, 4);
    d.add(new D.FillLayer({ name: 'Pattern', paint: { type: 'pattern', pattern: { canvas: pc, scale: 2, angle: 0, link: true, origin: [0, 0], name: 'Checker' } }, docWidth: 200, docHeight: 150, opacity: 0.25 }));
    const { back, raw } = roundTrip();
    const pat = layer(back, 'Pattern').paint.pattern;
    return {
      raw: ['Radial', 'Solid', 'Pattern'].map((n) => rec(raw, n).vectorFill.type),
      patterns: raw.patterns?.length ?? 0,
      types: ['Radial', 'Solid', 'Pattern'].map((n) => layer(back, n).type),
      solid: layer(back, 'Solid').paint,
      radial: { kind: layer(back, 'Radial').paint.gradient.kind, from: layer(back, 'Radial').paint.gradient.from.map(Math.round), to: layer(back, 'Radial').paint.gradient.to.map(Math.round) },
      pattern: { scale: pat.scale, name: pat.name, canvas: !!pat.canvas, dataUrl: typeof pat.dataUrl === 'string' },
      diff: maxDiff(d, back),
    };
  });
  expect(r.raw).toEqual(['solid', 'color', 'pattern']);
  expect(r.patterns).toBe(1);
  expect(r.types).toEqual(['fill', 'fill', 'fill']);
  expect(r.solid).toEqual({ type: 'solid', color: '#204080' });
  expect(r.radial).toEqual({ kind: 'radial', from: [100, 75], to: [180, 75] });
  expect(r.pattern).toEqual({ scale: 2, name: 'Checker', canvas: true, dataUrl: true });
  expect(r.diff).toBeLessThanOrEqual(2);
  expect(errors).toEqual([]);
});

test('adjustment layers: Colorize and Color Lookup stay editable, with no "saved without Colorize" toast', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 120, height: 90, background: 'white' });
  await helpers(page);
  await page.evaluate(() => {
    const { D, fill } = window.__psd;
    window.pigmentApp.doc.add(new D.RasterLayer({ name: 'C', canvas: fill(120, 90, '#c08040'), x: 0, y: 0 }));
  });
  const preset = await page.evaluate(async () => (await import('/shared/pixels/lut.js')).LUT_PRESET_NAMES[0]);
  await runAwait(page, 'layer:new-adjustment', { kind: 'hue-saturation', params: { colorize: true, colorizeHue: 200, colorizeSat: 40, colorizeLight: -10 } });
  await runAwait(page, 'layer:new-adjustment', { kind: 'color-lookup', params: { preset, lut: null, dither: false } });
  await page.evaluate(() => (window.__pigmentTest.nextSavePath = 'mem:/adj.psd'));
  await runAwait(page, 'file:save-as');
  await expect.poll(() => page.evaluate(() => !!window.__pigmentTest.written['mem:/adj.psd'])).toBe(true);
  await expect(page.locator('#toasts .toast', { hasText: 'saved without Colorize' })).toHaveCount(0);
  const r = await page.evaluate(() => {
    const { io, maxDiff } = window.__psd;
    const back = io.readPsdDocument(window.__pigmentTest.written['mem:/adj.psd']);
    window.pigmentApp.docs.add(back, { activate: false });
    return { adj: back.layers().filter((l) => l.type === 'adjustment').map((l) => ({ kind: l.kind, colorize: l.params.colorize ?? null, hue: l.params.colorizeHue ?? null, preset: l.params.preset ?? null })), diff: maxDiff(window.pigmentApp.doc, back) };
  });
  expect(r.adj[0]).toEqual({ kind: 'hue-saturation', colorize: true, hue: 200, preset: null });
  expect(r.adj[1]).toEqual({ kind: 'color-lookup', colorize: null, hue: null, preset });
  expect(r.diff).toBeLessThanOrEqual(2);
  expect(errors).toEqual([]);
});

test('colour labels and linked layers come back from the PSD; linked layers still move together', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 100, height: 80, background: 'white' });
  await helpers(page);
  const r = await page.evaluate(async () => {
    const { D, fill, roundTrip } = window.__psd;
    const app = window.pigmentApp;
    const d = app.doc;
    const a = new D.RasterLayer({ name: 'A', canvas: fill(10, 10, '#ff0000'), x: 0, y: 0 });
    const b = new D.RasterLayer({ name: 'B', canvas: fill(10, 10, '#00ff00'), x: 20, y: 0 });
    const c = new D.RasterLayer({ name: 'C', canvas: fill(10, 10, '#0000ff'), x: 40, y: 0 });
    d.add(a);
    d.add(b);
    d.add(c);
    d.setActive(a);
    d.selected = new Set([a, b]);
    await app.commands.run('layer:link', undefined, 'api');
    a.color = 'red';
    c.color = 'gray';
    const { back } = roundTrip();
    const get = (n) => back.layers().find((l) => l.name === n);
    return { colors: ['A', 'B', 'C'].map((n) => get(n).color ?? null), linkedTogether: !!get('A').linked && get('A').linked === get('B').linked, cLinked: get('C').linked ?? null, before: !!a.linked && a.linked === b.linked };
  });
  expect(r.before).toBe(true);
  expect(r.colors).toEqual(['red', null, 'gray']);
  expect(r.linkedTogether).toBe(true);
  expect(r.cLinked).toBeNull();
  expect(errors).toEqual([]);
});

test('a Grayscale document: a coloured shape and fill stay grey pixels, a grey one is written natively', async ({ page }) => {
  const errors = await openApp(page);
  await helpers(page);
  const r = await page.evaluate(() => {
    const { D, livePath, rec } = window.__psd;
    const app = window.pigmentApp;
    app.newDocument({ width: 80, height: 60, name: 'grey', mode: 'grayscale' });
    const d = app.doc;
    const p = { x: 10, y: 10, width: 40, height: 30, angle: 0, radii: [0, 0, 0, 0] };
    d.add(new D.ShapeLayer({ name: 'Red', path: livePath('rect', p), shapeKind: 'rect', shapeProps: p, fill: { type: 'solid', color: '#ff0000' }, stroke: null }));
    d.add(new D.ShapeLayer({ name: 'Grey', path: livePath('rect', p), shapeKind: 'rect', shapeProps: p, fill: { type: 'solid', color: '#808080' }, stroke: null, opacity: 0.5 }));
    d.add(new D.FillLayer({ name: 'Blue fill', paint: { type: 'solid', color: '#0000ff' }, docWidth: 80, docHeight: 60, opacity: 0.2 }));
    d.add(new D.RasterLayer({ name: 'Styled', canvas: D.createCanvas(10, 10), x: 0, y: 0, styles: { colorOverlay: { enabled: true, color: '#00ff00' } } }));
    const raw = window.__psd.readPsd(window.__psd.io.writePsdDocument(d, d.view.compositor, { notices: false }), { skipThumbnail: true, skipCompositeImageData: true });
    const red = rec(raw, 'Red');
    const px = red.canvas.getContext('2d').getImageData(20 - red.left, 20 - red.top, 1, 1).data;
    return { red: { vf: red.vectorFill ?? null, px: Array.from(px) }, grey: rec(raw, 'Grey').vectorFill?.color ? 'native' : 'pixels', fill: rec(raw, 'Blue fill').vectorFill ?? null, styled: rec(raw, 'Styled').effects ?? null };
  });
  expect(r.red.vf).toBeNull();
  expect(r.red.px[0]).toBe(r.red.px[1]);
  expect(r.red.px[1]).toBe(r.red.px[2]);
  expect(r.grey).toBe('native');
  expect(r.fill).toBeNull();
  expect(r.styled).toBeNull();
  expect(errors).toEqual([]);
});

test('Maximize Compatibility: "Ask" shows Photoshop Format Options on save; off writes a blank composite; the Preferences section sets it', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 40, height: 30, background: 'white' });
  await helpers(page);
  await page.evaluate(() => {
    const { D, fill } = window.__psd;
    window.pigmentApp.doc.add(new D.RasterLayer({ name: 'Blue', canvas: fill(40, 30, '#204080'), x: 0, y: 0 }));
    window.pigmentApp.settings.psd.maximizeCompatibility = 'ask';
  });
  const save = async (path) => {
    await page.evaluate((p) => (window.__pigmentTest.nextSavePath = p), path);
    await run(page, 'file:save-as');
  };
  const composite = (path) => page.evaluate((p) => {
    const raw = window.__psd.readPsd(window.__pigmentTest.written[p], { skipLayerImageData: true });
    return { px: Array.from(raw.canvas.getContext('2d').getImageData(5, 5, 1, 1).data), real: raw.imageResources?.versionInfo?.hasRealMergedData ?? null };
  }, path);
  const dialog = page.locator('.dialog-backdrop', { hasText: 'Photoshop Format Options' });
  // Cancel cancels the save
  await save('mem:/cancel.psd');
  await expect(dialog).toBeVisible();
  await dialog.locator('.dialog-buttons .btn[data-value="null"]').click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => !!window.__pigmentTest.written['mem:/cancel.psd'])).toBe(false);
  // off: a blank composite, not real merged data
  await save('mem:/off.psd');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Maximize compatibility').uncheck();
  await dialog.locator('.dialog-buttons .btn.primary').click();
  await expect.poll(() => page.evaluate(() => !!window.__pigmentTest.written['mem:/off.psd'])).toBe(true);
  expect(await composite('mem:/off.psd')).toEqual({ px: [255, 255, 255, 255], real: false });
  // on, and "Don't show again" makes it the preference
  await save('mem:/on.psd');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Don't show again").check();
  await dialog.locator('.dialog-buttons .btn.primary').click();
  await expect.poll(() => page.evaluate(() => !!window.__pigmentTest.written['mem:/on.psd'])).toBe(true);
  expect(await composite('mem:/on.psd')).toEqual({ px: [32, 64, 128, 255], real: null });
  expect(await page.evaluate(() => window.pigmentApp.settings.psd.maximizeCompatibility)).toBe('always');
  // the Preferences: File Handling
  await run(page, 'edit:preferences');
  const prefs = page.locator('.dialog-backdrop', { hasText: 'Maximize PSD and PSB File Compatibility' });
  await expect(prefs).toBeVisible();
  await prefs.getByLabel('Maximize PSD and PSB File Compatibility').selectOption('never');
  await prefs.locator('.dialog-buttons .btn.primary').click();
  await expect.poll(() => page.evaluate(() => window.pigmentApp.settings.psd.maximizeCompatibility)).toBe('never');
  // 'never' saves without asking
  await save('mem:/never.psd');
  await expect.poll(() => page.evaluate(() => !!window.__pigmentTest.written['mem:/never.psd'])).toBe(true);
  expect(await composite('mem:/never.psd')).toEqual({ px: [255, 255, 255, 255], real: false });
  expect(errors).toEqual([]);
});

test('a 16-bit document writes its styles, shapes and masks natively through the 8-bit proxies', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 100, height: 80, background: 'white' });
  await helpers(page);
  await page.evaluate(() => {
    const { D, fill, livePath, rect } = window.__psd;
    const d = window.pigmentApp.doc;
    const p = { x: 10, y: 10, width: 40, height: 30, angle: 0 };
    d.add(new D.ShapeLayer({ name: 'E', path: livePath('ellipse', p), shapeKind: 'ellipse', shapeProps: p, fill: { type: 'solid', color: '#ff8000' }, stroke: null, styles: { dropShadow: { enabled: true, distance: 4, size: 3 } } }));
    d.add(new D.RasterLayer({ name: 'M', canvas: fill(100, 80, '#0060c0'), x: 0, y: 0, opacity: 0.5, vectorMask: { path: { subpaths: [rect(50, 20, 40, 40)] } } }));
  });
  await runAwait(page, 'image:depth', 16);
  const r = await page.evaluate(() => {
    const { roundTrip, rec, layer, maxDiff } = window.__psd;
    const d = window.pigmentApp.doc;
    const { back, raw } = roundTrip();
    return { depth: d.depth, shape: !!rec(raw, 'E').vectorOrigination, fx: !!rec(raw, 'E').effects, vm: !!rec(raw, 'M').vectorMask, kind: layer(back, 'E').shapeKind, diff: maxDiff(d, back) };
  });
  expect(r).toMatchObject({ depth: 16, shape: true, fx: true, vm: true, kind: 'ellipse' });
  expect(r.diff).toBeLessThanOrEqual(2);
  expect(errors).toEqual([]);
});

test('documents without the new features still write 0.4\'s PSD exactly (the adjustments and guides goldens)', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(async () => {
    const { writePsdDocument } = await import('/lib/io.js');
    window.__goldenWritePsd = (d) => writePsdDocument(d, d.view.compositor);
  });
  for (const id of ['adjustments', 'guides']) {
    const json = await page.evaluate(pagePsdGolden, id);
    expect(json, id).toBe(readFileSync(join(PSD_GOLDEN, `${id}.json`), 'utf8').trimEnd());
  }
  expect(errors).toEqual([]);
});
