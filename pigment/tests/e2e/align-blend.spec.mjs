// Auto-Align Layers, Auto-Blend Layers, Photomerge, Load Files into Stack, Statistics and Stack Mode.
import { test, expect } from '@playwright/test';
import { openApp, newDoc, run, runAwait, pixel, confirmDialog, historyLength } from './helpers.mjs';

const COMMANDS = ['edit:auto-align', 'edit:auto-blend', 'file:automate-photomerge', 'file:script-load-stack', 'file:script-statistics', 'layer:stack-mode'];

/**
 * Page-side helpers (window.__ab): a busy synthetic scene, layers painted from canvases, PNG files in the
 * in-memory bridge, and pixel comparisons.
 */
async function installHelpers(page) {
  await page.evaluate(() => {
    const canvasOf = (w, h) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      c.getContext('2d', { willReadFrequently: true });
      return c;
    };
    const ab = {
      canvasOf,
      /** Random opaque rectangles on grey: plenty of corners for the feature detector. */
      scene(w, h, seed = 7, count = 420) {
        let s = seed >>> 0;
        const rnd = () => {
          s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
          return s / 4294967296;
        };
        const c = canvasOf(w, h);
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#787878';
        ctx.fillRect(0, 0, w, h);
        for (let k = 0; k < count; k++) {
          ctx.fillStyle = `rgb(${(rnd() * 255) | 0},${(rnd() * 255) | 0},${(rnd() * 255) | 0})`;
          ctx.fillRect((rnd() * (w - 20)) | 0, (rnd() * (h - 20)) | 0, 6 + ((rnd() * 40) | 0), 6 + ((rnd() * 40) | 0));
        }
        return c;
      },
      /** A w × h canvas showing `src` drawn through draw(ctx). */
      paint(w, h, draw) {
        const c = canvasOf(w, h);
        draw(c.getContext('2d'));
        return c;
      },
      /** Replaces a raster layer's pixels (test setup, not an undo step). */
      setLayer(layer, canvas, x = 0, y = 0) {
        layer.canvas = canvas;
        layer.x = x;
        layer.y = y;
        layer.touch();
        window.pigmentApp.doc.changed('pixels', { layer });
      },
      /** Adds a raster layer on top showing `canvas`; returns it. */
      async addLayer(name, canvas, x = 0, y = 0) {
        const app = window.pigmentApp;
        await app.commands.run('layer:new', { name }, 'api');
        const layer = app.doc.active;
        ab.setLayer(layer, canvas, x, y);
        return layer;
      },
      select(layers) {
        const d = window.pigmentApp.doc;
        d.selected = new Set(layers);
        d.active = layers[layers.length - 1];
        d.changed('active', { layer: d.active });
      },
      async png(path, canvas) {
        const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
        window.__pigmentTest.files[path] = new Uint8Array(await blob.arrayBuffer());
        return path;
      },
      /** Mean absolute difference (per colour channel) between two layers where both are opaque inside rect. */
      layerDiff(a, b, rect) {
        const da = a.canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, a.canvas.width, a.canvas.height);
        const db = b.canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, b.canvas.width, b.canvas.height);
        let sum = 0, count = 0;
        for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) {
          const ax = x - a.x, ay = y - a.y, bx = x - b.x, by = y - b.y;
          if (ax < 0 || ay < 0 || bx < 0 || by < 0 || ax >= da.width || ay >= da.height || bx >= db.width || by >= db.height) continue;
          const i = (ay * da.width + ax) * 4, j = (by * db.width + bx) * 4;
          if (da.data[i + 3] < 255 || db.data[j + 3] < 255) continue;
          sum += Math.abs(da.data[i] - db.data[j]) + Math.abs(da.data[i + 1] - db.data[j + 1]) + Math.abs(da.data[i + 2] - db.data[j + 2]);
          count++;
        }
        return { mean: count ? sum / (count * 3) : -1, count };
      },
      /** The flattened document as ImageData. */
      flat() {
        const d = window.pigmentApp.doc;
        const c = d.view.compositor.composite(d);
        return c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, d.width, d.height);
      },
      /** Mean absolute colour difference between the flattened document and a canvas drawn at (ox, oy), over opaque pixels of rect. */
      flatDiff(canvas, ox, oy, rect) {
        const f = ab.flat();
        const r = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
        let sum = 0, count = 0;
        for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) {
          const i = (y * f.width + x) * 4, j = ((y - oy) * r.width + (x - ox)) * 4;
          if (f.data[i + 3] < 255) continue;
          sum += Math.abs(f.data[i] - r.data[j]) + Math.abs(f.data[i + 1] - r.data[j + 1]) + Math.abs(f.data[i + 2] - r.data[j + 2]);
          count++;
        }
        return { mean: count ? sum / (count * 3) : -1, count };
      },
      maskAt(layer, x, y) {
        return layer.mask ? layer.mask.canvas.getContext('2d', { willReadFrequently: true }).getImageData(x, y, 1, 1).data[3] : null;
      },
      info() {
        const d = window.pigmentApp.doc;
        return { name: d.name, size: [d.width, d.height], layers: d.layers().map((l) => ({ name: l.name, type: l.type, x: l.x, y: l.y, w: l.canvas?.width ?? null, h: l.canvas?.height ?? null, mask: !!l.mask, visible: l.visible })) };
      },
    };
    window.__ab = ab;
  });
}

const info = (page) => page.evaluate(() => window.__ab.info());
const lastToast = (page) => page.locator('.toast').last();

test('the six commands are registered; Auto-Align and Auto-Blend need two selected pixel layers', async ({ page }) => {
  const errors = await openApp(page);
  await installHelpers(page);
  const before = await page.evaluate((ids) => ids.map((c) => [window.pigmentApp.commands.has(c), window.pigmentApp.commands.isEnabled(c), (window.pigmentApp.stubbed ?? []).includes(c)]), COMMANDS);
  // registered, not stubs; the document commands are disabled without a document, the file commands are not
  expect(before).toEqual([[true, false, false], [true, false, false], [true, true, false], [true, true, false], [true, true, false], [true, false, false]]);
  await newDoc(page, { width: 200, height: 150 });
  expect(await page.evaluate(() => [window.pigmentApp.commands.isEnabled('edit:auto-align'), window.pigmentApp.commands.isEnabled('edit:auto-blend')])).toEqual([false, false]);
  await page.evaluate(async () => {
    const d = window.pigmentApp.doc, bg = d.active;
    const top = await window.__ab.addLayer('Top', window.__ab.scene(200, 150));
    window.__ab.select([bg, top]);
  });
  expect(await page.evaluate(() => [window.pigmentApp.commands.isEnabled('edit:auto-align'), window.pigmentApp.commands.isEnabled('edit:auto-blend'), window.pigmentApp.commands.isEnabled('layer:stack-mode')])).toEqual([true, true, false]);
  // two layers without common content: nothing moves, the user is told, nothing is recorded
  const n = await historyLength(page);
  await runAwait(page, 'edit:auto-align', { projection: 'reposition' });
  await expect(lastToast(page)).toContainText('could not be aligned');
  expect(await historyLength(page)).toBe(n);
  // the dialog offers the six projections and the two lens corrections; Cancel changes nothing
  await run(page, 'edit:auto-align');
  const dialog = page.locator('.dialog-backdrop').last();
  await expect(dialog).toContainText('Auto-Align Layers');
  expect(await dialog.locator('select[data-key="projection"] option').allTextContents()).toEqual(['Auto', 'Perspective', 'Collage', 'Cylindrical', 'Spherical', 'Reposition']);
  await expect(dialog.locator('input[data-key="vignette"]')).toHaveCount(1);
  await expect(dialog.locator('input[data-key="distortion"]')).toHaveCount(1);
  await dialog.locator('.dialog-buttons .btn').first().click();
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0);
  expect(await historyLength(page)).toBe(n);
  expect(errors).toEqual([]);
});

test('Auto-Align brings two shifted copies into register (Reposition moves, Auto grows the canvas), one undo step each', async ({ page }) => {
  const errors = await openApp(page);
  await installHelpers(page);
  await newDoc(page, { width: 400, height: 300 });
  await page.evaluate(async () => {
    const ab = window.__ab, d = window.pigmentApp.doc, bg = d.active;
    const scene = ab.scene(600, 420);
    window.__scene = scene;
    ab.setLayer(bg, ab.paint(400, 300, (ctx) => ctx.drawImage(scene, -50, -40)));
    // the top layer shows the same scene 23 px further right and 14 px further up: it must move by (+23, -14)
    const top = await ab.addLayer('Shifted', ab.paint(400, 300, (ctx) => ctx.drawImage(scene, -50 - 23, -40 + 14)));
    ab.select([bg, top]);
  });
  const diff = () => page.evaluate(() => {
    const [a, b] = window.pigmentApp.doc.layers();
    return window.__ab.layerDiff(a, b, { x: 0, y: 0, width: window.pigmentApp.doc.width, height: window.pigmentApp.doc.height });
  });
  expect((await diff()).mean).toBeGreaterThan(20); // out of register
  const n = await historyLength(page);

  await runAwait(page, 'edit:auto-align', { projection: 'reposition' });
  let state = await info(page);
  expect(state.size).toEqual([400, 300]); // Reposition keeps the canvas
  expect(state.layers.map((l) => [l.name, l.x, l.y, l.w, l.h])).toEqual([['Background', 0, 0, 400, 300], ['Shifted', 23, -14, 400, 300]]);
  let d = await diff();
  expect(d.mean).toBe(0); // the overlap is pixel-identical
  expect(d.count).toBe((400 - 23) * (300 - 14));
  expect(await historyLength(page)).toBe(n + 1);
  expect(await page.evaluate(() => window.pigmentApp.doc.history.entries.at(-1).label)).toBe('Auto-Align Layers');
  await expect(lastToast(page)).toContainText('Aligned 2 layers (Reposition)');
  // both layers stay selected
  expect(await page.evaluate(() => window.pigmentApp.doc.selectedLayers().map((l) => l.name))).toEqual(['Shifted', 'Background']);
  await runAwait(page, 'edit:undo');
  expect((await info(page)).layers[1]).toMatchObject({ x: 0, y: 0 });
  expect((await diff()).mean).toBeGreaterThan(20);
  await runAwait(page, 'edit:redo');
  expect((await info(page)).layers[1]).toMatchObject({ x: 23, y: -14 });
  await runAwait(page, 'edit:undo');

  // through the dialog with Auto: the same registration, and the canvas grows to hold both layers
  await run(page, 'edit:auto-align');
  const dialog = page.locator('.dialog-backdrop').last();
  await dialog.locator('select[data-key="projection"]').selectOption('auto');
  await confirmDialog(page);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.width)).toBe(423);
  state = await info(page);
  expect(state.size).toEqual([423, 314]);
  expect(state.layers.map((l) => [l.name, l.x, l.y])).toEqual([['Background', 0, 14], ['Shifted', 23, 0]]);
  d = await diff();
  expect(d.mean).toBe(0);
  expect(d.count).toBe((400 - 23) * (300 - 14));
  expect(await historyLength(page)).toBe(n + 1); // the moves and the canvas resize are one entry
  await expect(lastToast(page)).toContainText('Aligned 2 layers (Reposition)');
  expect(await page.evaluate(() => window.pigmentApp.doc.selectedLayers().map((l) => l.name))).toEqual(['Shifted', 'Background']);
  await runAwait(page, 'edit:undo');
  state = await info(page);
  expect(state.size).toEqual([400, 300]);
  expect(state.layers.map((l) => [l.x, l.y])).toEqual([[0, 0], [0, 0]]);
  expect(await historyLength(page)).toBe(n);
  await runAwait(page, 'edit:redo');
  expect((await info(page)).size).toEqual([423, 314]);
  expect((await diff()).mean).toBe(0);
  // the choice is remembered for the next dialog
  expect(await page.evaluate(() => window.pigmentApp.settings.alignBlend.projection)).toBe('auto');

  // a locked layer is the reference: it stays, the other one moves
  await runAwait(page, 'edit:undo');
  await page.evaluate(() => {
    const [bg, top] = window.pigmentApp.doc.layers();
    top.locked = { ...top.locked, position: true };
    window.__ab.select([bg, top]);
  });
  await runAwait(page, 'edit:auto-align', { projection: 'reposition' });
  expect((await info(page)).layers.map((l) => [l.x, l.y])).toEqual([[-23, 14], [0, 0]]);
  expect((await diff()).mean).toBe(0);
  expect(errors).toEqual([]);
});

test('Auto-Align registers a rotated, scaled copy (Collage) and a perspective view', async ({ page }) => {
  const errors = await openApp(page);
  await installHelpers(page);
  await newDoc(page, { width: 420, height: 320 });
  const setup = (kind) => page.evaluate(async (k) => {
    const ab = window.__ab, app = window.pigmentApp, d = app.doc;
    const scene = ab.scene(420, 320, 31);
    while (d.layers().length > 1) {
      d.setActive(d.layers().at(-1));
      await app.commands.run('layer:delete', undefined, 'api');
    }
    const bg = d.layers()[0];
    ab.setLayer(bg, ab.paint(420, 320, (ctx) => ctx.drawImage(scene, 0, 0)));
    const view = ab.paint(420, 320, (ctx) => {
      if (k === 'collage') {
        ctx.translate(210, 160);
        ctx.rotate((6 * Math.PI) / 180);
        ctx.scale(1.05, 1.05);
        ctx.translate(-210 + 9, -160 - 5);
        ctx.drawImage(scene, 0, 0);
      }
    });
    if (k === 'perspective') {
      // a true perspective view of the scene, through the app's own resampler
      const T = await import('/shared/pixels/transform.js');
      const quad = [[0, 0], [420, 0], [420, 320], [0, 320]];
      const img = T.perspective(scene.getContext('2d').getImageData(0, 0, 420, 320), quad, [[14, 6], [404, -10], [430, 330], [-8, 306]], { x: 0, y: 0, width: 420, height: 320 });
      view.getContext('2d').putImageData(new ImageData(img.data, 420, 320), 0, 0);
    }
    const top = await ab.addLayer('View', view);
    ab.select([bg, top]);
  }, kind);
  const diff = () => page.evaluate(() => {
    const [a, b] = window.pigmentApp.doc.layers();
    // the middle of the reference layer, wherever the canvas growth put it
    return window.__ab.layerDiff(a, b, { x: a.x + 70, y: a.y + 60, width: 280, height: 200 });
  });

  await setup('collage');
  const before = (await diff()).mean;
  expect(before).toBeGreaterThan(25);
  let n = await historyLength(page);
  await runAwait(page, 'edit:auto-align', { projection: 'auto' });
  await expect(lastToast(page)).toContainText('Aligned 2 layers (Collage)');
  let d = await diff();
  // resampling softens the rectangle edges; in register the mean difference is a small fraction of what it was
  expect(d.count).toBeGreaterThan(50000);
  expect(d.mean).toBeLessThan(before / 5);
  expect(await historyLength(page)).toBe(n + 1);
  // the canvas grew to hold the turned layer; undo brings everything back
  const grown = (await info(page)).size;
  expect(grown[0]).toBeGreaterThan(420);
  expect(grown[1]).toBeGreaterThan(320);
  await runAwait(page, 'edit:undo');
  expect((await info(page)).size).toEqual([420, 320]);
  expect((await diff()).mean).toBeCloseTo(before, 5);

  await setup('perspective');
  const beforeP = (await diff()).mean;
  n = await historyLength(page);
  await runAwait(page, 'edit:auto-align', { projection: 'perspective' });
  await expect(lastToast(page)).toContainText('(Perspective)');
  d = await diff();
  expect(d.count).toBeGreaterThan(40000);
  expect(d.mean).toBeLessThan(beforeP / 5);
  expect(await historyLength(page)).toBe(n + 1);

  // the lens corrections are accepted and report what they did (nothing measurable on a synthetic scene)
  await setup('collage');
  await runAwait(page, 'edit:auto-align', { projection: 'collage', vignette: true, distortion: true });
  await expect(lastToast(page)).toContainText('vignette was not removed');
  await expect(lastToast(page)).toContainText('geometric distortion was not corrected');
  expect((await diff()).mean).toBeLessThan(before / 5);
  expect(errors).toEqual([]);
});

test('Auto-Blend adds seam masks, matches tones, focus-stacks and fills transparent areas, each as one undo step', async ({ page }) => {
  const errors = await openApp(page);
  await installHelpers(page);
  await newDoc(page, { width: 300, height: 120, background: 'transparent' });
  await page.evaluate(async () => {
    const ab = window.__ab, d = window.pigmentApp.doc;
    const scene = ab.scene(300, 120, 5, 160);
    window.__scene = scene;
    // left part at full brightness, right part 20% darker; they overlap in x = 120..179
    ab.setLayer(d.active, ab.paint(180, 120, (ctx) => ctx.drawImage(scene, 0, 0)), 0, 0);
    d.active.name = 'Left';
    const right = await ab.addLayer('Right', ab.paint(180, 120, (ctx) => {
      ctx.drawImage(scene, -120, 0);
      ctx.fillStyle = 'rgba(0,0,0,0.2)';
      ctx.fillRect(0, 0, 180, 120);
    }), 120, 0);
    ab.select([d.layers()[0], right]);
  });
  const n = await historyLength(page);
  const sample = (x, y) => page.evaluate(([px, py]) => {
    const s = window.__scene.getContext('2d', { willReadFrequently: true }).getImageData(px, py, 1, 1).data;
    const f = window.__ab.flat();
    const i = (py * f.width + px) * 4;
    return { scene: [s[0], s[1], s[2]], flat: [f.data[i], f.data[i + 1], f.data[i + 2], f.data[i + 3]] };
  }, [x, y]);
  // before: the darker layer covers the whole overlap
  let p = await sample(130, 60);
  expect(Math.abs(p.flat[0] - p.scene[0] * 0.8)).toBeLessThanOrEqual(2);

  await runAwait(page, 'edit:auto-blend', { method: 'panorama', seamless: false, fill: false });
  let masks = await page.evaluate(() => {
    const [a, b] = window.pigmentApp.doc.layers();
    const ab = window.__ab;
    return { a: [ab.maskAt(a, 50, 60), ab.maskAt(a, 170, 60), ab.maskAt(a, 250, 60)], b: [ab.maskAt(b, 50, 60), ab.maskAt(b, 124, 60), ab.maskAt(b, 176, 60), ab.maskAt(b, 250, 60)], size: [a.mask.canvas.width, a.mask.canvas.height] };
  });
  expect(masks.size).toEqual([300, 120]);
  expect(masks.a).toEqual([255, 255, 0]); // the bottom layer is opaque wherever it has pixels
  expect(masks.b).toEqual([0, 0, 255, 255]); // the top layer shows only right of the seam
  const seam = await page.evaluate(() => {
    const b = window.pigmentApp.doc.layers()[1];
    const row = b.mask.canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 60, 300, 1).data;
    let first = -1, greys = 0;
    for (let x = 0; x < 300; x++) {
      if (first < 0 && row[x * 4 + 3] >= 128) first = x;
      if (row[x * 4 + 3] > 0 && row[x * 4 + 3] < 255) greys++;
    }
    return { first, greys };
  });
  expect(Math.abs(seam.first - 150)).toBeLessThanOrEqual(3); // through the middle of the overlap
  expect(seam.greys).toBeGreaterThanOrEqual(3); // feathered
  // left of the seam the bright layer shows now, right of it the dark one; no holes anywhere
  p = await sample(130, 60);
  expect(Math.abs(p.flat[0] - p.scene[0])).toBeLessThanOrEqual(2);
  p = await sample(172, 60);
  expect(Math.abs(p.flat[0] - p.scene[0] * 0.8)).toBeLessThanOrEqual(2);
  expect(await page.evaluate(() => {
    const f = window.__ab.flat();
    for (let i = 3; i < f.data.length; i += 4) if (f.data[i] !== 255) return false;
    return true;
  })).toBe(true);
  expect(await historyLength(page)).toBe(n + 1);
  expect(await page.evaluate(() => window.pigmentApp.doc.history.entries.at(-1).label)).toBe('Auto-Blend Layers');
  await runAwait(page, 'edit:undo');
  expect(await page.evaluate(() => window.pigmentApp.doc.layers().map((l) => !!l.mask))).toEqual([false, false]);

  // Seamless Tones and Colors: the dark layer is lifted, the bright one lowered, until they agree
  await runAwait(page, 'edit:auto-blend', { method: 'panorama', seamless: true, fill: false });
  await expect(lastToast(page)).toContainText('tones matched on 2 layers');
  const ratio = async (x) => {
    let num = 0, den = 0;
    for (const y of [20, 40, 60, 80, 100]) {
      const s = await sample(x, y);
      for (let c = 0; c < 3; c++) {
        if (s.scene[c] < 40 || s.scene[c] > 250) continue;
        num += s.flat[c];
        den += s.scene[c];
      }
    }
    return num / den;
  };
  const leftGain = await ratio(60), rightGain = await ratio(240);
  expect(leftGain).toBeLessThan(1);
  expect(rightGain).toBeGreaterThan(0.8);
  expect(Math.abs(leftGain - rightGain)).toBeLessThan(0.04); // was 1 against 0.8
  expect(await historyLength(page)).toBe(n + 1);
  await runAwait(page, 'edit:undo');
  p = await sample(60, 60);
  expect(p.flat.slice(0, 3)).toEqual(p.scene); // the pixels are back
  expect(await page.evaluate(() => window.pigmentApp.doc.layers().map((l) => !!l.mask))).toEqual([false, false]);

  // the dialog: Panorama / Stack Images, the two checkboxes; OK blends
  await run(page, 'edit:auto-blend');
  const dialog = page.locator('.dialog-backdrop').last();
  await expect(dialog).toContainText('Auto-Blend Layers');
  await expect(dialog).toContainText('Panorama');
  await expect(dialog).toContainText('Stack Images');
  await expect(dialog.locator('input[data-key="seamless"]')).toBeChecked();
  await expect(dialog.locator('input[data-key="fill"]')).not.toBeChecked();
  await confirmDialog(page);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.layers().map((l) => !!l.mask))).toEqual([true, true]);
  expect(await historyLength(page)).toBe(n + 1);

  // ---- Stack Images: each half is sharp in a different layer -------------------------------------------------
  await newDoc(page, { width: 240, height: 120 });
  await page.evaluate(async () => {
    const ab = window.__ab, d = window.pigmentApp.doc;
    const scene = ab.scene(240, 120, 12, 150);
    window.__scene = scene;
    const half = (sharpLeft) => ab.paint(240, 120, (ctx) => {
      ctx.filter = 'blur(4px)';
      ctx.drawImage(scene, 0, 0);
      ctx.filter = 'none';
      ctx.drawImage(scene, sharpLeft ? 0 : 120, 0, 120, 120, sharpLeft ? 0 : 120, 0, 120, 120);
    });
    ab.setLayer(d.active, half(true));
    const top = await ab.addLayer('Far focus', half(false));
    ab.select([d.layers()[0], top]);
  });
  const sharpness = () => page.evaluate(() => window.__ab.flatDiff(window.__scene, 0, 0, { x: 8, y: 8, width: 224, height: 104 }).mean);
  const blurred = await sharpness(); // the top layer alone: its left half is soft
  await runAwait(page, 'edit:auto-blend', { method: 'stack', seamless: false, fill: false });
  await expect(lastToast(page)).toContainText('sharpest layer per area');
  const stacked = await sharpness();
  expect(stacked).toBeLessThan(blurred / 3); // sharp nearly everywhere now
  expect(await page.evaluate(() => {
    const [a, b] = window.pigmentApp.doc.layers();
    return [window.__ab.maskAt(b, 40, 60), window.__ab.maskAt(b, 200, 60), window.__ab.maskAt(a, 40, 60)];
  })).toEqual([0, 255, 255]);

  // ---- Content Aware Fill Transparent Areas ---------------------------------------------------------------------
  await newDoc(page, { width: 160, height: 100, background: 'transparent' });
  await page.evaluate(async () => {
    const ab = window.__ab, d = window.pigmentApp.doc;
    const scene = ab.scene(160, 100, 3, 60);
    ab.setLayer(d.active, ab.paint(100, 100, (ctx) => ctx.drawImage(scene, 0, 0)), 0, 0);
    // the right layer is 16 px short at the bottom: a 60 × 16 strip of the canvas stays empty
    const right = await ab.addLayer('Right', ab.paint(100, 84, (ctx) => ctx.drawImage(scene, -60, 0)), 60, 0);
    ab.select([d.layers()[0], right]);
  });
  expect((await pixel(page, 150, 95))[3]).toBe(0);
  const m = await historyLength(page);
  await runAwait(page, 'edit:auto-blend', { method: 'panorama', seamless: true, fill: true });
  await expect(lastToast(page)).toContainText('transparent areas filled on a merged layer');
  let state = await info(page);
  expect(state.layers.map((l) => [l.name, l.mask])).toEqual([['Layer 1', true], ['Right', true], ['Right (merged)', false]]);
  expect(await page.evaluate(() => window.pigmentApp.doc.active.name)).toBe('Right (merged)');
  expect(await page.evaluate(() => {
    const l = window.pigmentApp.doc.active;
    const d = l.canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, l.canvas.width, l.canvas.height).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] !== 255) return false;
    return true;
  })).toBe(true);
  expect((await pixel(page, 150, 95))[3]).toBe(255);
  expect(await historyLength(page)).toBe(m + 1); // masks, the merged layer and the fill are one entry
  await runAwait(page, 'edit:undo');
  state = await info(page);
  expect(state.layers.map((l) => [l.name, l.mask])).toEqual([['Layer 1', false], ['Right', false]]);
  expect((await pixel(page, 150, 95))[3]).toBe(0);
  await runAwait(page, 'edit:redo');
  expect((await info(page)).layers.length).toBe(3);
  expect((await pixel(page, 150, 95))[3]).toBe(255);
  expect(errors).toEqual([]);
});

test('Photomerge of two overlapping files gives a wider document with two masked layers', async ({ page }) => {
  const errors = await openApp(page);
  await installHelpers(page);
  await page.evaluate(async () => {
    const ab = window.__ab;
    const scene = ab.scene(520, 300, 17, 460);
    window.__scene = scene;
    await ab.png('browser:/pano/left.png', ab.paint(300, 240, (ctx) => ctx.drawImage(scene, 0, 0)));
    await ab.png('browser:/pano/right.png', ab.paint(300, 240, (ctx) => ctx.drawImage(scene, -180, -20)));
    await ab.png('browser:/pano/alien.png', ab.scene(300, 240, 4242));
  });
  const paths = ['browser:/pano/left.png', 'browser:/pano/right.png'];
  await runAwait(page, 'file:automate-photomerge', { source: 'files', paths, layout: 'auto', blend: true, vignette: false, distortion: false, fill: false });
  let state = await info(page);
  expect(state.name).toBe('Panorama');
  expect(state.size).toEqual([480, 260]); // 300 + 180 wide, 240 + 20 high
  expect(state.layers.map((l) => [l.name, l.type, l.x, l.y, l.w, l.h, l.mask])).toEqual([['left', 'raster', 0, 0, 300, 240, true], ['right', 'raster', 180, 20, 300, 240, true]]);
  await expect(lastToast(page)).toContainText('Merged 2 images (Reposition, blended with masks)');
  // the panorama is the scene (tones may be touched by a hair where the layers were matched)
  const d = await page.evaluate(() => window.__ab.flatDiff(window.__scene, 0, 0, { x: 0, y: 0, width: 480, height: 260 }));
  expect(d.mean).toBeLessThan(1.5);
  expect(d.count).toBe(480 * 260 - 180 * 20 - 180 * 20); // everything but the two empty corners
  expect((await pixel(page, 400, 5))[3]).toBe(0);
  expect((await pixel(page, 50, 255))[3]).toBe(0);
  expect((await pixel(page, 240, 130))[3]).toBe(255);
  // seam through the middle of the 120 px overlap (x = 180..299)
  expect(await page.evaluate(() => {
    const [a, b] = window.pigmentApp.doc.layers();
    const ab = window.__ab;
    return [ab.maskAt(a, 100, 100), ab.maskAt(b, 190, 100), ab.maskAt(b, 290, 100), ab.maskAt(b, 400, 100)];
  })).toEqual([255, 0, 255, 255]);
  // a new document: nothing to undo, not dirty
  expect(await historyLength(page)).toBe(0);

  // Content Aware Fill Transparent Areas: a merged layer on top without holes; no blending: no masks
  await runAwait(page, 'file:automate-photomerge', { source: 'files', paths, layout: 'reposition', blend: false, fill: true });
  state = await info(page);
  expect(state.size).toEqual([480, 260]);
  expect(state.layers.map((l) => [l.name, l.mask])).toEqual([['left', false], ['right', false], ['Panorama (merged)', false]]);
  expect((await pixel(page, 400, 5))[3]).toBe(255);
  expect((await pixel(page, 50, 255))[3]).toBe(255);
  await expect(lastToast(page)).toContainText('transparent areas filled on a merged layer');

  // an image that belongs to another scene is not placed: it comes along hidden and the user is told
  await runAwait(page, 'file:automate-photomerge', { source: 'files', paths: [...paths, 'browser:/pano/alien.png'], layout: 'reposition', blend: true });
  state = await info(page);
  expect(state.size).toEqual([480, 260]);
  expect(state.layers.map((l) => [l.name, l.visible, l.mask])).toEqual([['left', true, true], ['right', true, true], ['alien', false, false]]);
  await expect(lastToast(page)).toContainText('"alien" could not be placed');

  // the other layouts place the same two images
  for (const layout of ['perspective', 'collage', 'cylindrical', 'spherical']) {
    await runAwait(page, 'file:automate-photomerge', { source: 'files', paths, layout, blend: true });
    state = await info(page);
    expect(state.layers.length, layout).toBe(2);
    expect(Math.abs(state.size[0] - 480), `${layout} width ${state.size[0]}`).toBeLessThanOrEqual(layout === 'cylindrical' || layout === 'spherical' ? 60 : 3);
    expect(state.layers.every((l) => l.mask), layout).toBe(true);
    await expect(lastToast(page)).toContainText(`(${layout.charAt(0).toUpperCase()}${layout.slice(1)}, blended`);
    if (layout === 'perspective' || layout === 'collage') {
      const dd = await page.evaluate(() => window.__ab.flatDiff(window.__scene, 0, 0, { x: 20, y: 30, width: 440, height: 200 }));
      expect(dd.mean, layout).toBeLessThan(6);
    }
  }

  // nothing in common at all: an error, no document
  const count = await page.evaluate(() => window.pigmentApp.docs.list().length);
  await runAwait(page, 'file:automate-photomerge', { source: 'files', paths: ['browser:/pano/left.png', 'browser:/pano/alien.png'], layout: 'auto' });
  await expect(lastToast(page)).toContainText('No overlap was found');
  expect(await page.evaluate(() => window.pigmentApp.docs.list().length)).toBe(count);
  expect(errors).toEqual([]);
});

test('Photomerge dialog: open documents as the source, the layout options, files through the file dialog', async ({ page }) => {
  const errors = await openApp(page);
  await installHelpers(page);
  await page.evaluate(async () => {
    const ab = window.__ab, app = window.pigmentApp;
    const scene = ab.scene(520, 300, 23, 460);
    for (const [name, x, y] of [['west', 0, 10], ['east', 200, 0]]) {
      app.newDocument({ width: 300, height: 240, name });
      ab.setLayer(app.doc.active, ab.paint(300, 240, (ctx) => ctx.drawImage(scene, -x, -y)));
    }
    await ab.png('browser:/pano/a.png', ab.paint(300, 240, (ctx) => ctx.drawImage(scene, 0, 0)));
    await ab.png('browser:/pano/b.png', ab.paint(300, 240, (ctx) => ctx.drawImage(scene, -150, 0)));
  });
  await run(page, 'file:automate-photomerge');
  const dialog = page.locator('.dialog-backdrop').last();
  await expect(dialog).toContainText('Photomerge');
  expect(await dialog.locator('select[data-key="layout"] option').allTextContents()).toEqual(['Auto', 'Perspective', 'Collage', 'Cylindrical', 'Spherical', 'Reposition']);
  for (const key of ['blend', 'vignette', 'distortion', 'fill']) await expect(dialog.locator(`input[data-key="${key}"]`)).toHaveCount(1);
  await expect(dialog.locator('input[data-key="blend"]')).toBeChecked();
  // both open documents are listed and ticked
  await expect(dialog).toContainText('west (300 × 240)');
  await expect(dialog).toContainText('east (300 × 240)');
  await confirmDialog(page);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.name)).toBe('Panorama');
  let state = await info(page);
  expect(state.size).toEqual([500, 250]);
  expect(state.layers.map((l) => [l.name, l.x, l.y, l.mask])).toEqual([['west', 0, 10, true], ['east', 200, 0, true]]);
  // the source documents are untouched
  expect(await page.evaluate(() => window.pigmentApp.docs.list().map((d) => [d.name, d.width, d.layers().length]))).toEqual([['west', 300, 1], ['east', 300, 1], ['Panorama', 500, 2]]);

  // Files…: the file dialog opens after OK
  await page.evaluate(() => {
    window.__pigmentTest.nextOpenFiles = ['browser:/pano/a.png', 'browser:/pano/b.png'];
  });
  await run(page, 'file:automate-photomerge');
  await page.locator('.dialog-backdrop').last().locator('.segmented button, .segment button, button').filter({ hasText: 'Files…' }).first().click();
  await confirmDialog(page);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.docs.list().length)).toBe(4);
  state = await info(page);
  expect(state.size).toEqual([450, 240]);
  expect(state.layers.map((l) => l.name)).toEqual(['a', 'b']);
  // a dismissed file dialog merges nothing
  await page.evaluate(() => {
    window.__pigmentTest.nextOpenFiles = [];
  });
  await runAwait(page, 'file:automate-photomerge', { source: 'files', layout: 'auto' });
  expect(await page.evaluate(() => window.pigmentApp.docs.list().length)).toBe(4);
  expect(errors).toEqual([]);
});

test('Load Files into Stack and Statistics: median removes the noise; Stack Mode switches, undoes and is saved', async ({ page }) => {
  const errors = await openApp(page);
  await installHelpers(page);
  const paths = await page.evaluate(async () => {
    const ab = window.__ab;
    const clean = ab.paint(120, 90, (ctx) => {
      ctx.fillStyle = '#6080a0';
      ctx.fillRect(0, 0, 120, 90);
      ctx.fillStyle = '#c08040';
      ctx.fillRect(30, 20, 60, 50);
    });
    window.__clean = clean;
    let s = 99;
    const rnd = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
    const out = [];
    for (let k = 0; k < 7; k++) {
      const c = ab.paint(120, 90, (ctx) => ctx.drawImage(clean, 0, 0));
      const ctx = c.getContext('2d');
      const img = ctx.getImageData(0, 0, 120, 90);
      // uniform noise of ±40 on every channel; frame 3 also has a white "passer-by" block
      for (let i = 0; i < img.data.length; i += 4) for (let ch = 0; ch < 3; ch++) img.data[i + ch] += (rnd() - 0.5) * 80;
      if (k === 3) for (let y = 40; y < 60; y++) for (let x = 5; x < 25; x++) img.data.set([255, 255, 255, 255], (y * 120 + x) * 4);
      ctx.putImageData(img, 0, 0);
      out.push(await ab.png(`browser:/stack/frame${k}.png`, c));
    }
    return out;
  });
  const error = () => page.evaluate(() => window.__ab.flatDiff(window.__clean, 0, 0, { x: 0, y: 0, width: 120, height: 90 }).mean);

  // Load Files into Stack: one layer per file, first file at the bottom
  await runAwait(page, 'file:script-load-stack', { source: 'files', paths, align: false, smart: false });
  let state = await info(page);
  expect(state.size).toEqual([120, 90]);
  expect(state.layers.map((l) => [l.name, l.type, l.x, l.y])).toEqual(paths.map((_, k) => [`frame${k}`, 'raster', 0, 0]));
  const noisy = await error(); // the top frame: about ±40 uniform, mean |error| ≈ 20
  expect(noisy).toBeGreaterThan(15);
  await expect(lastToast(page)).toContainText('Loaded 7 images into layers');

  // Statistics: a smart object showing the median
  await runAwait(page, 'file:script-statistics', { source: 'files', paths, mode: 'median', align: false });
  state = await info(page);
  expect(state.size).toEqual([120, 90]);
  expect(state.layers.map((l) => l.type)).toEqual(['smart']);
  const smart = () => page.evaluate(() => {
    const l = window.pigmentApp.doc.active;
    return { type: l.type, mode: l.stackMode, layers: l.source.kind === 'document' ? l.source.doc.root.children.length : 0, ui: window.pigmentApp.uiState?.stackMode ?? window.__pigmentTest.uiState?.stackMode };
  });
  expect(await smart()).toEqual({ type: 'smart', mode: 'median', layers: 7, ui: 'median' });
  const median = await error();
  // seven frames of uniform noise: the median is about half as noisy (the unit tests check the 1/3 of fifteen Gaussian ones)
  expect(median).toBeLessThan(noisy * 0.62);
  // the passer-by of frame 3 is gone
  const p = await pixel(page, 15, 50);
  expect(Math.abs(p[0] - 0x60)).toBeLessThan(30);
  await expect(lastToast(page)).toContainText('Median of 7 images in a smart object');
  expect(await page.evaluate(() => window.pigmentApp.commands.isEnabled('layer:stack-mode'))).toBe(true);

  // Layer > Smart Objects > Stack Mode: Maximum shows the passer-by, Mean is in between, undo goes back
  const n = await historyLength(page);
  await runAwait(page, 'layer:stack-mode', 'maximum');
  expect((await smart()).mode).toBe('maximum');
  expect((await smart()).ui).toBe('maximum');
  expect(await pixel(page, 15, 50)).toEqual([255, 255, 255, 255]);
  expect(await historyLength(page)).toBe(n + 1);
  expect(await page.evaluate(() => window.pigmentApp.doc.history.entries.at(-1).label)).toBe('Stack Mode: Maximum');
  await runAwait(page, 'layer:stack-mode', 'minimum');
  expect((await pixel(page, 15, 50))[0]).toBeLessThan(0x60);
  await runAwait(page, 'layer:stack-mode', 'range');
  expect((await pixel(page, 15, 50))[0]).toBeGreaterThan(150); // white passer-by minus the darkest sample
  await runAwait(page, 'edit:undo');
  await runAwait(page, 'edit:undo');
  await runAwait(page, 'edit:undo');
  expect((await smart()).mode).toBe('median');
  expect(await error()).toBeCloseTo(median, 5);
  // every mode renders
  for (const mode of ['entropy', 'kurtosis', 'mean', 'skewness', 'standard-deviation', 'summation', 'variance']) {
    await runAwait(page, 'layer:stack-mode', mode);
    expect((await smart()).mode).toBe(mode);
    expect((await pixel(page, 60, 45))[3], mode).toBe(255);
  }
  expect(Math.max(...(await pixel(page, 60, 45)).slice(0, 3))).toBe(255); // the variance of ±40 noise (σ² ≈ 530 levels²) clips
  await runAwait(page, 'layer:stack-mode', 'mean');
  const mean = await error();
  expect(mean).toBeLessThan(noisy * 0.45); // 1 / √7 ≈ 0.38
  expect(mean).toBeLessThan(median);
  // None: the normal composite, which is the top frame
  await runAwait(page, 'layer:stack-mode', 'none');
  expect((await smart()).mode).toBe(null);
  expect((await smart()).ui).toBe('none');
  expect(await error()).toBeCloseTo(noisy, 5);
  await runAwait(page, 'layer:stack-mode', 'median');

  // saved in .pigment and read back
  await page.evaluate(() => {
    window.__pigmentTest.nextSavePath = 'mem:/stack.pigment';
  });
  await runAwait(page, 'file:save-as');
  await expect.poll(() => page.evaluate(() => !!window.__pigmentTest.written['mem:/stack.pigment'])).toBe(true);
  await page.evaluate(() => {
    window.__pigmentTest.files['mem:/again.pigment'] = window.__pigmentTest.written['mem:/stack.pigment'];
  });
  await runAwait(page, 'file:open-paths', ['mem:/again.pigment']);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.path)).toBe('mem:/again.pigment');
  expect(await smart()).toMatchObject({ type: 'smart', mode: 'median', layers: 7 });
  expect(await error()).toBeCloseTo(median, 5);

  // a smart object that is not a stack refuses a stack mode
  await newDoc(page, { width: 60, height: 40 });
  await runAwait(page, 'layer:smart-convert');
  await runAwait(page, 'layer:stack-mode', 'median');
  await expect(lastToast(page)).toContainText('needs a smart object that holds two or more layers');
  expect(await page.evaluate(() => window.pigmentApp.doc.active.stackMode ?? null)).toBe(null);
  expect(errors).toEqual([]);
});

test('Load Files into Stack: alignment, a smart object, the dialogs; the alignment hook Merge to HDR uses', async ({ page }) => {
  const errors = await openApp(page);
  await installHelpers(page);
  const paths = await page.evaluate(async () => {
    const ab = window.__ab;
    const scene = ab.scene(400, 300, 51, 380);
    window.__scene = scene;
    return [
      await ab.png('browser:/hand/one.png', ab.paint(300, 240, (ctx) => ctx.drawImage(scene, -40, -30))),
      await ab.png('browser:/hand/two.png', ab.paint(300, 240, (ctx) => ctx.drawImage(scene, -40 - 9, -30 + 6))),
      await ab.png('browser:/hand/three.png', ab.paint(300, 240, (ctx) => ctx.drawImage(scene, -40 + 5, -30 - 11))),
    ];
  });
  // hand-held frames: aligned on the first one, the canvas keeps its size
  await runAwait(page, 'file:script-load-stack', { source: 'files', paths, align: true, smart: false });
  let state = await info(page);
  expect(state.size).toEqual([300, 240]);
  expect(state.layers.map((l) => [l.name, l.x, l.y])).toEqual([['one', 0, 0], ['two', 9, -6], ['three', -5, 11]]);
  await expect(lastToast(page)).toContainText('aligned (Reposition)');
  const d = await page.evaluate(() => {
    const [a, b, c] = window.pigmentApp.doc.layers();
    const rect = { x: 0, y: 0, width: 300, height: 240 };
    return [window.__ab.layerDiff(a, b, rect).mean, window.__ab.layerDiff(a, c, rect).mean];
  });
  expect(d).toEqual([0, 0]);

  // as a smart object: one layer holding the three; a stack mode then works on it
  await runAwait(page, 'file:script-load-stack', { source: 'files', paths, align: true, smart: true });
  expect(await page.evaluate(() => {
    const d = window.pigmentApp.doc, l = d.active;
    return [d.layers().length, l.type, l.stackMode ?? null, l.source.doc.root.children.map((c) => [c.name, c.x, c.y])];
  })).toEqual([1, 'smart', null, [['one', 0, 0], ['two', 9, -6], ['three', -5, 11]]]);
  await runAwait(page, 'layer:stack-mode', 'range');
  // aligned frames of one scene differ nowhere they overlap: the range is black there
  expect(await pixel(page, 150, 120)).toEqual([0, 0, 0, 255]);
  await runAwait(page, 'layer:stack-mode', 'mean');
  expect((await page.evaluate(() => window.__ab.flatDiff(window.__scene, -40, -30, { x: 20, y: 20, width: 260, height: 200 }))).mean).toBe(0);

  // the dialogs
  await run(page, 'file:script-load-stack');
  let dialog = page.locator('.dialog-backdrop').last();
  await expect(dialog).toContainText('Load Files into Stack');
  await expect(dialog.locator('input[data-key="align"]')).toHaveCount(1);
  await expect(dialog.locator('input[data-key="smart"]')).toHaveCount(1);
  await expect(dialog).toContainText('Attempt to Automatically Align Source Images');
  await expect(dialog).toContainText('Create Smart Object after Loading Layers');
  await dialog.locator('.dialog-buttons .btn').first().click();
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0);

  const docs = await page.evaluate(() => window.pigmentApp.docs.list().length);
  await run(page, 'file:script-statistics');
  dialog = page.locator('.dialog-backdrop').last();
  await expect(dialog).toContainText('Image Statistics');
  expect(await dialog.locator('select[data-key="mode"] option').allTextContents()).toEqual(['Entropy', 'Kurtosis', 'Maximum', 'Mean', 'Median', 'Minimum', 'Range', 'Skewness', 'Standard Deviation', 'Summation', 'Variance']);
  await dialog.locator('select[data-key="mode"]').selectOption('maximum');
  // the two open documents are the source
  await confirmDialog(page);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.docs.list().length)).toBe(docs + 1);
  expect(await page.evaluate(() => [window.pigmentApp.doc.active.type, window.pigmentApp.doc.active.stackMode, window.pigmentApp.doc.active.source.doc.root.children.length])).toEqual(['smart', 'maximum', docs]);

  // Merge to HDR's alignment hook: same sizes back, in register
  const hook = await page.evaluate(async () => {
    const ab = window.__ab;
    const grab = (dx, dy) => ab.paint(300, 240, (ctx) => ctx.drawImage(window.__scene, -40 - dx, -30 - dy)).getContext('2d').getImageData(0, 0, 300, 240);
    const images = [grab(0, 0), grab(12, -7), grab(-6, 4)];
    const out = await window.pigmentApp.alignBlend.alignImages(images);
    const ref = out[1]; // the middle image is the reference
    const diff = (a, b) => {
      let s = 0, n = 0;
      for (let y = 30; y < 210; y++) for (let x = 30; x < 270; x++) {
        const i = (y * 300 + x) * 4;
        s += Math.abs(a.data[i] - b.data[i]);
        n++;
      }
      return s / n;
    };
    return { sizes: out.map((o) => [o.width, o.height, o.data.length]), same: out[1] === images[1], before: diff(images[0], images[1]), after: [diff(out[0], ref), diff(out[2], ref)] };
  });
  expect(hook.sizes).toEqual([[300, 240, 288000], [300, 240, 288000], [300, 240, 288000]]);
  expect(hook.same).toBe(true);
  expect(hook.before).toBeGreaterThan(20);
  expect(hook.after).toEqual([0, 0]);
  expect(errors).toEqual([]);
});
