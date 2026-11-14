// Regressions from the review of the 0.3.1 hunt fixes, area "layers, automation, smart objects": the Image Processor
// on an open document whose history is full, a recorded "Close: save changes" step over JPEGs, smart filters that
// draw or lay themselves out after a blur, Undo of layer links, and labels / links inside a saved smart object.
import { test, expect } from '@playwright/test';
import { openApp, newDoc } from './helpers.mjs';

async function setup(page) {
  await page.evaluate(async () => {
    const app = window.pigmentApp;
    const D = await import('/lib/document.js');
    const LO = await import('/lib/layer-ops.js');
    const M = await import('/lib/actions/model.js');
    window.H = {
      M,
      rect(name, color, x, y, w, h) {
        const d = app.doc;
        const layer = new D.RasterLayer({ name, width: d.width, height: d.height });
        const ctx = layer.canvas.getContext('2d');
        ctx.fillStyle = color;
        ctx.fillRect(x, y, w, h);
        LO.structural(app, `Add ${name}`, () => {
          d.add(layer, d.root, d.root.children.length);
          d.setActive(layer);
        });
        return layer;
      },
      /** A layer whose canvas is just the rectangle (a smart object made from it has these bounds). */
      box(name, color, x, y, w, h) {
        const d = app.doc;
        const layer = new D.RasterLayer({ name, width: w, height: h, x, y });
        const ctx = layer.canvas.getContext('2d');
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, w, h);
        LO.structural(app, `Add ${name}`, () => {
          d.add(layer, d.root, d.root.children.length);
          d.setActive(layer);
        });
        return layer;
      },
      select(names, d = app.doc) {
        const layers = names.map((n) => d.layers().find((l) => l.name === n));
        d.selected = new Set(layers);
        d.active = layers[layers.length - 1];
        d.changed('active', { layer: d.active });
      },
      /** [name, colour label, link set id] per layer, bottom first. */
      tags(d = app.doc) {
        return d.layers().map((l) => [l.name, l.color ?? null, l.linked ?? null]);
      },
      hash(d = app.doc) {
        const c = d.view.compositor.composite(d);
        const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let h = 2166136261;
        for (let i = 0; i < data.length; i++) h = Math.imul(h ^ data[i], 16777619);
        return `${h >>> 0}:${c.width}x${c.height}`;
      },
      action(setName, name, steps = []) {
        const set = M.makeSet(setName);
        const action = M.makeAction(name, steps);
        set.actions.push(action);
        app.actions.sets.push(set);
        return action;
      },
      async image(type, color) {
        const c = document.createElement('canvas');
        c.width = 40;
        c.height = 30;
        const x = c.getContext('2d');
        x.fillStyle = color;
        x.fillRect(0, 0, 40, 30);
        x.fillStyle = '#000';
        x.fillRect(0, 0, 10, 10);
        const blob = await new Promise((r) => c.toBlob(r, type, 0.9));
        return new Uint8Array(await blob.arrayBuffer());
      },
    };
  });
}

test.beforeEach(async ({ page }) => {
  await openApp(page);
  await setup(page);
});

test('Image Processor on an open document with a full history leaves it exactly as it was', async ({ page }) => {
  await newDoc(page, { width: 80, height: 60, name: 'IP' });
  const result = await page.evaluate(async () => {
    const app = window.pigmentApp, T = window.__pigmentTest, d = app.doc;
    H.action('R', 'Four', ['image:adjust-invert', 'image:flip-h', 'image:rotate-90', 'image:adjust-desaturate'].map((c) => H.M.makeStep(c)));
    // a short history limit stands for the default 100 states: the history is full before the run
    d.history.limit = 12;
    for (let i = 0; i < 14; i++) H.rect(`L${i}`, i % 2 ? '#00ff00' : '#ff00ff', (i * 5) % 60, (i * 7) % 40, 10, 10);
    T.nextSavePath = 'browser:/ip-src.pigment';
    await app.commands.run('file:save', undefined, 'api');
    const state = () => ({ index: d.history.index, labels: d.history.entries.map((e) => e.label), size: [d.width, d.height], hash: H.hash(), dirty: d.history.dirty, canRedo: d.history.canRedo });
    const before = state();
    const r = await app.commands.run('file:script-image-processor', { source: 'open', destination: 'folder', destFolder: 'browser:/ip', jpeg: true, jpegQuality: 8, jpegResize: true, jpegWidth: 40, jpegHeight: 40, psd: false, png: true, tiff: false, runAction: true, set: 'R', action: 'Four' }, 'api');
    return { before, after: state(), errors: r?.errors, saved: r?.saved, hold: d.history.hold, limit: d.history.limit };
  });
  expect(result.errors).toEqual([]);
  expect(result.saved).toEqual(['browser:/ip/JPEG/ip-src.jpg', 'browser:/ip/PNG/ip-src.png']);
  expect(result.before).toMatchObject({ index: 11, size: [80, 60], dirty: false, canRedo: false });
  expect(result.before.labels).toHaveLength(12);
  // not resized, none of the action's steps left on the pixels, and the history says the same
  expect(result.after).toEqual(result.before);
  expect(result.hold).toBe(false);
});

test('a recorded "Close: save changes" step saves JPEGs during a Batch without the JPEG Options dialog', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const app = window.pigmentApp, T = window.__pigmentTest;
    for (const [n, c] of [['a', '#ff0000'], ['b', '#00ff00'], ['c', '#0000ff']]) T.files[`mem:/shots/${n}.jpg`] = await H.image('image/jpeg', c);
    H.action('Rec', 'FlipSaveClose', [H.M.makeStep('image:flip-h'), H.M.makeStep('file:close', { save: true }, 'Close: save changes')]);
    const asked = [];
    T.autoRespond = (o) => {
      asked.push(o.message);
      return 0;
    };
    const dialogs = [];
    const watch = new MutationObserver(() => {
      for (const dlg of document.querySelectorAll('.dialog-backdrop .dialog')) {
        const text = dlg.textContent.replace(/\s+/g, ' ').slice(0, 40);
        if (!/Batch/.test(text) && !dialogs.includes(text)) dialogs.push(text);
        // answer it, so that a regression fails on the assertion instead of a hanging batch
        if (/Options/.test(text)) [...dlg.querySelectorAll('.dialog-buttons .btn.primary')].pop()?.click();
      }
    });
    watch.observe(document.body, { childList: true, subtree: true });
    const r = await app.commands.run('file:automate-batch', { set: 'Rec', action: 'FlipSaveClose', source: 'folder', folder: 'mem:/shots', destination: 'none', errors: 'stop' }, 'api');
    watch.disconnect();
    T.autoRespond = undefined;
    return { batch: { processed: r?.processed, errors: r?.errors, stopped: r?.stopped }, dialogs, asked, written: Object.keys(T.written).sort(), docs: app.docs.docs.length };
  });
  expect(result.batch).toEqual({ processed: 3, errors: [], stopped: false });
  expect(result.dialogs).toEqual([]);
  expect(result.asked).toEqual([]);
  expect(result.written).toEqual(['mem:/shots/a.jpg', 'mem:/shots/b.jpg', 'mem:/shots/c.jpg']);
  expect(result.docs).toBe(0);
});

test('a smart filter that draws or lays itself out after a blur is drawn once, on the object, not again in the halo', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { FILTERS } = await import('/shared/pixels/filters.js');
    const out = {};
    const pixels = (so) => {
      const r = so.render();
      return { r, w: r.canvas.width, h: r.canvas.height, d: r.canvas.getContext('2d').getImageData(0, 0, r.canvas.width, r.canvas.height).data };
    };
    for (const kind of ['picture-frame', 'tree', 'vignette']) {
      app.newDocument({ width: 300, height: 220, name: kind });
      H.box('Art', '#ff0000', 100, 60, 100, 100);
      await app.commands.run('layer:smart-convert', undefined, 'api');
      const so = app.doc.active;
      const b = so.bounds();
      await app.commands.run('filter:gaussian-blur', { radius: 10 }, 'api');
      const halo = pixels(so);
      await app.commands.run(`filter:${kind}`, { ...FILTERS[kind].defaults, ...(kind === 'vignette' ? { amount: -100 } : {}) }, 'api');
      const both = pixels(so);
      // outside the object's bounds the render is the blur's halo, untouched by the second filter
      let changed = 0;
      for (let y = 0; y < both.h; y++) {
        for (let x = 0; x < both.w; x++) {
          const X = x + both.r.x, Y = y + both.r.y;
          if (X >= b.x && X < b.x + b.width && Y >= b.y && Y < b.y + b.height) continue;
          const i = (y * both.w + x) * 4;
          for (let c = 0; c < 4; c++) {
            if (Math.abs(both.d[i + c] - halo.d[i + c]) > 2) {
              changed++;
              break;
            }
          }
        }
      }
      // and inside, the filter did run
      let inside = 0;
      for (let i = 0; i < both.d.length; i++) if (both.d[i] !== halo.d[i]) inside++;
      out[kind] = { filters: so.filters.map((f) => f.kind), bounds: [b.x, b.y, b.width, b.height], sameRender: both.r.x === halo.r.x && both.w === halo.w, ringChanged: changed, objectChanged: inside > 0 };
    }
    return out;
  });
  for (const kind of ['picture-frame', 'tree', 'vignette']) expect(result[kind], kind).toEqual({ filters: ['gaussian-blur', kind], bounds: [100, 60, 100, 100], sameRender: true, ringChanged: 0, objectChanged: true });
});

test('Undo back to "Link layers" links the pair again, after either layer was linked to another partner meanwhile', async ({ page }) => {
  await newDoc(page, { width: 100, height: 80 });
  const result = await page.evaluate(async () => {
    const app = window.pigmentApp, d = app.doc;
    const go = (c, a) => app.commands.run(c, a, 'api');
    const linked = (a, b) => {
      const [la, lb] = [a, b].map((n) => d.layers().find((l) => l.name === n));
      return !!la?.linked && la.linked === lb?.linked;
    };
    const undo = (n) => {
      for (let i = 0; i < n; i++) d.history.undo();
    };
    H.rect('A', '#ff0000', 5, 5, 20, 20);
    H.rect('B', '#00ff00', 30, 5, 20, 20);
    H.rect('C', '#0000ff', 55, 5, 20, 20);
    const out = {};
    // 1. Link A+B, delete B, Link A+C, delete C, then Undo three times: the state right after the first Link
    H.select(['A', 'B']);
    await go('layer:link');
    const linkEntry = d.history.entries[d.history.index];
    H.select(['B']);
    await go('layer:delete');
    H.select(['A', 'C']);
    await go('layer:link');
    H.select(['C']);
    await go('layer:delete');
    undo(3);
    out.first = { top: d.history.entries[d.history.index] === linkEntry, ab: linked('A', 'B'), tags: H.tags().map(([n, , k]) => [n, !!k]) };
    d.history.redo();
    out.firstRedo = linked('A', 'B');
    undo(2); // back to before the first Link
    // 2. Link A+B, Unlink, Link B+C, delete C, then Undo three times: the state right after the first Link
    H.select(['A', 'B']);
    await go('layer:link');
    await go('layer:link'); // both linked and selected: Unlink
    out.unlinked = H.tags().map(([n, , k]) => [n, !!k]);
    H.select(['B', 'C']);
    await go('layer:link');
    H.select(['C']);
    await go('layer:delete');
    undo(3);
    out.second = { label: d.history.entries[d.history.index].label, ab: linked('A', 'B'), c: !!d.layers().find((l) => l.name === 'C').linked };
    return out;
  });
  expect(result.first).toEqual({ top: true, ab: true, tags: [['Background', false], ['A', true], ['B', true], ['C', false]] });
  expect(result.firstRedo).toBe(false);
  expect(result.unlinked).toEqual([['Background', false], ['A', false], ['B', false], ['C', false]]);
  expect(result.second).toEqual({ label: 'Link layers', ab: true, c: false });
});

test('colour labels and links inside a smart object survive saving and reopening the document', async ({ page }) => {
  await newDoc(page, { width: 100, height: 80 });
  const result = await page.evaluate(async () => {
    const app = window.pigmentApp, T = window.__pigmentTest;
    const go = (c, a) => app.commands.run(c, a, 'api');
    H.rect('A', '#ff0000', 5, 5, 30, 30);
    H.rect('B', '#00ff00', 25, 25, 30, 30);
    H.rect('C', '#0000ff', 45, 45, 30, 30);
    H.select(['A', 'B']);
    await go('layer:link');
    await go('layer:color', 'red');
    await go('layer:smart-convert');
    T.nextSavePath = 'mem:/so.pigment';
    await go('file:save-as');
    for (let i = 0; i < 100 && !T.written['mem:/so.pigment']; i++) await new Promise((r) => setTimeout(r, 50));
    T.files['mem:/so-copy.pigment'] = T.written['mem:/so.pigment'];
    await go('file:open-paths', ['mem:/so-copy.pigment']);
    for (let i = 0; i < 100 && app.doc.path !== 'mem:/so-copy.pigment'; i++) await new Promise((r) => setTimeout(r, 50));
    const re = app.doc;
    const smart = re.layers().find((l) => l.type === 'smart');
    const inner = H.tags(smart.source.doc);
    re.setActive(smart);
    await go('layer:smart-to-layers');
    const back = H.tags(re);
    const [a, b] = ['A', 'B'].map((n) => back.find((t) => t[0] === n && t[2]));
    return { inner: inner.map(([n, c, k]) => [n, c, !!k]), innerShared: inner[0][2] === inner[1][2], back: back.map(([n, c, k]) => [n, c, !!k]), backShared: !!a && a[2] === b?.[2] };
  });
  expect(result.inner).toEqual([['A', 'red', true], ['B', 'red', true]]);
  expect(result.innerShared).toBe(true);
  expect(result.back).toEqual([['Background', null, false], ['B', 'red', false], ['A', 'red', true], ['B', 'red', true], ['C', null, false]]);
  expect(result.backShared).toBe(true);
});
