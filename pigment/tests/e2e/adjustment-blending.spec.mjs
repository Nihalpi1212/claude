// Blending Options on adjustment layers (0.4, the hunt's deferred paints-adjust item). Photoshop gives an adjustment
// layer Blend If (This Layer reads the adjusted result, Underlying Layer the backdrop under it), Fill opacity (which
// scales the adjustment as Opacity does), the channel restriction and its blend mode: the adjusted pixels are mixed
// back into the backdrop by fill × opacity × mask × Blend If, in the layer's mode. These tests set them through the
// Layer Style dialog and the Layers panel, check the canvas in 8 and 16 bits, that Merge Down, Merge Visible, Stamp
// Visible and Flatten Image give what the canvas shows (in float in a 16-bit document), undo, Copy and Paste Layer
// Style, the fx menu, and that .pigment and PSD files keep the settings.
import { test, expect } from '@playwright/test';
import { openApp, newDoc, run, runAwait, historyLength, confirmDialog } from './helpers.mjs';

const dialog = (page) => page.locator('.style-dialog');
const pane = (page) => page.locator('.style-dialog .style-pane');
const panel = (page) => page.locator('[data-panel="layers"]');

/** A document of a grey ramp (column x has value x; with `color`, red = x, green = 255 - x, blue = 128), and window.__ab. */
async function rampDoc(page, { depth = 8, color = false, height = 40 } = {}) {
  await newDoc(page, { width: 256, height, background: 'white', depth });
  await page.evaluate(async ({ color }) => {
    const app = window.pigmentApp;
    const { RasterLayer, AdjustmentLayer, createCanvas } = await import('/lib/document.js');
    const { setLayerProps } = await import('/lib/layer-ops.js');
    const d = app.doc;
    const bg = d.root.children[0];
    const g = bg.canvas.getContext('2d');
    for (let x = 0; x < 256; x++) {
      g.fillStyle = color ? `rgb(${x},${255 - x},128)` : `rgb(${x},${x},${x})`;
      g.fillRect(x, 0, 1, bg.canvas.height);
    }
    bg.touch();
    d.changed('pixels', { layer: bg });
    window.__ab = {
      RasterLayer, AdjustmentLayer, createCanvas, setLayerProps,
      composite(doc = app.doc) {
        return (doc.view?.compositor ?? app.view.compositor).composite(doc).getContext('2d').getImageData(0, 0, doc.width, doc.height).data;
      },
      /** RGBA of the canvas at (x, 5). */
      px(x, y = 5) {
        return Array.from(app.doc.view.compositor.composite(app.doc).getContext('2d').getImageData(x, y, 1, 1).data);
      },
      maxDiff(a, b) {
        let m = 0;
        for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
        return m;
      },
      /** An adjustment layer added on top (with the white mask New Adjustment Layer gives it) and made active. */
      adjust(kind, params, props = {}) {
        const l = new AdjustmentLayer({ name: props.name ?? kind, kind, params, ...props });
        const m = createCanvas(d.width, d.height);
        const mg = m.getContext('2d');
        mg.fillStyle = '#fff';
        mg.fillRect(0, 0, d.width, d.height);
        l.mask = { canvas: m, enabled: true, linked: true };
        app.doc.add(l, app.doc.root, app.doc.root.children.length);
        app.doc.setActive(l);
        return l;
      },
      /** The float composite as 8-bit values (lib/depth.js flattenDeep), with exact and reason. */
      deep(doc = app.doc) {
        const f = app.deep.flatten(doc);
        const k = f.type === 'f32' ? 255 : 1 / 257;
        return { exact: f.exact, reason: f.reason, data: Array.from(f.data, (v) => Math.max(0, Math.min(255, Math.round(v * k)))) };
      },
    };
  }, { color });
}

const CURVE_HALF = { rgb: [[0, 0], [255, 128]] };

test('Curves with Blend If on the highlights only, set in Blending Options, is one step and undoes', async ({ page }) => {
  const errors = await openApp(page);
  await rampDoc(page);
  const plain = await page.evaluate((params) => {
    window.__ab.adjust('curves', params, { name: 'Curves' });
    return [100, 200, 240].map((x) => window.__ab.px(x)[0]);
  }, CURVE_HALF);
  expect(plain[2]).toBeLessThan(125);
  // the fx menu offers Blending Options and the style commands, not the effects
  const menu = await page.evaluate(() => window.pigmentApp.layerStyleMenu().map((i) => i.label ?? '-'));
  expect(menu).toEqual(['Blending Options…', '-', 'Copy Layer Style', 'Paste Layer Style', 'Clear Layer Style']);
  expect(await page.evaluate(() => window.pigmentApp.commands.isEnabled('layer:style-dropShadow'))).toBe(false);
  const h0 = await historyLength(page);
  await run(page, 'layer:style', 'dialog');
  await expect(dialog(page)).toBeVisible();
  // the page only: no effects, no knockout or check boxes, which act on pixels and effects an adjustment layer has none of
  await expect(page.locator('.style-dialog .style-list label')).toHaveText(['Blending Options']);
  await expect(pane(page).locator('[data-key="knockout"]')).toHaveCount(0);
  await expect(pane(page).locator('[data-key="interiorAsGroup"]')).toHaveCount(0);
  // Underlying Layer black slider split 180 / 220: shadows of the backdrop untouched, highlights adjusted, a ramp between
  const under = (i) => pane(page).locator(`.bif-row[data-which="under"] input[data-key="under-${i}"]`);
  for (const [i, v] of [[1, '220'], [0, '180']]) {
    await under(i).fill(v);
    await under(i).dispatchEvent('change');
  }
  await confirmDialog(page);
  expect(await historyLength(page)).toBe(h0 + 1);
  const after = await page.evaluate(() => [100, 179, 200, 240].map((x) => window.__ab.px(x)));
  expect(after[0]).toEqual([100, 100, 100, 255]);
  expect(after[1]).toEqual([179, 179, 179, 255]);
  expect(Math.abs(after[2][0] - (200 + (plain[1] - 200) * 0.5))).toBeLessThanOrEqual(1);
  expect(after[3][0]).toBe(plain[2]);
  expect(await page.evaluate(() => window.pigmentApp.doc.active.blending.blendIf.gray.under)).toEqual([180, 220, 255, 255]);
  await runAwait(page, 'edit:undo');
  expect(await page.evaluate(() => [100, 200, 240].map((x) => window.__ab.px(x)[0]))).toEqual(plain);
  await runAwait(page, 'edit:redo');
  expect(await page.evaluate(() => window.__ab.px(100))).toEqual([100, 100, 100, 255]);
  // This Layer reads the adjusted pixels: white slider at 60 hides where the curve's result is above 60
  await page.evaluate(() => {
    const ab = window.__ab, a = window.pigmentApp.doc.active;
    ab.setLayerProps(window.pigmentApp, a, { blending: { blendIf: { gray: { this: [0, 0, 60, 60], under: [0, 0, 255, 255] } } } }, 'Blend If');
  });
  const thisLayer = await page.evaluate(() => [100, 130].map((x) => window.__ab.px(x)[0]));
  expect(thisLayer[0]).toBe(50); // adjusted to 50: shown
  expect(thisLayer[1]).toBe(130); // adjusted to 65: hidden
  expect(errors).toEqual([]);
});

test('Hue/Saturation with Fill 50 % from the Layers panel mixes as Opacity 50 % does, and Shift+digit sets it', async ({ page }) => {
  const errors = await openApp(page);
  await rampDoc(page, { color: true });
  const full = await page.evaluate(() => {
    window.__ab.adjust('hue-saturation', { hue: 120, saturation: 0, lightness: 0 }, { name: 'Hue' });
    return window.__ab.composite();
  });
  await page.evaluate(() => window.pigmentApp.panels.show('layers', { reveal: true }));
  const fill = panel(page).locator('input[data-fill]');
  await expect(fill).toBeEnabled();
  const h0 = await historyLength(page);
  await fill.fill('50');
  await fill.press('Enter');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.active.fillOpacity)).toBe(0.5);
  // (Undo in a focused text field undoes the typing)
  await fill.blur();
  expect(await historyLength(page)).toBe(h0 + 1);
  const r = await page.evaluate(() => {
    const ab = window.__ab, a = window.pigmentApp.doc.active;
    const half = ab.composite();
    // the same layer at Opacity 50 % and Fill 100 %
    Object.assign(a, { opacity: 0.5, fillOpacity: 1 });
    a.touch();
    const viaOpacity = ab.composite();
    Object.assign(a, { opacity: 1, fillOpacity: 0.5 });
    a.touch();
    const bg = window.pigmentApp.doc.root.children[0].canvas.getContext('2d').getImageData(0, 0, 256, 1).data;
    return { same: ab.maxDiff(half, viaOpacity), at: Array.from(half.slice(100 * 4, 100 * 4 + 4)), bg: Array.from(bg.slice(100 * 4, 100 * 4 + 4)) };
  });
  expect(r.same).toBe(0);
  for (let c = 0; c < 3; c++) expect(Math.abs(r.at[c] - (r.bg[c] + full[100 * 4 + c]) / 2)).toBeLessThanOrEqual(1);
  await runAwait(page, 'edit:undo');
  expect(await page.evaluate(() => window.pigmentApp.doc.active.fillOpacity)).toBe(1);
  expect(await page.evaluate((f) => window.__ab.maxDiff(window.__ab.composite(), f), full)).toBe(0);
  // the fill keys work on an adjustment layer (they skip groups only)
  await page.evaluate(() => {
    window.pigmentApp.tools.activate('move');
    document.activeElement?.blur();
  });
  await page.keyboard.press('Shift+3');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.active.fillOpacity)).toBe(0.3);
  expect(errors).toEqual([]);
});

test('a Levels restricted to the red and blue channels leaves green alone', async ({ page }) => {
  const errors = await openApp(page);
  await rampDoc(page, { color: true });
  const plain = await page.evaluate(() => {
    window.__ab.adjust('levels', { rgb: { inBlack: 0, inWhite: 128, gamma: 1, outBlack: 0, outWhite: 255 } }, { name: 'Levels' });
    return [30, 100].map((x) => window.__ab.px(x));
  });
  await run(page, 'layer:style', 'dialog');
  await expect(dialog(page)).toBeVisible();
  await pane(page).locator('input[data-key="channel-g"]').uncheck();
  await confirmDialog(page);
  const after = await page.evaluate(() => [30, 100].map((x) => window.__ab.px(x)));
  // red and blue as the Levels makes them, green as the backdrop has it (255 - x)
  expect(after[0]).toEqual([plain[0][0], 225, plain[0][2], 255]);
  expect(after[1]).toEqual([plain[1][0], 155, plain[1][2], 255]);
  expect(plain[0][1]).not.toBe(225);
  await runAwait(page, 'edit:undo');
  expect(await page.evaluate(() => window.__ab.px(30))).toEqual(plain[0]);
  expect(errors).toEqual([]);
});

/**
 * The adjustment layers of the tests above over an opaque 'Mid' layer: a Levels clipped to it (channels and Blend If),
 * the Curves with Blend If directly above that, Hue/Saturation at Fill 50 % and a Multiply Levels on red and green.
 */
const STACK = async (page) => page.evaluate((curve) => {
  const app = window.pigmentApp, ab = window.__ab, d = app.doc;
  const c = ab.createCanvas(d.width, d.height);
  const g = c.getContext('2d');
  const gr = g.createLinearGradient(0, 0, d.width, 0);
  gr.addColorStop(0, '#203040');
  gr.addColorStop(1, '#f0e0a0');
  g.fillStyle = gr;
  g.fillRect(0, 0, d.width, d.height);
  // opaque: a merge renders against transparency what the canvas draws over the layers below (as in Photoshop)
  d.add(new ab.RasterLayer({ name: 'Mid', canvas: c, x: 0, y: 0 }), d.root, d.root.children.length);
  ab.adjust('levels', { rgb: { inBlack: 20, inWhite: 200, gamma: 1, outBlack: 0, outWhite: 255 } }, { name: 'Clipped', clip: true, blending: { channels: { r: true, g: false, b: true }, blendIf: { gray: { this: [0, 0, 255, 255], under: [0, 0, 150, 230] } } } });
  ab.adjust('curves', curve, { name: 'Curves', blending: { blendIf: { gray: { this: [0, 0, 255, 255], under: [100, 180, 255, 255] } } } });
  ab.adjust('hue-saturation', { hue: 60, saturation: 20, lightness: 0 }, { name: 'Hue', fillOpacity: 0.5 });
  ab.adjust('levels', { rgb: { inBlack: 0, inWhite: 200, gamma: 1.2, outBlack: 0, outWhite: 255 } }, { name: 'Levels', blend: 'multiply', opacity: 0.8, blending: { channels: { r: true, g: true, b: false } } });
  return ab.composite();
}, CURVE_HALF);

for (const depth of [8, 16]) {
  test(`${depth} bits: Merge Down, Merge Visible, Stamp Visible and Flatten Image match the canvas`, async ({ page }) => {
    const errors = await openApp(page);
    await rampDoc(page, { depth, height: 24 });
    const before = await STACK(page);
    // the Blending Options change the picture (without them it is another one)
    expect(await page.evaluate((b) => {
      const ab = window.__ab, adj = window.pigmentApp.doc.layers().filter((l) => l.type === 'adjustment');
      const kept = adj.map((l) => ({ l, blend: l.blend, fill: l.fillOpacity, blending: l.blending }));
      for (const l of adj) Object.assign(l, { blend: 'normal', fillOpacity: 1, blending: null }), l.touch();
      const plain = ab.composite();
      for (const k of kept) Object.assign(k.l, { blend: k.blend, fillOpacity: k.fill, blending: k.blending }), k.l.touch();
      return ab.maxDiff(plain, b);
    }, before)).toBeGreaterThan(20);
    let before16 = null;
    if (depth > 8) {
      // the float composite: exact (Blend If, Fill, the channels, Multiply in float), and the picture the canvas shows
      const f = await page.evaluate(() => window.__ab.deep());
      before16 = f.data;
      expect(f.reason).toBeNull();
      expect(f.exact).toBe(true);
      let m = 0, off = 0;
      for (let i = 0; i < f.data.length; i++) {
        const e = Math.abs(f.data[i] - before[i]);
        m = Math.max(m, e);
        if (e > 2) off++;
      }
      // the 8-bit canvas rounds after every adjustment, float does not: a level or two (three at most) apart
      expect(m).toBeLessThanOrEqual(3);
      expect(off).toBeLessThan(f.data.length * 0.01);
    }
    const activate = (name) => page.evaluate((n) => {
      const d = window.pigmentApp.doc;
      d.setActive(d.layers().find((l) => l.name === n));
    }, name);
    /** Runs a merge and checks the result: a raster layer (with float pixels in a deep document) and the same picture. */
    const check = async (cmd, active) => {
      await activate(active);
      const n0 = await page.evaluate(() => window.pigmentApp.doc.layers().length);
      await runAwait(page, cmd);
      const r = await page.evaluate(([b, b16]) => {
        const d = window.pigmentApp.doc, a = d.active, ab = window.__ab;
        return { diff: ab.maxDiff(ab.composite(), b), diff16: b16 ? ab.maxDiff(ab.deep().data, b16) : 0, n: d.layers().length, deep: !!a?.deep, type: a?.type };
      }, [before, before16]);
      expect(r.n, cmd).not.toBe(n0);
      expect(r.type, cmd).toBe('raster');
      // a deep document's result holds the float composite: the float picture is the same, and the canvas (which runs
      // the adjustments above a merged layer at 8 bits on its float values) within a few levels
      expect(r.diff, cmd).toBeLessThanOrEqual(depth > 8 ? 4 : 1);
      expect(r.diff16, cmd).toBeLessThanOrEqual(1);
      // in a deep document the result takes the float composite (lib/depth.js MERGES, STAMPS and Flatten)
      if (depth > 8) expect(r.deep, cmd).toBe(true);
    };
    const undone = async (steps) => {
      for (let i = 0; i < steps; i++) await runAwait(page, 'edit:undo');
      expect(await page.evaluate((b) => window.__ab.maxDiff(window.__ab.composite(), b), before)).toBe(0);
    };
    // Merge Down of the clipped Levels onto its base, then of the Curves onto that: Blend If reads the layer below
    await check('layer:merge-down', 'Clipped');
    await check('layer:merge-down', 'Curves');
    await undone(2);
    await check('layer:merge-visible', 'Levels');
    await undone(1);
    await check('layer:stamp-visible', 'Levels');
    // the stamped layer alone is the picture
    expect(await page.evaluate((b) => {
      const d = window.pigmentApp.doc;
      return window.__ab.maxDiff(d.active.canvas.getContext('2d').getImageData(0, 0, d.width, d.height).data, b);
    }, before)).toBeLessThanOrEqual(depth > 8 ? 3 : 1);
    await undone(1);
    await check('image:flatten', 'Levels');
    await undone(1);
    expect(errors).toEqual([]);
  });
}

test('16 bits: the canvas and the float composite apply Blend If, and modes float has no maths for composite at 8 bits', async ({ page }) => {
  const errors = await openApp(page);
  await rampDoc(page, { depth: 16 });
  const r = await page.evaluate((curve) => {
    const ab = window.__ab;
    const l = ab.adjust('curves', curve, { name: 'Curves', blending: { blendIf: { gray: { this: [0, 0, 255, 255], under: [180, 220, 255, 255] } } } });
    const f = ab.deep();
    const out = { canvas: [100, 240].map((x) => ab.px(x)[0]), deep: [100, 240].map((x) => f.data[(5 * 256 + x) * 4]), exact: f.exact };
    l.blend = 'overlay';
    l.touch();
    const o = ab.deep();
    out.overlay = { exact: o.exact, reason: o.reason, diff: ab.maxDiff(o.data, ab.composite()) };
    return out;
  }, CURVE_HALF);
  expect(r.canvas[0]).toBe(100);
  expect(r.canvas[1]).toBeLessThan(125);
  expect(r.deep[0]).toBe(100);
  expect(Math.abs(r.deep[1] - r.canvas[1])).toBeLessThanOrEqual(1);
  expect(r.exact).toBe(true);
  expect(r.overlay.exact).toBe(false);
  expect(r.overlay.reason).toContain('overlay blend mode');
  expect(r.overlay.diff).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});

test('.pigment and PSD keep the blending; Copy and Paste Layer Style carry it', async ({ page }) => {
  const errors = await openApp(page);
  await rampDoc(page, { color: true });
  const r = await page.evaluate(async (curve) => {
    const app = window.pigmentApp, ab = window.__ab, d = app.doc;
    const { writePigment, readPigment, writePsdDocument, readPsdDocument } = await import('/lib/io.js');
    const { Compositor } = await import('/lib/compositor.js');
    const blendIf = { gray: { this: [0, 0, 255, 255], under: [60, 140, 255, 255] } };
    const curves = ab.adjust('curves', curve, { name: 'Curves', fillOpacity: 0.6, blend: 'screen', blending: { blendIf } });
    const before = ab.composite();
    const out = {};
    const back = await readPigment(await writePigment(d));
    const bc = back.layers().find((l) => l.name === 'Curves');
    out.pigment = { diff: ab.maxDiff(new Compositor().composite(back).getContext('2d').getImageData(0, 0, d.width, d.height).data, before), fill: bc.fillOpacity, blend: bc.blend, under: bc.blending?.blendIf?.gray?.under };
    const psd = readPsdDocument(writePsdDocument(d, app.view.compositor));
    const pc = psd.layers().find((l) => l.type === 'adjustment');
    out.psd = { diff: ab.maxDiff(new Compositor().composite(psd).getContext('2d').getImageData(0, 0, d.width, d.height).data, before), fill: Math.round(pc.fillOpacity * 100), blend: pc.blend, under: pc.blending?.blendIf?.gray?.under };
    // Copy Layer Style on the adjustment layer, Paste on another one: the mode, Fill and Blend If go across
    await app.commands.run('layer:copy-style', undefined, 'api');
    const inv = ab.adjust('invert', {}, { name: 'Invert' });
    out.pasteEnabled = app.commands.isEnabled('layer:paste-style');
    await app.commands.run('layer:paste-style', undefined, 'api');
    out.pasted = { fill: inv.fillOpacity, blend: inv.blend, under: inv.blending?.blendIf?.gray?.under, styles: inv.styles ?? null };
    // a raster layer's style with effects and knockout: the adjustment layer takes its blending options only
    const ras = new ab.RasterLayer({ name: 'R', canvas: ab.createCanvas(10, 10), x: 0, y: 0, blend: 'multiply', fillOpacity: 0.4, styles: { dropShadow: { enabled: true } }, blending: { knockout: 'deep', channels: { r: false } } });
    d.add(ras, d.root, 1);
    d.setActive(ras);
    await app.commands.run('layer:copy-style', undefined, 'api');
    d.setActive(inv);
    await app.commands.run('layer:paste-style', undefined, 'api');
    out.fromRaster = { styles: inv.styles ?? null, blend: inv.blend, fill: inv.fillOpacity, blending: inv.blending };
    await app.commands.run('layer:clear-style', undefined, 'api');
    out.cleared = { blend: inv.blend, fill: inv.fillOpacity, blending: inv.blending ?? null };
    return out;
  }, CURVE_HALF);
  expect(r.pigment).toEqual({ diff: 0, fill: 0.6, blend: 'screen', under: [60, 140, 255, 255] });
  expect(r.psd.diff).toBeLessThanOrEqual(1);
  expect(r.psd).toMatchObject({ fill: 60, blend: 'screen', under: [60, 140, 255, 255] });
  expect(r.pasteEnabled).toBe(true);
  expect(r.pasted).toEqual({ fill: 0.6, blend: 'screen', under: [60, 140, 255, 255], styles: null });
  expect(r.fromRaster).toEqual({ styles: null, blend: 'multiply', fill: 0.4, blending: { channels: { r: false } } });
  expect(r.cleared).toEqual({ blend: 'normal', fill: 1, blending: null });
  expect(errors).toEqual([]);
});

test('a PSD keeps an adjustment layer\'s Blend If and says when its channel restriction is not kept', async ({ page }) => {
  const errors = await openApp(page);
  await rampDoc(page, { color: true });
  const save = async (path) => {
    await page.evaluate((p) => (window.__pigmentTest.nextSavePath = p), path);
    await runAwait(page, 'file:save-as');
    await expect.poll(() => page.evaluate((p) => !!window.__pigmentTest.written[p], path)).toBe(true);
  };
  const notice = page.locator('#toasts .toast', { hasText: '1 layer with layer effects or Blending Options was saved without them' });
  // Blend If alone goes into the file (the layer record's blending ranges): no notice
  await page.evaluate(() => window.__ab.adjust('invert', {}, { name: 'Invert', blending: { blendIf: { gray: { this: [0, 0, 255, 255], under: [0, 0, 150, 200] } } } }));
  await save('mem:/blendif.psd');
  const ranges = await page.evaluate(async () => {
    const { readPsd } = await import('ag-psd');
    const raw = readPsd(window.__pigmentTest.written['mem:/blendif.psd'], { skipThumbnail: true, skipLayerImageData: true, skipCompositeImageData: true });
    return raw.children.find((c) => c.adjustment)?.blendingRanges?.compositeGraphBlendDestinationRange ?? null;
  });
  expect(ranges).toEqual([0, 0, 150, 200]);
  await expect(notice).toHaveCount(0);
  // the channel restriction is not written: the notice says so
  await page.evaluate(() => {
    const a = window.pigmentApp.doc.active;
    a.blending = { ...a.blending, channels: { r: true, g: false, b: true } };
    a.touch();
  });
  await save('mem:/adj.psd');
  await expect(notice).toBeVisible();
  expect(errors).toEqual([]);
});
