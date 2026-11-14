// Regressions from the 0.4 cross-feature hunt, area "files, history": a Pattern Fill made from a pattern paint keeps its
// canvas (it draws and saves), an action records the text and shape layers the Type and shape tools make and plays them
// back, a PSD keeps Hue/Saturation ranges and guides and says what it drops, and a styled layer with Blend If on a
// document-sized canvas is blended only where it has pixels.
import { test, expect } from '@playwright/test';
import { openApp, newDoc, runAwait, screenPoint, drag } from './helpers.mjs';

/** The flattened document as an array of bytes. */
const composite = (page) => page.evaluate(() => {
  const d = window.pigmentApp.doc;
  return Array.from(d.view.compositor.composite(d).getContext('2d').getImageData(0, 0, d.width, d.height).data);
});
const countDiff = (a, b) => {
  let n = 0;
  for (let i = 0; i < a.length; i += 4) if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]), Math.abs(a[i + 3] - b[i + 3])) > 2) n++;
  return n;
};

test('layer:new-fill with a pattern paint keeps the pattern canvas: the layer draws and the document saves', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 100, height: 80, background: 'white' });
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { makePatternPaint } = await import('/lib/pattern-paint.js');
    const cur = app.patterns.current();
    await app.commands.run('layer:new-fill', { kind: 'pattern', paint: makePatternPaint(cur.canvas, { scale: 1, presetId: cur.id, name: cur.name }) }, 'api');
    const l = app.doc.active;
    return { type: l.type, drawable: typeof l.paint.pattern.canvas?.getContext === 'function', presetId: l.paint.pattern.presetId ?? null };
  });
  expect(r).toEqual({ type: 'fill', drawable: true, presetId: expect.any(String) });
  // the pattern shows (the default pattern is not plain white)
  const px = await composite(page);
  expect(px.some((v, i) => i % 4 !== 3 && v < 250)).toBe(true);
  await page.evaluate(() => (window.__pigmentTest.nextSavePath = 'mem:/pattern.pigment'));
  expect(await runAwait(page, 'file:save-as')).toBe(true);
  await expect.poll(() => page.evaluate(() => !!window.__pigmentTest.written['mem:/pattern.pigment'])).toBe(true);
  // a paint whose canvas was lost (a JSON copy) is rebuilt from the library entry it names
  const again = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const cur = app.patterns.current();
    await app.commands.run('layer:new-fill', { kind: 'pattern', paint: { type: 'pattern', pattern: { canvas: {}, presetId: cur.id, scale: 2, angle: 0, link: true, origin: [0, 0] } } }, 'api');
    const p = app.doc.active.paint.pattern;
    return { drawable: typeof p.canvas?.getContext === 'function', scale: p.scale };
  });
  expect(again).toEqual({ drawable: true, scale: 2 });
  expect(errors).toEqual([]);
});

test('an action records the text the Type tool makes and the shape a shape tool draws, and plays them back', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 300, height: 200, background: 'white' });
  await page.evaluate(() => {
    const app = window.pigmentApp;
    window.__toasts = [];
    const t = app.dialogs.toast.bind(app.dialogs);
    app.dialogs.toast = (m, o) => (window.__toasts.push(m), t(m, o));
    const e = app.actions;
    e.record(e.newAction({ name: 'Make layers' }));
    app.tools.activate('type-horizontal');
  });
  const p = await screenPoint(page, 30, 60);
  await page.mouse.click(p.x, p.y);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.active?.type)).toBe('text');
  await page.keyboard.type('Hello');
  await page.keyboard.press('Control+Enter');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.tools.active?.session ?? null)).toBe(null);
  await page.evaluate(() => window.pigmentApp.tools.activate('shape-rect'));
  await drag(page, [150, 100], [260, 180], { steps: 6 });
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.active?.type)).toBe('shape');
  await page.evaluate(() => window.pigmentApp.commands.run('layer:shape-properties', { props: { radii: [10, 10, 10, 10] } }, 'menu'));
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.history.entries.at(-1)?.label)).toBe('Shape Properties');
  const steps = await page.evaluate(() => {
    const e = window.pigmentApp.actions;
    e.stop();
    for (const s of e.sets) for (const a of s.actions) if (a.name === 'Make layers') return a.steps.map((x) => x.label);
    return null;
  });
  expect(steps).toEqual(['Make Text Layer “Hello”', 'Make Shape Layer “Rectangle 1”', expect.stringContaining('Shape Properties')]);
  expect(await page.evaluate(() => window.__toasts.filter((m) => /not recorded/.test(m)))).toEqual([]);
  const recorded = await composite(page);
  await newDoc(page, { width: 300, height: 200, background: 'white' });
  const played = await page.evaluate(() => window.pigmentApp.commands.run('actions:play', { action: 'Make layers' }, 'api'));
  expect(played?.ok).toBe(true);
  expect(await page.evaluate(() => window.pigmentApp.doc.layers().map((l) => `${l.name}/${l.type}`))).toEqual(['Background/raster', 'Hello/text', 'Rectangle 1/shape']);
  expect(await page.evaluate(() => window.pigmentApp.doc.active.shapeProps?.radii)).toEqual([10, 10, 10, 10]);
  await expect.poll(async () => countDiff(recorded, await composite(page))).toBe(0);
  // undoing the shape while recording takes its step back out
  await page.evaluate(() => {
    const e = window.pigmentApp.actions;
    e.record(e.newAction({ name: 'Undone' }));
    window.pigmentApp.tools.activate('shape-rect');
  });
  await drag(page, [20, 20], [80, 80], { steps: 4 });
  await runAwait(page, 'edit:undo');
  const undone = await page.evaluate(() => {
    const e = window.pigmentApp.actions;
    e.stop();
    for (const s of e.sets) for (const a of s.actions) if (a.name === 'Undone') return a.steps.length;
    return null;
  });
  expect(undone).toBe(0);
  expect(errors).toEqual([]);
});

test('a PSD keeps Hue/Saturation ranges and the guides, and says which adjustments and the ruler origin it drops', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 160, height: 120, background: 'white' });
  const before = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { RasterLayer, createCanvas } = await import('/lib/document.js');
    const d = app.doc;
    const c = createCanvas(160, 120);
    const g = c.getContext('2d');
    for (let i = 0; i < 6; i++) {
      g.fillStyle = ['#e02020', '#e0e020', '#20e020', '#20e0e0', '#2020e0', '#e020e0'][i];
      g.fillRect(i * 26, 0, 26, 120);
    }
    d.add(new RasterLayer({ name: 'Bars', canvas: c, x: 0, y: 0 }));
    await app.commands.run('layer:new-adjustment', { kind: 'hue-saturation', params: { ranges: [{ base: 'reds', hue: 40, saturation: -30, lightness: 0 }, { base: 'blues', bounds: [190, 220, 260, 290], hue: -20, saturation: 20, lightness: 10 }] } }, 'api');
    await app.commands.run('layer:new-adjustment', { kind: 'grain', params: { amount: 10, size: 25, seed: 3 } }, 'api');
    app.doc.layers().find((l) => l.kind === 'grain').visible = false;
    await app.commands.run('view:new-guide', { axis: 'x', pos: 40 }, 'api');
    await app.commands.run('view:new-guide', { axis: 'y', pos: 30.5 }, 'api');
    await app.commands.run('view:ruler-origin', { x: 10, y: 12 }, 'api');
    d.changed('props');
    return { guides: d.guides.map((x) => [x.axis, x.pos]) };
  });
  const picture = await composite(page);
  await page.evaluate(() => (window.__pigmentTest.nextSavePath = 'mem:/ranges.psd'));
  expect(await runAwait(page, 'file:save-as')).toBe(true);
  await expect(page.locator('#toasts .toast', { hasText: '1 adjustment layer (Grain) has no PSD equivalent' })).toBeVisible();
  await expect(page.locator('#toasts .toast', { hasText: 'PSD does not keep the ruler origin' })).toBeVisible();
  await page.evaluate(() => (window.__pigmentTest.files['mem:/ranges-back.psd'] = window.__pigmentTest.written['mem:/ranges.psd']));
  await runAwait(page, 'file:open-paths', ['mem:/ranges-back.psd']);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.path)).toBe('mem:/ranges-back.psd');
  const back = await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    return { guides: d.guides.map((x) => [x.axis, x.pos]), ranges: d.layers().find((l) => l.kind === 'hue-saturation')?.params.ranges };
  });
  expect(back.guides).toEqual(before.guides);
  expect(back.ranges).toEqual([
    { base: 'reds', bounds: [315, 345, 15, 45], hue: 40, saturation: -30, lightness: 0 },
    { base: 'blues', bounds: [190, 220, 260, 290], hue: -20, saturation: 20, lightness: 10 },
  ]);
  await expect.poll(async () => countDiff(picture, await composite(page))).toBe(0);
  expect(errors).toEqual([]);
});

test('a styled layer with Blend If on a document-sized canvas is blended only where it has pixels, with the same result', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 1200, height: 900, background: 'white' });
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { RasterLayer, createCanvas } = await import('/lib/document.js');
    const { Compositor } = await import('/lib/compositor.js');
    const d = app.doc;
    const c = createCanvas(1200, 900);
    const g = c.getContext('2d');
    g.fillStyle = '#3060c0';
    g.fillRect(100, 100, 160, 120);
    const l = new RasterLayer({ name: 'Small', canvas: c, x: 0, y: 0 });
    d.add(l);
    d.setActive(l);
    await app.commands.run('layer:style', { styles: { dropShadow: [{ enabled: true, size: 12, distance: 10, angle: 120, opacity: 0.7, blend: 'multiply', color: '#000000' }], stroke: { enabled: true, size: 6, position: 'outside', fillType: 'color', color: '#ff0000' } } }, 'api');
    l.blending = { blendIf: { gray: { this: [0, 0, 200, 240], under: [0, 0, 255, 255] } } };
    l.fillOpacity = 0.8;
    l.touch();
    d.changed('props', { layer: l });
    const comp = d.view.compositor;
    comp.composite(d); // fills the style cache
    // an edit elsewhere: the next composite reads back only around the styled layer
    d.root.children[0].opacity = 0.9;
    d.root.children[0].touch();
    d.changed('props');
    const proto = CanvasRenderingContext2D.prototype;
    const get = proto.getImageData;
    let read = 0;
    proto.getImageData = function (x, y, w, h, ...rest) {
      read += w * h;
      return get.call(this, x, y, w, h, ...rest);
    };
    let px;
    try {
      px = comp.composite(d).getContext('2d').getImageData(0, 0, d.width, d.height).data;
    } finally {
      proto.getImageData = get;
    }
    // the same document through a compositor that blends the whole canvas
    const ref = new Compositor();
    ref.frozenBounds = () => undefined;
    const want = ref.composite(d).getContext('2d').getImageData(0, 0, d.width, d.height).data;
    let n = 0;
    for (let i = 0; i < px.length; i++) if (Math.abs(px[i] - want[i]) > 2) n++;
    return { read, area: d.width * d.height, n };
  });
  expect(r.n).toBe(0);
  // the final read of the whole result is one area; the layer's blend reads a few small regions
  expect(r.read).toBeLessThan(r.area * 1.5);
  expect(errors).toEqual([]);
});
